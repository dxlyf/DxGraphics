/**
 * Type vocabulary for the WebAssembly bridge.
 *
 * The wasm layer is deliberately tiny: it validates a binary's header, caches
 * compiled instances by URL and hands the exports back to the caller. Every
 * numeric detail of a module's ABI is described by a *typed export surface*
 * (`GeometryWasmExports`, `MathWasmExports`) so calling code is checked at
 * compile time instead of failing inside a wasm trap.
 *
 * ## Placeholder binaries
 *
 * `geometry.wasm` and `math.wasm` in this directory are **documented
 * placeholders**. They contain the 8-byte WebAssembly header
 * (`00 61 73 6d 01 00 00 00`) followed by an ASCII note; they are *not* valid
 * modules and cannot be instantiated. They exist so the paths are real and so
 * {@link validateWasmHeader} can be exercised end to end. Replace them with a
 * real build produced by `tools/shader-compiler` and copied by
 * `scripts/copy-assets.ts`.
 *
 * @packageDocumentation
 */

/* -------------------------------------------------------------------------- */
/* Core wasm contracts                                                        */
/* -------------------------------------------------------------------------- */

/** A value that can cross the wasm boundary without conversion work. */
export type WasmValue = number | bigint;

/** A wasm linear memory view exported by a module. */
export interface WasmMemory {
  /** The live `ArrayBuffer`; it is **detached** when memory grows. */
  readonly buffer: ArrayBuffer;
  /** Current size in wasm pages (64 KiB each). */
  readonly byteLength: number;
  /** Grows the memory by `deltaPages` pages; returns the previous page count. */
  grow(deltaPages: number): number;
}

/** The table object a module may export. */
export interface WasmTable {
  /** Number of entries currently allocated. */
  readonly length: number;
  /** Reads the raw function pointer stored at `index`. */
  get(index: number): ((...args: WasmValue[]) => WasmValue) | undefined;
}

/** A minimal `WebAssembly.Global`-shaped handle. */
export interface WasmGlobal {
  /** Current value. */
  value: WasmValue;
}

/**
 * The function/table/memory exports of an instantiated module.
 *
 * Deliberately not `WebAssembly.Exports`: that type is index-signature based and
 * erases the per-module typing this library wants. Concrete ABI descriptions
 * extend {@link WasmExports}.
 */
export interface WasmExports {
  /** Exported linear memory, when the module declares one. */
  memory?: WasmMemory;
  /** Exported function table, when the module declares one. */
  table?: WasmTable;
  /** Exported mutable/immutable globals. */
  globals?: Record<string, WasmGlobal>;
  /** Any additional exported function, keyed by its wasm export name. */
  [name: string]: unknown;
}

/**
 * The import object handed to `WebAssembly.instantiate`.
 *
 * Each top-level key is an import *namespace* (`env`, `wasi_snapshot_preview1`,
 * ...) mapping to that namespace's members.
 */
export type WasmImports = Record<string, Record<string, unknown>>;

/** A compiled and instantiated module plus the metadata the loader recorded. */
export interface WasmModule<TExports extends WasmExports = WasmExports> {
  /** URL (or cache key) the module was loaded from. */
  readonly url: string;
  /** Typed view over {@link WasmModule.instance}'s exports. */
  readonly exports: TExports;
  /** The raw instance, for callers that need `WebAssembly.Instance` itself. */
  readonly instance: unknown;
  /** The compiled module, for callers that want to instantiate it again. */
  readonly module: unknown;
  /** `true` when the bytes were streamed instead of buffered. */
  readonly streamed: boolean;
  /** Bytes compiled, as reported by the loader (streamed loads may report `0`). */
  readonly byteLength: number;
  /** Milliseconds spent fetching + compiling. */
  readonly loadTime: number;
}

/** Options accepted by {@link loadWasm} / `instantiateWasm`. */
export interface WasmLoadOptions {
  /**
   * Import object. Required for modules that import anything; a module with no
   * imports accepts an empty object.
   */
  imports?: WasmImports;
  /**
   * Skip `instantiateStreaming` and always use the `arrayBuffer` path.
   *
   * Useful behind CDNs that do not send `application/wasm`, or for tests that
   * stub `fetch`.
   */
  forceArrayBuffer?: boolean;
  /** Skip reading the header before compiling. Defaults to `false`. */
  skipHeaderValidation?: boolean;
  /**
   * When `true` a failed load resolves to `null` instead of rejecting.
   * Defaults to `false`.
   */
  optional?: boolean;
  /** Aborts the underlying fetch when the signal fires. */
  signal?: AbortSignal;
  /** `fetch` implementation override; defaults to the global one. */
  fetcher?: WasmFetcher;
  /** Pre-supplied bytes, bypassing `fetch` entirely. */
  bytes?: ArrayBuffer | ArrayBufferView;
  /** Cache the compiled module under {@link WasmLoadOptions.cacheKey}. Defaults to `true`. */
  cache?: boolean;
  /** Explicit cache key; defaults to the module URL. */
  cacheKey?: string;
}

/** Result record returned by {@link loadWasm}. */
export interface WasmLoadResult<TExports extends WasmExports = WasmExports> {
  /** The instantiated module, or `null` when `optional` was set and loading failed. */
  module: WasmModule<TExports> | null;
  /** `true` when the module came out of the loader cache. */
  cached: boolean;
  /** Failure cause, when `module` is `null`. */
  error?: Error;
}

/** The subset of `fetch` the wasm loader uses. */
export interface WasmFetcher {
  /** Fetches `url`; may return a `Response`-shaped object or an `ArrayBuffer`. */
  (url: string, init?: { signal?: AbortSignal }): Promise<WasmFetchResponse>;
}

/** The subset of `Response` the wasm loader reads. */
export interface WasmFetchResponse {
  /** `true` when the request succeeded (2xx). */
  readonly ok?: boolean;
  /** HTTP status code, when the implementation reports one. */
  readonly status?: number;
  /** Status text used in error messages. */
  readonly statusText?: string;
  /** MIME type; `application/wasm` enables the streaming path. */
  readonly headers?: { get(name: string): string | null };
  /** Reads the body into an `ArrayBuffer`. */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** The bodystream used by `instantiateStreaming`. */
  readonly body?: unknown;
}

/** Minimal description of the `WebAssembly` namespace the loader needs. */
export interface WasmRuntime {
  /** `WebAssembly.instantiateStreaming`, when the host provides it. */
  instantiateStreaming?: (source: unknown, imports?: WasmImports) => Promise<WasmInstantiateResult>;
  /** `WebAssembly.instantiate`; always required. */
  instantiate: (
    bytes: BufferSource,
    imports?: WasmImports,
  ) => Promise<WasmInstantiateResult> | WasmInstantiateResult;
  /** `WebAssembly.compile`, used when only compilation is wanted. */
  compile?: (bytes: BufferSource) => Promise<unknown> | unknown;
  /** `WebAssembly.validate`, used as a cheap sanity check. */
  validate?: (bytes: BufferSource) => boolean;
}

/** Shape shared by `WebAssembly.instantiate`'s two overloads. */
export interface WasmInstantiateResult {
  /** The instantiated module. */
  instance: { exports: Record<string, unknown> };
  /** The module, present only for the `BufferSource` overload. */
  module?: unknown;
}

/* -------------------------------------------------------------------------- */
/* Module ABIs                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Export surface of `geometry.wasm`.
 *
 * ## Placeholder status
 *
 * The committed `geometry.wasm` is a **documented placeholder** containing only
 * the wasm header. None of the functions below exist in it yet; instantiating it
 * will fail. The list documents the ABI a real build must provide.
 */
export interface GeometryWasmExports extends WasmExports {
  /** Pointer to the module's scratch allocator. */
  malloc?: (byteLength: number) => number;
  /** Releases a pointer previously returned by `malloc`. */
  free?: (pointer: number) => void;
  /** Exported linear memory the pointers index into. */
  memory?: WasmMemory;
  /** Builds a box: `(out, hx, hy, hz) -> void`. */
  buildBox?: (out: number, hx: number, hy: number, hz: number) => void;
  /** Builds a UV sphere: `(out, radius, widthSegments, heightSegments) -> void`. */
  buildSphere?: (out: number, radius: number, widthSegments: number, heightSegments: number) => void;
  /** Builds a cylinder: `(out, radiusTop, radiusBottom, height, segments) -> void`. */
  buildCylinder?: (
    out: number,
    radiusTop: number,
    radiusBottom: number,
    height: number,
    segments: number,
  ) => void;
  /** Builds a plane: `(out, width, height, wSegments, hSegments) -> void`. */
  buildPlane?: (out: number, width: number, height: number, wSegments: number, hSegments: number) => void;
  /** Accumulates area-weighted normals: `(positions, count, out) -> void`. */
  computeVertexNormals?: (positions: number, count: number, out: number) => void;
  /** Computes per-vertex tangents from positions/normals/uvs. */
  computeTangents?: (positions: number, normals: number, uvs: number, count: number, out: number) => void;
  /** Interleaves several attributes into one buffer. */
  interleaveAttributes?: (sources: number, strides: number, count: number, out: number) => void;
  /** Computes a bounding sphere for `count` vec3s. */
  computeBoundingSphere?: (positions: number, count: number, out: number) => void;
}

/**
 * Export surface of `math.wasm`.
 *
 * ## Placeholder status
 *
 * The committed `math.wasm` is a **documented placeholder** containing only the
 * wasm header. Replace it with a real build before relying on any of these.
 */
export interface MathWasmExports extends WasmExports {
  /** Pointer to the module's scratch allocator. */
  malloc?: (byteLength: number) => number;
  /** Releases a pointer previously returned by `malloc`. */
  free?: (pointer: number) => void;
  /** Exported linear memory the pointers index into. */
  memory?: WasmMemory;
  /** Column-major `out = a * b` over 16-float matrices. */
  mat4Multiply?: (a: number, b: number, out: number) => void;
  /** Column-major 4x4 inversion; returns `0` on a singular input. */
  mat4Invert?: (m: number, out: number) => number;
  /** Spherical interpolation between two quaternions. */
  quatSlerp?: (a: number, b: number, t: number, out: number) => void;
  /** Transforms `count` vec3s by a 4x4 matrix. */
  vec3TransformBatch?: (positions: number, count: number, matrix: number, out: number) => void;
  /** Batched Möller–Trumbore ray/triangle test; writes `count` distances. */
  rayTriangleBatch?: (
    origin: number,
    direction: number,
    triangles: number,
    count: number,
    out: number,
  ) => number;
  /** In-place radix-2 FFT over `count` complex pairs. */
  fft2d?: (real: number, imag: number, count: number, inverse: number) => void;
  /** 2D simplex noise; writes `count` samples. */
  simplexNoise2d?: (points: number, count: number, seed: number, out: number) => void;
}

/** Union of every ABI this library documents. */
export type KnownWasmExports = GeometryWasmExports | MathWasmExports;

/** Canonical names under which the placeholder binaries are cached. */
export const WASM_MODULE_NAMES = {
  /** Geometry helper module. */
  Geometry: 'geometry',
  /** Scalar/vector math module. */
  Math: 'math',
} as const;

/** Union of {@link WASM_MODULE_NAMES} values. */
export type WasmModuleName = (typeof WASM_MODULE_NAMES)[keyof typeof WASM_MODULE_NAMES];
