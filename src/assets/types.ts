/**
 * Shared type vocabulary for the asset pipeline.
 *
 * The asset layer is where "the library's own types" meet "whatever the user's
 * runtime provides", so almost everything here is either a structural interface over
 * a host object (`fetch`, `Response`, `XMLHttpRequest`, `createImageBitmap`) or a
 * typed description of a file format.
 *
 * ## No third-party parsers
 *
 * `GLTFLoader`, `OBJLoader`, `STLLoader` and `PLYLoader` parse their formats with
 * code in this repository. `FBXLoader` parses the ASCII header and node tree and
 * **honestly refuses** binary FBX — see {@link FBXParseResult}. Nothing here imports
 * a convenience library, which is the whole point of a zero-dependency package.
 *
 * @packageDocumentation
 */

import type { Box3 } from '../math/Box3';
import type { Vec2 } from '../math/Vec2';
import type { Vec3 } from '../math/Vec3';

/* -------------------------------------------------------------------------- */
/* Structural host contracts                                                  */
/* -------------------------------------------------------------------------- */

/** The subset of `Response` the file loader reads. */
export interface FetchResponseLike {
  /** `true` for a 2xx status. */
  readonly ok?: boolean;
  /** HTTP status code. */
  readonly status?: number;
  /** Status text used in error messages. */
  readonly statusText?: string;
  /** MIME type reported by the server. */
  readonly headers?: { get(name: string): string | null };
  /** Total byte count, when the server sent `Content-Length`. */
  readonly body?: unknown;
  /** Reads the body as text. */
  text(): Promise<string>;
  /** Reads the body as bytes. */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Reads the body as a blob. */
  blob?(): Promise<unknown>;
  /** Streaming reader used for progress, when the host provides one. */
  readonly bodyUsed?: boolean;
}

/** The subset of `fetch` the loaders use. */
export interface FetchLike {
  /** Performs a request. */
  (url: string, init?: FetchInitLike): Promise<FetchResponseLike>;
}

/** Options passed to `fetch`. */
export interface FetchInitLike {
  /** Request method. */
  method?: string;
  /** Extra headers. */
  headers?: Record<string, string>;
  /** CORS mode. */
  mode?: string;
  /** Credentials policy. */
  credentials?: string;
  /** Cache policy. */
  cache?: string;
  /** Abort signal. */
  signal?: AbortSignal;
}

/** The subset of `XMLHttpRequest` used by the progress-capable fallback. */
export interface XhrLike {
  /** Opens a request. */
  open(method: string, url: string, async?: boolean): void;
  /** Sends the request. */
  send(body?: unknown): void;
  /** Aborts the request. */
  abort(): void;
  /** Sets a request header. */
  setRequestHeader(name: string, value: string): void;
  /** Response body as text; set once `responseType` is `'text'`. */
  responseText: string;
  /** Response body; type depends on {@link XhrLike.responseType}. */
  response: unknown;
  /** Final status code. */
  status: number;
  /** Final status text. */
  statusText: string;
  /** Uploaded and total byte counts. */
  loaded?: number;
  /** Total bytes, or `0` when unknown. */
  total?: number;
  /** Response type selector. */
  responseType: string;
  /** Per-event handlers. */
  onload: ((event: unknown) => void) | null;
  /** Error handler. */
  onerror: ((event: unknown) => void) | null;
  /** Abort handler. */
  onabort: ((event: unknown) => void) | null;
  /** Progress handler. */
  onprogress: ((event: { loaded: number; total: number }) => void) | null;
  /** Timeout in milliseconds. */
  timeout: number;
  /** Read-only ready state. */
  readonly readyState?: number;
}

/** Factory that produces a fresh `XMLHttpRequest`-shaped object. */
export type XhrFactory = () => XhrLike;

/* -------------------------------------------------------------------------- */
/* Progress / errors                                                          */
/* -------------------------------------------------------------------------- */

/** A progress report emitted by a loader or the asset manager. */
export interface LoadProgress {
  /** Bytes transferred so far. */
  loaded: number;
  /** Total bytes, or `0` when the server did not report a length. */
  total: number;
  /** `loaded / total`, or `0` when the total is unknown. */
  ratio: number;
  /** URL the report belongs to. */
  url: string;
  /** Asset key, when the report came from an `AssetManager`. */
  key?: string;
}

/** A failed load. */
export interface LoadError {
  /** URL that failed. */
  url: string;
  /** Asset key, when the failure came from an `AssetManager`. */
  key?: string;
  /** Cause. */
  error: Error;
  /** Attempt number that produced the failure; `1` is the first try. */
  attempt: number;
  /** `true` when the failure was an abort rather than a network/parse error. */
  aborted: boolean;
}

/** Options accepted by every loader's `load`/`loadAsync`. */
export interface LoadOptions {
  /** Aborts the request. */
  signal?: AbortSignal;
  /** Bytes-transferred progress callback. */
  onProgress?: (progress: LoadProgress) => void;
  /** Per-attempt failure callback; fired before a retry is scheduled. */
  onError?: (error: LoadError) => void;
  /** Overrides the configured retry count for this call. */
  retries?: number;
  /** Overrides the configured retry delay for this call. */
  retryDelay?: number;
  /** Skips the cache for this call. */
  bypassCache?: boolean;
  /** Extra loader-specific options. */
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* Asset manager                                                              */
/* -------------------------------------------------------------------------- */

/** One entry of an {@link AssetManager} batch. */
export interface AssetRequest<T = unknown> {
  /** Key the result is stored under. */
  key: string;
  /** URL to load, or a pre-parsed value when `value` is set. */
  url?: string;
  /** Loader to use; resolved from the extension/MIME when omitted. */
  loader?: string;
  /** Pre-supplied value; short-circuits the load. */
  value?: T;
  /** Options forwarded to the loader. */
  options?: LoadOptions;
}

/** Result of one asset load. */
export interface AssetResult<T = unknown> {
  /** Key the result is stored under. */
  key: string;
  /** `true` when the load succeeded. */
  ok: boolean;
  /** The loaded value, when `ok`. */
  value?: T;
  /** The failure, when `!ok`. */
  error?: Error;
}

/** Progress across a whole batch. */
export interface BatchProgress {
  /** Items finished, successfully or not. */
  completed: number;
  /** Items in the batch. */
  total: number;
  /** Items that succeeded. */
  succeeded: number;
  /** Items that failed. */
  failed: number;
  /** Sum of the per-item ratios, divided by the item count. */
  ratio: number;
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                      */
/* -------------------------------------------------------------------------- */

/** Cache bookkeeping numbers. */
export interface CacheStats {
  /** Entries currently held. */
  entries: number;
  /** Configured entry limit. */
  limit: number;
  /** Cache hits since the last {@link Cache.resetStats}. */
  hits: number;
  /** Cache misses since the last {@link Cache.resetStats}. */
  misses: number;
  /** Entries evicted since the last {@link Cache.resetStats}. */
  evictions: number;
  /** Total bytes tracked, when entries report a size. */
  bytes: number;
  /** `hits / (hits + misses)`, or `0` with no lookups. */
  hitRate: number;
}

/** A cache entry that can report its own memory footprint. */
export interface Sized {
  /** Approximate size in bytes. */
  readonly byteLength?: number;
}

/* -------------------------------------------------------------------------- */
/* Formats: OBJ                                                               */
/* -------------------------------------------------------------------------- */

/** One `usemtl`/`g`/`o` range of an OBJ file. */
export interface OBJGroup {
  /** Group name, or `''`. */
  name: string;
  /** Material name from the active `usemtl`, or `null`. */
  material: string | null;
  /** Starting index into {@link OBJParseResult.indices}. */
  start: number;
  /** Number of indices in this group. */
  count: number;
}

/** A `newmtl` record from an MTL sidecar. */
export interface MTLMaterial {
  /** Material name. */
  name: string;
  /** Diffuse colour. */
  diffuse?: [number, number, number, number];
  /** Ambient colour. */
  ambient?: [number, number, number];
  /** Specular colour. */
  specular?: [number, number, number, number];
  /** Emissive colour. */
  emissive?: [number, number, number];
  /** Specular exponent. */
  shininess?: number;
  /** Opacity in `[0, 1]`. */
  opacity?: number;
  /** Index of refraction. */
  ior?: number;
  /** Diffuse texture path. */
  mapDiffuse?: string;
  /** Normal map path. */
  mapNormal?: string;
  /** Specular map path. */
  mapSpecular?: string;
  /** Alpha map path. */
  mapAlpha?: string;
  /** Emissive map path. */
  mapEmissive?: string;
}

/** Parsed OBJ data, still in "flat arrays" form. */
export interface OBJParseResult {
  /** Positions, three floats per vertex. */
  positions: Float32Array;
  /** Texture coordinates, two floats per vertex; empty when absent. */
  uvs: Float32Array;
  /** Normals, three floats per vertex; empty when absent. */
  normals: Float32Array;
  /** Triangle indices into the deduplicated vertex list. */
  indices: Uint32Array;
  /** `g`/`o`/`usemtl` ranges. */
  groups: OBJGroup[];
  /** Material names referenced by `usemtl`. */
  materialNames: string[];
  /** Parsed MTL sidecars, when `mtllib` data was supplied. */
  materials: MTLMaterial[];
  /** True when the source declared any `f` with more than three vertices. */
  hadPolygons: boolean;
  /** Counters useful in diagnostics. */
  counts: {
    /** `v` lines read. */
    vertices: number;
    /** `vt` lines read. */
    uvs: number;
    /** `vn` lines read. */
    normals: number;
    /** Faces read, before fan triangulation. */
    faces: number;
    /** Triangles produced. */
    triangles: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Formats: STL                                                               */
/* -------------------------------------------------------------------------- */

/** Parsed STL data. */
export interface STLParseResult {
  /** `'ascii'` or `'binary'`. */
  format: 'ascii' | 'binary';
  /** Triangle corner positions, nine floats per triangle. */
  positions: Float32Array;
  /** Per-triangle normals from the file, three floats per triangle. */
  normals: Float32Array;
  /** Number of triangles. */
  triangleCount: number;
  /** Header text, for a binary file. */
  header?: string;
}

/* -------------------------------------------------------------------------- */
/* Formats: PLY                                                               */
/* -------------------------------------------------------------------------- */

/** One `element` declaration in a PLY header. */
export interface PLYElement {
  /** Element name (`'vertex'`, `'face'`, ...). */
  name: string;
  /** Declared instance count. */
  count: number;
  /** Properties, in declaration order. */
  properties: PLYProperty[];
}

/** One PLY property. */
export interface PLYProperty {
  /** Property name. */
  name: string;
  /** Declared type name, e.g. `'float'`, `'uchar'`, `'list'`. */
  type: string;
  /** `true` for a list property. */
  isList: boolean;
  /** Element type of a list's count field. */
  countType?: string;
  /** Element type of a list's items. */
  itemType?: string;
}

/** Parsed PLY data. */
export interface PLYParseResult {
  /** `'ascii'` or `'binary_little_endian'` / `'binary_big_endian'`. */
  format: string;
  /** Parsed elements in header order. */
  elements: PLYElement[];
  /** Vertex positions, three floats per vertex. */
  positions: Float32Array;
  /** Vertex normals, three floats per vertex; empty when absent. */
  normals: Float32Array;
  /** Vertex texture coordinates, two floats per vertex; empty when absent. */
  uvs: Float32Array;
  /** Per-vertex red channel, when present. */
  colors: Float32Array;
  /** Triangle indices, flattened. */
  indices: Uint32Array;
  /** `true` when `indices` describes faces rather than a plain triangle soup. */
  hasFaces: boolean;
  /** Any comment lines, in order. */
  comments: string[];
}

/* -------------------------------------------------------------------------- */
/* Formats: glTF / GLB                                                        */
/* -------------------------------------------------------------------------- */

/** A glTF asset block. */
export interface GLTFAssetInfo {
  /** Format version. */
  version?: string;
  /** Tool that produced the file. */
  generator?: string;
  /** Copyright line. */
  copyright?: string;
}

/** A parsed glTF buffer. */
export interface GLTFBuffer {
  /** Resolved bytes, when the buffer was inline or a data URI. */
  data?: ArrayBuffer;
  /** External URI, when the buffer must still be fetched. */
  uri?: string;
  /** Declared byte length. */
  byteLength: number;
}

/** A parsed glTF accessor. */
export interface GLTFAccessor {
  /** Buffer view index. */
  bufferView?: number;
  /** Byte offset inside the view. */
  byteOffset?: number;
  /** Component type enum (`5126` = float). */
  componentType?: number;
  /** `true` when integer components are normalised. */
  normalized?: boolean;
  /** Component count. */
  count?: number;
  /** Type string (`'VEC3'`, `'SCALAR'`, ...). */
  type?: string;
  /** Minimum per component. */
  min?: number[];
  /** Maximum per component. */
  max?: number[];
}

/** A parsed glTF buffer view. */
export interface GLTFBufferView {
  /** Buffer index. */
  buffer?: number;
  /** Byte offset inside the buffer. */
  byteOffset?: number;
  /** View length in bytes. */
  byteLength?: number;
  /** Stride between elements. */
  byteStride?: number;
  /** Binding target (`34962` = ARRAY_BUFFER). */
  target?: number;
}

/** A parsed glTF image. */
export interface GLTFImage {
  /** Image name. */
  name?: string;
  /** External URI. */
  uri?: string;
  /** MIME type for a buffer-view image. */
  mimeType?: string;
  /** Buffer view index. */
  bufferView?: number;
}

/** A parsed glTF texture. */
export interface GLTFTexture {
  /** Texture name. */
  name?: string;
  /** Source image index. */
  source?: number;
  /** Sampler index. */
  sampler?: number;
}

/** A parsed glTF material. */
export interface GLTFMaterial {
  /** Material name. */
  name?: string;
  /** PBR metallic-roughness parameters. */
  pbrMetallicRoughness?: {
    /** Base colour factor `[r, g, b, a]`. */
    baseColorFactor?: number[];
    /** Base colour texture reference. */
    baseColorTexture?: { index?: number; texCoord?: number };
    /** Metalness factor. */
    metallicFactor?: number;
    /** Roughness factor. */
    roughnessFactor?: number;
    /** Metallic-roughness texture reference. */
    metallicRoughnessTexture?: { index?: number; texCoord?: number };
  };
  /** Normal texture reference. */
  normalTexture?: { index?: number; texCoord?: number; scale?: number };
  /** Occlusion texture reference. */
  occlusionTexture?: { index?: number; texCoord?: number; strength?: number };
  /** Emissive texture reference. */
  emissiveTexture?: { index?: number; texCoord?: number };
  /** Emissive factor `[r, g, b]`. */
  emissiveFactor?: number[];
  /** `'OPAQUE'`, `'MASK'` or `'BLEND'`. */
  alphaMode?: string;
  /** Alpha cutoff for `'MASK'`. */
  alphaCutoff?: number;
  /** `true` disables back-face culling. */
  doubleSided?: boolean;
}

/** A parsed glTF primitive. */
export interface GLTFPrimitive {
  /** Vertex attribute map, e.g. `{ POSITION: 0, NORMAL: 1 }`. */
  attributes?: Record<string, number>;
  /** Index accessor. */
  indices?: number;
  /** Material index. */
  material?: number;
  /** Primitive mode (`4` = triangles). */
  mode?: number;
}

/** A parsed glTF mesh. */
export interface GLTFMesh {
  /** Mesh name. */
  name?: string;
  /** Primitives. */
  primitives: GLTFPrimitive[];
  /** Morph target names, when the mesh is a morph target. */
  weights?: number[];
}

/** A parsed glTF node. */
export interface GLTFNode {
  /** Node name. */
  name?: string;
  /** Child node indices. */
  children?: number[];
  /** Mesh index attached to this node. */
  mesh?: number;
  /** Skin index attached to this node. */
  skin?: number;
  /** Local translation. */
  translation?: number[];
  /** Local rotation quaternion `[x, y, z, w]`. */
  rotation?: number[];
  /** Local scale. */
  scale?: number[];
  /** Column-major local matrix. */
  matrix?: number[];
}

/** A parsed glTF scene. */
export interface GLTFScene {
  /** Scene name. */
  name?: string;
  /** Root node indices. */
  nodes?: number[];
}

/** A resolved vertex attribute set, ready for a geometry. */
export interface GLTFAttributeData {
  /** Attribute name (`'position'`, `'normal'`, `'uv'`, ...). */
  name: string;
  /** Flattened values. */
  array: Float32Array;
  /** Components per element. */
  itemSize: number;
  /** Element count. */
  count: number;
}

/** A fully resolved glTF primitive. */
export interface GLTFResolvedPrimitive {
  /** Material index, or `-1`. */
  materialIndex: number;
  /** Resolved attributes. */
  attributes: GLTFAttributeData[];
  /** Triangle indices, when the primitive is indexed. */
  indices: Uint32Array | null;
  /** Primitive mode. */
  mode: number;
}

/** A fully resolved glTF mesh. */
export interface GLTFResolvedMesh {
  /** Mesh name. */
  name: string;
  /** Resolved primitives. */
  primitives: GLTFResolvedPrimitive[];
}

/** The scene-shaped result a `GLTFLoader` produces. */
export interface GLTFParseResult {
  /** Asset metadata. */
  asset: GLTFAssetInfo;
  /** Resolved buffers. */
  buffers: GLTFBuffer[];
  /** Raw accessors. */
  accessors: GLTFAccessor[];
  /** Raw buffer views. */
  bufferViews: GLTFBufferView[];
  /** Raw meshes. */
  meshes: GLTFMesh[];
  /** Raw materials. */
  materials: GLTFMaterial[];
  /** Raw textures. */
  textures: GLTFTexture[];
  /** Raw images. */
  images: GLTFImage[];
  /** Raw nodes. */
  nodes: GLTFNode[];
  /** Raw scenes. */
  scenes: GLTFScene[];
  /** Index of the default scene. */
  scene: number;
  /** Resolved meshes, with attributes and indices materialised. */
  resolvedMeshes: GLTFResolvedMesh[];
  /** `true` when the source was a binary GLB container. */
  binary: boolean;
  /** Extensions declared in `extensionsUsed`. */
  extensionsUsed: string[];
  /** Extensions the loader honoured. */
  extensionsSupported: string[];
}

/* -------------------------------------------------------------------------- */
/* Formats: FBX                                                               */
/* -------------------------------------------------------------------------- */

/** One node of an ASCII FBX tree. */
export interface FBXNode {
  /** Node name, e.g. `'Model'`. */
  name: string;
  /** Property values attached to the node. */
  properties: (string | number | boolean)[];
  /** Child nodes. */
  children: FBXNode[];
}

/** The result of parsing an ASCII FBX header and node tree. */
export interface FBXParseResult {
  /**
   * Always `'ascii'`.
   *
   * The loader only ever returns this for the ASCII form. Binary FBX is **not
   * implemented** and raises a descriptive error instead — see
   * {@link FBXUnsupportedError}.
   */
  format: 'ascii';
  /** FBX version from the `FBXHeaderVersion`/`FBXVersion` record. */
  version: number;
  /** Raw header text, up to the version record. */
  header: string;
  /** Top-level nodes of the tree. */
  nodes: FBXNode[];
  /** Count of nodes visited, for diagnostics. */
  nodeCount: number;
}

/* -------------------------------------------------------------------------- */
/* Formats: SVG                                                               */
/* -------------------------------------------------------------------------- */

/** One subpath of an SVG path, as flattened polyline points. */
export interface SVGSubPath {
  /** Points, two floats per point. */
  points: Float32Array;
  /** `true` when the subpath was explicitly closed with `Z`. */
  closed: boolean;
}

/** The command characters `SVGLoader` understands. */
export type SVGCommand = 'M' | 'L' | 'H' | 'V' | 'C' | 'S' | 'Q' | 'T' | 'A' | 'Z';

/** Parsed SVG path data. */
export interface SVGParseResult {
  /** Subpaths, in document order. */
  subPaths: SVGSubPath[];
  /** Every point, flattened across subpaths. */
  points: Float32Array;
  /** `viewBox` from the root element, when present. */
  viewBox?: { x: number; y: number; width: number; height: number };
  /** Root width in user units. */
  width?: number;
  /** Root height in user units. */
  height?: number;
  /** Number of path commands executed. */
  commandCount: number;
}

/* -------------------------------------------------------------------------- */
/* Textures / images                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Structural view of a texture the loaders hand back.
 *
 * `TextureLoader` returns this shape rather than an instance from
 * `src/textures` (a module this file must not import): the real `Texture` class
 * satisfies it, and so does a hand-built fixture.
 */
export interface TextureLike {
  /** Decoded image, kept opaque. */
  image?: unknown;
  /** Convenience alias of `image`, matching the DOM convention. */
  source?: unknown;
  /** Width in texels. */
  width?: number;
  /** Height in texels. */
  height?: number;
  /** `true` once the texture has bytes behind it. */
  needsUpdate?: boolean;
  /** `true` when the texture reads as flipped. */
  flipY?: boolean;
  /** Free-form texture parameters. */
  [property: string]: unknown;
}

/** Structural view of a decoded image the loaders accept. */
export interface ImageLike {
  /** Bitmap width in pixels. */
  readonly width?: number;
  /** Bitmap height in pixels. */
  readonly height?: number;
  /** Natural width, for an `HTMLImageElement`. */
  readonly naturalWidth?: number;
  /** Natural height, for an `HTMLImageElement`. */
  readonly naturalHeight?: number;
  /** `true` once the bytes are decoded. */
  readonly complete?: boolean;
  /** Source URL. */
  readonly src?: string;
  /** Releases the bitmap, when the host supports it. */
  close?(): void;
}

/** Factory the texture loader uses to turn bytes into a bitmap. */
export type ImageDecoder = (bytes: ArrayBuffer, mimeType: string) => Promise<ImageLike> | ImageLike;

/* -------------------------------------------------------------------------- */
/* Geometry-bearing results                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Structural view of a `BufferGeometry` the loaders can build.
 *
 * `AssetManager` and the mesh loaders return these rather than instances so they
 * stay independent of `src/geometry`; the real class satisfies this shape.
 */
export interface GeometryLike {
  /** Attribute dictionary. */
  attributes: Record<string, { array: ArrayLike<number>; itemSize: number; count?: number }>;
  /** Index buffer. */
  index: { array: ArrayLike<number>; itemSize: number; count?: number } | null;
  /** Cached local bounds. */
  boundingBox?: Box3 | null;
  /** Cached local bounding sphere. */
  boundingSphere?: { center: Vec3; radius: number } | null;
  /** Attaches an attribute. */
  setAttribute?(name: string, attribute: unknown): unknown;
  /** Assigns the index buffer. */
  setIndex?(index: unknown): unknown;
  /** Computes the bounding volumes. */
  computeBoundingBox?(): unknown;
  /** Computes the bounding sphere. */
  computeBoundingSphere?(): unknown;
  /** Releases GPU resources. */
  dispose?(): void;
}

/** A mesh-shaped result produced by the geometry loaders. */
export interface MeshLike {
  /** Name from the file, when present. */
  name: string;
  /** Geometry payload. */
  geometry: GeometryLike | null;
  /** Material name or index from the file. */
  material?: string | number | null;
  /** Group ranges, when the source declared them. */
  groups?: { name: string; start: number; count: number; material: string | null }[];
  /** World-space bounds, when the parser computed them. */
  bounds?: { min: Vec3; max: Vec3 };
}

/** Options shared by the geometry loaders. */
export interface MeshLoadOptions extends LoadOptions {
  /** Flip the V texture coordinate (`1 - v`). */
  flipUvs?: boolean;
  /** Compute vertex normals when the file has none. */
  computeNormals?: boolean;
  /** Scale applied to every position. */
  scale?: number;
  /** Recentre the geometry on its bounding-box centre. */
  center?: boolean;
}

/** Re-exported so parser modules can talk about UVs without importing maths broadly. */
export type UVLike = Vec2;
