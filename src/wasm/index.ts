/**
 * WebAssembly bridge: {@link wasmLoader} plus the ABI vocabulary.
 *
 * ```ts
 * import { isWasmSupported, loadWasm, type MathWasmExports } from '@dxyl/graphics';
 *
 * if (isWasmSupported()) {
 *   const { module } = await loadWasm<MathWasmExports>('/build/math.wasm');
 *   module?.exports.mat4Multiply?.(aPtr, bPtr, outPtr);
 * }
 * ```
 *
 * ## The bundled `.wasm` files are placeholders
 *
 * `geometry.wasm` and `math.wasm` in this directory are **documented placeholder
 * stubs**, not functional modules. Each contains exactly the 8-byte WebAssembly
 * header
 *
 * ```
 * 00 61 73 6d 01 00 00 00
 * ```
 *
 * (magic `\0asm` + binary-format version 1) followed by an ASCII note naming the
 * module and the ABI it is expected to export. They exist so that
 *
 *  * the file paths the loader looks up are real, and
 *  * {@link validateWasmHeader} / {@link assertWasmHeader} can be exercised by the
 *    test suite against the exact bytes that will ship.
 *
 * They are **not instantiable**: `WebAssembly.instantiate` rejects them because
 * the byte stream ends before any section header. Replace them with a real build
 * produced by `tools/shader-compiler` and placed next to the bundle by
 * `scripts/copy-assets.ts`. The expected export surface is documented on
 * {@link GeometryWasmExports} and {@link MathWasmExports}; the
 * `getPlaceholderBytes` helper returns the committed payload so a build script or
 * a test can diff it against a real binary.
 *
 * @packageDocumentation
 */

export {
  WASM_MAGIC,
  WASM_VERSION,
  WASM_HEADER_BYTES,
  validateWasmHeader,
  assertWasmHeader,
  isWasmSupported,
  isWasmStreamingSupported,
  isWasmBinary,
  loadWasm,
  compileWasm,
  instantiateWasm,
  getWasmModule,
  getWasmCacheSize,
  clearWasmCache,
  getPlaceholderBytes,
} from './wasmLoader';
export type { WasmHeader } from './wasmLoader';
export * from './types';
