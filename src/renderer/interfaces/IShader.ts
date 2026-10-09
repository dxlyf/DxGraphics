/**
 * Shader contract.
 *
 * Only the GPU backends compile real shader source. The Canvas2D backend
 * implements a documented *emulation* (`Canvas2DShader`) whose `compile` rejects
 * GLSL/WGSL and whose "programs" are per-pixel JavaScript kernels.
 *
 * @packageDocumentation
 */

/** Shader pipeline stages. */
export enum ShaderStage {
  Vertex = 'vertex',
  Fragment = 'fragment',
  Compute = 'compute',
}

/** Value kinds a uniform or attribute may hold. */
export enum ShaderValueType {
  Float = 'float',
  Vec2 = 'vec2',
  Vec3 = 'vec3',
  Vec4 = 'vec4',
  Int = 'int',
  IVec2 = 'ivec2',
  IVec3 = 'ivec3',
  IVec4 = 'ivec4',
  Mat2 = 'mat2',
  Mat3 = 'mat3',
  Mat4 = 'mat4',
  Bool = 'bool',
  Sampler2D = 'sampler2d',
  SamplerCube = 'sampler-cube',
}

/** Reflected description of one shader interface member. */
export interface ShaderMember {
  /** Name as written in the shader source. */
  name: string;
  /** Value kind. */
  type: ShaderValueType;
  /** Explicit location, when the source pinned one. */
  location?: number;
  /** Array length for array members; `1` for scalars. */
  arrayLength?: number;
  /** Uniform binding group, for WebGPU-style sources. */
  group?: number;
}

/** Result of a successful compilation. */
export interface ShaderCompileResult {
  /** `true` when compilation succeeded. */
  readonly success: boolean;
  /** Reflected attributes, when the backend reflects them. */
  readonly attributes: readonly ShaderMember[];
  /** Reflected uniforms, when the backend reflects them. */
  readonly uniforms: readonly ShaderMember[];
  /** Backend diagnostics (warnings and, on failure, the error log). */
  readonly log: string;
}

/** Uniform values accepted by {@link IShader.setUniform}. */
export type UniformValue =
  | number
  | boolean
  | Float32Array
  | Int32Array
  | Uint32Array
  | ArrayLike<number>
  | unknown;

/** Common contract implemented by every shader-backend program. */
export interface IShader {
  /** Stable identifier used in cache keys and diagnostics. */
  readonly id: string;

  /** Backend that produced the program (`'webgl2'`, `'canvas2d'`, ...). */
  readonly backend: string;

  /** Vertex source, when the backend has one. */
  readonly vertexSource: string | null;

  /** Fragment source, when the backend has one. */
  readonly fragmentSource: string | null;

  /** `true` once {@link compile} has succeeded. */
  readonly isCompiled: boolean;

  /** `true` when the program has been released. */
  readonly isDisposed: boolean;

  /** Reflected attribute list; empty before compilation. */
  readonly attributes: readonly ShaderMember[];

  /** Reflected uniform list; empty before compilation. */
  readonly uniforms: readonly ShaderMember[];

  /**
   * Compiles/links the program and reflects its interface members.
   *
   * @param vertexSource Vertex source, or `null` for backends without stages.
   * @param fragmentSource Fragment/pixel source.
   * @returns A {@link ShaderCompileResult} describing the outcome.
   */
  compile(vertexSource: string | null, fragmentSource: string): ShaderCompileResult;

  /**
   * Makes the program current so that subsequent draws use it.
   *
   * @returns `true` when the program is usable.
   */
  use(): boolean;

  /**
   * Assigns a uniform value.
   *
   * Unknown names are ignored and logged once; this keeps a shared material
   * usable across backends that support different uniform sets.
   *
   * @param name Uniform name.
   * @param value Value to assign.
   */
  setUniform(name: string, value: UniformValue): void;

  /**
   * Assigns every entry of a uniform bag.
   *
   * @param values Name → value map.
   */
  setUniforms(values: Readonly<Record<string, UniformValue>>): void;

  /**
   * Returns the location/handle the backend assigned to an attribute.
   *
   * @param name Attribute name.
   * @returns The location, or `-1` when the attribute is not active.
   */
  getAttributeLocation(name: string): number;

  /**
   * Returns the location/handle the backend assigned to a uniform.
   *
   * @param name Uniform name.
   * @returns The location, or `null` when the uniform is not active.
   */
  getUniformLocation(name: string): unknown;

  /** Releases the program and its reflection data. */
  dispose(): void;
}

/** `true` when `value` satisfies the minimum {@link IShader} shape. */
export function isShader(value: unknown): value is IShader {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<IShader>;
  return typeof candidate.compile === 'function' && typeof candidate.dispose === 'function';
}
