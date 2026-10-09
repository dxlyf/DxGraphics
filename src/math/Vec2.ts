/**
 * `Vec2` — a mutable 2D vector with a chainable API.
 *
 * Every method that mutates returns `this` so calls compose; every method that
 * reads takes an optional target so hot loops can avoid allocation:
 *
 * ```ts
 * const a = new Vec2(1, 2);
 * const b = new Vec2(3, 4);
 * const sum = a.clone().add(b);          // allocates
 * a.addVectors(a, b);                     // reuses `a`
 * ```
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import type { Vec2Source } from '../types';
import { clamp, lerp } from '../utils/MathUtils';

/** A 2D vector. */
export class Vec2 {
  /** Backing field for {@link Vec2.x}. */
  private _x: number;

  /** Backing field for {@link Vec2.y}. */
  private _y: number;

  /**
   * Optional observer invoked whenever a component, or the vector as a whole,
   * is mutated. Used by 2D transforms to invalidate cached matrices; `null` by
   * default so standalone maths stays allocation-free.
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

  /** Creates a vector; defaults to the origin. */
  constructor(x: number = 0, y: number = x) {
    this._x = x;
    this._y = y;
  }

  /** Fires {@link Vec2.onChange} explicitly for direct backing-field writes. */
  public notifyChange(): this {
    this.onChange?.();
    return this;
  }

  /* ---------------------------------------------------------------- static */

  /** The zero vector `(0, 0)`. */
  public static zero(): Vec2 {
    return new Vec2(0, 0);
  }

  /** The one vector `(1, 1)`. */
  public static one(): Vec2 {
    return new Vec2(1, 1);
  }

  /** The unit vector along `+X`. */
  public static unitX(): Vec2 {
    return new Vec2(1, 0);
  }

  /** The unit vector along `+Y`. */
  public static unitY(): Vec2 {
    return new Vec2(0, 1);
  }

  /** `(Infinity, Infinity)`; convenient as an "empty" AABB starting point. */
  public static infinity(): Vec2 {
    return new Vec2(Infinity, Infinity);
  }

  /** `(-Infinity, -Infinity)`. */
  public static negativeInfinity(): Vec2 {
    return new Vec2(-Infinity, -Infinity);
  }

  /** Coerces a number or object literal into a `Vec2` (allocating when needed). */
  public static from(source: Vec2Source): Vec2 {
    if (typeof source === 'number') return new Vec2(source, source);
    if (Array.isArray(source)) return new Vec2(source[0] ?? 0, source[1] ?? 0);
    return new Vec2(source.x, source.y);
  }

  /** Distance between two points. */
  public static distanceBetween(a: Vec2, b: Vec2): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** Squared distance between two points (avoids the square root). */
  public static distanceSquaredBetween(a: Vec2, b: Vec2): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  /** Interpolates between two vectors without allocating. */
  public static lerpVectors(a: Vec2, b: Vec2, t: number, target = new Vec2()): Vec2 {
    return target.set(lerp(a.x, b.x, t), lerp(a.y, b.y, t));
  }

  /** Signed angle from `a` to `b`, in radians, in `(-PI, PI]`. */
  public static angleBetween(a: Vec2, b: Vec2): number {
    return Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
  }

  /** `true` when every component is within `tolerance`. */
  public static equals(a: Vec2, b: Vec2, tolerance: number = EPSILON): boolean {
    return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
  }

  /* ----------------------------------------------------------- accessors */

  /** Returns the component at `index` (`0` = x, `1` = y, `2` = 0). */
  public getComponent(index: number): number {
    switch (index) {
      case 0:
        return this.x;
      case 1:
        return this.y;
      default:
        return 0;
    }
  }

  /** Writes the component at `index`, ignoring out-of-range indices. */
  public setComponent(index: number, value: number): this {
    if (index === 0) this.x = value;
    else if (index === 1) this.y = value;
    return this;
  }

  /** Sets both components, notifying {@link Vec2.onChange} at most once. */
  public set(x: number, y: number = x): this {
    this._x = x;
    this._y = y;
    this.onChange?.();
    return this;
  }

  /** Copies another vector (or plain object) into this one. */
  public copy(source: Vec2Source): this {
    if (typeof source === 'number') return this.set(source, source);
    if (Array.isArray(source)) return this.set(source[0] ?? 0, source[1] ?? 0);
    return this.set(source.x, source.y);
  }

  /** Returns a new vector with the same components. */
  public clone(): Vec2 {
    return new Vec2(this.x, this.y);
  }

  /** Writes the components into `target` and returns it. */
  public to(target: { x: number; y: number }): { x: number; y: number } {
    target.x = this.x;
    target.y = this.y;
    return target;
  }

  /** `[x, y]`. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    target[offset] = this.x;
    target[offset + 1] = this.y;
    return target;
  }

  /** `Float32Array` view of the components. */
  public toFloat32Array(target: Float32Array = new Float32Array(2), offset: number = 0): Float32Array {
    target[offset] = this.x;
    target[offset + 1] = this.y;
    return target;
  }

  /* ------------------------------------------------------------- algebra */

  /** Adds `other`, component-wise. */
  public add(other: Vec2Source): this {
    const x = typeof other === 'number' ? other : (other as any).x;
    const y = typeof other === 'number' ? other : Array.isArray(other) ? other[1] : (other as any).y;
    this.x += x;
    this.y += y;
    return this;
  }

  /** Adds a scalar to both components. */
  public addScalar(scalar: number): this {
    this.x += scalar;
    this.y += scalar;
    return this;
  }

  /** `this = a + b`. */
  public addVectors(a: Vec2Source, b: Vec2Source): this {
    const ax = typeof a === 'number' ? a : Array.isArray(a) ? a[0] : (a as any).x;
    const ay = typeof a === 'number' ? a : Array.isArray(a) ? a[1] : (a as any).y;
    const bx = typeof b === 'number' ? b : Array.isArray(b) ? b[0] : (b as any).x;
    const by = typeof b === 'number' ? b : Array.isArray(b) ? b[1] : (b as any).y;
    this.x = ax + bx;
    this.y = ay + by;
    return this;
  }

  /** Adds `other` scaled by `scale`. */
  public addScaledVector(other: Vec2, scale: number): this {
    this.x += other.x * scale;
    this.y += other.y * scale;
    return this;
  }

  /** Subtracts `other`, component-wise. */
  public sub(other: Vec2Source): this {
    const x = typeof other === 'number' ? other : Array.isArray(other) ? other[0] : (other as any).x;
    const y = typeof other === 'number' ? other : Array.isArray(other) ? other[1] : (other as any).y;
    this.x -= x;
    this.y -= y;
    return this;
  }

  /** Subtracts a scalar from both components. */
  public subScalar(scalar: number): this {
    this.x -= scalar;
    this.y -= scalar;
    return this;
  }

  /** `this = a - b`. */
  public subVectors(a: Vec2, b: Vec2): this {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    return this;
  }

  /** Multiplies component-wise by `other`. */
  public multiply(other: Vec2Source): this {
    const x = typeof other === 'number' ? other : Array.isArray(other) ? other[0] : (other as any).x;
    const y = typeof other === 'number' ? other : Array.isArray(other) ? other[1] : (other as any).y;
    this.x *= x;
    this.y *= y;
    return this;
  }

  /** Multiplies both components by a scalar. */
  public multiplyScalar(scalar: number): this {
    this.x *= scalar;
    this.y *= scalar;
    return this;
  }

  /** `this = a * b`, component-wise. */
  public multiplyVectors(a: Vec2, b: Vec2): this {
    this.x = a.x * b.x;
    this.y = a.y * b.y;
    return this;
  }

  /** Divides component-wise by `other`, leaving zero divisors untouched. */
  public divide(other: Vec2Source): this {
    const x = typeof other === 'number' ? other : Array.isArray(other) ? other[0] : (other as any).x;
    const y = typeof other === 'number' ? other : Array.isArray(other) ? other[1] : (other as any).y;
    if (x !== 0) this.x /= x;
    if (y !== 0) this.y /= y;
    return this;
  }

  /** Divides both components by a scalar. */
  public divideScalar(scalar: number): this {
    return this.multiplyScalar(scalar === 0 ? 1 : 1 / scalar);
  }

  /** Negates both components. */
  public negate(): this {
    this.x = -this.x;
    this.y = -this.y;
    return this;
  }

  /** Rounds every component towards negative infinity. */
  public floor(): this {
    this.x = Math.floor(this.x);
    this.y = Math.floor(this.y);
    return this;
  }

  /** Rounds every component towards positive infinity. */
  public ceil(): this {
    this.x = Math.ceil(this.x);
    this.y = Math.ceil(this.y);
    return this;
  }

  /** Rounds every component to the nearest integer. */
  public round(): this {
    this.x = Math.round(this.x);
    this.y = Math.round(this.y);
    return this;
  }

  /** Keeps the sign of each component, discarding magnitude. */
  public sign(): this {
    this.x = Math.sign(this.x);
    this.y = Math.sign(this.y);
    return this;
  }

  /** Keeps the fractional part of each component. */
  public fract(): this {
    this.x -= Math.floor(this.x);
    this.y -= Math.floor(this.y);
    return this;
  }

  /** Absolute value of each component. */
  public abs(): this {
    this.x = Math.abs(this.x);
    this.y = Math.abs(this.y);
    return this;
  }

  /** Clamps each component into `[min, max]`. */
  public clamp(min: number | Vec2, max: number | Vec2): this {
    const minX = typeof min === 'number' ? min : min.x;
    const minY = typeof min === 'number' ? min : min.y;
    const maxX = typeof max === 'number' ? max : max.x;
    const maxY = typeof max === 'number' ? max : max.y;
    this.x = clamp(this.x, minX, maxX);
    this.y = clamp(this.y, minY, maxY);
    return this;
  }

  /** Clamps each component into `[0, 1]`. */
  public clamp01(): this {
    this.x = clamp(this.x, 0, 1);
    this.y = clamp(this.y, 0, 1);
    return this;
  }

  /** Rounds each component to `step`, preventing drift via `Math.round`. */
  public snap(step: number): this {
    if (step > 0) {
      this.x = Math.round(this.x / step) * step;
      this.y = Math.round(this.y / step) * step;
    }
    return this;
  }

  /* ------------------------------------------------------------ products */

  /** Dot product with `other`. */
  public dot(other: Vec2Source): number {
    const x = typeof other === 'number' ? other : Array.isArray(other) ? other[0] : (other as any).x;
    const y = typeof other === 'number' ? other : Array.isArray(other) ? other[1] : (other as any).y;
    return this.x * x + this.y * y;
  }

  /**
   * 2D cross product (the z component of the 3D cross product).
   *
   * Positive when `other` is counter-clockwise from `this`.
   */
  public cross(other: Vec2): number {
    return this.x * other.y - this.y * other.x;
  }

  /** Euclidean length. */
  public length(): number {
    return Math.hypot(this.x, this.y);
  }

  /** Squared length (cheaper than {@link length}). */
  public lengthSquared(): number {
    return this.x * this.x + this.y * this.y;
  }

  /** Manhattan length `|x| + |y|`. */
  public manhattanLength(): number {
    return Math.abs(this.x) + Math.abs(this.y);
  }

  /** Distance to `other`. */
  public distanceTo(other: Vec2): number {
    return Math.hypot(this.x - other.x, this.y - other.y);
  }

  /** Squared distance to `other`. */
  public distanceToSquared(other: Vec2): number {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    return dx * dx + dy * dy;
  }

  /** Chebyshev distance (largest component delta). */
  public distanceToChebyshev(other: Vec2): number {
    return Math.max(Math.abs(this.x - other.x), Math.abs(this.y - other.y));
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

  /** Clamps the length to at most `max`. */
  public clampLength(max: number): this {
    const length = this.length();
    return length > max && length > 0 ? this.multiplyScalar(max / length) : this;
  }

  /** Linear interpolation towards `other` by `t`. */
  public lerp(other: Vec2, t: number): this {
    this.x = lerp(this.x, other.x, t);
    this.y = lerp(this.y, other.y, t);
    return this;
  }

  /** Angle of the vector measured from `+X`, in radians. */
  public angle(): number {
    return Math.atan2(this.y, this.x);
  }

  /** Rotates around the origin by `radians`. */
  public rotateAround(radians: number): this {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const x = this.x;
    const y = this.y;
    this.x = x * cos - y * sin;
    this.y = x * sin + y * cos;
    return this;
  }

  /** Rotates around `center` by `radians`. */
  public rotateAroundPoint(center: Vec2, radians: number): this {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const dx = this.x - center.x;
    const dy = this.y - center.y;
    this.x = center.x + dx * cos - dy * sin;
    this.y = center.y + dx * sin + dy * cos;
    return this;
  }

  /** Rotates 90 degrees counter-clockwise: `(x, y) -> (-y, x)`. */
  public perp(): this {
    const x = this.x;
    this.x = -this.y;
    this.y = x;
    return this;
  }

  /** Reflects across the line through the origin with direction `normal`. */
  public reflect(normal: Vec2): this {
    const factor = 2 * this.dot(normal);
    this.x -= normal.x * factor;
    this.y -= normal.y * factor;
    return this;
  }

  /** Moves the vector `amount` towards `target`, without overshooting. */
  public moveTowards(target: Vec2, amount: number): this {
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= amount || distance === 0) return this.copy(target);
    this.x += (dx / distance) * amount;
    this.y += (dy / distance) * amount;
    return this;
  }

  /** Linear interpolation towards `other` by `t`, wrapping into `[0, 1]`. */
  public smoothLerp(other: Vec2, t: number): this {
    const s = t * t * (3 - 2 * t);
    return this.lerp(other, s);
  }

  /* ------------------------------------------------------------ queries */

  /** `true` when both components are exactly zero. */
  public isZero(): boolean {
    return this.x === 0 && this.y === 0;
  }

  /** `true` when every component is finite. */
  public isFinite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y);
  }

  /** `true` when the vector has unit length within `tolerance`. */
  public isNormalized(tolerance: number = EPSILON): boolean {
    return Math.abs(this.lengthSquared() - 1) <= tolerance;
  }

  /** `true` when every component equals `other` within `tolerance`. */
  public equals(other: Vec2Source, tolerance: number = EPSILON): boolean {
    const x = typeof other === 'number' ? other : Array.isArray(other) ? other[0] : (other as any).x;
    const y = typeof other === 'number' ? other : Array.isArray(other) ? other[1] : (other as any).y;
    return Math.abs(this.x - x) <= tolerance && Math.abs(this.y - y) <= tolerance;
  }

  /* ------------------------------------------------------------ output */

  /** `"[x, y]"` with each component rounded to `precision` digits. */
  public toString(precision: number = 4): string {
    return `[${this.x.toFixed(precision)}, ${this.y.toFixed(precision)}]`;
  }

  /** JSON-friendly representation. */
  public toJSON(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  /** Iterates over the components (`0` = x, `1` = y). */
  public *[Symbol.iterator](): IterableIterator<number> {
    yield this.x;
    yield this.y;
  }
}

/** Creates a `Vec2` from a number, array or object literal. */
export function vec2(x: number = 0, y: number = x): Vec2 {
  return new Vec2(x, y);
}
