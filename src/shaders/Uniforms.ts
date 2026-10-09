/**
 * `Uniforms` — a typed uniform container plus the type inference and
 * declaration-emission helpers the compiler and the backends share.
 *
 * ```ts
 * const uniforms = new Uniforms({ uModelViewMatrix: new Mat4(), uColor: new Color(1, 0, 0) });
 * uniforms.set('uOpacity', 0.5);
 * uniforms.getDeclaration('wgsl');
 * // @group(0) @binding(0) var<uniform> uModelViewMatrix: mat4x4<f32>;
 * // @group(0) @binding(1) var<uniform> uColor: vec3<f32>;
 * // @group(0) @binding(2) var<uniform> uOpacity: f32;
 * ```
 *
 * Design notes:
 *  - values are stored by reference; the container never clones a `Vec3` or a
 *    `Texture`, so uploading stays allocation-free. Mutating a stored vector in
 *    place is invisible to {@link Uniforms.version} — call {@link Uniforms.markDirty}
 *    for that, exactly like `Material.markNeedsUpdate()`;
 *  - {@link Uniforms.getDeclaration} emits GLSL and WGSL spellings from the same
 *    semantic type, so a descriptor only ever names a type once;
 *  - textures and samplers are compared by identity, every other value by value.
 *
 * @packageDocumentation
 */

import { deepEqual } from '../utils/ObjectUtils';
import type { ShaderLanguage, UniformDeclaration, UniformType, UniformValue } from './types';

/** A stored uniform: its inferred (or explicit) type plus the value. */
interface UniformEntry {
  /** Semantic type of the value. */
  type: UniformType;
  /** Current value. */
  value: UniformValue;
  /** Element count when {@link type} is `'array'`. */
  count?: number;
  /** Element type when {@link type} is `'array'`. */
  elementType?: UniformType;
  /** Explicit WGSL binding group. */
  group?: number;
  /** Explicit WGSL binding index. */
  binding?: number;
}

/** Extra options accepted by {@link Uniforms.set}. */
export interface UniformSetOptions {
  /** Overrides the inferred type. */
  type?: UniformType;
  /** Element type for explicit array declarations. */
  elementType?: UniformType;
  /** Element count for explicit array declarations; inferred from the value when omitted. */
  count?: number;
  /** Explicit WGSL binding group. */
  group?: number;
  /** Explicit WGSL binding index. */
  binding?: number;
}

/** Options accepted by {@link Uniforms.getDeclaration}. */
export interface UniformDeclarationOptions {
  /** First WGSL binding index; defaults to `0`. */
  bindingStart?: number;
  /** WGSL group applied to every declaration; defaults to `0`. */
  group?: number;
  /** Skip declarations whose value is `null`/`undefined`. Defaults to `false`. */
  skipEmpty?: boolean;
  /** Prefix each declaration with a comment naming the semantic type. */
  comments?: boolean;
}

/** `true` when `value` is branded as a texture. */
export function isTextureUniform(value: unknown): value is { readonly isTexture: true } {
  return typeof value === 'object' && value !== null && (value as { isTexture?: unknown }).isTexture === true;
}

/** `true` when `value` is branded as a sampler. */
export function isSamplerUniform(value: unknown): value is { readonly isSampler: true } {
  return typeof value === 'object' && value !== null && (value as { isSampler?: unknown }).isSampler === true;
}

/** `true` when `value` is a typed array or a plain array of numbers. */
function isNumericArray(value: unknown): value is ArrayLike<number> {
  if (ArrayBuffer.isView(value)) return !(value instanceof DataView);
  return Array.isArray(value) && value.every((item) => typeof item === 'number');
}

/** Declares the length/shape of a numeric array as a uniform type. */
function arrayUniformType(array: ArrayLike<number>): { type: UniformType; count?: number; elementType?: UniformType } {
  switch (array.length) {
    case 2:
      return { type: 'vec2' };
    case 3:
      return { type: 'vec3' };
    case 4:
      return { type: 'vec4' };
    case 9:
      return { type: 'mat3' };
    case 16:
      return { type: 'mat4' };
    default:
      return { type: 'array', count: array.length, elementType: 'float' };
  }
}

/** The GLSL and WGSL spelling of every semantic uniform type. */
const TYPE_NAMES: Readonly<Record<UniformType, readonly [glsl: string, wgsl: string]>> = {
  float: ['float', 'f32'],
  int: ['int', 'i32'],
  uint: ['uint', 'u32'],
  bool: ['bool', 'bool'],
  vec2: ['vec2', 'vec2<f32>'],
  vec3: ['vec3', 'vec3<f32>'],
  vec4: ['vec4', 'vec4<f32>'],
  mat2: ['mat2', 'mat2x2<f32>'],
  mat3: ['mat3', 'mat3x3<f32>'],
  mat4: ['mat4', 'mat4x4<f32>'],
  color: ['vec3', 'vec3<f32>'],
  texture: ['sampler2D', 'texture_2d<f32>'],
  sampler: ['sampler2D', 'sampler'],
  array: ['float', 'f32'],
  struct: ['float', 'f32'],
  unknown: ['float', 'f32'],
};

/**
 * Renders a semantic uniform type in a concrete language.
 *
 * @param type Semantic type, as returned by {@link inferUniformType}.
 * @param language Target language spelling.
 * @returns The language-specific type name (`'vec3'` / `'vec3<f32>'`).
 */
export function uniformTypeName(type: UniformType, language: ShaderLanguage): string {
  const names = TYPE_NAMES[type] ?? TYPE_NAMES.unknown;
  return language === 'wgsl' ? names[1] : names[0];
}

/**
 * Infers the semantic uniform type of a runtime value.
 *
 * The rules are structural, so the container works with plain objects as well as
 * with the library's math classes:
 *
 * | Input | Inferred type |
 * | --- | --- |
 * | `number` / `boolean` | `'float'` / `'bool'` |
 * | `{ x, y }` … `{ x, y, z, w }` | `'vec2'` … `'vec4'` |
 * | `{ r, g, b }` | `'color'` |
 * | `{ elements }` of length 4/9/16 | `'mat2'` / `'mat3'` / `'mat4'` |
 * | numeric array of length 2/3/4/9/16 | vector/matrix, otherwise `'array'` |
 * | `{ isTexture: true }` | `'texture'` |
 * | `{ isSampler: true }` | `'sampler'` |
 * | anything else | `'unknown'` |
 *
 * @param value Value to inspect.
 * @returns The inferred semantic type.
 */
export function inferUniformType(value: unknown): UniformType {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return 'float';
  if (typeof value !== 'object') return 'unknown';

  if (isTextureUniform(value)) return 'texture';
  if (isSamplerUniform(value)) return 'sampler';

  const candidate = value as {
    elements?: ArrayLike<number>;
    r?: unknown;
    g?: unknown;
    b?: unknown;
    x?: unknown;
    y?: unknown;
    z?: unknown;
    w?: unknown;
  };

  if (candidate.elements && typeof candidate.elements.length === 'number') {
    switch (candidate.elements.length) {
      case 4:
        return 'mat2';
      case 9:
        return 'mat3';
      case 16:
        return 'mat4';
      default:
        return 'array';
    }
  }

  if (typeof candidate.r === 'number' && typeof candidate.g === 'number' && typeof candidate.b === 'number') {
    return 'color';
  }

  if (typeof candidate.x === 'number' && typeof candidate.y === 'number') {
    if (typeof candidate.z === 'number') {
      return typeof candidate.w === 'number' ? 'vec4' : 'vec3';
    }
    return 'vec2';
  }

  if (isNumericArray(value)) return arrayUniformType(value).type;

  if (Array.isArray(value)) {
    // A nested array is a uniform array of whatever the first element is.
    return value.length > 0 ? 'array' : 'unknown';
  }

  if (ArrayBuffer.isView(value)) return 'unknown';

  return 'struct';
}

/** Value equality used by {@link Uniforms.equals}: numbers by value, resources by identity. */
function uniformValueEquals(a: UniformValue, b: UniformValue): boolean {
  if (a === b) return true;
  const aResource = isTextureUniform(a) || isSamplerUniform(a);
  const bResource = isTextureUniform(b) || isSamplerUniform(b);
  if (aResource || bResource) return false;
  return deepEqual(normalizeUniformValue(a), normalizeUniformValue(b));
}

/** Converts a value into plain numbers/arrays so `deepEqual` compares meaningfully. */
function normalizeUniformValue(value: UniformValue): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (isTextureUniform(value) || isSamplerUniform(value)) return value;
  if (ArrayBuffer.isView(value) || Array.isArray(value)) return Array.from(value as ArrayLike<number>);

  const candidate = value as {
    elements?: ArrayLike<number>;
    r?: unknown;
    g?: unknown;
    b?: unknown;
    a?: unknown;
    x?: unknown;
    y?: unknown;
    z?: unknown;
    w?: unknown;
  };

  if (candidate.elements) return Array.from(candidate.elements);
  if (typeof candidate.r === 'number') {
    return [candidate.r, candidate.g, candidate.b, typeof candidate.a === 'number' ? candidate.a : 1];
  }
  if (typeof candidate.x === 'number') {
    const out = [candidate.x, candidate.y];
    if (typeof candidate.z === 'number') out.push(candidate.z);
    if (typeof candidate.w === 'number') out.push(candidate.w);
    return out;
  }
  return value;
}

/**
 * An ordered, typed uniform container.
 *
 * Insertion order defines the WGSL binding order, so a program compiled twice
 * from the same descriptor gets an identical layout.
 */
export class Uniforms {
  /** Stored values, in declaration order. */
  private readonly entries = new Map<string, UniformEntry>();

  /** Names whose value changed since the last {@link consumeDirty}. */
  private readonly dirty = new Set<string>();

  /** Monotonic revision, bumped by every mutation. */
  private revision = 0;

  /**
   * @param initial Optional values to seed the container with.
   */
  constructor(initial?: Readonly<Record<string, UniformValue>>) {
    if (initial) {
      for (const [name, value] of Object.entries(initial)) this.set(name, value);
    }
  }

  /* ---------------------------------------------------------------- queries */

  /** Number of stored uniforms. */
  public get size(): number {
    return this.entries.size;
  }

  /** Monotonic revision; bumped by {@link set}, {@link delete} and {@link markDirty}. */
  public get version(): number {
    return this.revision;
  }

  /** `true` while at least one uniform is marked dirty. */
  public get isDirty(): boolean {
    return this.dirty.size > 0;
  }

  /** Every uniform name, in declaration order. */
  public keys(): string[] {
    return Array.from(this.entries.keys());
  }

  /** `true` when `name` has a value. */
  public has(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * Reads a uniform.
   *
   * @param name Uniform name.
   * @returns The stored value, or `undefined` when absent.
   */
  public get<T extends UniformValue = UniformValue>(name: string): T | undefined {
    return this.entries.get(name)?.value as T | undefined;
  }

  /**
   * Reads a uniform and throws when it is missing.
   *
   * @param name Uniform name.
   * @throws Error when the uniform has not been set.
   */
  public require(name: string): UniformValue {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Uniform "${name}" has not been set`);
    return entry.value;
  }

  /** The semantic type recorded for `name`, or `undefined` when absent. */
  public typeOf(name: string): UniformType | undefined {
    return this.entries.get(name)?.type;
  }

  /* ------------------------------------------------------------- mutation */

  /**
   * Stores a value, inferring its type unless one is supplied.
   *
   * @param name Uniform name.
   * @param value New value.
   * @param options Optional explicit type/binding overrides.
   * @returns This container, for chaining.
   */
  public set(name: string, value: UniformValue, options: UniformSetOptions = {}): this {
    if (name.length === 0) throw new Error('Uniforms.set() requires a non-empty name');

    const shape = Array.isArray(value) || ArrayBuffer.isView(value) ? arrayUniformType(value as ArrayLike<number>) : undefined;
    const type = options.type ?? inferUniformType(value);
    const existing = this.entries.get(name);

    this.entries.set(name, {
      type,
      value,
      count:
        type === 'array'
          ? (options.count ?? shape?.count ?? (Array.isArray(value) ? value.length : undefined))
          : undefined,
      elementType: type === 'array' ? (options.elementType ?? shape?.elementType ?? 'float') : undefined,
      group: options.group ?? existing?.group,
      binding: options.binding ?? existing?.binding,
    });

    this.dirty.add(name);
    this.revision++;
    return this;
  }

  /** Removes a uniform. Returns `true` when something was removed. */
  public delete(name: string): boolean {
    if (!this.entries.delete(name)) return false;
    this.dirty.delete(name);
    this.revision++;
    return true;
  }

  /** Removes every uniform. */
  public clear(): this {
    if (this.entries.size > 0) {
      this.entries.clear();
      this.dirty.clear();
      this.revision++;
    }
    return this;
  }

  /**
   * Marks a uniform — or the whole container — dirty.
   *
   * Use this after mutating a stored vector or matrix in place, which cannot be
   * observed by the container without a Proxy on the hot path.
   */
  public markDirty(name?: string): this {
    if (name === undefined) {
      for (const key of this.entries.keys()) this.dirty.add(key);
    } else {
      this.dirty.add(name);
    }
    this.revision++;
    return this;
  }

  /** Returns (and clears) the set of names changed since the previous call. */
  public consumeDirty(): string[] {
    const names = Array.from(this.dirty);
    this.dirty.clear();
    return names;
  }

  /* ---------------------------------------------------------- declarations */

  /**
   * Resolves every uniform into a language-specific declaration.
   *
   * @param language Target language.
   * @param options Binding assignment options.
   * @returns One declaration per uniform, in insertion order.
   */
  public getDeclarations(language: ShaderLanguage, options: UniformDeclarationOptions = {}): UniformDeclaration[] {
    const bindingStart = options.bindingStart ?? 0;
    const defaultGroup = options.group ?? 0;
    const declarations: UniformDeclaration[] = [];
    let binding = bindingStart;

    for (const [name, entry] of this.entries) {
      if (options.skipEmpty && (entry.value === null || entry.value === undefined)) continue;
      // For arrays `typeName` holds the *element* spelling; `declare` adds the
      // `[count]` / `array<T, N>` wrapper, which differs per language.
      const typeName = uniformTypeName(
        entry.type === 'array' ? (entry.elementType ?? 'float') : entry.type,
        language,
      );
      declarations.push({
        name,
        type: entry.type,
        typeName,
        group: entry.group ?? defaultGroup,
        binding: entry.binding ?? binding,
        count: entry.count,
        elementType: entry.elementType,
      });
      binding++;
    }
    return declarations;
  }

  /**
   * Emits a single uniform declaration.
   *
   * @param declaration Declaration to render; for arrays {@link UniformDeclaration.typeName}
   *   is the element spelling and `count` supplies the length.
   * @param language Target language.
   * @returns `uniform mat4 uModelViewMatrix;` or
   *   `@group(0) @binding(0) var<uniform> uModelViewMatrix: mat4x4<f32>;`.
   */
  public static declare(declaration: UniformDeclaration, language: ShaderLanguage): string {
    const group = declaration.group ?? 0;
    const binding = declaration.binding ?? 0;

    if (language === 'wgsl') {
      const wgslType =
        declaration.type === 'array'
          ? `array<${declaration.typeName}, ${Math.max(1, declaration.count ?? 1)}>`
          : declaration.typeName;
      const addressSpace = declaration.type === 'texture' || declaration.type === 'sampler' ? '' : '<uniform>';
      return `@group(${group}) @binding(${binding}) var${addressSpace} ${declaration.name}: ${wgslType};`;
    }

    if (declaration.type === 'array') {
      return `uniform ${declaration.typeName} ${declaration.name}[${Math.max(1, declaration.count ?? 1)}];`;
    }
    return `uniform ${declaration.typeName} ${declaration.name};`;
  }

  /**
   * Emits every declaration as source text.
   *
   * @param language Target language.
   * @param options Binding assignment and formatting options.
   * @returns Newline-separated declarations, or `''` when there are none.
   */
  public getDeclaration(language: ShaderLanguage, options: UniformDeclarationOptions = {}): string {
    const declarations = this.getDeclarations(language, options);
    if (declarations.length === 0) return '';
    const lines = declarations.map((declaration) => {
      const text = Uniforms.declare(declaration, language);
      return options.comments ? `${text} // ${declaration.type}` : text;
    });
    return lines.join('\n');
  }

  /** Renders one uniform's declaration by name, or `''` when it is not set. */
  public declareOne(name: string, language: ShaderLanguage, options: UniformDeclarationOptions = {}): string {
    const declaration = this.getDeclarations(language, options).find((item) => item.name === name);
    return declaration ? Uniforms.declare(declaration, language) : '';
  }

  /* --------------------------------------------------------------- copying */

  /** Value equality: names, types and values (resources compare by identity). */
  public equals(other: Uniforms | null | undefined): boolean {
    if (other == null) return false;
    if (other === this) return true;
    if (other.entries.size !== this.entries.size) return false;
    for (const [name, entry] of this.entries) {
      const otherEntry = other.entries.get(name);
      if (!otherEntry) return false;
      if (otherEntry.type !== entry.type) return false;
      if (!uniformValueEquals(entry.value, otherEntry.value)) return false;
    }
    return true;
  }

  /** Independent copy of the container; values are shared by reference. */
  public clone(): Uniforms {
    const copy = new Uniforms();
    for (const [name, entry] of this.entries) {
      copy.entries.set(name, { ...entry });
    }
    copy.revision = this.revision;
    return copy;
  }

  /** Copies every entry of `source` into this container. */
  public copy(source: Uniforms): this {
    this.entries.clear();
    this.dirty.clear();
    for (const [name, entry] of source.entries) {
      this.entries.set(name, { ...entry });
    }
    this.revision++;
    return this;
  }

  /**
   * Serialises the container.
   *
   * Math objects are flattened to arrays and textures/samplers to a `{ resource }`
   * marker, so the result survives `JSON.stringify`.
   */
  public toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, entry] of this.entries) {
      out[name] = { type: entry.type, value: normalizeUniformValue(entry.value) };
    }
    return out;
  }

  /** Every entry as a `[name, value]` pair, in declaration order. */
  public toEntries(): [string, UniformValue][] {
    return Array.from(this.entries, ([name, entry]) => [name, entry.value] as [string, UniformValue]);
  }
}
