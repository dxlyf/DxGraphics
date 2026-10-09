/**
 * Shader-layer types.
 *
 * The shader layer is deliberately backend- and language-agnostic: a
 * {@link ShaderDescriptor} is plain data that a WebGL, WebGPU or offline
 * compiler turns into a program. Nothing in this module (or in the shader layer
 * as a whole) imports a renderer, so the same descriptors can be validated in a
 * Node test run without a GPU.
 *
 * @packageDocumentation
 */

/**
 * The shading languages the library can emit.
 *
 * `'glsl'` covers GLSL ES 1.00/3.00 as consumed by WebGL 1 and 2; `'wgsl'` is
 * the WebGPU shading language.
 */
export type ShaderLanguage = 'glsl' | 'wgsl';

/** One programmable stage of a program. */
export type ShaderStage = 'vertex' | 'fragment' | 'compute';

/**
 * The semantic type of a uniform.
 *
 * Types are semantic rather than language-specific so a single declaration can
 * be rendered as GLSL (`vec3`) or WGSL (`vec3<f32>`); see
 * {@link UniformDeclaration.typeName} and `uniformTypeName()`.
 */
export type UniformType =
  | 'float'
  | 'int'
  | 'uint'
  | 'bool'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'mat2'
  | 'mat3'
  | 'mat4'
  | 'color'
  | 'texture'
  | 'sampler'
  | 'array'
  | 'struct'
  | 'unknown';

/**
 * Anything that can be stored in a uniform slot.
 *
 * The union is structural on purpose: a uniform value may be a plain number, a
 * math class (`Vec3`, `Mat4`, `Color`, ...), a typed array, a texture or a
 * sampler. Values branded with `isTexture`/`isSampler` are compared by identity
 * rather than by value.
 */
export type UniformValue =
  | number
  | boolean
  | null
  | readonly number[]
  | Float32Array
  | Float64Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array
  | { readonly x: number; readonly y: number }
  | { readonly x: number; readonly y: number; readonly z: number }
  | { readonly x: number; readonly y: number; readonly z: number; readonly w: number }
  | { readonly r: number; readonly g: number; readonly b: number; readonly a?: number }
  | { readonly elements: ArrayLike<number> }
  | { readonly isTexture: true }
  | { readonly isSampler: true };

/** A single uniform declaration, resolved down to a concrete language type. */
export interface UniformDeclaration {
  /** Uniform name as written in the shader source. */
  name: string;
  /** Semantic type of the value. */
  type: UniformType;
  /** Language-specific spelling, e.g. `vec3` (GLSL) or `vec3<f32>` (WGSL). */
  typeName: string;
  /** WGSL binding group; defaults to `0`. */
  group?: number;
  /** WGSL binding index; assigned in declaration order when omitted. */
  binding?: number;
  /** Number of elements when {@link type} is `'array'`. */
  count?: number;
  /** Element type when {@link type} is `'array'`. */
  elementType?: UniformType;
}

/** An explicit WGSL binding assignment. */
export interface ShaderBinding {
  /** Uniform name the binding refers to. */
  name: string;
  /** Binding group. */
  group: number;
  /** Binding index inside {@link group}. */
  binding: number;
  /** Semantic type of the bound resource. */
  type: UniformType;
}

/**
 * The declarative form of a uniform, as written in a `ShaderDescriptor`.
 *
 * A bare {@link UniformType} is shorthand for `{ type }`; the object form pins
 * the WGSL group/binding or describes an array. The resolved, language-specific
 * form is {@link UniformDeclaration}.
 */
export interface UniformSpec {
  /** Semantic type of the value. */
  type: UniformType;
  /** WGSL binding group; defaults to `0`. */
  group?: number;
  /** WGSL binding index; assigned in declaration order when omitted. */
  binding?: number;
  /** Number of elements when {@link type} is `'array'`. */
  count?: number;
  /** Element type when {@link type} is `'array'`. */
  elementType?: UniformType;
}

/**
 * A complete, language-agnostic program description.
 *
 * Descriptors are immutable plain data: the built-in library (`ShaderLib`) and
 * user code both produce them, and the compiler is the only thing that turns one
 * into a backend program.
 */
export interface ShaderDescriptor {
  /** Unique name, conventionally `'<language>/<family>'` for built-ins. */
  name: string;
  /** Language the sources are written in. */
  language: ShaderLanguage;
  /** Vertex-stage source. */
  vertex?: string;
  /** Fragment-stage source. */
  fragment?: string;
  /** Compute-stage source (mutually exclusive with vertex/fragment). */
  compute?: string;
  /** Preprocessor defines injected ahead of the source. */
  defines?: Readonly<Record<string, string | number | boolean>>;
  /**
   * Uniform declarations.
   *
   * A bare {@link UniformType} means "group `0`, binding assigned in declaration
   * order"; the {@link UniformSpec} form pins the group/binding explicitly or
   * describes an array.
   */
  uniforms?: Readonly<Record<string, UniformType | UniformSpec>>;
  /** Vertex attribute declarations, keyed by attribute name. */
  attributes?: Readonly<Record<string, string>>;
  /** Explicit WGSL bindings, used for reflection and validation. */
  bindings?: readonly ShaderBinding[];
  /** Entry-point names per stage; WGSL defaults to `vs_main`/`fs_main`. */
  entryPoints?: Partial<Record<ShaderStage, string>>;
}

/** A shader stage that has been compiled by a backend. */
export interface CompiledShader {
  /** Stage the source belongs to. */
  stage: ShaderStage;
  /** Backend handle (a `WebGLShader`, a `GPUShaderModule`, ...). */
  handle: unknown;
  /** Resolved source that was handed to the backend. */
  source: string;
}

/** A linked program plus the metadata needed to release it. */
export interface CompiledProgram {
  /** Cache key the program is stored under. */
  key: string;
  /** Name of the backend that produced the program. */
  backend: string;
  /** Descriptor the program was built from. */
  descriptor: ShaderDescriptor;
  /** Backend program handle (a `WebGLProgram`, a `GPURenderPipeline`, ...). */
  handle: unknown;
  /** Compiled stages, in pipeline order. */
  shaders: readonly CompiledShader[];
  /** Creation timestamp, from `performance.now()` when available. */
  created: number;
}

/**
 * The structural contract a rendering backend implements so
 * `ShaderCompiler` can compile and link programs for it.
 *
 * Every method receives already-resolved sources: chunk includes, defines and
 * version headers are handled by the compiler, so a backend only talks to its
 * native API.
 */
export interface ShaderBackend {
  /** Backend name; must match the name passed to `registerBackend`. */
  readonly name: string;
  /** Languages the backend accepts, e.g. `['glsl']` or `['wgsl']`. */
  readonly languages: readonly ShaderLanguage[];
  /**
   * Compiles one stage.
   *
   * @param stage Stage being compiled.
   * @param source Fully resolved source for the stage.
   * @param descriptor Descriptor the source came from, for diagnostics.
   * @returns A backend-specific shader handle.
   */
  compileShader(stage: ShaderStage, source: string, descriptor: ShaderDescriptor): unknown;
  /**
   * Links compiled stages into a program.
   *
   * @param compiled Stages in pipeline order.
   * @param descriptor Descriptor being linked.
   * @returns A backend-specific program handle.
   */
  linkProgram(compiled: readonly CompiledShader[], descriptor: ShaderDescriptor): unknown;
  /**
   * Releases a program and every stage it owns.
   *
   * @param program Program handle returned by {@link linkProgram}.
   */
  disposeProgram(program: CompiledProgram): void;
}

/** Counters reported by `ShaderCompiler.getStats()`. */
export interface ShaderStats {
  /** Programs compiled from scratch. */
  compiles: number;
  /** Stages compiled from scratch. */
  stageCompiles: number;
  /** Programs returned from the cache. */
  cacheHits: number;
  /** Compilations that had to run because the cache missed. */
  cacheMisses: number;
  /** Programs that failed to compile or link. */
  failures: number;
  /** Programs currently held in the cache. */
  programs: number;
  /** Programs released through `invalidate`/`releaseAll`. */
  released: number;
  /** Registered backend names. */
  backends: readonly string[];
}

/** Options accepted by `ShaderCompiler.compile()`. */
export interface ShaderCompileOptions {
  /** Backend to compile for; defaults to the first registered backend. */
  backend?: string;
  /** Extra defines merged over the descriptor's own. */
  defines?: Readonly<Record<string, string | number | boolean>>;
  /** Overrides the descriptor's language. */
  language?: ShaderLanguage;
  /** Resolve `#include`/`//!include` directives before compiling. Defaults to `true`. */
  resolveIncludes?: boolean;
  /** Reuse a cached program when possible. Defaults to `true`. */
  cache?: boolean;
  /** Force a recompile even when a cached program exists. */
  force?: boolean;
  /** Suffix appended to the cache key, for variant programs. */
  cacheKeySuffix?: string;
}
