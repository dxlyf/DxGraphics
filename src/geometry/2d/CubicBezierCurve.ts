/**
 * `CubicBezierCurve` — a single cubic Bézier segment.
 *
 * ```text
 *   B(t)  = (1-t)³·v0 + 3(1-t)²t·v1 + 3(1-t)t²·v2 + t³·v3
 *   B'(t) = 3(1-t)²(v1 - v0) + 6(1-t)t(v2 - v1) + 3t²(v3 - v2)
 * ```
 *
 * `getPoint(0)` is exactly `v0` and `getPoint(1)` is exactly `v3`; the midpoint
 * `getPoint(0.5)` is `(v0 + 3·v1 + 3·v2 + v3) / 8`.
 *
 * @packageDocumentation
 */

import { Vec2 } from '../../math/Vec2';
import { Curve, vec2FromJSON } from './Curve';
import type { CurveJSON, CurveType } from './types';

/** A cubic Bézier segment. */
export class CubicBezierCurve extends Curve<Vec2> {
  /** Discriminator. */
  public override readonly type: CurveType = 'CubicBezierCurve';

  /** Start point. */
  public v0: Vec2;

  /** First control point. */
  public v1: Vec2;

  /** Second control point. */
  public v2: Vec2;

  /** End point. */
  public v3: Vec2;

  /**
   * Creates the segment.
   *
   * @param v0 Start point.
   * @param v1 First control point.
   * @param v2 Second control point.
   * @param v3 End point.
   */
  constructor(
    v0: Vec2 = new Vec2(),
    v1: Vec2 = new Vec2(),
    v2: Vec2 = new Vec2(),
    v3: Vec2 = new Vec2(),
  ) {
    super();
    this.v0 = v0;
    this.v1 = v1;
    this.v2 = v2;
    this.v3 = v3;
  }

  /** Evaluates the Bézier at `t` using the explicit polynomial form. */
  public override getPoint(t: number, target: Vec2 = new Vec2()): Vec2 {
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    return target.set(
      a * this.v0.x + b * this.v1.x + c * this.v2.x + d * this.v3.x,
      a * this.v0.y + b * this.v1.y + c * this.v2.y + d * this.v3.y,
    );
  }

  /** Unit tangent from the analytic first derivative. */
  public override getTangent(t: number, target: Vec2 = new Vec2()): Vec2 {
    const mt = 1 - t;
    const dx =
      3 * mt * mt * (this.v1.x - this.v0.x) +
      6 * mt * t * (this.v2.x - this.v1.x) +
      3 * t * t * (this.v3.x - this.v2.x);
    const dy =
      3 * mt * mt * (this.v1.y - this.v0.y) +
      6 * mt * t * (this.v2.y - this.v1.y) +
      3 * t * t * (this.v3.y - this.v2.y);
    const length = Math.sqrt(dx * dx + dy * dy);
    return length > 0 ? target.set(dx / length, dy / length) : target.set(1, 0);
  }

  /** Replaces the four control points and invalidates the arc-length cache. */
  public setPoints(v0: Vec2, v1: Vec2, v2: Vec2, v3: Vec2): this {
    this.v0.copy(v0);
    this.v1.copy(v1);
    this.v2.copy(v2);
    this.v3.copy(v3);
    this.updateArcLengths();
    return this;
  }

  /** Copies the four control points from `source`. */
  public override copy(source: CubicBezierCurve): this {
    super.copy(source);
    this.v0.copy(source.v0);
    this.v1.copy(source.v1);
    this.v2.copy(source.v2);
    this.v3.copy(source.v3);
    return this;
  }

  /** Returns an independent copy of this segment. */
  public clone(): CubicBezierCurve {
    return new CubicBezierCurve().copy(this);
  }

  /** Serialises the segment; round-trips through {@link CubicBezierCurve.fromJSON}. */
  public override toJSON(): CurveJSON {
    return {
      type: this.type,
      arcLengthDivisions: this.arcLengthDivisions,
      v0: this.v0.toArray(),
      v1: this.v1.toArray(),
      v2: this.v2.toArray(),
      v3: this.v3.toArray(),
    };
  }

  /** Rebuilds a segment from {@link CubicBezierCurve.toJSON} output. */
  public static fromJSON(json: CurveJSON): CubicBezierCurve {
    const curve = new CubicBezierCurve(
      vec2FromJSON(json['v0']),
      vec2FromJSON(json['v1']),
      vec2FromJSON(json['v2']),
      vec2FromJSON(json['v3']),
    );
    curve.arcLengthDivisions =
      typeof json.arcLengthDivisions === 'number' ? json.arcLengthDivisions : 200;
    return curve;
  }
}
