/**
 * `Rect` — a mutable, axis-aligned 2D rectangle.
 *
 * The rectangle is stored as an origin plus a size (`x`, `y`, `width`,
 * `height`) rather than as a `min`/`max` pair, so the common cases — "place a
 * 40x20 button at (10, 10)" or "this sprite is 64px wide" — map directly onto
 * the fields. Negative widths and heights are legal and are resolved on
 * demand: the derived edges ({@link Rect.left}, {@link Rect.right},
 * {@link Rect.top}, {@link Rect.bottom}) are normalised, and
 * {@link Rect.normalize} rewrites the stored size so `width`/`height` become
 * non-negative.
 *
 * Every method that mutates returns `this` so calls compose; the read methods
 * that can allocate take an optional target:
 *
 * ```ts
 * const viewport = new Rect(0, 0, 800, 600);
 * const clip = viewport.clone().intersection(new Rect(100, 100, 200, 200));
 * viewport.expandToPoint(point).inflate(4, 4);
 * ```
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import type { Vec2Source } from '../types';
import { Vec2 } from './Vec2';

/** A plain rectangle object accepted by every `Rect` entry point. */
export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point accepted by the rectangle queries. */
export type RectPointLike = Vec2Source;

/** A 2D axis-aligned rectangle. */
export class Rect {
  /** X coordinate of the origin (the left edge once normalised). */
  public x: number;

  /** Y coordinate of the origin (the top edge once normalised). */
  public y: number;

  /** Size along X; may be negative until {@link Rect.normalize} runs. */
  public width: number;

  /** Size along Y; may be negative until {@link Rect.normalize} runs. */
  public height: number;

  /** Lazily created cache returned by {@link Rect.center}. */
  private readonly centerCache: Vec2;

  /** Creates a rectangle; defaults to the empty rectangle at the origin. */
  constructor(x: number = 0, y: number = 0, width: number = 0, height: number = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.centerCache = new Vec2(x + width / 2, y + height / 2);
  }

  /* ---------------------------------------------------------------- static */

  /** The empty rectangle `(0, 0, 0, 0)`. */
  public static empty(): Rect {
    return new Rect(0, 0, 0, 0);
  }

  /** Smallest rectangle containing both points (with a non-negative size). */
  public static fromPoints(a: Vec2Source, b: Vec2Source): Rect {
    return new Rect().setFromPoints(a, b);
  }

  /** Rectangle of `size`, centred on `center`. */
  public static fromCenterAndSize(center: Vec2Source, size: Vec2Source): Rect {
    const cx = componentOf(center, 0);
    const cy = componentOf(center, 1);
    const width = componentOf(size, 0);
    const height = componentOf(size, 1);
    return new Rect(cx - width / 2, cy - height / 2, width, height);
  }

  /** Reads `[x, y, width, height]` from an array-like source. */
  public static fromArray(source: ArrayLike<number>, offset: number = 0): Rect {
    return new Rect(
      source[offset] ?? 0,
      source[offset + 1] ?? 0,
      source[offset + 2] ?? 0,
      source[offset + 3] ?? 0,
    );
  }

  /* -------------------------------------------------------------- getters */

  /** Left edge (the smaller X extent; `x` for negative widths). */
  public get left(): number {
    return this.width >= 0 ? this.x : this.x + this.width;
  }

  /** Top edge (the smaller Y extent; `y` for negative heights). */
  public get top(): number {
    return this.height >= 0 ? this.y : this.y + this.height;
  }

  /** Right edge (`x + width`). */
  public get right(): number {
    return this.x + this.width;
  }

  /** Bottom edge (`y + height`). */
  public get bottom(): number {
    return this.y + this.height;
  }

  /** X coordinate of the centre. */
  public get centerX(): number {
    return this.x + this.width / 2;
  }

  /** Y coordinate of the centre. */
  public get centerY(): number {
    return this.y + this.height / 2;
  }

  /**
   * Centre of the rectangle.
   *
   * The returned `Vec2` is a cached, reused instance: copy it if it has to
   * outlive the next mutation of this rectangle.
   */
  public get center(): Vec2 {
    return this.centerCache.set(this.x + this.width / 2, this.y + this.height / 2);
  }

  /** Area of the rectangle; `0` when either extent is non-positive. */
  public get area(): number {
    return Math.max(0, this.width) * Math.max(0, this.height);
  }

  /** `true` when the rectangle covers no area (zero or negative extent). */
  public get isEmpty(): boolean {
    return this.width <= 0 || this.height <= 0;
  }
  /* -------------------------------------------------------------- setters */

  /** Sets origin and size. */
  public set(x: number, y: number, width: number = 0, height: number = 0): this {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    return this;
  }

  /** Builds the smallest rectangle containing both points. */
  public setFromPoints(a: Vec2Source, b: Vec2Source): this {
    const ax = componentOf(a, 0);
    const ay = componentOf(a, 1);
    const bx = componentOf(b, 0);
    const by = componentOf(b, 1);
    const minX = Math.min(ax, bx);
    const minY = Math.min(ay, by);
    return this.set(minX, minY, Math.abs(bx - ax), Math.abs(by - ay));
  }

  /** Copies another rectangle (or plain object) into this one. */
  public copy(source: RectLike): this {
    return this.set(source.x, source.y, source.width, source.height);
  }

  /** Returns a new rectangle with the same origin and size. */
  public clone(): Rect {
    return new Rect(this.x, this.y, this.width, this.height);
  }

  /** Writes `[x, y, width, height]` into `target` at `offset`. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    target[offset] = this.x;
    target[offset + 1] = this.y;
    target[offset + 2] = this.width;
    target[offset + 3] = this.height;
    return target;
  }

  /** JSON-friendly representation. */
  public toJSON(): { x: number; y: number; width: number; height: number } {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  /** `"[x, y, width, height]"` with each field rounded to `precision` digits. */
  public toString(precision: number = 4): string {
    return `[${this.x.toFixed(precision)}, ${this.y.toFixed(precision)}, ${this.width.toFixed(
      precision,
    )}, ${this.height.toFixed(precision)}]`;
  }

  /** Iterates over `(x, y, width, height)`. */
  public *[Symbol.iterator](): IterableIterator<number> {
    yield this.x;
    yield this.y;
    yield this.width;
    yield this.height;
  }

  /* -------------------------------------------------------------- queries */

  /**
   * `true` when `point` lies inside the rectangle.
   *
   * Touching an edge counts as inside, so a zero-sized rectangle still
   * contains the point it sits on and a scanline loop written as
   * `for (let x = rect.left; x <= rect.right; x++)` visits every covered pixel.
   */
  public contains(point: RectPointLike): boolean {
    const px = componentOf(point, 0);
    const py = componentOf(point, 1);
    return px >= this.left && px <= this.right && py >= this.top && py <= this.bottom;
  }

  /** `true` when `other` lies entirely inside this rectangle. */
  public containsRect(other: RectLike): boolean {
    return (
      other.x >= this.left &&
      other.y >= this.top &&
      other.x + other.width <= this.right &&
      other.y + other.height <= this.bottom
    );
  }

  /**
   * `true` when this rectangle and `other` share at least one point.
   *
   * Rectangles that merely touch along an edge or corner count as
   * intersecting, which is the behaviour selection and culling code expects.
   */
  public intersects(other: RectLike): boolean {
    return (
      other.x <= this.right &&
      other.x + other.width >= this.left &&
      other.y <= this.bottom &&
      other.y + other.height >= this.top
    );
  }

  /**
   * Overlap of this rectangle and `other`, or `null` when they do not
   * intersect.
   *
   * Writes into `target` when supplied; the result is always a new or reused
   * rectangle, never a view of either operand.
   */
  public intersection(other: RectLike, target?: Rect): Rect | null {
    const minX = Math.max(this.left, other.x);
    const minY = Math.max(this.top, other.y);
    const maxX = Math.min(this.right, other.x + other.width);
    const maxY = Math.min(this.bottom, other.y + other.height);
    if (maxX < minX || maxY < minY) return null;
    return (target ?? new Rect()).set(minX, minY, maxX - minX, maxY - minY);
  }

  /** Smallest rectangle containing both this rectangle and `other`. */
  public union(other: RectLike, target?: Rect): Rect {
    const minX = Math.min(this.left, other.x);
    const minY = Math.min(this.top, other.y);
    const maxX = Math.max(this.right, other.x + other.width);
    const maxY = Math.max(this.bottom, other.y + other.height);
    return (target ?? new Rect()).set(minX, minY, maxX - minX, maxY - minY);
  }

  /* ------------------------------------------------------------ mutators */

  /** Grows the rectangle so that it also contains `point`. */
  public expandToPoint(point: RectPointLike): this {
    const px = componentOf(point, 0);
    const py = componentOf(point, 1);
    const minX = Math.min(this.left, px);
    const minY = Math.min(this.top, py);
    const maxX = Math.max(this.right, px);
    const maxY = Math.max(this.bottom, py);
    return this.set(minX, minY, maxX - minX, maxY - minY);
  }

  /** Grows (or, for a negative `s`, shrinks) every edge by `s`. */
  public expandByScalar(s: number): this {
    return this.set(this.x - s, this.y - s, this.width + s * 2, this.height + s * 2);
  }

  /**
   * Grows every edge by `dx` horizontally and `dy` vertically.
   *
   * This is *not* a scale: the origin moves outwards so the centre stays put,
   * and a negative argument shrinks the rectangle along that axis.
   */
  public inflate(dx: number, dy: number = dx): this {
    return this.set(this.x - dx, this.y - dy, this.width + dx * 2, this.height + dy * 2);
  }

  /** Multiplies the size by `sx`/`sy`, keeping the origin fixed. */
  public scale(sx: number, sy: number = sx): this {
    return this.set(this.x, this.y, this.width * sx, this.height * sy);
  }

  /** Moves the origin by `(dx, dy)`, keeping the size. */
  public translate(dx: number, dy: number): this {
    this.x += dx;
    this.y += dy;
    return this;
  }

  /** Alias of {@link Rect.translate}. */
  public offset(dx: number, dy: number): this {
    return this.translate(dx, dy);
  }

  /**
   * Moves the whole rectangle so its top-left corner sits at `(x, y)`.
   *
   * Distinct from {@link Rect.set}, which also changes the size.
   */
  public setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  /** Rewrites the origin so `width` and `height` become non-negative. */
  public normalize(): this {
    if (this.width < 0) {
      this.x += this.width;
      this.width = -this.width;
    }
    if (this.height < 0) {
      this.y += this.height;
      this.height = -this.height;
    }
    return this;
  }

  /** Rounds every field to the nearest integer. */
  public round(): this {
    this.x = Math.round(this.x);
    this.y = Math.round(this.y);
    this.width = Math.round(this.width);
    this.height = Math.round(this.height);
    return this;
  }

  /** Rounds every field towards negative infinity. */
  public floor(): this {
    this.x = Math.floor(this.x);
    this.y = Math.floor(this.y);
    this.width = Math.floor(this.width);
    this.height = Math.floor(this.height);
    return this;
  }

  /** Rounds every field towards positive infinity. */
  public ceil(): this {
    this.x = Math.ceil(this.x);
    this.y = Math.ceil(this.y);
    this.width = Math.ceil(this.width);
    this.height = Math.ceil(this.height);
    return this;
  }

  /**
   * Clamps `point` into the rectangle and writes it into `target`.
   *
   * An empty rectangle collapses to its (normalised) top-left corner.
   */
  public clampPoint(point: RectPointLike, target: Vec2 = new Vec2()): Vec2 {
    const x = Math.min(Math.max(componentOf(point, 0), this.left), this.right);
    const y = Math.min(Math.max(componentOf(point, 1), this.top), this.bottom);
    return target.set(x, y);
  }

  /** Distance from `point` to the nearest point of the rectangle; `0` inside. */
  public distanceToPoint(point: RectPointLike): number {
    const x = componentOf(point, 0);
    const y = componentOf(point, 1);
    const dx = Math.max(this.left - x, 0, x - this.right);
    const dy = Math.max(this.top - y, 0, y - this.bottom);
    return Math.hypot(dx, dy);
  }

  /** `true` when every field equals `other` within `tolerance`. */
  public equals(other: RectLike, tolerance: number = EPSILON): boolean {
    return (
      Math.abs(this.x - other.x) <= tolerance &&
      Math.abs(this.y - other.y) <= tolerance &&
      Math.abs(this.width - other.width) <= tolerance &&
      Math.abs(this.height - other.height) <= tolerance
    );
  }
}

/** Reads component `index` (`0` = x, `1` = y) from any accepted point source. */
function componentOf(source: Vec2Source, index: number): number {
  if (typeof source === 'number') return source;
  if (Array.isArray(source)) return (source as readonly number[])[index] ?? 0;
  const like = source as { x: number; y: number };
  return index === 0 ? like.x : like.y;
}

/** Creates a `Rect`; defaults to the empty rectangle at the origin. */
export function rect(x: number = 0, y: number = 0, width: number = 0, height: number = 0): Rect {
  return new Rect(x, y, width, height);
}
