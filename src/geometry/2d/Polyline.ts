/**
 * `Polyline` — an open vertex list with geometric queries.
 *
 * Everything here is parameterised by **arc length**, not by vertex index, so
 * `pointAt(0.5)` is the point half way along the polyline by distance. The class
 * is the workhorse behind hit testing on 2D strokes, dash generation, and
 * reducing imported polylines before they reach the tessellator.
 *
 * The module also exports the shared low-level helpers
 * ({@link rdpSimplify}, {@link distanceToSegment}, {@link segmentLengths}) that
 * `Polygon` and `BooleanOps` build on.
 *
 * @packageDocumentation
 */

import { Box2 } from '../../math/Box2';
import { Vec2 } from '../../math/Vec2';
import { Shape } from './Shape';
import type { PolylineJSON } from './types';

/* -------------------------------------------------------------------------- */
/* Shared low-level helpers                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Distance from `point` to the segment `a -> b`, clamped to the segment.
 *
 * A degenerate segment (`a === b`) reports the distance to `a`.
 */
export function distanceToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/**
 * Length of every segment of a polyline.
 *
 * @param points Vertices.
 * @param closed When `true`, the closing segment `last -> first` is included.
 */
export function segmentLengths(points: readonly Vec2[], closed: boolean = false): number[] {
  const count = points.length;
  if (count < 2) return [];
  const limit = closed ? count : count - 1;
  const lengths: number[] = new Array(limit);
  for (let i = 0; i < limit; i++) {
    lengths[i] = points[i].distanceTo(points[(i + 1) % count]);
  }
  return lengths;
}

/**
 * Ramer–Douglas–Peucker simplification.
 *
 * A collinear run collapses to its two endpoints, which is the property the
 * polyline and polygon reducers rely on. Fully iterative (an explicit stack), so
 * a very long polyline cannot overflow the call stack.
 *
 * @param points Source vertices.
 * @param tolerance Maximum perpendicular deviation that is still discarded.
 * @returns A new array of surviving vertices, always including the endpoints.
 */
export function rdpSimplify(points: readonly Vec2[], tolerance: number): Vec2[] {
  const count = points.length;
  if (count < 3 || tolerance <= 0) return points.slice();

  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;

  const stack: Array<[number, number]> = [[0, count - 1]];
  while (stack.length > 0) {
    const range = stack.pop() as [number, number];
    const first = range[0];
    const last = range[1];
    if (last - first < 2) continue;

    let maxDistance = 0;
    let maxIndex = -1;
    for (let i = first + 1; i < last; i++) {
      const distance = distanceToSegment(points[i], points[first], points[last]);
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = i;
      }
    }

    if (maxIndex >= 0 && maxDistance > tolerance) {
      keep[maxIndex] = 1;
      stack.push([first, maxIndex], [maxIndex, last]);
    }
  }

  const result: Vec2[] = [];
  for (let i = 0; i < count; i++) if (keep[i]) result.push(points[i]);
  return result;
}

/* -------------------------------------------------------------------------- */
/* Polyline                                                                   */
/* -------------------------------------------------------------------------- */

/** The nearest point on a polyline, with its location. */
export interface ClosestPointResult {
  /** The nearest point on the polyline. */
  point: Vec2;
  /** Distance from the query point to {@link ClosestPointResult.point}. */
  distance: number;
  /** Index of the segment the point lies on. */
  segment: number;
  /** Local parameter inside that segment, in `[0, 1]`. */
  t: number;
}

/** An open (non-closed) polyline. */
export class Polyline {
  /** The ordered vertices. */
  public points: Vec2[];

  /**
   * Creates a polyline.
   *
   * @param points Vertices; plain tuples and object literals are accepted and
   *   copied into `Vec2` instances.
   */
  constructor(points: ReadonlyArray<Vec2 | [number, number] | { x: number; y: number }> = []) {
    this.points = [];
    this.setFromPoints(points);
  }

  /** Number of vertices. */
  public get count(): number {
    return this.points.length;
  }

  /** Replaces the vertex list. */
  public setFromPoints(
    points: ReadonlyArray<Vec2 | [number, number] | { x: number; y: number }>,
  ): this {
    this.points = points.map((point) =>
      point instanceof Vec2 ? point.clone() : Vec2.from(point as [number, number]),
    );
    return this;
  }

  /** Pushes one vertex. */
  public addPoint(point: Vec2): this {
    this.points.push(point);
    return this;
  }

  /** Total length, summed over the segments. */
  public get length(): number {
    const lengths = segmentLengths(this.points, false);
    let total = 0;
    for (const value of lengths) total += value;
    return total;
  }

  /** `true` when the polyline has fewer than two distinct vertices. */
  public get isEmpty(): boolean {
    return this.length <= 0;
  }

  /** Axis-aligned bounds. */
  public getBounds(target: Box2 = new Box2()): Box2 {
    if (this.points.length === 0) return target.makeEmpty();
    return target.setFromPoints(this.points);
  }

  /** Reverses the vertex order in place. */
  public reverse(): this {
    this.points.reverse();
    return this;
  }

  /* ---------------------------------------------------------------- queries */

  /**
   * Finds the point on the polyline nearest to `point`.
   *
   * Returns an empty result (distance `Infinity`) for a polyline with no
   * segments, rather than throwing: hit testing should not have to special-case
   * an empty stroke.
   */
  public closestPoint(point: Vec2): ClosestPointResult {
    const points = this.points;
    const result: ClosestPointResult = {
      point: new Vec2(),
      distance: Infinity,
      segment: -1,
      t: 0,
    };
    if (points.length < 2) {
      if (points.length === 1) {
        result.point.copy(points[0]);
        result.distance = point.distanceTo(points[0]);
        result.segment = 0;
      }
      return result;
    }

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      let t = 0;
      if (lengthSquared > 0) {
        t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      const px = a.x + t * dx;
      const py = a.y + t * dy;
      const distance = Math.hypot(point.x - px, point.y - py);
      if (distance < result.distance) {
        result.distance = distance;
        result.point.set(px, py);
        result.segment = i;
        result.t = t;
      }
    }
    return result;
  }

  /**
   * Point at a normalised arc-length parameter.
   *
   * @param t Parameter in `[0, 1]`; clamped.
   * @param target Optional point to write into.
   */
  public pointAt(t: number, target: Vec2 = new Vec2()): Vec2 {
    const points = this.points;
    if (points.length === 0) return target.set(0, 0);
    if (points.length === 1) return target.copy(points[0]);

    const lengths = segmentLengths(points, false);
    let total = 0;
    for (const value of lengths) total += value;
    if (total <= 0) return target.copy(points[0]);

    const distance = Math.min(Math.max(t, 0), 1) * total;
    let travelled = 0;
    for (let i = 0; i < lengths.length; i++) {
      const segmentLength = lengths[i];
      if (travelled + segmentLength >= distance || i === lengths.length - 1) {
        const local = segmentLength > 0 ? (distance - travelled) / segmentLength : 0;
        const a = points[i];
        const b = points[i + 1];
        return target.set(
          a.x + (b.x - a.x) * local,
          a.y + (b.y - a.y) * local,
        );
      }
      travelled += segmentLength;
    }
    return target.copy(points[points.length - 1]);
  }

  /**
   * Unit tangent at a normalised arc-length parameter.
   *
   * Degenerate polylines and zero-length segments return `(1, 0)`.
   *
   * @param t Parameter in `[0, 1]`.
   * @param target Optional point to write into.
   */
  public tangentAt(t: number, target: Vec2 = new Vec2()): Vec2 {
    const points = this.points;
    if (points.length < 2) return target.set(1, 0);

    const lengths = segmentLengths(points, false);
    let total = 0;
    for (const value of lengths) total += value;
    if (total <= 0) return target.set(1, 0);

    const distance = Math.min(Math.max(t, 0), 1) * total;
    let travelled = 0;
    for (let i = 0; i < lengths.length; i++) {
      const segmentLength = lengths[i];
      if (travelled + segmentLength >= distance || i === lengths.length - 1) {
        const a = points[i];
        const b = points[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const segment = Math.hypot(dx, dy);
        return segment > 0 ? target.set(dx / segment, dy / segment) : target.set(1, 0);
      }
      travelled += segmentLength;
    }
    return target.set(1, 0);
  }

  /* ------------------------------------------------------------ resampling */

  /**
   * Resamples the polyline into `count` points spaced uniformly by arc length.
   *
   * @param count Number of output points, inclusive of both endpoints.
   * @returns A **new** polyline; `this` is unchanged.
   */
  public resample(count: number): Polyline {
    const target = Math.max(2, Math.floor(count));
    const points = this.points;
    if (points.length < 2) return this.clone();

    const lengths = segmentLengths(points, false);
    let total = 0;
    for (const value of lengths) total += value;
    if (total <= 0) return this.clone();

    const result: Vec2[] = [];
    let travelled = 0;
    let segment = 0;
    for (let i = 0; i < target; i++) {
      const wanted = (i / (target - 1)) * total;
      while (segment < lengths.length - 1 && travelled + lengths[segment] < wanted) {
        travelled += lengths[segment];
        segment++;
      }
      const segmentLength = lengths[segment];
      const local = segmentLength > 0 ? (wanted - travelled) / segmentLength : 0;
      const a = points[segment];
      const b = points[segment + 1];
      result.push(new Vec2(a.x + (b.x - a.x) * local, a.y + (b.y - a.y) * local));
    }
    return new Polyline(result);
  }

  /**
   * Removes vertices that deviate from the simplified path by less than
   * `tolerance` (Ramer–Douglas–Peucker).
   *
   * @param tolerance Maximum discarded deviation; defaults to `0.5`.
   * @returns A **new** polyline.
   */
  public simplify(tolerance: number = 0.5): Polyline {
    return new Polyline(rdpSimplify(this.points, tolerance));
  }

  /**
   * Smooths the polyline with Laplacian relaxation, keeping the endpoints fixed.
   *
   * @param iterations Number of passes; defaults to `1`.
   * @param factor How far each interior vertex moves towards the midpoint of its
   *   neighbours, in `[0, 1]`; defaults to `0.5`.
   * @returns A **new** polyline.
   */
  public smooth(iterations: number = 1, factor: number = 0.5): Polyline {
    const passes = Math.max(0, Math.floor(iterations));
    const blend = Math.min(Math.max(factor, 0), 1);
    let current = this.points.map((point) => point.clone());

    for (let pass = 0; pass < passes; pass++) {
      const next = current.map((point) => point.clone());
      for (let i = 1; i < current.length - 1; i++) {
        const midX = (current[i - 1].x + current[i + 1].x) * 0.5;
        const midY = (current[i - 1].y + current[i + 1].y) * 0.5;
        next[i].set(
          current[i].x + (midX - current[i].x) * blend,
          current[i].y + (midY - current[i].y) * blend,
        );
      }
      current = next;
    }
    return new Polyline(current);
  }

  /* --------------------------------------------------------------- output */

  /**
   * Converts the polyline into an open `Shape` path.
   *
   * The shape is left open (no `closePath`), so triangulating it would produce
   * nothing useful; use it for stroking or for appending further segments.
   */
  public toShape(): Shape {
    const shape = new Shape();
    shape.setFromPoints(this.points);
    return shape;
  }

  /** Copies the vertices from `source`. */
  public copy(source: Polyline): this {
    this.points = source.points.map((point) => point.clone());
    return this;
  }

  /** Returns an independent copy of this polyline. */
  public clone(): Polyline {
    return new Polyline().copy(this);
  }

  /** Flattened `[x, y, ...]` vertex list. */
  public toArray(): number[] {
    const result: number[] = [];
    for (const point of this.points) result.push(point.x, point.y);
    return result;
  }

  /** Serialises the polyline; round-trips through {@link Polyline.fromJSON}. */
  public toJSON(): PolylineJSON {
    return { type: 'Polyline', points: this.toArray() };
  }

  /** Rebuilds a polyline from {@link Polyline.toJSON} output. */
  public static fromJSON(json: PolylineJSON): Polyline {
    const values = json.points ?? [];
    const points: Vec2[] = [];
    for (let i = 0; i + 1 < values.length; i += 2) points.push(new Vec2(values[i], values[i + 1]));
    return new Polyline(points);
  }

  /** `true` when every vertex matches within `tolerance`. */
  public equals(other: Polyline, tolerance: number = 1e-9): boolean {
    if (other.points.length !== this.points.length) return false;
    for (let i = 0; i < this.points.length; i++) {
      if (!this.points[i].equals(other.points[i], tolerance)) return false;
    }
    return true;
  }

  /** Iterates over the vertices. */
  public *[Symbol.iterator](): IterableIterator<Vec2> {
    yield* this.points;
  }

  /** `"Polyline(vertices=5, length=12.5)"`. */
  public toString(): string {
    return `Polyline(vertices=${this.points.length}, length=${this.length.toFixed(4)})`;
  }
}
