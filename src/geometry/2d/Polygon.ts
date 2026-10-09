/**
 * `Polygon` — a closed vertex list with area, winding and containment queries.
 *
 * A polygon is the "solid" counterpart of {@link Polyline}: it wraps a vertex
 * list, keeps the winding information that decides the sign of the area, and
 * exposes the predicates the 2D layer needs (convexity, containment, simplicity)
 * plus the reductions used before triangulation.
 *
 * All derived values (area, centroid, perimeter, bounds) are computed on demand
 * from the vertex list, so there is no cache to invalidate: mutate `points` and
 * the next query sees the change.
 *
 * ```ts
 * const square = Polygon.fromPoints([new Vec2(0, 0), new Vec2(1, 0), new Vec2(1, 1), new Vec2(0, 1)]);
 * square.area;              // 1
 * square.isClockwise;       // false
 * square.containsPoint(new Vec2(0.5, 0.5)); // true
 * ```
 *
 * @packageDocumentation
 */

import { Box2 } from '../../math/Box2';
import { Vec2 } from '../../math/Vec2';
import { Shape } from './Shape';
import { distanceToSegment, rdpSimplify, segmentLengths } from './Polyline';
import {
  earClip,
  isClockWise,
  pointInPolygon,
  segmentsIntersect,
  signedArea,
  triangulateShape,
} from './Triangulate';
import type { PolygonJSON, PolygonOrientation, TriangulationResult } from './types';

/** Anything a polygon constructor accepts as a vertex. */
export type PolygonPoint = Vec2 | [number, number] | { x: number; y: number };

/** Twice the signed area of the triangle `(a, b, c)`. */
function cross3(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** A closed polygon. */
export class Polygon {
  /** The ordered vertices; the closing point is implicit and must not be repeated. */
  public points: Vec2[];

  /**
   * Creates a polygon.
   *
   * @param points Vertices; tuples and object literals are copied into `Vec2`s.
   */
  constructor(points: ReadonlyArray<PolygonPoint> = []) {
    this.points = [];
    this.setFromPoints(points);
  }

  /** Creates a polygon from a vertex list. */
  public static fromPoints(points: ReadonlyArray<PolygonPoint>): Polygon {
    return new Polygon(points);
  }

  /** Number of vertices. */
  public get count(): number {
    return this.points.length;
  }

  /** Replaces the vertex list. */
  public setFromPoints(points: ReadonlyArray<PolygonPoint>): this {
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

  /* ------------------------------------------------------------------ metrics */

  /**
   * Signed area (shoelace).
   *
   * Positive for a counter-clockwise contour in a y-up coordinate system,
   * negative for a clockwise one.
   */
  public getSignedArea(): number {
    return signedArea(this.points);
  }

  /** Absolute area. */
  public get area(): number {
    return Math.abs(signedArea(this.points));
  }

  /** Total edge length, including the closing edge. */
  public get perimeter(): number {
    const lengths = segmentLengths(this.points, true);
    let total = 0;
    for (const value of lengths) total += value;
    return total;
  }

  /**
   * Area-weighted centroid.
   *
   * Falls back to the vertex average when the polygon has (numerically) zero
   * area, which is the only sensible answer for a degenerate contour.
   */
  public get centroid(): Vec2 {
    const points = this.points;
    const count = points.length;
    if (count === 0) return new Vec2();
    if (count < 3) {
      let x = 0;
      let y = 0;
      for (const point of points) {
        x += point.x;
        y += point.y;
      }
      return new Vec2(x / count, y / count);
    }

    let doubleArea = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < count; i++) {
      const a = points[i];
      const b = points[(i + 1) % count];
      const cross = a.x * b.y - b.x * a.y;
      doubleArea += cross;
      cx += (a.x + b.x) * cross;
      cy += (a.y + b.y) * cross;
    }

    if (Math.abs(doubleArea) < 1e-12) {
      let x = 0;
      let y = 0;
      for (const point of points) {
        x += point.x;
        y += point.y;
      }
      return new Vec2(x / count, y / count);
    }

    const factor = 1 / (3 * doubleArea);
    return new Vec2(cx * factor, cy * factor);
  }

  /** Axis-aligned bounds; an empty polygon yields an empty box. */
  public getBounds(target: Box2 = new Box2()): Box2 {
    if (this.points.length === 0) return target.makeEmpty();
    return target.setFromPoints(this.points);
  }

  /* ------------------------------------------------------------------ winding */

  /** `true` when the contour winds clockwise. */
  public get isClockwise(): boolean {
    return isClockWise(this.points);
  }

  /** Winding classification; `'degenerate'` when the area is negligible. */
  public get orientation(): PolygonOrientation {
    const area = signedArea(this.points);
    if (Math.abs(area) < 1e-12) return 'degenerate';
    return area < 0 ? 'clockwise' : 'counter-clockwise';
  }

  /**
   * `true` when every turn has the same sign.
   *
   * Collinear vertices are ignored, so a polygon with redundant collinear points
   * is still reported as convex.
   */
  public get isConvex(): boolean {
    const points = this.points;
    const count = points.length;
    if (count < 4) return true;

    let sign = 0;
    for (let i = 0; i < count; i++) {
      const value = cross3(points[i], points[(i + 1) % count], points[(i + 2) % count]);
      if (Math.abs(value) < 1e-12) continue;
      const current = value > 0 ? 1 : -1;
      if (sign === 0) sign = current;
      else if (sign !== current) return false;
    }
    return true;
  }

  /** Reverses the vertex order in place, flipping the winding. */
  public reverse(): this {
    this.points.reverse();
    return this;
  }

  /* --------------------------------------------------------------- predicates */

  /**
   * `true` when `point` lies inside the polygon or on one of its edges.
   *
   * The boundary is included explicitly, because an even-odd scan alone gives an
   * arbitrary answer for a point that sits exactly on an edge.
   *
   * @param point Query point.
   * @param tolerance Boundary tolerance.
   */
  public containsPoint(point: Vec2, tolerance: number = 1e-9): boolean {
    if (this.points.length < 3) return false;
    if (this.pointOnEdge(point, tolerance)) return true;
    return pointInPolygon(point, this.points);
  }

  /**
   * `true` when `point` lies within `tolerance` of any edge.
   *
   * @param point Query point.
   * @param tolerance Maximum distance to the edge.
   */
  public pointOnEdge(point: Vec2, tolerance: number = 1e-9): boolean {
    const points = this.points;
    const count = points.length;
    if (count < 2) return false;
    for (let i = 0; i < count; i++) {
      if (distanceToSegment(point, points[i], points[(i + 1) % count]) <= tolerance) return true;
    }
    return false;
  }

  /**
   * `true` when the contour does not cross itself.
   *
   * Detects proper crossings between non-adjacent edges and any repeated vertex.
   * Edges that merely touch at a shared endpoint do not count, but a vertex that
   * appears twice does.
   */
  public isSimple(): boolean {
    const points = this.points;
    const count = points.length;
    if (count < 3) return false;

    const seen = new Set<string>();
    for (const point of points) {
      const key = `${point.x}|${point.y}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }

    for (let i = 0; i < count; i++) {
      const a0 = points[i];
      const a1 = points[(i + 1) % count];
      for (let j = i + 1; j < count; j++) {
        // Skip adjacent edges, which always share an endpoint.
        if (j === i) continue;
        if ((j + 1) % count === i) continue;
        if (j === (i + 1) % count) continue;
        const b0 = points[j];
        const b1 = points[(j + 1) % count];
        if (segmentsIntersect(a0, a1, b0, b1)) return false;
      }
    }
    return true;
  }

  /* ------------------------------------------------------------- conversions */

  /**
   * Converts the polygon into a closed `Shape`.
   *
   * The shape is closed with {@link Path.closePath}, so `shape.triangulate()`
   * works directly.
   */
  public toShape(): Shape {
    const shape = new Shape();
    shape.setFromPoints(this.points);
    shape.closePath();
    return shape;
  }

  /**
   * Triangulates the polygon (no holes).
   *
   * Winding is normalised internally, so either orientation is accepted.
   */
  public triangulate(): TriangulationResult {
    return triangulateShape(this.points, []);
  }

  /**
   * Triangle indices into {@link Polygon.points}, for callers that want to keep
   * their own attribute arrays alongside the polygon.
   *
   * The polygon must already be counter-clockwise; run {@link Polygon.reverse}
   * first if it is not.
   */
  public triangulateIndices(): number[] {
    return this.isClockwise ? earClip([...this.points].reverse()) : earClip(this.points);
  }

  /* --------------------------------------------------------------- reductions */

  /**
   * Removes vertices that deviate from the contour by less than `tolerance`.
   *
   * The contour is split at its leftmost and rightmost vertices into two chains,
   * each reduced with Ramer–Douglas–Peucker, and the chains are recombined. That
   * is necessary because RDP needs two distinct endpoints, which a ring does not
   * have.
   *
   * @param tolerance Maximum discarded deviation; defaults to `0.5`.
   * @returns A **new** polygon.
   */
  public simplify(tolerance: number = 0.5): Polygon {
    const points = this.points;
    const count = points.length;
    if (count < 4 || tolerance <= 0) return this.clone();

    let minIndex = 0;
    let maxIndex = 0;
    for (let i = 1; i < count; i++) {
      if (points[i].x < points[minIndex].x) minIndex = i;
      if (points[i].x > points[maxIndex].x) maxIndex = i;
    }
    if (minIndex === maxIndex) return this.clone();

    const start = Math.min(minIndex, maxIndex);
    const end = Math.max(minIndex, maxIndex);

    const firstChain = points.slice(start, end + 1);
    const secondChain = [...points.slice(end), ...points.slice(0, start + 1)];

    const simplifiedFirst = rdpSimplify(firstChain, tolerance);
    const simplifiedSecond = rdpSimplify(secondChain, tolerance);

    // Drop each chain's last vertex: it is the other chain's first.
    const combined = [...simplifiedFirst.slice(0, -1), ...simplifiedSecond.slice(0, -1)];
    return new Polygon(combined.length >= 3 ? combined : points);
  }

  /**
   * Resamples the contour into `count` vertices spaced uniformly by arc length.
   *
   * @param count Number of output vertices; at least 3.
   * @returns A **new** polygon.
   */
  public resample(count: number): Polygon {
    const target = Math.max(3, Math.floor(count));
    const points = this.points;
    const vertexCount = points.length;
    if (vertexCount < 2) return this.clone();

    const lengths = segmentLengths(points, true);
    let total = 0;
    for (const value of lengths) total += value;
    if (total <= 0) return this.clone();

    const step = total / target;
    const result: Vec2[] = [];
    let segment = 0;
    let travelled = 0;
    for (let i = 0; i < target; i++) {
      const wanted = i * step;
      while (segment < lengths.length - 1 && travelled + lengths[segment] < wanted) {
        travelled += lengths[segment];
        segment++;
      }
      const segmentLength = lengths[segment];
      const local = segmentLength > 0 ? (wanted - travelled) / segmentLength : 0;
      const a = points[segment % vertexCount];
      const b = points[(segment + 1) % vertexCount];
      result.push(new Vec2(a.x + (b.x - a.x) * local, a.y + (b.y - a.y) * local));
    }
    return new Polygon(result);
  }

  /* ------------------------------------------------------------------- copies */

  /** Copies the vertices from `source`. */
  public copy(source: Polygon): this {
    this.points = source.points.map((point) => point.clone());
    return this;
  }

  /** Returns an independent copy of this polygon. */
  public clone(): Polygon {
    return new Polygon().copy(this);
  }

  /** `true` when every vertex matches within `tolerance` (order matters). */
  public equals(other: Polygon, tolerance: number = 1e-9): boolean {
    if (other.points.length !== this.points.length) return false;
    for (let i = 0; i < this.points.length; i++) {
      if (!this.points[i].equals(other.points[i], tolerance)) return false;
    }
    return true;
  }

  /** Flattened `[x, y, ...]` vertex list. */
  public toArray(): number[] {
    const result: number[] = [];
    for (const point of this.points) result.push(point.x, point.y);
    return result;
  }

  /** Serialises the polygon; round-trips through {@link Polygon.fromJSON}. */
  public toJSON(): PolygonJSON {
    return { type: 'Polygon', points: this.toArray() };
  }

  /** Rebuilds a polygon from {@link Polygon.toJSON} output. */
  public static fromJSON(json: PolygonJSON): Polygon {
    const values = json.points ?? [];
    const points: Vec2[] = [];
    for (let i = 0; i + 1 < values.length; i += 2) points.push(new Vec2(values[i], values[i + 1]));
    return new Polygon(points);
  }

  /** Iterates over the vertices. */
  public *[Symbol.iterator](): IterableIterator<Vec2> {
    yield* this.points;
  }

  /** `"Polygon(vertices=4, area=1.0000, ccw)"`. */
  public toString(): string {
    return `Polygon(vertices=${this.points.length}, area=${this.area.toFixed(4)}, ${
      this.isClockwise ? 'cw' : 'ccw'
    })`;
  }
}
