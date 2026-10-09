/**
 * Shared helpers for the geometry parsers.
 *
 * OBJ, STL, PLY and glTF all end up needing the same five operations — deduplicate
 * vertices, fan-triangulate a polygon, compute normals, normalise UVs, recentre — so
 * they live here once. Each is written against flat `Float32Array`/`Uint32Array`
 * buffers rather than `Vec3` objects, because a 200 000-triangle mesh allocates
 * 600 000 `Vec3`s otherwise.
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../math/Vec3';
import type { MeshLike, GeometryLike } from '../types';

/* -------------------------------------------------------------------------- */
/* Vertex deduplication                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Builds a vertex-keyed deduplication table.
 *
 * OBJ and PLY both index attributes independently (`v`, `vt`, `vn`), so a face
 * corner is a *triple* of indices and the renderer needs a single index. This table
 * maps a corner key to a unique output index, allocating one on first sight.
 *
 * Keys are quantised to `precision` decimals so that two positions differing in the
 * 12th float digit deduplicate together — which is what makes a welded mesh.
 */
export class VertexWelder {
  /** Corner key → output vertex index. */
  private readonly index = new Map<string, number>();

  /** Positions written so far, three floats per vertex. */
  private readonly positions: number[] = [];

  /** UVs written so far, two floats per vertex. */
  private readonly uvs: number[] = [];

  /** Normals written so far, three floats per vertex. */
  private readonly normals: number[] = [];

  /** `true` once at least one UV has been written. */
  private hasUvs = false;

  /** `true` once at least one normal has been written. */
  private hasNormals = false;

  /**
   * Creates a welder.
   *
   * @param precision Decimal places kept in a key; defaults to `6`.
   */
  constructor(private readonly precision = 6) {}

  /** Rounds a component into a stable string fragment. */
  private quantise(value: number): number {
    if (!Number.isFinite(value)) return 0;
    const factor = Math.pow(10, this.precision);
    return Math.round(value * factor) / factor;
  }

  /**
   * Returns the output index for a corner, allocating one when needed.
   *
   * @param positions Source positions, three floats per vertex.
   * @param pIndex Source position index.
   * @param uvs Source UVs, two floats per vertex.
   * @param uvIndex Source UV index, or `-1`.
   * @param normals Source normals, three floats per vertex.
   * @param nIndex Source normal index, or `-1`.
   * @returns The output vertex index.
   */
  public weld(
    positions: ArrayLike<number>,
    pIndex: number,
    uvs: ArrayLike<number>,
    uvIndex: number,
    normals: ArrayLike<number>,
    nIndex: number,
  ): number {
    const px = this.quantise(positions[pIndex * 3] ?? 0);
    const py = this.quantise(positions[pIndex * 3 + 1] ?? 0);
    const pz = this.quantise(positions[pIndex * 3 + 2] ?? 0);

    const hasUv = uvIndex >= 0 && uvs.length >= (uvIndex + 1) * 2;
    const u = hasUv ? this.quantise(uvs[uvIndex * 2] ?? 0) : 0;
    const v = hasUv ? this.quantise(uvs[uvIndex * 2 + 1] ?? 0) : 0;

    const hasNormal = nIndex >= 0 && normals.length >= (nIndex + 1) * 3;
    const nx = hasNormal ? this.quantise(normals[nIndex * 3] ?? 0) : 0;
    const ny = hasNormal ? this.quantise(normals[nIndex * 3 + 1] ?? 0) : 0;
    const nz = hasNormal ? this.quantise(normals[nIndex * 3 + 2] ?? 0) : 0;

    const key = `${px},${py},${pz}|${u},${v}|${nx},${ny},${nz}`;
    const existing = this.index.get(key);
    if (existing !== undefined) return existing;

    const allocated = this.positions.length / 3;
    this.index.set(key, allocated);
    this.positions.push(px, py, pz);

    if (hasUv) {
      this.hasUvs = true;
      this.uvs.push(u, v);
    } else {
      this.uvs.push(0, 0);
    }

    if (hasNormal) {
      this.hasNormals = true;
      this.normals.push(nx, ny, nz);
    } else {
      this.normals.push(0, 0, 0);
    }

    return allocated;
  }

  /** Number of unique vertices produced. */
  public get vertexCount(): number {
    return this.positions.length / 3;
  }

  /**
   * @returns The welded buffers.
   */
  public build(): {
    positions: Float32Array;
    uvs: Float32Array;
    normals: Float32Array;
    hasUvs: boolean;
    hasNormals: boolean;
  } {
    return {
      positions: Float32Array.from(this.positions),
      uvs: Float32Array.from(this.uvs),
      normals: Float32Array.from(this.normals),
      hasUvs: this.hasUvs,
      hasNormals: this.hasNormals,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Triangulation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fan-triangulates a convex polygon.
 *
 * OBJ and PLY both allow an arbitrary-vertex face. A fan is correct for the convex
 * case (which is what exporters emit) and is what every lightweight loader uses; a
 * full ear-clipping pass would be needed only for a concave n-gon, which is
 * documented as out of scope.
 *
 * @param cornerCount Number of corners.
 * @param out Destination index array.
 * @returns The number of triangles appended.
 */
export function fanTriangulate(cornerCount: number, out: number[]): number {
  if (cornerCount < 3) return 0;
  let triangles = 0;
  for (let i = 1; i + 1 < cornerCount; i++) {
    out.push(0, i, i + 1);
    triangles++;
  }
  return triangles;
}

/* -------------------------------------------------------------------------- */
/* Normals                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Computes area-weighted vertex normals from positions and indices.
 *
 * Area weighting falls out of using the un-normalised cross product: a large
 * triangle contributes proportionally more, which is what keeps a low-poly surface
 * from being dominated by its smallest facets.
 *
 * @param positions Positions, three floats per vertex.
 * @param indices Triangle indices.
 * @returns Normals, three floats per vertex.
 */
export function computeVertexNormals(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): Float32Array {
  const normals = new Float32Array(positions.length);

  const a = new Vec3();
  const b = new Vec3();
  const c = new Vec3();
  const edge1 = new Vec3();
  const edge2 = new Vec3();
  const cross = new Vec3();

  const triangleCount = Math.floor(indices.length / 3);
  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];

    a.set(positions[i0 * 3] ?? 0, positions[i0 * 3 + 1] ?? 0, positions[i0 * 3 + 2] ?? 0);
    b.set(positions[i1 * 3] ?? 0, positions[i1 * 3 + 1] ?? 0, positions[i1 * 3 + 2] ?? 0);
    c.set(positions[i2 * 3] ?? 0, positions[i2 * 3 + 1] ?? 0, positions[i2 * 3 + 2] ?? 0);

    edge1.subVectors(b, a);
    edge2.subVectors(c, a);
    cross.crossVectors(edge1, edge2);

    for (const index of [i0, i1, i2]) {
      normals[index * 3] += cross.x;
      normals[index * 3 + 1] += cross.y;
      normals[index * 3 + 2] += cross.z;
    }
  }

  // Normalise in place; a vertex with no incident triangle keeps (0, 0, 0).
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i];
    const y = normals[i + 1];
    const z = normals[i + 2];
    const length = Math.hypot(x, y, z);
    if (length > 1e-12) {
      normals[i] = x / length;
      normals[i + 1] = y / length;
      normals[i + 2] = z / length;
    }
  }

  return normals;
}

/* -------------------------------------------------------------------------- */
/* Post-processing                                                            */
/* -------------------------------------------------------------------------- */

/** Options accepted by {@link postProcessPositions}. */
export interface PostProcessOptions {
  /** Uniform scale applied to every position. */
  scale?: number;
  /** Recentre on the bounding-box centre. */
  center?: boolean;
}

/**
 * Applies scale and centring to a position buffer, in place.
 *
 * @param positions Positions, three floats per vertex; mutated.
 * @param options Scale and centring flags.
 * @returns The mutated buffer.
 */
export function postProcessPositions(
  positions: Float32Array,
  options: PostProcessOptions = {},
): Float32Array {
  const scale = options.scale ?? 1;

  if (scale !== 1) {
    for (let i = 0; i < positions.length; i++) positions[i] *= scale;
  }

  if (options.center === true && positions.length >= 3) {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;

    for (let i = 0; i < positions.length; i += 3) {
      positions[i] -= cx;
      positions[i + 1] -= cy;
      positions[i + 2] -= cz;
    }
  }

  return positions;
}

/**
 * Flips the V coordinate of a UV buffer, in place.
 *
 * OBJ, PLY and glTF all use a bottom-left UV origin; WebGL's `flipY` upload does the
 * conversion for textures, but a geometry that will be sampled in a shader directly
 * usually wants it applied to the data instead.
 *
 * @param uvs UVs, two floats per vertex; mutated.
 * @returns The mutated buffer.
 */
export function flipV(uvs: Float32Array): Float32Array {
  for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
  return uvs;
}

/**
 * Computes the axis-aligned bounds of a position buffer.
 *
 * @param positions Positions, three floats per vertex.
 * @returns Min and max corners, or `null` for an empty buffer.
 */
export function computeBounds(positions: ArrayLike<number>): { min: Vec3; max: Vec3 } | null {
  if (positions.length < 3) return null;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  return { min: new Vec3(minX, minY, minZ), max: new Vec3(maxX, maxY, maxZ) };
}

/**
 * Wraps flat buffers in a `MeshLike` result.
 *
 * @param name Mesh name.
 * @param positions Positions, three floats per vertex.
 * @param indices Triangle indices.
 * @param uvs UVs, or `null`.
 * @param normals Normals, or `null`.
 * @param material Material name, when the format supplied one.
 * @returns A mesh-shaped result.
 */
export function toMeshResult(
  name: string,
  positions: Float32Array,
  indices: Uint32Array,
  uvs: Float32Array | null,
  normals: Float32Array | null,
  material?: string | number | null,
): MeshLike {
  const attributes: Record<string, { array: ArrayLike<number>; itemSize: number; count: number }> = {
    position: { array: positions, itemSize: 3, count: positions.length / 3 },
  };
  if (normals !== null && normals.length > 0) {
    attributes.normal = { array: normals, itemSize: 3, count: normals.length / 3 };
  }
  if (uvs !== null && uvs.length > 0) {
    attributes.uv = { array: uvs, itemSize: 2, count: uvs.length / 2 };
  }

  const geometry: GeometryLike = {
    attributes,
    index: { array: indices, itemSize: 1, count: indices.length },
  };

  const bounds = computeBounds(positions);

  return {
    name,
    geometry,
    ...(material === undefined ? {} : { material: material ?? null }),
    ...(bounds === null ? {} : { bounds }),
  };
}

/**
 * Splits a UTF-8 byte buffer into lines, tolerating `\r\n` and a BOM.
 *
 * @param source Raw bytes.
 * @returns The lines, without terminators.
 */
export function bytesToLines(source: ArrayBuffer | Uint8Array): string[] {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  // A binary file misdetected as text would produce one enormous line; the
  // replacements keep `TextDecoder` from throwing on invalid sequences.
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const text = decoder.decode(bytes).replace(/^\uFEFF/, '');
  return text.replace(/\r\n?/g, '\n').split('\n');
}
