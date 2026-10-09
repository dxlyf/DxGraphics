/**
 * `Curve` — the base class for every parametric 2D (and 3D) curve.
 *
 * A curve is defined by a single abstract method, {@link Curve.getPoint}, which
 * maps a normalised parameter `t ∈ [0, 1]` onto a point. Everything else is
 * derived from it:
 *
 *  - **arc length** — {@link Curve.getLength} integrates the speed numerically
 *    into a cached table, which is what makes `getPointAt` (uniform in *length*)
 *    differ from `getPoint` (uniform in *parameter*);
 *  - **tangents** — analytic where a subclass overrides `getTangent`, otherwise a
 *    central finite difference;
 *  - **sampling** — {@link Curve.getPoints} (uniform in `t`) and
 *    {@link Curve.getSpacedPoints} (uniform in length);
 *  - **frames** — {@link Curve.computeFrenetFrames} returns an in-plane normal
 *    for 2D curves and a full tangent/normal/binormal frame for 3D ones.
 *
 * ## Arc-length cache
 *
 * The first call to {@link Curve.getLength} (or `getPointAt`, or
 * `getSpacedPoints`) samples the curve `arcLengthDivisions` times and stores the
 * cumulative distances. Every later call reuses the table. A subclass that
 * changes its control points **must** call {@link Curve.updateArcLengths}, which
 * marks the table stale and sets {@link Curve.needsUpdate}; forgetting to do so
 * is the single most common source of "the path did not move" bugs.
 *
 * ```ts
 * const curve = new LineCurve(new Vec2(0, 0), new Vec2(10, 0));
 * curve.getLength();            // 10
 * curve.getPointAt(0.5);        // (5, 0) — uniform in length
 * ```
 *
 * @packageDocumentation
 */

import { clamp } from '../../utils/MathUtils';
import { DEFAULT_CURVE_DIVISIONS } from '../../constants';
import { Vec2 } from '../../math/Vec2';
import { Vec3 } from '../../math/Vec3';
import { tessellateCurve } from './Tessellate';
import type { TessellatableCurve } from './Tessellate';
import type { CurveJSON, CurveType, FrenetFrames2D, FrenetFrames3D } from './types';

/* -------------------------------------------------------------------------- */
/* Structural point view                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The slice of `Vec2`/`Vec3` the base class needs.
 *
 * `Curve<T>` is generic over `Vec2 | Vec3`, and calling a method on that union
 * directly is not type-safe (the two signatures are incompatible). Reducing the
 * requirement to `x`, `y`, optional `z` and a permissive `set` lets the shared
 * implementations work for both without a single `any`.
 */
interface CurvePointLike {
  /** X component. */
  x: number;
  /** Y component. */
  y: number;
  /** Z component; absent on 2D points. */
  z?: number;
  /** Writes the components. A 2D point ignores the third argument. */
  set(x: number, y: number, z?: number): unknown;
}

/** Views a curve sample as {@link CurvePointLike}. */
function asPointLike(point: Vec2 | Vec3): CurvePointLike {
  return point as unknown as CurvePointLike;
}

/**
 * Coerces serialised point data into a `Vec2`.
 *
 * Accepts both `[x, y]` and `{ x, y }`, which are the two shapes the 2D curves
 * emit and the two shapes importers produce.
 *
 * @param value Serialised point.
 * @param target Optional point to write into.
 */
export function vec2FromJSON(value: unknown, target: Vec2 = new Vec2()): Vec2 {
  if (Array.isArray(value)) {
    return target.set(Number(value[0] ?? 0), Number(value[1] ?? 0));
  }
  if (value !== null && typeof value === 'object') {
    const point = value as { x?: number; y?: number };
    return target.set(point.x ?? 0, point.y ?? 0);
  }
  return target.set(0, 0);
}

/** Euclidean distance between two curve samples of either dimensionality. */
function pointDistance(a: CurvePointLike, b: CurvePointLike): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = (b.z ?? 0) - (a.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/* -------------------------------------------------------------------------- */
/* Curve                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * An abstract parametric curve over `Vec2` or `Vec3`.
 *
 * @typeParam T The point type the curve produces.
 */
export abstract class Curve<T extends Vec2 | Vec3> {
  /** Discriminator identifying the concrete subclass. */
  public abstract readonly type: CurveType;

  /**
   * Number of samples used to build the arc-length table.
   *
   * Higher values make {@link Curve.getPointAt} more accurate at the cost of one
   * `getPoint` call per division on the first length query.
   */
  public arcLengthDivisions: number;

  /**
   * Set by {@link Curve.updateArcLengths} and cleared by the owner once the
   * derived data has been rebuilt. Purely advisory; the curve never reads it
   * itself.
   */
  public needsUpdate: boolean;

  /** Cached cumulative arc lengths, one entry per division plus the origin. */
  private cacheArcLengths: number[];

  /** `true` while {@link Curve.cacheArcLengths} does not match the control points. */
  private cacheStale: boolean;

  /** Creates a curve with an empty arc-length cache. */
  protected constructor() {
    this.arcLengthDivisions = 200;
    this.needsUpdate = false;
    this.cacheArcLengths = [];
    this.cacheStale = true;
  }

  /* ------------------------------------------------------------- evaluation */

  /**
   * Evaluates the curve at a normalised parameter.
   *
   * Implementations must accept `t` outside `[0, 1]` where that is meaningful
   * (extrapolation) and must return `target` when one is supplied so callers can
   * avoid allocation.
   *
   * @param t Normalised parameter; `0` is the start, `1` the end.
   * @param target Optional point to write into.
   */
  public abstract getPoint(t: number, target?: T): T;

  /**
   * Evaluates the curve at a normalised **arc-length** parameter.
   *
   * `getPointAt(0.5)` is the point half way along the curve by distance, whereas
   * `getPoint(0.5)` is the point half way along in parameter space. The two
   * coincide only for a constant-speed curve.
   *
   * @param u Normalised arc-length parameter in `[0, 1]`.
   * @param target Optional point to write into.
   */
  public getPointAt(u: number, target?: T): T {
    return this.getPoint(this.getUtoTmapping(u), target);
  }

  /**
   * Returns the unit tangent at a normalised parameter.
   *
   * The base implementation uses a central finite difference with one-sided
   * fallbacks at the endpoints; subclasses with an analytic derivative override
   * it.
   *
   * @param t Normalised parameter.
   * @param target Optional point to write into.
   */
  public getTangent(t: number, target?: T): T {
    const delta = 1e-4;
    const lower = this.getPoint(Math.max(0, t - delta));
    const upper = this.getPoint(Math.min(1, t + delta));
    const a = asPointLike(lower);
    const b = asPointLike(upper);
    const out = target ?? this.getPoint(0);
    const point = asPointLike(out);

    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let dz = (b.z ?? 0) - (a.z ?? 0);
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length > 0) {
      dx /= length;
      dy /= length;
      dz /= length;
    } else {
      dx = 1;
      dy = 0;
      dz = 0;
    }
    point.set(dx, dy, dz);
    return out;
  }

  /**
   * Returns the unit tangent at a normalised arc-length parameter.
   *
   * @param u Normalised arc-length parameter in `[0, 1]`.
   * @param target Optional point to write into.
   */
  public getTangentAt(u: number, target?: T): T {
    return this.getTangent(this.getUtoTmapping(u), target);
  }

  /* ---------------------------------------------------------------- sampling */

  /**
   * Samples the curve uniformly in the parameter `t`.
   *
   * @param divisions Number of segments; defaults to `DEFAULT_CURVE_DIVISIONS`.
   * @returns `divisions + 1` points, inclusive of both ends.
   */
  public getPoints(divisions: number = DEFAULT_CURVE_DIVISIONS): T[] {
    const segments = Math.max(1, Math.floor(divisions));
    const points: T[] = new Array(segments + 1);
    for (let i = 0; i <= segments; i++) points[i] = this.getPoint(i / segments);
    return points;
  }

  /**
   * Samples the curve uniformly in **arc length**.
   *
   * @param divisions Number of segments; defaults to `DEFAULT_CURVE_DIVISIONS`.
   * @returns `divisions + 1` evenly spaced points, inclusive of both ends.
   */
  public getSpacedPoints(divisions: number = DEFAULT_CURVE_DIVISIONS): T[] {
    const segments = Math.max(1, Math.floor(divisions));
    const points: T[] = new Array(segments + 1);
    for (let i = 0; i <= segments; i++) points[i] = this.getPointAt(i / segments);
    return points;
  }

  /**
   * Adaptively samples the curve so the polyline stays within `tolerance` of it.
   *
   * Intended for 2D curves; a 3D curve is flattened onto the XY plane because the
   * tessellator works in 2D.
   *
   * @param tolerance Maximum chord deviation, in world units.
   */
  public getAdaptivePoints(tolerance: number = 0.25): T[] {
    const points = tessellateCurve(this as unknown as TessellatableCurve, { tolerance }).points;
    return points as unknown as T[];
  }

  /* ------------------------------------------------------------- arc length */

  /**
   * Total arc length of the curve.
   *
   * The first call builds the cache; later calls read its last entry.
   */
  public getLength(): number {
    const lengths = this.getLengths();
    return lengths.length > 0 ? lengths[lengths.length - 1] : 0;
  }

  /**
   * Cumulative arc lengths after each of `divisions` segments.
   *
   * @param divisions Sample count; defaults to {@link Curve.arcLengthDivisions}.
   * @returns An array of `divisions + 1` entries starting at `0` and ending at
   *   the total length.
   */
  public getLengths(divisions: number = this.arcLengthDivisions): number[] {
    const segments = Math.max(1, Math.floor(divisions));
    if (!this.cacheStale && this.cacheArcLengths.length === segments + 1) {
      return this.cacheArcLengths;
    }

    const lengths: number[] = [0];
    let previous = asPointLike(this.getPoint(0));
    let total = 0;

    for (let i = 1; i <= segments; i++) {
      const current = asPointLike(this.getPoint(i / segments));
      total += pointDistance(previous, current);
      lengths.push(total);
      previous = current;
    }

    if (segments === this.arcLengthDivisions) {
      this.cacheArcLengths = lengths;
      this.cacheStale = false;
    }
    return lengths;
  }

  /** Marks the arc-length cache stale; call it whenever the control points move. */
  public updateArcLengths(): void {
    this.needsUpdate = true;
    this.cacheStale = true;
  }

  /**
   * Maps a normalised arc-length parameter onto the curve parameter.
   *
   * Binary-searches the cached length table and linearly interpolates inside the
   * bracketing segment. Degenerate inputs (a curve of zero length, or a curve
   * with a single division) fall back to the identity mapping rather than
   * producing `NaN`.
   *
   * @param u Normalised arc-length parameter in `[0, 1]`.
   * @param distance Explicit distance to look up, instead of `u * totalLength`.
   * @returns The curve parameter `t` in `[0, 1]`.
   */
  public getUtoTmapping(u: number, distance?: number): number {
    const arcLengths = this.getLengths();
    const divisions = arcLengths.length - 1;

    if (divisions < 1) return u;

    const totalLength = arcLengths[divisions];
    if (totalLength <= 0) return clamp(u, 0, 1);

    const target = distance !== undefined ? distance : u * totalLength;
    if (target <= 0) return 0;
    if (target >= totalLength) return 1;

    let low = 0;
    let high = divisions;
    let index = 0;

    while (low <= high) {
      index = Math.floor(low + (high - low) / 2);
      const comparison = arcLengths[index] - target;
      if (comparison < 0) low = index + 1;
      else if (comparison > 0) high = index - 1;
      else {
        high = index;
        break;
      }
    }

    index = high;
    if (index < 0) return 0;
    if (index >= divisions) return 1;

    const lengthBefore = arcLengths[index];
    const lengthAfter = arcLengths[index + 1];
    const segmentLength = lengthAfter - lengthBefore;
    const fraction = segmentLength > 0 ? (target - lengthBefore) / segmentLength : 0;
    return (index + fraction) / divisions;
  }

  /* ------------------------------------------------------------------ frames */

  /**
   * Builds a moving frame along the curve.
   *
   * For `Curve<Vec2>` the frame is planar: `normals[i]` is `tangents[i]` rotated
   * +90°, and there is no binormal. For `Curve<Vec3>` the full
   * tangent/normal/binormal frame is produced by parallel transport (the
   * double-reflection algorithm), which avoids the twist a naive Frenet frame
   * suffers at inflection points. When `closed` is set the frame is post-rotated
   * so the first and last normals coincide, removing the seam.
   *
   * @param segments Number of samples.
   * @param closed `true` when the curve is a closed loop.
   */
  public computeFrenetFrames(
    segments: number,
    closed: boolean = false,
  ): T extends Vec2 ? FrenetFrames2D : FrenetFrames3D {
    const count = Math.max(1, Math.floor(segments));

    if (this.getPoint(0) instanceof Vec2) {
      const tangents: Vec2[] = [];
      const normals: Vec2[] = [];
      for (let i = 0; i <= count; i++) {
        const tangent = this.getTangentAt(i / count) as unknown as Vec2;
        tangents.push(tangent);
        normals.push(new Vec2(-tangent.y, tangent.x));
      }
      return { tangents, normals } as unknown as T extends Vec2 ? FrenetFrames2D : FrenetFrames3D;
    }

    const tangents: Vec3[] = [];
    for (let i = 0; i <= count; i++) {
      tangents.push(this.getTangentAt(i / count) as unknown as Vec3);
    }

    const normals: Vec3[] = [];
    const binormals: Vec3[] = [];
    const normal = new Vec3();
    const vec = new Vec3();

    const first = tangents[0];
    const tx = Math.abs(first.x);
    const ty = Math.abs(first.y);
    const tz = Math.abs(first.z);
    let minimum = Number.MAX_VALUE;
    if (tx <= minimum) {
      minimum = tx;
      normal.set(1, 0, 0);
    }
    if (ty <= minimum) {
      minimum = ty;
      normal.set(0, 1, 0);
    }
    if (tz <= minimum) {
      normal.set(0, 0, 1);
    }

    vec.crossVectors(first, normal).normalize();
    normals[0] = new Vec3().crossVectors(first, vec);
    binormals[0] = new Vec3().crossVectors(first, normals[0]);

    for (let i = 1; i <= count; i++) {
      normals[i] = normals[i - 1].clone();
      binormals[i] = binormals[i - 1].clone();

      vec.crossVectors(tangents[i - 1], tangents[i]);
      if (vec.length() > Number.EPSILON) {
        vec.normalize();
        const theta = Math.acos(clamp(tangents[i - 1].dot(tangents[i]), -1, 1));
        normals[i].applyAxisAngle(vec, theta);
        binormals[i].applyAxisAngle(vec, theta);
      }
    }

    if (closed) {
      let theta = Math.acos(clamp(normals[0].dot(normals[count]), -1, 1));
      theta /= count;
      if (tangents[0].dot(vec.crossVectors(normals[0], normals[count])) > 0) theta = -theta;
      for (let i = 1; i <= count; i++) {
        normals[i].applyAxisAngle(tangents[0], theta * i);
        binormals[i].applyAxisAngle(tangents[0], theta * i);
      }
    }

    return { tangents, normals, binormals } as unknown as T extends Vec2
      ? FrenetFrames2D
      : FrenetFrames3D;
  }

  /* ------------------------------------------------------------------ copies */

  /** Copies the arc-length resolution from `source` and invalidates the cache. */
  public copy(source: Curve<T>): this {
    this.arcLengthDivisions = source.arcLengthDivisions;
    this.needsUpdate = source.needsUpdate;
    this.updateArcLengths();
    return this;
  }

  /* ------------------------------------------------------------------ output */

  /** Serialises the shared curve metadata; subclasses extend the result. */
  public toJSON(): CurveJSON {
    return { type: this.type, arcLengthDivisions: this.arcLengthDivisions };
  }

  /** `"LineCurve(arcLengthDivisions=200)"`. */
  public toString(): string {
    return `${this.type}(arcLengthDivisions=${this.arcLengthDivisions})`;
  }
}
