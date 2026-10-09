/**
 * Uniform reflection and upload.
 *
 * Reflection walks a linked program once and records, for every active uniform,
 * the GL type, the array length and the location, so `setUniform` never calls
 * `gl.getUniformLocation` in the hot path.
 *
 * ## Why the value kind is `ShaderValueType`
 *
 * The renderer-agnostic equivalent of a "uniform type" already exists: the
 * {@link ShaderValueType} enumeration in `renderer/interfaces/IShader.ts`, which
 * the material and shader layers also speak. Using it here means a material's
 * uniform bag needs no translation at the backend boundary.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import { ShaderValueType, type UniformValue } from '../interfaces/IShader';
import { glConst, type GL } from './WebGLUtils';

/** Logger for uniform diagnostics. */
const log = createLogger('renderer:webgl:uniforms');

/* -------------------------------------------------------------------------- */
/* Reflection                                                                 */
/* -------------------------------------------------------------------------- */

/** Reflected description of one active uniform. */
export interface WebGLUniformInfo {
  /** Name exactly as the driver reports it (arrays keep their `[0]` suffix). */
  readonly name: string;
  /** Name with a trailing `[0]` removed, for convenient lookup. */
  readonly baseName: string;
  /** Value kind, mapped from the GL type. */
  readonly type: ShaderValueType;
  /** Number of elements (array length; `1` for scalars). */
  readonly size: number;
  /** Alias of {@link WebGLUniformInfo.size}. */
  readonly arrayLength: number;
  /** `true` when the uniform is an array. */
  readonly isArray: boolean;
  /** Location, or `null` for uniforms the driver optimised away. */
  readonly location: WebGLUniformLocation | null;
}

/**
 * Maps a raw `gl.*` uniform type onto {@link ShaderValueType}.
 *
 * @param gl Context supplying the enumeration values.
 * @param glType Value of `WebGLActiveInfo.type`.
 * @returns The matching value kind, or `null` for types the library does not model.
 */
export function mapGLShaderValueType(gl: GL, glType: number): ShaderValueType | null {
  const table: readonly (readonly [ShaderValueType, string, number])[] = [
    [ShaderValueType.Float, 'FLOAT', 0x1406],
    [ShaderValueType.Vec2, 'FLOAT_VEC2', 0x8b50],
    [ShaderValueType.Vec3, 'FLOAT_VEC3', 0x8b51],
    [ShaderValueType.Vec4, 'FLOAT_VEC4', 0x8b52],
    [ShaderValueType.Int, 'INT', 0x1404],
    [ShaderValueType.IVec2, 'INT_VEC2', 0x8b53],
    [ShaderValueType.IVec3, 'INT_VEC3', 0x8b54],
    [ShaderValueType.IVec4, 'INT_VEC4', 0x8b55],
    [ShaderValueType.Bool, 'BOOL', 0x8b56],
    [ShaderValueType.Mat2, 'FLOAT_MAT2', 0x8b5a],
    [ShaderValueType.Mat3, 'FLOAT_MAT3', 0x8b5b],
    [ShaderValueType.Mat4, 'FLOAT_MAT4', 0x8b5c],
    [ShaderValueType.Sampler2D, 'SAMPLER_2D', 0x8b5e],
    [ShaderValueType.SamplerCube, 'SAMPLER_CUBE', 0x8b60],
  ];

  for (const [kind, name, fallback] of table) {
    if (glConst(gl, name, fallback) === glType) return kind;
  }

  // Unsigned integers and the extra sampler shapes collapse onto the closest
  // modelled kind rather than being dropped, so a material can still bind them.
  const unsignedInt = glConst(gl, 'UNSIGNED_INT', 0x1405);
  if (glType === unsignedInt) return ShaderValueType.Int;
  const sampler3D = glConst(gl, 'SAMPLER_3D', 0x8b5f);
  const sampler2DShadow = glConst(gl, 'SAMPLER_2D_SHADOW', 0x8b62);
  const sampler2DArray = glConst(gl, 'SAMPLER_2D_ARRAY', 0x8dc1);
  if (glType === sampler3D || glType === sampler2DShadow || glType === sampler2DArray) {
    return ShaderValueType.Sampler2D;
  }

  return null;
}

/**
 * Reflects the active uniforms of a linked program.
 *
 * @param gl Context the program belongs to.
 * @param program Linked program handle.
 * @returns One entry per active uniform, in driver order.
 */
export function reflectUniforms(gl: GL, program: WebGLProgram): WebGLUniformInfo[] {
  const count = readActiveCount(gl, program, 'ACTIVE_UNIFORMS', 0x8b86);
  const infos: WebGLUniformInfo[] = [];

  for (let i = 0; i < count; i++) {
    const active = gl.getActiveUniform(program, i);
    if (active == null) continue;

    const type = mapGLShaderValueType(gl, active.type);
    if (type === null) {
      log.debug(`uniform '${active.name}' has an unsupported GL type ${active.type}; it is ignored`);
      continue;
    }

    const size = Math.max(1, active.size);
    infos.push({
      name: active.name,
      baseName: stripArraySuffix(active.name),
      type,
      size,
      arrayLength: size,
      isArray: size > 1 || active.name.endsWith('[0]'),
      location: gl.getUniformLocation(program, active.name),
    });
  }

  return infos;
}

/** Reads `ACTIVE_UNIFORMS`/`ACTIVE_ATTRIBUTES` defensively. */
export function readActiveCount(gl: GL, program: WebGLProgram, name: string, fallback: number): number {
  try {
    const value = gl.getProgramParameter(program, glConst(gl, name, fallback));
    return typeof value === 'number' && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Removes the `[0]` suffix the driver appends to array uniforms. */
export function stripArraySuffix(name: string): string {
  return name.endsWith('[0]') ? name.slice(0, -3) : name;
}

/* -------------------------------------------------------------------------- */
/* WebGLUniforms                                                              */
/* -------------------------------------------------------------------------- */

/** Scratch buffer reused by every vector upload. */
const SCRATCH = new Float32Array(16);

/**
 * Owner of a program's uniform table.
 *
 * Every setter diffs nothing (uniforms are cheap to write and the driver performs
 * no validation that depends on the previous value), but every setter *does* skip
 * work when the name is not active, which is what keeps a shared material usable
 * across backends with different uniform sets.
 */
export class WebGLUniforms {
  /** Context the uniforms are uploaded through. */
  private readonly gl: GL;

  /** Reflected uniforms, keyed by both `name` and `name[0]`-stripped `baseName`. */
  private readonly byName: Map<string, WebGLUniformInfo> = new Map();

  /** Reflection order, preserved for diagnostics. */
  private readonly ordered: WebGLUniformInfo[] = [];

  /** Names already reported as missing, so each is logged once. */
  private readonly reported: Set<string> = new Set();

  /**
   * Creates a uniform table.
   *
   * @param gl Context to upload through.
   * @param infos Reflected uniforms; defaults to none.
   */
  constructor(gl: GL, infos: readonly WebGLUniformInfo[] = []) {
    this.gl = gl;
    for (const info of infos) this.add(info);
  }

  /**
   * Replaces the reflected table.
   *
   * @param infos Newly reflected uniforms.
   * @returns This instance, for chaining.
   */
  public reset(infos: readonly WebGLUniformInfo[] = []): this {
    this.byName.clear();
    this.ordered.length = 0;
    this.reported.clear();
    for (const info of infos) this.add(info);
    return this;
  }

  /** Number of active uniforms. */
  public get size(): number {
    return this.ordered.length;
  }

  /** Active uniform names, in reflection order. */
  public get names(): readonly string[] {
    return this.ordered.map((info) => info.name);
  }

  /**
   * Looks a uniform up.
   *
   * @param name Uniform name, with or without a trailing `[0]`.
   * @returns The reflection entry, or `undefined`.
   */
  public get(name: string): WebGLUniformInfo | undefined {
    return this.byName.get(name) ?? this.byName.get(stripArraySuffix(name));
  }

  /**
   * Reports whether a uniform is active.
   *
   * @param name Uniform name.
   */
  public has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** @returns The full reflection list. */
  public getActiveUniforms(): readonly WebGLUniformInfo[] {
    return this.ordered;
  }

  /**
   * Assigns a uniform by name.
   *
   * @param name Uniform name.
   * @param value Value to upload.
   * @returns `true` when the uniform exists and was written.
   */
  public set(name: string, value: UniformValue): boolean {
    const info = this.get(name);
    if (info === undefined) {
      if (!this.reported.has(name)) {
        this.reported.add(name);
        log.debug(`uniform '${name}' is not active in this program; the assignment is ignored`);
      }
      return false;
    }
    return this.setValue(info, value);
  }

  /**
   * Assigns every entry of a uniform bag.
   *
   * @param values Name → value map.
   * @returns The number of uniforms actually written.
   */
  public setUniforms(values: Readonly<Record<string, UniformValue>>): number {
    let written = 0;
    for (const name of Object.keys(values)) {
      if (this.set(name, values[name])) written++;
    }
    return written;
  }

  /**
   * Uploads one reflected uniform.
   *
   * @param info Reflection entry.
   * @param value Value to upload.
   * @returns `true` when something was written.
   */
  public setValue(info: WebGLUniformInfo, value: UniformValue): boolean {
    const location = info.location;
    if (location === null || location === undefined) return false;
    if (value === null || value === undefined) return false;

    const gl = this.gl;

    switch (info.type) {
      case ShaderValueType.Float:
        if (isArrayLike(value)) {
          gl.uniform1fv(location, toFloatArray(value, 1));
        } else {
          gl.uniform1f(location, toNumber(value));
        }
        return true;

      case ShaderValueType.Vec2:
        if (isArrayLike(value)) {
          gl.uniform2fv(location, toFloatArray(value, 2));
        } else {
          gl.uniform2f(location, component(value, 'x', 0), component(value, 'y', 1));
        }
        return true;

      case ShaderValueType.Vec3:
        if (isArrayLike(value)) {
          gl.uniform3fv(location, toFloatArray(value, 3));
        } else {
          gl.uniform3f(location, component(value, 'x', 0), component(value, 'y', 1), component(value, 'z', 2));
        }
        return true;

      case ShaderValueType.Vec4:
        if (isArrayLike(value)) {
          gl.uniform4fv(location, toFloatArray(value, 4));
        } else {
          gl.uniform4f(
            location,
            component(value, 'x', 0, 'r'),
            component(value, 'y', 1, 'g'),
            component(value, 'z', 2, 'b'),
            component(value, 'w', 3, 'a', 1),
          );
        }
        return true;

      case ShaderValueType.Int:
        if (isArrayLike(value)) {
          gl.uniform1iv(location, toIntArray(value, 1));
        } else {
          gl.uniform1i(location, Math.trunc(toNumber(value)));
        }
        return true;

      case ShaderValueType.IVec2:
        if (isArrayLike(value)) {
          gl.uniform2iv(location, toIntArray(value, 2));
        } else {
          gl.uniform2i(location, component(value, 'x', 0), component(value, 'y', 1));
        }
        return true;

      case ShaderValueType.IVec3:
        if (isArrayLike(value)) {
          gl.uniform3iv(location, toIntArray(value, 3));
        } else {
          gl.uniform3i(location, component(value, 'x', 0), component(value, 'y', 1), component(value, 'z', 2));
        }
        return true;

      case ShaderValueType.IVec4:
        if (isArrayLike(value)) {
          gl.uniform4iv(location, toIntArray(value, 4));
        } else {
          gl.uniform4i(
            location,
            component(value, 'x', 0, 'r'),
            component(value, 'y', 1, 'g'),
            component(value, 'z', 2, 'b'),
            component(value, 'w', 3, 'a', 1),
          );
        }
        return true;

      case ShaderValueType.Bool:
        gl.uniform1i(location, toBoolean(value) ? 1 : 0);
        return true;

      case ShaderValueType.Mat2:
        // Matrices are column-major in this library, which is also GLSL's own
        // convention, so `transpose` is always `false`.
        gl.uniformMatrix2fv(location, false, toFloatArray(value, 4));
        return true;

      case ShaderValueType.Mat3:
        gl.uniformMatrix3fv(location, false, toFloatArray(value, 9));
        return true;

      case ShaderValueType.Mat4:
        gl.uniformMatrix4fv(location, false, toFloatArray(value, 16));
        return true;

      case ShaderValueType.Sampler2D:
      case ShaderValueType.SamplerCube:
        gl.uniform1i(location, toTextureUnit(value));
        return true;

      default:
        return false;
    }
  }

  /** Registers one reflection entry. */
  private add(info: WebGLUniformInfo): void {
    this.ordered.push(info);
    this.byName.set(info.name, info);
    if (info.baseName !== info.name) this.byName.set(info.baseName, info);
  }
}

/* -------------------------------------------------------------------------- */
/* Value coercion                                                             */
/* -------------------------------------------------------------------------- */

/** `true` when the value can be read as a numeric sequence. */
export function isArrayLike(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return true;
  if (ArrayBuffer.isView(value)) return true;
  if (typeof value === 'object' && typeof (value as ArrayLike<number>).length === 'number') {
    return true;
  }
  // A `Vec4`/`Mat4`-style object exposes `elements`; treat it as a sequence.
  return (
    typeof value === 'object' &&
    (value as { elements?: unknown }).elements != null &&
    typeof ((value as { elements: ArrayLike<number> }).elements as ArrayLike<number>).length === 'number'
  );
}

/** Number of elements a value sequence exposes. */
function lengthOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (ArrayBuffer.isView(value)) return (value as unknown as ArrayLike<number>).length;
  if (value != null && typeof value === 'object') {
    const withElements = value as { elements?: ArrayLike<number>; length?: number };
    if (withElements.elements != null) return withElements.elements.length;
    if (typeof withElements.length === 'number') return withElements.length;
  }
  return 0;
}

/** Reads element `index` of a value sequence. */
function elementAt(value: unknown, index: number): number {
  if (Array.isArray(value)) return Number(value[index]) || 0;
  if (ArrayBuffer.isView(value)) return Number((value as unknown as ArrayLike<number>)[index]) || 0;
  if (value != null && typeof value === 'object') {
    const withElements = value as { elements?: ArrayLike<number>; length?: number };
    if (withElements.elements != null) return Number(withElements.elements[index]) || 0;
    if (typeof withElements.length === 'number') {
      return Number((value as unknown as ArrayLike<number>)[index]) || 0;
    }
  }
  return 0;
}

/** Coerces a value into a `Float32Array` of at least `minimumLength` elements. */
function toFloatArray(value: unknown, minimumLength: number): Float32Array {
  const length = Math.max(minimumLength, lengthOf(value));
  const out = length <= SCRATCH.length ? SCRATCH.subarray(0, length) : new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = elementAt(value, i);
  return out;
}

/** Coerces a value into an `Int32Array` of at least `minimumLength` elements. */
function toIntArray(value: unknown, minimumLength: number): Int32Array {
  if (value instanceof Int32Array && value.length >= minimumLength) return value;
  const length = Math.max(minimumLength, lengthOf(value));
  const out = new Int32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.trunc(elementAt(value, i));
  return out;
}

/** Coerces a value into a number. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

/** Coerces a value into a boolean, honouring numbers and `{ x: 1 }`-style wiggle. */
function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (value != null && typeof value === 'object') {
    const x = (value as { x?: unknown }).x;
    if (typeof x === 'number') return x !== 0;
  }
  return Boolean(value);
}

/**
 * Reads a component from an object or tuple value.
 *
 * Falls back through the supplied names in order, so a `Vec4`, a `Color` and a
 * plain `{ r, g, b }` all resolve without the caller converting anything.
 */
function component(value: unknown, primary: string, index: number, secondary?: string, fallback?: number): number {
  if (typeof value === 'number') return value;
  if (value != null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const first = record[primary];
    if (typeof first === 'number') return first;
    if (secondary !== undefined) {
      const second = record[secondary];
      if (typeof second === 'number') return second;
    }
    const indexed = (value as ArrayLike<number>)[index];
    if (typeof indexed === 'number') return indexed;
  }
  return fallback ?? 0;
}

/**
 * Resolves a sampler value into a texture unit index.
 *
 * Accepts a plain number (already a unit), a `{ unit }`/`{ textureUnit }` object, or
 * anything with a numeric `textureUnit` property — the shape a texture-layer sampler
 * binding exposes.
 *
 * @param value Sampler value.
 * @returns The texture unit to sample from.
 */
export function toTextureUnit(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (value != null && typeof value === 'object') {
    const record = value as { unit?: unknown; textureUnit?: unknown; texture?: { unit?: unknown } };
    if (typeof record.unit === 'number') return Math.max(0, Math.trunc(record.unit));
    if (typeof record.textureUnit === 'number') return Math.max(0, Math.trunc(record.textureUnit));
    if (record.texture != null && typeof record.texture.unit === 'number') {
      return Math.max(0, Math.trunc(record.texture.unit));
    }
  }
  return 0;
}
