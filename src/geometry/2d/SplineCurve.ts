/**
 * `SplineCurve` — a Catmull-Rom spline through an ordered list of 2D points.
 *
 * The spline **interpolates** its control points, so `getPoint(0)` is exactly
 * `points[0]` and `getPoint(1)` is exactly `points[n - 1]`. Three
 * parameterisations are supported, differing only in how the knot spacing is
 * derived from the point distances:
 *
 * | `curveType` | knot weight | behaviour |
 * | --- | --- | --- |
 * | `'centripetal'` (default) | `distance^0.5` | no cusps or self-intersections in the limit |
 * | `'chordal'` | `distance^1` | follows the chord lengths closely, can overshoot |
 * | `'catmullrom'` | uniform | classic uniform Catmull-Rom, controlled by `tension` |
 *
 * Centripetal is the safe default because it is provably free of the cusps and
 * loops that uniform Catmull-Rom produces when two control points are much
 * closer together than their neighbours.
 *
 * @packageDocumentation
 */

import { Vec2 } from '../../math/Vec2';
import { Curve, vec2FromJSON } from './Curve';
import type { CurveJSON, CurveType } from './types';

/** The three supported knot-spacing rules. */
export type SplineCurveType = 'centripetal' | 'chordal' | 'catmullrom';

/* -------------------------------------------------------------------------- */
/* Scalar cubic helpers                                                       */
/* -------------------------------------------------------------------------- */

/** Coefficients of one scalar cubic, evaluated as `c0 + c1·t + c2·t² + c3·t³`. */
interface CubicCoefficients {
  c0: number;
  c1: number;
  c2: number;
  c3: number;
}

/** Uniform Catmull-Rom coefficients for one scalar component. */
function uniformCoefficients(
  x0: number,
  x1: number,
  x2: number,
  x3: number,
  tension: number,
): CubicCoefficients {
  return {
    c0: x1,
    c1: tension * (x2 - x0),
    c2: tension * (2 * x0 - 5 * x1 + 4 * x2 - x3),
    c3: tension * (-x0 + 3 * x1 - 3 * x2 + x3),
  };
}

/** Non-uniform (Barry–Goldman) Catmull-Rom coefficients for one scalar component. */
function nonUniformCoefficients(
  x0: number,
  x1: number,
  x2: number,
  x3: number,
  dt0: number,
  dt1: number,
  dt2: number,
): CubicCoefficients {
  let t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
  let t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
  t1 *= dt1;
  t2 *= dt1;
  return {
    c0: x1,
    c1: t1,
    c2: -3 * x1 + 3 * x2 - 2 * t1 - t2,
    c3: 2 * x1 - 2 * x2 + t1 + t2,
  };
}

/** Evaluates cubic coefficients at `t`. */
function evaluateCubic(coefficients: CubicCoefficients, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return coefficients.c0 + coefficients.c1 * t + coefficients.c2 * t2 + coefficients.c3 * t3;
}

/* -------------------------------------------------------------------------- */
/* SplineCurve                                                                */
/* -------------------------------------------------------------------------- */

/** A Catmull-Rom spline through 2D points. */
export class SplineCurve extends Curve<Vec2> {
  /** Discriminator. */
  public override readonly type: CurveType = 'SplineCurve';

  /** The interpolated control points. */
  public points: Vec2[];

  /** Knot-spacing rule. */
  public curveType: SplineCurveType;

  /** Tension for the uniform parameterisation; `0.5` is the classic value. */
  public tension: number;

  /** `true` to wrap the spline into a loop. */
  public closed: boolean;

  /**
   * Creates a spline.
   *
   * @param points Control points, in order.
   * @param curveType Knot-spacing rule.
   * @param tension Uniform-parameterisation tension.
   * @param closed Wrap the spline into a loop.
   */
  constructor(
    points: Vec2[] = [],
    curveType: SplineCurveType = 'centripetal',
    tension: number = 0.5,
    closed: boolean = false,
  ) {
    super();
    this.points = points;
    this.curveType = curveType;
    this.tension = tension;
    this.closed = closed;
  }

  /** Evaluates the spline at the normalised parameter `t`. */
  public override getPoint(t: number, target: Vec2 = new Vec2()): Vec2 {
    const points = this.points;
    const count = points.length;

    if (count === 0) return target.set(0, 0);
    if (count === 1) return target.copy(points[0]);

    const p = (count - (this.closed ? 0 : 1)) * t;
    let intPoint = Math.floor(p);
    let weight = p - intPoint;

    if (this.closed) {
      intPoint += intPoint > 0 ? 0 : (Math.floor(Math.abs(intPoint) / count) + 1) * count;
    } else if (weight === 0 && intPoint === count - 1) {
      // Landing exactly on the last point must evaluate from the final span.
      intPoint = count - 2;
      weight = 1;
    }

    const p0 = this.resolvePoint(intPoint - 1, points, count, false);
    const p3 = this.resolvePoint(intPoint + 2, points, count, true);
    const p1 = points[intPoint % count];
    const p2 = points[(intPoint + 1) % count];

    if (this.curveType === 'catmullrom') {
      const tension = this.tension;
      const cx = uniformCoefficients(p0.x, p1.x, p2.x, p3.x, tension);
      const cy = uniformCoefficients(p0.y, p1.y, p2.y, p3.y, tension);
      return target.set(evaluateCubic(cx, weight), evaluateCubic(cy, weight));
    }

    // 'centripetal' uses distance^0.5, 'chordal' uses distance^1.
    const power = this.curveType === 'chordal' ? 0.5 : 0.25;
    let dt0 = Math.pow(p0.distanceToSquared(p1), power);
    let dt1 = Math.pow(p1.distanceToSquared(p2), power);
    let dt2 = Math.pow(p2.distanceToSquared(p3), power);

    // Coincident control points produce a zero knot interval; substituting the
    // neighbouring interval keeps the cubic finite and the curve continuous.
    if (dt1 < 1e-4) dt1 = 1;
    if (dt0 < 1e-4) dt0 = dt1;
    if (dt2 < 1e-4) dt2 = dt1;

    const cx = nonUniformCoefficients(p0.x, p1.x, p2.x, p3.x, dt0, dt1, dt2);
    const cy = nonUniformCoefficients(p0.y, p1.y, p2.y, p3.y, dt0, dt1, dt2);
    return target.set(evaluateCubic(cx, weight), evaluateCubic(cy, weight));
  }

  /**
   * Resolves an out-of-range control-point index.
   *
   * Open splines reflect the nearest endpoint (mirroring the missing neighbour
   * across it, which is what keeps the end tangents natural); closed splines
   * wrap around.
   */
  private resolvePoint(index: number, points: Vec2[], count: number, trailing: boolean): Vec2 {
    if (this.closed || (index >= 0 && index < count)) return points[((index % count) + count) % count];
    if (trailing) {
      const last = points[count - 1];
      const previous = points[count - 2] ?? last;
      return new Vec2(last.x + (last.x - previous.x), last.y + (last.y - previous.y));
    }
    const first = points[0];
    const second = points[1] ?? first;
    return new Vec2(first.x + (first.x - second.x), first.y + (first.y - second.y));
  }

  /** Replaces the control points and invalidates the arc-length cache. */
  public setPoints(points: Vec2[]): this {
    this.points = points;
    this.updateArcLengths();
    return this;
  }

  /** Copies the control points and parameters from `source`. */
  public override copy(source: SplineCurve): this {
    super.copy(source);
    this.points = source.points.map((point) => point.clone());
    this.curveType = source.curveType;
    this.tension = source.tension;
    this.closed = source.closed;
    return this;
  }

  /** Returns an independent copy of this spline. */
  public clone(): SplineCurve {
    return new SplineCurve().copy(this);
  }

  /** Serialises the spline; round-trips through {@link SplineCurve.fromJSON}. */
  public override toJSON(): CurveJSON {
    return {
      type: this.type,
      arcLengthDivisions: this.arcLengthDivisions,
      points: this.points.map((point) => point.toArray()),
      curveType: this.curveType,
      tension: this.tension,
      closed: this.closed,
    };
  }

  /** Rebuilds a spline from {@link SplineCurve.toJSON} output. */
  public static fromJSON(json: CurveJSON): SplineCurve {
    const raw = json['points'];
    const points: Vec2[] = Array.isArray(raw) ? raw.map((value) => vec2FromJSON(value)) : [];
    const curveType = json['curveType'];
    const spline = new SplineCurve(
      points,
      curveType === 'chordal' || curveType === 'catmullrom' || curveType === 'centripetal'
        ? curveType
        : 'centripetal',
      typeof json['tension'] === 'number' ? json['tension'] : 0.5,
      json['closed'] === true,
    );
    spline.arcLengthDivisions =
      typeof json.arcLengthDivisions === 'number' ? json.arcLengthDivisions : 200;
    return spline;
  }
}
