/**
 * `RoundedRectShape` — a rectangle with quarter-circle corners.
 *
 * The radius is clamped to `min(|width|, |height|) / 2`, which is the largest
 * value for which the four corner arcs still meet rather than overlap. Each
 * corner sweeps exactly `π/2`.
 *
 * @packageDocumentation
 */

import { HALF_PI } from '../../constants';
import { Vec2 } from '../../math/Vec2';
import { Shape } from './Shape';
import type { ShapeJSON } from './types';

/** Serialised form of a {@link RoundedRectShape}. */
export interface RoundedRectShapeJSON extends ShapeJSON {
  /** Left edge. */
  x: number;
  /** Bottom edge. */
  y: number;
  /** Width. */
  width: number;
  /** Height. */
  height: number;
  /** Corner radius actually used (already clamped). */
  radius: number;
}

/** A rectangle with rounded corners. */
export class RoundedRectShape extends Shape {
  /** Left edge. */
  public x: number;

  /** Bottom edge. */
  public y: number;

  /** Width. */
  public width: number;

  /** Height. */
  public height: number;

  /** Corner radius, already clamped to half the shortest side. */
  public radius: number;

  /**
   * Creates a rounded rectangle.
   *
   * @param x Left edge.
   * @param y Bottom edge.
   * @param width Width.
   * @param height Height.
   * @param radius Corner radius; clamped to `min(|width|, |height|) / 2`.
   */
  constructor(
    x: number = 0,
    y: number = 0,
    width: number = 0,
    height: number = 0,
    radius: number = 0,
  ) {
    super();
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.radius = clampRadius(width, height, radius);
    this.rebuild();
  }

  /** Rebuilds the outline from the current parameters. */
  private rebuild(): void {
    this.curves = [];
    this.holes = [];
    this.currentPoint.set(0, 0);
    this.updateArcLengths();

    const x = this.x;
    const y = this.y;
    const w = this.width;
    const h = this.height;
    const r = this.radius;
    const right = x + w;
    const top = y + h;

    if (r <= 0) {
      this.moveTo(x, y);
      this.lineTo(right, y);
      this.lineTo(right, top);
      this.lineTo(x, top);
      this.closePath();
      return;
    }

    // Counter-clockwise, starting at the bottom-left corner's arc end.
    this.moveTo(x + r, y);
    this.lineTo(right - r, y);
    this.absarc(right - r, y + r, r, -HALF_PI, 0, false);
    this.lineTo(right, top - r);
    this.absarc(right - r, top - r, r, 0, HALF_PI, false);
    this.lineTo(x + r, top);
    this.absarc(x + r, top - r, r, HALF_PI, Math.PI, false);
    this.lineTo(x, y + r);
    this.absarc(x + r, y + r, r, Math.PI, HALF_PI * 3, false);
    this.closePath();
  }

  /** Replaces every parameter and re-clamps the radius. */
  public set(x: number, y: number, width: number, height: number, radius: number): this {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.radius = clampRadius(width, height, radius);
    this.rebuild();
    return this;
  }

  /** Creates a rounded rectangle. */
  public static create(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): RoundedRectShape {
    return new RoundedRectShape(x, y, width, height, radius);
  }

  /**
   * Enclosed area: the rectangle minus the four corner cut-outs.
   *
   * Each cut-out is `r² - πr²/4`, so the total removed area is `(4 - π)·r²`.
   */
  public get area(): number {
    const r = this.radius;
    return this.width * this.height - (4 - Math.PI) * r * r;
  }

  /** Axis-aligned bounds. */
  public getBounds(): { min: Vec2; max: Vec2 } {
    const right = this.x + this.width;
    const top = this.y + this.height;
    return {
      min: new Vec2(Math.min(this.x, right), Math.min(this.y, top)),
      max: new Vec2(Math.max(this.x, right), Math.max(this.y, top)),
    };
  }

  /** `true` when `point` lies inside or on the rounded rectangle. */
  public containsPoint(point: Vec2): boolean {
    const minX = Math.min(this.x, this.x + this.width);
    const maxX = Math.max(this.x, this.x + this.width);
    const minY = Math.min(this.y, this.y + this.height);
    const maxY = Math.max(this.y, this.y + this.height);
    const r = this.radius;

    if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) return false;

    // Only the four corner squares need the circular test.
    const nearLeft = point.x < minX + r;
    const nearRight = point.x > maxX - r;
    const nearBottom = point.y < minY + r;
    const nearTop = point.y > maxY - r;
    if ((!nearLeft && !nearRight) || (!nearBottom && !nearTop)) return true;

    const centreX = nearLeft ? minX + r : maxX - r;
    const centreY = nearBottom ? minY + r : maxY - r;
    const dx = point.x - centreX;
    const dy = point.y - centreY;
    return dx * dx + dy * dy <= r * r;
  }

  /** Serialises the shape; round-trips through {@link RoundedRectShape.fromJSON}. */
  public override toJSON(): RoundedRectShapeJSON {
    return {
      ...super.toJSON(),
      type: 'Shape',
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      radius: this.radius,
    };
  }

  /** Rebuilds the shape from {@link RoundedRectShape.toJSON} output. */
  public static override fromJSON(json: RoundedRectShapeJSON): RoundedRectShape {
    return new RoundedRectShape(
      typeof json.x === 'number' ? json.x : 0,
      typeof json.y === 'number' ? json.y : 0,
      typeof json.width === 'number' ? json.width : 0,
      typeof json.height === 'number' ? json.height : 0,
      typeof json.radius === 'number' ? json.radius : 0,
    );
  }
}

/** Clamps a corner radius to half the shortest side, and to zero for a negative input. */
function clampRadius(width: number, height: number, radius: number): number {
  if (!(radius > 0)) return 0;
  return Math.min(radius, Math.min(Math.abs(width), Math.abs(height)) / 2);
}
