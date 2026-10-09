/**
 * `CubicBezierCurve3` — a cubic Bézier in 3D.
 *
 * The most useful 3D curve in practice: two endpoints and two handles give enough
 * freedom for a smooth path through a scene, and the analytic derivative makes the
 * tangent (and therefore the Frenet frame) exact.
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../../math/Vec3';
import { Curve } from '../../2d/Curve';
import type { CurveJSON } from '../../2d/types';
import { Curve3, toVec3 } from './Curve3';

/**
 * A cubic Bézier curve defined by four control points.
 */
export class CubicBezierCurve3 extends Curve3 {
  /** Discriminator used by serialisation and debug output. */
  public readonly type = 'CubicBezierCurve3' as const;

  /** Start point. */
  public readonly v0: Vec3;

  /** Handle leaving {@link CubicBezierCurve3.v0}. */
  public readonly v1: Vec3;

  /** Handle arriving at {@link CubicBezierCurve3.v3}. */
  public readonly v2: Vec3;

  /** End point. */
  public readonly v3: Vec3;

  /**
   * @param v0 Start point.
   * @param v1 First handle.
   * @param v2 Second handle.
   * @param v3 End point.
   */
  constructor(
    v0: Vec3 | readonly [number, number, number] = new Vec3(),
    v1: Vec3 | readonly [number, number, number] = new Vec3(),
    v2: Vec3 | readonly [number, number, number] = new Vec3(),
    v3: Vec3 | readonly [number, number, number] = new Vec3(),
  ) {
    super();
    this.v0 = toVec3(v0);
    this.v1 = toVec3(v1);
    this.v2 = toVec3(v2);
    this.v3 = toVec3(v3);
  }

  /**
   * Point at parameter `t`.
   *
   * `B(t) = (1-t)³ v0 + 3(1-t)²t v1 + 3(1-t)t² v2 + t³ v3`.
   *
   * @param t Normalised parameter, unclamped.
   * @param target Vector to write into.
   * @returns The point on the curve.
   */
  public override getPoint(t: number, target: Vec3 = new Vec3()): Vec3 {
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    return target.set(
      a * this.v0.x + b * this.v1.x + c * this.v2.x + d * this.v3.x,
      a * this.v0.y + b * this.v1.y + c * this.v2.y + d * this.v3.y,
      a * this.v0.z + b * this.v1.z + c * this.v2.z + d * this.v3.z,
    );
  }

  /**
   * Analytic unit tangent.
   *
   * `B'(t) = 3(1-t)² (v1 - v0) + 6(1-t)t (v2 - v1) + 3t² (v3 - v2)`.
   *
   * @param t Normalised parameter.
   * @param target Vector to write into.
   * @returns The unit tangent, or the finite-difference fallback at a cusp.
   */
  public override getTangent(t: number, target: Vec3 = new Vec3()): Vec3 {
    const mt = 1 - t;
    const a = 3 * mt * mt;
    const b = 6 * mt * t;
    const c = 3 * t * t;
    target.set(
      a * (this.v1.x - this.v0.x) + b * (this.v2.x - this.v1.x) + c * (this.v3.x - this.v2.x),
      a * (this.v1.y - this.v0.y) + b * (this.v2.y - this.v1.y) + c * (this.v3.y - this.v2.y),
      a * (this.v1.z - this.v0.z) + b * (this.v2.z - this.v1.z) + c * (this.v3.z - this.v2.z),
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
    if (!(source instanceof CubicBezierCurve3)) return super.copy(source);
    this.v0.copy(source.v0);
    this.v1.copy(source.v1);
    this.v2.copy(source.v2);
    this.v3.copy(source.v3);
    this.updateArcLengths();
    return this;
  }

  /** Returns a new curve with the same control points. */
  public clone(): CubicBezierCurve3 {
    return new CubicBezierCurve3(this.v0, this.v1, this.v2, this.v3);
  }

  /** JSON form. */
  public override toJSON(): CurveJSON {
    return {
      ...super.toJSON(),
      v0: this.v0.toArray(),
      v1: this.v1.toArray(),
      v2: this.v2.toArray(),
      v3: this.v3.toArray(),
    };
  }
}

/** Convenience factory. */
export function cubicBezierCurve3(
  v0?: Vec3 | readonly [number, number, number],
  v1?: Vec3 | readonly [number, number, number],
  v2?: Vec3 | readonly [number, number, number],
  v3?: Vec3 | readonly [number, number, number],
): CubicBezierCurve3 {
  return new CubicBezierCurve3(v0, v1, v2, v3);
}
