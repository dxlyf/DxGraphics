/**
 * `SplineCurve3` — a uniform Catmull-Rom spline through 3D points.
 *
 * Kept as its own class (rather than an alias of `CatmullRomCurve3`) because the
 * two have different contracts: this one is *uniform* in the parameter, which is
 * what most authoring tools mean by "spline", while `CatmullRomCurve3` defaults to
 * the centripetal parameterisation that avoids cusps.
 *
 * Use this when the control points are already roughly evenly spaced and you want
 * the cheapest possible evaluation; use `CatmullRomCurve3` otherwise.
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../../math/Vec3';
import { CatmullRomCurve3 } from './CatmullRomCurve3';

/**
 * A uniform Catmull-Rom spline over a list of 3D points.
 */
export class SplineCurve3 extends CatmullRomCurve3 {
  /**
   * Discriminator inherited from `CatmullRomCurve3`.
   *
   * A subclass cannot narrow a readonly literal property, so this stays
   * `'CatmullRomCurve3'` to satisfy the base contract. Use
   * {@link SplineCurve3.kind} when the uniform-parameterisation identity
   * matters.
   */
  public override readonly type = 'CatmullRomCurve3' as const;

  /** Distinguishes this class from its `CatmullRomCurve3` parent. */
  public readonly kind = 'SplineCurve3' as const;
  /**
   * @param points Control points, in order.
   * @param closed Join the last point back to the first.
   */
  constructor(
    points: readonly (Vec3 | readonly [number, number, number])[] = [],
    closed: boolean = false,
  ) {
    // `'catmullrom'` is the uniform parameterisation: every knot spans the same
    // parameter interval regardless of the point spacing.
    super(points, { curveType: 'catmullrom', tension: 1, closed });
  }

  /**
   * Returns a new uniform spline with the same control points.
   *
   * Named `cloneSpline` rather than `clone` because `clone` is inherited from
   * `CatmullRomCurve3` with a `CatmullRomCurve3` return type, and an override
   * may only narrow covariantly from the *base* declaration — narrowing past
   * an intermediate override is not expressible.
   */
  public cloneSpline(): SplineCurve3 {
    return new SplineCurve3(
      this.points.map((point) => point.clone()),
      this.closed,
    );
  }
}

/** Convenience factory. */
export function splineCurve3(
  points?: readonly (Vec3 | readonly [number, number, number])[],
  closed?: boolean,
): SplineCurve3 {
  return new SplineCurve3(points, closed);
}
