/**
 * `RectShape` — an axis-aligned rectangle shape.
 *
 * Built from four corner commands plus {@link Path.closePath}, so
 * `getLength()` is exactly the perimeter.
 *
 * @packageDocumentation
 */

import { Vec2 } from '../../math/Vec2';
import { Shape } from './Shape';
import { RoundedRectShape } from './RoundedRectShape';
import type { ShapeJSON } from './types';

/** Serialised form of a {@link RectShape}. */
export interface RectShapeJSON extends ShapeJSON {
  /** Left edge. */
  x: number;
  /** Bottom edge. */
  y: number;
  /** Width. */
  width: number;
  /** Height. */
  height: number;
}

/** An axis-aligned rectangle. */
export class RectShape extends Shape {
  /** Left edge. */
  public x: number;

  /** Bottom edge. */
  public y: number;

  /** Width; may be negative, in which case the rectangle is built in reverse. */
  public width: number;

  /** Height; may be negative. */
  public height: number;

  /**
   * Creates a rectangle.
   *
   * @param x Left edge.
   * @param y Bottom edge.
   * @param width Width.
   * @param height Height.
   */
  constructor(x: number = 0, y: number = 0, width: number = 0, height: number = 0) {
    super();
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.rebuild();
  }

  /** Appends the four corners to the (already cleared) path. */
  private rebuild(): void {
    this.curves = [];
    this.holes = [];
    this.currentPoint.set(0, 0);
    this.updateArcLengths();

    const right = this.x + this.width;
    const top = this.y + this.height;
    this.moveTo(this.x, this.y);
    this.lineTo(right, this.y);
    this.lineTo(right, top);
    this.lineTo(this.x, top);
    this.closePath();
  }

  /** Replaces the geometry. */
  public set(x: number, y: number, width: number, height: number): this {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.rebuild();
    return this;
  }

  /** Creates a rectangle. */
  public static create(x: number, y: number, width: number, height: number): RectShape {
    return new RectShape(x, y, width, height);
  }

  /**
   * Creates a rounded rectangle.
   *
   * Returns a {@link RoundedRectShape} rather than a `RectShape` because the
   * rounded form has its own area and containment maths.
   */
  public static createRounded(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): RoundedRectShape {
    return RoundedRectShape.create(x, y, width, height, radius);
  }

  /** Creates a rectangle from its extremes. */
  public static fromBounds(minX: number, minY: number, maxX: number, maxY: number): RectShape {
    return new RectShape(minX, minY, maxX - minX, maxY - minY);
  }

  /** Enclosed area (`negative` when width and height have opposite signs). */
  public get area(): number {
    return this.width * this.height;
  }

  /** Outline length. */
  public get perimeter(): number {
    return 2 * (Math.abs(this.width) + Math.abs(this.height));
  }

  /** Axis-aligned bounds of the rectangle. */
  public getBounds(): { min: Vec2; max: Vec2 } {
    const right = this.x + this.width;
    const top = this.y + this.height;
    return {
      min: new Vec2(Math.min(this.x, right), Math.min(this.y, top)),
      max: new Vec2(Math.max(this.x, right), Math.max(this.y, top)),
    };
  }

  /** `true` when `point` lies inside or on the rectangle. */
  public containsPoint(point: Vec2): boolean {
    const right = this.x + this.width;
    const top = this.y + this.height;
    return (
      point.x >= Math.min(this.x, right) &&
      point.x <= Math.max(this.x, right) &&
      point.y >= Math.min(this.y, top) &&
      point.y <= Math.max(this.y, top)
    );
  }

  /** Serialises the rectangle; round-trips through {@link RectShape.fromJSON}. */
  public override toJSON(): RectShapeJSON {
    return { ...super.toJSON(), type: 'Shape', x: this.x, y: this.y, width: this.width, height: this.height };
  }

  /** Rebuilds a rectangle from {@link RectShape.toJSON} output. */
  public static override fromJSON(json: RectShapeJSON): RectShape {
    return new RectShape(
      typeof json.x === 'number' ? json.x : 0,
      typeof json.y === 'number' ? json.y : 0,
      typeof json.width === 'number' ? json.width : 0,
      typeof json.height === 'number' ? json.height : 0,
    );
  }
}
