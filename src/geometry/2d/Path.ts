/**
 * `Path` — an ordered sequence of 2D curve segments.
 *
 * A path is the authoring surface of the 2D layer: it records {@link Path.moveTo}
 * / {@link Path.lineTo} / {@link Path.quadraticCurveTo} / {@link Path.bezierCurveTo}
 * / {@link Path.arc} / {@link Path.ellipse} commands as concrete `Curve<Vec2>`
 * objects and then answers geometric questions about the whole outline.
 *
 * ## `moveTo` and the zero-length marker
 *
 * `moveTo` pushes a **zero-length `LineCurve`** rather than remembering a
 * separate pen position. That single trick keeps the model uniform:
 *
 *  - the pen position is always `curves[last].getPoint(1)`;
 *  - a "move" is recognisable as a segment whose endpoints coincide, which is
 *    what {@link Path.subPaths} splits on;
 *  - `getLength` is unaffected, because a zero-length segment adds zero.
 *
 * ## Parameterisation
 *
 * {@link Path.getPoint} distributes `t ∈ [0, 1]` evenly over the segments, so a
 * path made of a long line and a short arc spends half its parameter range on
 * each. {@link Path.getPointAt} instead reparameterises by **arc length** using
 * the exact per-segment lengths from {@link Path.getCurveLengths}, which is what
 * animated dashes and evenly spaced glyphs need.
 *
 * @packageDocumentation
 */

import { DEFAULT_CURVE_DIVISIONS, EPSILON } from '../../constants';
import { Vec2 } from '../../math/Vec2';
import { clamp } from '../../utils/MathUtils';
import { BufferGeometry } from '../core/BufferGeometry';
import { Float32BufferAttribute } from '../core/BufferAttribute';
import { Curve, vec2FromJSON } from './Curve';
import { ArcCurve } from './ArcCurve';
import { CubicBezierCurve } from './CubicBezierCurve';
import { EllipseCurve } from './EllipseCurve';
import { LineCurve } from './LineCurve';
import { QuadraticBezierCurve } from './QuadraticBezierCurve';
import { SplineCurve } from './SplineCurve';
import type { CurveJSON, CurveType, PathJSON } from './types';

/* -------------------------------------------------------------------------- */
/* Serialisation helper                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Rebuilds a concrete 2D curve from its serialised form.
 *
 * This is the single place that knows about every curve class, which is what
 * lets `Path.copy`, `Path.clone` and `Path.fromJSON` stay short and what makes
 * extending the curve family a one-line change.
 *
 * @param json Serialised curve.
 * @throws Error when the discriminator is not a supported 2D curve type.
 */
export function curveFromJSON(json: CurveJSON): Curve<Vec2> {
  switch (json.type) {
    case 'LineCurve':
      return LineCurve.fromJSON(json);
    case 'QuadraticBezierCurve':
      return QuadraticBezierCurve.fromJSON(json);
    case 'CubicBezierCurve':
      return CubicBezierCurve.fromJSON(json);
    case 'ArcCurve':
      return ArcCurve.fromJSON(json);
    case 'EllipseCurve':
      return EllipseCurve.fromJSON(json);
    case 'SplineCurve':
      return SplineCurve.fromJSON(json);
    default:
      throw new Error(
        `curveFromJSON(): '${String(json.type)}' is not a supported 2D curve type`,
      );
  }
}

/** Deep-copies a 2D curve through its JSON form. */
function cloneCurve(curve: Curve<Vec2>): Curve<Vec2> {
  return curveFromJSON(curve.toJSON());
}

/* -------------------------------------------------------------------------- */
/* Path                                                                       */
/* -------------------------------------------------------------------------- */

/** An ordered list of 2D curve segments. */
export class Path extends Curve<Vec2> {
  /** Discriminator; `'Shape'` on the subclass. */
  public override readonly type: CurveType = 'Path';

  /** Structural marker. */
  public readonly isPath = true;

  /** The pen position: the end of the last segment. */
  public currentPoint: Vec2;

  /**
   * When `true`, the path is treated as closed for sampling and length even
   * without an explicit {@link Path.closePath}.
   */
  public autoClose: boolean;

  /** The ordered segments. */
  public curves: Curve<Vec2>[];

  /** Cumulative arc lengths, one entry per segment; `null` when stale. */
  private cacheLengths: number[] | null;

  /**
   * Creates a path, optionally from a point list.
   *
   * @param points When given, the path becomes `moveTo(points[0])` followed by a
   *   `lineTo` for every remaining point.
   */
  constructor(points?: Vec2[]) {
    super();
    this.currentPoint = new Vec2();
    this.autoClose = false;
    this.curves = [];
    this.cacheLengths = null;
    if (points && points.length > 0) this.setFromPoints(points);
  }

  /* ------------------------------------------------------------ bookkeeping */

  /** Marks the cached segment lengths and the arc-length table stale. */
  private invalidate(): void {
    this.cacheLengths = null;
    this.updateArcLengths();
  }

  /** Clears the cached segment lengths as well as the base arc-length table. */
  public override updateArcLengths(): void {
    this.cacheLengths = null;
    super.updateArcLengths();
  }

  /* ------------------------------------------------------------- primitives */

  /**
   * Starts a new sub-path at a point.
   *
   * Implemented as a zero-length line segment; see the module documentation.
   *
   * @param x X coordinate, or a point.
   * @param y Y coordinate; ignored when `x` is a point.
   */
  public moveTo(x: number | Vec2, y?: number): this {
    const px = typeof x === 'number' ? x : x.x;
    const py = typeof x === 'number' ? y ?? 0 : x.y;
    this.currentPoint.set(px, py);
    const origin = this.currentPoint.clone();
    this.curves.push(new LineCurve(origin, origin.clone()));
    this.invalidate();
    return this;
  }

  /**
   * Appends a straight segment from the pen position to a point.
   *
   * Consecutive `lineTo` calls produce **one segment each** — they are not
   * merged, because a caller that emits two collinear lines usually wants two
   * segments (for dashes, for attribute breaks, or for a later
   * {@link Polyline.simplify}-style reduction).
   *
   * @param x X coordinate, or a point.
   * @param y Y coordinate; ignored when `x` is a point.
   */
  public lineTo(x: number | Vec2, y?: number): this {
    const px = typeof x === 'number' ? x : x.x;
    const py = typeof x === 'number' ? y ?? 0 : x.y;
    this.curves.push(new LineCurve(this.currentPoint.clone(), new Vec2(px, py)));
    this.currentPoint.set(px, py);
    this.invalidate();
    return this;
  }

  /**
   * Appends a quadratic Bézier from the pen position.
   *
   * @param aCPx Control point x.
   * @param aCPy Control point y.
   * @param aX End point x.
   * @param aY End point y.
   */
  public quadraticCurveTo(aCPx: number, aCPy: number, aX: number, aY: number): this {
    this.curves.push(
      new QuadraticBezierCurve(
        this.currentPoint.clone(),
        new Vec2(aCPx, aCPy),
        new Vec2(aX, aY),
      ),
    );
    this.currentPoint.set(aX, aY);
    this.invalidate();
    return this;
  }

  /**
   * Appends a cubic Bézier from the pen position.
   *
   * @param aCP1x First control point x.
   * @param aCP1y First control point y.
   * @param aCP2x Second control point x.
   * @param aCP2y Second control point y.
   * @param aX End point x.
   * @param aY End point y.
   */
  public bezierCurveTo(
    aCP1x: number,
    aCP1y: number,
    aCP2x: number,
    aCP2y: number,
    aX: number,
    aY: number,
  ): this {
    this.curves.push(
      new CubicBezierCurve(
        this.currentPoint.clone(),
        new Vec2(aCP1x, aCP1y),
        new Vec2(aCP2x, aCP2y),
        new Vec2(aX, aY),
      ),
    );
    this.currentPoint.set(aX, aY);
    this.invalidate();
    return this;
  }

  /**
   * Appends a Catmull-Rom spline through `points`, starting at the pen position.
   *
   * @param points The points the spline must interpolate; the pen position is
   *   prepended as the first control point.
   */
  public splineThru(points: ReadonlyArray<Vec2>): this {
    if (points.length === 0) return this;
    const controlPoints: Vec2[] = [this.currentPoint.clone()];
    for (const point of points) controlPoints.push(point.clone());
    this.curves.push(new SplineCurve(controlPoints));
    const last = points[points.length - 1];
    this.currentPoint.copy(last);
    this.invalidate();
    return this;
  }

  /* ------------------------------------------------------------------ arcs */

  /**
   * Appends an elliptical arc, joining the pen position to the arc's start with
   * a straight line when they differ.
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
  public absellipse(
    aX: number,
    aY: number,
    xRadius: number,
    yRadius: number,
    aStartAngle: number,
    aEndAngle: number,
    aClockwise: boolean,
    aRotation: number,
  ): this {
    const curve = new EllipseCurve(
      aX,
      aY,
      xRadius,
      yRadius,
      aStartAngle,
      aEndAngle,
      aClockwise,
      aRotation,
    );

    if (this.curves.length > 0) {
      const start = curve.getPoint(0);
      if (!start.equals(this.currentPoint, EPSILON)) this.lineTo(start.x, start.y);
    }

    this.curves.push(curve);
    this.currentPoint.copy(curve.getPoint(1));
    this.invalidate();
    return this;
  }

  /**
   * Appends an elliptical arc; identical to {@link Path.absellipse} because the
   * path has no separate current transform that could make a "relative" variant
   * differ. Kept as an alias so Canvas-like call sites read naturally.
   */
  public ellipse(
    aX: number,
    aY: number,
    xRadius: number,
    yRadius: number,
    aStartAngle: number,
    aEndAngle: number,
    aClockwise: boolean,
    aRotation: number,
  ): this {
    return this.absellipse(aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise, aRotation);
  }

  /**
   * Appends a circular arc centred on `(aX, aY)`.
   *
   * @param aX Centre x.
   * @param aY Centre y.
   * @param aRadius Radius.
   * @param aStartAngle Sweep start, in radians.
   * @param aEndAngle Sweep end, in radians.
   * @param aClockwise Sweep direction.
   */
  public absarc(
    aX: number,
    aY: number,
    aRadius: number,
    aStartAngle: number,
    aEndAngle: number,
    aClockwise: boolean,
  ): this {
    return this.absellipse(aX, aY, aRadius, aRadius, aStartAngle, aEndAngle, aClockwise, 0);
  }

  /**
   * Appends a circular arc; identical to {@link Path.absarc} for the same reason
   * {@link Path.ellipse} matches {@link Path.absellipse}.
   */
  public arc(
    aX: number,
    aY: number,
    aRadius: number,
    aStartAngle: number,
    aEndAngle: number,
    aClockwise: boolean,
  ): this {
    return this.absarc(aX, aY, aRadius, aStartAngle, aEndAngle, aClockwise);
  }

  /**
   * Appends a circular arc that is tangent to both `pen -> (aX1, aY1)` and
   * `(aX1, aY1) -> (aX2, aY2)`.
   *
   * Collinear or zero-length inputs (and a non-positive radius) degrade to a
   * plain `lineTo(aX2, aY2)` rather than producing `NaN`, which is what CSS and
   * Canvas2D do.
   *
   * @param aX1 Corner x.
   * @param aY1 Corner y.
   * @param aX2 End tangent point x.
   * @param aY2 End tangent point y.
   * @param aRadius Fillet radius.
   */
  public arcTo(aX1: number, aY1: number, aX2: number, aY2: number, aRadius: number): this {
    const x0 = this.currentPoint.x;
    const y0 = this.currentPoint.y;

    if (aRadius <= 0) return this.lineTo(aX2, aY2);
    if ((x0 === aX1 && y0 === aY1) || (aX1 === aX2 && aY1 === aY2)) {
      return this.lineTo(aX1, aY1);
    }

    // Unit directions from the corner towards the two tangent points.
    const d1x = x0 - aX1;
    const d1y = y0 - aY1;
    const d2x = aX2 - aX1;
    const d2y = aY2 - aY1;
    const l1 = Math.hypot(d1x, d1y);
    const l2 = Math.hypot(d2x, d2y);
    if (l1 < EPSILON || l2 < EPSILON) return this.lineTo(aX2, aY2);

    const v1x = d1x / l1;
    const v1y = d1y / l1;
    const v2x = d2x / l2;
    const v2y = d2y / l2;

    const cosTheta = clamp(v1x * v2x + v1y * v2y, -1, 1);
    const theta = Math.acos(cosTheta);
    if (theta < EPSILON || Math.abs(Math.PI - theta) < EPSILON) {
      return this.lineTo(aX2, aY2);
    }

    const tangentDistance = aRadius / Math.tan(theta * 0.5);
    const t1x = aX1 + v1x * tangentDistance;
    const t1y = aY1 + v1y * tangentDistance;
    const t2x = aX1 + v2x * tangentDistance;
    const t2y = aY1 + v2y * tangentDistance;

    // Centre lies on the bisector at r / sin(θ/2) from the corner.
    const bisectorX = v1x + v2x;
    const bisectorY = v1y + v2y;
    const bisectorLength = Math.hypot(bisectorX, bisectorY);
    if (bisectorLength < EPSILON) return this.lineTo(aX2, aY2);
    const distance = aRadius / Math.sin(theta * 0.5);
    const centreX = aX1 + (bisectorX / bisectorLength) * distance;
    const centreY = aY1 + (bisectorY / bisectorLength) * distance;

    const startAngle = Math.atan2(t1y - centreY, t1x - centreX);
    const endAngle = Math.atan2(t2y - centreY, t2x - centreX);

    // The fillet is the MINOR arc, whose central angle is π - θ. Picking the
    // minor arc is what keeps the corner rounded rather than almost erased.
    let counterClockwise = endAngle - startAngle;
    while (counterClockwise < 0) counterClockwise += Math.PI * 2;
    const clockwise = counterClockwise > Math.PI;

    this.lineTo(t1x, t1y);
    return this.arc(centreX, centreY, aRadius, startAngle, endAngle, clockwise);
  }

  /* --------------------------------------------------------------- assembly */

  /**
   * Replaces the path with a polyline through `points`.
   *
   * @param points Outline points; the first becomes a `moveTo` and every other
   *   point a `lineTo`.
   */
  public setFromPoints(points: ReadonlyArray<Vec2>): this {
    this.curves = [];
    this.currentPoint.set(0, 0);
    this.invalidate();

    if (points.length > 0) this.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) this.lineTo(points[i].x, points[i].y);
    return this;
  }

  /**
   * Closes the path with a straight segment back to its first point.
   *
   * Calling it twice is a no-op: the second call finds the endpoints already
   * coincident and adds nothing. This is what makes
   * `arc(0, 0, r, 0, 2π, false)` followed by `closePath()` measure exactly the
   * circumference rather than the circumference plus a zero-length chord.
   */
  public closePath(): this {
    if (this.curves.length === 0) return this;
    const lastPoint = this.curves[this.curves.length - 1].getPoint(1);
    const firstPoint = this.curves[0].getPoint(0);
    if (!lastPoint.equals(firstPoint, EPSILON)) this.lineTo(firstPoint.x, firstPoint.y);
    return this;
  }

  /* ------------------------------------------------------------ evaluation */

  /** Number of curves including the implicit closing segment, when any. */
  private get segmentCount(): number {
    return this.curves.length + (this.hasImplicitClosure() ? 1 : 0);
  }

  /** `true` when `autoClose` requests a closing segment that is not yet present. */
  private hasImplicitClosure(): boolean {
    if (!this.autoClose || this.curves.length === 0) return false;
    const firstPoint = this.curves[0].getPoint(0);
    const lastPoint = this.curves[this.curves.length - 1].getPoint(1);
    return !firstPoint.equals(lastPoint, EPSILON);
  }

  /**
   * Returns segment `index`, materialising the implicit closing line when asked
   * for the one past the end.
   */
  private curveAt(index: number): Curve<Vec2> {
    if (index < this.curves.length) return this.curves[index];
    const lastPoint = this.curves[this.curves.length - 1].getPoint(1).clone();
    const firstPoint = this.curves[0].getPoint(0).clone();
    return new LineCurve(lastPoint, firstPoint);
  }

  /**
   * Evaluates the path at a normalised parameter, distributing `t` evenly over
   * the segments.
   *
   * Use {@link Path.getPointAt} when you need equal *distances* instead of equal
   * segment shares.
   */
  public override getPoint(t: number, target: Vec2 = new Vec2()): Vec2 {
    const count = this.segmentCount;
    if (count === 0) return target.set(0, 0);
    if (t >= 1) return this.curveAt(count - 1).getPoint(1, target);

    const clamped = t <= 0 ? 0 : t;
    const scaled = clamped * count;
    let index = Math.floor(scaled);
    let weight = scaled - index;
    if (index >= count) {
      index = count - 1;
      weight = 1;
    }
    return this.curveAt(index).getPoint(weight, target);
  }

  /**
   * Evaluates the path at a normalised **arc-length** parameter.
   *
   * Uses the exact per-segment lengths, so the result is uniform in distance
   * even when the segments have wildly different sizes.
   */
  public override getPointAt(u: number, target: Vec2 = new Vec2()): Vec2 {
    const lengths = this.getCurveLengths();
    const count = lengths.length;
    if (count === 0) return target.set(0, 0);

    const total = lengths[count - 1];
    if (total <= 0) return this.getPoint(0, target);

    const distance = clamp(u, 0, 1) * total;

    let low = 0;
    let high = count - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (lengths[mid] < distance) low = mid + 1;
      else high = mid;
    }

    const start = low > 0 ? lengths[low - 1] : 0;
    const segmentLength = lengths[low] - start;
    const local = segmentLength > 0 ? (distance - start) / segmentLength : 0;
    return this.curveAt(low).getPoint(local, target);
  }

  /**
   * Samples the path, giving each curve a resolution suited to its kind:
   * ellipses and arcs get twice `divisions`, lines one segment, splines
   * `divisions` per control point, everything else `divisions`.
   *
   * Consecutive duplicate samples are dropped, and an `autoClose` path repeats
   * its first point at the end.
   *
   * @param divisions Resolution hint.
   */
  public override getPoints(divisions: number = DEFAULT_CURVE_DIVISIONS): Vec2[] {
    const points: Vec2[] = [];
    let last: Vec2 | null = null;

    for (const curve of this.curves) {
      const resolution =
        curve.type === 'EllipseCurve' || curve.type === 'ArcCurve'
          ? divisions * 2
          : curve.type === 'LineCurve'
            ? 1
            : curve.type === 'SplineCurve'
              ? divisions * (curve as SplineCurve).points.length
              : divisions;

      for (const point of curve.getPoints(resolution)) {
        if (last && last.equals(point, EPSILON)) continue;
        points.push(point);
        last = point;
      }
    }

    if (this.autoClose && points.length > 1 && !points[points.length - 1].equals(points[0], EPSILON)) {
      points.push(points[0].clone());
    }
    return points;
  }

  /* ------------------------------------------------------------- arc length */

  /**
   * Cumulative path length after each segment.
   *
   * Cached; call {@link Path.updateArcLengths} after mutating a segment in place.
   *
   * @returns An array of `segmentCount` entries; empty for an empty path.
   */
  public getCurveLengths(): number[] {
    if (this.cacheLengths) return this.cacheLengths;

    const lengths: number[] = [];
    let total = 0;
    const count = this.segmentCount;
    for (let i = 0; i < count; i++) {
      total += this.curveAt(i).getLength();
      lengths.push(total);
    }
    this.cacheLengths = lengths;
    return lengths;
  }

  /** Total path length, summed from the exact per-segment lengths. */
  public override getLength(): number {
    const lengths = this.getCurveLengths();
    return lengths.length > 0 ? lengths[lengths.length - 1] : 0;
  }

  /** Axis-aligned bounds of a dense sampling of the path. */
  public getBoundingBox(): { min: Vec2; max: Vec2 } {
    const min = new Vec2(Infinity, Infinity);
    const max = new Vec2(-Infinity, -Infinity);
    for (const point of this.getPoints(DEFAULT_CURVE_DIVISIONS)) {
      if (point.x < min.x) min.x = point.x;
      if (point.y < min.y) min.y = point.y;
      if (point.x > max.x) max.x = point.x;
      if (point.y > max.y) max.y = point.y;
    }
    if (min.x > max.x) {
      min.set(0, 0);
      max.set(0, 0);
    }
    return { min, max };
  }

  /* --------------------------------------------------------------- subpaths */

  /**
   * Splits the path into independent sub-paths at every `moveTo`.
   *
   * The marker for a move is a zero-length `LineCurve`, so a `lineTo` that
   * happens to be zero-length also starts a new sub-path. That is the documented
   * consequence of representing a move as a degenerate segment.
   */
  public get subPaths(): Path[] {
    const result: Path[] = [];
    let current = new Path();

    for (const curve of this.curves) {
      const isMove = curve.type === 'LineCurve' && isZeroLengthLine(curve);
      if (isMove && current.curves.length > 0) {
        result.push(current);
        current = new Path();
      }
      current.curves.push(curve);
    }

    if (current.curves.length > 0) {
      const last = current.curves[current.curves.length - 1];
      current.currentPoint.copy(last.getPoint(1));
      result.push(current);
    }
    return result;
  }

  /* -------------------------------------------------------------- geometry */

  /**
   * Wraps an explicit point list in a `BufferGeometry` with a `position`
   * attribute (`itemSize` 3, `z = 0`).
   *
   * The result is a **line list**, not a filled surface: pass it to a line
   * renderer, or feed it to `Shape.triangulate` for a filled shape.
   *
   * @param points Points to convert.
   */
  public createGeometry(points: ReadonlyArray<Vec2>): BufferGeometry {
    const geometry = new BufferGeometry();
    const positions = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      positions[i * 3] = points[i].x;
      positions[i * 3 + 1] = points[i].y;
      positions[i * 3 + 2] = 0;
    }
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute(positions, 3, false, 'static', 'position'),
    );
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  /**
   * Builds a line-list geometry from {@link Path.getPoints}.
   *
   * @param divisions Resolution hint passed to `getPoints`.
   */
  public createPointsGeometry(divisions: number): BufferGeometry {
    return this.createGeometry(this.getPoints(divisions));
  }

  /**
   * Builds a line-list geometry from {@link Path.getSpacedPoints}.
   *
   * @param divisions Number of evenly spaced samples.
   */
  public createSpacedPointsGeometry(divisions: number): BufferGeometry {
    return this.createGeometry(this.getSpacedPoints(divisions));
  }

  /**
   * Builds a line-list geometry from the path.
   *
   * @param divisions Resolution hint.
   */
  public toBufferGeometry(divisions: number = DEFAULT_CURVE_DIVISIONS): BufferGeometry {
    return this.createPointsGeometry(divisions);
  }

  /* ----------------------------------------------------------------- copies */

  /** Deep-copies every segment and the pen position from `source`. */
  public override copy(source: Path): this {
    super.copy(source);
    this.curves = source.curves.map((curve) => cloneCurve(curve));
    this.currentPoint.copy(source.currentPoint);
    this.autoClose = source.autoClose;
    this.invalidate();
    return this;
  }

  /** Returns an independent copy of this path. */
  public clone(): Path {
    return new Path().copy(this);
  }

  /* ---------------------------------------------------------------- output */

  /** Serialises the path; round-trips through {@link Path.fromJSON}. */
  public override toJSON(): PathJSON {
    return {
      type: this.type === 'Shape' ? 'Shape' : 'Path',
      arcLengthDivisions: this.arcLengthDivisions,
      curves: this.curves.map((curve) => curve.toJSON()),
      currentPoint: [this.currentPoint.x, this.currentPoint.y],
      autoClose: this.autoClose,
    };
  }

  /**
   * Rebuilds a path from {@link Path.toJSON} output.
   *
   * @throws Error when a segment carries an unknown discriminator.
   */
  public static fromJSON(json: PathJSON): Path {
    const path = new Path();
    path.curves = (json.curves ?? []).map((curveJSON) => curveFromJSON(curveJSON));
    const current = json.currentPoint;
    path.currentPoint.set(Number(current?.[0] ?? 0), Number(current?.[1] ?? 0));
    path.autoClose = json.autoClose === true;
    if (typeof json.arcLengthDivisions === 'number') {
      path.arcLengthDivisions = json.arcLengthDivisions;
    }
    path.updateArcLengths();
    return path;
  }
}

/** `true` when `curve` is a line segment whose endpoints coincide. */
function isZeroLengthLine(curve: Curve<Vec2>): boolean {
  if (curve.type !== 'LineCurve') return false;
  const line = curve as LineCurve;
  return line.v1.x === line.v2.x && line.v1.y === line.v2.y;
}
