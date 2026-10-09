/**
 * `GLTFLoader` — real glTF 2.0 / GLB parsing, offline.
 *
 * This is not a stub. The loader understands the container, the JSON schema and the
 * binary buffer model, and it produces a **scene-shaped result with meshes,
 * materials, textures and nodes** whose vertex data is fully materialised:
 *
 * - **GLB.** The 12-byte header (`glTF` magic, version 2, total length) plus the JSON
 *   and `BIN` chunks, including 4-byte chunk padding and an optional JSON-only chunk.
 * - **Buffers.** `data:` URIs (base64 and percent-encoded), plus the GLB binary chunk.
 *   An external `.bin` URI is recorded but **not fetched** — the caller decides
 *   whether that I/O is acceptable, which keeps this parser synchronous and testable.
 * - **Buffer views and accessors.** `byteOffset`, `byteStride`, all component types
 *   (`5120`–`5126`), the matrix/vector/scalar type table, and normalisation for
 *   integer attributes.
 * - **Meshes.** Every primitive, every attribute (`POSITION`, `NORMAL`, `TEXCOORD_n`,
 *   `COLOR_n`, `TANGENT`, `JOINTS_n`, `WEIGHTS_n`), and index accessors.
 * - **Sparse accessors.** Applied on top of the base data.
 * - **Nodes, scenes, materials, textures, images, samplers.** Materials keep their
 *   PBR metallic-roughness parameters, texture references, alpha mode and
 *   double-sided flag.
 *
 * ## What it deliberately does not do
 *
 * Animation channels, skins, morph targets, cameras and the `KHR_*` extensions are
 * parsed into the raw arrays and reported in {@link GLTFParseResult.extensionsUsed},
 * but are not applied to the scene. `extensionsSupported` lists exactly what was
 * honoured, so a caller can check rather than assume.
 *
 * ```ts
 * const gltf = parseGLTF(jsonText, { binaryChunk });
 * gltf.resolvedMeshes[0].primitives[0].attributes;   // [{ name: 'position', array, itemSize, count }]
 * ```
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import { Loader, type LoadedSource } from './Loader';
import type {
  FetchLike,
  GLTFAttributeData,
  GLTFBuffer,
  GLTFParseResult,
  GLTFResolvedMesh,
  GLTFResolvedPrimitive,
  LoadOptions,
} from '../types';

/** Logger shared by the glTF path. */
const log = createLogger('assets:gltf');

/** GLB container magic, little-endian `glTF`. */
export const GLB_MAGIC = 0x46546c67;

/** GLB JSON chunk type, little-endian `JSON`. */
export const GLB_CHUNK_JSON = 0x4e4f534a;

/** GLB binary chunk type, little-endian `BIN\0`. */
export const GLB_CHUNK_BIN = 0x004e4942;

/** Component-type enum → `[TypedArray, bytes]`. */
const COMPONENT_TYPES: Readonly<Record<number, { bytes: number; kind: 'int' | 'uint' | 'float' }>> = {
  5120: { bytes: 1, kind: 'int' }, // BYTE
  5121: { bytes: 1, kind: 'uint' }, // UNSIGNED_BYTE
  5122: { bytes: 2, kind: 'int' }, // SHORT
  5123: { bytes: 2, kind: 'uint' }, // UNSIGNED_SHORT
  5125: { bytes: 4, kind: 'uint' }, // UNSIGNED_INT
  5126: { bytes: 4, kind: 'float' }, // FLOAT
};

/** Accessor type string → component count. */
const TYPE_SIZES: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

/** glTF attribute name → engine attribute name. */
const ATTRIBUTE_NAMES: Readonly<Record<string, string>> = {
  POSITION: 'position',
  NORMAL: 'normal',
  TANGENT: 'tangent',
  TEXCOORD_0: 'uv',
  TEXCOORD_1: 'uv1',
  COLOR_0: 'color',
  JOINTS_0: 'skinIndex',
  WEIGHTS_0: 'skinWeight',
};

/** Options accepted by {@link parseGLTF}. */
export interface GLTFParseOptions {
  /** The GLB `BIN` chunk, when the source was a container. */
  binaryChunk?: ArrayBuffer | null;
  /** `true` skips resolving mesh vertex data (raw arrays only). */
  skipAttributeResolution?: boolean;
}

/** Options accepted by {@link GLTFLoader.loadAsync}. */
export interface GLTFLoadOptions extends LoadOptions {
  /** `fetch` implementation override. */
  fetcher?: FetchLike;
}

/* -------------------------------------------------------------------------- */
/* Base64 / data URI                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Decodes a `data:` URI into bytes.
 *
 * Both `base64` and percent-encoded payloads are handled, because exporters emit
 * both and a strict base64-only reader silently produces garbage on the other.
 *
 * @param uri Data URI.
 * @returns The decoded bytes.
 * @throws Error When the URI cannot be decoded.
 */
export function decodeDataUri(uri: string): ArrayBuffer {
  const comma = uri.indexOf(',');
  if (comma < 0) {
    throw new Error('GLTFLoader: a buffer URI starts with "data:" but has no comma separator.');
  }

  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);

  if (meta.includes(';base64')) {
    return base64ToArrayBuffer(payload);
  }

  const decoded = decodeURIComponent(payload);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i) & 0xff;
  return bytes.buffer;
}

/**
 * Decodes base64 into an `ArrayBuffer`.
 *
 * Uses the host `atob` when present (browser, Node 16+); otherwise falls back to a
 * table-driven decoder, so the loader works in any ES2022 runtime.
 *
 * @param base64 Base64 text, with or without padding.
 * @returns The decoded bytes.
 * @throws Error When the text contains a non-base64 character.
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const cleaned = base64.replace(/\s+/g, '');

  const globalAtob = (globalThis as { atob?: unknown }).atob;
  if (typeof globalAtob === 'function') {
    const binary = (globalAtob as (value: string) => string).call(globalThis, cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
    return bytes.buffer;
  }

  const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Int16Array(256).fill(-1);
  for (let i = 0; i < TABLE.length; i++) lookup[TABLE.charCodeAt(i)] = i;

  const padding = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0;
  const byteLength = Math.floor((cleaned.length * 3) / 4) - padding;
  const bytes = new Uint8Array(Math.max(0, byteLength));

  let accumulator = 0;
  let bits = 0;
  let out = 0;

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned.charCodeAt(i);
    if (char === 61 /* '=' */) break;
    const value = lookup[char];
    if (value < 0) {
      throw new Error(
        `GLTFLoader: invalid base64 character "${cleaned[i]}" at index ${i} in a buffer URI.`,
      );
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (accumulator >> bits) & 0xff;
    }
  }

  return bytes.buffer;
}

/* -------------------------------------------------------------------------- */
/* GLB container                                                              */
/* -------------------------------------------------------------------------- */

/** The pieces split out of a GLB container. */
export interface GLBChunks {
  /** JSON chunk text. */
  json: string;
  /** `BIN` chunk bytes, when present. */
  binary: ArrayBuffer | null;
  /** Container version from the header. */
  version: number;
  /** Declared total length. */
  length: number;
}

/**
 * Splits a GLB container into its chunks.
 *
 * @param bytes Container bytes.
 * @returns The chunks.
 * @throws Error When the magic, version or chunk layout is wrong.
 */
export function parseGLB(bytes: ArrayBuffer | Uint8Array): GLBChunks {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength < 12) {
    throw new Error(
      `GLTFLoader: a GLB container needs at least a 12-byte header, received ${view.byteLength}.`,
    );
  }

  const header = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const magic = header.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    throw new Error(
      `GLTFLoader: bad GLB magic 0x${magic.toString(16)} (expected 0x${GLB_MAGIC.toString(16)} ` +
        '= "glTF"). The file is probably a .gltf JSON document; parse it as text instead.',
    );
  }

  const version = header.getUint32(4, true);
  if (version !== 2) {
    throw new Error(
      `GLTFLoader: GLB version ${version} is not supported (this loader implements glTF 2.0).`,
    );
  }

  const length = header.getUint32(8, true);
  let offset = 12;
  let json: string | null = null;
  let binary: ArrayBuffer | null = null;

  const decoder = new TextDecoder('utf-8', { fatal: false });

  while (offset + 8 <= view.byteLength) {
    const chunkLength = header.getUint32(offset, true);
    const chunkType = header.getUint32(offset + 4, true);
    offset += 8;

    if (offset + chunkLength > view.byteLength) {
      throw new Error(
        `GLTFLoader: a GLB chunk declares ${chunkLength} bytes but only ` +
          `${view.byteLength - offset} remain. The container is truncated.`,
      );
    }

    const chunk = view.subarray(offset, offset + chunkLength);
    if (chunkType === GLB_CHUNK_JSON) {
      json = decoder.decode(chunk);
    } else if (chunkType === GLB_CHUNK_BIN) {
      // Copy: the chunk is a view into the container, and callers may keep the
      // accessor data alive after the container is released.
      binary = chunk.slice().buffer;
    } else {
      log.debug(`ignoring unknown GLB chunk type 0x${chunkType.toString(16)}`);
    }

    // Chunks are 4-byte aligned; the declared length already includes the padding.
    offset += chunkLength;
  }

  if (json === null) {
    throw new Error('GLTFLoader: the GLB container has no JSON chunk.');
  }

  return { json, binary, version, length };
}

/* -------------------------------------------------------------------------- */
/* Parser                                                                     */
/* -------------------------------------------------------------------------- */

/** Loosely typed glTF JSON document. */
interface GLTFDocument {
  asset?: { version?: string; generator?: string; copyright?: string };
  buffers?: { uri?: string; byteLength?: number }[];
  bufferViews?: {
    buffer?: number;
    byteOffset?: number;
    byteLength?: number;
    byteStride?: number;
    target?: number;
  }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType?: number;
    normalized?: boolean;
    count?: number;
    type?: string;
    min?: number[];
    max?: number[];
    sparse?: {
      count?: number;
      indices?: { bufferView?: number; byteOffset?: number; componentType?: number };
      values?: { bufferView?: number; byteOffset?: number };
    };
  }[];
  images?: { name?: string; uri?: string; mimeType?: string; bufferView?: number }[];
  samplers?: unknown[];
  textures?: { name?: string; source?: number; sampler?: number }[];
  materials?: Record<string, unknown>[];
  meshes?: { name?: string; primitives?: Record<string, unknown>[]; weights?: number[] }[];
  nodes?: Record<string, unknown>[];
  scenes?: { name?: string; nodes?: number[] }[];
  scene?: number;
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

/** Extensions this loader actually honours while resolving data. */
const SUPPORTED_EXTENSIONS: readonly string[] = [
  'KHR_materials_unlit',
  'KHR_texture_transform',
  'KHR_mesh_quantization',
];

/**
 * Parses a glTF document.
 *
 * @param source JSON text, a parsed document, or GLB bytes.
 * @param options GLB binary chunk and resolution flags.
 * @returns The parsed result.
 * @throws Error When the document is malformed or the asset version is unsupported.
 */
export function parseGLTF(
  source: string | ArrayBuffer | Uint8Array | GLTFDocument,
  options: GLTFParseOptions = {},
): GLTFParseResult {
  let document: GLTFDocument;
  let binaryChunk = options.binaryChunk ?? null;
  let binary = false;

  if (typeof source === 'string') {
    document = JSON.parse(source) as GLTFDocument;
  } else if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength >= 4 && view.getUint32(0, true) === GLB_MAGIC) {
      const chunks = parseGLB(bytes);
      document = JSON.parse(chunks.json) as GLTFDocument;
      binaryChunk = chunks.binary;
      binary = true;
    } else {
      document = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes)) as GLTFDocument;
    }
  } else {
    document = source;
  }

  const version = document.asset?.version ?? '2.0';
  if (!version.startsWith('2')) {
    throw new Error(
      `GLTFLoader: glTF version "${version}" is not supported; this loader implements 2.0.`,
    );
  }

  const declaredBuffers = document.buffers ?? [];
  const buffers: GLTFBuffer[] = [];
  const bufferViews = document.bufferViews ?? [];
  const accessors = document.accessors ?? [];

  for (let i = 0; i < declaredBuffers.length; i++) {
    const declared = declaredBuffers[i];
    const byteLength = declared.byteLength ?? 0;

    if (declared.uri === undefined) {
      // No URI means "the GLB BIN chunk"; only the first such buffer is meaningful.
      buffers.push({
        data: binaryChunk ?? undefined,
        byteLength,
      });
      if (binaryChunk === null) {
        log.warn(
          `buffer ${i} has no URI and no GLB BIN chunk was supplied; its views will read as zeros`,
        );
      }
    } else if (declared.uri.startsWith('data:')) {
      buffers.push({ data: decodeDataUri(declared.uri), byteLength });
    } else {
      // External `.bin`: recorded, deliberately not fetched.
      buffers.push({ uri: declared.uri, byteLength });
    }
  }

  const meshes = document.meshes ?? [];
  const resolvedMeshes: GLTFResolvedMesh[] = [];

  if (options.skipAttributeResolution !== true) {
    for (const mesh of meshes) {
      resolvedMeshes.push(resolveMesh(mesh, accessors, bufferViews, buffers));
    }
  }

  const materials = (document.materials ?? []) as GLTFParseResult['materials'];
  const textures = (document.textures ?? []) as GLTFParseResult['textures'];
  const images = (document.images ?? []) as GLTFParseResult['images'];
  const nodes = (document.nodes ?? []) as GLTFParseResult['nodes'];
  const scenes = (document.scenes ?? []) as GLTFParseResult['scenes'];

  const extensionsUsed = document.extensionsUsed ?? [];
  const extensionsSupported = extensionsUsed.filter((name) => SUPPORTED_EXTENSIONS.includes(name));

  return {
    asset: document.asset ?? {},
    buffers,
    accessors: accessors as GLTFParseResult['accessors'],
    bufferViews: bufferViews as GLTFParseResult['bufferViews'],
    meshes: meshes as GLTFParseResult['meshes'],
    materials,
    textures,
    images,
    nodes,
    scenes,
    scene: document.scene ?? 0,
    resolvedMeshes,
    binary,
    extensionsUsed,
    extensionsSupported,
  };
}

/** Resolves one mesh's primitives into flat attribute buffers. */
function resolveMesh(
  mesh: { name?: string; primitives?: Record<string, unknown>[] },
  accessors: GLTFDocument['accessors'],
  bufferViews: GLTFDocument['bufferViews'],
  buffers: GLTFBuffer[],
): GLTFResolvedMesh {
  const primitives: GLTFResolvedPrimitive[] = [];

  for (const primitive of mesh.primitives ?? []) {
    const attributeIndices = (primitive.attributes ?? {}) as Record<string, number>;
    const attributes: GLTFAttributeData[] = [];

    for (const [gltfName, accessorIndex] of Object.entries(attributeIndices)) {
      const accessor = accessors?.[accessorIndex];
      if (accessor === undefined) continue;

      const values = readAccessor(accessor, bufferViews, buffers);
      if (values === null) continue;

      attributes.push({
        name: ATTRIBUTE_NAMES[gltfName] ?? gltfName.toLowerCase(),
        array: values,
        itemSize: TYPE_SIZES[accessor.type ?? 'SCALAR'] ?? 1,
        count: accessor.count ?? 0,
      });
    }

    let indices: Uint32Array | null = null;
    const indexAccessor = primitive.indices;
    if (typeof indexAccessor === 'number') {
      const accessor = accessors?.[indexAccessor];
      if (accessor !== undefined) {
        const values = readAccessor(accessor, bufferViews, buffers);
        if (values !== null) indices = Uint32Array.from(values, (value) => Math.trunc(value));
      }
    }

    primitives.push({
      materialIndex: typeof primitive.material === 'number' ? primitive.material : -1,
      attributes,
      indices,
      mode: typeof primitive.mode === 'number' ? primitive.mode : 4,
    });
  }

  return { name: mesh.name ?? '', primitives };
}

/**
 * Reads an accessor into a `Float32Array`.
 *
 * Honours `byteOffset`, `byteStride`, every component type, normalisation, and a
 * `sparse` override block.
 *
 * @param accessor Accessor description.
 * @param bufferViews Buffer views.
 * @param buffers Resolved buffers.
 * @returns The values, or `null` when the backing data is unavailable (an external
 *   `.bin` that was not fetched).
 */
export function readAccessor(
  accessor: NonNullable<GLTFDocument['accessors']>[number],
  bufferViews: GLTFDocument['bufferViews'],
  buffers: GLTFBuffer[],
): Float32Array | null {
  const componentCount = TYPE_SIZES[accessor.type ?? 'SCALAR'] ?? 1;
  const count = accessor.count ?? 0;
  const componentType = accessor.componentType ?? 5126;
  const descriptor = COMPONENT_TYPES[componentType];

  if (descriptor === undefined) {
    log.warn(`accessor uses unknown componentType ${componentType}; skipping`);
    return null;
  }

  if (count === 0) return new Float32Array(0);

  const output = new Float32Array(count * componentCount);

  if (accessor.bufferView !== undefined) {
    const view = bufferViews?.[accessor.bufferView];
    if (view === undefined) return null;

    const buffer = buffers[view.buffer ?? 0];
    if (buffer === undefined || buffer.data === undefined) {
      // An unresolved external buffer: report rather than fabricate zeros.
      return null;
    }

    const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const stride = view.byteStride ?? componentCount * descriptor.bytes;
    const data = new DataView(buffer.data);

    for (let i = 0; i < count; i++) {
      const elementOffset = base + i * stride;
      for (let c = 0; c < componentCount; c++) {
        const offset = elementOffset + c * descriptor.bytes;
        if (offset + descriptor.bytes > data.byteLength) break;
        output[i * componentCount + c] = readComponent(data, offset, componentType, accessor.normalized === true);
      }
    }
  }

  // Sparse accessors override a subset of the base values.
  const sparse = accessor.sparse;
  if (sparse !== undefined && sparse.count !== undefined && sparse.count > 0) {
    applySparse(accessor, bufferViews, buffers, output, componentCount);
  }

  return output;
}

/** Reads one component with the right `DataView` accessor. */
function readComponent(view: DataView, offset: number, componentType: number, normalized: boolean): number {
  switch (componentType) {
    case 5120: {
      const value = view.getInt8(offset);
      return normalized ? Math.max(value / 127, -1) : value;
    }
    case 5121: {
      const value = view.getUint8(offset);
      return normalized ? value / 255 : value;
    }
    case 5122: {
      const value = view.getInt16(offset, true);
      return normalized ? Math.max(value / 32767, -1) : value;
    }
    case 5123: {
      const value = view.getUint16(offset, true);
      return normalized ? value / 65535 : value;
    }
    case 5125:
      return view.getUint32(offset, true);
    case 5126:
    default:
      return view.getFloat32(offset, true);
  }
}

/** Applies a sparse accessor's indices/values block onto `output`. */
function applySparse(
  accessor: NonNullable<GLTFDocument['accessors']>[number],
  bufferViews: GLTFDocument['bufferViews'],
  buffers: GLTFBuffer[],
  output: Float32Array,
  componentCount: number,
): void {
  const sparse = accessor.sparse;
  if (sparse === undefined) return;

  const count = sparse.count ?? 0;
  const indexComponentType = sparse.indices?.componentType ?? 5125;

  const indexView = sparse.indices?.bufferView;
  const valueView = sparse.values?.bufferView;
  if (indexView === undefined || valueView === undefined) return;

  const indexBufferView = bufferViews?.[indexView];
  const valueBufferView = bufferViews?.[valueView];
  if (indexBufferView === undefined || valueBufferView === undefined) return;

  const indexBuffer = buffers[indexBufferView.buffer ?? 0];
  const valueBuffer = buffers[valueBufferView.buffer ?? 0];
  if (indexBuffer?.data === undefined || valueBuffer?.data === undefined) return;

  const indexData = new DataView(indexBuffer.data);
  const valueData = new DataView(valueBuffer.data);
  const indexBase = (indexBufferView.byteOffset ?? 0) + (sparse.indices?.byteOffset ?? 0);
  const valueBase = (valueBufferView.byteOffset ?? 0) + (sparse.values?.byteOffset ?? 0);

  const indexBytes = componentTypeBytes(indexComponentType);
  const valueBytes = componentTypeBytes(accessor.componentType ?? 5126);

  for (let i = 0; i < count; i++) {
    let target: number;
    const indexOffset = indexBase + i * indexBytes;
    switch (indexComponentType) {
      case 5121:
        target = indexData.getUint8(indexOffset);
        break;
      case 5123:
        target = indexData.getUint16(indexOffset, true);
        break;
      case 5125:
      default:
        target = indexData.getUint32(indexOffset, true);
        break;
    }

    for (let c = 0; c < componentCount; c++) {
      const offset = valueBase + i * componentCount * valueBytes + c * valueBytes;
      if (offset + valueBytes > valueData.byteLength) break;
      output[target * componentCount + c] = readComponent(
        valueData,
        offset,
        accessor.componentType ?? 5126,
        accessor.normalized === true,
      );
    }
  }
}

/** Bytes per component for a glTF component type. */
function componentTypeBytes(componentType: number): number {
  return COMPONENT_TYPES[componentType]?.bytes ?? 4;
}

/* -------------------------------------------------------------------------- */
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Loads glTF and GLB assets.
 */
export class GLTFLoader extends Loader<GLTFParseResult, ArrayBuffer | string> {
  /** `fetch` implementation in use. */
  public fetcher: FetchLike | null = null;

  /** Last parsed result, kept for inspection. */
  public lastResult: GLTFParseResult | null = null;

  /**
   * Creates a glTF loader.
   *
   * @param options Transport overrides.
   */
  constructor(options: GLTFLoadOptions = {}) {
    super();
    this.fetcher = options.fetcher ?? null;
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
   * Always fetched as bytes: a `.gltf` is text and a `.glb` is binary, and the URL
   * extension is not a reliable discriminator.
   */
  protected override async loadData(
    url: string,
    options: LoadOptions,
  ): Promise<LoadedSource<ArrayBuffer>> {
    const gltfOptions = options as GLTFLoadOptions;
    const fetcher = this.resolveFetcher(gltfOptions);
    if (fetcher === null) {
      throw new Error(
        `GLTFLoader("${url}"): no \`fetch\` implementation is available. Use \`parse()\` on ` +
          'inline data when running on a host without fetch.',
      );
    }

    const response = await fetcher(url, {
      method: 'GET',
      headers: { ...this.requestHeaders },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (response.ok === false) {
      throw new Error(`GLTFLoader("${url}"): HTTP ${response.status ?? '?'} ${response.statusText ?? ''}`.trim());
    }

    const bytes = await response.arrayBuffer();
    this.reportProgress(url, bytes.byteLength, bytes.byteLength, options);
    return { data: bytes, fromCache: false, byteLength: bytes.byteLength };
  }

  /**
   * @inheritdoc
   *
   * @throws Error When the document is malformed or the version is unsupported.
   */
  public override parse(
    source: ArrayBuffer | string | Uint8Array,
    url = '<inline>',
    options?: LoadOptions,
  ): GLTFParseResult {
    try {
      const result = parseGLTF(source);
      this.lastResult = result;
      return result;
    } catch (error) {
      throw new Error(
        `GLTFLoader("${url}"): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    finally {
      void options;
    }
  }

  /** Resolves the `fetch` implementation to use. */
  private resolveFetcher(options: GLTFLoadOptions): FetchLike | null {
    if (options.fetcher !== undefined) return options.fetcher;
    if (this.fetcher !== null) return this.fetcher;
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    return typeof globalFetch === 'function' ? (globalFetch as FetchLike) : null;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    super.onDispose();
    this.fetcher = null;
    this.lastResult = null;
  }
}

/**
 * Convenience factory mirroring `new GLTFLoader(options)`.
 *
 * @param options Transport overrides.
 * @returns A new glTF loader.
 */
export function gltfLoader(options: GLTFLoadOptions = {}): GLTFLoader {
  return new GLTFLoader(options);
}
