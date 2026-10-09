/**
 * `QuadraticBezierCurve` — a single quadratic Bézier segment.
 *
 * ```text
 *   B(t) = (1-t)²·v0 + 2(1-t)t·v1 + t²·v2
 *   B'(t) = 2(1-t)(v1 - v0) + 2t(v2 - v1)
 * ```
 *
 * `getPoint(0)` is exactly `v0` and `getPoint(1)` is exactly `v2`; the midpoint
 * `getPoint(0.5)` is `(v0 + 2·v1 + v2) / 4`.
 *
 * @packageDocumentation
 */

import { Vec2 } from '../../math/Vec2';
import { Curve, vec2FromJSON } from './Curve';
import type { CurveJSON, CurveType } from './types';

/** A quadratic Bézier segment. */
export class QuadraticBezierCurve extends Curve<Vec2> {
  /** Discriminator. */
  public override readonly type: CurveType = 'QuadraticBezierCurve';

  /** Start point. */
  public v0: Vec2;

  /** Control point. */
  public v1: Vec2;

  /** End point. */
  public v2: Vec2;

  /**
   * Creates the segment.
   *
   * @param v0 Start point.
   * @param v1 Control point.
   * @param v2 End point.
   */
  constructor(v0: Vec2 = new Vec2(), v1: Vec2 = new Vec2(), v2: Vec2 = new Vec2()) {
    super();
    this.v0 = v0;
    this.v1 = v1;
    this.v2 = v2;
  }

  /** Evaluates the Bézier at `t` using the explicit polynomial form. */
  public override getPoint(t: number, target: Vec2 = new Vec2()): Vec2 {
    const mt = 1 - t;
    const a = mt * mt;
    const b = 2 * mt * t;
    const c = t * t;
    return target.set(
      a * this.v0.x + b * this.v1.x + c * this.v2.x,
      a * this.v0.y + b * this.v1.y + c * this.v2.y,
    );
  }

  /** Unit tangent from the analytic first derivative. */
  public override getTangent(t: number, target: Vec2 = new Vec2()): Vec2 {
    const mt = 1 - t;
    const dx = 2 * mt * (this.v1.x - this.v0.x) + 2 * t * (this.v2.x - this.v1.x);
    const dy = 2 * mt * (this.v1.y - this.v0.y) + 2 * t * (this.v2.y - this.v1.y);
    const length = Math.sqrt(dx * dx + dy * dy);
    return length > 0 ? target.set(dx / length, dy / length) : target.set(1, 0);
  }

  /** Replaces the three control points and invalidates the arc-length cache. */
  public setPoints(v0: Vec2, v1: Vec2, v2: Vec2): this {
    this.v0.copy(v0);
    this.v1.copy(v1);
    this.v2.copy(v2);
    this.updateArcLengths();
    return this;
  }

  /** Copies the three control points from `source`. */
  public override copy(source: QuadraticBezierCurve): this {
    super.copy(source);
    this.v0.copy(source.v0);
    this.v1.copy(source.v1);
    this.v2.copy(source.v2);
    return this;
  }

  /** Returns an independent copy of this segment. */
  public clone(): QuadraticBezierCurve {
    return new QuadraticBezierCurve().copy(this);
  }

  /** Serialises the segment; round-trips through {@link QuadraticBezierCurve.fromJSON}. */
  public override toJSON(): CurveJSON {
    return {
      type: this.type,
      arcLengthDivisions: this.arcLengthDivisions,
      v0: this.v0.toArray(),
      v1: this.v1.toArray(),
      v2: this.v2.toArray(),
    };
  }

  /** Rebuilds a segment from {@link QuadraticBezierCurve.toJSON} output. */
  public static fromJSON(json: CurveJSON): QuadraticBezierCurve {
    const curve = new QuadraticBezierCurve(
      vec2FromJSON(json['v0']),
      vec2FromJSON(json['v1']),
      vec2FromJSON(json['v2']),
    );
    curve.arcLengthDivisions =
      typeof json.arcLengthDivisions === 'number' ? json.arcLengthDivisions : 200;
    return curve;
  }
}
