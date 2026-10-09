/**
 * `Box2` — an axis-aligned 2D bounding box stored as `min`/`max` corners.
 *
 * The box is *empty* when `min` is greater than `max` on any axis, which is
 * what {@link Box2.makeEmpty} arranges with `+Infinity`/`-Infinity` corners and
 * what {@link Box2.isEmpty} detects. An empty box is the identity for
 * {@link Box2.expandByPoint} and {@link Box2.union}, so boxes are usually built
 * by starting empty and folding points into them.
 *
 * Mutators return `this`; read/compute methods take an optional `target` so hot
 * loops stay allocation-free:
 *
 * ```ts
 * const box = new Box2().setFromPoints(points);
 * box.getCenter(target);              // reuses `target`
 * const merged = box.union(otherBox); // allocates
 * box.union(otherBox, target);        // does not
 * ```
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import type { Vec2Source } from '../types';
import { Vec2 } from './Vec2';
import type { RectLike } from './Rect';

/** Scratch buffer for single-operand coercion. */
const _a = new Vec2();

/** Second scratch buffer, needed where two operands are live at once. */
const _b = new Vec2();

/** An axis-aligned 2D bounding box. */
export class Box2 {
  /** Lower corner; `+Infinity` on both axes while the box is empty. */
  public min: Vec2;

  /** Upper corner; `-Infinity` on both axes while the box is empty. */
  public max: Vec2;

  /**
   * Creates a box from two corners.
   *
   * Both arguments are coerced with `Vec2.from` and **copied**, never aliased.
   * With no arguments the box starts empty.
   */
  constructor(min?: Vec2Source, max?: Vec2Source) {
    this.min = min === undefined ? Vec2.infinity() : Vec2.from(min);
    this.max = max === undefined ? Vec2.negativeInfinity() : Vec2.from(max);
  }

  /* ---------------------------------------------------------------- static */

  /** Returns an empty box (`min = +Infinity`, `max = -Infinity`). */
  public static empty(target: Box2 = new Box2()): Box2 {
    return target.makeEmpty();
  }

  /** Fits a box around every point in `points`. */
  public static fromPoints(points: readonly Vec2Source[], target: Box2 = new Box2()): Box2 {
    return target.setFromPoints(points);
  }

  /** Builds a box of the given size centred on `center`. */
  public static fromCenterAndSize(
    center: Vec2Source,
    size: Vec2Source,
    target: Box2 = new Box2(),
  ): Box2 {
    return target.setFromCenterAndSize(center, size);
  }

  /** Builds a box from a `{ x, y, width, height }` rectangle. */
  public static fromRect(rect: RectLike, target: Box2 = new Box2()): Box2 {
    return target.fromRect(rect);
  }

  /* -------------------------------------------------------------- geometry */

  /** Resets the box to its empty state. */
  public makeEmpty(): this {
    this.min.set(Infinity, Infinity);
    this.max.set(-Infinity, -Infinity);
    return this;
  }

  /** `true` when the box contains no volume. */
  public isEmpty(): boolean {
    return this.max.x < this.min.x || this.max.y < this.min.y;
  }

  /** Sets both corners. */
  public set(min: Vec2Source, max: Vec2Source): this {
    this.min.copy(min);
    this.max.copy(max);
    return this;
  }

  /** Fits the box around every point in `points`; no points yields an empty box. */
  public setFromPoints(points: readonly Vec2Source[]): this {
    this.makeEmpty();
    for (let i = 0; i < points.length; i++) this.expandByPoint(points[i]);
    return this;
  }

  /** Places the box around `center` with the given full `size`. */
  public setFromCenterAndSize(center: Vec2Source, size: Vec2Source): this {
    const c = _a.copy(center);
    const s = _b.copy(size);
    this.min.copy(c).addScaledVector(s, -0.5);
    this.max.copy(c).addScaledVector(s, 0.5);
    return this;
  }

  /**
   * Sets the box from a `{ x, y, width, height }` rectangle.
   *
   * Negative extents are stored as-is, which leaves the box empty; normalise
   * the rectangle first if that is not what you want.
   */
  public fromRect(rect: RectLike): this {
    this.min.set(rect.x, rect.y);
    this.max.set(rect.x + rect.width, rect.y + rect.height);
    return this;
  }

  /**
   * Writes the box as a `{ x, y, width, height }` rectangle.
   *
   * An empty box yields an all-zero rectangle rather than infinities.
   */
  public toRect(target: RectLike = { x: 0, y: 0, width: 0, height: 0 }): RectLike {
    if (this.isEmpty()) {
      target.x = 0;
      target.y = 0;
      target.width = 0;
      target.height = 0;
      return target;
    }
    target.x = this.min.x;
    target.y = this.min.y;
    target.width = this.max.x - this.min.x;
    target.height = this.max.y - this.min.y;
    return target;
  }

  /** Copies both corners from `box`. */
  public copy(box: Box2): this {
    this.min.copy(box.min);
    this.max.copy(box.max);
    return this;
  }

  /** Returns a new box with the same corners. */
  public clone(): Box2 {
    return new Box2(this.min, this.max);
  }

  /* ------------------------------------------------------------- expansion */

  /** Grows the box so that it contains `point`. */
  public expandByPoint(point: Vec2Source): this {
    const p = _a.copy(point);
    if (p.x < this.min.x) this.min.x = p.x;
    if (p.y < this.min.y) this.min.y = p.y;
    if (p.x > this.max.x) this.max.x = p.x;
    if (p.y > this.max.y) this.max.y = p.y;
    return this;
  }

  /** Grows the box by `vector` in both directions. */
  public expandByVector(vector: Vec2Source): this {
    const v = _a.copy(vector);
    this.min.sub(v);
    this.max.add(v);
    return this;
  }

  /** Grows the box by `scalar` in every direction. */
  public expandByScalar(scalar: number): this {
    this.min.subScalar(scalar);
    this.max.addScalar(scalar);
    return this;
  }

  /* -------------------------------------------------------------- set maths */

  /**
   * Smallest box containing both `this` and `box`, written into `target`.
   *
   * Non-mutating: `this` is left untouched even when `target` is omitted.
   */
  public union(box: Box2, target: Box2 = new Box2()): Box2 {
    const minX = Math.min(this.min.x, box.min.x);
    const minY = Math.min(this.min.y, box.min.y);
    const maxX = Math.max(this.max.x, box.max.x);
    const maxY = Math.max(this.max.y, box.max.y);
    target.min.set(minX, minY);
    target.max.set(maxX, maxY);
    return target;
  }

  /**
   * Overlap of `this` and `box`, written into `target`.
   *
   * Non-mutating; a disjoint pair yields an empty result.
   */
  public intersect(box: Box2, target: Box2 = new Box2()): Box2 {
    const minX = Math.max(this.min.x, box.min.x);
    const minY = Math.max(this.min.y, box.min.y);
    const maxX = Math.min(this.max.x, box.max.x);
    const maxY = Math.min(this.max.y, box.max.y);
    target.min.set(minX, minY);
    target.max.set(maxX, maxY);
    return target;
  }

  /* --------------------------------------------------------------- queries */

  /** `true` when the two boxes overlap or touch. */
  public intersectsBox(box: Box2): boolean {
    return !(
      box.max.x < this.min.x ||
      box.min.x > this.max.x ||
      box.max.y < this.min.y ||
      box.min.y > this.max.y
    );
  }

  /** `true` when `point` lies inside or on the boundary. */
  public containsPoint(point: Vec2Source): boolean {
    const p = _a.copy(point);
    return (
      p.x >= this.min.x && p.x <= this.max.x && p.y >= this.min.y && p.y <= this.max.y
    );
  }

  /** `true` when `box` lies entirely inside or on the boundary. */
  public containsBox(box: Box2): boolean {
    return (
      this.min.x <= box.min.x &&
      box.max.x <= this.max.x &&
      this.min.y <= box.min.y &&
      box.max.y <= this.max.y
    );
  }

  /** Nearest point of the box to `point`, written into `target`. */
  public clampPoint(point: Vec2Source, target: Vec2 = new Vec2()): Vec2 {
    return target.copy(point).clamp(this.min, this.max);
  }

  /** Distance from `point` to the box (`0` when it is inside). */
  public distanceToPoint(point: Vec2Source): number {
    const p = _b.copy(point);
    _a.copy(p).clamp(this.min, this.max);
    return _a.distanceTo(p);
  }

  /** Returns the box centre; an empty box reports `(0, 0)`. */
  public getCenter(target: Vec2 = new Vec2()): Vec2 {
    if (this.isEmpty()) return target.set(0, 0);
    return target.set((this.min.x + this.max.x) * 0.5, (this.min.y + this.max.y) * 0.5);
  }

  /** Returns the full extent of the box; an empty box reports `(0, 0)`. */
  public getSize(target: Vec2 = new Vec2()): Vec2 {
    if (this.isEmpty()) return target.set(0, 0);
    return target.set(this.max.x - this.min.x, this.max.y - this.min.y);
  }

  /** Moves the box by `offset`. */
  public translate(offset: Vec2Source): this {
    const o = _a.copy(offset);
    this.min.add(o);
    this.max.add(o);
    return this;
  }

  /** `true` when both corners match within `tolerance`. */
  public equals(box: Box2, tolerance: number = EPSILON): boolean {
    return this.min.equals(box.min, tolerance) && this.max.equals(box.max, tolerance);
  }

  /* ---------------------------------------------------------------- output */

  /** `[min.x, min.y, max.x, max.y]`. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    this.min.toArray(target, offset);
    this.max.toArray(target, offset + 2);
    return target;
  }

  /** JSON-friendly representation of both corners. */
  public toJSON(): { min: { x: number; y: number }; max: { x: number; y: number } } {
    return { min: this.min.toJSON(), max: this.max.toJSON() };
  }

  /** `"Box2(min=[x, y], max=[x, y])"`, rounded to `precision` digits. */
  public toString(precision: number = 4): string {
    return `Box2(min=${this.min.toString(precision)}, max=${this.max.toString(precision)})`;
  }
}
