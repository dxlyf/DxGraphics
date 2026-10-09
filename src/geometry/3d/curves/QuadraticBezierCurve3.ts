/**
 * `QuadraticBezierCurve3` — a quadratic Bézier in 3D.
 *
 * Evaluated with the closed-form quadratic, and with the analytic derivative for
 * the tangent so no finite difference is needed.
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../../math/Vec3';
import { Curve } from '../../2d/Curve';
import type { CurveJSON } from '../../2d/types';
import { Curve3, toVec3 } from './Curve3';

/**
 * A quadratic Bézier curve defined by three control points.
 *
 * The curve starts at {@link QuadraticBezierCurve3.v0}, ends at
 * {@link QuadraticBezierCurve3.v2} and is pulled towards
 * {@link QuadraticBezierCurve3.v1} — which it does not pass through.
 */
export class QuadraticBezierCurve3 extends Curve3 {
  /** Discriminator used by serialisation and debug output. */
  public readonly type = 'QuadraticBezierCurve3' as const;

  /** Start control point. */
  public readonly v0: Vec3;

  /** Middle control point (the handle). */
  public readonly v1: Vec3;

  /** End control point. */
  public readonly v2: Vec3;

  /**
   * @param v0 Start point.
   * @param v1 Handle.
   * @param v2 End point.
   */
  constructor(
    v0: Vec3 | readonly [number, number, number] = new Vec3(),
    v1: Vec3 | readonly [number, number, number] = new Vec3(),
    v2: Vec3 | readonly [number, number, number] = new Vec3(),
  ) {
    super();
    this.v0 = toVec3(v0);
    this.v1 = toVec3(v1);
    this.v2 = toVec3(v2);
  }

  /**
   * Point at parameter `t`.
   *
   * `B(t) = (1 - t)² v0 + 2(1 - t)t v1 + t² v2`, evaluated in the
   * numerically stable "lerp twice" form so precision holds near the ends.
   *
   * @param t Normalised parameter, unclamped.
   * @param target Vector to write into.
   * @returns The point on the curve.
   */
  public override getPoint(t: number, target: Vec3 = new Vec3()): Vec3 {
    const mt = 1 - t;
    const a = mt * mt;
    const b = 2 * mt * t;
    const c = t * t;
    return target.set(
      a * this.v0.x + b * this.v1.x + c * this.v2.x,
      a * this.v0.y + b * this.v1.y + c * this.v2.y,
      a * this.v0.z + b * this.v1.z + c * this.v2.z,
    );
  }

  /**
   * Analytic unit tangent `B'(t) / |B'(t)|`.
   *
   * @param t Normalised parameter.
   * @param target Vector to write into.
   * @returns The unit tangent; falls back to the finite difference when the
   *   derivative vanishes (a cusp or a degenerate handle).
   */
  public override getTangent(t: number, target: Vec3 = new Vec3()): Vec3 {
    const mt = 1 - t;
    target.set(
      2 * (mt * (this.v1.x - this.v0.x) + t * (this.v2.x - this.v1.x)),
      2 * (mt * (this.v1.y - this.v0.y) + t * (this.v2.y - this.v1.y)),
      2 * (mt * (this.v1.z - this.v0.z) + t * (this.v2.z - this.v1.z)),
    );
    if (target.lengthSquared() > 1e-20) return target.normalize();
    return super.getTangent(t, target);
  }

  /**
   * Copies another curve of this kind.
   *
   * Accepts the base `Curve<Vec3>` type (an override cannot narrow its
   * parameter) and falls back to the shared metadata copy when the argument is
   * a different curve class.
   */
  public override copy(source: Curve<Vec3>): this {
    if (!(source instanceof QuadraticBezierCurve3)) return super.copy(source);
    this.v0.copy(source.v0);
    this.v1.copy(source.v1);
    this.v2.copy(source.v2);
    this.updateArcLengths();
    return this;
  }

  /** Returns a new curve with the same control points. */
  public clone(): QuadraticBezierCurve3 {
    return new QuadraticBezierCurve3(this.v0, this.v1, this.v2);
  }

  /** JSON form. */
  public override toJSON(): CurveJSON {
    return {
      ...super.toJSON(),
      v0: this.v0.toArray(),
      v1: this.v1.toArray(),
      v2: this.v2.toArray(),
    };
  }
}

/** Convenience factory. */
export function quadraticBezierCurve3(
  v0?: Vec3 | readonly [number, number, number],
  v1?: Vec3 | readonly [number, number, number],
  v2?: Vec3 | readonly [number, number, number],
): QuadraticBezierCurve3 {
  return new QuadraticBezierCurve3(v0, v1, v2);
}
