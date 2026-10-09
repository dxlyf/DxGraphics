/**
 * Array and typed-array helpers.
 *
 * @packageDocumentation
 */

import type { TypedArray, TypedArrayConstructor } from '../types';

/** `true` when `value` is an array-like with a numeric `length`. */
export function isArrayLike(value: unknown): value is ArrayLike<unknown> {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as ArrayLike<unknown>).length === 'number'
  );
}

/** `true` when `value` is a typed array (Float32Array, Uint16Array, ...). */
export function isTypedArrayLike(value: unknown): boolean {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

/** Returns `value` when it is an array, otherwise wraps it in a single-element array. */
export function toArray<T>(value: T | readonly T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? (value as T[]).slice() : [value as T];
}

/** Ensures a value is an array (no copy when it already is one). */
export function ensureArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/** Allocates a typed array of `length` for the given constructor. */
export function createTypedArray<T extends TypedArray>(
  Type: TypedArrayConstructor<T>,
  length: number,
): T {
  return new Type(Math.max(0, length));
}

/** Converts any numeric array or typed array to a plain `number[]`. */
export function toNumberArray(values: ArrayLike<number>): number[] {
  return Array.from(values);
}

/** Copies `source` into `target`, growing nothing and clamping to `target.length`. */
export function copyInto<T extends TypedArray>(source: ArrayLike<number>, target: T): T {
  const n = Math.min(source.length, target.length);
  for (let i = 0; i < n; i++) target[i] = source[i];
  return target;
}

/** Concatenates typed arrays that share the same constructor. */
export function concatTypedArrays<T extends TypedArray>(arrays: readonly T[]): T {
  if (arrays.length === 0) throw new Error('concatTypedArrays requires at least one array');
  const first = arrays[0];
  const Type = first.constructor as TypedArrayConstructor<T>;
  let total = 0;
  for (const array of arrays) total += array.length;
  const result = new Type(total);
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

/** Removes duplicate primitives while preserving first-seen order. */
export function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

/** Flattens one level of nesting. */
export function flatten<T>(values: readonly (T | readonly T[])[]): T[] {
  const result: T[] = [];
  for (const value of values) {
    if (Array.isArray(value)) result.push(...(value as T[]));
    else result.push(value as T);
  }
  return result;
}

/** Splits `values` into chunks of at most `size` elements. */
export function chunk<T>(values: readonly T[], size: number): T[][] {
  if (size <= 0) throw new RangeError('chunk size must be greater than zero');
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

/** Returns the element-wise sum of two equal-length numeric arrays. */
export function addArrays(a: readonly number[], b: readonly number[]): number[] {
  const n = Math.min(a.length, b.length);
  const result = new Array<number>(n);
  for (let i = 0; i < n; i++) result[i] = a[i] + b[i];
  return result;
}

/** Returns `values` scaled element-wise by `scalar`. */
export function scaleArray(values: readonly number[], scalar: number): number[] {
  const result = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) result[i] = values[i] * scalar;
  return result;
}

/** Index of the largest element, or `-1` for an empty array. */
export function argMax(values: readonly number[]): number {
  let best = -1;
  let bestValue = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > bestValue) {
      bestValue = values[i];
      best = i;
    }
  }
  return best;
}

/** Index of the smallest element, or `-1` for an empty array. */
export function argMin(values: readonly number[]): number {
  let best = -1;
  let bestValue = Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < bestValue) {
      bestValue = values[i];
      best = i;
    }
  }
  return best;
}

/** Binary search for `value` in a sorted array; returns the insertion index. */
export function binarySearch(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const midValue = values[mid];
    if (midValue === value) return mid;
    if (midValue < value) low = mid + 1;
    else high = mid - 1;
  }
  return low;
}

/** Resizes an array in place to `length`, filling new slots with `fill`. */
export function resize<T>(values: T[], length: number, fill: T): T[] {
  while (values.length < length) values.push(fill);
  values.length = Math.max(0, length);
  return values;
}

/** Fisher-Yates shuffle, returning a new array. */
export function shuffle<T>(values: readonly T[], random: () => number = Math.random): T[] {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return result;
}

/** Rotates `values` left by `offset` positions. */
export function rotate<T>(values: readonly T[], offset: number): T[] {
  const n = values.length;
  if (n === 0) return [];
  const k = ((offset % n) + n) % n;
  return values.slice(k).concat(values.slice(0, k));
}

/** Compares two numeric arrays element-wise with a tolerance. */
export function arraysEqual(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  tolerance: number = 0,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > tolerance) return false;
  }
  return true;
}

/** Converts an array of numbers into a `Float32Array` sharing no memory. */
export function toFloat32(values: readonly number[]): Float32Array {
  const result = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) result[i] = values[i];
  return result;
}

/** Converts an array of numbers into a `Uint32Array`. */
export function toUint32(values: readonly number[]): Uint32Array {
  const result = new Uint32Array(values.length);
  for (let i = 0; i < values.length; i++) result[i] = values[i];
  return result;
}

/** Converts an array of numbers into a `Uint16Array` (indices). */
export function toUint16(values: readonly number[]): Uint16Array {
  const result = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) result[i] = values[i];
  return result;
}
