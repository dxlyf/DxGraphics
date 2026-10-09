/**
 * `EllipseCurve` — an axis-aligned ellipse, optionally rotated, swept between two
 * angles.
 *
 * ```text
 *   Δ = aEndAngle - aStartAngle                      (unwrapped to at most one turn)
 *   θ(t) = aClockwise ? aStartAngle - t·|Δ| : aStartAngle + t·|Δ|
 *   x(t) = aX + xRadius·cos θ·cos rot - yRadius·sin θ·sin rot
 *   y(t) = aY + xRadius·cos θ·sin rot + yRadius·sin θ·cos rot
 * ```
 *
 * With `aRotation === 0` and `t = 0` the point is exactly `(aX + xRadius, aY)`,
 * which is the invariant the rest of the 2D layer relies on when it builds a
 * circle from `(startAngle, endAngle, clockwise)`.
 *
 * A full turn is emitted when `|Δ| >= 2π`, so the default construction
 * (`0 → 2π`, counter-clockwise) traces the whole ellipse once.
 *
 * @packageDocumentation
 */

import { PI2 } from '../../constants';
import { Vec2 } from '../../math/Vec2';
import { Curve } from './Curve';
import type { CurveJSON, CurveType } from './types';

/** A 2D ellipse (or circle) arc. */
export class EllipseCurve extends Curve<Vec2> {
  /** Discriminator. */
  public override readonly type: CurveType = 'EllipseCurve';

  /** Structural marker. */
  public readonly isEllipseCurve = true;

  /** Centre x. */
  public aX: number;

  /** Centre y. */
  public aY: number;

  /** Radius along the local x axis. */
  public xRadius: number;

  /** Radius along the local y axis. */
  public yRadius: number;

  /** Sweep start angle, in radians. */
  public aStartAngle: number;

  /** Sweep end angle, in radians. */
  public aEndAngle: number;

  /** `true` to sweep from the start angle towards the end angle in the negative direction. */
  public aClockwise: boolean;

  /** Rotation of the ellipse's local frame, in radians. */
  public aRotation: number;

  /**
   * Creates an ellipse arc.
   *
   * @param aX Centre x.
   * @param aY Centre y.
   * @param xRadius Radius along the local x axis.
   * @param yRadius Radius along the local y axis.
   * @param aStartAngle Sweep start, in radians.
   * @param aEndAngle Sweep end, in radians.
   * @param aClockwise Sweep direction.
   * @param aRotation Local frame rotation, in radians.
   */
  constructor(
    aX: number = 0,
    aY: number = 0,
    xRadius: number = 1,
    yRadius: number = 1,
    aStartAngle: number = 0,
    aEndAngle: number = PI2,
    aClockwise: boolean = false,
    aRotation: number = 0,
  ) {
    super();
    this.aX = aX;
    this.aY = aY;
    this.xRadius = xRadius;
    this.yRadius = yRadius;
    this.aStartAngle = aStartAngle;
    this.aEndAngle = aEndAngle;
    this.aClockwise = aClockwise;
    this.aRotation = aRotation;
  }

  /**
   * Signed angular sweep, unwrapped so a full turn is never lost and never
   * doubled.
   */
  private sweep(): number {
    let delta = this.aEndAngle - this.aStartAngle;
    if (this.aClockwise && delta >= PI2) delta -= PI2;
    if (!this.aClockwise && delta <= -PI2) delta += PI2;
    return delta;
  }

  /** Evaluates the arc at the normalised parameter `t`. */
  public override getPoint(t: number, target: Vec2 = new Vec2()): Vec2 {
    const delta = this.sweep();
    const angle = this.aClockwise
      ? this.aStartAngle - t * Math.abs(delta)
      : this.aStartAngle + t * Math.abs(delta);

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const cosRotation = Math.cos(this.aRotation);
    const sinRotation = Math.sin(this.aRotation);

    return target.set(
      this.aX + this.xRadius * cos * cosRotation - this.yRadius * sin * sinRotation,
      this.aY + this.xRadius * cos * sinRotation + this.yRadius * sin * cosRotation,
    );
  }

  /** Unit tangent from the analytic derivative with respect to `t`. */
  public override getTangent(t: number, target: Vec2 = new Vec2()): Vec2 {
    const delta = this.sweep();
    const sweep = Math.abs(delta);
    const direction = this.aClockwise ? -1 : 1;
    const angle = this.aStartAngle + direction * t * sweep;

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const cosRotation = Math.cos(this.aRotation);
    const sinRotation = Math.sin(this.aRotation);

    const dx = (-this.xRadius * sin * cosRotation - this.yRadius * cos * sinRotation) * direction * sweep;
    const dy = (-this.xRadius * sin * sinRotation + this.yRadius * cos * cosRotation) * direction * sweep;

    const length = Math.sqrt(dx * dx + dy * dy);
    return length > 0 ? target.set(dx / length, dy / length) : target.set(1, 0);
  }

  /** Replaces every field and invalidates the arc-length cache. */
  public set(
    aX: number,
    aY: number,
    xRadius: number,
    yRadius: number,
    aStartAngle: number,
    aEndAngle: number,
    aClockwise: boolean,
    aRotation: number,
  ): this {
    this.aX = aX;
    this.aY = aY;
    this.xRadius = xRadius;
    this.yRadius = yRadius;
    this.aStartAngle = aStartAngle;
    this.aEndAngle = aEndAngle;
    this.aClockwise = aClockwise;
    this.aRotation = aRotation;
    this.updateArcLengths();
    return this;
  }

  /** Copies every field from `source`. */
  public override copy(source: EllipseCurve): this {
    super.copy(source);
    this.aX = source.aX;
    this.aY = source.aY;
    this.xRadius = source.xRadius;
    this.yRadius = source.yRadius;
    this.aStartAngle = source.aStartAngle;
    this.aEndAngle = source.aEndAngle;
    this.aClockwise = source.aClockwise;
    this.aRotation = source.aRotation;
    return this;
  }

  /** Returns an independent copy of this arc. */
  public clone(): EllipseCurve {
    return new EllipseCurve().copy(this);
  }

  /** Serialises the arc; round-trips through {@link EllipseCurve.fromJSON}. */
  public override toJSON(): CurveJSON {
    return {
      type: this.type,
      arcLengthDivisions: this.arcLengthDivisions,
      aX: this.aX,
      aY: this.aY,
      xRadius: this.xRadius,
      yRadius: this.yRadius,
      aStartAngle: this.aStartAngle,
      aEndAngle: this.aEndAngle,
      aClockwise: this.aClockwise,
      aRotation: this.aRotation,
    };
  }

  /** Rebuilds an arc from {@link EllipseCurve.toJSON} output. */
  public static fromJSON(json: CurveJSON): EllipseCurve {
    const read = (key: string, fallback: number): number =>
      typeof json[key] === 'number' ? (json[key] as number) : fallback;
    const curve = new EllipseCurve(
      read('aX', 0),
      read('aY', 0),
      read('xRadius', 1),
      read('yRadius', 1),
      read('aStartAngle', 0),
      read('aEndAngle', PI2),
      json['aClockwise'] === true,
      read('aRotation', 0),
    );
    curve.arcLengthDivisions =
      typeof json.arcLengthDivisions === 'number' ? json.arcLengthDivisions : 200;
    return curve;
  }
}
