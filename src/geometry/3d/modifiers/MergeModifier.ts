/**
 * `MergeModifier` — weld coincident vertices.
 *
 * The counterpart of an import: OBJ, STL and PLY files all repeat a vertex once per
 * face, so a cube arrives with 36 vertices instead of 8. Welding them back is what
 * makes smooth shading, index buffers and vertex-animation possible.
 *
 * ## Which vertices may be welded
 *
 * Two vertices are merged only when they agree on **every attribute the caller asks
 * about** — position always, plus UV and normal when requested. Merging on position
 * alone would destroy a UV seam (the two sides of a cylinder's seam share a position
 * but need different `u`), and merging on normal alone would collapse a hard edge.
 * That is why the options default to merging position plus UV, and why the
 * `tolerance` is a position tolerance only.
 *
 * The vertex order of the first occurrence is preserved, so the output is
 * deterministic.
 *
 * @packageDocumentation
 */

import { BufferGeometry } from '../../core/BufferGeometry';
import { Float32BufferAttribute, Uint32BufferAttribute } from '../../core/BufferAttribute';
import { computeBoundingBox } from '../utils/computeBoundingBox';
import { computeBoundingSphere } from '../utils/computeBoundingSphere';
import type { MergeOptions } from '../types';

/** Options accepted by {@link mergeVertices}. */
export type { MergeOptions };

/** What a merge did. */
export interface MergeVerticesResult {
  /** The welded geometry. */
  geometry: BufferGeometry;
  /** Vertices in the input. */
  inputVertices: number;
  /** Vertices in the output. */
  outputVertices: number;
  /** Vertices removed. */
  mergedCount: number;
}

/**
 * Welds vertices that agree on position (and optionally UV/normal) within
 * `tolerance`.
 *
 * @param geometry Source geometry.
 * @param options See {@link MergeOptions}.
 * @returns The welded geometry and a summary.
 */
export function mergeVertices(
  geometry: BufferGeometry,
  options: MergeOptions = {},
): MergeVerticesResult {
  const tolerance = Math.max(0, options.tolerance ?? 1e-6);
  const mergeUv = options.mergeUv ?? true;
  const mergeNormals = options.mergeNormals ?? false;

  const position = geometry.getAttribute('position');
  if (!position) {
    return {
      geometry: geometry.clone(),
      inputVertices: 0,
      outputVertices: 0,
      mergedCount: 0,
    };
  }

  const uv = mergeUv ? geometry.getAttribute('uv') : undefined;
  const normal = mergeNormals ? geometry.getAttribute('normal') : undefined;

  const array = position.array;
  const stride = position.itemSize || 3;
  const inputVertices = position.count > 0 ? position.count : Math.floor(array.length / stride);

  const decimals = tolerance > 0 ? Math.max(0, Math.ceil(-Math.log10(tolerance))) : 12;

  /** Rounds a coordinate to the welding grid. */
  const quantize = (value: number): string => value.toFixed(Math.min(12, decimals));

  const remap = new Int32Array(inputVertices).fill(-1);
  const outputPositions: number[] = [];
  const outputUvs: number[] = [];
  const outputNormals: number[] = [];
  const lookup = new Map<string, number>();
  let outputVertices = 0;

  for (let i = 0; i < inputVertices; i++) {
    const parts: string[] = [
      quantize(array[i * stride] ?? 0),
      quantize(array[i * stride + 1] ?? 0),
      quantize(array[i * stride + 2] ?? 0),
    ];
    if (uv) parts.push(quantize(uv.array[i * 2] ?? 0), quantize(uv.array[i * 2 + 1] ?? 0));
    if (normal) {
      parts.push(
        quantize(normal.array[i * 3] ?? 0),
        quantize(normal.array[i * 3 + 1] ?? 0),
        quantize(normal.array[i * 3 + 2] ?? 0),
      );
    }
    const key = parts.join('|');

    const existing = lookup.get(key);
    if (existing !== undefined) {
      remap[i] = existing;
      continue;
    }

    const index = outputVertices++;
    lookup.set(key, index);
    remap[i] = index;
    outputPositions.push(array[i * stride] ?? 0, array[i * stride + 1] ?? 0, array[i * stride + 2] ?? 0);
    if (uv) outputUvs.push(uv.array[i * 2] ?? 0, uv.array[i * 2 + 1] ?? 0);
    if (normal) {
      outputNormals.push(
        normal.array[i * 3] ?? 0,
        normal.array[i * 3 + 1] ?? 0,
        normal.array[i * 3 + 2] ?? 0,
      );
    }
  }

  const result = new BufferGeometry();
  result.name = geometry.name;
  result.setAttribute(
    'position',
    new Float32BufferAttribute(Float32Array.from(outputPositions), 3, false, 'static', 'position'),
  );
  if (uv) {
    result.setAttribute('uv', new Float32BufferAttribute(Float32Array.from(outputUvs), 2, false, 'static', 'uv'));
  }
  if (normal) {
    result.setAttribute(
      'normal',
      new Float32BufferAttribute(Float32Array.from(outputNormals), 3, false, 'static', 'normal'),
    );
  }

  // Remap the index buffer, dropping triangles that collapsed.
  const index = geometry.getIndex();
  const indexArray = index ? index.array : null;
  const elementCount = indexArray ? indexArray.length : inputVertices;
  const indices: number[] = [];
  for (let f = 0; f + 2 < elementCount; f += 3) {
    const a = remap[indexArray ? (indexArray[f] ?? 0) : f];
    const b = remap[indexArray ? (indexArray[f + 1] ?? 0) : f + 1];
    const c = remap[indexArray ? (indexArray[f + 2] ?? 0) : f + 2];
    if (a === b || b === c || a === c) continue;
    indices.push(a, b, c);
  }
  result.setIndex(new Uint32BufferAttribute(Uint32Array.from(indices), 1));

  computeBoundingBox(result);
  computeBoundingSphere(result);

  return {
    geometry: result,
    inputVertices,
    outputVertices,
    mergedCount: inputVertices - outputVertices,
  };
}

/**
 * `MergeModifier` — the class form of {@link mergeVertices}.
 */
export class MergeModifier {
  /** Creates the modifier. */
  constructor(public readonly options: MergeOptions = {}) {}

  /**
   * Welds the coincident vertices of a geometry.
   *
   * @param geometry Source geometry.
   * @returns The welded geometry.
   */
  public modify(geometry: BufferGeometry): BufferGeometry {
    return mergeVertices(geometry, this.options).geometry;
  }
}
