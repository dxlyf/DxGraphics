/**
 * `TessellateModifier` — subdivide faces until no edge exceeds a length.
 *
 * Unlike `SubdivisionModifier`, this does **not** smooth: every new vertex is
 * placed on the original surface (midpoint subdivision), so the silhouette is
 * unchanged and only the tessellation density rises. That is what a displacement or
 * a vertex-shader effect needs — enough vertices to displace without altering the
 * base shape.
 *
 * The loop is bounded by `maxIterations` because subdivision grows the vertex count
 * by 4× per pass and an unbounded loop on a pathological input (a single very long
 * edge among many short ones) would exhaust memory.
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../../math/Vec3';
import { BufferGeometry } from '../../core/BufferGeometry';
import { Float32BufferAttribute, Uint32BufferAttribute } from '../../core/BufferAttribute';
import { computeBoundingBox } from '../utils/computeBoundingBox';
import { computeBoundingSphere } from '../utils/computeBoundingSphere';
import type { TessellateOptions } from '../types';

/** Options accepted by {@link tessellate}. */
export type { TessellateOptions };

/** What a tessellation pass did. */
export interface TessellateResult {
  /** The tessellated geometry. */
  geometry: BufferGeometry;
  /** Passes actually applied. */
  iterations: number;
  /** Triangles in the output. */
  triangleCount: number;
  /** `true` when the iteration cap stopped the process early. */
  capped: boolean;
}

/**
 * Subdivides until every edge is at most `maxEdgeLength`.
 *
 * @param geometry Source geometry.
 * @param options See {@link TessellateOptions}.
 * @returns The tessellated result, including whether the cap was hit.
 */
export function tessellate(
  geometry: BufferGeometry,
  options: TessellateOptions = {},
): TessellateResult {
  const maxEdgeLength = Math.max(1e-6, options.maxEdgeLength ?? 0.1);
  const maxIterations = Math.max(0, Math.floor(options.maxIterations ?? 8));

  const position = geometry.getAttribute('position');
  if (!position) {
    return { geometry: geometry.clone(), iterations: 0, triangleCount: 0, capped: false };
  }

  const index = geometry.getIndex();
  const array = position.array;
  const stride = position.itemSize || 3;
  const vertexCount = position.count > 0 ? position.count : Math.floor(array.length / stride);

  let vertices: Vec3[] = [];
  for (let i = 0; i < vertexCount; i++) {
    vertices.push(new Vec3(array[i * stride] ?? 0, array[i * stride + 1] ?? 0, array[i * stride + 2] ?? 0));
  }

  const indexArray = index ? index.array : null;
  const elementCount = indexArray ? indexArray.length : vertexCount;
  let faces: number[] = [];
  for (let f = 0; f + 2 < elementCount; f += 3) {
    faces.push(
      indexArray ? (indexArray[f] ?? 0) : f,
      indexArray ? (indexArray[f + 1] ?? 0) : f + 1,
      indexArray ? (indexArray[f + 2] ?? 0) : f + 2,
    );
  }

  const maxEdgeSquared = maxEdgeLength * maxEdgeLength;
  let iterations = 0;
  let capped = false;

  while (iterations < maxIterations) {
    /** `true` when at least one edge needs splitting. */
    let needsSplit = false;
    for (let f = 0; f < faces.length && !needsSplit; f += 3) {
      const a = vertices[faces[f]];
      const b = vertices[faces[f + 1]];
      const c = vertices[faces[f + 2]];
      if (
        a.distanceToSquared(b) > maxEdgeSquared ||
        b.distanceToSquared(c) > maxEdgeSquared ||
        c.distanceToSquared(a) > maxEdgeSquared
      ) {
        needsSplit = true;
      }
    }
    if (!needsSplit) break;

    const midpoints = new Map<string, number>();
    const nextVertices = vertices.slice();
    const nextFaces: number[] = [];

    /** Returns (creating if needed) the midpoint of an edge. */
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const cached = midpoints.get(key);
      if (cached !== undefined) return cached;
      const created = nextVertices.length;
      nextVertices.push(new Vec3().addVectors(vertices[a], vertices[b]).multiplyScalar(0.5));
      midpoints.set(key, created);
      return created;
    };

    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f];
      const b = faces[f + 1];
      const c = faces[f + 2];

      const abLong = vertices[a].distanceToSquared(vertices[b]) > maxEdgeSquared;
      const bcLong = vertices[b].distanceToSquared(vertices[c]) > maxEdgeSquared;
      const caLong = vertices[c].distanceToSquared(vertices[a]) > maxEdgeSquared;

      const splitCount = Number(abLong) + Number(bcLong) + Number(caLong);

      if (splitCount === 0) {
        nextFaces.push(a, b, c);
        continue;
      }

      if (splitCount === 3) {
        // Split every edge: one central triangle plus three corners.
        const ab = midpoint(a, b);
        const bc = midpoint(b, c);
        const ca = midpoint(c, a);
        nextFaces.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
        continue;
      }

      if (splitCount === 1) {
        // Split only the offending edge.
        if (abLong) {
          const ab = midpoint(a, b);
          nextFaces.push(a, ab, c, ab, b, c);
        } else if (bcLong) {
          const bc = midpoint(b, c);
          nextFaces.push(b, bc, a, bc, c, a);
        } else {
          const ca = midpoint(c, a);
          nextFaces.push(c, ca, b, ca, a, b);
        }
        continue;
      }

      // Two long edges: split at their shared vertex's opposite midpoints.
      if (!abLong) {
        // bc and ca are long.
        const bc = midpoint(b, c);
        const ca = midpoint(c, a);
        nextFaces.push(a, b, bc, a, bc, ca, ca, bc, c);
      } else if (!bcLong) {
        // ab and ca are long.
        const ab = midpoint(a, b);
        const ca = midpoint(c, a);
        nextFaces.push(a, ab, ca, ab, b, ca, b, c, ca);
      } else {
        // ab and bc are long.
        const ab = midpoint(a, b);
        const bc = midpoint(b, c);
        nextFaces.push(a, ab, bc, a, bc, c, ab, b, bc);
      }
    }

    vertices = nextVertices;
    faces = nextFaces;
    iterations++;

    if (iterations === maxIterations) {
      // Check whether more work remains, so the caller learns the cap was hit.
      for (let f = 0; f < faces.length; f += 3) {
        const a = vertices[faces[f]];
        const b = vertices[faces[f + 1]];
        const c = vertices[faces[f + 2]];
        if (
          a.distanceToSquared(b) > maxEdgeSquared ||
          b.distanceToSquared(c) > maxEdgeSquared ||
          c.distanceToSquared(a) > maxEdgeSquared
        ) {
          capped = true;
          break;
        }
      }
    }
  }

  const positions = new Float32Array(vertices.length * 3);
  for (let i = 0; i < vertices.length; i++) {
    positions[i * 3] = vertices[i].x;
    positions[i * 3 + 1] = vertices[i].y;
    positions[i * 3 + 2] = vertices[i].z;
  }

  const result = new BufferGeometry();
  result.name = geometry.name;
  result.setAttribute('position', new Float32BufferAttribute(positions, 3, false, 'static', 'position'));
  result.setIndex(new Uint32BufferAttribute(Uint32Array.from(faces), 1));
  result.computeVertexNormals();
  computeBoundingBox(result);
  computeBoundingSphere(result);

  return { geometry: result, iterations, triangleCount: faces.length / 3, capped };
}

/**
 * `TessellateModifier` — the class form of {@link tessellate}.
 */
export class TessellateModifier {
  /** Creates the modifier. */
  constructor(public readonly options: TessellateOptions = {}) {}

  /**
   * Tessellates a geometry.
   *
   * @param geometry Source geometry.
   * @returns The tessellated geometry.
   */
  public modify(geometry: BufferGeometry): BufferGeometry {
    return tessellate(geometry, this.options).geometry;
  }
}
