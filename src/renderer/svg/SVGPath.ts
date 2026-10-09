/**
 * SVG path builder.
 *
 * Produces the `d` attribute of a `<path>` element. The builder holds no DOM
 * reference, so it is pure string work and unit-testable in Node.
 *
 * Curve and geometry helpers consume the library's shapes **structurally**: they
 * accept anything that can report points — `{ getPoint(t) }` for parametric
 * curves, `{ x, y }` objects, `[x, y]` tuples, or plain number pairs — and never
 * import `src/geometry`.
 *
 * ```ts
 * new SVGPath().moveTo(0, 0).lineTo(10, 10).close().toString();  // 'M 0 0 L 10 10 Z'
 * ```
 *
 * @packageDocumentation
 */

import { DEFAULT_CURVE_DIVISIONS, DEFAULT_PRECISION } from '../../constants';
import { roundTo } from '../../utils/MathUtils';

/* -------------------------------------------------------------------------- */
/* Structural shapes                                                          */
/* -------------------------------------------------------------------------- */

/** A point as `{ x, y }`. */
export interface PathPoint {
  x: number;
  y: number;
}

/** Anything that can be read as a point. */
export type PathPointLike = PathPoint | readonly [number, number] | readonly number[];

/** A parametric curve: `getPoint(t)` for `t` in 0..1. */
export interface CurveLike {
  getPoint(t: number): PathPoint;
}

/** A rectangle-like object. */
export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A circle/ellipse-like object. */
export interface CircleLike {
  x: number;
  y: number;
  radius?: number;
  radiusX?: number;
  radiusY?: number;
}

/** An arc segment description. */
export interface ArcLike {
  x: number;
  y: number;
  rx: number;
  ry: number;
  xAxisRotation?: number;
  largeArc?: boolean;
  sweep?: boolean;
}

/* -------------------------------------------------------------------------- */
/* SVGPath                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Fluent builder for an SVG `d` attribute.
 *
 * Every command has an absolute and a relative variant; the relative variants are
 * suffixed with `By` (`moveBy`, `lineBy`, `curveBy`, ...) so the two are never
 * confused.
 */
export class SVGPath {
  /** Recorded command segments, each already serialised. */
  private readonly segments: string[] = [];

  /** Decimal places kept when serialising numbers. */
  private precision: number;

  /**
   * Creates an empty path.
   *
   * @param precision Decimal places kept when formatting numbers. Defaults to
   *   `DECIMAL_PLACES`-style rounding via {@link DEFAULT_PRECISION}.
   */
  constructor(precision: number = DEFAULT_PRECISION) {
    this.precision = precision;
  }

  /* ------------------------------------------------------------------ factories */

  /** A path starting at `(x, y)` and closed back to it. */
  public static fromPoints(points: readonly PathPointLike[], close: boolean = true, precision?: number): SVGPath {
    return new SVGPath(precision).addPoints(points, close);
  }

  /** A `polyline`-equivalent open path. */
  public static fromPolyline(points: readonly PathPointLike[], precision?: number): SVGPath {
    return new SVGPath(precision).addPoints(points, false);
  }

  /** The four-corner path of a rectangle. */
  public static fromRect(rect: RectLike, precision?: number): SVGPath {
    const path = new SVGPath(precision);
    path.moveTo(rect.x, rect.y);
    path.lineTo(rect.x + rect.width, rect.y);
    path.lineTo(rect.x + rect.width, rect.y + rect.height);
    path.lineTo(rect.x, rect.y + rect.height);
    return path.close();
  }

  /** A rectangle with rounded corners. */
  public static fromRoundedRect(
    rect: RectLike,
    radius: number | readonly [number, number, number, number],
    precision?: number,
  ): SVGPath {
    const path = new SVGPath(precision);
    const maxRadius = Math.min(Math.abs(rect.width), Math.abs(rect.height)) / 2;
    const corners = typeof radius === 'number' ? [radius, radius, radius, radius] : radius;
    const [tl, tr, br, bl] = corners.map((value) => Math.max(0, Math.min(maxRadius, value)));

    const x = rect.x;
    const y = rect.y;
    const w = rect.width;
    const h = rect.height;

    path.moveTo(x + tl, y);
    path.lineTo(x + w - tr, y);
    if (tr > 0) path.arcToLocal(tr, tr, 0, false, true, x + w, y + tr);
    path.lineTo(x + w, y + h - br);
    if (br > 0) path.arcToLocal(br, br, 0, false, true, x + w - br, y + h);
    path.lineTo(x + bl, y + h);
    if (bl > 0) path.arcToLocal(bl, bl, 0, false, true, x, y + h - bl);
    path.lineTo(x, y + tl);
    if (tl > 0) path.arcToLocal(tl, tl, 0, false, true, x + tl, y);
    return path.close();
  }

  /** A circular arc rendered as an elliptical-arc command. */
  public static fromArc(
    cx: number,
    cy: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise: boolean = false,
    precision?: number,
  ): SVGPath {
    return new SVGPath(precision).addArc(cx, cy, radius, startAngle, endAngle, counterclockwise);
  }

  /** A parametric curve sampled into line segments. */
  public static fromCurve(
    curve: CurveLike,
    divisions: number = DEFAULT_CURVE_DIVISIONS,
    precision?: number,
  ): SVGPath {
    return new SVGPath(precision).addCurve(curve, divisions);
  }

  /** A closed polygon through the supplied points. */
  public static fromPolygon(points: readonly PathPointLike[], precision?: number): SVGPath {
    return new SVGPath(precision).addPoints(points, true);
  }

  /* -------------------------------------------------------------------- commands */

  /**
   * `M x y` — absolute move.
   *
   * @param x Destination x.
   * @param y Destination y.
   * @returns This builder, for chaining.
   */
  public moveTo(x: number, y: number): this {
    this.segments.push(`M ${this.n(x)} ${this.n(y)}`);
    return this;
  }

  /**
   * `m dx dy` — relative move.
   *
   * @param dx Horizontal delta.
   * @param dy Vertical delta.
   * @returns This builder, for chaining.
   */
  public moveBy(dx: number, dy: number): this {
    this.segments.push(`m ${this.n(dx)} ${this.n(dy)}`);
    return this;
  }

  /**
   * `L x y` — absolute line.
   *
   * @param x Destination x.
   * @param y Destination y.
   * @returns This builder, for chaining.
   */
  public lineTo(x: number, y: number): this {
    this.segments.push(`L ${this.n(x)} ${this.n(y)}`);
    return this;
  }

  /**
   * `l dx dy` — relative line.
   *
   * @param dx Horizontal delta.
   * @param dy Vertical delta.
   * @returns This builder, for chaining.
   */
  public lineBy(dx: number, dy: number): this {
    this.segments.push(`l ${this.n(dx)} ${this.n(dy)}`);
    return this;
  }

  /**
   * `H x` — absolute horizontal line.
   *
   * @param x Destination x.
   * @returns This builder, for chaining.
   */
  public horizontalTo(x: number): this {
    this.segments.push(`H ${this.n(x)}`);
    return this;
  }

  /**
   * `h dx` — relative horizontal line.
   *
   * @param dx Horizontal delta.
   * @returns This builder, for chaining.
   */
  public horizontalBy(dx: number): this {
    this.segments.push(`h ${this.n(dx)}`);
    return this;
  }

  /**
   * `V y` — absolute vertical line.
   *
   * @param y Destination y.
   * @returns This builder, for chaining.
   */
  public verticalTo(y: number): this {
    this.segments.push(`V ${this.n(y)}`);
    return this;
  }

  /**
   * `v dy` — relative vertical line.
   *
   * @param dy Vertical delta.
   * @returns This builder, for chaining.
   */
  public verticalBy(dy: number): this {
    this.segments.push(`v ${this.n(dy)}`);
    return this;
  }

  /**
   * `C x1 y1 x2 y2 x y` — absolute cubic Bézier.
   *
   * @param x1 First control point x.
   * @param y1 First control point y.
   * @param x2 Second control point x.
   * @param y2 Second control point y.
   * @param x End point x.
   * @param y End point y.
   * @returns This builder, for chaining.
   */
  public curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
    this.segments.push(
      `C ${this.n(x1)} ${this.n(y1)} ${this.n(x2)} ${this.n(y2)} ${this.n(x)} ${this.n(y)}`,
    );
    return this;
  }

  /**
   * `c dx1 dy1 dx2 dy2 dx dy` — relative cubic Bézier.
   *
   * @param dx1 First control point delta x.
   * @param dy1 First control point delta y.
   * @param dx2 Second control point delta x.
   * @param dy2 Second control point delta y.
   * @param dx End point delta x.
   * @param dy End point delta y.
   * @returns This builder, for chaining.
   */
  public curveBy(dx1: number, dy1: number, dx2: number, dy2: number, dx: number, dy: number): this {
    this.segments.push(
      `c ${this.n(dx1)} ${this.n(dy1)} ${this.n(dx2)} ${this.n(dy2)} ${this.n(dx)} ${this.n(dy)}`,
    );
    return this;
  }

  /**
   * `S x2 y2 x y` — absolute smooth cubic Bézier.
   *
   * @param x2 Second control point x.
   * @param y2 Second control point y.
   * @param x End point x.
   * @param y End point y.
   * @returns This builder, for chaining.
   */
  public smoothCurveTo(x2: number, y2: number, x: number, y: number): this {
    this.segments.push(`S ${this.n(x2)} ${this.n(y2)} ${this.n(x)} ${this.n(y)}`);
    return this;
  }

  /**
   * `s dx2 dy2 dx dy` — relative smooth cubic Bézier.
   *
   * @param dx2 Second control point delta x.
   * @param dy2 Second control point delta y.
   * @param dx End point delta x.
   * @param dy End point delta y.
   * @returns This builder, for chaining.
   */
  public smoothCurveBy(dx2: number, dy2: number, dx: number, dy: number): this {
    this.segments.push(`s ${this.n(dx2)} ${this.n(dy2)} ${this.n(dx)} ${this.n(dy)}`);
    return this;
  }

  /**
   * `Q x1 y1 x y` — absolute quadratic Bézier.
   *
   * @param x1 Control point x.
   * @param y1 Control point y.
   * @param x End point x.
   * @param y End point y.
   * @returns This builder, for chaining.
   */
  public quadraticTo(x1: number, y1: number, x: number, y: number): this {
    this.segments.push(`Q ${this.n(x1)} ${this.n(y1)} ${this.n(x)} ${this.n(y)}`);
    return this;
  }

  /**
   * `q dx1 dy1 dx dy` — relative quadratic Bézier.
   *
   * @param dx1 Control point delta x.
   * @param dy1 Control point delta y.
   * @param dx End point delta x.
   * @param dy End point delta y.
   * @returns This builder, for chaining.
   */
  public quadraticBy(dx1: number, dy1: number, dx: number, dy: number): this {
    this.segments.push(`q ${this.n(dx1)} ${this.n(dy1)} ${this.n(dx)} ${this.n(dy)}`);
    return this;
  }

  /**
   * `T x y` — absolute smooth quadratic Bézier.
   *
   * @param x End point x.
   * @param y End point y.
   * @returns This builder, for chaining.
   */
  public smoothQuadraticTo(x: number, y: number): this {
    this.segments.push(`T ${this.n(x)} ${this.n(y)}`);
    return this;
  }

  /**
   * `t dx dy` — relative smooth quadratic Bézier.
   *
   * @param dx End point delta x.
   * @param dy End point delta y.
   * @returns This builder, for chaining.
   */
  public smoothQuadraticBy(dx: number, dy: number): this {
    this.segments.push(`t ${this.n(dx)} ${this.n(dy)}`);
    return this;
  }

  /**
   * `A rx ry rotation large-arc sweep x y` — absolute elliptical arc.
   *
   * @param rx X radius.
   * @param ry Y radius.
   * @param xAxisRotation Rotation of the ellipse's x axis, in degrees.
   * @param largeArc Take the large-arc branch.
   * @param sweep Sweep in the positive-angle direction.
   * @param x End point x.
   * @param y End point y.
   * @returns This builder, for chaining.
   */
  public arc(
    rx: number,
    ry: number,
    xAxisRotation: number,
    largeArc: boolean,
    sweep: boolean,
    x: number,
    y: number,
  ): this {
    this.segments.push(
      `A ${this.n(rx)} ${this.n(ry)} ${this.n(xAxisRotation)} ${largeArc ? 1 : 0} ${sweep ? 1 : 0} ` +
        `${this.n(x)} ${this.n(y)}`,
    );
    return this;
  }

  /**
   * `a rx ry rotation large-arc sweep dx dy` — relative elliptical arc.
   *
   * @param rx X radius.
   * @param ry Y radius.
   * @param xAxisRotation Rotation of the ellipse's x axis, in degrees.
   * @param largeArc Take the large-arc branch.
   * @param sweep Sweep in the positive-angle direction.
   * @param dx End point delta x.
   * @param dy End point delta y.
   * @returns This builder, for chaining.
   */
  public arcBy(
    rx: number,
    ry: number,
    xAxisRotation: number,
    largeArc: boolean,
    sweep: boolean,
    dx: number,
    dy: number,
  ): this {
    this.segments.push(
      `a ${this.n(rx)} ${this.n(ry)} ${this.n(xAxisRotation)} ${largeArc ? 1 : 0} ${sweep ? 1 : 0} ` +
        `${this.n(dx)} ${this.n(dy)}`,
    );
    return this;
  }

  /**
   * `Z` — closes the current sub-path.
   *
   * @returns This builder, for chaining.
   */
  public close(): this {
    this.segments.push('Z');
    return this;
  }

  /* ------------------------------------------------------------------- helpers */

  /**
   * Appends a pre-formatted command string.
   *
   * @param segment Raw `d` fragment, without a leading separator.
   * @returns This builder, for chaining.
   */
  public addSegment(segment: string): this {
    const trimmed = segment.trim();
    if (trimmed.length > 0) this.segments.push(trimmed);
    return this;
  }

  /**
   * Appends a sequence of points as moves/lines.
   *
   * @param points Points to append.
   * @param close Close the resulting sub-path.
   * @returns This builder, for chaining.
   */
  public addPoints(points: readonly PathPointLike[], close: boolean = true): this {
    if (points.length === 0) return this;
    const first = readPoint(points[0]);
    if (first === null) return this;

    this.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i++) {
      const point = readPoint(points[i]);
      if (point !== null) this.lineTo(point.x, point.y);
    }
    return close ? this.close() : this;
  }

  /**
   * Appends a circular arc.
   *
   * The arc is emitted as a single `A` command; when
   * `startAngle === endAngle` nothing is emitted.
   *
   * @param cx Centre x.
   * @param cy Centre y.
   * @param radius Radius.
   * @param startAngle Start angle in radians.
   * @param endAngle End angle in radians.
   * @param counterclockwise Sweep anticlockwise.
   * @returns This builder, for chaining.
   */
  public addArc(
    cx: number,
    cy: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise: boolean = false,
  ): this {
    const sweepAngle = endAngle - startAngle;
    if (sweepAngle === 0 || radius <= 0) return this;

    const startX = cx + radius * Math.cos(startAngle);
    const startY = cy + radius * Math.sin(startAngle);
    const endX = cx + radius * Math.cos(endAngle);
    const endY = cy + radius * Math.sin(endAngle);
    const largeArc = Math.abs(sweepAngle) > Math.PI;
    const sweep = counterclockwise ? sweepAngle < 0 : sweepAngle > 0;

    this.moveTo(startX, startY);
    this.arc(radius, radius, 0, largeArc, sweep, endX, endY);
    return this;
  }

  /**
   * Samples a parametric curve into line segments.
   *
   * @param curve Curve exposing `getPoint(t)`.
   * @param divisions Number of segments; clamped to at least `1`.
   * @returns This builder, for chaining.
   */
  public addCurve(curve: CurveLike, divisions: number = DEFAULT_CURVE_DIVISIONS): this {
    const count = Math.max(1, Math.floor(divisions));
    const first = curve.getPoint(0);
    this.moveTo(first.x, first.y);
    for (let i = 1; i <= count; i++) {
      const point = curve.getPoint(i / count);
      this.lineTo(point.x, point.y);
    }
    return this;
  }

  /**
   * Appends a rectangle as a closed sub-path.
   *
   * @param rect Rectangle to append.
   * @returns This builder, for chaining.
   */
  public addRect(rect: RectLike): this {
    this.moveTo(rect.x, rect.y);
    this.horizontalBy(rect.width);
    this.verticalBy(rect.height);
    this.horizontalBy(-rect.width);
    return this.close();
  }

  /**
   * Appends an ellipse as two elliptical arcs.
   *
   * @param circle Centre and radii.
   * @returns This builder, for chaining.
   */
  public addEllipse(circle: CircleLike): this {
    const rx = circle.radiusX ?? circle.radius ?? 0;
    const ry = circle.radiusY ?? circle.radius ?? rx;
    if (rx <= 0 || ry <= 0) return this;

    const { x, y } = circle;
    this.moveTo(x + rx, y);
    this.arc(rx, ry, 0, false, true, x - rx, y);
    this.arc(rx, ry, 0, false, true, x + rx, y);
    return this.close();
  }

  /* ------------------------------------------------------------------- output */

  /** @returns The serialised `d` attribute; an empty string when no commands exist. */
  public toString(): string {
    return this.segments.join(' ');
  }

  /** @returns The serialised `d` attribute. */
  public toAttribute(): string {
    return this.toString();
  }

  /** @returns The recorded command segments, in order. */
  public getCommands(): readonly string[] {
    return this.segments;
  }

  /** @returns The number of recorded commands. */
  public get length(): number {
    return this.segments.length;
  }

  /** @returns `true` when no command has been recorded. */
  public get isEmpty(): boolean {
    return this.segments.length === 0;
  }

  /** Removes every recorded command. */
  public reset(): this {
    this.segments.length = 0;
    return this;
  }

  /**
   * Changes the number of decimal places kept when serialising numbers.
   *
   * @param precision Decimal places.
   * @returns This builder, for chaining.
   */
  public setPrecision(precision: number): this {
    this.precision = Math.max(0, Math.floor(precision));
    return this;
  }

  /** @returns A copy of this builder, with the same commands. */
  public clone(): SVGPath {
    const copy = new SVGPath(this.precision);
    for (const segment of this.segments) copy.segments.push(segment);
    return copy;
  }

  /* -------------------------------------------------------------------- private */

  /** Appends a local arc, used by the rounded-rectangle factory. */
  private arcToLocal(
    rx: number,
    ry: number,
    rotation: number,
    largeArc: boolean,
    sweep: boolean,
    x: number,
    y: number,
  ): this {
    return this.arc(rx, ry, rotation, largeArc, sweep, x, y);
  }

  /** Formats a number, normalising `-0` to `0`. */
  private n(value: number): string {
    if (!Number.isFinite(value)) return '0';
    const rounded = roundTo(value, this.precision);
    return String(rounded === 0 ? 0 : rounded);
  }
}

/* -------------------------------------------------------------------------- */
/* Point readers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Reads a point from any of the accepted shapes.
 *
 * @param value Point-like value.
 * @returns A `{ x, y }` reading, or `null` when the value is not point-like.
 */
export function readPoint(value: PathPointLike | null | undefined): PathPoint | null {
  if (value == null) return null;

  if (Array.isArray(value)) {
    const [x, y] = value as readonly number[];
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    return { x, y };
  }

  const candidate = value as { x?: unknown; y?: unknown };
  if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number') return null;
  return { x: candidate.x, y: candidate.y };
}

/**
 * Builds a `d` attribute from a list of points.
 *
 * @param points Points to join.
 * @param close Close the path.
 * @param precision Decimal places.
 * @returns The `d` attribute string.
 */
export function pointsToPathData(
  points: readonly PathPointLike[],
  close: boolean = true,
  precision?: number,
): string {
  return SVGPath.fromPoints(points, close, precision).toString();
}

/**
 * Builds a `d` attribute for a rectangle.
 *
 * @param rect Rectangle to convert.
 * @param precision Decimal places.
 * @returns The `d` attribute string.
 */
export function rectToPathData(rect: RectLike, precision?: number): string {
  return SVGPath.fromRect(rect, precision).toString();
}

/**
 * Builds a `d` attribute for a circular arc.
 *
 * @param cx Centre x.
 * @param cy Centre y.
 * @param radius Radius.
 * @param startAngle Start angle in radians.
 * @param endAngle End angle in radians.
 * @param counterclockwise Sweep anticlockwise.
 * @param precision Decimal places.
 * @returns The `d` attribute string.
 */
export function arcToPathData(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  counterclockwise: boolean = false,
  precision?: number,
): string {
  return SVGPath.fromArc(cx, cy, radius, startAngle, endAngle, counterclockwise, precision).toString();
}

/**
 * Builds a `d` attribute for a parametric curve.
 *
 * @param curve Curve exposing `getPoint(t)`.
 * @param divisions Number of line segments.
 * @param precision Decimal places.
 * @returns The `d` attribute string.
 */
export function curveToPathData(
  curve: CurveLike,
  divisions: number = DEFAULT_CURVE_DIVISIONS,
  precision?: number,
): string {
  return SVGPath.fromCurve(curve, divisions, precision).toString();
}

/**
 * Builds a `d` attribute for an elliptical arc segment description.
 *
 * @param from Start point of the segment.
 * @param arc Arc parameters.
 * @param precision Decimal places.
 * @returns The `d` attribute string.
 */
export function arcSegmentToPathData(
  from: PathPointLike,
  arc: ArcLike,
  precision?: number,
): string {
  const start = readPoint(from);
  if (start === null) return '';
  return new SVGPath(precision)
    .moveTo(start.x, start.y)
    .arc(arc.rx, arc.ry, arc.xAxisRotation ?? 0, arc.largeArc ?? false, arc.sweep ?? true, arc.x, arc.y)
    .toString();
}
