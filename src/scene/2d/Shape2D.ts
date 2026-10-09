/**
 * `Shape2D` - a filled and/or stroked vector shape.
 *
 * The shape is described by its type plus the parameters that type needs, which
 * keeps the node allocation-free while still covering the primitives every 2D
 * backend supports: rectangles, rounded rectangles, ellipses and regular
 * polygons.
 *
 * ```ts
 * const badge = new Shape2D({
 *   shape: 'ellipse',
 *   width: 48, height: 48,
 *   fill: { color: '#3af' },
 *   stroke: { color: '#fff', width: 2 },
 * });
 * ```
 *
 * @packageDocumentation
 */

import { DEFAULT_CURVE_SEGMENTS } from '../../constants';
import { Rect } from '../../math/Rect';
import { Vec2 } from '../../math/Vec2';
import { Node2D } from './Node2D';
import type { FillStyle2D, Node2DOptions, StrokeStyle2D } from './types';

/** Primitive drawn by a {@link Shape2D}. */
export type ShapeKind2D = 'rect' | 'roundRect' | 'ellipse' | 'circle' | 'polygon' | 'custom';

/** Options accepted by the {@link Shape2D} constructor. */
export interface Shape2DOptions extends Node2DOptions {
  /** Primitive to draw; defaults to `'rect'`. */
  shape?: ShapeKind2D;
  /** Width of the primitive, in local units. */
  width?: number;
  /** Height of the primitive, in local units. */
  height?: number;
  /** Corner radius for `'roundRect'`, in local units. */
  radius?: number;
  /** Number of sides for `'polygon'`; `3` and above. */
  sides?: number;
  /** Fill description; `null` disables filling. */
  fill?: FillStyle2D | null;
  /** Stroke description; `null` disables stroking. */
  stroke?: StrokeStyle2D | null;
  /** Extra points for a `'custom'` polygon. */
  points?: readonly Vec2[];
}

/** A filled and/or stroked vector shape. */
export class Shape2D extends Node2D {
  /** Allows consumers to detect a shape without an `instanceof` check. */
  public readonly isShape2D: true = true;

  /** Class name used by serialisation and the backend's dispatch. */
  public override readonly type: string = 'Shape2D';

  /** Primitive drawn by this shape. */
  public shape: ShapeKind2D;

  /** Corner radius for `'roundRect'`. */
  public radius: number;

  /** Number of sides for `'polygon'`. */
  public sides: number;

  /** Fill description, or `null`. */
  public fill: FillStyle2D | null;

  /** Stroke description, or `null`. */
  public stroke: StrokeStyle2D | null;

  /** Points of a `'custom'` polygon, in local units. */
  public points: Vec2[];

  /** Tessellation segments used when the backend approximates the shape. */
  public curveSegments: number = DEFAULT_CURVE_SEGMENTS;

  /** Creates a shape. */
  constructor(options: Shape2DOptions = {}) {
    super(options);
    this.shape = options.shape ?? 'rect';
    this.radius = options.radius ?? 0;
    this.sides = options.sides ?? 6;
    this.fill = options.fill ?? { color: '#ffffff' };
    this.stroke = options.stroke ?? null;
    this.points = options.points ? options.points.map((point) => point.clone()) : [];
    if (!this.bounds) {
      this.setBounds(new Rect(0, 0, options.width ?? 0, options.height ?? 0));
    }
  }

  /** Replaces the fill description. */
  public setFill(fill: FillStyle2D | null): this {
    this.fill = fill;
    this.notifyBoundsChanged();
    return this;
  }

  /** Replaces the stroke description. */
  public setStroke(stroke: StrokeStyle2D | null): this {
    this.stroke = stroke;
    this.notifyBoundsChanged();
    return this;
  }

  /** Replaces the custom polygon points. */
  public setPoints(points: readonly Vec2[]): this {
    this.points = points.map((point) => point.clone());
    this.shape = 'custom';
    return this;
  }

  /**
   * Appends the shape's outline to a painter path.
   *
   * The painter owns the path; this method only issues the segment commands, so
   * backends that build their own geometry (SVG, WebGPU) can ignore it.
   *
   * @param painter Backend exposing the path primitives.
   */
  public buildPath(painter: unknown): void {
    const host = painter as {
      beginPath?(): void;
      moveTo?(x: number, y: number): void;
      lineTo?(x: number, y: number): void;
      arc?(
        x: number,
        y: number,
        radius: number,
        startAngle: number,
        endAngle: number,
        counterClockwise?: boolean,
      ): void;
      rect?(x: number, y: number, width: number, height: number): void;
      roundRect?(x: number, y: number, width: number, height: number, radii: number): void;
      closePath?(): void;
    };
    if (typeof host?.beginPath !== 'function') return;
    host.beginPath();

    const width = this.bounds?.width ?? 0;
    const height = this.bounds?.height ?? 0;

    switch (this.shape) {
      case 'rect':
        host.rect?.(0, 0, width, height);
        break;
      case 'roundRect':
        host.roundRect?.(0, 0, width, height, this.radius);
        break;
      case 'ellipse':
      case 'circle': {
        const radiusX = width * 0.5;
        const radiusY = this.shape === 'circle' ? radiusX : height * 0.5;
        const centerX = radiusX;
        const centerY = this.shape === 'circle' ? radiusX : radiusY;
        host.arc?.(centerX, centerY, Math.max(radiusX, radiusY), 0, Math.PI * 2, false);
        break;
      }
      case 'polygon': {
        const sides = Math.max(3, Math.floor(this.sides));
        const radiusX = width * 0.5;
        const radiusY = height * 0.5;
        for (let i = 0; i <= sides; i++) {
          const angle = (i / sides) * Math.PI * 2 - Math.PI / 2;
          const x = radiusX + Math.cos(angle) * radiusX;
          const y = radiusY + Math.sin(angle) * radiusY;
          if (i === 0) host.moveTo?.(x, y);
          else host.lineTo?.(x, y);
        }
        host.closePath?.();
        break;
      }
      default: {
        for (let i = 0; i < this.points.length; i++) {
          const point = this.points[i];
          if (i === 0) host.moveTo?.(point.x, point.y);
          else host.lineTo?.(point.x, point.y);
        }
        if (this.points.length > 2) host.closePath?.();
        break;
      }
    }
  }

  /** Copies the shape state of `source`. */
  public override copy(source: Node2D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof Shape2D) {
      this.shape = source.shape;
      this.radius = source.radius;
      this.sides = source.sides;
      this.fill = source.fill ? { ...source.fill } : null;
      this.stroke = source.stroke
        ? { ...source.stroke, dash: source.stroke.dash ? [...source.stroke.dash] : undefined }
        : null;
      this.points = source.points.map((point) => point.clone());
      this.curveSegments = source.curveSegments;
    }
    return this;
  }

  /** Serialises the shape alongside the node data. */
  public override toJSON(recursive = true): ReturnType<Node2D['toJSON']> {
    const json = super.toJSON(recursive);
    json.shape = this.shape;
    json.radius = this.radius;
    json.sides = this.sides;
    json.curveSegments = this.curveSegments;
    return json;
  }

  /** Returns a new shape with the same state. */
  public override clone(recursive = true): Shape2D {
    return this.createInstance().copy(this, recursive) as Shape2D;
  }

  /** Creates an empty `Shape2D`, used by `clone()`. */
  protected override createInstance(): Node2D {
    return new Shape2D();
  }
}
