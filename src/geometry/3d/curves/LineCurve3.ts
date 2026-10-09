/**
 * `LineCurve3` — a straight segment between two 3D points.
 *
 * The 3D counterpart of `LineCurve`, and the building block every other 3D curve
 * falls back to when it needs a straight piece.
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../../math/Vec3';
import { Curve } from '../../2d/Curve';
import type { CurveJSON } from '../../2d/types';
import { Curve3, toVec3 } from './Curve3';

/** A straight line segment in 3D. */
export class LineCurve3 extends Curve3 {
  /** Discriminator used by serialisation and debug output. */
  public readonly type = 'LineCurve3' as const;

  /** Start point. */
  public readonly v1: Vec3;

  /** End point. */
  public readonly v2: Vec3;

  /**
   * @param v1 Start point.
   * @param v2 End point.
   */
  constructor(
    v1: Vec3 | readonly [number, number, number] = new Vec3(),
    v2: Vec3 | readonly [number, number, number] = new Vec3(),
  ) {
    super();
    this.v1 = toVec3(v1);
    this.v2 = toVec3(v2);
  }

  /**
   * Point at parameter `t`, linearly interpolated and **not** clamped.
   *
   * `t` outside `[0, 1]` extrapolates along the same line, which the curve base
   * class relies on when it builds its arc-length table.
   *
   * @param t Normalised parameter.
   * @param target Vector to write into.
   * @returns The point.
   */
  public override getPoint(t: number, target: Vec3 = new Vec3()): Vec3 {
    return target.copy(this.v2).sub(this.v1).multiplyScalar(t).add(this.v1);
  }

  /**
   * Unit tangent, which is constant along the segment.
   *
   * Overridden rather than left to the base class's finite difference: the
   * analytic value is exact and free.
   *
   * @param _t Parameter; irrelevant for a straight line.
   * @param target Vector to write into.
   * @returns The unit tangent, or `(0, 0, 0)` for a degenerate segment.
   */
  public override getTangent(_t: number, target: Vec3 = new Vec3()): Vec3 {
    return target.copy(this.v2).sub(this.v1).normalize();
  }

  /**
   * Copies another curve of this kind.
   *
   * Accepts the base `Curve<Vec3>` type (an override cannot narrow its
   * parameter) and falls back to the shared metadata copy when the argument is
   * a different curve class.
   */
  public override copy(source: Curve<Vec3>): this {
    if (!(source instanceof LineCurve3)) return super.copy(source);
    this.v1.copy(source.v1);
    this.v2.copy(source.v2);
    this.updateArcLengths();
    return this;
  }

  /** Returns a new segment with the same endpoints. */
  public clone(): LineCurve3 {
    return new LineCurve3(this.v1, this.v2);
  }

  /** JSON form. */
  public override toJSON(): CurveJSON {
    return {
      ...super.toJSON(),
      v1: this.v1.toArray(),
      v2: this.v2.toArray(),
    };
  }
}

/** Convenience factory. */
export function lineCurve3(
  v1?: Vec3 | readonly [number, number, number],
  v2?: Vec3 | readonly [number, number, number],
): LineCurve3 {
  return new LineCurve3(v1, v2);
}
