/**
 * `Triangle` — three 3D vertices with the usual geometric queries.
 *
 * The class stores three `Vec3` instances and caches the derived plane, area and
 * midpoint, invalidating that cache whenever a vertex mutates through
 * {@link set}/{@link setFromPointsAndIndices}/{@link copy}. Direct field writes
 * (`triangle.a.x = ...`) bypass the cache, so call {@link updateCache} in that
 * case.
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import { clamp } from '../utils/MathUtils';
import { Plane } from './Plane';
import { Vec2 } from './Vec2';
import { Vec3 } from './Vec3';

/** Barycentric coordinates `[u, v, w]` weighting `a`, `b` and `c`. */
export type BarycentricCoordinates = [number, number, number];

/** A triangle in 3D space. */
export class Triangle {
  /** First vertex. */
  public readonly a: Vec3;

  /** Second vertex. */
  public readonly b: Vec3;

  /** Third vertex. */
  public readonly c: Vec3;

  /** Lazily computed plane; refresh with {@link getPlane}. */
  private readonly cachedPlane = new Plane();

  /** Lazily computed midpoint; refresh with {@link getMidpoint}. */
  private readonly cachedMidpoint = new Vec3();

  /** Creates a triangle; vertices are copied. */
  constructor(a: Vec3 = new Vec3(), b: Vec3 = new Vec3(), c: Vec3 = new Vec3()) {
    this.a = a.clone();
    this.b = b.clone();
    this.c = c.clone();
    this.updateCache();
  }

  /* ---------------------------------------------------------------- static */

  /** Builds a triangle from three vertices. */
  public static fromPoints(a: Vec3, b: Vec3, c: Vec3): Triangle {
    return new Triangle(a, b, c);
  }

  /**
   * Reference barycentric routine from `Real-Time Collision Detection`.
   *
   * Numerically robust for thin triangles, where the naive two-cross-product
   * formulation loses precision.
   */
  public static barycoordFromPoint(
    point: Vec3,
    a: Vec3,
    b: Vec3,
    c: Vec3,
    target: BarycentricCoordinates = [0, 0, 0],
  ): BarycentricCoordinates {
    const v0 = Triangle.scratchV0.copy(c).sub(a);
    const v1 = Triangle.scratchV1.copy(b).sub(a);
    const v2 = Triangle.scratchV2.copy(point).sub(a);

    const d00 = v0.dot(v0);
    const d01 = v0.dot(v1);
    const d11 = v1.dot(v1);
    const d20 = v2.dot(v0);
    const d21 = v2.dot(v1);
    const denominator = d00 * d11 - d01 * d01;

    if (Math.abs(denominator) <= EPSILON) {
      target[0] = 1;
      target[1] = 0;
      target[2] = 0;
      return target;
    }

    const v = (d11 * d20 - d01 * d21) / denominator;
    const w = (d00 * d21 - d01 * d20) / denominator;
    target[0] = 1 - v - w;
    target[1] = v;
    target[2] = w;
    return target;
  }

  /** Closest point on the triangle `(a, b, c)` to `point`. */
  public static closestPointToPoint(
    point: Vec3,
    a: Vec3,
    b: Vec3,
    c: Vec3,
    target: Vec3 = new Vec3(),
  ): Vec3 {
    const bary = Triangle.barycoordFromPoint(point, a, b, c);
    const u = bary[0];
    const v = bary[1];
    const w = bary[2];

    if (u >= 0 && v >= 0 && w >= 0) {
      // Inside: the projection is already the closest point.
      return target
        .copy(a)
        .multiplyScalar(u)
        .addScaledVector(b, v)
        .addScaledVector(c, w);
    }

    // Outside: check the three edges and pick the nearest.
    const edge = Triangle.scratchEdge;
    const delta = Triangle.scratchDelta;
    const closest = Triangle.scratchClosest;
    target.copy(a).multiplyScalar(u).addScaledVector(b, v).addScaledVector(c, w);
    let best = target.distanceToSquared(point);

    /** Tests the edge `p0 -> p1`. */
    const testEdge = (p0: Vec3, p1: Vec3) => {
      edge.copy(p1).sub(p0);
      delta.copy(point).sub(p0);
      const lengthSquared = edge.lengthSquared();
      const t = lengthSquared <= EPSILON ? 0 : clamp(delta.dot(edge) / lengthSquared, 0, 1);
      closest.copy(p0).addScaledVector(edge, t);
      const distance = closest.distanceToSquared(point);
      if (distance < best) {
        best = distance;
        target.copy(closest);
      }
    };

    testEdge(a, b);
    testEdge(b, c);
    testEdge(c, a);
    return target;
  }

  /** Shared scratch vector for {@link barycoordFromPoint}. */
  private static readonly scratchV0 = new Vec3();
  private static readonly scratchV1 = new Vec3();
  private static readonly scratchV2 = new Vec3();
  private static readonly scratchEdge = new Vec3();
  private static readonly scratchDelta = new Vec3();
  private static readonly scratchClosest = new Vec3();

  /* ------------------------------------------------------------ assignment */

  /** Sets all three vertices. */
  public set(a: Vec3, b: Vec3, c: Vec3): this {
    this.a.copy(a);
    this.b.copy(b);
    this.c.copy(c);
    return this.updateCache();
  }

  /** Sets the vertices from a flat array of positions and three indices. */
  public setFromPointsAndIndices(points: readonly Vec3[], i0: number, i1: number, i2: number): this {
    this.a.copy(points[i0]);
    this.b.copy(points[i1]);
    this.c.copy(points[i2]);
    return this.updateCache();
  }

  /** Copies another triangle. */
  public copy(triangle: Triangle): this {
    this.a.copy(triangle.a);
    this.b.copy(triangle.b);
    this.c.copy(triangle.c);
    return this.updateCache();
  }

  /** Returns a new triangle with the same vertices. */
  public clone(): Triangle {
    return new Triangle(this.a, this.b, this.c);
  }

  /** Recomputes the cached plane and midpoint after direct vertex mutation. */
  public updateCache(): this {
    this.cachedPlane.setFromCoplanarPoints(this.a, this.b, this.c);
    this.cachedMidpoint.copy(this.a).add(this.b).add(this.c).divideScalar(3);
    return this;
  }

  /* -------------------------------------------------------------- geometry */

  /** Geometric normal (not normalised), computed as `(b - a) × (c - a)`. */
  public getNormal(target: Vec3 = new Vec3()): Vec3 {
    const ab = Triangle.scratchV0.copy(this.b).sub(this.a);
    const ac = Triangle.scratchV1.copy(this.c).sub(this.a);
    return target.copy(ab).cross(ac);
  }

  /** Unit vector perpendicular to the triangle's plane. */
  public getNormalizedNormal(target: Vec3 = new Vec3()): Vec3 {
    return this.getNormal(target).normalize();
  }

  /** Cached plane containing the triangle. */
  public getPlane(target: Plane = new Plane()): Plane {
    return target.copy(this.cachedPlane);
  }

  /** Cached centroid. */
  public getMidpoint(target: Vec3 = new Vec3()): Vec3 {
    return target.copy(this.cachedMidpoint);
  }

  /** Area of the triangle. */
  public getArea(): number {
    return this.getNormal(Triangle.scratchClosest).length() * 0.5;
  }

  /** Perimeter of the triangle. */
  public getPerimeter(): number {
    return (
      this.a.distanceTo(this.b) + this.b.distanceTo(this.c) + this.c.distanceTo(this.a)
    );
  }

  /** Signed plane constant (used by clipping helpers). */
  public getPlaneConstant(): number {
    return this.cachedPlane.constant;
  }

  /* --------------------------------------------------------------- queries */

  /** Barycentric coordinates of `point` relative to this triangle. */
  public barycoordFromPoint(point: Vec3, target: BarycentricCoordinates = [0, 0, 0]): BarycentricCoordinates {
    return Triangle.barycoordFromPoint(point, this.a, this.b, this.c, target);
  }

  /** Interpolates a 2D attribute (e.g. UV) at `point`. */
  public interpolate2D(
    point: Vec3,
    uvA: Vec2,
    uvB: Vec2,
    uvC: Vec2,
    target: Vec2 = new Vec2(),
  ): Vec2 {
    const [u, v, w] = this.barycoordFromPoint(point);
    return target.set(
      uvA.x * u + uvB.x * v + uvC.x * w,
      uvA.y * u + uvB.y * v + uvC.y * w,
    );
  }

  /** Interpolates a 3D attribute (e.g. a vertex normal) at `point`. */
  public interpolate3D(
    point: Vec3,
    a: Vec3,
    b: Vec3,
    c: Vec3,
    target: Vec3 = new Vec3(),
  ): Vec3 {
    const [u, v, w] = this.barycoordFromPoint(point);
    return target
      .copy(a)
      .multiplyScalar(u)
      .addScaledVector(b, v)
      .addScaledVector(c, w);
  }

  /** `true` when `point` lies inside the triangle within `tolerance`. */
  public containsPoint(point: Vec3, tolerance: number = 0): boolean {
    const [u, v, w] = this.barycoordFromPoint(point);
    return u >= -tolerance && v >= -tolerance && w >= -tolerance;
  }

  /** Closest point on the triangle to `point`. */
  public closestPointToPoint(point: Vec3, target: Vec3 = new Vec3()): Vec3 {
    return Triangle.closestPointToPoint(point, this.a, this.b, this.c, target);
  }

  /** Distance from `point` to the triangle. */
  public distanceToPoint(point: Vec3): number {
    return this.closestPointToPoint(point).distanceTo(point);
  }

  /** Signed distance from `point` to the triangle's plane. */
  public signedDistanceToPlane(point: Vec3): number {
    return this.cachedPlane.distanceToPoint(point);
  }

  /** `true` when the triangle has non-zero area. */
  public isValid(tolerance: number = EPSILON): boolean {
    return this.getArea() > tolerance;
  }

  /**
   * Uniformly samples a point inside the triangle.
   *
   * @param random Source of randomness in `[0, 1)`; pass a seeded generator for
   *   reproducible sampling.
   */
  public sample(random: () => number = Math.random, target: Vec3 = new Vec3()): Vec3 {
    let u = random();
    let v = random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const w = 1 - u - v;
    return target
      .copy(this.a)
      .multiplyScalar(u)
      .addScaledVector(this.b, v)
      .addScaledVector(this.c, w);
  }

  /* ------------------------------------------------------------ transforms */

  /** Translates all three vertices. */
  public translate(offset: Vec3): this {
    this.a.add(offset);
    this.b.add(offset);
    this.c.add(offset);
    return this.updateCache();
  }

  /** Applies a 4x4 matrix to all three vertices. */
  public applyMat4(m: { elements: ArrayLike<number> } | ArrayLike<number>): this {
    this.a.applyMat4(m);
    this.b.applyMat4(m);
    this.c.applyMat4(m);
    return this.updateCache();
  }

  /** `true` when every vertex matches within `tolerance`. */
  public equals(triangle: Triangle, tolerance: number = EPSILON): boolean {
    return (
      this.a.equals(triangle.a, tolerance) &&
      this.b.equals(triangle.b, tolerance) &&
      this.c.equals(triangle.c, tolerance)
    );
  }

  /* --------------------------------------------------------------- output */

  /** `[a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]`. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    this.a.toArray(target, offset);
    this.b.toArray(target, offset + 3);
    this.c.toArray(target, offset + 6);
    return target;
  }

  /** JSON-friendly representation. */
  public toJSON(): {
    a: { x: number; y: number; z: number };
    b: { x: number; y: number; z: number };
    c: { x: number; y: number; z: number };
  } {
    return { a: this.a.toJSON(), b: this.b.toJSON(), c: this.c.toJSON() };
  }

  /** Human-readable representation. */
  public toString(precision: number = 4): string {
    return `Triangle(${this.a.toString(precision)}, ${this.b.toString(precision)}, ${this.c.toString(precision)})`;
  }

  /** Iterates over the three vertices. */
  public *[Symbol.iterator](): IterableIterator<Vec3> {
    yield this.a;
    yield this.b;
    yield this.c;
  }
}

/** Creates a `Triangle` from three vertices. */
export function triangle(a?: Vec3, b?: Vec3, c?: Vec3): Triangle {
  return new Triangle(a, b, c);
}
