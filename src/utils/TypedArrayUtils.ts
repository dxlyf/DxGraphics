/**
 * Typed-array helpers used by geometry, buffers and texture upload paths.
 *
 * @packageDocumentation
 */

import { BYTES_PER_ELEMENT } from '../constants';
import type { TypedArray, TypedArrayConstructor } from '../types';

/** Constructor name -> byte size lookup for every supported typed array. */
export const TYPED_ARRAY_BYTES: Readonly<Record<string, number>> = BYTES_PER_ELEMENT;

/** Returns the byte size of one element of `array`. */
export function getBytesPerElement(array: TypedArray): number {
  return array.BYTES_PER_ELEMENT;
}

/** Returns `array.length * array.BYTES_PER_ELEMENT`. */
export function getByteLength(array: TypedArray): number {
  return array.byteLength;
}

/** Returns the constructor name (`'Float32Array'`, ...) for debugging. */
export function getTypedArrayName(value: unknown): string | null {
  if (!ArrayBuffer.isView(value)) return null;
  return value.constructor.name;
}

/** Returns the number of components per element implied by a constructor name. */
export function getComponentsPerElement(name: string): number {
  if (name.endsWith('64')) return name.startsWith('Float') ? 1 : 1;
  return 1;
}

/** Resolves a typed array constructor from its string name. */
export function getTypedArrayConstructor(name: string): TypedArrayConstructor | null {
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

/** `true` when `value` is a typed array. */
export function isTypedArray(value: unknown): value is TypedArray {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

/** `true` when `Type` produces 32-bit floats. */
export function isFloat32(Type: TypedArrayConstructor): boolean {
  return Type === Float32Array;
}

/** `true` when `Type` can hold values above 255 (used for index buffers). */
export function isWideIndexType(Type: TypedArrayConstructor): boolean {
  return Type === Uint32Array || Type === Int32Array || Type === Float32Array || Type === Float64Array;
}

/**
 * Chooses the smallest index type able to address `vertexCount` vertices.
 *
 * Returns `Uint16Array` when the range fits (the WebGL default and the fastest
 * path), otherwise `Uint32Array`. WebGPU always prefers `Uint32Array` because
 * the spec discourages 16-bit indices; pass `force32` to opt in.
 */
export function getIndexType(vertexCount: number, force32: boolean = false): TypedArrayConstructor {
  if (force32) return Uint32Array;
  return vertexCount <= 65535 ? Uint16Array : Uint32Array;
}

/** Creates a typed array from any numeric sequence. */
export function createTypedArrayFrom<T extends TypedArray>(
  Type: TypedArrayConstructor<T>,
  values: ArrayLike<number>,
): T {
  const result = new Type(values.length);
  for (let i = 0; i < values.length; i++) result[i] = values[i];
  return result;
}

/**
 * Converts a typed array to the requested element type.
 *
 * Returns the input untouched when it already has the right type.
 */
export function convertTypedArray<T extends TypedArray>(
  array: TypedArray,
  Type: TypedArrayConstructor<T>,
): T {
  if (array instanceof Type) return array as T;
  const result = new Type(array.length);
  for (let i = 0; i < array.length; i++) result[i] = array[i];
  return result;
}

/** Grows (or copies) a typed array to `length`, preserving existing values. */
export function growTypedArray<T extends TypedArray>(array: T, length: number): T {
  if (length <= array.length) return array;
  const Type = array.constructor as TypedArrayConstructor<T>;
  const next = new Type(length);
  next.set(array as unknown as ArrayLike<number>);
  return next;
}

/**
 * Ensures `array` has room for `required` elements, doubling when needed.
 *
 * When the array must be replaced the new instance is returned; callers must
 * use the return value (attributes do this inside {@link resizeBuffer}).
 */
export function ensureCapacity<T extends TypedArray>(array: T, required: number): T {
  if (array.length >= required) return array;
  const target = Math.max(required, array.length * 2 || 1);
  return growTypedArray(array, target);
}

/** Extracts a strided slice of `array` into a tightly packed copy. */
export function subarrayStrided(
  array: TypedArray,
  offset: number,
  stride: number,
  count: number,
): TypedArray {
  const result = new Float32Array(count);
  for (let i = 0; i < count; i++) result[i] = array[offset + i * stride];
  return result;
}

/** Computes the inclusive `[min, max]` range of an array; `[0, 0]` when empty. */
export function getRange(array: ArrayLike<number>): [number, number] {
  if (array.length === 0) return [0, 0];
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < array.length; i++) {
    const value = array[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return [min, max];
}

/** `true` when all values are strictly inside `[min, max]` of `Type`. */
export function fitsInType(array: ArrayLike<number>, Type: TypedArrayConstructor): boolean {
  const limits: Record<string, [number, number]> = {
    Uint8Array: [0, 255],
    Uint8ClampedArray: [0, 255],
    Int8Array: [-128, 127],
    Uint16Array: [0, 65535],
    Int16Array: [-32768, 32767],
    Uint32Array: [0, 4294967295],
    Int32Array: [-2147483648, 2147483647],
    Float32Array: [-Infinity, Infinity],
    Float64Array: [-Infinity, Infinity],
  };
  const limit = limits[Type.name];
  if (!limit) return true;
  const [min, max] = getRange(array);
  return min >= limit[0] && max <= limit[1];
}

/** Element-wise addition; writes into `out` when provided. */
export function addTypedArrays(a: TypedArray, b: TypedArray, out?: Float32Array): Float32Array {
  const result = out ?? new Float32Array(Math.min(a.length, b.length));
  const n = Math.min(a.length, b.length, result.length);
  for (let i = 0; i < n; i++) result[i] = a[i] + b[i];
  return result;
}

/** Element-wise multiplication by a scalar. */
export function scaleTypedArray(a: TypedArray, scalar: number, out?: Float32Array): Float32Array {
  const result = out ?? new Float32Array(a.length);
  const n = Math.min(a.length, result.length);
  for (let i = 0; i < n; i++) result[i] = a[i] * scalar;
  return result;
}

/** Dot product of two same-length sequences. */
export function dotTypedArrays(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < n; i++) total += a[i] * b[i];
  return total;
}

/** Normalises an array in place (3-component vectors by default). */
export function normalizeVec3Array(array: Float32Array, stride: number = 3): Float32Array {
  for (let i = 0; i + 2 < array.length; i += stride) {
    const x = array[i];
    const y = array[i + 1];
    const z = array[i + 2];
    const length = Math.sqrt(x * x + y * y + z * z);
    if (length > 0) {
      array[i] = x / length;
      array[i + 1] = y / length;
      array[i + 2] = z / length;
    }
  }
  return array;
}

/** Reinterprets the bytes of a typed array as another element type. */
export function reinterpretTypedArray<T extends TypedArray>(
  array: TypedArray,
  Type: TypedArrayConstructor<T>,
): T {
  return new Type(array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength));
}

/** Concatenates numeric sequences into one `Float32Array`. */
export function concatToFloat32(...arrays: ArrayLike<number>[]): Float32Array {
  let total = 0;
  for (const array of arrays) total += array.length;
  const result = new Float32Array(total);
  let offset = 0;
  for (const array of arrays) {
    for (let i = 0; i < array.length; i++) result[offset + i] = array[i];
    offset += array.length;
  }
  return result;
}

/** Serialises a typed array to a plain array, rounded for stable snapshots. */
export function toPlainArray(array: TypedArray, precision: number = 6): number[] {
  const factor = Math.pow(10, precision);
  const result = new Array<number>(array.length);
  for (let i = 0; i < array.length; i++) result[i] = Math.round(array[i] * factor) / factor;
  return result;
}

/** Packs a `Float32Array` into a `Uint8Array` copy of its bytes. */
export function float32ToBytes(array: Float32Array): Uint8Array {
  return new Uint8Array(array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength));
}

/** Builds a `Float32Array` view over the bytes of `bytes`. */
export function bytesToFloat32(bytes: Uint8Array): Float32Array {
  const copy = bytes.slice();
  return new Float32Array(copy.buffer);
}

/** Interleaves `count` separate attribute arrays into one buffer. */
export function interleave(
  arrays: readonly ArrayLike<number>[],
  itemSizes: readonly number[],
  count: number,
): Float32Array {
  const stride = itemSizes.reduce((total, size) => total + size, 0);
  const result = new Float32Array(count * stride);
  let write = 0;
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < arrays.length; a++) {
      const source = arrays[a];
      const size = itemSizes[a];
      const base = i * size;
      for (let c = 0; c < size; c++) result[write++] = source[base + c];
    }
  }
  return result;
}
