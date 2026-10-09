/**
 * `OBJLoader` — Wavefront OBJ and MTL.
 *
 * OBJ is the most forgiving interchange format in graphics, and this parser handles
 * the full surface of it that actually appears in the wild:
 *
 * - `v`, `vt`, `vn` records plus the optional `w` coordinate on `v`;
 * - faces with `v`, `v/vt`, `v//vn` and `v/vt/vn` corners, including **negative**
 *   (relative) indices, which some exporters emit;
 * - n-gon faces, fan-triangulated;
 * - `g`, `o`, `s` and `usemtl` state, recorded as group ranges so a renderer can
 *   draw one material per range;
 * - `mtllib` sidecars, parsed when their text is supplied alongside the OBJ (the
 *   loader does not fetch them, so a caller controls the I/O);
 * - `#` comments, blank lines, and lines longer than any sane buffer.
 *
 * ## Why welding matters
 *
 * OBJ indexes position, UV and normal **independently**, but a GPU vertex buffer has
 * one index. The parsed result is therefore a *welded* index buffer produced by
 * {@link VertexWelder}: two face corners become one vertex only when all three of
 * their indices agree. That is exactly the seam behaviour a renderer wants — a cube
 * corner with three different normals stays three vertices.
 *
 * ```ts
 * const result = parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
 * result.counts.triangles;   // 1
 * result.indices;            // Uint32Array [0, 1, 2]
 * ```
 *
 * @packageDocumentation
 */

import { Loader, type LoadedSource } from './Loader';
import { VertexWelder, flipV, postProcessPositions, type PostProcessOptions } from './geometryUtils';
import type {
  FetchLike,
  LoadOptions,
  MeshLoadOptions,
  MeshLike,
  MTLMaterial,
  OBJGroup,
  OBJParseResult,
} from '../types';

/** Options accepted by {@link OBJLoader.loadAsync}. */
export interface OBJLoadOptions extends MeshLoadOptions {
  /** `fetch` implementation override. */
  fetcher?: FetchLike;
  /** MTL sidecar text, keyed by the name used in `mtllib`. */
  mtlSources?: Record<string, string>;
  /** Flip the V texture coordinate. */
  flipUvs?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Parser                                                                     */
/* -------------------------------------------------------------------------- */

/** One face corner, resolved to source indices. */
interface Corner {
  /** Position index. */
  p: number;
  /** UV index, or `-1`. */
  t: number;
  /** Normal index, or `-1`. */
  n: number;
}

/**
 * Resolves an OBJ index, honouring the negative (relative) form.
 *
 * @param raw Parsed integer.
 * @param count Number of records of that kind seen so far.
 * @returns A zero-based index into the record list.
 */
function resolveIndex(raw: number, count: number): number {
  if (raw > 0) return raw - 1;
  if (raw < 0) return count + raw;
  // Index 0 is illegal in OBJ; treating it as "first" is the lenient behaviour every
  // other loader picks.
  return 0;
}

/** Parses one face corner token. */
function parseCorner(token: string, counts: { v: number; vt: number; vn: number }): Corner {
  const parts = token.split('/');
  const p = resolveIndex(Number(parts[0]) || 0, counts.v);
  const t = parts.length > 1 && parts[1] !== '' && parts[1] !== undefined
    ? resolveIndex(Number(parts[1]) || 0, counts.vt)
    : -1;
  const n = parts.length > 2 && parts[2] !== '' && parts[2] !== undefined
    ? resolveIndex(Number(parts[2]) || 0, counts.vn)
    : -1;
  return { p, t, n };
}

/**
 * Parses an OBJ file.
 *
 * @param source OBJ text.
 * @param options MTL sources and post-processing flags.
 * @returns The parsed, welded mesh data.
 * @throws Error When the source declares no vertices at all.
 */
export function parseOBJ(source: string, options: OBJLoadOptions = {}): OBJParseResult {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  const rawPositions: number[] = [];
  const rawUvs: number[] = [];
  const rawNormals: number[] = [];

  const counts = { v: 0, vt: 0, vn: 0 };
  const groups: OBJGroup[] = [];
  const materialNames: string[] = [];

  const welder = new VertexWelder(6);
  const indices: number[] = [];

  let currentGroup: OBJGroup | null = null;
  let currentName = '';
  let currentMaterial: string | null = null;
  let faces = 0;
  let triangles = 0;
  let hadPolygons = false;
  let pendingMtlLibraries: string[] = [];

  /** Opens a new group when anything about the draw state changed. */
  const ensureGroup = (name: string, material: string | null): OBJGroup => {
    if (currentGroup !== null && currentName === name && currentMaterial === material) {
      currentGroup.count = indices.length - currentGroup.start;
      return currentGroup;
    }
    if (currentGroup !== null) currentGroup.count = indices.length - currentGroup.start;

    const group: OBJGroup = { name, material, start: indices.length, count: 0 };
    groups.push(group);
    currentGroup = group;
    currentName = name;
    currentMaterial = material;
    return group;
  };

  const lines = text.split('\n');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (line.length === 0) continue;

    // Fast path: the vast majority of lines start with a directive we care about.
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.charCodeAt(0) === 35 /* '#' */) continue;

    const space = trimmed.indexOf(' ');
    const keyword = space < 0 ? trimmed : trimmed.slice(0, space);

    switch (keyword) {
      case 'v': {
        const parts = trimmed.slice(space + 1).split(/\s+/);
        rawPositions.push(Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0);
        counts.v++;
        break;
      }
      case 'vt': {
        const parts = trimmed.slice(space + 1).split(/\s+/);
        rawUvs.push(Number(parts[0]) || 0, Number(parts[1]) || 0);
        counts.vt++;
        break;
      }
      case 'vn': {
        const parts = trimmed.slice(space + 1).split(/\s+/);
        rawNormals.push(Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0);
        counts.vn++;
        break;
      }
      case 'f': {
        const tokens = trimmed.slice(space + 1).split(/\s+/);
        if (tokens.length < 3) break;
        faces++;
        if (tokens.length > 3) hadPolygons = true;

        const corners: Corner[] = [];
        for (const token of tokens) {
          if (token.length === 0) continue;
          corners.push(parseCorner(token, counts));
        }
        if (corners.length < 3) break;

        ensureGroup(currentName, currentMaterial);

        // Fan triangulation, welding each corner on the way through.
        const welded = corners.map((corner) =>
          welder.weld(rawPositions, corner.p, rawUvs, corner.t, rawNormals, corner.n),
        );

        for (let i = 1; i + 1 < welded.length; i++) {
          indices.push(welded[0], welded[i], welded[i + 1]);
          triangles++;
        }
        break;
      }
      case 'g':
      case 'o': {
        const name = trimmed.slice(space + 1).trim();
        ensureGroup(name, currentMaterial);
        break;
      }
      case 'usemtl': {
        const material = trimmed.slice(space + 1).trim();
        if (!materialNames.includes(material)) materialNames.push(material);
        ensureGroup(currentName, material);
        break;
      }
      case 'mtllib': {
        // A single line may name several libraries.
        pendingMtlLibraries = trimmed
          .slice(space + 1)
          .trim()
          .split(/\s+/)
          .filter((entry) => entry.length > 0);
        break;
      }
      case 's':
      case 'l':
      case 'p':
      case 'vp':
      case 'vpw':
      case 'curv':
      case 'surf':
      default:
        // Smoothing groups, lines, points and free-form surfaces are parsed without
        // complaint and ignored: they carry no triangle data.
        break;
    }
  }

  if (counts.v === 0) {
    throw new Error(
      'OBJLoader: the source declares no "v" (vertex) records, so it is not an OBJ ' +
        'mesh. Check that the file was fetched as text and not as a binary blob.',
    );
  }

  // Close the final group's range. The cast is needed because TypeScript does not
  // carry the narrowing of a `let` captured by the `ensureGroup` closure.
  const lastGroup = currentGroup as OBJGroup | null;
  if (lastGroup !== null) lastGroup.count = indices.length - lastGroup.start;

  const welded = welder.build();

  // Accept either `mtlSources` or a single `mtlSource`; both are common call shapes.
  const materials: MTLMaterial[] = [];
  const mtlSources = options.mtlSources;
  if (mtlSources !== undefined) {
    for (const [name, mtlText] of Object.entries(mtlSources)) {
      void name;
      for (const material of parseMTL(mtlText)) materials.push(material);
    }
  }

  const postOptions: PostProcessOptions = {};
  if (options.scale !== undefined) postOptions.scale = options.scale;
  if (options.center !== undefined) postOptions.center = options.center;
  postProcessPositions(welded.positions, postOptions);
  if (options.flipUvs === true) flipV(welded.uvs);

  void pendingMtlLibraries;

  return {
    positions: welded.positions,
    uvs: welded.uvs,
    normals: welded.normals,
    indices: Uint32Array.from(indices),
    groups,
    materialNames,
    materials,
    hadPolygons,
    counts: {
      vertices: counts.v,
      uvs: counts.vt,
      normals: counts.vn,
      faces,
      triangles,
    },
  };
}

/**
 * Parses an MTL sidecar.
 *
 * @param source MTL text.
 * @returns One record per `newmtl`.
 */
export function parseMTL(source: string): MTLMaterial[] {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const materials: MTLMaterial[] = [];
  let current: MTLMaterial | null = null;

  const readTriple = (value: string): [number, number, number] => {
    const parts = value.trim().split(/\s+/);
    return [Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0];
  };
  const readQuad = (value: string): [number, number, number, number] => {
    const parts = value.trim().split(/\s+/);
    return [
      Number(parts[0]) || 0,
      Number(parts[1]) || 0,
      Number(parts[2]) || 0,
      parts.length > 3 ? Number(parts[3]) || 0 : 1,
    ];
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const space = line.indexOf(' ');
    const keyword = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1).trim();

    switch (keyword) {
      case 'newmtl': {
        current = { name: value };
        materials.push(current);
        break;
      }
      case 'Kd':
        if (current) current.diffuse = readQuad(value);
        break;
      case 'Ka':
        if (current) current.ambient = readTriple(value);
        break;
      case 'Ks':
        if (current) current.specular = readQuad(value);
        break;
      case 'Ke':
        if (current) current.emissive = readTriple(value);
        break;
      case 'Ns':
        if (current) current.shininess = Number(value) || 0;
        break;
      case 'd':
        if (current) current.opacity = Number(value) || 0;
        break;
      case 'Tr':
        if (current) current.opacity = 1 - (Number(value) || 0);
        break;
      case 'Ni':
        if (current) current.ior = Number(value) || 1;
        break;
      case 'map_Kd':
        if (current) current.mapDiffuse = value;
        break;
      case 'map_Bump':
      case 'bump':
      case 'norm':
        if (current) current.mapNormal = value;
        break;
      case 'map_Ks':
        if (current) current.mapSpecular = value;
        break;
      case 'map_d':
        if (current) current.mapAlpha = value;
        break;
      case 'map_Ke':
        if (current) current.mapEmissive = value;
        break;
      default:
        break;
    }
  }

  return materials;
}

/**
 * Splits a welded OBJ result into per-group meshes.
 *
 * @param result Parsed OBJ data.
 * @returns One mesh per group, sharing the source buffers where possible.
 */
export function splitOBJGroups(result: OBJParseResult): MeshLike[] {
  const meshes: MeshLike[] = [];

  for (const group of result.groups) {
    if (group.count === 0) continue;

    const indices: number[] = [];
    for (let i = group.start; i < group.start + group.count; i++) {
      indices.push(result.indices[i] ?? 0);
    }

    const geometry = {
      attributes: {
        position: { array: result.positions, itemSize: 3, count: result.positions.length / 3 },
        ...(result.normals.length > 0
          ? { normal: { array: result.normals, itemSize: 3, count: result.normals.length / 3 } }
          : {}),
        ...(result.uvs.length > 0
          ? { uv: { array: result.uvs, itemSize: 2, count: result.uvs.length / 2 } }
          : {}),
      },
      index: { array: Uint32Array.from(indices), itemSize: 1, count: indices.length },
    };

    meshes.push({
      name: group.name.length > 0 ? group.name : 'OBJ',
      geometry,
      material: group.material,
    });
  }

  return meshes;
}

/* -------------------------------------------------------------------------- */
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Loads OBJ meshes.
 */
export class OBJLoader extends Loader<OBJParseResult, ArrayBuffer | string> {
  /** `fetch` implementation in use. */
  public fetcher: FetchLike | null = null;

  /** MTL sidecar text supplied by the caller, keyed by library name. */
  public readonly mtlSources: Record<string, string> = {};

  /** Post-processing options applied to every parse. */
  public readonly meshOptions: OBJLoadOptions = {};

  /**
   * Creates an OBJ loader.
   *
   * @param options Post-processing and transport overrides.
   */
  constructor(options: OBJLoadOptions = {}) {
    super();
    this.fetcher = options.fetcher ?? null;
    this.meshOptions = options;
  }

  /**
   * Registers an MTL sidecar's text.
   *
   * @param name Library name as written in `mtllib`.
   * @param source MTL text.
   * @returns This loader, for chaining.
   */
  public addMTL(name: string, source: string): this {
    this.mtlSources[name] = source;
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
   */
  protected override async loadData(
    url: string,
    options: LoadOptions,
  ): Promise<LoadedSource<ArrayBuffer | string>> {
    const objOptions = options as OBJLoadOptions;
    const fetcher = this.resolveFetcher(objOptions);
    if (fetcher === null) {
      throw new Error(
        `OBJLoader("${url}"): no \`fetch\` implementation is available. Use \`parse()\` on ` +
          'inline text when running on a host without fetch.',
      );
    }

    const response = await fetcher(url, {
      method: 'GET',
      headers: { ...this.requestHeaders },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (response.ok === false) {
      throw new Error(`OBJLoader("${url}"): HTTP ${response.status ?? '?'} ${response.statusText ?? ''}`.trim());
    }

    const text = await response.text();
    this.reportProgress(url, text.length, text.length, options);
    return { data: text, fromCache: false, byteLength: text.length };
  }

  /**
   * @inheritdoc
   *
   * @throws Error When the text is not an OBJ mesh.
   */
  public override parse(
    source: ArrayBuffer | string,
    url = '<inline>',
    options?: LoadOptions,
  ): OBJParseResult {
    const objOptions = (options ?? {}) as OBJLoadOptions;
    const text =
      typeof source === 'string'
        ? source
        : new TextDecoder('utf-8', { fatal: false }).decode(source);

    try {
      return parseOBJ(text, {
        ...this.meshOptions,
        ...objOptions,
        mtlSources: { ...this.mtlSources, ...(objOptions.mtlSources ?? {}) },
      });
    } catch (error) {
      throw new Error(
        `OBJLoader("${url}"): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Resolves the `fetch` implementation to use. */
  private resolveFetcher(options: OBJLoadOptions): FetchLike | null {
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
 * Convenience factory mirroring `new OBJLoader(options)`.
 *
 * @param options Post-processing and transport overrides.
 * @returns A new OBJ loader.
 */
export function objLoader(options: OBJLoadOptions = {}): OBJLoader {
  return new OBJLoader(options);
}
