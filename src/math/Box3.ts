/**
 * `Box3` — an axis-aligned 3D bounding box stored as `min`/`max` corners.
 *
 * Semantics match {@link Box2}: the box is empty while `min` exceeds `max` on
 * any axis, {@link Box3.makeEmpty} produces that state with infinite corners,
 * and an empty box is the identity for {@link Box3.expandByPoint} and
 * {@link Box3.union}.
 *
 * Mutators return `this`; {@link Box3.union} and {@link Box3.intersect} are
 * non-mutating and write into an optional `target`.
 *
 * ```ts
 * const box = new Box3().setFromPoints(points);
 * box.getCenter(center);            // reuses `center`
 * box.applyMat4(matrix);            // transforms all eight corners
 * ```
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import type { Vec3Source } from '../types';
import { Vec3 } from './Vec3';
import type { Mat4 } from './Mat4';
import type { Plane } from './Plane';
import type { Sphere } from './Sphere';

/** Scratch buffer for single-operand coercion. */
const _a = new Vec3();

/** Second scratch buffer, needed where two operands are live at once. */
const _b = new Vec3();

/** Scratch corners reused by {@link Box3.applyMat4}. */
const _corners: Vec3[] = [
  new Vec3(),
  new Vec3(),
  new Vec3(),
  new Vec3(),
  new Vec3(),
  new Vec3(),
  new Vec3(),
  new Vec3(),
];

/** An axis-aligned 3D bounding box. */
export class Box3 {
  /** Lower corner; `+Infinity` on every axis while the box is empty. */
  public min: Vec3;

  /** Upper corner; `-Infinity` on every axis while the box is empty. */
  public max: Vec3;

  /**
   * Creates a box from two corners.
   *
   * Both arguments are coerced with `Vec3.from` and **copied**, never aliased.
   * With no arguments the box starts empty.
   */
  constructor(min?: Vec3Source, max?: Vec3Source) {
    this.min = min === undefined ? Vec3.infinity() : Vec3.from(min);
    this.max = max === undefined ? Vec3.negativeInfinity() : Vec3.from(max);
  }

  /* ---------------------------------------------------------------- static */

  /** Returns an empty box (`min = +Infinity`, `max = -Infinity`). */
  public static empty(target: Box3 = new Box3()): Box3 {
    return target.makeEmpty();
  }

  /** Fits a box around every point in `points`. */
  public static fromPoints(points: readonly Vec3Source[], target: Box3 = new Box3()): Box3 {
    return target.setFromPoints(points);
  }

  /** Builds a box of the given size centred on `center`. */
  public static fromCenterAndSize(
    center: Vec3Source,
    size: Vec3Source,
    target: Box3 = new Box3(),
  ): Box3 {
    return target.setFromCenterAndSize(center, size);
  }

  /* -------------------------------------------------------------- geometry */

  /** Resets the box to its empty state. */
  public makeEmpty(): this {
    this.min.set(Infinity, Infinity, Infinity);
    this.max.set(-Infinity, -Infinity, -Infinity);
    return this;
  }

  /** `true` when the box contains no volume. */
  public isEmpty(): boolean {
    return this.max.x < this.min.x || this.max.y < this.min.y || this.max.z < this.min.z;
  }

  /** Sets both corners. */
  public set(min: Vec3Source, max: Vec3Source): this {
    this.min.copy(min);
    this.max.copy(max);
    return this;
  }

  /** Fits the box around every point in `points`; no points yields an empty box. */
  public setFromPoints(points: readonly Vec3Source[]): this {
    this.makeEmpty();
    for (let i = 0; i < points.length; i++) this.expandByPoint(points[i]);
    return this;
  }

  /** Places the box around `center` with the given full `size`. */
  public setFromCenterAndSize(center: Vec3Source, size: Vec3Source): this {
    const c = _a.copy(center);
    const s = _b.copy(size);
    this.min.copy(c).addScaledVector(s, -0.5);
    this.max.copy(c).addScaledVector(s, 0.5);
    return this;
  }

  /** Copies both corners from `box`. */
  public copy(box: Box3): this {
    this.min.copy(box.min);
    this.max.copy(box.max);
    return this;
  }

  /** Returns a new box with the same corners. */
  public clone(): Box3 {
    return new Box3(this.min, this.max);
  }

  /* ------------------------------------------------------------- expansion */

  /** Grows the box so that it contains `point`. */
  public expandByPoint(point: Vec3Source): this {
    this.min.min(_a.copy(point));
    this.max.max(_a);
    return this;
  }

  /** Grows the box by `vector` in both directions. */
  public expandByVector(vector: Vec3Source): this {
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
  public union(box: Box3, target: Box3 = new Box3()): Box3 {
    const minX = Math.min(this.min.x, box.min.x);
    const minY = Math.min(this.min.y, box.min.y);
    const minZ = Math.min(this.min.z, box.min.z);
    const maxX = Math.max(this.max.x, box.max.x);
    const maxY = Math.max(this.max.y, box.max.y);
    const maxZ = Math.max(this.max.z, box.max.z);
    target.min.set(minX, minY, minZ);
    target.max.set(maxX, maxY, maxZ);
    return target;
  }

  /**
   * Overlap of `this` and `box`, written into `target`.
   *
   * Non-mutating; a disjoint pair yields an empty result.
   */
  public intersect(box: Box3, target: Box3 = new Box3()): Box3 {
    const minX = Math.max(this.min.x, box.min.x);
    const minY = Math.max(this.min.y, box.min.y);
    const minZ = Math.max(this.min.z, box.min.z);
    const maxX = Math.min(this.max.x, box.max.x);
    const maxY = Math.min(this.max.y, box.max.y);
    const maxZ = Math.min(this.max.z, box.max.z);
    target.min.set(minX, minY, minZ);
    target.max.set(maxX, maxY, maxZ);
    return target;
  }

  /* ----------------------------------------------------------- transforms */

  /**
   * Transforms all eight corners by a column-major 4x4 matrix.
   *
   * The result is the axis-aligned box that contains the transformed corners,
   * which is the tightest axis-aligned box that can be produced from the
   * corners alone. An empty box is returned unchanged.
   */
  public applyMat4(m: Mat4): this {
    if (this.isEmpty()) return this;

    const minX = this.min.x;
    const minY = this.min.y;
    const minZ = this.min.z;
    const maxX = this.max.x;
    const maxY = this.max.y;
    const maxZ = this.max.z;

    _corners[0].set(minX, minY, minZ);
    _corners[1].set(minX, minY, maxZ);
    _corners[2].set(minX, maxY, minZ);
    _corners[3].set(minX, maxY, maxZ);
    _corners[4].set(maxX, minY, minZ);
    _corners[5].set(maxX, minY, maxZ);
    _corners[6].set(maxX, maxY, minZ);
    _corners[7].set(maxX, maxY, maxZ);

    this.makeEmpty();
    for (let i = 0; i < 8; i++) {
      _corners[i].applyMat4(m);
      this.expandByPoint(_corners[i]);
    }
    return this;
  }

  /** Moves the box by `offset`. */
  public translate(offset: Vec3Source): this {
    const o = _a.copy(offset);
    this.min.add(o);
    this.max.add(o);
    return this;
  }

  /* --------------------------------------------------------------- queries */

  /** `true` when the two boxes overlap or touch. */
  public intersectsBox(box: Box3): boolean {
    return !(
      box.max.x < this.min.x ||
      box.min.x > this.max.x ||
      box.max.y < this.min.y ||
      box.min.y > this.max.y ||
      box.max.z < this.min.z ||
      box.min.z > this.max.z
    );
  }

  /** `true` when the box overlaps `sphere`, or fully contains it. */
  public intersectsSphere(sphere: Sphere): boolean {
    if (this.isEmpty() || sphere.isEmpty()) return false;
    _a.copy(sphere.center).clamp(this.min, this.max);
    return _a.distanceToSquared(sphere.center) <= sphere.radius * sphere.radius;
  }

  /**
   * `true` when the box straddles `plane`.
   *
   * Computes the extreme plane-space projections of the box and checks whether
   * the plane constant falls between them, so the test is exact and allocation
   * free.
   */
  public intersectsPlane(plane: Plane): boolean {
    const nx = plane.normal.x;
    const ny = plane.normal.y;
    const nz = plane.normal.z;

    let min: number;
    let max: number;

    if (nx > 0) {
      min = nx * this.min.x;
      max = nx * this.max.x;
    } else {
      min = nx * this.max.x;
      max = nx * this.min.x;
    }
    if (ny > 0) {
      min += ny * this.min.y;
      max += ny * this.max.y;
    } else {
      min += ny * this.max.y;
      max += ny * this.min.y;
    }
    if (nz > 0) {
      min += nz * this.min.z;
      max += nz * this.max.z;
    } else {
      min += nz * this.max.z;
      max += nz * this.min.z;
    }

    return min <= -plane.constant && max >= -plane.constant;
  }

  /** `true` when `point` lies inside or on the boundary. */
  public containsPoint(point: Vec3Source): boolean {
    const p = _a.copy(point);
    return (
      p.x >= this.min.x &&
      p.x <= this.max.x &&
      p.y >= this.min.y &&
      p.y <= this.max.y &&
      p.z >= this.min.z &&
      p.z <= this.max.z
    );
  }

  /** `true` when `box` lies entirely inside or on the boundary. */
  public containsBox(box: Box3): boolean {
    return (
      this.min.x <= box.min.x &&
      box.max.x <= this.max.x &&
      this.min.y <= box.min.y &&
      box.max.y <= this.max.y &&
      this.min.z <= box.min.z &&
      box.max.z <= this.max.z
    );
  }

  /** Nearest point of the box to `point`, written into `target`. */
  public clampPoint(point: Vec3Source, target: Vec3 = new Vec3()): Vec3 {
    return target.copy(point).clamp(this.min, this.max);
  }

  /** Distance from `point` to the box (`0` when it is inside). */
  public distanceToPoint(point: Vec3Source): number {
    const p = _b.copy(point);
    _a.copy(p).clamp(this.min, this.max);
    return _a.distanceTo(p);
  }

  /** Returns the box centre; an empty box reports `(0, 0, 0)`. */
  public getCenter(target: Vec3 = new Vec3()): Vec3 {
    if (this.isEmpty()) return target.set(0, 0, 0);
    return target.set(
      (this.min.x + this.max.x) * 0.5,
      (this.min.y + this.max.y) * 0.5,
      (this.min.z + this.max.z) * 0.5,
    );
  }

  /** Returns the full extent of the box; an empty box reports `(0, 0, 0)`. */
  public getSize(target: Vec3 = new Vec3()): Vec3 {
    if (this.isEmpty()) return target.set(0, 0, 0);
    return target.set(
      this.max.x - this.min.x,
      this.max.y - this.min.y,
      this.max.z - this.min.z,
    );
  }

  /** `true` when both corners match within `tolerance`. */
  public equals(box: Box3, tolerance: number = EPSILON): boolean {
    return this.min.equals(box.min, tolerance) && this.max.equals(box.max, tolerance);
  }

  /* ---------------------------------------------------------------- output */

  /** `[min.x, min.y, min.z, max.x, max.y, max.z]`. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    this.min.toArray(target, offset);
    this.max.toArray(target, offset + 3);
    return target;
  }

  /** JSON-friendly representation of both corners. */
  public toJSON(): {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  } {
    return { min: this.min.toJSON(), max: this.max.toJSON() };
  }

  /** `"Box3(min=[x, y, z], max=[x, y, z])"`, rounded to `precision` digits. */
  public toString(precision: number = 4): string {
    return `Box3(min=${this.min.toString(precision)}, max=${this.max.toString(precision)})`;
  }
}
