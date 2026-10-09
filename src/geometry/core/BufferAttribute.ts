/**
 * `BufferAttribute` 鈥?a typed, named view over a chunk of vertex data.
 *
 * ## Memory layout
 *
 * An attribute is a flat typed array interpreted as a sequence of `count`
 * elements, each made of `itemSize` consecutive components. Element `i` occupies
 * the slots `[i * itemSize, i * itemSize + itemSize)`:
 *
 * ```text
 * position, itemSize = 3, count = 3
 * index :  0   1   2   3   4   5   6   7   8
 * value : x0  y0  z0  x1  y1  z1  x2  y2  z2
 *         鈹斺攢 element 0 鈹€鈹樷敂鈹€ element 1 鈹€鈹樷敂鈹€ element 2 鈹€鈹? * ```
 *
 * There is **no padding**: a plain attribute is tightly packed. Attributes that
 * share a buffer must go through `InterleavedBufferAttribute`, which adds the
 * `stride`/`offset` pair needed to describe a column of a wider layout.
 *
 * The API is deliberately allocation-light: `getX(i)`/`setXYZ(i, x, y, z)` do one
 * multiply, one add and one indexed read or write, so a per-vertex loop never
 * touches the allocator.
 *
 * ## Change tracking
 *
 * Every mutation bumps {@link BufferAttribute.version}. Backends cache the
 * version they last uploaded and re-upload when it differs. `needsUpdate` is a
 * thin convenience layer over the same counter: reading it reports whether the
 * attribute has been touched since a consumer last acknowledged it by assigning
 * `false`.
 *
 * @packageDocumentation
 */

import { Disposable } from '../../core/Disposable';
import type { TypedArray, TypedArrayConstructor } from '../../types';
import { getTypedArrayConstructor } from '../../utils/TypedArrayUtils';
import type { AttributeJSON, AttributeUsage, TransformTarget } from './types';

/* -------------------------------------------------------------------------- */
/* Structural matrix views                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Minimal structural 4x4 matrix, `{ elements: ArrayLike<number> }` in
 * column-major order.
 *
 * Declared structurally so this module needs no dependency on `Mat4`; a real
 * `Mat4` satisfies it without a cast.
 */
export interface Mat4Like {
  /** Sixteen elements in column-major order. */
  elements: ArrayLike<number>;
}

/**
 * Minimal structural 3x3 matrix, `{ elements: ArrayLike<number> }` in
 * column-major order.
 */
export interface Mat3Like {
  /** Nine elements in column-major order. */
  elements: ArrayLike<number>;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Component index accepted by the generic accessors. */
export type ComponentIndex = 0 | 1 | 2 | 3;

/** `true` when `value` is one of the typed arrays this library supports. */
function isTypedArrayLike(value: unknown): value is TypedArray {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

/** Wraps any numeric sequence into a `Float32Array` unless it already is a typed array. */
function toTypedArray(array: ArrayLike<number> | TypedArray): TypedArray {
  return isTypedArrayLike(array) ? array : new Float32Array(array as ArrayLike<number>);
}

/**
 * Scratch 3x3 normal matrix used by {@link BufferAttribute.applyMat4}.
 *
 * Reused across calls because it is only alive inside a single `applyMat4`
 * invocation; `applyMat4` is not re-entrant, but it never calls back into user
 * code, so a single buffer is safe.
 */
const normalMatrixScratch = new Float64Array(9);

/* -------------------------------------------------------------------------- */
/* BufferAttribute                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A named, typed array of vertex data plus the layout metadata needed to
 * interpret it.
 *
 * @typeParam T The concrete typed array backing the attribute.
 */
export class BufferAttribute<T extends TypedArray = TypedArray> extends Disposable<'BufferAttribute'> {
  /** Diagnostic label used by {@link Disposable}. */
  public override readonly label = 'BufferAttribute' as const;

  /** Human-readable name, used in error messages and serialised output. */
  public name: string;

  /** The backing store; `array.length === count * itemSize`. */
  public array: T;

  /** Components per element (`1` scalar, `2` uv, `3` position, `4` colour/tangent). */
  public itemSize: number;

  /** Number of elements; always `Math.floor(array.length / itemSize)`. */
  public count: number;

  /** `true` when integer data must be normalised into `[0, 1]`/`[-1, 1]` by the shader. */
  public normalized: boolean;

  /** Buffer usage hint handed to the backend. */
  public usage: AttributeUsage;

  /** Revision counter bumped by every mutation; backends diff against it. */
  public version: number;

  /** Set while the attribute has unacknowledged changes. */
  private dirty: boolean;

  /**
   * Creates an attribute.
   *
   * @param array Backing data. A plain array is copied into a `Float32Array`;
   *   an existing typed array is adopted **by reference**, never copied.
   * @param itemSize Components per element; must be a positive integer.
   * @param normalized Whether integer data should be normalised in the shader.
   * @param usage Buffer usage hint.
   * @param name Optional debug name.
   */
  constructor(
    array: ArrayLike<number> | T,
    itemSize: number,
    normalized: boolean = false,
    usage: AttributeUsage = 'static',
    name: string = '',
  ) {
    super();
    if (!Number.isInteger(itemSize) || itemSize <= 0) {
      throw new RangeError(`BufferAttribute: itemSize must be a positive integer, got ${itemSize}`);
    }
    this.array = toTypedArray(array) as T;
    this.itemSize = itemSize;
    this.count = Math.floor(this.array.length / itemSize);
    this.normalized = normalized;
    this.usage = usage;
    this.name = name;
    this.version = 0;
    this.dirty = true;
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Releases the attribute.
   *
   * The CPU array is owned by JavaScript and is collected with the object, so
   * there is no native handle to free; the hook exists so backends can register
   * themselves through {@link Disposable.addDisposeCallback} instead of keeping
   * an external map.
   */
  protected override onDispose(): void {
    this.dirty = false;
  }

  /* ------------------------------------------------------------ core shape */

  /**
   * Replaces the backing store.
   *
   * The new array is adopted by reference. `count` is recomputed and `version`
   * is bumped so backends re-upload.
   *
   * @returns `this`, so calls chain.
   */
  public setArray(array: T): this {
    this.array = array;
    this.count = Math.floor(array.length / this.itemSize);
    this.markDirty();
    return this;
  }

  /** `true` while the attribute has unacknowledged changes. */
  public get needsUpdate(): boolean {
    return this.dirty;
  }

  /**
   * Marks the attribute as changed (`true`) or as uploaded (`false`).
   *
   * Assigning `true` bumps {@link BufferAttribute.version}; assigning `false`
   * only clears the flag and leaves the version alone, so a backend can record
   * "I have uploaded revision N" without confusing later readers.
   */
  public set needsUpdate(value: boolean) {
    if (value) this.markDirty();
    else this.dirty = false;
  }

  /** Marks the attribute dirty and bumps {@link BufferAttribute.version}. */
  protected markDirty(): void {
    this.dirty = true;
    this.version++;
  }

  /* -------------------------------------------------------------- read/write */

  /** Reads the x (component `0`) of element `index`; `0` when the component does not exist. */
  public getX(index: number): number {
    return this.array[index * this.itemSize];
  }

  /** Reads the y (component `1`) of element `index`; `0` when `itemSize < 2`. */
  public getY(index: number): number {
    return this.itemSize > 1 ? this.array[index * this.itemSize + 1] : 0;
  }

  /** Reads the z (component `2`) of element `index`; `0` when `itemSize < 3`. */
  public getZ(index: number): number {
    return this.itemSize > 2 ? this.array[index * this.itemSize + 2] : 0;
  }

  /** Reads the w (component `3`) of element `index`; `0` when `itemSize < 4`. */
  public getW(index: number): number {
    return this.itemSize > 3 ? this.array[index * this.itemSize + 3] : 0;
  }

  /** Writes the x component of element `index`. */
  public setX(index: number, x: number): this {
    this.array[index * this.itemSize] = x;
    this.markDirty();
    return this;
  }

  /** Writes the y component of element `index`; ignored when `itemSize < 2`. */
  public setY(index: number, y: number): this {
    if (this.itemSize > 1) {
      this.array[index * this.itemSize + 1] = y;
      this.markDirty();
    }
    return this;
  }

  /** Writes the z component of element `index`; ignored when `itemSize < 3`. */
  public setZ(index: number, z: number): this {
    if (this.itemSize > 2) {
      this.array[index * this.itemSize + 2] = z;
      this.markDirty();
    }
    return this;
  }

  /** Writes the w component of element `index`; ignored when `itemSize < 4`. */
  public setW(index: number, w: number): this {
    if (this.itemSize > 3) {
      this.array[index * this.itemSize + 3] = w;
      this.markDirty();
    }
    return this;
  }

  /** Writes two components of element `index`; the second is skipped when `itemSize < 2`. */
  public setXY(index: number, x: number, y: number): this {
    const offset = index * this.itemSize;
    this.array[offset] = x;
    if (this.itemSize > 1) this.array[offset + 1] = y;
    this.markDirty();
    return this;
  }

  /** Writes three components of element `index`, skipping any the layout does not have. */
  public setXYZ(index: number, x: number, y: number, z: number): this {
    const offset = index * this.itemSize;
    this.array[offset] = x;
    if (this.itemSize > 1) this.array[offset + 1] = y;
    if (this.itemSize > 2) this.array[offset + 2] = z;
    this.markDirty();
    return this;
  }

  /** Writes four components of element `index`, skipping any the layout does not have. */
  public setXYZW(index: number, x: number, y: number, z: number, w: number): this {
    const offset = index * this.itemSize;
    this.array[offset] = x;
    if (this.itemSize > 1) this.array[offset + 1] = y;
    if (this.itemSize > 2) this.array[offset + 2] = z;
    if (this.itemSize > 3) this.array[offset + 3] = w;
    this.markDirty();
    return this;
  }

  /** Reads component `component` of element `index`. */
  public getComponent(index: number, component: number): number {
    if (component < 0 || component >= this.itemSize) return 0;
    return this.array[index * this.itemSize + component];
  }

  /** Writes component `component` of element `index`. */
  public setComponent(index: number, component: number, value: number): this {
    if (component < 0 || component >= this.itemSize) return this;
    this.array[index * this.itemSize + component] = value;
    this.markDirty();
    return this;
  }

  /* --------------------------------------------------------------- transform */

  /**
   * Transforms every element in place.
   *
   * @param m Column-major 4x4 matrix.
   * @param target How to interpret the data:
   *   - `'position'` (default) transforms as a point: xyz (or xy for `itemSize`
   *     of 2) go through the matrix, including translation and the perspective
   *     divide for `itemSize >= 3`.
   *   - `'normal'` transforms by the inverse-transpose of the upper-left 3x3
   *     block so non-uniform scaling cannot shear normals off the surface, then
   *     renormalises. `itemSize` of 2 uses the 2x2 inverse-transpose.
   *   - `'tangent'` transforms the xyz part as a direction (no translation); for
   *     `itemSize === 4` the handedness in `w` is flipped when the matrix
   *     determinant is negative.
   * @returns `this`, so calls chain.
   */
  public applyMat4(m: Mat4Like, target: TransformTarget = 'position'): this {
    const e = m.elements;
    if (target === 'normal') return this.applyNormalMatrix4(e);

    const itemSize = this.itemSize;
    const array = this.array;
    const count = this.count;

    if (target === 'tangent') {
      for (let i = 0; i < count; i++) {
        const offset = i * itemSize;
        const x = array[offset];
        const y = itemSize > 1 ? array[offset + 1] : 0;
        const z = itemSize > 2 ? array[offset + 2] : 0;
        array[offset] = e[0] * x + e[4] * y + e[8] * z;
        if (itemSize > 1) array[offset + 1] = e[1] * x + e[5] * y + e[9] * z;
        if (itemSize > 2) array[offset + 2] = e[2] * x + e[6] * y + e[10] * z;
      }
      // A mirroring matrix reverses the tangent frame handedness.
      if (itemSize > 3) {
        const determinant =
          e[0] * (e[5] * e[10] - e[6] * e[9]) -
          e[4] * (e[1] * e[10] - e[2] * e[9]) +
          e[8] * (e[1] * e[6] - e[2] * e[5]);
        if (determinant < 0) {
          for (let i = 0; i < count; i++) array[i * itemSize + 3] = -array[i * itemSize + 3];
        }
      }
      this.markDirty();
      return this;
    }

    if (itemSize === 2) {
      for (let i = 0; i < count; i++) {
        const offset = i * itemSize;
        const x = array[offset];
        const y = array[offset + 1];
        array[offset] = e[0] * x + e[4] * y + e[12];
        array[offset + 1] = e[1] * x + e[5] * y + e[13];
      }
      this.markDirty();
      return this;
    }

    for (let i = 0; i < count; i++) {
      const offset = i * itemSize;
      const x = array[offset];
      const y = itemSize > 1 ? array[offset + 1] : 0;
      const z = itemSize > 2 ? array[offset + 2] : 0;
      const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15] || 1);
      array[offset] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
      if (itemSize > 1) array[offset + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
      if (itemSize > 2) array[offset + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    }
    this.markDirty();
    return this;
  }

  /**
   * Applies an explicit normal matrix (usually the inverse-transpose of the
   * model matrix) and renormalises.
   *
   * @param m Column-major 3x3 matrix.
   */
  public applyNormalMat3(m: Mat3Like): this {
    const e = m.elements;
    const itemSize = this.itemSize;
    const array = this.array;
    const count = this.count;

    for (let i = 0; i < count; i++) {
      const offset = i * itemSize;
      const x = array[offset];
      const y = itemSize > 1 ? array[offset + 1] : 0;
      const z = itemSize > 2 ? array[offset + 2] : 0;
      const nx = e[0] * x + e[3] * y + e[6] * z;
      const ny = e[1] * x + e[4] * y + e[7] * z;
      const nz = e[2] * x + e[5] * y + e[8] * z;
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const scale = length > 0 ? 1 / length : 1;
      array[offset] = nx * scale;
      if (itemSize > 1) array[offset + 1] = ny * scale;
      if (itemSize > 2) array[offset + 2] = nz * scale;
    }
    this.markDirty();
    return this;
  }

  /**
   * Normal-matrix transform driven by a 4x4 matrix.
   *
   * Derives the inverse-transpose of the upper-left 3x3 (or 2x2) block from the
   * cofactor matrix, which is proportional to `M鈦会祤`; because the result is
   * renormalised the constant factor cancels, so no explicit division by the
   * determinant is needed. A singular block falls back to the plain linear
   * transform rather than producing `NaN`.
   */
  private applyNormalMatrix4(e: ArrayLike<number>): this {
    const itemSize = this.itemSize;
    const array = this.array;
    const count = this.count;

    if (itemSize === 2) {
      const m00 = e[0];
      const m10 = e[1];
      const m01 = e[4];
      const m11 = e[5];
      const determinant = m00 * m11 - m01 * m10;
      if (determinant === 0) return this.applyMat4({ elements: e });
      for (let i = 0; i < count; i++) {
        const offset = i * itemSize;
        const x = array[offset];
        const y = array[offset + 1];
        // (M鈦宦?岬€ = [m11, -m10; -m01, m00] / det
        const nx = m11 * x - m10 * y;
        const ny = -m01 * x + m00 * y;
        const length = Math.hypot(nx, ny);
        const scale = length > 0 ? 1 / length : 1;
        array[offset] = nx * scale;
        array[offset + 1] = ny * scale;
      }
      this.markDirty();
      return this;
    }

    const m00 = e[0];
    const m10 = e[1];
    const m20 = e[2];
    const m01 = e[4];
    const m11 = e[5];
    const m21 = e[6];
    const m02 = e[8];
    const m12 = e[9];
    const m22 = e[10];

    const determinant =
      m00 * (m11 * m22 - m12 * m21) - m01 * (m10 * m22 - m12 * m20) + m02 * (m10 * m21 - m11 * m20);

    const c = normalMatrixScratch;
    if (determinant === 0) {
      c[0] = m00;
      c[1] = m10;
      c[2] = m20;
      c[3] = m01;
      c[4] = m11;
      c[5] = m21;
      c[6] = m02;
      c[7] = m12;
      c[8] = m22;
    } else {
      // Cofactor matrix, row-major: c[row * 3 + col].
      c[0] = m11 * m22 - m12 * m21;
      c[1] = m12 * m20 - m10 * m22;
      c[2] = m10 * m21 - m11 * m20;
      c[3] = m02 * m21 - m01 * m22;
      c[4] = m00 * m22 - m02 * m20;
      c[5] = m01 * m20 - m00 * m21;
      c[6] = m01 * m12 - m02 * m11;
      c[7] = m02 * m10 - m00 * m12;
      c[8] = m00 * m11 - m01 * m10;
    }

    for (let i = 0; i < count; i++) {
      const offset = i * itemSize;
      const x = array[offset];
      const y = itemSize > 1 ? array[offset + 1] : 0;
      const z = itemSize > 2 ? array[offset + 2] : 0;
      const nx = c[0] * x + c[1] * y + c[2] * z;
      const ny = c[3] * x + c[4] * y + c[5] * z;
      const nz = c[6] * x + c[7] * y + c[8] * z;
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const scale = length > 0 ? 1 / length : 1;
      array[offset] = nx * scale;
      if (itemSize > 1) array[offset + 1] = ny * scale;
      if (itemSize > 2) array[offset + 2] = nz * scale;
    }
    this.markDirty();
    return this;
  }

  /* ------------------------------------------------------------------ copies */

  /**
   * Copies the components of another attribute into this one.
   *
   * Copies `min(this.itemSize, other.itemSize)` components per element, so a
   * narrow destination can never be written out of bounds.
   */
  public fromBufferAttribute(other: { array: ArrayLike<number>; itemSize: number; count: number }): this {
    const components = Math.min(this.itemSize, other.itemSize);
    const elements = Math.min(this.count, other.count);
    const array = this.array;
    const source = other.array;
    for (let i = 0; i < elements; i++) {
      const write = i * this.itemSize;
      const read = i * other.itemSize;
      for (let c = 0; c < components; c++) array[write + c] = source[read + c];
    }
    this.markDirty();
    return this;
  }

  /** Copies `source` wholesale, reallocating the backing array when its length differs. */
  public copy(source: BufferAttribute<T>): this {
    const Type = source.array.constructor as TypedArrayConstructor<T>;
    if (this.array.length !== source.array.length || !(this.array instanceof Type)) {
      this.array = new Type(source.array.length) as T;
    }
    const destination = this.array as unknown as { [index: number]: number };
    const origin = source.array as unknown as { [index: number]: number };
    for (let i = 0; i < source.array.length; i++) destination[i] = origin[i];
    this.name = source.name;
    this.itemSize = source.itemSize;
    this.count = source.count;
    this.normalized = source.normalized;
    this.usage = source.usage;
    this.markDirty();
    return this;
  }

  /** Returns an independent copy of this attribute. */
  public clone(): BufferAttribute<T> {
    const Type = this.array.constructor as TypedArrayConstructor<T>;
    const buffer = new Type(this.array.length) as T;
    const destination = buffer as unknown as { [index: number]: number };
    const origin = this.array as unknown as { [index: number]: number };
    for (let i = 0; i < this.array.length; i++) destination[i] = origin[i];
    return new BufferAttribute<T>(buffer, this.itemSize, this.normalized, this.usage, this.name);
  }

  /* ------------------------------------------------------------------ output */

  /** Serialises the attribute; round-trips through {@link BufferAttribute.fromJSON}. */
  public toJSON(): AttributeJSON {
    return {
      name: this.name,
      arrayType: this.array.constructor.name,
      array: Array.from(this.array as unknown as ArrayLike<number>),
      itemSize: this.itemSize,
      count: this.count,
      normalized: this.normalized,
      usage: this.usage,
    };
  }

  /** Rebuilds an attribute from {@link BufferAttribute.toJSON} output. */
  public static fromJSON(json: AttributeJSON): BufferAttribute {
    const Type = (getTypedArrayConstructor(json.arrayType) ?? Float32Array) as TypedArrayConstructor;
    const array = new Type(json.array.length);
    for (let i = 0; i < json.array.length; i++) array[i] = json.array[i];
    return new BufferAttribute(array, json.itemSize, json.normalized, json.usage, json.name ?? '');
  }

  /**
   * Iterates element by element, yielding `[x, y, z, w]` tuples.
   *
   * Missing components are reported as `0`, so the tuple always has four slots.
   */
  public *[Symbol.iterator](): IterableIterator<[number, number, number, number]> {
    for (let i = 0; i < this.count; i++) {
      yield [this.getX(i), this.getY(i), this.getZ(i), this.getW(i)];
    }
  }

  /** `"BufferAttribute(name=position, itemSize=3, count=3, Float32Array)"`. */
  public override toString(): string {
    return `BufferAttribute(name=${this.name || 'unnamed'}, itemSize=${this.itemSize}, count=${this.count}, ${this.array.constructor.name})`;
  }
}

/* -------------------------------------------------------------------------- */
/* Convenience subclasses                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Builds the backing store of a convenience subclass from a length or a sequence.
 *
 * A typed array of the **same type** is adopted by reference rather than copied. That is
 * load-bearing, not an optimisation: producers that keep their own view of the data — a
 * `ParticleSystem` writing into its simulation arrays while handing out
 * `Float32BufferAttribute` views of them — depend on writing through one and reading
 * through the other. Copying quietly severs that link, and the reader sees a buffer of
 * zeros forever. There is no error, and nothing throws, because both buffers are valid.
 *
 * A plain array or a length still allocates, and a typed array of a different type is
 * still converted, so the declared `T` stays honest.
 */
function createArray<T extends TypedArray>(
  Type: TypedArrayConstructor<T>,
  source: ArrayLike<number> | number,
): T {
  if (typeof source === 'number') return new Type(source);
  if (source instanceof Type) return source;
  const array = new Type(source.length);
  for (let i = 0; i < source.length; i++) array[i] = source[i];
  return array;
}

/**
 * A `BufferAttribute` backed by a `Float32Array` 鈥?the default for positions,
 * normals, uvs and tangents.
 */
export class Float32BufferAttribute extends BufferAttribute<Float32Array> {
  /**
   * @param array Element data, or the number of components to allocate.
   * @param itemSize Components per element.
   * @param normalized Whether integer data should be normalised (rarely useful here).
   * @param usage Buffer usage hint.
   * @param name Optional debug name.
   */
  constructor(
    array: ArrayLike<number> | number,
    itemSize: number,
    normalized: boolean = false,
    usage: AttributeUsage = 'static',
    name: string = '',
  ) {
    super(createArray(Float32Array, array), itemSize, normalized, usage, name);
  }
}

/** A `BufferAttribute` backed by a `Float64Array`, for CPU-side precision work. */
export class Float64BufferAttribute extends BufferAttribute<Float64Array> {
  /** @param array Element data, or the number of components to allocate. */
  constructor(
    array: ArrayLike<number> | number,
    itemSize: number,
    normalized: boolean = false,
    usage: AttributeUsage = 'static',
    name: string = '',
  ) {
    super(createArray(Float64Array, array), itemSize, normalized, usage, name);
  }
}

/** A `BufferAttribute` backed by a `Uint16Array`; the default index element type. */
export class Uint16BufferAttribute extends BufferAttribute<Uint16Array> {
  /** @param array Element data, or the number of components to allocate. */
  constructor(
    array: ArrayLike<number> | number,
    itemSize: number,
    normalized: boolean = false,
    usage: AttributeUsage = 'static',
    name: string = '',
  ) {
    super(createArray(Uint16Array, array), itemSize, normalized, usage, name);
  }
}

/** A `BufferAttribute` backed by a `Uint32Array`; required beyond 65 535 vertices. */
export class Uint32BufferAttribute extends BufferAttribute<Uint32Array> {
  /** @param array Element data, or the number of components to allocate. */
  constructor(
    array: ArrayLike<number> | number,
    itemSize: number,
    normalized: boolean = false,
    usage: AttributeUsage = 'static',
    name: string = '',
  ) {
    super(createArray(Uint32Array, array), itemSize, normalized, usage, name);
  }
}

/** A `BufferAttribute` backed by an `Int8Array`, typically with `normalized`. */
export class Int8BufferAttribute extends BufferAttribute<Int8Array> {
  /** @param array Element data, or the number of components to allocate. */
  constructor(
    array: ArrayLike<number> | number,
    itemSize: number,
    normalized: boolean = true,
    usage: AttributeUsage = 'static',
    name: string = '',
  ) {
    super(createArray(Int8Array, array), itemSize, normalized, usage, name);
  }
}

/** A `BufferAttribute` backed by a `Uint8Array`, typically with `normalized`. */
export class Uint8BufferAttribute extends BufferAttribute<Uint8Array> {
  /** @param array Element data, or the number of components to allocate. */
  constructor(
    array: ArrayLike<number> | number,
    itemSize: number,
    normalized: boolean = true,
    usage: AttributeUsage = 'static',
    name: string = '',
  ) {
    super(createArray(Uint8Array, array), itemSize, normalized, usage, name);
  }
}
