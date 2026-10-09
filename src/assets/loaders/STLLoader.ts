/**
 * `STLLoader` — STL in both its ASCII and binary forms.
 *
 * STL stores nothing but triangles: no indices, no UVs, no materials, and a
 * per-facet normal that is frequently wrong (many exporters write `(0, 0, 0)`).
 * That makes the loader small but the *detection* subtle, because both forms can
 * legitimately begin with the word `solid`.
 *
 * ## Detection
 *
 * Three checks, in order:
 *
 * 1. **Size arithmetic.** A binary file is exactly `84 + 50 * triangleCount` bytes.
 *    If the declared count matches the actual length, it is binary — this is
 *    decisive and cannot be fooled by a `solid` header.
 * 2. **The `facet` keyword.** An ASCII file contains `facet normal` within its first
 *    few hundred bytes; a binary file's facet records are `float32` and will not
 *    decode to that ASCII text.
 * 3. **`solid` prefix.** If neither check fires, a `solid` prefix means ASCII.
 *
 * The result records which branch was taken, so a caller never has to guess.
 *
 * ```ts
 * const ascii = parseSTL('solid s\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\n...');
 * ascii.format;          // 'ascii'
 * const binary = parseSTL(bufferWithMagicCount);   // 'binary'
 * ```
 *
 * @packageDocumentation
 */

import { Loader, type LoadedSource } from './Loader';
import { bytesToLines, postProcessPositions, type PostProcessOptions } from './geometryUtils';
import type { FetchLike, LoadOptions, MeshLoadOptions, MeshLike, STLParseResult } from '../types';

/** Options accepted by {@link STLLoader.loadAsync}. */
export interface STLLoadOptions extends MeshLoadOptions {
  /** `fetch` implementation override. */
  fetcher?: FetchLike;
  /** Force a format instead of detecting it. */
  format?: 'ascii' | 'binary' | 'auto';
}

/** Bytes a binary STL header occupies: an 80-byte comment plus a `uint32` count. */
export const STL_HEADER_BYTES = 84;

/** Bytes per binary STL triangle record. */
export const STL_TRIANGLE_BYTES = 50;

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Decides whether a buffer is a binary STL.
 *
 * @param bytes Raw bytes.
 * @returns `true` when the buffer is binary.
 */
export function isBinarySTL(bytes: Uint8Array): boolean {
  if (bytes.byteLength < STL_HEADER_BYTES) return false;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(80, true);
  if (declared === 0) return false;

  const expected = STL_HEADER_BYTES + declared * STL_TRIANGLE_BYTES;
  if (expected === bytes.byteLength) return true;

  // Some writers round the file up; accept a small overshoot but not an undershoot.
  if (bytes.byteLength >= expected && bytes.byteLength - expected < STL_TRIANGLE_BYTES) return true;

  return false;
}

/* -------------------------------------------------------------------------- */
/* ASCII                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Parses an ASCII STL file.
 *
 * The parser is a token scanner rather than a line parser, because exporters are
 * inconsistent about line breaks inside a facet.
 *
 * @param source ASCII text.
 * @returns The parsed triangles.
 * @throws Error When no triangle was found.
 */
export function parseSTLAscii(source: string): STLParseResult {
  const text = source.replace(/^\uFEFF/, '');
  const tokens = text.split(/\s+/);

  const positions: number[] = [];
  const normals: number[] = [];
  let count = 0;

  let pendingNormal: [number, number, number] = [0, 0, 0];
  let inFacet = false;
  let cornerCount = 0;
  let triangle: number[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    switch (token) {
      case 'facet': {
        // `facet normal nx ny nz`
        if (tokens[i + 1] === 'normal') {
          pendingNormal = [
            Number(tokens[i + 2]) || 0,
            Number(tokens[i + 3]) || 0,
            Number(tokens[i + 4]) || 0,
          ];
          i += 4;
        }
        inFacet = true;
        cornerCount = 0;
        triangle = [];
        break;
      }
      case 'vertex': {
        if (!inFacet) break;
        const x = Number(tokens[i + 1]) || 0;
        const y = Number(tokens[i + 2]) || 0;
        const z = Number(tokens[i + 3]) || 0;
        i += 3;
        triangle.push(x, y, z);
        cornerCount++;
        break;
      }
      case 'endfacet': {
        if (inFacet && cornerCount >= 3) {
          // Keep the first three corners; a malformed facet with more is truncated.
          positions.push(triangle[0], triangle[1], triangle[2]);
          positions.push(triangle[3], triangle[4], triangle[5]);
          positions.push(triangle[6], triangle[7], triangle[8]);
          normals.push(pendingNormal[0], pendingNormal[1], pendingNormal[2]);
          count++;
        }
        inFacet = false;
        break;
      }
      default:
        break;
    }
  }

  if (count === 0) {
    throw new Error(
      'STLLoader: the ASCII source contains no complete "facet ... endfacet" block, ' +
        'so no triangle could be read.',
    );
  }

  return {
    format: 'ascii',
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    triangleCount: count,
  };
}

/* -------------------------------------------------------------------------- */
/* Binary                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parses a binary STL file.
 *
 * @param bytes Raw bytes.
 * @returns The parsed triangles.
 * @throws Error When the buffer is too small or the triangle count is implausible.
 */
export function parseSTLBinary(bytes: Uint8Array): STLParseResult {
  if (bytes.byteLength < STL_HEADER_BYTES) {
    throw new Error(
      `STLLoader: a binary STL needs at least ${STL_HEADER_BYTES} header bytes, ` +
        `received ${bytes.byteLength}.`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(80, true);
  const available = Math.floor((bytes.byteLength - STL_HEADER_BYTES) / STL_TRIANGLE_BYTES);

  if (triangleCount > available) {
    throw new Error(
      `STLLoader: the binary header declares ${triangleCount} triangles but the file ` +
        `only holds ${available}. The file is truncated or not a binary STL.`,
    );
  }

  const positions = new Float32Array(triangleCount * 9);
  const normals = new Float32Array(triangleCount * 3);

  const decoder = new TextDecoder('ascii', { fatal: false });
  const header = decoder.decode(bytes.subarray(0, 80)).replace(/\0+$/, '').trim();

  for (let t = 0; t < triangleCount; t++) {
    const offset = STL_HEADER_BYTES + t * STL_TRIANGLE_BYTES;

    normals[t * 3] = view.getFloat32(offset, true);
    normals[t * 3 + 1] = view.getFloat32(offset + 4, true);
    normals[t * 3 + 2] = view.getFloat32(offset + 8, true);

    for (let corner = 0; corner < 3; corner++) {
      const base = offset + 12 + corner * 12;
      positions[t * 9 + corner * 3] = view.getFloat32(base, true);
      positions[t * 9 + corner * 3 + 1] = view.getFloat32(base + 4, true);
      positions[t * 9 + corner * 3 + 2] = view.getFloat32(base + 8, true);
    }

    // Skip the 2-byte attribute record at `offset + 48`.
  }

  return {
    format: 'binary',
    positions,
    normals,
    triangleCount,
    header,
  };
}

/* -------------------------------------------------------------------------- */
/* Unified entry point                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Parses an STL file, detecting the encoding.
 *
 * @param source ASCII text or raw bytes.
 * @param format Force a format, or `'auto'` to detect it.
 * @returns The parsed triangles.
 * @throws Error When the input cannot be read as either form.
 */
export function parseSTL(
  source: string | ArrayBuffer | Uint8Array,
  format: 'ascii' | 'binary' | 'auto' = 'auto',
): STLParseResult {
  if (typeof source === 'string') return parseSTLAscii(source);

  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (format === 'binary') return parseSTLBinary(bytes);
  if (format === 'ascii') {
    return parseSTLAscii(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
  }

  if (isBinarySTL(bytes)) return parseSTLBinary(bytes);

  // Not decisively binary: is it text?
  const preview = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 1024));
  if (/^\s*solid/.test(preview) || preview.includes('facet normal')) {
    return parseSTLAscii(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
  }

  throw new Error(
    'STLLoader: the payload is neither a binary STL (the declared triangle count does ' +
      'not match the byte length) nor an ASCII STL (no "solid"/"facet normal" was found ' +
      'in the first kilobyte).',
  );
}

/**
 * Converts a parsed STL into a triangle-soup mesh.
 *
 * STL has no index buffer, so the mesh is non-indexed by construction: three vertices
 * per triangle, with a duplicated position at every shared edge. That is the format
 * STL actually describes, and welding it is the caller's decision (a smooth-shaded
 * surface wants welding, a faceted one does not).
 *
 * @param result Parsed STL data.
 * @param options Post-processing flags.
 * @returns A mesh-shaped result.
 */
export function stlToMesh(result: STLParseResult, options: STLLoadOptions = {}): MeshLike {
  const positions = Float32Array.from(result.positions);

  const postOptions: PostProcessOptions = {};
  if (options.scale !== undefined) postOptions.scale = options.scale;
  if (options.center !== undefined) postOptions.center = options.center;
  postProcessPositions(positions, postOptions);

  // A zero normal is a common exporter bug; fall back to the geometric normal.
  const normals = Float32Array.from(result.normals);
  for (let t = 0; t < result.triangleCount; t++) {
    const nx = normals[t * 3];
    const ny = normals[t * 3 + 1];
    const nz = normals[t * 3 + 2];
    if (Math.hypot(nx, ny, nz) > 1e-9) continue;

    const base = t * 9;
    const ax = positions[base];
    const ay = positions[base + 1];
    const az = positions[base + 2];
    const bx = positions[base + 3];
    const by = positions[base + 4];
    const bz = positions[base + 5];
    const cx = positions[base + 6];
    const cy = positions[base + 7];
    const cz = positions[base + 8];

    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;

    let fx = e1y * e2z - e1z * e2y;
    let fy = e1z * e2x - e1x * e2z;
    let fz = e1x * e2y - e1y * e2x;
    const length = Math.hypot(fx, fy, fz);
    if (length > 1e-12) {
      fx /= length;
      fy /= length;
      fz /= length;
    }

    for (let corner = 0; corner < 3; corner++) {
      normals[t * 3 + corner * 3] = fx;
      normals[t * 3 + corner * 3 + 1] = fy;
      normals[t * 3 + corner * 3 + 2] = fz;
    }
  }

  const indices = new Uint32Array(result.triangleCount * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;

  return {
    name: result.header !== undefined && result.header.length > 0 ? result.header : 'STL',
    geometry: {
      attributes: {
        position: { array: positions, itemSize: 3, count: positions.length / 3 },
        normal: { array: normals, itemSize: 3, count: normals.length / 3 },
      },
      index: { array: indices, itemSize: 1, count: indices.length },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Loads STL meshes.
 */
export class STLLoader extends Loader<STLParseResult, ArrayBuffer | string> {
  /** `fetch` implementation in use. */
  public fetcher: FetchLike | null = null;

  /** Detection override applied to every parse. */
  public format: 'ascii' | 'binary' | 'auto' = 'auto';

  /** Post-processing options. */
  public readonly meshOptions: STLLoadOptions;

  /**
   * Creates an STL loader.
   *
   * @param options Detection and post-processing overrides.
   */
  constructor(options: STLLoadOptions = {}) {
    super();
    this.fetcher = options.fetcher ?? null;
    this.format = options.format ?? 'auto';
    this.meshOptions = options;
  }

  /**
   * Sets the detection override.
   *
   * @param format Format, or `'auto'`.
   * @returns This loader, for chaining.
   */
  public setFormat(format: 'ascii' | 'binary' | 'auto'): this {
    this.format = format;
    return this;
  }

  /**
   * Installs a `fetch` implementation.
   *
   * @param fetcher Fetcher, or `null` for the global one.
   * @returns This loader, for chaining.
   */
  public setFetcher(fetcher: FetchLike | null): this {
    this.fetcher = fetcher;
    return this;
  }

  /**
   * @inheritdoc
   *
   * STL is fetched as bytes, because that is the only representation that survives
   * both encodings.
   */
  protected override async loadData(
    url: string,
    options: LoadOptions,
  ): Promise<LoadedSource<ArrayBuffer>> {
    const stlOptions = options as STLLoadOptions;
    const fetcher = this.resolveFetcher(stlOptions);
    if (fetcher === null) {
      throw new Error(
        `STLLoader("${url}"): no \`fetch\` implementation is available. Use \`parse()\` on ` +
          'inline data when running on a host without fetch.',
      );
    }

    const response = await fetcher(url, {
      method: 'GET',
      headers: { ...this.requestHeaders },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (response.ok === false) {
      throw new Error(`STLLoader("${url}"): HTTP ${response.status ?? '?'} ${response.statusText ?? ''}`.trim());
    }

    const bytes = await response.arrayBuffer();
    this.reportProgress(url, bytes.byteLength, bytes.byteLength, options);
    return { data: bytes, fromCache: false, byteLength: bytes.byteLength };
  }

  /**
   * @inheritdoc
   *
   * @throws Error When the payload is not a readable STL.
   */
  public override parse(
    source: ArrayBuffer | string | Uint8Array,
    url = '<inline>',
    options?: LoadOptions,
  ): STLParseResult {
    const stlOptions = (options ?? {}) as STLLoadOptions;
    const format = stlOptions.format ?? this.format;
    try {
      return parseSTL(source, format);
    } catch (error) {
      throw new Error(
        `STLLoader("${url}"): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Parses and converts to a mesh in one step.
   *
   * @param source ASCII text or raw bytes.
   * @param options Detection and post-processing overrides.
   * @returns A mesh-shaped result.
   */
  public parseMesh(
    source: ArrayBuffer | string | Uint8Array,
    options: STLLoadOptions = {},
  ): MeshLike {
    const result = this.parse(source, '<inline>', options);
    return stlToMesh(result, { ...this.meshOptions, ...options });
  }

  /** Resolves the `fetch` implementation to use. */
  private resolveFetcher(options: STLLoadOptions): FetchLike | null {
    if (options.fetcher !== undefined) return options.fetcher;
    if (this.fetcher !== null) return this.fetcher;
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    return typeof globalFetch === 'function' ? (globalFetch as FetchLike) : null;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    super.onDispose();
    this.fetcher = null;
  }
}

/**
 * Convenience factory mirroring `new STLLoader(options)`.
 *
 * @param options Detection and post-processing overrides.
 * @returns A new STL loader.
 */
export function stlLoader(options: STLLoadOptions = {}): STLLoader {
  return new STLLoader(options);
}
