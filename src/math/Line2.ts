/**
 * `Line2` — an infinite 2D line, a segment, and the distance queries built on it.
 *
 * A line is stored as `origin + t * direction` where `direction` is expected to
 * be unit length. Segment methods treat the line as the closed interval
 * `[start, end]`; those endpoints are derived from `origin` and `direction`
 * rather than stored, so a `Line2` never goes out of sync.
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import { equals } from '../utils/MathUtils';
import { Vec2 } from './Vec2';

/** A 2D line or line segment. */
export class Line2 {
  /** A point on the line. */
  public readonly origin: Vec2;

  /** Unit direction of the line. */
  public readonly direction: Vec2;

  /**
   * Length of the finite segment, in world units.
   *
   * The direction is always unit length, so the segment spans the parameter range
   * `[0, segmentLength]`. A `Line2` built from a bare direction (rather than two
   * points) keeps the default of `1`, matching the "origin plus direction" shape.
   */
  public segmentLength = 1;

  /** Creates a line; defaults to the unit segment along `+X`. */
  constructor(origin: Vec2 = new Vec2(), direction: Vec2 = new Vec2(1, 0), length: number = 1) {
    this.origin = origin.clone();
    this.direction = direction.clone().normalize();
    this.segmentLength = Math.max(0, length);
  }

  /* ---------------------------------------------------------------- static */

  /** Builds a segment from two points; the direction is normalised. */
  public static fromPoints(start: Vec2, end: Vec2): Line2 {
    const line = new Line2(start, end.clone().sub(start));
    line.segmentLength = start.distanceTo(end);
    return line;
  }

  /** Builds a line from a point and a direction (normalised internally). */
  public static fromPointAndDirection(origin: Vec2, direction: Vec2): Line2 {
    return new Line2(origin, direction);
  }

  /** Builds a segment from a start point, a direction and an explicit length. */
  public static fromSegment(start: Vec2, direction: Vec2, length: number): Line2 {
    return new Line2(start, direction, length);
  }

  /* ------------------------------------------------------------ accessors */

  /**
   * Length of the segment `[start, end]`.
   *
   * A `Line2` describes **both** an infinite line (`origin + t * direction`, with
   * `direction` always normalised) and a finite segment. The segment spans
   * `t ∈ [0, length]`, which is why `end` is `origin + direction * length` rather
   * than `origin + direction`.
   */
  public get length(): number {
    return this.segmentLength;
  }

  /** Start point of the segment (a copy of `origin`). */
  public get start(): Vec2 {
    return this.origin.clone();
  }

  /** End point of the segment, i.e. `origin + direction * length`. */
  public get end(): Vec2 {
    return this.origin.clone().addScaledVector(this.direction, this.segmentLength);
  }

  /** Sets origin and direction in one call; the segment length is preserved. */
  public set(origin: Vec2, direction: Vec2): this {
    this.origin.copy(origin);
    this.direction.copy(direction);
    return this;
  }

  /**
   * Sets origin, direction **and** segment length (the direction is normalised).
   *
   * Use this when the two endpoints are known and the caller wants to distinguish
   * a long segment from a short one that share a direction.
   */
  public setSegment(origin: Vec2, direction: Vec2, length: number): this {
    this.origin.copy(origin);
    this.direction.copy(direction).normalize();
    this.segmentLength = Math.max(0, length);
    return this;
  }

  /** Copies another line, including its segment length. */
  public copy(line: Line2): this {
    this.origin.copy(line.origin);
    this.direction.copy(line.direction);
    this.segmentLength = line.segmentLength;
    return this;
  }

  /** Returns a new line with the same origin, direction and length. */
  public clone(): Line2 {
    const copy = new Line2(this.origin, this.direction);
    copy.segmentLength = this.segmentLength;
    return copy;
  }

  /** Sets the line from two points; the direction is normalised. */
  public setFromPoints(start: Vec2, end: Vec2): this {
    this.origin.copy(start);
    this.direction.copy(end).sub(start);
    this.segmentLength = this.direction.length();
    this.direction.normalize();
    return this;
  }

  /** Translates the line by `offset`. */
  public translate(offset: Vec2): this {
    this.origin.add(offset);
    return this;
  }

  /** Rotates origin and direction around `pivot` by `radians`. */
  public rotate(radians: number, pivot: Vec2 = new Vec2()): this {
    this.origin.rotateAroundPoint(pivot, radians);
    this.direction.rotateAround(radians);
    return this;
  }

  /* --------------------------------------------------------------- queries */

  /** Point on the line at parameter `t`: `origin + t * direction`. */
  public at(t: number, target: Vec2 = new Vec2()): Vec2 {
    return target.copy(this.origin).addScaledVector(this.direction, t);
  }

  /**
   * Parameter `t` of the point on the line closest to `point`.
   *
   * Also works as the projection parameter: `at(pointProjection(point))` is the
   * orthogonal projection of `point` onto the infinite line.
   */
  public pointToParameter(point: Vec2): number {
    return point.clone().sub(this.origin).dot(this.direction);
  }

  /** Orthogonal projection of `point` onto the infinite line. */
  public projectPoint(point: Vec2, target: Vec2 = new Vec2()): Vec2 {
    return this.at(this.pointToParameter(point), target);
  }

  /**
   * Signed perpendicular distance from `point` to the infinite line.
   *
   * Positive on the left of the direction vector (counter-clockwise side).
   */
  public signedDistanceToPoint(point: Vec2): number {
    return point.clone().sub(this.origin).cross(this.direction);
  }

  /** Absolute perpendicular distance from `point` to the infinite line. */
  public distanceToPoint(point: Vec2): number {
    return Math.abs(this.signedDistanceToPoint(point));
  }

  /** Squared perpendicular distance from `point` to the infinite line. */
  public distanceSquaredToPoint(point: Vec2): number {
    const d = this.signedDistanceToPoint(point);
    return d * d;
  }

  /** Distance from `point` to the **segment** `[start, end]`. */
  public distanceToSegment(point: Vec2, tolerance: number = EPSILON): number {
    const length = this.segmentLength;
    if (length <= tolerance) return point.distanceTo(this.origin);
    const t = this.pointToParameter(point);
    const clamped = t < 0 ? 0 : t > length ? length : t;
    return point.distanceTo(this.at(clamped));
  }

  /** `true` when `point` lies on the infinite line within `tolerance`. */
  public containsPoint(point: Vec2, tolerance: number = EPSILON): boolean {
    return this.distanceToPoint(point) <= tolerance;
  }

  /** `true` when `point` lies on the **segment** within `tolerance`. */
  public containsSegmentPoint(point: Vec2, tolerance: number = EPSILON): boolean {
    if (!this.containsPoint(point, tolerance)) return false;
    return this.isSegmentParameterValid(this.pointToParameter(point), tolerance);
  }

  /**
   * `true` when parameter `t` (in the unit-direction parameterisation) falls
   * inside the segment, allowing `tolerance` of slack at both ends.
   */
  private isSegmentParameterValid(t: number, tolerance: number): boolean {
    if (this.segmentLength <= tolerance) return true;
    return t >= -tolerance && t <= this.segmentLength + tolerance;
  }

  /**
   * Intersects this infinite line with `other`.
   *
   * @returns The intersection point, or `null` when the lines are parallel
   *   (including collinear, which has no unique intersection).
   */
  public intersectLine(other: Line2, target: Vec2 = new Vec2()): Vec2 | null {
    const denominator = this.direction.clone().cross(other.direction);
    if (Math.abs(denominator) <= EPSILON) return null;
    const t = other.origin.clone().sub(this.origin).cross(other.direction) / denominator;
    return this.at(t, target);
  }

  /**
   * Intersects the two **segments**.
   *
   * @returns The intersection point, or `null` when they do not overlap.
   */
  public intersectSegment(other: Line2, target: Vec2 = new Vec2()): Vec2 | null {
    const p = this.origin;
    const r = this.direction;
    const q = other.origin;
    const s = other.direction;

    const denominator = r.clone().cross(s);
    const qp = q.clone().sub(p);

    if (Math.abs(denominator) <= EPSILON) {
      // Parallel: collinear segments overlap along their whole length, so there
      // is no single intersection point to report.
      return null;
    }

    // Parameters use the unit direction, so each segment spans [0, its length].
    const t = qp.clone().cross(s) / denominator;
    const u = qp.clone().cross(r) / denominator;

    if (!this.isSegmentParameterValid(t, EPSILON)) return null;
    if (!other.isSegmentParameterValid(u, EPSILON)) return null;

    const maxT = this.segmentLength;
    const clampedT = t < 0 ? 0 : t > maxT ? maxT : t;
    return this.at(clampedT, target);
  }

  /** `true` when the two segments intersect. */
  public intersectsSegment(other: Line2): boolean {
    return this.intersectSegment(other) !== null;
  }

  /** `true` when every component of origin and direction matches. */
  public equals(line: Line2, tolerance: number = EPSILON): boolean {
    return (
      this.origin.equals(line.origin, tolerance) && this.direction.equals(line.direction, tolerance)
    );
  }

  /** `true` when both lines are parallel (or anti-parallel). */
  public isParallelTo(line: Line2, tolerance: number = EPSILON): boolean {
    return equals(Math.abs(this.direction.clone().cross(line.direction)), 0, tolerance);
  }

  /** `true` when both lines are parallel and share at least one point. */
  public isCollinearWith(line: Line2, tolerance: number = EPSILON): boolean {
    return this.isParallelTo(line, tolerance) && this.distanceToPoint(line.origin) <= tolerance;
  }

  /** Angle of the line relative to `+X`, in radians. */
  public angle(): number {
    return this.direction.angle();
  }

  /* --------------------------------------------------------------- output */

  /** `[origin.x, origin.y, direction.x, direction.y]`. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    target[offset] = this.origin.x;
    target[offset + 1] = this.origin.y;
    target[offset + 2] = this.direction.x;
    target[offset + 3] = this.direction.y;
    return target;
  }

  /** JSON-friendly representation. */
  public toJSON(): { origin: { x: number; y: number }; direction: { x: number; y: number } } {
    return { origin: this.origin.toJSON(), direction: this.direction.toJSON() };
  }

  /** Human-readable representation. */
  public toString(precision: number = 4): string {
    return `Line2(origin=${this.origin.toString(precision)}, direction=${this.direction.toString(precision)})`;
  }
}

/** Creates a `Line2` from an origin and direction. */
export function line2(origin?: Vec2, direction?: Vec2): Line2 {
  return new Line2(origin, direction);
}
