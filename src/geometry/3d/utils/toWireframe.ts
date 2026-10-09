/**
 * `toWireframe` — derive a line representation from a triangle mesh.
 *
 * Two output flavours:
 *
 * - **segments** (default) — each edge appears once as a pair of indices, ready
 *   for `LineSegments`. Shared edges are deduplicated by default, so a cube's
 *   12 edges are emitted once each rather than 36 times.
 * - **strip** — the triangle indices unchanged, ready for `Line` with an
 *   `index`-less draw, which is cheaper but repeats shared edges.
 *
 * The produced geometry keeps the source's vertex attributes (positions, normals,
 * UVs) so a wireframe can be shaded with the same material inputs.
 *
 * @packageDocumentation
 */

import { Uint32BufferAttribute } from '../../core/BufferAttribute';
import { BufferGeometry } from '../../core/BufferGeometry';
import type { WireframeOptions } from '../types';
export type { WireframeOptions } from '../types';

/** What the conversion produced. */
export interface WireframeResult {
  /** The line geometry. */
  geometry: BufferGeometry;
  /** Edge count in the output (pairs for `segments`, triangles for `strip`). */
  edgeCount: number;
  /** `true` when the output is an index-pair buffer. */
  segments: boolean;
  /** Edges removed because the two vertices coincided. */
  degenerateEdges: number;
}

/**
 * Builds a wireframe from a triangle mesh.
 *
 * @param geometry Source triangle geometry.
 * @param options See {@link WireframeOptions}.
 * @returns The line geometry and a description of the conversion.
 */
export function toWireframe(
  geometry: BufferGeometry,
  options: WireframeOptions = {},
): WireframeResult {
  const segments = options.segments ?? true;
  const unique = options.unique ?? true;
  const copyAttributes = options.copyAttributes ?? true;
  const degenerateThreshold = options.degenerateThreshold ?? 0;

  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const vertexCount = position
    ? position.count > 0
      ? position.count
      : Math.floor(position.array.length / (position.itemSize || 3))
    : 0;
  const indexArray = index ? index.array : null;
  const elementCount = indexArray ? indexArray.length : vertexCount;
  const faceCount = Math.floor(elementCount / 3);

  const wireframe = new BufferGeometry();
  if (options.name !== undefined) wireframe.name = options.name;

  if (copyAttributes) {
    for (const name of geometry.getAttributeNames()) {
      const attribute = geometry.getAttribute(name);
      if (attribute) wireframe.setAttribute(name, attribute.clone());
    }
  } else if (position) {
    wireframe.setAttribute('position', position.clone());
  }

  /** Reads the three indices of triangle `f`. */
  const triangle = (f: number): [number, number, number] => [
    indexArray ? (indexArray[f * 3] ?? 0) : f * 3,
    indexArray ? (indexArray[f * 3 + 1] ?? 0) : f * 3 + 1,
    indexArray ? (indexArray[f * 3 + 2] ?? 0) : f * 3 + 2,
  ];

  /** `true` when the two vertices are closer than the threshold. */
  const isDegenerate = (a: number, b: number): boolean => {
    if (degenerateThreshold <= 0 || !position) return false;
    const stride = position.itemSize || 3;
    const ax = position.array[a * stride] ?? 0;
    const ay = position.array[a * stride + 1] ?? 0;
    const az = position.array[a * stride + 2] ?? 0;
    const bx = position.array[b * stride] ?? 0;
    const by = position.array[b * stride + 1] ?? 0;
    const bz = position.array[b * stride + 2] ?? 0;
    return Math.hypot(bx - ax, by - ay, bz - az) <= degenerateThreshold;
  };

  if (!segments) {
    // Line-strip form: reuse the triangle indices as-is.
    const data = new Uint32Array(faceCount * 3);
    let degenerateEdges = 0;
    for (let f = 0; f < faceCount; f++) {
      const [a, b, c] = triangle(f);
      data[f * 3] = a;
      data[f * 3 + 1] = b;
      data[f * 3 + 2] = c;
      if (isDegenerate(a, b)) degenerateEdges++;
      if (isDegenerate(b, c)) degenerateEdges++;
      if (isDegenerate(c, a)) degenerateEdges++;
    }
    wireframe.setIndex(new Uint32BufferAttribute(data, 1));
    return { geometry: wireframe, edgeCount: faceCount, segments: false, degenerateEdges };
  }

  const seen = unique ? new Set<number>() : null;
  const pairs: number[] = [];
  let degenerateEdges = 0;

  /** Records an undirected edge. */
  const addEdge = (a: number, b: number): void => {
    if (a === b || isDegenerate(a, b)) {
      degenerateEdges++;
      return;
    }
    if (seen) {
      // Order-independent key so (a,b) and (b,a) collide.
      const low = Math.min(a, b);
      const high = Math.max(a, b);
      const key = low * 4294967296 + high;
      if (seen.has(key)) return;
      seen.add(key);
    }
    pairs.push(a, b);
  };

  for (let f = 0; f < faceCount; f++) {
    const [a, b, c] = triangle(f);
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }

  wireframe.setIndex(new Uint32BufferAttribute(Uint32Array.from(pairs), 1));
  return { geometry: wireframe, edgeCount: pairs.length / 2, segments: true, degenerateEdges };
}

/**
 * Convenience wrapper returning just the geometry.
 *
 * @param geometry Source triangle geometry.
 * @param options See {@link WireframeOptions}.
 * @returns The line geometry.
 */
export function toWireframeGeometry(
  geometry: BufferGeometry,
  options: WireframeOptions = {},
): BufferGeometry {
  return toWireframe(geometry, options).geometry;
}
