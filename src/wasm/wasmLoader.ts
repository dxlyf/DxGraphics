/**
 * WebAssembly loading, validation and caching.
 *
 * ```ts
 * const { module } = await loadWasm<MathWasmExports>('/math.wasm');
 * module?.exports.mat4Multiply?.(aPtr, bPtr, outPtr);
 * ```
 *
 * The loader has three jobs:
 *  1. **Validate the header** before compiling, so a truncated file or an HTML
 *     error page yields "geometry.wasm: not a WebAssembly binary …" instead of an
 *     opaque `CompileError`.
 *  2. **Prefer `instantiateStreaming`** — it compiles while the body downloads —
 *     and fall back to `instantiate(arrayBuffer)` whenever the host lacks it, the
 *     response is not `application/wasm`, or the caller asked for
 *     {@link WasmLoadOptions.forceArrayBuffer}.
 *  3. **Cache instances by URL**, because a wasm module is stateless glue code and
 *     instantiating the same file twice is pure waste.
 *
 * ## The binaries in this directory are placeholders
 *
 * `geometry.wasm` and `math.wasm` shipped in `src/wasm/` are **documented
 * placeholders**: exactly the 8-byte header (`00 61 73 6d 01 00 00 00`) followed
 * by an ASCII note. They pass {@link validateWasmHeader} — which is what the test
 * suite asserts — but `WebAssembly.instantiate` on them fails by design. Replace
 * them with a real build from `tools/shader-compiler`, copied by
 * `scripts/copy-assets.ts`; see {@link GeometryWasmExports} and
 * {@link MathWasmExports} for the ABI each one is expected to export.
 *
 * @packageDocumentation
 */

import { createLogger } from '../utils/Logger';
import type {
  WasmExports,
  WasmFetchResponse,
  WasmFetcher,
  WasmImports,
  WasmInstantiateResult,
  WasmLoadOptions,
  WasmLoadResult,
  WasmModule,
  WasmRuntime,
} from './types';

/** Logger shared by every wasm load. */
const log = createLogger('wasm');

/* -------------------------------------------------------------------------- */
/* Header parsing                                                             */
/* -------------------------------------------------------------------------- */

/** WebAssembly magic number: `\0asm`, little-endian. */
export const WASM_MAGIC = 0x6d736100;

/** WebAssembly binary format version this loader understands (version 1). */
export const WASM_VERSION = 0x00000001;

/** Bytes a minimal wasm binary must contain (magic + version). */
export const WASM_HEADER_BYTES = 8;

/** Decoded wasm header. */
export interface WasmHeader {
  /** Magic number as a little-endian `uint32`; must equal {@link WASM_MAGIC}. */
  magic: number;
  /** Format version; must equal {@link WASM_VERSION}. */
  version: number;
  /** `true` when both magic and version were accepted. */
  valid: boolean;
}

/**
 * Reads the 8-byte wasm header from `source`.
 *
 * Never throws: an undersized buffer reports `valid: false` with whatever bytes
 * were available. Use {@link assertWasmHeader} when a descriptive error is
 * wanted instead.
 *
 * @param source Bytes to inspect; only the first eight are read.
 * @returns The decoded header.
 */
export function validateWasmHeader(source: ArrayBuffer | ArrayBufferView): WasmHeader {
  const view = toUint8(source);
  if (view.byteLength < WASM_HEADER_BYTES) {
    return { magic: 0, version: 0, valid: false };
  }

  const magic =
    view[0] | (view[1] << 8) | (view[2] << 16) | (view[3] << 24);
  const version =
    view[4] | (view[5] << 8) | (view[6] << 16) | (view[7] << 24);

  return {
    // `>>> 0` keeps the value unsigned; the shifts above can produce negatives.
    magic: magic >>> 0,
    version: version >>> 0,
    valid: (magic >>> 0) === WASM_MAGIC && (version >>> 0) === WASM_VERSION,
  };
}

/**
 * Validates the header and throws a descriptive error when it is wrong.
 *
 * The message names the offending values in hex, which is what makes a mangled
 * deployment ("we got a 404 HTML page") obvious from a single log line.
 *
 * @param source Bytes to inspect.
 * @param label Name used in the error message; usually the module URL.
 * @returns The decoded header, guaranteed `valid`.
 * @throws Error When the magic number or the version is wrong, or the input is
 *   shorter than eight bytes.
 */
export function assertWasmHeader(source: ArrayBuffer | ArrayBufferView, label: string): WasmHeader {
  const view = toUint8(source);
  if (view.byteLength < WASM_HEADER_BYTES) {
    throw new Error(
      `${label}: not a WebAssembly binary — expected at least ${WASM_HEADER_BYTES} header bytes, ` +
        `received ${view.byteLength}. A placeholder or truncated file cannot be instantiated.`,
    );
  }

  const header = validateWasmHeader(view);
  if (header.magic !== WASM_MAGIC) {
    throw new Error(
      `${label}: not a WebAssembly binary — bad magic number 0x${header.magic
        .toString(16)
        .padStart(8, '0')} (expected 0x${WASM_MAGIC.toString(16).padStart(8, '0')} = "\\0asm"). ` +
        'The response was probably HTML or JSON, not wasm.',
    );
  }
  if (header.version !== WASM_VERSION) {
    throw new Error(
      `${label}: unsupported WebAssembly version ${header.version} ` +
        `(this loader supports version ${WASM_VERSION}).`,
    );
  }
  return header;
}

/** Copies any `ArrayBuffer`/view into a `Uint8Array` without duplicating bytes. */
function toUint8(source: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (source instanceof Uint8Array) return source;
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  return new Uint8Array(source);
}

/* -------------------------------------------------------------------------- */
/* Host capability probes                                                     */
/* -------------------------------------------------------------------------- */

/** Resolves the `WebAssembly` namespace, or `null` on a host without wasm. */
function resolveRuntime(): WasmRuntime | null {
  const candidate = (globalThis as { WebAssembly?: unknown }).WebAssembly;
  if (candidate == null || typeof candidate !== 'object') return null;
  const runtime = candidate as unknown as WasmRuntime;
  return typeof runtime.instantiate === 'function' ? runtime : null;
}

/**
 * `true` when the host can compile and instantiate a wasm binary.
 *
 * A boolean probe rather than a throwing one: callers use it to pick a wasm or a
 * JavaScript code path, and "no wasm" is a normal, expected outcome.
 *
 * @returns `true` when `WebAssembly.instantiate` is available.
 */
export function isWasmSupported(): boolean {
  return resolveRuntime() !== null;
}

/**
 * `true` when the host can also stream-compile (`instantiateStreaming`).
 *
 * Streaming is an optimisation only; {@link loadWasm} falls back automatically.
 *
 * @returns `true` when `WebAssembly.instantiateStreaming` is available.
 */
export function isWasmStreamingSupported(): boolean {
  const runtime = resolveRuntime();
  return runtime !== null && typeof runtime.instantiateStreaming === 'function';
}

/** Builds the descriptive "wasm is unavailable" error used by the loader. */
function unsupportedError(url: string): Error {
  return new Error(
    `loadWasm("${url}"): this environment does not expose WebAssembly.instantiate. ` +
      'WebAssembly requires a browser, a worker, or Node.js 12+; the request cannot be served.',
  );
}

/* -------------------------------------------------------------------------- */
/* Module cache                                                               */
/* -------------------------------------------------------------------------- */

/** Compiled modules keyed by URL (or the caller's explicit cache key). */
const moduleCache = new Map<string, WasmModule<WasmExports>>();

/** In-flight loads, so two concurrent requests for one URL share a compile. */
const pendingLoads = new Map<string, Promise<WasmModule<WasmExports>>>();

/**
 * Looks a previously loaded module up by its name or URL.
 *
 * The lookup tries the exact key first, then a suffix match on the file name, so
 * `getWasmModule('geometry')` finds `/assets/wasm/geometry.wasm`.
 *
 * @typeParam TExports ABI to cast the exports to.
 * @param name Cache key, module name (`'geometry'`) or full URL.
 * @returns The cached module, or `undefined`.
 */
export function getWasmModule<TExports extends WasmExports = WasmExports>(
  name: string,
): WasmModule<TExports> | undefined {
  const direct = moduleCache.get(name);
  if (direct) return direct as WasmModule<TExports>;

  const normalized = name.toLowerCase();
  for (const [key, value] of moduleCache) {
    const file = key.split(/[?#]/)[0].split(/[\\/]/).pop()?.toLowerCase();
    if (file === normalized || file === `${normalized}.wasm`) {
      return value as WasmModule<TExports>;
    }
  }
  return undefined;
}

/**
 * Number of modules currently cached.
 *
 * @returns The cache size.
 */
export function getWasmCacheSize(): number {
  return moduleCache.size;
}

/**
 * Removes one entry, or every entry when `name` is omitted.
 *
 * The loader drops its cached *instance*, not the underlying compiled module, so
 * a later `loadWasm` recompiles from the network; call this after swapping a
 * placeholder for a real build during development.
 *
 * @param name Cache key, module name or URL; omit to clear everything.
 * @returns `true` when at least one entry was removed.
 */
export function clearWasmCache(name?: string): boolean {
  if (name === undefined) {
    const had = moduleCache.size > 0;
    moduleCache.clear();
    pendingLoads.clear();
    return had;
  }
  const resolved = getWasmModule(name);
  if (!resolved) return false;
  for (const [key, value] of Array.from(moduleCache)) {
    if (value === resolved) moduleCache.delete(key);
  }
  pendingLoads.delete(name);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                   */
/* -------------------------------------------------------------------------- */

/** Default fetcher: the global `fetch`, adapted to {@link WasmFetcher}. */
function defaultFetcher(): WasmFetcher {
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  if (typeof globalFetch !== 'function') {
    throw new Error(
      'loadWasm: no `fetch` implementation is available and no bytes were supplied. ' +
        'Pass `options.bytes` or `options.fetcher` when running outside a fetch-capable host.',
    );
  }
  return globalFetch as WasmFetcher;
}

/** Reads the bytes of `url` through `fetcher`, validating the HTTP status. */
async function fetchBytes(
  url: string,
  fetcher: WasmFetcher,
  signal: AbortSignal | undefined,
): Promise<{ bytes: ArrayBuffer; response: WasmFetchResponse | null }> {
  const response = await fetcher(url, signal ? { signal } : undefined);

  if (response && response.ok === false) {
    throw new Error(
      `loadWasm("${url}"): HTTP ${response.status ?? '?'} ${response.statusText ?? ''}`.trim(),
    );
  }

  const bytes = await response.arrayBuffer();
  return { bytes, response };
}

/* -------------------------------------------------------------------------- */
/* loadWasm                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Loads, validates, instantiates and caches a WebAssembly module.
 *
 * ```ts
 * const { module, cached } = await loadWasm<GeometryWasmExports>('/build/geometry.wasm', {
 *   imports: { env: { abort: () => { throw new Error('wasm aborted'); } } },
 * });
 * ```
 *
 * @typeParam TExports ABI the exports are typed as. Nothing is verified at
 *   runtime — the generic parameter is a compile-time convenience.
 * @param url Module URL, used as the default cache key and in error messages.
 * @param options Import object, fallbacks and caching flags.
 * @returns A result record; `module` is `null` only when `options.optional` is set
 *   and loading failed.
 * @throws Error When the header is invalid, the fetch fails, or instantiation
 *   throws — unless `options.optional` is set.
 */
export async function loadWasm<TExports extends WasmExports = WasmExports>(
  url: string,
  options: WasmLoadOptions = {},
): Promise<WasmLoadResult<TExports>> {
  const cacheKey = options.cacheKey ?? url;
  const useCache = options.cache ?? true;

  if (useCache) {
    const cached = getWasmModule<TExports>(cacheKey);
    if (cached) return { module: cached, cached: true };
  }

  try {
    const module = await loadWasmUncached<TExports>(url, options, cacheKey, useCache);
    return { module, cached: false };
  } catch (error) {
    if (!options.optional) throw error;
    const resolved = error instanceof Error ? error : new Error(String(error));
    log.warn(`optional wasm load failed for "${url}"`, resolved.message);
    return { module: null, cached: false, error: resolved };
  }
}

/** Shared body of {@link loadWasm}, minus caching and the `optional` wrapper. */
async function loadWasmUncached<TExports extends WasmExports>(
  url: string,
  options: WasmLoadOptions,
  cacheKey: string,
  useCache: boolean,
): Promise<WasmModule<TExports>> {
  // De-duplicate concurrent loads of the same key before doing any work.
  const inFlight = pendingLoads.get(cacheKey);
  if (useCache && inFlight) {
    return (await inFlight) as WasmModule<TExports>;
  }

  const attempt = (async (): Promise<WasmModule<WasmExports>> => {
    const runtime = resolveRuntime();
    if (!runtime) throw unsupportedError(url);

    const startedAt = Date.now();
    const imports: WasmImports = options.imports ?? {};

    let streamed = false;
    let byteLength = 0;
    let result: WasmInstantiateResult;

    const suppliedBytes = options.bytes;
    const canStream =
      suppliedBytes === undefined &&
      !options.forceArrayBuffer &&
      typeof runtime.instantiateStreaming === 'function';

    if (canStream) {
      const attemptStream = await tryStreaming(url, runtime, imports, options);
      if (attemptStream) {
        result = attemptStream.result;
        streamed = true;
        byteLength = attemptStream.byteLength;
      } else {
        result = await instantiateFromFetch(url, runtime, imports, options);
      }
    } else {
      result = suppliedBytes
        ? await instantiateFromBytes(url, runtime, imports, suppliedBytes, options)
        : await instantiateFromFetch(url, runtime, imports, options);
    }

    if (!streamed && byteLength === 0) {
      // The buffered paths know their length; recover it from the response when
      // the runtime did not hand back a module object.
      byteLength = guessByteLength(result);
    }

    const exports = (result.instance?.exports ?? {}) as unknown as WasmExports;
    const module: WasmModule<WasmExports> = {
      url,
      exports,
      instance: result.instance,
      module: result.module ?? null,
      streamed,
      byteLength,
      loadTime: Date.now() - startedAt,
    };

    log.debug(`instantiated wasm module "${url}"`, {
      streamed,
      byteLength,
      loadTime: module.loadTime,
    });

    if (useCache) moduleCache.set(cacheKey, module);
    return module;
  })();

  if (useCache) pendingLoads.set(cacheKey, attempt);
  try {
    return (await attempt) as WasmModule<TExports>;
  } finally {
    pendingLoads.delete(cacheKey);
  }
}

/** Attempts the streaming path; returns `null` when the host refuses to stream. */
async function tryStreaming(
  url: string,
  runtime: WasmRuntime,
  imports: WasmImports,
  options: WasmLoadOptions,
): Promise<{ result: WasmInstantiateResult; byteLength: number } | null> {
  const instantiateStreaming = runtime.instantiateStreaming;
  if (typeof instantiateStreaming !== 'function') return null;

  const fetcher = options.fetcher ?? safeDefaultFetcher();
  if (!fetcher) return null;

  try {
    const response = await fetcher(url, options.signal ? { signal: options.signal } : undefined);
    if (response.ok === false) {
      throw new Error(
        `loadWasm("${url}"): HTTP ${response.status ?? '?'} ${response.statusText ?? ''}`.trim(),
      );
    }

    const mime = response.headers?.get('content-type') ?? '';
    if (mime.length > 0 && !mime.includes('application/wasm')) {
      // Chrome refuses to stream a mis-typed body; take the buffered path now
      // instead of letting a TypeMismatchError propagate.
      log.debug(`"${url}" served as "${mime}"; falling back to arrayBuffer()`);
      return null;
    }

    const result = await instantiateStreaming(response, imports);
    if (!options.skipHeaderValidation) {
      // The header could not be inspected before compiling, so at least warn:
      // a placeholder binary compiles to a module with no exports.
      log.debug(`streamed "${url}" without a pre-flight header check`);
    }
    return { result, byteLength: 0 };
  } catch (error) {
    log.debug(`streaming instantiate failed for "${url}"; retrying buffered`, error);
    return null;
  }
}

/** Buffered path: fetch, validate the header, then `instantiate`. */
async function instantiateFromFetch(
  url: string,
  runtime: WasmRuntime,
  imports: WasmImports,
  options: WasmLoadOptions,
): Promise<WasmInstantiateResult> {
  const fetcher = options.fetcher ?? defaultFetcher();
  const { bytes } = await fetchBytes(url, fetcher, options.signal);
  return instantiateFromBytes(url, runtime, imports, bytes, options);
}

/** Buffered instantiate with optional header validation. */
async function instantiateFromBytes(
  url: string,
  runtime: WasmRuntime,
  imports: WasmImports,
  bytes: ArrayBuffer | ArrayBufferView,
  options: WasmLoadOptions,
): Promise<WasmInstantiateResult> {
  if (!options.skipHeaderValidation) assertWasmHeader(bytes, moduleLabel(url));
  return runtime.instantiate(bytes as BufferSource, imports);
}

/** Returns the global fetcher, or `null` when the host has no `fetch`. */
function safeDefaultFetcher(): WasmFetcher | null {
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  return typeof globalFetch === 'function' ? (globalFetch as WasmFetcher) : null;
}

/** Best-effort byte count for a result the runtime did not measure. */
function guessByteLength(result: WasmInstantiateResult): number {
  const module = result.module as { byteLength?: unknown } | undefined;
  if (module && typeof module.byteLength === 'number') return module.byteLength;
  return 0;
}

/** Short human label for a module URL, used at the head of error messages. */
function moduleLabel(url: string): string {
  const file = url.split(/[?#]/)[0].split(/[\\/]/).pop();
  return file && file.length > 0 ? file : url;
}

/* -------------------------------------------------------------------------- */
/* Convenience wrappers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Compiles a module without instantiating it.
 *
 * Useful to warm the compile cache before the first frame that needs the module.
 *
 * @param url Module URL.
 * @param options Import/fallback options; `imports` is ignored here.
 * @returns The compiled module handle, or `null` when the host lacks `compile`.
 * @throws Error When the header is invalid or the fetch fails.
 */
export async function compileWasm(url: string, options: WasmLoadOptions = {}): Promise<unknown> {
  const runtime = resolveRuntime();
  if (!runtime) throw unsupportedError(url);
  if (typeof runtime.compile !== 'function') return null;

  const bytes =
    options.bytes ?? (await fetchBytes(url, options.fetcher ?? defaultFetcher(), options.signal)).bytes;
  if (!options.skipHeaderValidation) assertWasmHeader(bytes, moduleLabel(url));
  return runtime.compile(bytes as BufferSource);
}

/**
 * Instantiates a module straight from bytes, bypassing `fetch` and the cache.
 *
 * This is the entry point a test uses to feed a hand-built binary.
 *
 * @typeParam TExports ABI the exports are typed as.
 * @param bytes Wasm binary bytes.
 * @param options Import object and validation flags.
 * @param label Label used in error messages; defaults to `'<bytes>'`.
 * @returns The instantiated module record.
 */
export async function instantiateWasm<TExports extends WasmExports = WasmExports>(
  bytes: ArrayBuffer | ArrayBufferView,
  options: WasmLoadOptions = {},
  label = '<bytes>',
): Promise<WasmModule<TExports>> {
  const runtime = resolveRuntime();
  if (!runtime) throw unsupportedError(label);
  if (!options.skipHeaderValidation) assertWasmHeader(bytes, label);

  const startedAt = Date.now();
  const result = await runtime.instantiate(bytes as BufferSource, options.imports ?? {});
  // The ABI is a caller-supplied promise: the loader cannot verify that the module
  // really exports `mat4Multiply`, so the cast is the documented contract of the
  // generic parameter rather than an unchecked assumption.
  const exports = (result.instance?.exports ?? {}) as unknown as TExports;

  return {
    url: label,
    exports,
    instance: result.instance,
    module: result.module ?? null,
    streamed: false,
    byteLength: toUint8(bytes).byteLength,
    loadTime: Date.now() - startedAt,
  };
}

/**
 * `true` when `value` carries a valid wasm header.
 *
 * A cheap guard for callers that received bytes from an untrusted source.
 *
 * @param value Bytes to test.
 * @returns `true` when the magic number and version both match.
 */
export function isWasmBinary(value: unknown): boolean {
  if (value instanceof ArrayBuffer) return validateWasmHeader(value).valid;
  if (ArrayBuffer.isView(value)) return validateWasmHeader(value).valid;
  return false;
}

/**
 * Reads the two placeholder binaries shipped in `src/wasm/`.
 *
 * Documented behaviour: the placeholders pass header validation and cannot be
 * instantiated. Callers should treat a non-`null` result as "the file exists" and
 * check {@link isWasmBinary} separately from a successful `instantiateWasm`.
 *
 * @param name Module name from {@link WASM_MODULE_NAMES}.
 * @returns A `Uint8Array` view of the bundled placeholder bytes.
 */
export function getPlaceholderBytes(name: string): Uint8Array | null {
  const placeholder = PLACEHOLDER_BINARIES[name.toLowerCase()];
  return placeholder ? placeholder.slice() : null;
}

/**
 * The committed placeholder payloads.
 *
 * Each entry is the 8-byte header followed by an ASCII note naming the module and
 * the build step that should replace it. Keeping the note inside the binary makes
 * the placeholder self-describing in a hex dump.
 */
const PLACEHOLDER_BINARIES: Readonly<Record<string, Uint8Array>> = {
  geometry: buildPlaceholder(
    'geometry.wasm',
    'buildBox, buildSphere, buildCylinder, buildPlane, computeVertexNormals, ' +
      'computeTangents, interleaveAttributes, computeBoundingSphere',
  ),
  math: buildPlaceholder(
    'math.wasm',
    'mat4Multiply, mat4Invert, quatSlerp, vec3TransformBatch, rayTriangleBatch, fft2d, simplexNoise2d',
  ),
};

/** Builds one placeholder payload: header + ASCII note listing the ABI. */
function buildPlaceholder(file: string, exports: string): Uint8Array {
  const note =
    `DXYL-WASM-PLACEHOLDER ${file}: replace with a real build ` +
    `(tools/shader-compiler + scripts/copy-assets.ts). Expected exports: ${exports}.`;
  const bytes = new Uint8Array(WASM_HEADER_BYTES + note.length);
  bytes[0] = 0x00;
  bytes[1] = 0x61;
  bytes[2] = 0x73;
  bytes[3] = 0x6d;
  bytes[4] = 0x01;
  bytes[5] = 0x00;
  bytes[6] = 0x00;
  bytes[7] = 0x00;
  for (let i = 0; i < note.length; i++) bytes[WASM_HEADER_BYTES + i] = note.charCodeAt(i) & 0xff;
  return bytes;
}
