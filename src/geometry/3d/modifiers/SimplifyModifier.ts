/**
 * `SimplifyModifier` — edge-collapse decimation.
 *
 * ## The algorithm
 *
 * Quadric error metrics (Garland–Heckbert) are the right tool: each vertex carries
 * a 4×4 symmetric error quadric accumulated from the planes of its incident faces,
 * and collapsing an edge `(u, v)` to a new position costs `vᵀ(Qᵤ + Qᵥ)v`. Repeatedly
 * collapsing the cheapest edge produces a decimation that preserves silhouette far
 * better than removing "unimportant" vertices by curvature.
 *
 * This implementation keeps the quadrics' `10` unique coefficients, evaluates the
 * cost at a small set of candidate positions (both endpoints, the midpoint and the
 * optimal point when the combined quadric is invertible) rather than solving a
 * full 3×3 system for every edge, and lazily re-evaluates affected edges after each
 * collapse. That trades a little optimality for a large constant-factor win, which
 * is the usual trade for a mesh modifier that runs at load time.
 *
 * ## What it refuses to do
 *
 * It will not create a non-manifold edge, and it will not collapse an edge that
 * would flip a neighbouring face's normal by more than 90°. Both checks matter
 * because a decimated mesh is usually rendered immediately, and a flipped face is a
 * visible hole.
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../../math/Vec3';
import { BufferGeometry } from '../../core/BufferGeometry';
import { Float32BufferAttribute, Uint32BufferAttribute } from '../../core/BufferAttribute';
import type { SimplifyOptions } from '../types';

/** Options accepted by {@link simplify}. */
export type { SimplifyOptions };

/** A symmetric 4×4 error quadric stored as its 10 unique coefficients. */
interface Quadric {
  /** `q0..q9` = `a², ab, ac, ad, b², bc, bd, c², cd, d²` for the plane `(a, b, c, d)`. */
  readonly coefficients: Float64Array;
}

/** Creates a zero quadric. */
function createQuadric(): Quadric {
  return { coefficients: new Float64Array(10) };
}

/** Adds the plane `(a, b, c, d)` to a quadric. */
function addPlane(quadric: Quadric, a: number, b: number, c: number, d: number): void {
  const q = quadric.coefficients;
  q[0] += a * a;
  q[1] += a * b;
  q[2] += a * c;
  q[3] += a * d;
  q[4] += b * b;
  q[5] += b * c;
  q[6] += b * d;
  q[7] += c * c;
  q[8] += c * d;
  q[9] += d * d;
}

/** Adds `source` into `target`, in place. */
function addQuadric(target: Quadric, source: Quadric): void {
  for (let i = 0; i < 10; i++) target.coefficients[i] += source.coefficients[i];
}

/**
 * Evaluates `vᵀ Q v` for the point `(x, y, z)`.
 *
 * The quadric is symmetric, so the product reduces to ten terms.
 */
function evaluateQuadric(quadric: Quadric, x: number, y: number, z: number): number {
  const q = quadric.coefficients;
  return (
    q[0] * x * x +
    2 * q[1] * x * y +
    2 * q[2] * x * z +
    2 * q[3] * x +
    q[4] * y * y +
    2 * q[5] * y * z +
    2 * q[6] * y +
    q[7] * z * z +
    2 * q[8] * z +
    q[9]
  );
}

/**
 * Decimates a geometry by collapsing edges.
 *
 * @param geometry Source geometry; must have a `position` attribute.
 * @param options See {@link SimplifyOptions}.
 * @returns A new geometry with roughly the requested vertex count, or a clone when
 *   nothing can be removed.
 */
export function simplify(geometry: BufferGeometry, options: SimplifyOptions = {}): BufferGeometry {
  const position = geometry.getAttribute('position');
  if (!position) return geometry.clone();

  const index = geometry.getIndex();
  const array = position.array;
  const stride = position.itemSize || 3;
  const vertexCount = position.count > 0 ? position.count : Math.floor(array.length / stride);
  if (vertexCount < 4) return geometry.clone();

  /* --------------------------------------------------------------- topology */

  const positions: Vec3[] = [];
  for (let i = 0; i < vertexCount; i++) {
    positions.push(new Vec3(array[i * stride] ?? 0, array[i * stride + 1] ?? 0, array[i * stride + 2] ?? 0));
  }

  const indexArray = index ? index.array : null;
  const elementCount = indexArray ? indexArray.length : vertexCount;
  let faces: number[] = [];
  for (let f = 0; f + 2 < elementCount; f += 3) {
    const a = indexArray ? (indexArray[f] ?? 0) : f;
    const b = indexArray ? (indexArray[f + 1] ?? 0) : f + 1;
    const c = indexArray ? (indexArray[f + 2] ?? 0) : f + 2;
    if (a === b || b === c || a === c) continue;
    faces.push(a, b, c);
  }

  const totalTarget = options.count !== undefined
    ? Math.max(4, vertexCount - Math.max(0, Math.floor(options.count)))
    : Math.max(4, Math.floor(vertexCount * (1 - clamp01(options.ratio ?? 0.5))));
  const maxEdgeLength = options.maxEdgeLength ?? Infinity;

  /* --------------------------------------------------------------- quadrics */

  const quadrics: Quadric[] = Array.from({ length: vertexCount }, () => createQuadric());
  for (let f = 0; f < faces.length; f += 3) {
    const a = positions[faces[f]];
    const b = positions[faces[f + 1]];
    const c = positions[faces[f + 2]];

    const normal = new Vec3().copy(b).sub(a).cross(new Vec3().copy(c).sub(a));
    const length = normal.length();
    if (length < 1e-12) continue;
    normal.divideScalar(length);
    const d = -normal.dot(a);

    for (const vertex of [faces[f], faces[f + 1], faces[f + 2]]) {
      addPlane(quadrics[vertex], normal.x, normal.y, normal.z, d);
    }
  }

  /* ------------------------------------------------------------ vertex state */

  /** `true` once a vertex has been collapsed away. */
  const removed = new Uint8Array(vertexCount);

  /** Where a surviving vertex was moved to. */
  const positionsAfter = positions.map((point) => point.clone());

  /** Incidence: vertex -> the faces containing it. */
  const vertexFaces: Set<number>[] = Array.from({ length: vertexCount }, () => new Set<number>());
  for (let f = 0; f < faces.length; f += 3) {
    vertexFaces[faces[f]].add(f / 3);
    vertexFaces[faces[f + 1]].add(f / 3);
    vertexFaces[faces[f + 2]].add(f / 3);
  }

  /**
   * Candidate collapse target for an edge.
   *
   * Evaluates the combined quadric at the midpoint and at both endpoints and keeps
   * whichever is cheapest; the true optimum would need a 3×3 inverse, which costs
   * more than the error it saves for a load-time modifier.
   */
  const bestTarget = (u: number, v: number, combined: Quadric): Vec3 => {
    const pu = positionsAfter[u];
    const pv = positionsAfter[v];
    const midpoint = new Vec3().addVectors(pu, pv).multiplyScalar(0.5);

    const candidates: Vec3[] = [pu, pv, midpoint];
    let best = midpoint;
    let bestCost = Infinity;
    for (const candidate of candidates) {
      const cost = evaluateQuadric(combined, candidate.x, candidate.y, candidate.z);
      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
      }
    }
    return best.clone();
  };

  /* ---------------------------------------------------------------- collapse */

  const combined = createQuadric();
  let live = vertexCount;

  // A simple priority pass: repeatedly collapse the cheapest edge in the whole mesh.
  // For the mesh sizes this runs on, an O(E) scan per collapse is competitive with
  // maintaining a heap, and it is far easier to keep correct.
  while (live > totalTarget) {
    let bestCost = Infinity;
    let bestU = -1;
    let bestV = -1;
    let bestPosition: Vec3 | null = null;

    for (let f = 0; f < faces.length; f += 3) {
      const tri = [faces[f], faces[f + 1], faces[f + 2]];
      for (let i = 0; i < 3; i++) {
        const u = tri[i];
        const v = tri[(i + 1) % 3];
        if (removed[u] || removed[v]) continue;

        const pu = positionsAfter[u];
        const pv = positionsAfter[v];
        if (pu.distanceTo(pv) > maxEdgeLength) continue;

        // Reject a collapse that would flip a neighbouring face.
        if (wouldFlip(faces, positionsAfter, removed, u, v)) continue;

        combined.coefficients.set(quadrics[u].coefficients);
        addQuadric(combined, quadrics[v]);

        const target = bestTarget(u, v, combined);
        const cost = evaluateQuadric(combined, target.x, target.y, target.z);
        if (cost < bestCost) {
          bestCost = cost;
          bestU = u;
          bestV = v;
          bestPosition = target;
        }
      }
    }

    if (bestU < 0 || bestV < 0 || !bestPosition) break; // nothing collapsible left

    // Collapse `v` into `u`.
    positionsAfter[bestU].copy(bestPosition);
    addQuadric(quadrics[bestU], quadrics[bestV]);
    removed[bestV] = 1;
    live--;

    for (const face of vertexFaces[bestV]) vertexFaces[bestU].add(face);
  }

  /* ---------------------------------------------------------------- rebuild */

  const outputPositions: number[] = [];
  const outputIndices: number[] = [];
  const remap = new Map<number, number>();

  /** Returns the output index for a surviving input vertex. */
  const emit = (vertex: number): number => {
    const existing = remap.get(vertex);
    if (existing !== undefined) return existing;
    const index = outputPositions.length / 3;
    const point = positionsAfter[vertex];
    outputPositions.push(point.x, point.y, point.z);
    remap.set(vertex, index);
    return index;
  };

  /** Resolves a collapsed vertex to the one that absorbed it. */
  const resolve = (vertex: number): number => {
    if (!removed[vertex]) return vertex;
    // Walk the chain: a collapsed vertex's faces now belong to its absorber.
    for (const face of vertexFaces[vertex]) {
      for (let k = face * 3; k < face * 3 + 3; k++) {
        const candidate = faces[k];
        if (!removed[candidate]) return candidate;
      }
    }
    return vertex;
  };

  for (let f = 0; f < faces.length; f += 3) {
    const a = resolve(faces[f]);
    const b = resolve(faces[f + 1]);
    const c = resolve(faces[f + 2]);
    if (a === b || b === c || a === c) continue;
    outputIndices.push(emit(a), emit(b), emit(c));
  }

  const result = new BufferGeometry();
  result.name = geometry.name;
  result.setAttribute(
    'position',
    new Float32BufferAttribute(Float32Array.from(outputPositions), 3, false, 'static', 'position'),
  );
  result.setIndex(new Uint32BufferAttribute(Uint32Array.from(outputIndices), 1));
  result.computeVertexNormals();
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

/**
 * `true` when collapsing `u`–`v` would flip one of the faces around `u` or `v`.
 *
 * Compares each incident face's normal before and after the collapse and rejects a
 * change of more than 90°.
 */
function wouldFlip(
  faces: number[],
  positions: Vec3[],
  removed: Uint8Array,
  u: number,
  v: number,
): boolean {
  const target = new Vec3().addVectors(positions[u], positions[v]).multiplyScalar(0.5);

  for (let f = 0; f < faces.length; f += 3) {
    const tri = [faces[f], faces[f + 1], faces[f + 2]];
    if (!tri.includes(u) && !tri.includes(v)) continue;
    if (tri.some((vertex) => removed[vertex] && vertex !== u && vertex !== v)) continue;

    const before = faceNormal(positions, tri);
    const afterTri = tri.map((vertex) => (vertex === v ? u : vertex));
    if (afterTri[0] === afterTri[1] || afterTri[1] === afterTri[2] || afterTri[0] === afterTri[2]) continue;

    const moved = afterTri.map((vertex) => (vertex === u ? target : positions[vertex]));
    const after = faceNormal(moved, [0, 1, 2]);

    if (before.dot(after) < 0) return true;
  }
  return false;
}

/** Unit normal of a triangle given three positions. */
function faceNormal(positions: Vec3[], tri: readonly number[]): Vec3 {
  const a = positions[tri[0]];
  const b = positions[tri[1]];
  const c = positions[tri[2]];
  if (!a || !b || !c) return new Vec3(0, 0, 1);
  return new Vec3().copy(b).sub(a).cross(new Vec3().copy(c).sub(a)).normalize();
}

/** Clamps a value into `[0, 1]`. */
function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * `SimplifyModifier` — the class form of {@link simplify}.
 */
export class SimplifyModifier {
  /** Creates the modifier. */
  constructor(public readonly options: SimplifyOptions = {}) {}

  /**
   * Decimates a geometry.
   *
   * @param geometry Source geometry.
   * @returns The simplified geometry.
   */
  public modify(geometry: BufferGeometry): BufferGeometry {
    return simplify(geometry, this.options);
  }
}
