/**
 * `Line3` — a 3D line segment.
 *
 * Geometry and picking code needs the same handful of segment queries over and
 * over (closest point, distance to a point, closest approach between two
 * segments, triangle intersection), so they live here in one place.
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import { clip, clamp } from '../utils/MathUtils';
import { Vec3 } from './Vec3';

/** A 3D line segment defined by two endpoints. */
export class Line3 {
  /** Start point. */
  public readonly start: Vec3;

  /** End point. */
  public readonly end: Vec3;

  /** Creates a segment; defaults to a degenerate point at the origin. */
  constructor(start: Vec3 = new Vec3(), end: Vec3 = new Vec3()) {
    this.start = start.clone();
    this.end = end.clone();
  }

  /* ---------------------------------------------------------------- static */

  /** Builds a segment from two endpoints (copied). */
  public static fromPoints(start: Vec3, end: Vec3): Line3 {
    return new Line3(start, end);
  }

  /**
   * Computes the closest approach between two segments.
   *
   * This is the classic Ericson (`Real-Time Collision Detection`) routine with
   * the parallel/degenerate branches handled explicitly.
   *
   * @param a1,a2 Endpoints of the first segment.
   * @param b1,b2 Endpoints of the second segment.
   * @param c1,c2 Optional targets receiving the closest points (may be omitted).
   * @returns The parameters `[s, t]` such that the closest points are
   *   `a1 + s * (a2 - a1)` and `b1 + t * (b2 - b1)`.
   */
  public static closestPointsBetweenSegments(
    a1: Vec3,
    a2: Vec3,
    b1: Vec3,
    b2: Vec3,
    c1: Vec3 = new Vec3(),
    c2: Vec3 = new Vec3(),
  ): [number, number] {
    const d1 = a2.clone().sub(a1);
    const d2 = b2.clone().sub(b1);
    const r = a1.clone().sub(b1);
    const a = d1.dot(d1);
    const e = d2.dot(d2);
    const f = d2.dot(r);

    let s: number;
    let t: number;

    if (a <= EPSILON && e <= EPSILON) {
      // Both segments are points.
      s = 1;
      t = 1;
    } else if (a <= EPSILON) {
      s = 1;
      t = clamp(f / e, 0, 1);
    } else {
      const c = d1.dot(r);
      if (e <= EPSILON) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else {
        const b = d1.dot(d2);
        const denom = a * e - b * b;
        // `denom === 0` means the segments are parallel, so any `s` works.
        s = denom > EPSILON ? clamp((b * f - c * e) / denom, 0, 1) : 1;
        t = (b * s + f) / e;
        if (t < 0) {
          t = 0;
          s = clamp(-c / a, 0, 1);
        } else if (t > 1) {
          t = 1;
          s = clamp((b - c) / a, 0, 1);
        }
      }
    }

    c1.copy(d1).multiplyScalar(s).add(a1);
    c2.copy(d2).multiplyScalar(t).add(b1);
    return [s, t];
  }

  /** Squared distance between two segments. */
  public static distanceSquaredBetweenSegments(a1: Vec3, a2: Vec3, b1: Vec3, b2: Vec3): number {
    const c1 = new Vec3();
    const c2 = new Vec3();
    Line3.closestPointsBetweenSegments(a1, a2, b1, b2, c1, c2);
    return c1.distanceToSquared(c2);
  }

  /** Distance between two segments. */
  public static distanceBetweenSegments(a1: Vec3, a2: Vec3, b1: Vec3, b2: Vec3): number {
    return Math.sqrt(Line3.distanceSquaredBetweenSegments(a1, a2, b1, b2));
  }

  /* ------------------------------------------------------------ accessors */

  /** Sets both endpoints. */
  public set(start: Vec3, end: Vec3): this {
    this.start.copy(start);
    this.end.copy(end);
    return this;
  }

  /** Copies another segment. */
  public copy(line: Line3): this {
    this.start.copy(line.start);
    this.end.copy(line.end);
    return this;
  }

  /** Returns a new segment with the same endpoints. */
  public clone(): Line3 {
    return new Line3(this.start, this.end);
  }

  /** Alias of {@link set}, mirroring three.js. */
  public setFromPoints(start: Vec3, end: Vec3): this {
    return this.set(start, end);
  }

  /** Centre of the segment. */
  public getCenter(target: Vec3 = new Vec3()): Vec3 {
    return target.copy(this.start).add(this.end).multiplyScalar(0.5);
  }

  /** Vector from `start` to `end`. */
  public getDelta(target: Vec3 = new Vec3()): Vec3 {
    return target.copy(this.end).sub(this.start);
  }

  /** Length of the segment. */
  public length(): number {
    return this.start.distanceTo(this.end);
  }

  /** Squared length of the segment. */
  public lengthSquared(): number {
    return this.start.distanceToSquared(this.end);
  }

  /** Reverses the segment in place. */
  public reverse(): this {
    const tmp = this.start.clone();
    this.start.copy(this.end);
    this.end.copy(tmp);
    return this;
  }

  /** Point at parameter `t` (`0` = start, `1` = end), clamped to the segment. */
  public at(t: number, target: Vec3 = new Vec3()): Vec3 {
    return target.copy(this.end).sub(this.start).multiplyScalar(clamp(t, 0, 1)).add(this.start);
  }

  /** Point at `t` without clamping (useful for infinite-line queries). */
  public atUnclamped(t: number, target: Vec3 = new Vec3()): Vec3 {
    return target.copy(this.end).sub(this.start).multiplyScalar(t).add(this.start);
  }

  /* ------------------------------------------------------------ transforms */

  /** Translates both endpoints. */
  public translate(offset: Vec3): this {
    this.start.add(offset);
    this.end.add(offset);
    return this;
  }

  /** Applies a 4x4 matrix to both endpoints. */
  public applyMat4(m: { elements: ArrayLike<number> } | ArrayLike<number>): this {
    this.start.applyMat4(m);
    this.end.applyMat4(m);
    return this;
  }

  /* --------------------------------------------------------------- queries */

  /** Parameter `t` in `[0, 1]` of the point on the segment closest to `point`. */
  public closestPointToPointParameter(point: Vec3, clampToSegment: boolean = true): number {
    const delta = this.end.clone().sub(this.start);
    const lengthSquared = delta.lengthSquared();
    if (lengthSquared === 0) return 0;
    const t = point.clone().sub(this.start).dot(delta) / lengthSquared;
    return clampToSegment ? clamp(t, 0, 1) : t;
  }

  /** Point on the segment closest to `point`. */
  public closestPointToPoint(point: Vec3, clampToSegment: boolean = true, target: Vec3 = new Vec3()): Vec3 {
    const t = this.closestPointToPointParameter(point, clampToSegment);
    return this.atUnclamped(t, target);
  }

  /** Distance from `point` to the segment. */
  public distanceToPoint(point: Vec3): number {
    return this.closestPointToPoint(point).distanceTo(point);
  }

  /** Squared distance from `point` to the segment. */
  public distanceSquaredToPoint(point: Vec3): number {
    return this.closestPointToPoint(point).distanceToSquared(point);
  }

  /** `true` when `point` lies on the segment within `tolerance`. */
  public containsPoint(point: Vec3, tolerance: number = EPSILON): boolean {
    return this.distanceSquaredToPoint(point) <= tolerance * tolerance;
  }

  /** Closest points between this segment and `other`. */
  public closestPointsToSegment(
    other: Line3,
    targetA: Vec3 = new Vec3(),
    targetB: Vec3 = new Vec3(),
  ): [number, number] {
    return Line3.closestPointsBetweenSegments(
      this.start,
      this.end,
      other.start,
      other.end,
      targetA,
      targetB,
    );
  }

  /** Distance to another segment. */
  public distanceToSegment(other: Line3): number {
    return Math.sqrt(this.distanceSquaredToSegment(other));
  }

  /** Squared distance to another segment. */
  public distanceSquaredToSegment(other: Line3): number {
    return Line3.distanceSquaredBetweenSegments(this.start, this.end, other.start, other.end);
  }

  /** `true` when the segment comes within `tolerance` of `other`. */
  public intersectsSegment(other: Line3, tolerance: number = EPSILON): boolean {
    return this.distanceSquaredToSegment(other) <= tolerance * tolerance;
  }

  /**
   * Intersects the segment with a triangle (Möller–Trumbore).
   *
   * @param backfaceCulling When set, only front-facing hits are reported.
   * @returns The intersection point, or `null`.
   */
  public intersectTriangle(
    a: Vec3,
    b: Vec3,
    c: Vec3,
    backfaceCulling: boolean = false,
    target: Vec3 = new Vec3(),
  ): Vec3 | null {
    const direction = this.end.clone().sub(this.start);
    const edge1 = b.clone().sub(a);
    const edge2 = c.clone().sub(a);
    const pvec = direction.clone().cross(edge2);
    const det = edge1.dot(pvec);

    if (backfaceCulling) {
      if (det < EPSILON) return null;
    } else if (Math.abs(det) < EPSILON) {
      return null;
    }

    const invDet = 1 / det;
    const tvec = this.start.clone().sub(a);
    const u = tvec.dot(pvec) * invDet;
    if (u < 0 || u > 1) return null;

    const qvec = tvec.clone().cross(edge1);
    const v = direction.dot(qvec) * invDet;
    if (v < 0 || u + v > 1) return null;

    const t = edge2.dot(qvec) * invDet;
    if (t < 0 || t > 1) return null;

    return target.copy(direction).multiplyScalar(t).add(this.start);
  }

  /** `true` when the segment intersects the triangle. */
  public intersectsTriangle(a: Vec3, b: Vec3, c: Vec3, backfaceCulling: boolean = false): boolean {
    return this.intersectTriangle(a, b, c, backfaceCulling, new Vec3()) !== null;
  }

  /**
   * Intersects the segment with an axis-aligned box.
   *
   * @returns The entry point, or `null` when the segment misses the box.
   */
  public intersectBox(
    min: Vec3,
    max: Vec3,
    target: Vec3 = new Vec3(),
  ): Vec3 | null {
    const direction = this.end.clone().sub(this.start);
    let tMin = 0;
    let tMax = 1;

    for (const axis of ['x', 'y', 'z'] as const) {
      const origin = this.start[axis];
      const dir = direction[axis];
      const low = min[axis];
      const high = max[axis];

      if (Math.abs(dir) < EPSILON) {
        if (origin < low || origin > high) return null;
        continue;
      }

      const inv = 1 / dir;
      let t1 = (low - origin) * inv;
      let t2 = (high - origin) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }

    return this.atUnclamped(tMin, target);
  }

  /** Parameter `t` of the segment's entry into a box, or `null` if it misses. */
  public intersectBoxParameter(min: Vec3, max: Vec3): number | null {
    const direction = this.end.clone().sub(this.start);
    let tMin = 0;
    let tMax = 1;

    for (const axis of ['x', 'y', 'z'] as const) {
      const origin = this.start[axis];
      const dir = direction[axis];
      const low = min[axis];
      const high = max[axis];

      if (Math.abs(dir) < EPSILON) {
        if (origin < low || origin > high) return null;
        continue;
      }

      const inv = 1 / dir;
      const t1 = Math.min((low - origin) * inv, (high - origin) * inv);
      const t2 = Math.max((low - origin) * inv, (high - origin) * inv);
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }
    return tMin;
  }

  /**
   * Clip parameters `[t0, t1]` of the segment against a plane.
   *
   * @returns `null` when the segment lies entirely on one side.
   */
  public clipToPlane(
    planeNormal: Vec3,
    planeConstant: number,
  ): [number, number] | null {
    const d0 = planeNormal.dot(this.start) + planeConstant;
    const d1 = planeNormal.dot(this.end) + planeConstant;
    if (d0 * d1 > 0) return null;
    if (d0 === d1) return [0, 1];
    const t = clip(d0 / (d0 - d1), 0, 1);
    return d0 < 0 ? [0, t] : [t, 1];
  }

  /** `true` when both endpoints match within `tolerance`. */
  public equals(line: Line3, tolerance: number = EPSILON): boolean {
    return this.start.equals(line.start, tolerance) && this.end.equals(line.end, tolerance);
  }

  /** `true` when both endpoints are finite. */
  public isFinite(): boolean {
    return this.start.isFinite() && this.end.isFinite();
  }

  /** `true` when both endpoints coincide within `tolerance`. */
  public isDegenerate(tolerance: number = EPSILON): boolean {
    return this.lengthSquared() <= tolerance * tolerance;
  }

  /* --------------------------------------------------------------- output */

  /** `[start.x, start.y, start.z, end.x, end.y, end.z]`. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    this.start.toArray(target, offset);
    this.end.toArray(target, offset + 3);
    return target;
  }

  /** JSON-friendly representation. */
  public toJSON(): { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } } {
    return { start: this.start.toJSON(), end: this.end.toJSON() };
  }

  /** Human-readable representation. */
  public toString(precision: number = 4): string {
    return `Line3(start=${this.start.toString(precision)}, end=${this.end.toString(precision)})`;
  }
}

/** Creates a `Line3` from two endpoints. */
export function line3(start?: Vec3, end?: Vec3): Line3 {
  return new Line3(start, end);
}
