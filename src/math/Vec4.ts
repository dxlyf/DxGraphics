/**
 * `Vec4` — a mutable 4D vector with a chainable API.
 *
 * Every method that mutates returns `this` so calls compose; every method that
 * reads takes an optional target so hot loops can avoid allocation:
 *
 * ```ts
 * const a = new Vec4(1, 2, 3, 1);
 * const b = new Vec4(4, 5, 6, 0);
 * const sum = a.clone().add(b);           // allocates
 * a.addVectors(a, b);                      // reuses `a`
 * ```
 *
 * `w` defaults to `1`, which is the value that makes
 * {@link Vec4.applyMat4} behave like a point transformation; pass `0` to
 * transform a direction.
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import { clamp, lerp, sign } from '../utils/MathUtils';

/**
 * Minimal structural view of a 4x4 matrix.
 *
 * `Vec4` only ever reads the sixteen coefficients in column-major order, so it
 * accepts `Mat4` (which exposes `elements`), an array-like column-major list,
 * or any object that can report a coefficient through `getComponent`. Keeping
 * this structural is what lets `Vec4` stay free of a runtime import of `Mat4`.
 */
export interface Vec4Mat4Like {
  /** Column-major coefficients, as `Mat4` and `Mat3` expose them. */
  readonly elements?: ArrayLike<number>;
  /** Element at `row`, `column` (column-major storage); optional alternative. */
  getComponent?(row: number, column: number): number;
}

/**
 * Reads element `row`, `column` of a **column-major** matrix.
 *
 * Storage is `elements[column * size + row]`, so the stride has to be derived
 * from the array length: 16 entries mean a 4x4 matrix, 9 mean a 3x3 one.
 */
function matrixElement(m: Vec4Mat4Like, row: number, column: number): number {
  if (typeof m.getComponent === 'function') return m.getComponent(row, column);
  const elements = m.elements;
  if (elements === undefined) {
    throw new TypeError('Vec4.applyMat4: matrix exposes neither `elements` nor `getComponent`');
  }
  const size = elements.length === 9 ? 3 : 4;
  return elements[column * size + row];
}

/** Plain 4-component object accepted by every `Vec4` entry point. */
export interface Vec4Like {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** A 4D vector. */
export class Vec4 {
  /** X component. */
  public x: number;

  /** Y component. */
  public y: number;

  /** Z component. */
  public z: number;

  /** W component; `1` for points, `0` for directions. */
  public w: number;

  /** Creates a vector; components default to the origin with `w = 1`. */
  constructor(x: number = 0, y: number = 0, z: number = 0, w: number = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  /* ---------------------------------------------------------------- static */

  /** The zero vector `(0, 0, 0, 0)`. */
  public static zero(): Vec4 {
    return new Vec4(0, 0, 0, 0);
  }

  /** The one vector `(1, 1, 1, 1)`. */
  public static one(): Vec4 {
    return new Vec4(1, 1, 1, 1);
  }

  /** The unit vector along `+X`. */
  public static unitX(): Vec4 {
    return new Vec4(1, 0, 0, 0);
  }

  /** The unit vector along `+Y`. */
  public static unitY(): Vec4 {
    return new Vec4(0, 1, 0, 0);
  }

  /** The unit vector along `+Z`. */
  public static unitZ(): Vec4 {
    return new Vec4(0, 0, 1, 0);
  }

  /** The unit vector along `+W`. */
  public static unitW(): Vec4 {
    return new Vec4(0, 0, 0, 1);
  }

  /** Coerces an array or object literal into a `Vec4` (allocating). */
  public static from(source: Vec4Like | readonly number[]): Vec4 {
    if (Array.isArray(source)) {
      const values = source as readonly number[];
      return new Vec4(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1);
    }
    const like = source as Vec4Like;
    return new Vec4(like.x, like.y, like.z, like.w);
  }

  /* ----------------------------------------------------------- accessors */

  /** Returns the component at `index` (`0` = x, `1` = y, `2` = z, `3` = w). */
  public getComponent(index: number): number {
    switch (index) {
      case 0:
        return this.x;
      case 1:
        return this.y;
      case 2:
        return this.z;
      case 3:
        return this.w;
      default:
        return 0;
    }
  }

  /** Writes the component at `index`, ignoring out-of-range indices. */
  public setComponent(index: number, value: number): this {
    if (index === 0) this.x = value;
    else if (index === 1) this.y = value;
    else if (index === 2) this.z = value;
    else if (index === 3) this.w = value;
    return this;
  }

  /** Sets every component; `y`, `z` and `w` default to `x`. */
  public set(x: number, y: number = x, z: number = x, w: number = x): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  /** Sets every component to `scalar`. */
  public setScalar(scalar: number): this {
    return this.set(scalar, scalar, scalar, scalar);
  }

  /** Copies another vector (or plain object/array) into this one. */
  public copy(source: Vec4Like | readonly number[]): this {
    if (Array.isArray(source)) {
      const values = source as readonly number[];
      return this.set(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1);
    }
    const like = source as Vec4Like;
    return this.set(like.x, like.y, like.z, like.w);
  }

  /** Returns a new vector with the same components. */
  public clone(): Vec4 {
    return new Vec4(this.x, this.y, this.z, this.w);
  }

  /** Writes the components into `target` and returns it. */
  public to(target: Vec4Like): Vec4Like {
    target.x = this.x;
    target.y = this.y;
    target.z = this.z;
    target.w = this.w;
    return target;
  }

  /** `[x, y, z, w]`. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    target[offset] = this.x;
    target[offset + 1] = this.y;
    target[offset + 2] = this.z;
    target[offset + 3] = this.w;
    return target;
  }

  /** `Float32Array` view of the components. */
  public toFloat32Array(target: Float32Array = new Float32Array(4), offset: number = 0): Float32Array {
    target[offset] = this.x;
    target[offset + 1] = this.y;
    target[offset + 2] = this.z;
    target[offset + 3] = this.w;
    return target;
  }

  /* ------------------------------------------------------------- algebra */

  /** Adds `other`, component-wise. */
  public add(other: Vec4Like): this {
    this.x += other.x;
    this.y += other.y;
    this.z += other.z;
    this.w += other.w;
    return this;
  }

  /** Adds a scalar to every component. */
  public addScalar(scalar: number): this {
    this.x += scalar;
    this.y += scalar;
    this.z += scalar;
    this.w += scalar;
    return this;
  }

  /** `this = a + b`. */
  public addVectors(a: Vec4Like, b: Vec4Like): this {
    this.x = a.x + b.x;
    this.y = a.y + b.y;
    this.z = a.z + b.z;
    this.w = a.w + b.w;
    return this;
  }

  /** Adds `other` scaled by `scale`. */
  public addScaledVector(other: Vec4Like, scale: number): this {
    this.x += other.x * scale;
    this.y += other.y * scale;
    this.z += other.z * scale;
    this.w += other.w * scale;
    return this;
  }

  /** Subtracts `other`, component-wise. */
  public sub(other: Vec4Like): this {
    this.x -= other.x;
    this.y -= other.y;
    this.z -= other.z;
    this.w -= other.w;
    return this;
  }

  /** Subtracts a scalar from every component. */
  public subScalar(scalar: number): this {
    this.x -= scalar;
    this.y -= scalar;
    this.z -= scalar;
    this.w -= scalar;
    return this;
  }

  /** `this = a - b`. */
  public subVectors(a: Vec4Like, b: Vec4Like): this {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    this.w = a.w - b.w;
    return this;
  }

  /** Multiplies component-wise by `other`. */
  public multiply(other: Vec4Like): this {
    this.x *= other.x;
    this.y *= other.y;
    this.z *= other.z;
    this.w *= other.w;
    return this;
  }

  /** Multiplies every component by a scalar. */
  public multiplyScalar(scalar: number): this {
    this.x *= scalar;
    this.y *= scalar;
    this.z *= scalar;
    this.w *= scalar;
    return this;
  }

  /** `this = a * b`, component-wise. */
  public multiplyVectors(a: Vec4Like, b: Vec4Like): this {
    this.x = a.x * b.x;
    this.y = a.y * b.y;
    this.z = a.z * b.z;
    this.w = a.w * b.w;
    return this;
  }

  /** Divides component-wise by `other`, leaving zero divisors untouched. */
  public divide(other: Vec4Like): this {
    if (other.x !== 0) this.x /= other.x;
    if (other.y !== 0) this.y /= other.y;
    if (other.z !== 0) this.z /= other.z;
    if (other.w !== 0) this.w /= other.w;
    return this;
  }

  /** Divides every component by a scalar; a zero scalar is ignored. */
  public divideScalar(scalar: number): this {
    return this.multiplyScalar(scalar === 0 ? 1 : 1 / scalar);
  }

  /** Negates every component. */
  public negate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    this.w = -this.w;
    return this;
  }

  /** Absolute value of every component. */
  public abs(): this {
    this.x = Math.abs(this.x);
    this.y = Math.abs(this.y);
    this.z = Math.abs(this.z);
    this.w = Math.abs(this.w);
    return this;
  }

  /** Rounds every component towards negative infinity. */
  public floor(): this {
    this.x = Math.floor(this.x);
    this.y = Math.floor(this.y);
    this.z = Math.floor(this.z);
    this.w = Math.floor(this.w);
    return this;
  }

  /** Rounds every component towards positive infinity. */
  public ceil(): this {
    this.x = Math.ceil(this.x);
    this.y = Math.ceil(this.y);
    this.z = Math.ceil(this.z);
    this.w = Math.ceil(this.w);
    return this;
  }

  /** Rounds every component to the nearest integer. */
  public round(): this {
    this.x = Math.round(this.x);
    this.y = Math.round(this.y);
    this.z = Math.round(this.z);
    this.w = Math.round(this.w);
    return this;
  }

  /** Keeps the sign of each component, discarding magnitude. */
  public sign(): this {
    this.x = sign(this.x);
    this.y = sign(this.y);
    this.z = sign(this.z);
    this.w = sign(this.w);
    return this;
  }

  /** Keeps the fractional part of each component. */
  public fract(): this {
    this.x -= Math.floor(this.x);
    this.y -= Math.floor(this.y);
    this.z -= Math.floor(this.z);
    this.w -= Math.floor(this.w);
    return this;
  }

  /** Clamps every component into `[min, max]`; scalars apply to all four. */
  public clamp(min: number | Vec4Like, max: number | Vec4Like): this {
    const minX = typeof min === 'number' ? min : min.x;
    const minY = typeof min === 'number' ? min : min.y;
    const minZ = typeof min === 'number' ? min : min.z;
    const minW = typeof min === 'number' ? min : min.w;
    const maxX = typeof max === 'number' ? max : max.x;
    const maxY = typeof max === 'number' ? max : max.y;
    const maxZ = typeof max === 'number' ? max : max.z;
    const maxW = typeof max === 'number' ? max : max.w;
    this.x = clamp(this.x, minX, maxX);
    this.y = clamp(this.y, minY, maxY);
    this.z = clamp(this.z, minZ, maxZ);
    this.w = clamp(this.w, minW, maxW);
    return this;
  }

  /* ------------------------------------------------------------ products */

  /** Dot product with `other`. */
  public dot(other: Vec4Like): number {
    return this.x * other.x + this.y * other.y + this.z * other.z + this.w * other.w;
  }

  /** Euclidean length. */
  public length(): number {
    return Math.sqrt(this.lengthSquared());
  }

  /** Squared length (cheaper than {@link length}). */
  public lengthSquared(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
  }

  /** Scales to unit length. A zero vector is left untouched. */
  public normalize(): this {
    const length = this.length();
    return length === 0 ? this : this.divideScalar(length);
  }

  /** Sets the length to `length`, keeping the direction. */
  public setLength(length: number): this {
    return this.normalize().multiplyScalar(length);
  }

  /** Distance to `other`. */
  public distanceTo(other: Vec4Like): number {
    return Math.sqrt(this.distanceToSquared(other));
  }

  /** Squared distance to `other`. */
  public distanceToSquared(other: Vec4Like): number {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    const dz = this.z - other.z;
    const dw = this.w - other.w;
    return dx * dx + dy * dy + dz * dz + dw * dw;
  }

  /** Linear interpolation towards `other` by `t`. */
  public lerp(other: Vec4Like, t: number): this {
    this.x = lerp(this.x, other.x, t);
    this.y = lerp(this.y, other.y, t);
    this.z = lerp(this.z, other.z, t);
    this.w = lerp(this.w, other.w, t);
    return this;
  }

  /** Linear interpolation towards `other` by `t` with Hermite smoothing. */
  public smoothLerp(other: Vec4Like, t: number): this {
    const s = t * t * (3 - 2 * t);
    return this.lerp(other, s);
  }

  /* ------------------------------------------------------------- matrix */

  /**
   * Applies a column-major 4x4 matrix to this vector.
   *
   * The full homogeneous product is computed, `w` included, so a perspective
   * matrix divides through by the transformed `w` (three.js semantics). The
   * divide is skipped when `w === 0`, which leaves direction vectors and
   * points at infinity untouched.
   */
  public applyMat4(m: Vec4Mat4Like): this {
    const x = this.x;
    const y = this.y;
    const z = this.z;
    const w = this.w;

    // `matrixElement(row, column)` already resolves the column-major storage, so
    // the four "column" groups below must be named by COLUMN, not by row: the
    // vector's `x` multiplies column 0, `y` column 1, `z` column 2 and `w`
    // column 3. Treating `m03` (row 0 of column 3, i.e. the translation) as the
    // `w` coefficient is the classic transpose bug this code avoids.
    const outX =
      matrixElement(m, 0, 0) * x +
      matrixElement(m, 0, 1) * y +
      matrixElement(m, 0, 2) * z +
      matrixElement(m, 0, 3) * w;
    const outY =
      matrixElement(m, 1, 0) * x +
      matrixElement(m, 1, 1) * y +
      matrixElement(m, 1, 2) * z +
      matrixElement(m, 1, 3) * w;
    const outZ =
      matrixElement(m, 2, 0) * x +
      matrixElement(m, 2, 1) * y +
      matrixElement(m, 2, 2) * z +
      matrixElement(m, 2, 3) * w;
    const outW =
      matrixElement(m, 3, 0) * x +
      matrixElement(m, 3, 1) * y +
      matrixElement(m, 3, 2) * z +
      matrixElement(m, 3, 3) * w;

    this.x = outX;
    this.y = outY;
    this.z = outZ;
    this.w = outW;

    // Three.js semantics: divide whenever the transformed `w` is non-zero, so a
    // w = 0 direction vector stays a direction (a point at infinity).
    if (outW !== 0) {
      this.x = outX / outW;
      this.y = outY / outW;
      this.z = outZ / outW;
      this.w = 1;
    }
    return this;
  }

  /* ------------------------------------------------------------ queries */

  /** `true` when every component is exactly zero. */
  public isZero(): boolean {
    return this.x === 0 && this.y === 0 && this.z === 0 && this.w === 0;
  }

  /** `true` when every component is finite. */
  public isFinite(): boolean {
    return (
      Number.isFinite(this.x) &&
      Number.isFinite(this.y) &&
      Number.isFinite(this.z) &&
      Number.isFinite(this.w)
    );
  }

  /** `true` when the vector has unit length within `tolerance`. */
  public isNormalized(tolerance: number = EPSILON): boolean {
    return Math.abs(this.lengthSquared() - 1) <= tolerance;
  }

  /** `true` when every component equals `other` within `tolerance`. */
  public equals(other: Vec4Like, tolerance: number = EPSILON): boolean {
    return (
      Math.abs(this.x - other.x) <= tolerance &&
      Math.abs(this.y - other.y) <= tolerance &&
      Math.abs(this.z - other.z) <= tolerance &&
      Math.abs(this.w - other.w) <= tolerance
    );
  }

  /* ------------------------------------------------------------ output */

  /** `"[x, y, z, w]"` with each component rounded to `precision` digits. */
  public toString(precision: number = 4): string {
    return `[${this.x.toFixed(precision)}, ${this.y.toFixed(precision)}, ${this.z.toFixed(
      precision,
    )}, ${this.w.toFixed(precision)}]`;
  }

  /** JSON-friendly representation. */
  public toJSON(): { x: number; y: number; z: number; w: number } {
    return { x: this.x, y: this.y, z: this.z, w: this.w };
  }

  /** Iterates over the components (`0` = x … `3` = w). */
  public *[Symbol.iterator](): IterableIterator<number> {
    yield this.x;
    yield this.y;
    yield this.z;
    yield this.w;
  }
}

/** Creates a `Vec4`; components default to the origin with `w = 1`. */
export function vec4(x: number = 0, y: number = 0, z: number = 0, w: number = 1): Vec4 {
  return new Vec4(x, y, z, w);
}
