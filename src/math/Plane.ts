/**
 * `Plane` — an infinite plane in Hessian normal form, `normal · x + constant = 0`.
 *
 * `normal` is expected to be a **unit** vector: {@link Plane.distanceToPoint},
 * {@link Plane.distanceToSphere}, {@link Plane.orthoPoint} and
 * {@link Plane.projectPoint} all rely on that, and {@link Plane.normalize}
 * restores it after a non-unit assignment. `setFromNormalAndCoplanarPoint` and
 * `setFromCoplanarPoints` deliberately do not renormalise what you pass, so the
 * caller decides when the extra square root is worth paying for.
 *
 * Mutators return `this`; compute methods take an optional `target` so hot loops
 * stay allocation-free.
 *
 * ```ts
 * const plane = new Plane().setFromCoplanarPoints(a, b, c);
 * plane.distanceToPoint(p);            // signed, negative on the back side
 * plane.projectPoint(p, target);       // closest point on the plane
 * ```
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import type { Vec3Source } from '../types';
import { Vec3 } from './Vec3';
import { Mat3 } from './Mat3';
import type { Box3 } from './Box3';
import type { Line3 } from './Line3';
import type { Mat4 } from './Mat4';
import type { Sphere } from './Sphere';

/**
 * Minimal structural segment, `{ start, end }`.
 *
 * Declared locally (and deliberately not exported) so that the line queries
 * accept both a real `Line3` and a hand-built literal. Only the `start`/`end`
 * coordinates are ever read, so no dependency on the `Line3` *implementation*
 * is needed; `Line3` satisfies this shape structurally.
 */
interface Line3Like {
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
}

/** Scratch buffer for coplanar/normal work. */
const _v1 = new Vec3();

/** Scratch buffer for the transformed normal. */
const _v2 = new Vec3();

/** Scratch buffer for line/coplanar-point arithmetic. */
const _v3 = new Vec3();

/** Scratch buffer for the coplanar-points normal. */
const _v4 = new Vec3();

/** Scratch buffer for point coercion inside the distance helpers. */
const _p = new Vec3();

/** Scratch normal matrix reused by {@link Plane.applyMat4}. */
const _normalMatrix = new Mat3();

/** An infinite plane. */
export class Plane {
  /** Unit plane normal. */
  public normal: Vec3;

  /** Signed distance from the origin along the normal, negated. */
  public constant: number;

  /**
   * Creates a plane.
   *
   * `normal` is coerced with `Vec3.from` and **copied**, never aliased. The
   * default is the plane `z = 0`.
   */
  constructor(normal?: Vec3Source, constant: number = 0) {
    this.normal = normal === undefined ? Vec3.unitZ() : Vec3.from(normal);
    this.constant = constant;
  }

  /* ---------------------------------------------------------------- static */

  /** Builds a plane from a normal and a point known to lie on it. */
  public static fromNormalAndCoplanarPoint(
    normal: Vec3Source,
    point: Vec3Source,
    target: Plane = new Plane(),
  ): Plane {
    return target.setFromNormalAndCoplanarPoint(normal, point);
  }

  /** Builds a plane through three points. */
  public static fromCoplanarPoints(
    a: Vec3Source,
    b: Vec3Source,
    c: Vec3Source,
    target: Plane = new Plane(),
  ): Plane {
    return target.setFromCoplanarPoints(a, b, c);
  }

  /* ------------------------------------------------------------ components */

  /** Sets the normal and the constant. The normal is not renormalised. */
  public set(normal: Vec3Source, constant: number): this {
    this.normal.copy(normal);
    this.constant = constant;
    return this;
  }

  /** Sets the normal from components and the constant from `w`. */
  public setComponents(x: number, y: number, z: number, w: number): this {
    this.normal.set(x, y, z);
    this.constant = w;
    return this;
  }

  /**
   * Sets the plane from a normal and a point known to lie on it.
   *
   * The normal is not normalised, so pass a unit vector (or call
   * {@link normalize}) if you intend to use the distance methods.
   */
  public setFromNormalAndCoplanarPoint(normal: Vec3Source, point: Vec3Source): this {
    this.normal.copy(normal);
    this.constant = -this.normal.dot(point);
    return this;
  }

  /**
   * Sets the plane through three points, in counter-clockwise order.
   *
   * The normal `(c - b) × (a - b)` is normalised. Collinear points leave a zero
   * normal rather than producing `NaN`.
   */
  public setFromCoplanarPoints(a: Vec3Source, b: Vec3Source, c: Vec3Source): this {
    const av = _v1.copy(a);
    const bv = _v2.copy(b);
    const cv = _v3.copy(c);
    const normal = _v4.subVectors(cv, bv).cross(_p.subVectors(av, bv)).normalize();
    return this.setFromNormalAndCoplanarPoint(normal, av);
  }

  /** Copies the normal and constant from `plane`. */
  public copy(plane: Plane): this {
    this.normal.copy(plane.normal);
    this.constant = plane.constant;
    return this;
  }

  /** Returns a new plane with the same normal and constant. */
  public clone(): Plane {
    return new Plane(this.normal, this.constant);
  }

  /* -------------------------------------------------------------- geometry */

  /**
   * Scales the normal to unit length and rescales the constant to match.
   *
   * A zero normal is left untouched, mirroring `Vec3.normalize`.
   */
  public normalize(): this {
    const length = this.normal.length();
    if (length === 0) return this;
    const inverseLength = 1 / length;
    this.normal.multiplyScalar(inverseLength);
    this.constant *= inverseLength;
    return this;
  }

  /** Flips the plane to face the other way. */
  public negate(): this {
    this.normal.negate();
    this.constant = -this.constant;
    return this;
  }

  /** Returns any point that lies on the plane, written into `target`. */
  public coplanarPoint(target: Vec3 = new Vec3()): Vec3 {
    return target.copy(this.normal).multiplyScalar(-this.constant);
  }

  /**
   * Signed distance from `point` to the plane.
   *
   * Positive when the point is on the side the normal points to. Requires a
   * unit `normal`.
   */
  public distanceToPoint(point: Vec3Source): number {
    return this.normal.dot(_p.copy(point)) + this.constant;
  }

  /** Signed distance from the surface of `sphere` to the plane. */
  public distanceToSphere(sphere: Sphere): number {
    return this.distanceToPoint(sphere.center) - sphere.radius;
  }

  /** Orthogonal projection of `point` onto the plane, written into `target`. */
  public projectPoint(point: Vec3Source, target: Vec3 = new Vec3()): Vec3 {
    const distance = this.distanceToPoint(point);
    _v1.copy(this.normal).multiplyScalar(-distance).add(point);
    return target.copy(_v1);
  }

  /**
   * The plane normal scaled by the signed distance from `point` to the plane.
   *
   * That is the component of `point -> plane` measured along the normal.
   */
  public orthoPoint(point: Vec3Source, target: Vec3 = new Vec3()): Vec3 {
    const distance = this.distanceToPoint(point);
    return target.copy(this.normal).multiplyScalar(distance);
  }

  /* ------------------------------------------------------------ transform */

  /**
   * Transforms the plane by a column-major 4x4 matrix.
   *
   * A coplanar point is transformed as a point while the normal is transformed
   * by a normal matrix — the inverse transpose of the matrix's upper-left 3x3
   * block — and the constant is rebuilt from both.
   *
   * `optionalNormalMatrix` lets a caller reuse a normal matrix it already has;
   * when it is omitted one is derived from `m` through
   * `Mat3.getNormalMatrix`, which is exact for any affine transform (including
   * non-uniform scaling) and falls back to the plain upper-left block for a
   * singular matrix.
   */
  public applyMat4(m: Mat4, optionalNormalMatrix?: Mat3): this {
    const reference = this.coplanarPoint(_v1);
    reference.applyMat4(m);

    const normalMatrix =
      optionalNormalMatrix === undefined ? _normalMatrix.getNormalMatrix(m) : optionalNormalMatrix;
    _v2.copy(this.normal).applyNormalMat3(normalMatrix);

    this.normal.copy(_v2);
    this.constant = -reference.dot(_v2);
    return this;
  }

  /** Moves the plane by `offset`. */
  public translate(offset: Vec3Source): this {
    this.constant -= this.normal.dot(_p.copy(offset));
    return this;
  }

  /* --------------------------------------------------------------- queries */

  /**
   * Intersection of the segment `line` with the plane, written into `target`.
   *
   * Returns `null` when the segment does not cross the plane in `0..1`. A
   * segment that lies inside the plane returns its `start`; a parallel segment
   * that misses returns `null`.
   */
  public intersectLine(line: Line3 | Line3Like, target: Vec3 = new Vec3()): Vec3 | null {
    _v3.copy(line.end).sub(line.start);
    const startDistance = this.distanceToPoint(line.start);
    const denominator = this.normal.dot(_v3);

    if (denominator === 0) {
      return startDistance === 0 ? target.copy(line.start) : null;
    }

    const t = -startDistance / denominator;
    if (t < 0 || t > 1) return null;
    return target.copy(_v3).multiplyScalar(t).add(line.start);
  }

  /** `true` when the segment `line` crosses the plane strictly. */
  public intersectsLine(line: Line3 | Line3Like): boolean {
    const startSign = this.distanceToPoint(line.start);
    const endSign = this.distanceToPoint(line.end);
    return (startSign < 0 && endSign > 0) || (startSign > 0 && endSign < 0);
  }

  /** `true` when the plane cuts through `box`. */
  public intersectsBox(box: Box3): boolean {
    return box.intersectsPlane(this);
  }

  /** `true` when the plane cuts through `sphere`. */
  public intersectsSphere(sphere: Sphere): boolean {
    return sphere.intersectsPlane(this);
  }

  /** `true` when the normal and constant both match within `tolerance`. */
  public equals(plane: Plane, tolerance: number = EPSILON): boolean {
    return (
      this.normal.equals(plane.normal, tolerance) &&
      Math.abs(this.constant - plane.constant) <= tolerance
    );
  }

  /* ---------------------------------------------------------------- output */

  /** `[normal.x, normal.y, normal.z, constant]`. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    this.normal.toArray(target, offset);
    target[offset + 3] = this.constant;
    return target;
  }

  /** JSON-friendly representation of the normal and constant. */
  public toJSON(): {
    normal: { x: number; y: number; z: number };
    constant: number;
  } {
    return { normal: this.normal.toJSON(), constant: this.constant };
  }

  /** `"Plane(normal=[x, y, z], constant=c)"`, rounded to `precision` digits. */
  public toString(precision: number = 4): string {
    return `Plane(normal=${this.normal.toString(precision)}, constant=${this.constant.toFixed(
      precision,
    )})`;
  }
}
