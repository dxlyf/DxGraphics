/**
 * `EdgeSplitModifier` — split vertices along sharp edges.
 *
 * ## When to use this instead of `computeNormals({ mode: 'angle' })`
 *
 * Both produce a hard edge at a crease, by different means:
 *
 * - `computeNormals` keeps the shared vertex and writes *different normals* to the
 *   corners that use it, which requires a non-indexed geometry and inflates the
 *   vertex count everywhere;
 * - this modifier splits only the vertices that actually sit on a sharp edge, so a
 *   mostly-smooth mesh keeps its shared vertices and only its creases are
 *   duplicated.
 *
 * Use this when the crease is a real topological break (an imported hard-surface
 * model, a bevel that must stay crisp), and `computeNormals` when you only want the
 * shading to change.
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../../math/Vec3';
import { BufferGeometry } from '../../core/BufferGeometry';
import { Float32BufferAttribute, Uint32BufferAttribute } from '../../core/BufferAttribute';
import { computeBoundingBox } from '../utils/computeBoundingBox';
import { computeBoundingSphere } from '../utils/computeBoundingSphere';
import type { EdgeSplitOptions } from '../types';

/** Options accepted by {@link splitEdges}. */
export type { EdgeSplitOptions };

/** What an edge split did. */
export interface EdgeSplitResult {
  /** The new geometry. */
  geometry: BufferGeometry;
  /** Vertices in the input. */
  inputVertices: number;
  /** Vertices in the output. */
  outputVertices: number;
  /** Edges that were split. */
  splitEdges: number;
}

/**
 * Splits every edge whose dihedral angle exceeds `maxAngle`.
 *
 * @param geometry Source geometry.
 * @param options See {@link EdgeSplitOptions}.
 * @returns The new geometry and a summary of the split.
 */
export function splitEdges(
  geometry: BufferGeometry,
  options: EdgeSplitOptions = {},
): EdgeSplitResult {
  const maxAngle = options.maxAngle ?? Math.PI / 4;
  const recomputeNormals = options.recomputeNormals ?? false;
  const cosLimit = Math.cos(maxAngle);

  const position = geometry.getAttribute('position');
  if (!position) {
    return {
      geometry: geometry.clone(),
      inputVertices: 0,
      outputVertices: 0,
      splitEdges: 0,
    };
  }

  const index = geometry.getIndex();
  const array = position.array;
  const stride = position.itemSize || 3;
  const inputVertices = position.count > 0 ? position.count : Math.floor(array.length / stride);

  const positions: Vec3[] = [];
  for (let i = 0; i < inputVertices; i++) {
    positions.push(new Vec3(array[i * stride] ?? 0, array[i * stride + 1] ?? 0, array[i * stride + 2] ?? 0));
  }

  const indexArray = index ? index.array : null;
  const elementCount = indexArray ? indexArray.length : inputVertices;
  const faceCount = Math.floor(elementCount / 3);

  /** Reads the three indices of a face. */
  const face = (f: number): [number, number, number] => [
    indexArray ? (indexArray[f * 3] ?? 0) : f * 3,
    indexArray ? (indexArray[f * 3 + 1] ?? 0) : f * 3 + 1,
    indexArray ? (indexArray[f * 3 + 2] ?? 0) : f * 3 + 2,
  ];

  /* ------------------------------------------------------ edge -> faces map */

  const edgeFaces = new Map<string, number[]>();
  for (let f = 0; f < faceCount; f++) {
    const [a, b, c] = face(f);
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      const list = edgeFaces.get(key);
      if (list) list.push(f);
      else edgeFaces.set(key, [f]);
    }
  }

  /* -------------------------------------------------------- which to split */

  /** Edge key -> `true` when the crease is sharp enough to split. */
  const sharp = new Set<string>();

  const normalOf = (f: number): Vec3 => {
    const [a, b, c] = face(f);
    return new Vec3()
      .copy(positions[b])
      .sub(positions[a])
      .cross(new Vec3().copy(positions[c]).sub(positions[a]))
      .normalize();
  };

  for (const [key, faces] of edgeFaces) {
    if (faces.length !== 2) continue; // boundary or non-manifold: leave it alone
    const dot = normalOf(faces[0]).dot(normalOf(faces[1]));
    if (dot < cosLimit) sharp.add(key);
  }

  /* ------------------------------------------------------------- the split */

  // For each (face, vertex) corner on a sharp edge, allocate a distinct output
  // vertex. A corner keeps the original index when every edge meeting it in that
  // face is smooth, so a smooth interior is not inflated at all.
  const outputPositions: number[] = [];
  const outputIndices: number[] = [];
  const cornerMap = new Map<string, number>();
  let outputVertices = 0;

  /**
   * Returns the output index for one corner.
   *
   * `faceIndex` is `-1` for a smooth corner, which is shared by every face that
   * meets it; a hard corner passes its own face index, and a per-face key
   * (`faceIndex >= 0`) can never collide with a shared one.
   */
  const emitCorner = (faceIndex: number, vertex: number): number => {
    const key = `${faceIndex}_${vertex}`;
    const existing = cornerMap.get(key);
    if (existing !== undefined) return existing;

    const point = positions[vertex];
    const index = outputPositions.length / 3;
    outputPositions.push(point.x, point.y, point.z);
    cornerMap.set(key, index);
    outputVertices++;
    return index;
  };

  for (let f = 0; f < faceCount; f++) {
    const [a, b, c] = face(f);
    const tri: [number, number, number] = [a, b, c];

    for (let i = 0; i < 3; i++) {
      const vertex = tri[i];
      const previous = tri[(i - 1 + 3) % 3];
      const next = tri[(i + 1) % 3];

      const edgePrevious = previous < vertex ? `${previous}_${vertex}` : `${vertex}_${previous}`;
      const edgeNext = vertex < next ? `${vertex}_${next}` : `${next}_${vertex}`;

      // A corner is "hard" when either edge meeting it in this face is a crease:
      // those are exactly the corners that need their own vertex.
      const hard = sharp.has(edgePrevious) || sharp.has(edgeNext);
      outputIndices.push(emitCorner(hard ? f : -1, vertex));
    }
  }

  const result = new BufferGeometry();
  result.name = geometry.name;
  result.setAttribute(
    'position',
    new Float32BufferAttribute(Float32Array.from(outputPositions), 3, false, 'static', 'position'),
  );
  result.setIndex(new Uint32BufferAttribute(Uint32Array.from(outputIndices), 1));

  if (recomputeNormals || !geometry.getAttribute('normal')) {
    result.computeVertexNormals();
  }

  computeBoundingBox(result);
  computeBoundingSphere(result);

  return {
    geometry: result,
    inputVertices,
    outputVertices,
    splitEdges: sharp.size,
  };
}

/**
 * `EdgeSplitModifier` — the class form of {@link splitEdges}.
 */
export class EdgeSplitModifier {
  /** Creates the modifier. */
  constructor(public readonly options: EdgeSplitOptions = {}) {}

  /**
   * Splits the sharp edges of a geometry.
   *
   * @param geometry Source geometry.
   * @returns The new geometry.
   */
  public modify(geometry: BufferGeometry): BufferGeometry {
    return splitEdges(geometry, this.options).geometry;
  }
}
