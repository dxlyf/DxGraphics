/**
 * Object / record helpers.
 *
 * @packageDocumentation
 */

import type { Dictionary } from '../types';

/** `true` when `value` is a non-null plain object (not an array, not a view). */
export function isPlainObject(value: unknown): value is Dictionary {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Type-safe `Object.keys`. */
export function keys<T extends object>(value: T): (keyof T & string)[] {
  return Object.keys(value) as (keyof T & string)[];
}

/** Type-safe `Object.entries`. */
export function entries<T extends object>(value: T): [keyof T & string, T[keyof T & string]][] {
  return Object.entries(value) as [keyof T & string, T[keyof T & string]][];
}

/** Type-safe `Object.values`. */
export function values<T extends object>(value: T): T[keyof T & string][] {
  return Object.values(value) as T[keyof T & string][];
}

/** Returns a shallow copy of `value` with `key` removed. */
export function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const result = { ...value };
  delete result[key];
  return result as Omit<T, K>;
}

/** Returns a shallow copy of `value` with only `keysToKeep` retained. */
export function pick<T extends object, K extends keyof T>(value: T, keysToKeep: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keysToKeep) {
    if (key in value) result[key] = value[key];
  }
  return result;
}

/**
 * Deep merge of plain objects.
 *
 * Arrays are replaced wholesale (not concatenated) and class instances are
 * assigned by reference, which is what descriptor/option merging needs.
 */
export function merge<T extends Dictionary>(target: T, ...sources: Dictionary[]): T {
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      const current = (target as Dictionary)[key];
      if (isPlainObject(current) && isPlainObject(value)) {
        merge(current as Dictionary, value as Dictionary);
      } else if (value !== undefined) {
        (target as Dictionary)[key] = value;
      }
    }
  }
  return target;
}

/** Recursively clones plain objects/arrays, preserving typed arrays. */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as { slice(): unknown };
    return view.slice() as T;
  }
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as unknown as T;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (value instanceof Map) {
    const map = new Map();
    value.forEach((v, k) => map.set(k, deepClone(v)));
    return map as unknown as T;
  }
  if (value instanceof Set) {
    const set = new Set();
    value.forEach((v) => set.add(deepClone(v)));
    return set as unknown as T;
  }
  if (!isPlainObject(value)) return value;
  const result: Dictionary = {};
  for (const [key, item] of Object.entries(value as Dictionary)) {
    result[key] = deepClone(item);
  }
  return result as T;
}

/** Recursive deep equality for plain data (objects, arrays, typed arrays, primitives). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    const va = a as unknown as ArrayLike<number>;
    const vb = b as unknown as ArrayLike<number>;
    if (va.length !== vb.length) return false;
    for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const oa = a as Dictionary;
  const ob = b as Dictionary;
  const ka = Object.keys(oa);
  const kb = Object.keys(ob);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.prototype.hasOwnProperty.call(ob, key)) return false;
    if (!deepEqual(oa[key], ob[key])) return false;
  }
  return true;
}

/**
 * Creates a lazily computed value.
 *
 * The factory runs at most once; subsequent calls return the cached result even
 * when it is `undefined` or `null`.
 */
export function lazy<T>(factory: () => T): () => T {
  let computed = false;
  let result: T;
  return () => {
    if (!computed) {
      result = factory();
      computed = true;
    }
    return result;
  };
}

/** Copies only the own enumerable properties of `source` onto `target`. */
export function assign<T extends object>(target: T, source: Partial<T>): T {
  return Object.assign(target, source);
}

/** `Object.freeze` that keeps the precise input type. */
export function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}

/** Default values applied only where `target[key]` is `undefined`. */
export function defaults<T extends Dictionary>(target: T, fallback: Dictionary): T {
  for (const [key, value] of Object.entries(fallback)) {
    if ((target as Dictionary)[key] === undefined) (target as Dictionary)[key] = value;
  }
  return target;
}

/** Safely reads a nested path (`'a.b.c'`) from an object. */
export function get<T = unknown>(object: unknown, path: string, fallback?: T): T | undefined {
  const parts = path.split('.');
  let current: any = object;
  for (const part of parts) {
    if (current == null) return fallback;
    current = current[part];
  }
  return (current === undefined ? fallback : current) as T;
}

/** Safely writes a nested path, creating intermediate objects as needed. */
export function set(object: Dictionary, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Dictionary = object;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!isPlainObject(current[part])) current[part] = {};
    current = current[part] as Dictionary;
  }
  current[parts[parts.length - 1]] = value;
}

/** Returns a new object without keys whose value is `undefined`. */
export function compact<T extends Dictionary>(value: T): T {
  const result: Dictionary = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item;
  }
  return result as T;
}

/** Maps every own enumerable value through `transform`. */
export function mapValues<T extends Dictionary, R>(
  value: T,
  transform: (item: T[keyof T], key: string) => R,
): Record<string, R> {
  const result: Record<string, R> = {};
  for (const [key, item] of Object.entries(value)) result[key] = transform(item as T[keyof T], key);
  return result;
}
