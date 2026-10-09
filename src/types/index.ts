/**
 * Shared type vocabulary used across module boundaries.
 *
 * @packageDocumentation
 */

export type {
  BackendName,
} from '../constants';

/** A 2/3/4 component vector expressed as a plain array literal. */
export type Vector2Like = { x: number; y: number };
export type Vector3Like = { x: number; y: number; z: number };
export type Vector4Like = { x: number; y: number; z: number; w: number };
export type AnyVectorLike = Vector2Like | Vector3Like | Vector4Like;

/** A quaternion expressed as a plain object literal. */
export type QuaternionLike = { x: number; y: number; z: number; w: number };

/** Euler angles in radians. */
export type EulerLike = { x: number; y: number; z: number; order?: string };

/** RGBA colour channels in the 0..1 range. */
export type ColorLike = { r: number; g: number; b: number; a?: number };

/**
 * Anything the math layer can coerce into a `Vec3`.
 *
 * The tuple form is a plain mutable `[x, y, z]` (not `readonly`) because
 * `Array.isArray` does not narrow `readonly` tuples; callers with a readonly
 * tuple can spread it into `Vec3.from`.
 */
export type Vec3Source = Vector3Like | [number, number, number] | number;

/** Anything the math layer can coerce into a `Vec2`. */
export type Vec2Source = Vector2Like | [number, number] | number;

/** A 4x4 matrix in column-major order. */
export type Mat4Elements = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

/** A 3x3 matrix in column-major order. */
export type Mat3Elements = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

/** A 2x2 matrix in column-major order. */
export type Mat2Elements = readonly [number, number, number, number];

/** Element type accepted by a `BufferAttribute`. */
export type TypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

/** Constructor signature shared by every typed array. */
export type TypedArrayConstructor<T extends TypedArray = TypedArray> = {
  new (length: number): T;
  new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): T;
  readonly BYTES_PER_ELEMENT: number;
};

/** A plain JSON value. */
export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

/** A plain, string-keyed record. */
export type Dictionary<T = unknown> = Record<string, T>;

/** Deep-partial helper used by option objects. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Constructor type. */
export type Constructor<T = object> = new (...args: any[]) => T;

/** Abstract constructor type. */
export type AbstractConstructor<T = object> = abstract new (...args: any[]) => T;

/** Nullable helper. */
export type Nullable<T> = T | null;

/** Maybe-promise helper. */
export type Awaitable<T> = T | Promise<T>;

/** A resource that can be explicitly released. */
export interface IDisposable {
  dispose(): void;
}

/** Types that participate in the renderer lifecycle. */
export type LifecycleState = 'created' | 'initialized' | 'disposed';

/** Sortable priority: lower numbers render earlier. */
export type RenderOrder = number;

/** Identifier type used throughout the library. */
export type ID = string;

/** Callback invoked with no arguments. */
export type Listener = (...args: any[]) => void;
