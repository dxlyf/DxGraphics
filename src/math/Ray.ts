/**
 * `Ray` — a half-line defined by an `origin` and a `direction`.
 *
 * `direction` is expected to be a **unit** vector; the intersection and
 * distance routines all assume it and {@link Ray.lookAt} / {@link Ray.applyMat4}
 * maintain it. Methods take an optional `target` so hot picking loops stay
 * allocation-free, and the intersection methods return `null` rather than a
 * sentinel so a miss is impossible to misread.
 *
 * ```ts
 * const ray = new Ray().lookAt(pointer);
 * ray.at(4, target);                 // 4 units along the ray
 * ray.intersectBox(box, hit);        // Vec3 | null
 * ```
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import type { Vec3Source } from '../types';
import { Vec3 } from './Vec3';
import type { Box3 } from './Box3';
import type { Mat4 } from './Mat4';
import type { Plane } from './Plane';
import type { Sphere } from './Sphere';

/** Scratch buffer for the first operand. */
const _va = new Vec3();

/** Scratch buffer for the second operand. */
const _vb = new Vec3();

/** Scratch buffer for the triangle normal. */
const _vc = new Vec3();

/** Scratch buffer for the origin-to-vertex difference. */
const _vd = new Vec3();

/** A ray. */
export class Ray {
  /** Ray origin. */
  public origin: Vec3;

  /** Unit ray direction. */
  public direction: Vec3;

  /**
   * Creates a ray.
   *
   * Both arguments are coerced with `Vec3.from` and **copied**, never aliased.
   * The defaults produce a ray at the origin looking down `-Z`, matching the
   * conventional camera forward axis.
   */
  constructor(origin?: Vec3Source, direction?: Vec3Source) {
    this.origin = origin === undefined ? Vec3.zero() : Vec3.from(origin);
    this.direction = direction === undefined ? new Vec3(0, 0, -1) : Vec3.from(direction);
  }

  /* ---------------------------------------------------------------- static */

  /** Allocation-free factory for a ray from an origin and a direction. */
  public static from(
    origin: Vec3Source,
    direction: Vec3Source,
    target: Ray = new Ray(),
  ): Ray {
    return target.set(origin, direction);
  }

  /* ------------------------------------------------------------ components */

  /** Sets the origin and direction. The direction is not normalised. */
  public set(origin: Vec3Source, direction: Vec3Source): this {
    this.origin.copy(origin);
    this.direction.copy(direction);
    return this;
  }

  /** Copies the origin and direction from `ray`. */
  public copy(ray: Ray): this {
    this.origin.copy(ray.origin);
    this.direction.copy(ray.direction);
    return this;
  }

  /** Returns a new ray with the same origin and direction. */
  public clone(): Ray {
    return new Ray(this.origin, this.direction);
  }

  /* -------------------------------------------------------------- geometry */

  /** Point at distance `t` along the ray, written into `target`. */
  public at(t: number, target: Vec3 = new Vec3()): Vec3 {
    return target.copy(this.direction).multiplyScalar(t).add(this.origin);
  }

  /**
   * Points the ray at `v`, replacing the direction with the normalised vector
   * from the origin to `v`.
   */
  public lookAt(v: Vec3Source): this {
    this.direction.copy(v).sub(this.origin).normalize();
    return this;
  }

  /** Moves the origin `t` units along the ray, keeping the direction. */
  public recast(t: number): this {
    this.origin.copy(this.at(t, _va));
    return this;
  }

  /* ------------------------------------------------------------ transform */

  /**
   * Transforms the ray by a column-major 4x4 matrix.
   *
   * The origin is transformed as a point and the direction is derived from the
   * transformed `origin + direction` point, so the result stays exact under
   * translation, rotation and non-uniform scaling alike. The direction is
   * renormalised afterwards.
   */
  public applyMat4(m: Mat4): this {
    _va.copy(this.origin).applyMat4(m);
    _vb.copy(this.direction).add(this.origin).applyMat4(m);
    this.origin.copy(_va);
    this.direction.copy(_vb).sub(_va).normalize();
    return this;
  }

  /* --------------------------------------------------------------- queries */

  /** Closest point on the ray to `point`, written into `target`. */
  public closestPointToPoint(point: Vec3Source, target: Vec3 = new Vec3()): Vec3 {
    const directionDistance = _va.copy(point).sub(this.origin).dot(this.direction);
    if (directionDistance < 0) return target.copy(this.origin);
    return target.copy(this.direction).multiplyScalar(directionDistance).add(this.origin);
  }

  /** Distance from `point` to the ray; the ray is a half-line, not a line. */
  public distanceToPoint(point: Vec3Source): number {
    _vb.copy(point);
    const directionDistance = _va.copy(_vb).sub(this.origin).dot(this.direction);
    if (directionDistance < 0) return this.origin.distanceTo(_vb);
    _va.copy(this.direction).multiplyScalar(directionDistance).add(this.origin);
    return _va.distanceTo(_vb);
  }

  /** Squared distance from `point` to the ray (avoids the square root). */
  public distanceSquaredToPoint(point: Vec3Source): number {
    _vb.copy(point);
    const directionDistance = _va.copy(_vb).sub(this.origin).dot(this.direction);
    if (directionDistance < 0) return this.origin.distanceToSquared(_vb);
    _va.copy(this.direction).multiplyScalar(directionDistance).add(this.origin);
    return _va.distanceToSquared(_vb);
  }

  /**
   * Distance along the ray at which it reaches `plane`, or `null`.
   *
   * `null` means the ray never reaches the plane in the forward direction:
   * either the plane is behind the origin, or the ray is parallel to it.
   * A ray that lies inside the plane reports `0`.
   */
  public distanceToPlane(plane: Plane): number | null {
    const denominator = plane.normal.dot(this.direction);
    if (denominator === 0) {
      return plane.distanceToPoint(this.origin) === 0 ? 0 : null;
    }
    const t = -(this.origin.dot(plane.normal) + plane.constant) / denominator;
    // `-0` is normalised to `0` so that strict comparisons on the result behave.
    return t >= 0 ? (t === 0 ? 0 : t) : null;
  }

  /** Intersection with `plane`, written into `target`, or `null`. */
  public intersectPlane(plane: Plane, target: Vec3 = new Vec3()): Vec3 | null {
    const t = this.distanceToPlane(plane);
    if (t === null) return null;
    return this.at(t, target);
  }

  /**
   * Intersection with `box`, written into `target`, or `null`.
   *
   * Uses the slab method. Parallel rays are resolved by an explicit
   * inside/outside test per slab rather than by multiplying by `1 / 0`, so a
   * ray that grazes a face never produces `NaN`. When the origin already lies
   * inside the box the **exit** point is returned; `tmax < 0` (a box entirely
   * behind the origin) and an empty box both report `null`.
   */
  public intersectBox(box: Box3, target: Vec3 = new Vec3()): Vec3 | null {
    if (box.isEmpty()) return null;

    const dx = this.direction.x;
    const dy = this.direction.y;
    const dz = this.direction.z;
    const ox = this.origin.x;
    const oy = this.origin.y;
    const oz = this.origin.z;

    if (
      Number.isNaN(dx) ||
      Number.isNaN(dy) ||
      Number.isNaN(dz) ||
      Number.isNaN(ox) ||
      Number.isNaN(oy) ||
      Number.isNaN(oz)
    ) {
      return null;
    }

    let tmin = -Infinity;
    let tmax = Infinity;

    if (dx === 0) {
      if (ox < box.min.x || ox > box.max.x) return null;
    } else {
      const inverse = 1 / dx;
      let t1 = (box.min.x - ox) * inverse;
      let t2 = (box.max.x - ox) * inverse;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }

    if (dy === 0) {
      if (oy < box.min.y || oy > box.max.y) return null;
    } else {
      const inverse = 1 / dy;
      let t1 = (box.min.y - oy) * inverse;
      let t2 = (box.max.y - oy) * inverse;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }

    if (dz === 0) {
      if (oz < box.min.z || oz > box.max.z) return null;
    } else {
      const inverse = 1 / dz;
      let t1 = (box.min.z - oz) * inverse;
      let t2 = (box.max.z - oz) * inverse;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }

    if (tmax < 0) return null;
    return this.at(tmin >= 0 ? tmin : tmax, target);
  }

  /** `true` when the ray hits `box` at or ahead of the origin. */
  public intersectsBox(box: Box3): boolean {
    return this.intersectBox(box, _va) !== null;
  }

  /**
   * Intersection with `sphere`, written into `target`, or `null`.
   *
   * Returns the nearest hit at or ahead of the origin; a sphere entirely behind
   * the origin and an empty sphere both report `null`.
   */
  public intersectSphere(sphere: Sphere, target: Vec3 = new Vec3()): Vec3 | null {
    if (sphere.isEmpty()) return null;

    const dx = this.direction.x;
    const dy = this.direction.y;
    const dz = this.direction.z;

    const vx = sphere.center.x - this.origin.x;
    const vy = sphere.center.y - this.origin.y;
    const vz = sphere.center.z - this.origin.z;

    const tca = vx * dx + vy * dy + vz * dz;
    const d2 = vx * vx + vy * vy + vz * vz - tca * tca;
    const radiusSquared = sphere.radius * sphere.radius;
    if (d2 > radiusSquared) return null;

    const thc = Math.sqrt(radiusSquared - d2);
    const t0 = tca - thc;
    const t1 = tca + thc;
    if (t0 < 0 && t1 < 0) return null;
    return this.at(t0 < 0 ? t1 : t0, target);
  }

  /** `true` when the ray hits `sphere` at or ahead of the origin. */
  public intersectsSphere(sphere: Sphere): boolean {
    return this.intersectSphere(sphere, _va) !== null;
  }

  /**
   * Intersection with the triangle `a, b, c`, written into `target`, or `null`.
   *
   * Möller–Trumbore. With `backfaceCulling` the triangle is only hit from the
   * side its winding makes front-facing — that is, from the side
   * `(c - b) × (a - b)` points to.
   */
  public intersectTriangle(
    a: Vec3Source,
    b: Vec3Source,
    c: Vec3Source,
    backfaceCulling: boolean,
    target: Vec3 = new Vec3(),
  ): Vec3 | null {
    const edge1 = _va.copy(b).sub(a);
    const edge2 = _vb.copy(c).sub(a);
    const normal = _vc.crossVectors(edge1, edge2);

    let ddN = this.direction.dot(normal);
    let sign: number;

    if (ddN > 0) {
      if (backfaceCulling) return null;
      sign = 1;
    } else if (ddN < 0) {
      sign = -1;
      ddN = -ddN;
    } else {
      return null;
    }

    const diff = _vd.copy(this.origin).sub(a);

    const ddQxE2 = sign * this.direction.dot(edge2.crossVectors(diff, edge2));
    if (ddQxE2 < 0) return null;

    const ddE1xQ = sign * this.direction.dot(edge1.cross(diff));
    if (ddE1xQ < 0) return null;

    if (ddQxE2 + ddE1xQ > ddN) return null;

    const qdN = -sign * diff.dot(normal);
    if (qdN < 0) return null;

    return this.at(qdN / ddN, target);
  }

  /** `true` when the origin and direction both match within `tolerance`. */
  public equals(ray: Ray, tolerance: number = EPSILON): boolean {
    return (
      this.origin.equals(ray.origin, tolerance) &&
      this.direction.equals(ray.direction, tolerance)
    );
  }

  /* ---------------------------------------------------------------- output */

  /** `[origin.x, origin.y, origin.z, direction.x, direction.y, direction.z]`. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    this.origin.toArray(target, offset);
    this.direction.toArray(target, offset + 3);
    return target;
  }

  /** JSON-friendly representation of the origin and direction. */
  public toJSON(): {
    origin: { x: number; y: number; z: number };
    direction: { x: number; y: number; z: number };
  } {
    return { origin: this.origin.toJSON(), direction: this.direction.toJSON() };
  }

  /** `"Ray(origin=[x, y, z], direction=[x, y, z])"`, rounded to `precision`. */
  public toString(precision: number = 4): string {
    return `Ray(origin=${this.origin.toString(precision)}, direction=${this.direction.toString(
      precision,
    )})`;
  }
}
