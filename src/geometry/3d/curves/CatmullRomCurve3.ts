/**
 * `CatmullRomCurve3` — a smooth interpolating spline through 3D points.
 *
 * Catmull-Rom is the right default for a camera path or a tube because it passes
 * *through* every control point (unlike a Bézier, which only approaches its
 * handles), and because the tangent is analytic from the four surrounding points.
 *
 * Three parameterisations are offered, and the choice matters:
 *
 * | `curveType` | Behaviour |
 * | --- | --- |
 * | `centripetal` (default) | No cusps or self-intersections, even with unevenly spaced points. Barry–Goldman's recommendation, and what a camera path wants. |
 * | `chordal` | Uniform speed in world units, at the cost of possible loops. |
 * | `catmullrom` | Uniform in the parameter; classic, but can overshoot badly. |
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../../math/Vec3';
import { Curve } from '../../2d/Curve';
import type { CurveJSON } from '../../2d/types';
import { Curve3, toVec3 } from './Curve3';

/** The three Catmull-Rom parameterisations. */
export type CatmullRomCurveType = 'centripetal' | 'chordal' | 'catmullrom';

/** Options accepted by {@link CatmullRomCurve3}. */
export interface CatmullRomCurve3Options {
  /** Parameterisation. @default 'centripetal' */
  curveType?: CatmullRomCurveType;
  /** Knot tension; only used by the `'catmullrom'` parameterisation. @default 0.5 */
  tension?: number;
  /** Join the last point back to the first. @default false */
  closed?: boolean;
}

/**
 * A Catmull-Rom spline through an ordered list of 3D points.
 */
export class CatmullRomCurve3 extends Curve3 {
  /** Discriminator used by serialisation and debug output. */
  public readonly type = 'CatmullRomCurve3' as const;

  /** Control points the curve interpolates. */
  public readonly points: Vec3[];

  /** Parameterisation in use. */
  public curveType: CatmullRomCurveType;

  /** Knot tension for the `'catmullrom'` parameterisation. */
  public tension: number;

  /** `true` when the spline wraps around. */
  public closed: boolean;

  /** Per-interval knot parameters, recomputed when the points change. */
  private readonly cache = { lengths: [] as number[] };

  /**
   * @param points Control points, in order.
   * @param options See {@link CatmullRomCurve3Options}.
   */
  constructor(
    points: readonly (Vec3 | readonly [number, number, number])[] = [],
    options: CatmullRomCurve3Options = {},
  ) {
    super();
    this.points = points.map((point) => toVec3(point));
    this.curveType = options.curveType ?? 'centripetal';
    this.tension = options.tension ?? 0.5;
    this.closed = options.closed ?? false;

    if (this.curveType === 'catmullrom' && (this.tension <= 0 || this.tension > 1)) {
      // A tension outside (0, 1] produces a degenerate or exploded spline; fall
      // back rather than emitting NaN geometry downstream.
      this.tension = 0.5;
    }
  }

  /**
   * Point at parameter `t`.
   *
   * @param t Normalised parameter; unclamped so the base class can tabulate the
   *   arc length beyond the ends.
   * @param target Vector to write into.
   * @returns The interpolated point.
   */
  public override getPoint(t: number, target: Vec3 = new Vec3()): Vec3 {
    const points = this.points;
    const count = points.length;

    if (count === 0) return target.set(0, 0, 0);
    if (count === 1) return target.copy(points[0]);
    if (count === 2) return target.copy(points[0]).lerp(points[1], t);

    const segments = this.closed ? count : count - 1;

    // Which interval are we in, and how far through it? For an interior sample the
    // segment index is `floor(t * segments)`, but when `t` lands exactly on an
    // interior control point the sample must evaluate *at* that point: using the
    // preceding interval with weight 1 gives the same result analytically, and the
    // Barry-Goldman form below reproduces it exactly.
    const p = t * segments;
    let intPoint = Math.floor(p);
    let weight = p - intPoint;

    if (this.closed) {
      intPoint = ((intPoint % count) + count) % count;
      weight = weight < 0 ? weight + 1 : weight;
    } else if (weight < 1e-12 && intPoint > 0) {
      // Snap an exact knot hit to the end of the previous interval, so the result
      // is bit-identical to the analytic control point rather than a rounding of it.
      intPoint -= 1;
      weight = 1;
    }

    const p0 = points[this.index(intPoint - 1, count)];
    const p1 = points[this.index(intPoint, count)];
    const p2 = points[this.index(intPoint + 1, count)];
    const p3 = points[this.index(intPoint + 2, count)];

    // Knot spacing, in the units of the chosen parameterisation.
    const t0 = 0;
    const t1 = t0 + this.knot(p0, p1);
    const t2 = t1 + this.knot(p1, p2);
    const t3 = t2 + this.knot(p2, p3);

    // Map `weight ∈ [0, 1]` onto the interval `[t1, t2]`, then run the standard
    // non-uniform Catmull-Rom interpolation. At `weight = 0` this reduces to `p1`
    // exactly and at `weight = 1` to `p2` exactly, which is the defining property
    // of an interpolating spline — and what the previous `t1 / (dt0 + dt1)` form
    // got wrong (it produced `0` at one end and overshot at the other).
    const knot = t1 + weight * (t2 - t1);

    const a1 = interpolate(p0, p1, t1 === t0 ? 0 : (knot - t0) / (t1 - t0), scratchA1);
    const a2 = interpolate(p1, p2, t2 === t1 ? 0 : (knot - t1) / (t2 - t1), scratchA2);
    const a3 = interpolate(p2, p3, t3 === t2 ? 0 : (knot - t2) / (t3 - t2), scratchA3);

    const b1 = interpolate(a1, a2, t2 === t0 ? 0 : (knot - t0) / (t2 - t0), scratchB1);
    const b2 = interpolate(a2, a3, t3 === t1 ? 0 : (knot - t1) / (t3 - t1), scratchB2);

    return interpolate(b1, b2, t2 === t1 ? 0 : (knot - t1) / (t2 - t1), target);
  }

  /**
   * Wraps an index for the closed case and clamps for the open one.
   *
   * @param index Requested neighbour index.
   * @param count Number of control points.
   * @returns A valid index.
   */
  private index(index: number, count: number): number {
    if (this.closed) return ((index % count) + count) % count;
    return Math.max(0, Math.min(index, count - 1));
  }

  /**
   * Knot spacing between two consecutive control points.
   *
   * @param a First point.
   * @param b Second point.
   * @returns The spacing; `1` for the uniform `'catmullrom'` parameterisation.
   */
  private knot(a: Vec3, b: Vec3): number {
    const distance = a.distanceTo(b);
    switch (this.curveType) {
      case 'chordal':
        return Math.sqrt(distance);
      case 'centripetal':
        return Math.pow(distance, 0.25);
      case 'catmullrom':
      default:
        return this.tension;
    }
  }

  /** Recomputes the cached knot lengths after the control points change. */
  public override updateArcLengths(): void {
    this.cache.lengths.length = 0;
    super.updateArcLengths();
  }

  /**
   * Copies another spline.
   *
   * Accepts the base `Curve<Vec3>` type (an override cannot narrow its
   * parameter) and defers to the shared metadata copy for other classes.
   */
  public override copy(source: Curve<Vec3>): this {
    if (!(source instanceof CatmullRomCurve3)) return super.copy(source);
    this.points.length = 0;
    for (const point of source.points) this.points.push(point.clone());
    this.curveType = source.curveType;
    this.tension = source.tension;
    this.closed = source.closed;
    this.updateArcLengths();
    return this;
  }

  /** Returns a new spline with the same control points. */
  public clone(): CatmullRomCurve3 {
    return new CatmullRomCurve3(
      this.points.map((point) => point.clone()),
      { curveType: this.curveType, tension: this.tension, closed: this.closed },
    );
  }

  /**
   * JSON form.
   *
   * `type` reports the concrete class name, which for `SplineCurve3` differs from
   * {@link CatmullRomCurve3.type} — that field must stay `'CatmullRomCurve3'` to
   * satisfy the readonly base contract, so the serialised discriminator is taken
   * from the constructor name instead.
   */
  public override toJSON(): CurveJSON {
    return {
      ...super.toJSON(),
      type: (this.constructor as { name?: string }).name === 'SplineCurve3' ? 'SplineCurve3' : this.type,
      points: this.points.map((point) => point.toArray()),
      curveType: this.curveType,
      tension: this.tension,
      closed: this.closed,
    } as CurveJSON;
  }
}

/**
 * Linear interpolation between two points, written to a target.
 *
 * @param a Start point.
 * @param b End point.
 * @param t Interpolation factor.
 * @param target Vector to write into.
 * @returns The interpolated point.
 */
function interpolate(a: Vec3, b: Vec3, t: number, target: Vec3): Vec3 {
  return target.copy(b).sub(a).multiplyScalar(t).add(a);
}

/** Scratch vectors reused by {@link CatmullRomCurve3.getPoint}. */
const scratchA1 = new Vec3();
const scratchA2 = new Vec3();
const scratchA3 = new Vec3();
const scratchB1 = new Vec3();
const scratchB2 = new Vec3();

/** Convenience factory. */
export function catmullRomCurve3(
  points?: readonly (Vec3 | readonly [number, number, number])[],
  options?: CatmullRomCurve3Options,
): CatmullRomCurve3 {
  return new CatmullRomCurve3(points, options);
}
