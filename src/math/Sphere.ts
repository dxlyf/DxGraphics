/**
 * `Sphere` — a bounding sphere defined by a `center` and a `radius`.
 *
 * A sphere is *empty* while `radius` is negative; {@link Sphere.makeEmpty}
 * arranges that and {@link Sphere.isEmpty} detects it. Unlike an empty
 * {@link Box3}, an empty sphere cannot be grown point by point — use
 * {@link Sphere.setFromPoints}, which also handles the empty point list.
 *
 * Mutators return `this`; read/compute methods take an optional `target` so hot
 * loops stay allocation-free.
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import type { Vec3Source } from '../types';
import { Vec3 } from './Vec3';
import { Box3 } from './Box3';
import type { Mat4 } from './Mat4';
import type { Plane } from './Plane';

/** Scratch buffer for single-operand coercion. */
const _a = new Vec3();

/** Second scratch buffer, needed where two operands are live at once. */
const _b = new Vec3();

/** A bounding sphere. */
export class Sphere {
  /** Sphere centre. */
  public center: Vec3;

  /** Sphere radius; negative means "empty". */
  public radius: number;

  /**
   * Creates a sphere.
   *
   * `center` is coerced with `Vec3.from` and **copied**, never aliased. The
   * default `radius` of `-1` produces an empty sphere.
   */
  constructor(center?: Vec3Source, radius: number = -1) {
    this.center = center === undefined ? Vec3.zero() : Vec3.from(center);
    this.radius = radius;
  }

  /* ---------------------------------------------------------------- static */

  /** Returns an empty sphere (centre at the origin, radius `-1`). */
  public static empty(target: Sphere = new Sphere()): Sphere {
    return target.makeEmpty();
  }

  /** Builds a sphere enclosing `points` using the naive centroid fit. */
  public static fromPoints(
    points: readonly Vec3Source[],
    optionalCenter?: Vec3Source,
    target: Sphere = new Sphere(),
  ): Sphere {
    return target.setFromPoints(points, optionalCenter);
  }

  /* -------------------------------------------------------------- geometry */

  /** Sets the centre and radius. */
  public set(center: Vec3Source, radius: number): this {
    this.center.copy(center);
    this.radius = radius;
    return this;
  }

  /**
   * Fits a sphere around every point in `points`.
   *
   * The centre is the centroid of the points (or `optionalCenter` when given)
   * and the radius is the largest distance from that centre to any point.
   *
   * **This is not the minimal enclosing sphere.** It is the cheap
   * two-pass approximation every bounding-volume hierarchy uses, and it can be
   * up to about 15% larger than the optimal fit. Use a dedicated
   * minimal-enclosing-sphere routine when tightness matters more than cost.
   *
   * An empty `points` array leaves the sphere empty.
   */
  public setFromPoints(points: readonly Vec3Source[], optionalCenter?: Vec3Source): this {
    if (points.length === 0) return this.makeEmpty();

    const center = optionalCenter === undefined ? _a.set(0, 0, 0) : _a.copy(optionalCenter);
    if (optionalCenter === undefined) {
      for (let i = 0; i < points.length; i++) center.add(points[i]);
      center.divideScalar(points.length);
    }

    this.center.copy(center);

    let radius = 0;
    for (let i = 0; i < points.length; i++) {
      const distance = _b.copy(points[i]).distanceTo(center);
      if (distance > radius) radius = distance;
    }
    this.radius = radius;
    return this;
  }

  /** Resets the sphere to its empty state. */
  public makeEmpty(): this {
    this.center.set(0, 0, 0);
    this.radius = -1;
    return this;
  }

  /** `true` when the radius is negative. */
  public isEmpty(): boolean {
    return this.radius < 0;
  }

  /** Copies the centre and radius from `sphere`. */
  public copy(sphere: Sphere): this {
    this.center.copy(sphere.center);
    this.radius = sphere.radius;
    return this;
  }

  /** Returns a new sphere with the same centre and radius. */
  public clone(): Sphere {
    return new Sphere(this.center, this.radius);
  }

  /* ----------------------------------------------------------- transforms */

  /**
   * Transforms the sphere by a column-major 4x4 matrix.
   *
   * The centre is transformed as a point and the radius is scaled by the
   * largest column length of the matrix (its maximum scale on any axis), which
   * keeps the sphere conservative under non-uniform scaling. An empty sphere is
   * returned unchanged.
   */
  public applyMat4(m: Mat4): this {
    if (this.isEmpty()) return this;
    this.center.applyMat4(m);
    this.radius *= m.getMaxScaleOnAxis();
    return this;
  }

  /** Moves the centre by `offset`. */
  public translate(offset: Vec3Source): this {
    this.center.add(_a.copy(offset));
    return this;
  }

  /* --------------------------------------------------------------- queries */

  /** `true` when `point` lies inside or on the surface. */
  public containsPoint(point: Vec3Source): boolean {
    if (this.isEmpty()) return false;
    return _a.copy(point).distanceToSquared(this.center) <= this.radius * this.radius;
  }

  /** Distance from `point` to the surface; negative inside the sphere. */
  public distanceToPoint(point: Vec3Source): number {
    return _a.copy(point).distanceTo(this.center) - this.radius;
  }

  /** `true` when the two spheres overlap or touch. */
  public intersectsSphere(other: Sphere): boolean {
    if (this.isEmpty() || other.isEmpty()) return false;
    const sum = this.radius + other.radius;
    return _a.copy(other.center).distanceToSquared(this.center) <= sum * sum;
  }

  /** `true` when the sphere overlaps `box`, or fully contains it. */
  public intersectsBox(box: Box3): boolean {
    if (this.isEmpty()) return false;
    return box.distanceToPoint(this.center) <= this.radius;
  }

  /**
   * `true` when the sphere straddles `plane`.
   *
   * When `target` is supplied it receives the point of the plane closest to the
   * sphere centre: that is the touch point when the sphere merely touches the
   * plane, and the centre of the intersection circle when it cuts through.
   */
  public intersectsPlane(plane: Plane, target?: Vec3): boolean {
    if (this.isEmpty()) return false;
    const distance = plane.distanceToPoint(this.center);
    if (distance < -this.radius || distance > this.radius) return false;
    if (target !== undefined) plane.projectPoint(this.center, target);
    return true;
  }

  /** Nearest point of the sphere to `point`, written into `target`. */
  public clampPoint(point: Vec3Source, target: Vec3 = new Vec3()): Vec3 {
    if (this.isEmpty()) return target.copy(point);
    const radiusSquared = this.radius * this.radius;
    if (_a.copy(point).distanceToSquared(this.center) > radiusSquared) {
      return target
        .copy(point)
        .sub(this.center)
        .normalize()
        .multiplyScalar(this.radius)
        .add(this.center);
    }
    return target.copy(point);
  }

  /** Axis-aligned box that encloses the sphere; empty for an empty sphere. */
  public getBoundingBox(target: Box3 = new Box3()): Box3 {
    if (this.isEmpty()) return target.makeEmpty();
    target.min.set(
      this.center.x - this.radius,
      this.center.y - this.radius,
      this.center.z - this.radius,
    );
    target.max.set(
      this.center.x + this.radius,
      this.center.y + this.radius,
      this.center.z + this.radius,
    );
    return target;
  }

  /** `true` when the centres match and the radii agree within `tolerance`. */
  public equals(other: Sphere, tolerance: number = EPSILON): boolean {
    return (
      this.center.equals(other.center, tolerance) &&
      Math.abs(this.radius - other.radius) <= tolerance
    );
  }

  /* ---------------------------------------------------------------- output */

  /** `[center.x, center.y, center.z, radius]`. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    this.center.toArray(target, offset);
    target[offset + 3] = this.radius;
    return target;
  }

  /** JSON-friendly representation of the centre and radius. */
  public toJSON(): { center: { x: number; y: number; z: number }; radius: number } {
    return { center: this.center.toJSON(), radius: this.radius };
  }

  /** `"Sphere(center=[x, y, z], radius=r)"`, rounded to `precision` digits. */
  public toString(precision: number = 4): string {
    return `Sphere(center=${this.center.toString(precision)}, radius=${this.radius.toFixed(
      precision,
    )})`;
  }
}
