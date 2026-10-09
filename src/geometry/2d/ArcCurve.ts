/**
 * `ArcCurve` — a circular arc defined by centre, radius and start/end angle.
 *
 * It is a thin specialisation of {@link EllipseCurve} with `xRadius ===
 * yRadius === aRadius`, which keeps the sweep-direction semantics identical
 * across both classes and avoids a second copy of the unwrapping logic.
 *
 * One subtlety matters for the 2D layer: a **full** circle built with
 * `absarc(…, 0, 2π, false)` followed by `Path.closePath()` must have a length
 * equal to the circumference, not the circumference plus a spurious chord. The
 * closing segment is appended at the exact start point, so its length is zero;
 * that is why the arc-length table must be built from `getPoint`, which is exact
 * at both ends.
 *
 * @packageDocumentation
 */

import { EPSILON, PI2 } from '../../constants';
import { Vec2 } from '../../math/Vec2';
import { wrapAngle360 } from '../../utils/MathUtils';
import { Curve } from './Curve';
import { EllipseCurve } from './EllipseCurve';
import type { CurveJSON, CurveType } from './types';

/** A circular arc. */
export class ArcCurve extends Curve<Vec2> {
  /** Discriminator. */
  public override readonly type: CurveType = 'ArcCurve';

  /** Structural marker. */
  public readonly isArcCurve = true;

  /** Centre x. */
  public aX: number;

  /** Centre y. */
  public aY: number;

  /** Radius. */
  public aRadius: number;

  /** Sweep start angle, in radians. */
  public aStartAngle: number;

  /** Sweep end angle, in radians. */
  public aEndAngle: number;

  /** `true` to sweep in the negative angular direction. */
  public aClockwise: boolean;

  /** Backing ellipse that performs the actual evaluation. */
  private readonly ellipse: EllipseCurve;

  /**
   * Creates an arc.
   *
   * @param aX Centre x.
   * @param aY Centre y.
   * @param aRadius Radius.
   * @param aStartAngle Sweep start, in radians.
   * @param aEndAngle Sweep end, in radians.
   * @param aClockwise Sweep direction.
   */
  constructor(
    aX: number = 0,
    aY: number = 0,
    aRadius: number = 1,
    aStartAngle: number = 0,
    aEndAngle: number = PI2,
    aClockwise: boolean = false,
  ) {
    super();
    this.aX = aX;
    this.aY = aY;
    this.aRadius = aRadius;
    this.aStartAngle = aStartAngle;
    this.aEndAngle = aEndAngle;
    this.aClockwise = aClockwise;
    this.ellipse = new EllipseCurve(
      aX,
      aY,
      aRadius,
      aRadius,
      aStartAngle,
      aEndAngle,
      aClockwise,
      0,
    );
  }

  /** Pushes the current fields into the backing ellipse. */
  private syncEllipse(): void {
    this.ellipse.set(
      this.aX,
      this.aY,
      this.aRadius,
      this.aRadius,
      this.aStartAngle,
      this.aEndAngle,
      this.aClockwise,
      0,
    );
  }

  /** Evaluates the arc at the normalised parameter `t`. */
  public override getPoint(t: number, target: Vec2 = new Vec2()): Vec2 {
    return this.ellipse.getPoint(t, target);
  }

  /** Unit tangent, taken from the backing ellipse's analytic derivative. */
  public override getTangent(t: number, target: Vec2 = new Vec2()): Vec2 {
    return this.ellipse.getTangent(t, target);
  }

  /** Replaces every field and invalidates the arc-length cache. */
  public set(
    aX: number,
    aY: number,
    aRadius: number,
    aStartAngle: number,
    aEndAngle: number,
    aClockwise: boolean,
  ): this {
    this.aX = aX;
    this.aY = aY;
    this.aRadius = aRadius;
    this.aStartAngle = aStartAngle;
    this.aEndAngle = aEndAngle;
    this.aClockwise = aClockwise;
    this.syncEllipse();
    this.updateArcLengths();
    return this;
  }

  /** Copies every field from `source`. */
  public override copy(source: ArcCurve): this {
    super.copy(source);
    this.aX = source.aX;
    this.aY = source.aY;
    this.aRadius = source.aRadius;
    this.aStartAngle = source.aStartAngle;
    this.aEndAngle = source.aEndAngle;
    this.aClockwise = source.aClockwise;
    this.syncEllipse();
    return this;
  }

  /** Returns an independent copy of this arc. */
  public clone(): ArcCurve {
    return new ArcCurve().copy(this);
  }

  /**
   * Builds the unique circular arc through three points.
   *
   * The circumcentre and radius come from the standard determinant formula; the
   * direction is chosen so the arc actually passes through the middle point
   * `p2`, and a clockwise sweep is selected when `p2` does not lie on the
   * counter-clockwise path from `p1` to `p3`.
   *
   * @param p1 Start point.
   * @param p2 A point the arc must pass through.
   * @param p3 End point.
   * @throws Error when the three points are collinear, in which case no finite
   *   circle passes through them and any returned arc would be wrong.
   */
  public static fromThreePoints(p1: Vec2, p2: Vec2, p3: Vec2): ArcCurve {
    const ax = p1.x;
    const ay = p1.y;
    const bx = p2.x;
    const by = p2.y;
    const cx = p3.x;
    const cy = p3.y;

    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < EPSILON) {
      throw new Error(
        'ArcCurve.fromThreePoints(): the three points are collinear, so no unique circle passes through them',
      );
    }

    const aSquared = ax * ax + ay * ay;
    const bSquared = bx * bx + by * by;
    const cSquared = cx * cx + cy * cy;

    const centreX = (aSquared * (by - cy) + bSquared * (cy - ay) + cSquared * (ay - by)) / d;
    const centreY = (aSquared * (cx - bx) + bSquared * (ax - cx) + cSquared * (bx - ax)) / d;
    const radius = Math.hypot(ax - centreX, ay - centreY);

    const startAngle = Math.atan2(ay - centreY, ax - centreX);
    const midAngle = Math.atan2(by - centreY, bx - centreX);
    const endAngle = Math.atan2(cy - centreY, cx - centreX);

    const counterClockwiseSweep = wrapAngle360(endAngle - startAngle);
    const counterClockwiseToMid = wrapAngle360(midAngle - startAngle);
    const clockwise = counterClockwiseToMid > counterClockwiseSweep;

    return new ArcCurve(centreX, centreY, radius, startAngle, endAngle, clockwise);
  }

  /** Serialises the arc; round-trips through {@link ArcCurve.fromJSON}. */
  public override toJSON(): CurveJSON {
    return {
      type: this.type,
      arcLengthDivisions: this.arcLengthDivisions,
      aX: this.aX,
      aY: this.aY,
      aRadius: this.aRadius,
      aStartAngle: this.aStartAngle,
      aEndAngle: this.aEndAngle,
      aClockwise: this.aClockwise,
    };
  }

  /** Rebuilds an arc from {@link ArcCurve.toJSON} output. */
  public static fromJSON(json: CurveJSON): ArcCurve {
    const read = (key: string, fallback: number): number =>
      typeof json[key] === 'number' ? (json[key] as number) : fallback;
    const curve = new ArcCurve(
      read('aX', 0),
      read('aY', 0),
      read('aRadius', 1),
      read('aStartAngle', 0),
      read('aEndAngle', PI2),
      json['aClockwise'] === true,
    );
    curve.arcLengthDivisions =
      typeof json.arcLengthDivisions === 'number' ? json.arcLengthDivisions : 200;
    return curve;
  }
}
