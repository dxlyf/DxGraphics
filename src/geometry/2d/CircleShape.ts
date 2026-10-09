/**
 * `CircleShape` — a circle shape built from a full elliptical arc.
 *
 * `getLength()` is the circumference up to the numerical accuracy of the
 * arc-length integration (the default 200 divisions keep the error below
 * `10⁻⁵` relative), and `closePath()` adds nothing because the arc already ends
 * where it starts.
 *
 * @packageDocumentation
 */

import { PI2 } from '../../constants';
import { Vec2 } from '../../math/Vec2';
import { Shape } from './Shape';
import type { ShapeJSON } from './types';

/** Serialised form of a {@link CircleShape}. */
export interface CircleShapeJSON extends ShapeJSON {
  /** Centre x. */
  x: number;
  /** Centre y. */
  y: number;
  /** Radius. */
  radius: number;
}

/** A circle. */
export class CircleShape extends Shape {
  /** Centre x. */
  public x: number;

  /** Centre y. */
  public y: number;

  /** Radius. */
  public radius: number;

  /**
   * Creates a circle.
   *
   * @param x Centre x.
   * @param y Centre y.
   * @param radius Radius.
   */
  constructor(x: number = 0, y: number = 0, radius: number = 1) {
    super();
    this.x = x;
    this.y = y;
    this.radius = radius;
    this.rebuild();
  }

  /** Rebuilds the outline from the current centre and radius. */
  private rebuild(): void {
    this.curves = [];
    this.holes = [];
    this.currentPoint.set(0, 0);
    this.updateArcLengths();

    this.absarc(this.x, this.y, this.radius, 0, PI2, false);
    // The arc already ends at its start, so this is a no-op; it is kept so the
    // shape is explicitly closed for consumers that inspect the segment list.
    this.closePath();
  }

  /** Replaces the centre and radius. */
  public set(x: number, y: number, radius: number): this {
    this.x = x;
    this.y = y;
    this.radius = radius;
    this.rebuild();
    return this;
  }

  /** Creates a circle. */
  public static create(x: number, y: number, radius: number): CircleShape {
    return new CircleShape(x, y, radius);
  }

  /** Enclosed area. */
  public get area(): number {
    return Math.PI * this.radius * this.radius;
  }

  /** Circumference. */
  public get circumference(): number {
    return PI2 * Math.abs(this.radius);
  }

  /** Axis-aligned bounds of the circle. */
  public getBounds(): { min: Vec2; max: Vec2 } {
    const r = Math.abs(this.radius);
    return { min: new Vec2(this.x - r, this.y - r), max: new Vec2(this.x + r, this.y + r) };
  }

  /** `true` when `point` lies inside or on the circle. */
  public containsPoint(point: Vec2): boolean {
    const dx = point.x - this.x;
    const dy = point.y - this.y;
    return dx * dx + dy * dy <= this.radius * this.radius;
  }

  /**
   * Samples the circle into a polygon.
   *
   * @param x Centre x.
   * @param y Centre y.
   * @param radius Radius.
   * @param segments Number of segments; the first point is not repeated.
   */
  public static toPolygon(
    x: number,
    y: number,
    radius: number,
    segments: number = 64,
  ): Vec2[] {
    const count = Math.max(3, Math.floor(segments));
    const points: Vec2[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * PI2;
      points[i] = new Vec2(x + radius * Math.cos(angle), y + radius * Math.sin(angle));
    }
    return points;
  }

  /** Serialises the circle; round-trips through {@link CircleShape.fromJSON}. */
  public override toJSON(): CircleShapeJSON {
    return { ...super.toJSON(), type: 'Shape', x: this.x, y: this.y, radius: this.radius };
  }

  /** Rebuilds a circle from {@link CircleShape.toJSON} output. */
  public static override fromJSON(json: CircleShapeJSON): CircleShape {
    return new CircleShape(
      typeof json.x === 'number' ? json.x : 0,
      typeof json.y === 'number' ? json.y : 0,
      typeof json.radius === 'number' ? json.radius : 1,
    );
  }
}
