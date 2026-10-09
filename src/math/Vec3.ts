/**
 * `Vec3` — a mutable 3D vector with a chainable API.
 *
 * Follows the same conventions as {@link Vec2}: mutators return `this`, read
 * methods accept an optional `target` so hot loops stay allocation-free, and
 * every component accessor is a plain field so the JIT keeps them in registers.
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import type { Vec3Source } from '../types';
import { clamp, lerp } from '../utils/MathUtils';
import { Vec2 } from './Vec2';

/** Component names accepted by {@link Vec3.setComponent}. */
export type Vec3Component = 'x' | 'y' | 'z';

/** A 3D vector. */
export class Vec3 {
  /** Backing field for {@link Vec3.x}. */
  private _x: number;

  /** Backing field for {@link Vec3.y}. */
  private _y: number;

  /** Backing field for {@link Vec3.z}. */
  private _z: number;

  /**
   * Optional observer invoked whenever a component, or the vector as a whole,
   * is mutated. Used by `Transform` to keep matrices and Euler angles in sync.
   * Kept `null` by default so standalone maths stays allocation-free.
   */
  public onChange: (() => void) | null = null;

  /** X component. */
  public get x(): number {
    return this._x;
  }

  public set x(value: number) {
    if (value === this._x) return;
    this._x = value;
    this.onChange?.();
  }

  /** Y component. */
  public get y(): number {
    return this._y;
  }

  public set y(value: number) {
    if (value === this._y) return;
    this._y = value;
    this.onChange?.();
  }

  /** Z component. */
  public get z(): number {
    return this._z;
  }

  public set z(value: number) {
    if (value === this._z) return;
    this._z = value;
    this.onChange?.();
  }

  /** Creates a vector; `new Vec3(2)` yields `(2, 2, 2)`. */
  constructor(x: number = 0, y: number = x, z: number = x) {
    this._x = x;
    this._y = y;
    this._z = z;
  }

  /** Fires {@link Vec3.onChange} explicitly for direct backing-field writes. */
  public notifyChange(): this {
    this.onChange?.();
    return this;
  }

  /* ---------------------------------------------------------------- static */

  /** The zero vector. */
  public static zero(): Vec3 {
    return new Vec3(0, 0, 0);
  }

  /** The one vector. */
  public static one(): Vec3 {
    return new Vec3(1, 1, 1);
  }

  /** The unit vector along `+X`. */
  public static unitX(): Vec3 {
    return new Vec3(1, 0, 0);
  }

  /** The unit vector along `+Y`. */
  public static unitY(): Vec3 {
    return new Vec3(0, 1, 0);
  }

  /** The unit vector along `+Z`. */
  public static unitZ(): Vec3 {
    return new Vec3(0, 0, 1);
  }

  /** The up axis used by cameras and lights (`+Y`). */
  public static up(): Vec3 {
    return Vec3.unitY();
  }

  /** `(Infinity, Infinity, Infinity)`. */
  public static infinity(): Vec3 {
    return new Vec3(Infinity, Infinity, Infinity);
  }

  /** `(-Infinity, -Infinity, -Infinity)`. */
  public static negativeInfinity(): Vec3 {
    return new Vec3(-Infinity, -Infinity, -Infinity);
  }

  /** Coerces a number, tuple or object literal into a `Vec3`. */
  public static from(source: Vec3Source): Vec3 {
    if (typeof source === 'number') return new Vec3(source, source, source);
    if (Array.isArray(source)) return new Vec3(source[0] ?? 0, source[1] ?? 0, source[2] ?? 0);
    return new Vec3(source.x, source.y, (source as { z?: number }).z ?? 0);
  }

  /** Distance between two points. */
  public static distanceBetween(a: Vec3, b: Vec3): number {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  /** Interpolates between two vectors into `target`. */
  public static lerpVectors(a: Vec3, b: Vec3, t: number, target: Vec3 = new Vec3()): Vec3 {
    return target.set(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
  }

  /** Component-wise minimum. */
  public static min(a: Vec3, b: Vec3, target: Vec3 = new Vec3()): Vec3 {
    return target.set(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z));
  }

  /** Component-wise maximum. */
  public static max(a: Vec3, b: Vec3, target: Vec3 = new Vec3()): Vec3 {
    return target.set(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z));
  }

  /** Cross product written into `target`. */
  public static crossVectors(a: Vec3, b: Vec3, target: Vec3 = new Vec3()): Vec3 {
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    const bx = b.x;
    const by = b.y;
    const bz = b.z;
    return target.set(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
  }

  /** Dot product. */
  public static dot(a: Vec3, b: Vec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  /** `true` when every component is within `tolerance`. */
  public static equals(a: Vec3, b: Vec3, tolerance: number = EPSILON): boolean {
    return (
      Math.abs(a.x - b.x) <= tolerance &&
      Math.abs(a.y - b.y) <= tolerance &&
      Math.abs(a.z - b.z) <= tolerance
    );
  }

  /** Orthonormal basis built from an arbitrary direction. */
  public static basisFromDirection(
    direction: Vec3,
    target: { u: Vec3; v: Vec3; w: Vec3 } = { u: new Vec3(), v: new Vec3(), w: new Vec3() },
  ): { u: Vec3; v: Vec3; w: Vec3 } {
    const w = target.w.copy(direction).normalize();
    const helper = Math.abs(w.y) > 0.9999 ? Vec3.unitX() : Vec3.unitY();
    target.u.crossVectors(helper, w).normalize();
    target.v.crossVectors(w, target.u).normalize();
    return target;
  }

  /* ----------------------------------------------------------- accessors */

  /** Returns the component at `index` (`0` = x, `1` = y, `2` = z). */
  public getComponent(index: number): number {
    switch (index) {
      case 0:
        return this.x;
      case 1:
        return this.y;
      case 2:
        return this.z;
      default:
        return 0;
    }
  }

  /** Writes the component at `index`. */
  public setComponent(index: number, value: number): this {
    if (index === 0) this.x = value;
    else if (index === 1) this.y = value;
    else if (index === 2) this.z = value;
    return this;
  }

  /** Sets all three components, notifying {@link Vec3.onChange} at most once. */
  public set(x: number, y: number = x, z: number = x): this {
    this._x = x;
    this._y = y;
    this._z = z;
    this.onChange?.();
    return this;
  }

  /** Sets every component to `scalar`. */
  public setScalar(scalar: number): this {
    return this.set(scalar, scalar, scalar);
  }

  /** Copies from another vector, tuple or object literal. */
  public copy(source: Vec3Source): this {
    if (typeof source === 'number') return this.setScalar(source);
    if (Array.isArray(source)) return this.set(source[0] ?? 0, source[1] ?? 0, source[2] ?? 0);
    return this.set(source.x, source.y, (source as { z?: number }).z ?? 0);
  }

  /** Returns a new vector with the same components. */
  public clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }

  /** Copies the components into `target`. */
  public to(target: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    target.x = this.x;
    target.y = this.y;
    target.z = this.z;
    return target;
  }

  /** `[x, y, z]`. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    target[offset] = this.x;
    target[offset + 1] = this.y;
    target[offset + 2] = this.z;
    return target;
  }

  /** Writes into a `Float32Array`. */
  public toFloat32Array(
    target: Float32Array = new Float32Array(3),
    offset: number = 0,
  ): Float32Array {
    target[offset] = this.x;
    target[offset + 1] = this.y;
    target[offset + 2] = this.z;
    return target;
  }

  /** Writes into a `Float64Array`. */
  public toFloat64Array(
    target: Float64Array = new Float64Array(3),
    offset: number = 0,
  ): Float64Array {
    target[offset] = this.x;
    target[offset + 1] = this.y;
    target[offset + 2] = this.z;
    return target;
  }

  /* ------------------------------------------------------------- algebra */

  /** Adds `other`. */
  public add(other: Vec3Source): this {
    if (typeof other === 'number') return this.addScalar(other);
    const v: any = other;
    const x = Array.isArray(other) ? other[0] ?? 0 : v.x;
    const y = Array.isArray(other) ? other[1] ?? 0 : v.y;
    const z = Array.isArray(other) ? other[2] ?? 0 : v.z ?? 0;
    this.x += x;
    this.y += y;
    this.z += z;
    return this;
  }

  /** Adds `scalar` to every component. */
  public addScalar(scalar: number): this {
    this.x += scalar;
    this.y += scalar;
    this.z += scalar;
    return this;
  }

  /** `this = a + b`. */
  public addVectors(a: Vec3, b: Vec3): this {
    this.x = a.x + b.x;
    this.y = a.y + b.y;
    this.z = a.z + b.z;
    return this;
  }

  /** Adds `other` scaled by `scale`. */
  public addScaledVector(other: Vec3, scale: number): this {
    this.x += other.x * scale;
    this.y += other.y * scale;
    this.z += other.z * scale;
    return this;
  }

  /** Subtracts `other`. */
  public sub(other: Vec3Source): this {
    if (typeof other === 'number') return this.subScalar(other);
    const v: any = other;
    const x = Array.isArray(other) ? other[0] ?? 0 : v.x;
    const y = Array.isArray(other) ? other[1] ?? 0 : v.y;
    const z = Array.isArray(other) ? other[2] ?? 0 : v.z ?? 0;
    this.x -= x;
    this.y -= y;
    this.z -= z;
    return this;
  }

  /** Subtracts `scalar` from every component. */
  public subScalar(scalar: number): this {
    this.x -= scalar;
    this.y -= scalar;
    this.z -= scalar;
    return this;
  }

  /** `this = a - b`. */
  public subVectors(a: Vec3, b: Vec3): this {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }

  /** Multiplies component-wise. */
  public multiply(other: Vec3Source): this {
    if (typeof other === 'number') return this.multiplyScalar(other);
    const v: any = other;
    this.x *= Array.isArray(other) ? other[0] ?? 0 : v.x;
    this.y *= Array.isArray(other) ? other[1] ?? 0 : v.y;
    this.z *= Array.isArray(other) ? other[2] ?? 0 : v.z ?? 0;
    return this;
  }

  /** Multiplies every component by `scalar`. */
  public multiplyScalar(scalar: number): this {
    this.x *= scalar;
    this.y *= scalar;
    this.z *= scalar;
    return this;
  }

  /** `this = a * b`, component-wise. */
  public multiplyVectors(a: Vec3, b: Vec3): this {
    this.x = a.x * b.x;
    this.y = a.y * b.y;
    this.z = a.z * b.z;
    return this;
  }

  /** Divides component-wise, leaving zero divisors untouched. */
  public divide(other: Vec3Source): this {
    if (typeof other === 'number') return this.divideScalar(other);
    const v: any = other;
    const x = Array.isArray(other) ? other[0] ?? 0 : v.x;
    const y = Array.isArray(other) ? other[1] ?? 0 : v.y;
    const z = Array.isArray(other) ? other[2] ?? 0 : v.z ?? 0;
    if (x !== 0) this.x /= x;
    if (y !== 0) this.y /= y;
    if (z !== 0) this.z /= z;
    return this;
  }

  /** Divides every component by `scalar`. */
  public divideScalar(scalar: number): this {
    return this.multiplyScalar(scalar === 0 ? 1 : 1 / scalar);
  }

  /** Negates every component. */
  public negate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  /** Absolute value of every component. */
  public abs(): this {
    this.x = Math.abs(this.x);
    this.y = Math.abs(this.y);
    this.z = Math.abs(this.z);
    return this;
  }

  /** Rounds towards negative infinity. */
  public floor(): this {
    this.x = Math.floor(this.x);
    this.y = Math.floor(this.y);
    this.z = Math.floor(this.z);
    return this;
  }

  /** Rounds towards positive infinity. */
  public ceil(): this {
    this.x = Math.ceil(this.x);
    this.y = Math.ceil(this.y);
    this.z = Math.ceil(this.z);
    return this;
  }

  /** Rounds to the nearest integer. */
  public round(): this {
    this.x = Math.round(this.x);
    this.y = Math.round(this.y);
    this.z = Math.round(this.z);
    return this;
  }

  /** Sign of every component. */
  public sign(): this {
    this.x = Math.sign(this.x);
    this.y = Math.sign(this.y);
    this.z = Math.sign(this.z);
    return this;
  }

  /** Fractional part of every component. */
  public fract(): this {
    this.x -= Math.floor(this.x);
    this.y -= Math.floor(this.y);
    this.z -= Math.floor(this.z);
    return this;
  }

  /** Rounds every component to the nearest multiple of `step`. */
  public snap(step: number): this {
    if (step > 0) {
      this.x = Math.round(this.x / step) * step;
      this.y = Math.round(this.y / step) * step;
      this.z = Math.round(this.z / step) * step;
    }
    return this;
  }

  /** Clamps every component into `[min, max]`. */
  public clamp(min: number | Vec3, max: number | Vec3): this {
    const minX = typeof min === 'number' ? min : min.x;
    const minY = typeof min === 'number' ? min : min.y;
    const minZ = typeof min === 'number' ? min : min.z;
    const maxX = typeof max === 'number' ? max : max.x;
    const maxY = typeof max === 'number' ? max : max.y;
    const maxZ = typeof max === 'number' ? max : max.z;
    this.x = clamp(this.x, minX, maxX);
    this.y = clamp(this.y, minY, maxY);
    this.z = clamp(this.z, minZ, maxZ);
    return this;
  }

  /** Clamps every component into `[0, 1]`. */
  public clamp01(): this {
    return this.clamp(0, 1);
  }

  /** Component-wise minimum with `other`. */
  public min(other: Vec3): this {
    this.x = Math.min(this.x, other.x);
    this.y = Math.min(this.y, other.y);
    this.z = Math.min(this.z, other.z);
    return this;
  }

  /** Component-wise maximum with `other`. */
  public max(other: Vec3): this {
    this.x = Math.max(this.x, other.x);
    this.y = Math.max(this.y, other.y);
    this.z = Math.max(this.z, other.z);
    return this;
  }

  /** Rounds each component towards zero. */
  public trunc(): this {
    this.x = Math.trunc(this.x);
    this.y = Math.trunc(this.y);
    this.z = Math.trunc(this.z);
    return this;
  }

  /** Applies `Math.pow` to every component. */
  public pow(exponent: number): this {
    this.x = Math.pow(this.x, exponent);
    this.y = Math.pow(this.y, exponent);
    this.z = Math.pow(this.z, exponent);
    return this;
  }

  /** Scales the vector so the largest absolute component is `1`. */
  public normalizeMax(): this {
    const max = Math.max(Math.abs(this.x), Math.abs(this.y), Math.abs(this.z));
    return max > 0 ? this.divideScalar(max) : this;
  }

  /* ------------------------------------------------------------ products */

  /** Dot product. */
  public dot(other: Vec3Source): number {
    if (typeof other === 'number') return this.x * other + this.y * other + this.z * other;
    if (Array.isArray(other)) {
      return this.x * (other[0] ?? 0) + this.y * (other[1] ?? 0) + this.z * (other[2] ?? 0);
    }
    const v = other as { x: number; y: number; z?: number };
    return this.x * v.x + this.y * v.y + this.z * (v.z ?? 0);
  }

  /** Cross product (`this = this × other`). */
  public cross(other: Vec3): this {
    return this.crossVectors(this, other);
  }

  /** `this = a × b`. */
  public crossVectors(a: Vec3, b: Vec3): this {
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    const bx = b.x;
    const by = b.y;
    const bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }

  /** Euclidean length. */
  public length(): number {
    return Math.hypot(this.x, this.y, this.z);
  }

  /** Squared length. */
  public lengthSquared(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  /** Manhattan length. */
  public manhattanLength(): number {
    return Math.abs(this.x) + Math.abs(this.y) + Math.abs(this.z);
  }

  /** Largest absolute component. */
  public maxComponent(): number {
    return Math.max(Math.abs(this.x), Math.abs(this.y), Math.abs(this.z));
  }

  /** Index of the largest absolute component (`0`, `1` or `2`). */
  public maxComponentIndex(): number {
    const ax = Math.abs(this.x);
    const ay = Math.abs(this.y);
    const az = Math.abs(this.z);
    if (ax >= ay && ax >= az) return 0;
    return ay >= az ? 1 : 2;
  }

  /** Distance to `other`. */
  public distanceTo(other: Vec3): number {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  /** Squared distance to `other`. */
  public distanceToSquared(other: Vec3): number {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    const dz = this.z - other.z;
    return dx * dx + dy * dy + dz * dz;
  }

  /** Manhattan distance to `other`. */
  public manhattanDistanceTo(other: Vec3): number {
    return Math.abs(this.x - other.x) + Math.abs(this.y - other.y) + Math.abs(this.z - other.z);
  }

  /** Scales to unit length; a zero vector is returned unchanged. */
  public normalize(): this {
    const length = this.length();
    return length === 0 ? this : this.divideScalar(length);
  }

  /** Sets the length, keeping direction; a zero vector becomes `(0, 0, length)`. */
  public setLength(length: number): this {
    if (length === 0) return this.set(0, 0, 0);
    const current = this.length();
    return current === 0 ? this.set(0, 0, length) : this.multiplyScalar(length / current);
  }

  /** Clamps the length to `max`. */
  public clampLength(max: number): this {
    const length = this.length();
    return length > max && length > 0 ? this.multiplyScalar(max / length) : this;
  }

  /** Ensures the length is at least `min`. */
  public clampLengthMin(min: number): this {
    const length = this.length();
    return length < min ? this.setLength(min) : this;
  }

  /** Linear interpolation towards `other`. */
  public lerp(other: Vec3, t: number): this {
    this.x = lerp(this.x, other.x, t);
    this.y = lerp(this.y, other.y, t);
    this.z = lerp(this.z, other.z, t);
    return this;
  }

  /** Hermite-smoothed interpolation towards `other`. */
  public smoothLerp(other: Vec3, t: number): this {
    return this.lerp(other, t * t * (3 - 2 * t));
  }

  /**
   * Applies a column-major 4x4 matrix, including translation.
   *
   * Accepts either a `Mat4`-like object exposing a `elements` array or the
   * element array itself, which keeps this module free of a runtime dependency
   * on `Mat4`.
   */
  public applyMat4(m: { elements: ArrayLike<number> } | ArrayLike<number>): this {
    const e: ArrayLike<number> = (m as { elements?: ArrayLike<number> }).elements ?? (m as ArrayLike<number>);
    const x = this.x;
    const y = this.y;
    const z = this.z;
    const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15] || 1);
    this.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
    this.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
    this.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    return this;
  }

  /** Applies a 3x3 matrix (rotation/scale only, no translation). */
  public applyMat3(m: { elements: ArrayLike<number> } | ArrayLike<number>): this {
    const e: ArrayLike<number> =
      (m as { elements?: ArrayLike<number> }).elements ?? (m as ArrayLike<number>);
    const x = this.x;
    const y = this.y;
    const z = this.z;
    this.x = e[0] * x + e[3] * y + e[6] * z;
    this.y = e[1] * x + e[4] * y + e[7] * z;
    this.z = e[2] * x + e[5] * y + e[8] * z;
    return this;
  }

  /** Rotates the vector around a unit `axis` by `angle` radians (Rodrigues). */
  public applyAxisAngle(axis: Vec3, angle: number): this {
    return this.applyQuatElements(axis.x, axis.y, axis.z, angle);
  }

  /** Rotates around `+X` by `angle` radians. */
  public applyRotationX(angle: number): this {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const y = this.y;
    const z = this.z;
    this.y = y * cos - z * sin;
    this.z = y * sin + z * cos;
    return this;
  }

  /** Rotates around `+Y` by `angle` radians. */
  public applyRotationY(angle: number): this {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = this.x;
    const z = this.z;
    this.x = x * cos + z * sin;
    this.z = -x * sin + z * cos;
    return this;
  }

  /** Rotates around `+Z` by `angle` radians. */
  public applyRotationZ(angle: number): this {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = this.x;
    const y = this.y;
    this.x = x * cos - y * sin;
    this.y = x * sin + y * cos;
    return this;
  }

  /**
   * Rotates by a quaternion given as a unit `(x, y, z, w)` tuple.
   *
   * Separated from `applyQuat` so this module needs no import from `Quat`.
   */
  public applyQuatElements(qx: number, qy: number, qz: number, qw: number): this {
    const x = this.x;
    const y = this.y;
    const z = this.z;

    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);

    // v + q.w * t + cross(q.xyz, t)
    this.x = x + qw * tx + (qy * tz - qz * ty);
    this.y = y + qw * ty + (qz * tx - qx * tz);
    this.z = z + qw * tz + (qx * ty - qy * tx);
    return this;
  }

  /** Rotates by a `Quat`-like object. */
  public applyQuat(q: { x: number; y: number; z: number; w: number }): this {
    return this.applyQuatElements(q.x, q.y, q.z, q.w);
  }

  /** Applies a normal matrix: the inverse-transpose of a 3x3 matrix. */
  public applyNormalMat3(m: { elements: ArrayLike<number> } | ArrayLike<number>): this {
    const e: ArrayLike<number> =
      (m as { elements?: ArrayLike<number> }).elements ?? (m as ArrayLike<number>);
    const x = this.x;
    const y = this.y;
    const z = this.z;
    this.x = e[0] * x + e[3] * y + e[6] * z;
    this.y = e[1] * x + e[4] * y + e[7] * z;
    this.z = e[2] * x + e[5] * y + e[8] * z;
    return this.normalize();
  }

  /** Reflects across a plane through the origin with unit `normal`. */
  public reflect(normal: Vec3): this {
    const factor = 2 * this.dot(normal);
    this.x -= normal.x * factor;
    this.y -= normal.y * factor;
    this.z -= normal.z * factor;
    return this;
  }

  /** Portion of `this` that lies along `normal`. */
  public projectOnVector(normal: Vec3): this {
    const denominator = normal.lengthSquared();
    if (denominator === 0) return this.set(0, 0, 0);
    const scalar = this.dot(normal) / denominator;
    return this.copy(normal).multiplyScalar(scalar);
  }

  /** Component of `this` perpendicular to `normal`. */
  public projectOnPlane(planeNormal: Vec3): this {
    const projected = Vec3.prototype.projectOnVector.call(this.clone(), planeNormal);
    return this.sub(projected);
  }

  /** Mirrors the vector across the plane defined by `normal`. */
  public mirror(normal: Vec3): this {
    return this.projectOnPlane(normal).negate().add(this.projectOnVector(normal).multiplyScalar(2));
  }

  /** Angle between `this` and `other`, in radians. */
  public angleTo(other: Vec3): number {
    const denominator = Math.sqrt(this.lengthSquared() * other.lengthSquared());
    if (denominator === 0) return Math.PI / 2;
    const cosine = clamp(this.dot(other) / denominator, -1, 1);
    return Math.acos(cosine);
  }

  /** Moves towards `target` by at most `amount`. */
  public moveTowards(target: Vec3, amount: number): this {
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dz = target.z - this.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= amount || distance === 0) return this.copy(target);
    this.x += (dx / distance) * amount;
    this.y += (dy / distance) * amount;
    this.z += (dz / distance) * amount;
    return this;
  }

  /** Projects onto the XY plane, writing into a `Vec2`. */
  public toVec2(target: Vec2 = new Vec2()): Vec2 {
    return target.set(this.x, this.y);
  }

  /** Spherical coordinates `(radius, phi, theta)` for this vector. */
  public toSpherical(
    target: { radius: number; phi: number; theta: number } = { radius: 0, phi: 0, theta: 0 },
  ): { radius: number; phi: number; theta: number } {
    const radius = this.length();
    target.radius = radius;
    if (radius === 0) {
      target.phi = 0;
      target.theta = 0;
    } else {
      target.theta = Math.atan2(this.x, this.z);
      target.phi = Math.acos(clamp(this.y / radius, -1, 1));
    }
    return target;
  }

  /** Reads spherical coordinates `(radius, phi, theta)` into cartesian form. */
  public setFromSpherical(
    spherical: { radius: number; phi: number; theta: number },
    isDegrees: boolean = false,
  ): this {
    const phi = isDegrees ? (spherical.phi * Math.PI) / 180 : spherical.phi;
    const theta = isDegrees ? (spherical.theta * Math.PI) / 180 : spherical.theta;
    const sinPhiRadius = Math.sin(phi) * spherical.radius;
    return this.set(
      sinPhiRadius * Math.sin(theta),
      Math.cos(phi) * spherical.radius,
      sinPhiRadius * Math.cos(theta),
    );
  }

  /** Cylindrical coordinates `(radius, theta, y)`. */
  public toCylindrical(
    target: { radius: number; theta: number; y: number } = { radius: 0, theta: 0, y: 0 },
  ): { radius: number; theta: number; y: number } {
    target.radius = Math.hypot(this.x, this.z);
    target.theta = Math.atan2(this.x, this.z);
    target.y = this.y;
    return target;
  }

  /** Reads cylindrical coordinates into cartesian form. */
  public setFromCylindrical(cylindrical: { radius: number; theta: number; y: number }): this {
    return this.set(
      cylindrical.radius * Math.sin(cylindrical.theta),
      cylindrical.y,
      cylindrical.radius * Math.cos(cylindrical.theta),
    );
  }

  /** Reads a `Mat4` column (mirrors three.js `setFromMatrixColumn`). */
  public fromArray(array: ArrayLike<number>, offset: number = 0): this {
    return this.set(array[offset] ?? 0, array[offset + 1] ?? 0, array[offset + 2] ?? 0);
  }

  /** Reads the translation component (column 3) of a column-major 4x4 matrix. */
  public setFromMatrixPosition(m: { elements: ArrayLike<number> } | ArrayLike<number>): this {
    const e: ArrayLike<number> =
      (m as { elements?: ArrayLike<number> }).elements ?? (m as ArrayLike<number>);
    return this.set(e[12] ?? 0, e[13] ?? 0, e[14] ?? 0);
  }

  /** Reads a column of a column-major 4x4 matrix (`index` in `0..3`). */
  public setFromMatrixColumn(m: { elements: ArrayLike<number> } | ArrayLike<number>, index: number): this {
    const e: ArrayLike<number> =
      (m as { elements?: ArrayLike<number> }).elements ?? (m as ArrayLike<number>);
    const offset = index * 4;
    return this.set(e[offset] ?? 0, e[offset + 1] ?? 0, e[offset + 2] ?? 0);
  }

  /** Reads the lengths of the three basis columns of a column-major 4x4 matrix. */
  public setFromMatrixScale(m: { elements: ArrayLike<number> } | ArrayLike<number>): this {
    const e: ArrayLike<number> =
      (m as { elements?: ArrayLike<number> }).elements ?? (m as ArrayLike<number>);
    return this.set(
      Math.hypot(e[0] ?? 0, e[1] ?? 0, e[2] ?? 0),
      Math.hypot(e[4] ?? 0, e[5] ?? 0, e[6] ?? 0),
      Math.hypot(e[8] ?? 0, e[9] ?? 0, e[10] ?? 0),
    );
  }

  /* ------------------------------------------------------------ queries */

  /** `true` when every component is exactly zero. */
  public isZero(): boolean {
    return this.x === 0 && this.y === 0 && this.z === 0;
  }

  /** `true` when every component is finite. */
  public isFinite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z);
  }

  /** `true` when the vector has unit length within `tolerance`. */
  public isNormalized(tolerance: number = EPSILON): boolean {
    return Math.abs(this.lengthSquared() - 1) <= tolerance;
  }

  /** `true` when the vector lies on the given axis. */
  public isOnAxis(axis: Vec3, tolerance: number = EPSILON): boolean {
    return this.clone().cross(axis).lengthSquared() <= tolerance;
  }

  /** `true` when every component matches `other` within `tolerance`. */
  public equals(other: Vec3Source, tolerance: number = EPSILON): boolean {
    const v = Vec3.from(other);
    return (
      Math.abs(this.x - v.x) <= tolerance &&
      Math.abs(this.y - v.y) <= tolerance &&
      Math.abs(this.z - v.z) <= tolerance
    );
  }

  /* ------------------------------------------------------------ output */

  /** `"[x, y, z]"`, rounded to `precision` digits. */
  public toString(precision: number = 4): string {
    return `[${this.x.toFixed(precision)}, ${this.y.toFixed(precision)}, ${this.z.toFixed(precision)}]`;
  }

  /** JSON-friendly representation. */
  public toJSON(): { x: number; y: number; z: number } {
    return { x: this.x, y: this.y, z: this.z };
  }

  /** Iterates over `x`, `y`, `z`. */
  public *[Symbol.iterator](): IterableIterator<number> {
    yield this.x;
    yield this.y;
    yield this.z;
  }
}

/** Creates a `Vec3`. */
export function vec3(x: number = 0, y: number = x, z: number = x): Vec3 {
  return new Vec3(x, y, z);
}
