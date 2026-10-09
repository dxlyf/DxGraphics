/**
 * `Path2DObject` - a free path built from an explicit segment list.
 *
 * Unlike `Shape2D`, which knows how to describe a primitive, this node stores the
 * path verbatim: what the importer read from an SVG, what a pen tool produced, or
 * what a spline was sampled into. Segments are copied into a flat record list so
 * a path survives round-tripping through `copy`/`toJSON` unchanged.
 *
 * @packageDocumentation
 */

import { Rect } from '../../math/Rect';
import { Vec2 } from '../../math/Vec2';
import { Node2D } from './Node2D';
import type { FillStyle2D, Node2DOptions, PathSegment2D, StrokeStyle2D } from './types';

/** Options accepted by the {@link Path2DObject} constructor. */
export interface Path2DObjectOptions extends Node2DOptions {
  /** Initial segments. */
  segments?: readonly PathSegment2D[];
  /** Fill description; `null` disables filling. */
  fill?: FillStyle2D | null;
  /** Stroke description; `null` disables stroking. */
  stroke?: StrokeStyle2D | null;
  /** Closes the path automatically when it is drawn. */
  closed?: boolean;
}

/** A polyline/polycurve described by an explicit segment list. */
export class Path2DObject extends Node2D {
  /** Allows consumers to detect a path without an `instanceof` check. */
  public readonly isPath2DObject: true = true;

  /** Class name used by serialisation and the backend's dispatch. */
  public override readonly type: string = 'Path2DObject';

  /** Segments, in draw order. */
  public segments: PathSegment2D[];

  /** Fill description, or `null`. */
  public fill: FillStyle2D | null;

  /** Stroke description, or `null`. */
  public stroke: StrokeStyle2D | null;

  /** Closes the path automatically when it is drawn. */
  public closed: boolean;

  /**
   * Cached stroke approximation, in local units.
   *
   * Populated by {@link Path2DObject.tessellate}; used by bounds computation and
   * by picking, which needs the exact outline rather than the bounding box.
   */
  public readonly polyline: Vec2[] = [];

  /** Creates a path node. */
  constructor(options: Path2DObjectOptions = {}) {
    super(options);
    this.segments = options.segments ? options.segments.map(cloneSegment) : [];
    this.fill = options.fill ?? null;
    this.stroke = options.stroke ?? { color: '#ffffff', width: 1 };
    this.closed = options.closed ?? false;
    this.tessellate();
    if (!this.bounds) this.bounds = this.computeSegmentBounds();
  }

  /** Replaces the segment list and refreshes the cached bounds. */
  public setSegments(segments: readonly PathSegment2D[]): this {
    this.segments = segments.map(cloneSegment);
    this.tessellate();
    const bounds = this.computeSegmentBounds();
    if (bounds) this.setBounds(bounds);
    return this;
  }

  /** Appends one segment. */
  public addSegment(segment: PathSegment2D): this {
    this.segments.push(cloneSegment(segment));
    this.tessellate();
    const bounds = this.computeSegmentBounds();
    if (bounds) this.setBounds(bounds);
    return this;
  }

  /** Removes every segment. */
  public clearSegments(): this {
    this.segments.length = 0;
    this.polyline.length = 0;
    this.setBounds(null);
    return this;
  }

  /**
   * Approximates the path as a polyline.
   *
   * Curves are flattened with a fixed subdivision count, which is enough for
   * bounds and picking; the backend still draws the exact curves.
   *
   * @param divisions Segments per curve; defaults to the cubic subdivision used
   *   by the rest of the library.
   */
  public tessellate(divisions = 12): Vec2[] {
    this.polyline.length = 0;
    let currentX = 0;
    let currentY = 0;
    let startX = 0;
    let startY = 0;

    for (const segment of this.segments) {
      switch (segment.type) {
        case 'move':
          currentX = segment.x;
          currentY = segment.y;
          startX = currentX;
          startY = currentY;
          this.polyline.push(new Vec2(currentX, currentY));
          break;
        case 'line':
          currentX = segment.x;
          currentY = segment.y;
          this.polyline.push(new Vec2(currentX, currentY));
          break;
        case 'quadratic': {
          const x0 = currentX;
          const y0 = currentY;
          for (let i = 1; i <= divisions; i++) {
            const t = i / divisions;
            const mt = 1 - t;
            const x = mt * mt * x0 + 2 * mt * t * segment.cx + t * t * segment.x;
            const y = mt * mt * y0 + 2 * mt * t * segment.cy + t * t * segment.y;
            this.polyline.push(new Vec2(x, y));
          }
          currentX = segment.x;
          currentY = segment.y;
          break;
        }
        case 'cubic': {
          const x0 = currentX;
          const y0 = currentY;
          for (let i = 1; i <= divisions; i++) {
            const t = i / divisions;
            const mt = 1 - t;
            const a = mt * mt * mt;
            const b = 3 * mt * mt * t;
            const c = 3 * mt * t * t;
            const d = t * t * t;
            this.polyline.push(
              new Vec2(
                a * x0 + b * segment.c1x + c * segment.c2x + d * segment.x,
                a * y0 + b * segment.c1y + c * segment.c2y + d * segment.y,
              ),
            );
          }
          currentX = segment.x;
          currentY = segment.y;
          break;
        }
        case 'arc': {
          const start = segment.startAngle ?? 0;
          const end = segment.endAngle ?? Math.PI * 2;
          for (let i = 0; i <= divisions; i++) {
            const angle = start + ((end - start) * i) / divisions;
            this.polyline.push(
              new Vec2(
                segment.x + Math.cos(angle) * segment.radius,
                segment.y + Math.sin(angle) * segment.radius,
              ),
            );
          }
          currentX = this.polyline[this.polyline.length - 1]?.x ?? currentX;
          currentY = this.polyline[this.polyline.length - 1]?.y ?? currentY;
          break;
        }
        default:
          currentX = startX;
          currentY = startY;
          break;
      }
    }

    return this.polyline;
  }

  /**
   * `true` when `point` (world space) lies inside the filled path.
   *
   * Uses the even-odd rule over the tessellated polyline, which is exact for the
   * flat parts of a path and within one tessellation step elsewhere.
   */
  public override containsPoint(point: Vec2, tolerance = 0, includeChildren = false): boolean {
    const local = this.worldToLocal(point);
    if (this.pathContainsLocal(local, tolerance)) return true;
    return super.containsPoint(point, tolerance, includeChildren);
  }

  /** `true` when `point` (local space) lies inside the tessellated path. */
  public pathContainsLocal(point: Vec2, tolerance = 0): boolean {
    const polyline = this.polyline;
    if (polyline.length < 3) return false;

    let inside = false;
    for (let i = 0, j = polyline.length - 1; i < polyline.length; j = i++) {
      const a = polyline[i];
      const b = polyline[j];
      if (pointOnSegment(point, a, b, tolerance)) return true;
      const intersects = a.y > point.y !== b.y > point.y;
      if (intersects) {
        const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
        if (point.x < x) inside = !inside;
      }
    }
    return inside;
  }

  /** Copies the path state of `source`. */
  public override copy(source: Node2D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof Path2DObject) {
      this.segments = source.segments.map(cloneSegment);
      this.fill = source.fill ? { ...source.fill } : null;
      this.stroke = source.stroke
        ? { ...source.stroke, dash: source.stroke.dash ? [...source.stroke.dash] : undefined }
        : null;
      this.closed = source.closed;
      this.tessellate();
    }
    return this;
  }

  /** Serialises the path alongside the node data. */
  public override toJSON(recursive = true): ReturnType<Node2D['toJSON']> {
    const json = super.toJSON(recursive);
    json.segments = this.segments as unknown as Record<string, unknown>[];
    json.closed = this.closed;
    return json;
  }

  /** Returns a new path with the same segments. */
  public override clone(recursive = true): Path2DObject {
    return this.createInstance().copy(this, recursive) as Path2DObject;
  }

  /** Creates an empty `Path2DObject`, used by `clone()`. */
  protected override createInstance(): Node2D {
    return new Path2DObject();
  }

  /** Local-space bounding box of the tessellated polyline, or `null`. */
  private computeSegmentBounds(): Rect | null {
    if (this.polyline.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of this.polyline) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
    const padding = this.stroke ? Math.max(0, (this.stroke.width ?? 1) * 0.5) : 0;
    return new Rect(minX - padding, minY - padding, maxX - minX + padding * 2, maxY - minY + padding * 2);
  }
}

/** Deep-copies one path segment. */
function cloneSegment(segment: PathSegment2D): PathSegment2D {
  return { ...segment };
}

/** `true` when `point` lies on the segment `a`-`b` within `tolerance`. */
function pointOnSegment(point: Vec2, a: Vec2, b: Vec2, tolerance: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return point.distanceTo(a) <= tolerance;
  const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  if (t < 0 || t > 1) return false;
  const closestX = a.x + dx * t;
  const closestY = a.y + dy * t;
  return Math.hypot(point.x - closestX, point.y - closestY) <= Math.max(tolerance, 1e-6);
}
