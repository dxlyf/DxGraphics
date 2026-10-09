/**
 * `LineCurve` — a straight 2D segment from `v1` to `v2`.
 *
 * Parameter and arc length coincide, so `getPointAt` is `getPoint` and the
 * arc-length table is exact for any division count.
 *
 * @packageDocumentation
 */

import { Vec2 } from '../../math/Vec2';
import { Curve, vec2FromJSON } from './Curve';
import type { CurveJSON, CurveType } from './types';

/** A straight 2D line segment. */
export class LineCurve extends Curve<Vec2> {
  /** Discriminator. */
  public override readonly type: CurveType = 'LineCurve';

  /** Start point. */
  public v1: Vec2;

  /** End point. */
  public v2: Vec2;

  /**
   * Creates a segment.
   *
   * @param v1 Start point.
   * @param v2 End point.
   */
  constructor(v1: Vec2 = new Vec2(), v2: Vec2 = new Vec2()) {
    super();
    this.v1 = v1;
    this.v2 = v2;
  }

  /**
   * Evaluates the segment; `t = 0` gives `v1`, `t = 1` gives `v2`, and values
   * outside `[0, 1]` extrapolate along the line.
   */
  public override getPoint(t: number, target: Vec2 = new Vec2()): Vec2 {
    return target.set(
      this.v1.x + (this.v2.x - this.v1.x) * t,
      this.v1.y + (this.v2.y - this.v1.y) * t,
    );
  }

  /** Identical to {@link LineCurve.getPoint} because the speed is constant. */
  public override getPointAt(u: number, target: Vec2 = new Vec2()): Vec2 {
    return this.getPoint(u, target);
  }

  /** Unit direction from `v1` to `v2`; `(1, 0)` for a degenerate segment. */
  public override getTangent(_t: number, target: Vec2 = new Vec2()): Vec2 {
    const dx = this.v2.x - this.v1.x;
    const dy = this.v2.y - this.v1.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    return length > 0 ? target.set(dx / length, dy / length) : target.set(1, 0);
  }

  /** Replaces both endpoints and invalidates the arc-length cache. */
  public setPoints(v1: Vec2, v2: Vec2): this {
    this.v1.copy(v1);
    this.v2.copy(v2);
    this.updateArcLengths();
    return this;
  }

  /** Copies both endpoints from `source`. */
  public override copy(source: LineCurve): this {
    super.copy(source);
    this.v1.copy(source.v1);
    this.v2.copy(source.v2);
    return this;
  }

  /** Returns an independent copy of this segment. */
  public clone(): LineCurve {
    return new LineCurve().copy(this);
  }

  /** Serialises the segment; round-trips through {@link LineCurve.fromJSON}. */
  public override toJSON(): CurveJSON {
    return {
      type: this.type,
      arcLengthDivisions: this.arcLengthDivisions,
      v1: this.v1.toArray(),
      v2: this.v2.toArray(),
    };
  }

  /** Rebuilds a segment from {@link LineCurve.toJSON} output. */
  public static fromJSON(json: CurveJSON): LineCurve {
    const curve = new LineCurve(
      vec2FromJSON(json['v1']),
      vec2FromJSON(json['v2']),
    );
    curve.arcLengthDivisions = typeof json.arcLengthDivisions === 'number' ? json.arcLengthDivisions : 200;
    return curve;
  }
}
