/**
 * Interleaved vertex data: several attributes sharing one typed array.
 *
 * ## Why
 *
 * A vertex is usually read as a whole: the vertex shader consumes position,
 * normal and uv together. Storing them in three separate arrays means three
 * cache lines are touched per vertex and the GPU pays for three buffer binds.
 * Interleaving packs one vertex into `stride` consecutive components:
 *
 * ```text
 * stride = 8 (position.xyz, normal.xyz, uv.xy)
 * index :  0   1   2 | 3   4   5 | 6   7  |  8   9  10 | 11  12  13 | 14  15
 * value : px  py  pz | nx  ny  nz | u   v  | px  py  pz | nx  ny  nz | u   v
 *         鈹?position 鈹?鈹斺攢 normal 鈹€鈹?鈹斺攢 uv 鈹€鈹?鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€ vertex 1 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹? *         offset 0     offset 3     offset 6
 * ```
 *
 * One `InterleavedBuffer` owns the array; each `InterleavedBufferAttribute` is a
 * cheap `(offset, itemSize)` window into it.
 *
 * ## The shared-stride constraint
 *
 * **Every view over a given buffer must be created from the same `stride`.** The
 * stride is a property of the buffer, not of a view, because all views advance
 * through the array together: element `i` of every attribute lives inside the
 * same `stride`-sized record starting at `i * stride`. Creating attributes with
 * a different stride silently reads the wrong components, so this module keeps
 * `stride` on the buffer and exposes it read-only on the attributes.
 *
 * The memory saving is real but modest: interleaving removes per-attribute
 * padding and cache-line waste, not the data itself. A tightly packed set of
 * separate `Float32Array`s holds exactly the same number of components; the win
 * is locality (one line per vertex instead of one per attribute) and fewer
 * buffer objects to create, bind and track.
 *
 * @packageDocumentation
 */

import { Disposable } from '../../core/Disposable';
import type { TypedArray, TypedArrayConstructor } from '../../types';
import type { AttributeJSON, AttributeUsage, InterleavedAttributeJSON, TransformTarget } from './types';
import type { Mat3Like, Mat4Like } from './BufferAttribute';

/** `true` when `value` is one of the typed arrays this library supports. */
function isTypedArrayLike(value: unknown): value is TypedArray {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

/** Wraps any numeric sequence into a `Float32Array` unless it already is a typed array. */
function toTypedArray(array: ArrayLike<number> | TypedArray): TypedArray {
  if (isTypedArrayLike(array)) return array;
  const result = new Float32Array(array.length);
  for (let i = 0; i < array.length; i++) result[i] = array[i];
  return result;
}

/** Copies a numeric sequence into a freshly allocated array of the same kind. */
function duplicateArray(source: TypedArray): TypedArray {
  const Type = source.constructor as TypedArrayConstructor;
  const result = new Type(source.length) as TypedArray;
  const destination = result as unknown as { [index: number]: number };
  const origin = source as unknown as { [index: number]: number };
  for (let i = 0; i < source.length; i++) destination[i] = origin[i];
  return result;
}

/** JSON form of an {@link InterleavedBuffer}. */
export interface InterleavedBufferJSON {
  /** Component type name (`'Float32Array'`, ...). */
  arrayType: string;
  /** Flattened interleaved data. */
  array: number[];
  /** Components between two consecutive records. */
  stride: number;
  /** Number of records. */
  count: number;
  /** Buffer usage hint. */
  usage: AttributeUsage;
  /** Debug name. */
  name: string;
}

/* -------------------------------------------------------------------------- */
/* InterleavedBuffer                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One typed array holding several attributes in a repeating `stride`-sized
 * record.
 */
export class InterleavedBuffer extends Disposable<'InterleavedBuffer'> {
  /** Diagnostic label used by {@link Disposable}. */
  public override readonly label = 'InterleavedBuffer' as const;

  /** Human-readable name, used in diagnostics and serialised output. */
  public name: string;

  /** The interleaved backing store. */
  public array: TypedArray;

  /**
   * Components between the start of one record and the start of the next.
   *
   * Shared by every view over this buffer; see the module documentation for why
   * it cannot differ per view.
   */
  public stride: number;

  /** Number of records; `Math.floor(array.length / stride)`. */
  public count: number;

  /** Buffer usage hint handed to the backend. */
  public usage: AttributeUsage;

  /** Revision counter bumped by every mutation. */
  public version: number;

  /** Set while the buffer has unacknowledged changes. */
  private dirty: boolean;

  /**
   * Creates an interleaved buffer.
   *
   * @param array Interleaved data; a plain array is copied into a `Float32Array`,
   *   a typed array is adopted by reference.
   * @param stride Components between two consecutive records.
   * @param usage Buffer usage hint.
   * @param name Optional debug name.
   */
  constructor(
    array: ArrayLike<number> | TypedArray,
    stride: number,
    usage: AttributeUsage = 'static',
    name: string = '',
  ) {
    super();
    if (!Number.isInteger(stride) || stride <= 0) {
      throw new RangeError(`InterleavedBuffer: stride must be a positive integer, got ${stride}`);
    }
    this.array = toTypedArray(array);
    this.stride = stride;
    this.count = Math.floor(this.array.length / stride);
    this.usage = usage;
    this.name = name;
    this.version = 0;
    this.dirty = true;
  }

  /** Releases the buffer; the CPU array is collected with the object. */
  protected override onDispose(): void {
    this.dirty = false;
  }

  /** `true` while the buffer has unacknowledged changes. */
  public get needsUpdate(): boolean {
    return this.dirty;
  }

  /** Marks the buffer as changed (`true`) or as uploaded (`false`). */
  public set needsUpdate(value: boolean) {
    if (value) this.markDirty();
    else this.dirty = false;
  }

  /** Marks the buffer dirty and bumps {@link InterleavedBuffer.version}. */
  public markDirty(): void {
    this.dirty = true;
    this.version++;
  }

  /**
   * Replaces the backing store, optionally with a different stride.
   *
   * Recomputes {@link InterleavedBuffer.count}; every existing view is
   * invalidated, which is why callers usually rebuild the attributes too.
   */
  public setArray(array: ArrayLike<number> | TypedArray, stride: number = this.stride): this {
    if (!Number.isInteger(stride) || stride <= 0) {
      throw new RangeError(`InterleavedBuffer: stride must be a positive integer, got ${stride}`);
    }
    this.array = toTypedArray(array);
    this.stride = stride;
    this.count = Math.floor(this.array.length / stride);
    this.markDirty();
    return this;
  }

  /**
   * Returns an independent copy.
   *
   * @param data Optional replacement backing store (for example a differently
   *   typed array built from the same data); it is adopted by reference.
   */
  public clone(data?: TypedArray): InterleavedBuffer {
    return new InterleavedBuffer(data ?? duplicateArray(this.array), this.stride, this.usage, this.name);
  }

  /** Copies every field from `source`, adopting a fresh copy of its array. */
  public copy(source: InterleavedBuffer): this {
    this.array = duplicateArray(source.array);
    this.stride = source.stride;
    this.count = source.count;
    this.usage = source.usage;
    this.name = source.name;
    this.markDirty();
    return this;
  }

  /** Serialises the buffer; round-trips through {@link InterleavedBuffer.fromJSON}. */
  public toJSON(): InterleavedBufferJSON {
    return {
      arrayType: this.array.constructor.name,
      array: Array.from(this.array as unknown as ArrayLike<number>),
      stride: this.stride,
      count: this.count,
      usage: this.usage,
      name: this.name,
    };
  }

  /** Rebuilds a buffer from {@link InterleavedBuffer.toJSON} output. */
  public static fromJSON(json: InterleavedBufferJSON): InterleavedBuffer {
    const Type = (typedArrayConstructor(json.arrayType) ?? Float32Array) as TypedArrayConstructor;
    const array = new Type(json.array.length) as TypedArray;
    const destination = array as unknown as { [index: number]: number };
    for (let i = 0; i < json.array.length; i++) destination[i] = json.array[i];
    return new InterleavedBuffer(array, json.stride, json.usage, json.name);
  }

  /** `"InterleavedBuffer(name=data, stride=8, count=3, Float32Array)"`. */
  public override toString(): string {
    return `InterleavedBuffer(name=${this.name || 'unnamed'}, stride=${this.stride}, count=${this.count}, ${this.array.constructor.name})`;
  }
}

/** Resolves a typed array constructor from its `constructor.name`. */
function typedArrayConstructor(name: string): TypedArrayConstructor | null {
  const table: Record<string, TypedArrayConstructor> = {
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
  };
  return table[name] ?? null;
}

/* -------------------------------------------------------------------------- */
/* InterleavedBufferAttribute                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A `(offset, itemSize)` window into an {@link InterleavedBuffer}.
 *
 * Exposes the same read/write surface as `BufferAttribute`, so geometry code can
 * treat both uniformly. The only differences are that reads and writes are
 * strided (they step by `data.stride` rather than `itemSize`) and that the
 * stride itself belongs to the buffer and therefore cannot be set here.
 */
export class InterleavedBufferAttribute extends Disposable<'InterleavedBufferAttribute'> {
  /** Diagnostic label used by {@link Disposable}. */
  public override readonly label = 'InterleavedBufferAttribute' as const;

  /** Human-readable name, used in diagnostics and serialised output. */
  public name: string;

  /** The shared interleaved store. */
  public data: InterleavedBuffer;

  /** Components belonging to this view inside one record. */
  public itemSize: number;

  /** Index of this view's first component inside one record. */
  public offset: number;

  /** `true` when integer data must be normalised by the shader. */
  public normalized: boolean;

  /**
   * Creates a view.
   *
   * @param data The shared interleaved buffer.
   * @param itemSize Components belonging to this view.
   * @param offset First component of this view inside one record.
   * @param normalized Whether integer data is normalised in the shader.
   * @param name Optional debug name.
   */
  constructor(
    data: InterleavedBuffer,
    itemSize: number,
    offset: number,
    normalized: boolean = false,
    name: string = '',
  ) {
    super();
    if (!Number.isInteger(itemSize) || itemSize <= 0) {
      throw new RangeError(
        `InterleavedBufferAttribute: itemSize must be a positive integer, got ${itemSize}`,
      );
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError(
        `InterleavedBufferAttribute: offset must be a non-negative integer, got ${offset}`,
      );
    }
    if (offset + itemSize > data.stride) {
      throw new RangeError(
        `InterleavedBufferAttribute: view [${offset}, ${offset + itemSize}) does not fit inside a stride of ${data.stride}`,
      );
    }
    this.data = data;
    this.itemSize = itemSize;
    this.offset = offset;
    this.normalized = normalized;
    this.name = name;
  }

  /** Releases the view; the shared buffer is owned by the geometry. */
  protected override onDispose(): void {
    /* The view holds no native handle; the shared buffer outlives it. */
  }

  /* ---------------------------------------------------------------- layout */

  /** The shared backing store (identical to `data.array`). */
  public get array(): TypedArray {
    return this.data.array;
  }

  /** Components between two consecutive elements of this view. */
  public get stride(): number {
    return this.data.stride;
  }

  /** Number of elements, shared with the owning buffer. */
  public get count(): number {
    return this.data.count;
  }

  /** Buffer usage hint, read from the owning buffer. */
  public get usage(): AttributeUsage {
    return this.data.usage;
  }

  /** Revision counter, read from the owning buffer. */
  public get version(): number {
    return this.data.version;
  }

  /** `true` while the owning buffer has unacknowledged changes. */
  public get needsUpdate(): boolean {
    return this.data.needsUpdate;
  }

  /** Marks the owning buffer as changed (`true`) or as uploaded (`false`). */
  public set needsUpdate(value: boolean) {
    this.data.needsUpdate = value;
  }

  /* -------------------------------------------------------------- read/write */

  /** Reads the x (component `0`) of element `index`. */
  public getX(index: number): number {
    return this.data.array[index * this.data.stride + this.offset];
  }

  /** Reads the y (component `1`) of element `index`; `0` when `itemSize < 2`. */
  public getY(index: number): number {
    return this.itemSize > 1 ? this.data.array[index * this.data.stride + this.offset + 1] : 0;
  }

  /** Reads the z (component `2`) of element `index`; `0` when `itemSize < 3`. */
  public getZ(index: number): number {
    return this.itemSize > 2 ? this.data.array[index * this.data.stride + this.offset + 2] : 0;
  }

  /** Reads the w (component `3`) of element `index`; `0` when `itemSize < 4`. */
  public getW(index: number): number {
    return this.itemSize > 3 ? this.data.array[index * this.data.stride + this.offset + 3] : 0;
  }

  /** Writes the x component of element `index`. */
  public setX(index: number, x: number): this {
    this.data.array[index * this.data.stride + this.offset] = x;
    this.data.markDirty();
    return this;
  }

  /** Writes the y component of element `index`; ignored when `itemSize < 2`. */
  public setY(index: number, y: number): this {
    if (this.itemSize > 1) {
      this.data.array[index * this.data.stride + this.offset + 1] = y;
      this.data.markDirty();
    }
    return this;
  }

  /** Writes the z component of element `index`; ignored when `itemSize < 3`. */
  public setZ(index: number, z: number): this {
    if (this.itemSize > 2) {
      this.data.array[index * this.data.stride + this.offset + 2] = z;
      this.data.markDirty();
    }
    return this;
  }

  /** Writes the w component of element `index`; ignored when `itemSize < 4`. */
  public setW(index: number, w: number): this {
    if (this.itemSize > 3) {
      this.data.array[index * this.data.stride + this.offset + 3] = w;
      this.data.markDirty();
    }
    return this;
  }

  /** Writes two components of element `index`. */
  public setXY(index: number, x: number, y: number): this {
    const base = index * this.data.stride + this.offset;
    this.data.array[base] = x;
    if (this.itemSize > 1) this.data.array[base + 1] = y;
    this.data.markDirty();
    return this;
  }

  /** Writes three components of element `index`, skipping any the view does not have. */
  public setXYZ(index: number, x: number, y: number, z: number): this {
    const base = index * this.data.stride + this.offset;
    this.data.array[base] = x;
    if (this.itemSize > 1) this.data.array[base + 1] = y;
    if (this.itemSize > 2) this.data.array[base + 2] = z;
    this.data.markDirty();
    return this;
  }

  /** Writes four components of element `index`, skipping any the view does not have. */
  public setXYZW(index: number, x: number, y: number, z: number, w: number): this {
    const base = index * this.data.stride + this.offset;
    this.data.array[base] = x;
    if (this.itemSize > 1) this.data.array[base + 1] = y;
    if (this.itemSize > 2) this.data.array[base + 2] = z;
    if (this.itemSize > 3) this.data.array[base + 3] = w;
    this.data.markDirty();
    return this;
  }

  /** Reads component `component` of element `index`. */
  public getComponent(index: number, component: number): number {
    if (component < 0 || component >= this.itemSize) return 0;
    return this.data.array[index * this.data.stride + this.offset + component];
  }

  /** Writes component `component` of element `index`. */
  public setComponent(index: number, component: number, value: number): this {
    if (component < 0 || component >= this.itemSize) return this;
    this.data.array[index * this.data.stride + this.offset + component] = value;
    this.data.markDirty();
    return this;
  }

  /* --------------------------------------------------------------- transform */

  /**
   * Transforms every element in place.
   *
   * @param m Column-major 4x4 matrix.
   * @param target `'position'` (default), `'normal'` or `'tangent'`; see
   *   `BufferAttribute.applyMat4`.
   */
  public applyMat4(m: Mat4Like, target: TransformTarget = 'position'): this {
    const e = m.elements;
    const stride = this.data.stride;
    const offset = this.offset;
    const array = this.data.array;
    const itemSize = this.itemSize;

    if (target === 'normal') {
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
        m00 * (m11 * m22 - m12 * m21) -
        m01 * (m10 * m22 - m12 * m20) +
        m02 * (m10 * m21 - m11 * m20);
      const singular = determinant === 0;
      const c0 = singular ? m00 : m11 * m22 - m12 * m21;
      const c1 = singular ? m01 : m12 * m20 - m10 * m22;
      const c2 = singular ? m02 : m10 * m21 - m11 * m20;
      const c3 = singular ? m10 : m02 * m21 - m01 * m22;
      const c4 = singular ? m11 : m00 * m22 - m02 * m20;
      const c5 = singular ? m12 : m01 * m20 - m00 * m21;
      const c6 = singular ? m20 : m01 * m12 - m02 * m11;
      const c7 = singular ? m21 : m02 * m10 - m00 * m12;
      const c8 = singular ? m22 : m00 * m11 - m01 * m10;

      for (let i = 0; i < this.data.count; i++) {
        const base = i * stride + offset;
        const x = array[base];
        const y = itemSize > 1 ? array[base + 1] : 0;
        const z = itemSize > 2 ? array[base + 2] : 0;
        const nx = c0 * x + c1 * y + c2 * z;
        const ny = c3 * x + c4 * y + c5 * z;
        const nz = c6 * x + c7 * y + c8 * z;
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const scale = length > 0 ? 1 / length : 1;
        array[base] = nx * scale;
        if (itemSize > 1) array[base + 1] = ny * scale;
        if (itemSize > 2) array[base + 2] = nz * scale;
      }
      this.data.markDirty();
      return this;
    }

    const directionOnly = target === 'tangent';
    for (let i = 0; i < this.data.count; i++) {
      const base = i * stride + offset;
      const x = array[base];
      const y = itemSize > 1 ? array[base + 1] : 0;
      const z = itemSize > 2 ? array[base + 2] : 0;
      if (directionOnly) {
        array[base] = e[0] * x + e[4] * y + e[8] * z;
        if (itemSize > 1) array[base + 1] = e[1] * x + e[5] * y + e[9] * z;
        if (itemSize > 2) array[base + 2] = e[2] * x + e[6] * y + e[10] * z;
      } else {
        const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15] || 1);
        array[base] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
        if (itemSize > 1) array[base + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
        if (itemSize > 2) array[base + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
      }
    }
    this.data.markDirty();
    return this;
  }

  /** Applies an explicit normal matrix and renormalises, stepping by the buffer stride. */
  public applyNormalMat3(m: Mat3Like): this {
    const e = m.elements;
    const stride = this.data.stride;
    const offset = this.offset;
    const array = this.data.array;
    const itemSize = this.itemSize;

    for (let i = 0; i < this.data.count; i++) {
      const base = i * stride + offset;
      const x = array[base];
      const y = itemSize > 1 ? array[base + 1] : 0;
      const z = itemSize > 2 ? array[base + 2] : 0;
      const nx = e[0] * x + e[3] * y + e[6] * z;
      const ny = e[1] * x + e[4] * y + e[7] * z;
      const nz = e[2] * x + e[5] * y + e[8] * z;
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const scale = length > 0 ? 1 / length : 1;
      array[base] = nx * scale;
      if (itemSize > 1) array[base + 1] = ny * scale;
      if (itemSize > 2) array[base + 2] = nz * scale;
    }
    this.data.markDirty();
    return this;
  }

  /* ------------------------------------------------------------------ copies */

  /** Copies the components of another attribute, writing through the stride. */
  public fromBufferAttribute(other: {
    array: ArrayLike<number>;
    itemSize: number;
    count: number;
  }): this {
    const components = Math.min(this.itemSize, other.itemSize);
    const elements = Math.min(this.count, other.count);
    const stride = this.data.stride;
    const offset = this.offset;
    const array = this.data.array;
    for (let i = 0; i < elements; i++) {
      const base = i * stride + offset;
      const read = i * other.itemSize;
      for (let c = 0; c < components; c++) array[base + c] = other.array[read + c];
    }
    this.data.markDirty();
    return this;
  }

  /**
   * Returns an independent view.
   *
   * @param data Backing buffer to share; defaults to a deep copy of this view's
   *   buffer, which is what makes the result independent.
   */
  public clone(data?: InterleavedBuffer): InterleavedBufferAttribute {
    return new InterleavedBufferAttribute(
      data ?? this.data.clone(),
      this.itemSize,
      this.offset,
      this.normalized,
      this.name,
    );
  }

  /** Serialises the view; round-trips through {@link InterleavedBufferAttribute.fromJSON}. */
  public toJSON(): InterleavedAttributeJSON {
    const base: AttributeJSON = {
      name: this.name,
      arrayType: this.data.array.constructor.name,
      array: Array.from(this.data.array as unknown as ArrayLike<number>),
      itemSize: this.itemSize,
      count: this.count,
      normalized: this.normalized,
      usage: this.data.usage,
    };
    return { ...base, interleaved: true, stride: this.data.stride, offset: this.offset };
  }

  /** Rebuilds a view from {@link InterleavedBufferAttribute.toJSON} output. */
  public static fromJSON(json: InterleavedAttributeJSON): InterleavedBufferAttribute {
    const Type = (typedArrayConstructor(json.arrayType) ?? Float32Array) as TypedArrayConstructor;
    const array = new Type(json.array.length) as TypedArray;
    const destination = array as unknown as { [index: number]: number };
    for (let i = 0; i < json.array.length; i++) destination[i] = json.array[i];
    const data = new InterleavedBuffer(array, json.stride, json.usage, json.name ?? '');
    return new InterleavedBufferAttribute(data, json.itemSize, json.offset, json.normalized, json.name ?? '');
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

  /** `"InterleavedBufferAttribute(name=uv, itemSize=2, offset=6, stride=8)"`. */
  public override toString(): string {
    return `InterleavedBufferAttribute(name=${this.name || 'unnamed'}, itemSize=${this.itemSize}, offset=${this.offset}, stride=${this.data.stride})`;
  }
}
