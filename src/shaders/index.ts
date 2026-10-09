/**
 * Shader layer.
 *
 * A backend-agnostic description of shader programs, the registry of reusable
 * source chunks, the built-in program library and the compile/link orchestration
 * every backend shares. Nothing here touches a GPU: a backend implements the
 * structural `ShaderBackend` contract and the compiler drives it, which keeps
 * the WebGL and WebGPU implementations symmetrical.
 *
 * ## Shader sources are TypeScript modules
 *
 * `.glsl`/`.wgsl` files need a bundler plugin to become strings, so the built-in
 * sources live in `src/shaders/glsl/**\/*.ts` and `src/shaders/wgsl/**\/*.ts` as
 * template-literal string constants. The library therefore builds with Vite,
 * Rollup, webpack, esbuild **and** plain `tsc`, with no plugin and no extra
 * configuration, and the sources stay unit-testable:
 *
 * ```ts
 * import { getShaderLib, ShaderChunk } from '@dxyl/graphics';
 *
 * ShaderChunk.hasChunk('glsl/lighting');            // true: registered on import
 * const entry = getShaderLib('standard');           // GLSL + WGSL descriptors
 * const vertex = entry.glsl.vertex;                 // typed string constant
 * ```
 *
 * `#include <name>` (GLSL) and `//!include name` (WGSL) directives inside the
 * sources are expanded by `ShaderChunk`, including cycle detection, so the
 * source text still reads like ordinary shader code.
 *
 * | Module | Contents |
 * | --- | --- |
 * | `types` | `ShaderLanguage`, `ShaderStage`, `ShaderDescriptor`, `UniformValue`, ... |
 * | `Shader` | the mutable program description object |
 * | `ShaderChunk` | the named-chunk registry and include resolver |
 * | `ShaderLib` | the built-in families and their language variants |
 * | `ShaderCache` | a bounded per-backend LRU of compiled handles |
 * | `ShaderCompiler` | source assembly, compilation and linking |
 * | `Uniforms` | the typed uniform container and declaration emitter |
 *
 * @packageDocumentation
 */

export * from './types';
export * from './Shader';
export * from './ShaderChunk';
export * from './ShaderCache';
export * from './ShaderCompiler';
export * from './ShaderLib';
export * from './Uniforms';

// Language sources: the barrels register their chunks with `ShaderChunk` as a
// side effect and expose the program descriptors used by `ShaderLib`.
export * from './glsl';
export * from './wgsl';
