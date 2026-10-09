/**
 * `EllipseShape` — an ellipse shape, optionally rotated about its centre.
 *
 * @packageDocumentation
 */

import { PI2 } from '../../constants';
import { Vec2 } from '../../math/Vec2';
import { Shape } from './Shape';
import type { ShapeJSON } from './types';

/** Serialised form of an {@link EllipseShape}. */
export interface EllipseShapeJSON extends ShapeJSON {
  /** Centre x. */
  x: number;
  /** Centre y. */
  y: number;
  /** Radius along the local x axis. */
  xRadius: number;
  /** Radius along the local y axis. */
  yRadius: number;
  /** Local frame rotation, in radians. */
  rotation: number;
}

/** An ellipse. */
export class EllipseShape extends Shape {
  /** Centre x. */
  public x: number;

  /** Centre y. */
  public y: number;

  /** Radius along the local x axis. */
  public xRadius: number;

  /** Radius along the local y axis. */
  public yRadius: number;

  /** Local frame rotation, in radians. */
  public rotation: number;

  /**
   * Creates an ellipse.
   *
   * @param x Centre x.
   * @param y Centre y.
   * @param xRadius Radius along the local x axis.
   * @param yRadius Radius along the local y axis.
   * @param rotation Local frame rotation, in radians.
   */
  constructor(
    x: number = 0,
    y: number = 0,
    xRadius: number = 1,
    yRadius: number = 1,
    rotation: number = 0,
  ) {
    super();
    this.x = x;
    this.y = y;
    this.xRadius = xRadius;
    this.yRadius = yRadius;
    this.rotation = rotation;
    this.rebuild();
  }

  /** Rebuilds the outline from the current parameters. */
  private rebuild(): void {
    this.curves = [];
    this.holes = [];
    this.currentPoint.set(0, 0);
    this.updateArcLengths();

    this.absellipse(this.x, this.y, this.xRadius, this.yRadius, 0, PI2, false, this.rotation);
    this.closePath();
  }

  /** Replaces every parameter. */
  public set(x: number, y: number, xRadius: number, yRadius: number, rotation: number): this {
    this.x = x;
    this.y = y;
    this.xRadius = xRadius;
    this.yRadius = yRadius;
    this.rotation = rotation;
    this.rebuild();
    return this;
  }

  /** Creates an ellipse. */
  public static create(
    x: number,
    y: number,
    xRadius: number,
    yRadius: number,
    rotation: number = 0,
  ): EllipseShape {
    return new EllipseShape(x, y, xRadius, yRadius, rotation);
  }

  /** Enclosed area. */
  public get area(): number {
    return Math.PI * Math.abs(this.xRadius * this.yRadius);
  }

  /**
   * Ramanujan's second approximation of the perimeter.
   *
   * Accurate to better than `10⁻⁵` relative for all eccentricities, which is far
   * tighter than the arc-length integration the exact `getLength()` performs.
   */
  public get approxCircumference(): number {
    const a = Math.abs(this.xRadius);
    const b = Math.abs(this.yRadius);
    const h = ((a - b) * (a - b)) / ((a + b) * (a + b));
    return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  }

  /** Axis-aligned bounds of the rotated ellipse. */
  public getBounds(): { min: Vec2; max: Vec2 } {
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    const a = Math.abs(this.xRadius);
    const b = Math.abs(this.yRadius);
    const halfWidth = Math.hypot(a * cos, b * sin);
    const halfHeight = Math.hypot(a * sin, b * cos);
    return {
      min: new Vec2(this.x - halfWidth, this.y - halfHeight),
      max: new Vec2(this.x + halfWidth, this.y + halfHeight),
    };
  }

  /** `true` when `point` lies inside or on the ellipse. */
  public containsPoint(point: Vec2): boolean {
    const cos = Math.cos(-this.rotation);
    const sin = Math.sin(-this.rotation);
    const dx = point.x - this.x;
    const dy = point.y - this.y;
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    if (this.xRadius === 0 || this.yRadius === 0) return false;
    return (localX * localX) / (this.xRadius * this.xRadius) + (localY * localY) / (this.yRadius * this.yRadius) <= 1;
  }

  /**
   * Samples the ellipse into a polygon.
   *
   * @param x Centre x.
   * @param y Centre y.
   * @param xRadius Radius along the local x axis.
   * @param yRadius Radius along the local y axis.
   * @param segments Number of segments; the first point is not repeated.
   * @param rotation Local frame rotation, in radians.
   */
  public static toPolygon(
    x: number,
    y: number,
    xRadius: number,
    yRadius: number,
    segments: number = 64,
    rotation: number = 0,
  ): Vec2[] {
    const count = Math.max(3, Math.floor(segments));
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const points: Vec2[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * PI2;
      const px = xRadius * Math.cos(angle);
      const py = yRadius * Math.sin(angle);
      points[i] = new Vec2(x + px * cos - py * sin, y + px * sin + py * cos);
    }
    return points;
  }

  /** Serialises the ellipse; round-trips through {@link EllipseShape.fromJSON}. */
  public override toJSON(): EllipseShapeJSON {
    return {
      ...super.toJSON(),
      type: 'Shape',
      x: this.x,
      y: this.y,
      xRadius: this.xRadius,
      yRadius: this.yRadius,
      rotation: this.rotation,
    };
  }

  /** Rebuilds an ellipse from {@link EllipseShape.toJSON} output. */
  public static override fromJSON(json: EllipseShapeJSON): EllipseShape {
    return new EllipseShape(
      typeof json.x === 'number' ? json.x : 0,
      typeof json.y === 'number' ? json.y : 0,
      typeof json.xRadius === 'number' ? json.xRadius : 1,
      typeof json.yRadius === 'number' ? json.yRadius : 1,
      typeof json.rotation === 'number' ? json.rotation : 0,
    );
  }
}
