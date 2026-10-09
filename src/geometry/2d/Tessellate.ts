/**
 * Adaptive curve tessellation.
 *
 * Uniform sampling wastes segments on straight stretches and starves curved
 * ones. The flatness test used here fixes that: a segment is accepted only when
 * the curve's *second* derivative is small enough that the chord is within
 * `tolerance` of the curve, measured as the perpendicular distance of the
 * midpoint sample from the chord:
 *
 * ```text
 *        p1
 *        /·\
 *       / | \        error = perpendicular distance of p1 from the chord p0->p2
 *      /  |  \               = |(p1 - p0) x (p2 - p0)| / |p2 - p0|
 *    p0···+···p2
 * ```
 *
 * That is exactly the sagitta of the arc through the three samples, and for a
 * twice-differentiable curve it is proportional to the second derivative times
 * the square of the interval — so halving a rejected interval cuts the error by
 * roughly four, which makes the recursion converge quickly.
 *
 * This module is deliberately decoupled from `Curve`: it only needs something
 * that can be sampled at a normalised parameter, declared here as
 * {@link TessellatableCurve}. `Curve.ts` therefore imports this file without
 * creating an import cycle.
 *
 * @packageDocumentation
 */

import { Vec2 } from '../../math/Vec2';
import type { TessellationOptions, TessellatedPath } from './types';
import { DEFAULT_CURVE_DIVISIONS } from '../../constants';

/* -------------------------------------------------------------------------- */
/* Structural inputs                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Anything that can be sampled at a normalised parameter.
 *
 * `Curve<Vec2>` satisfies this structurally, so no import is required.
 */
export interface TessellatableCurve {
  /**
   * Evaluates the curve at `t` in `[0, 1]`.
   *
   * @param t Normalised parameter.
   * @param target Optional point to write into, so hot loops stay allocation-free.
   */
  getPoint(t: number, target?: Vec2): Vec2;
}

/** A multi-segment path: the concatenation of its {@link curves}. */
export interface TessellatablePath {
  /** The ordered segments. */
  readonly curves: readonly TessellatableCurve[];
  /** Evaluates the whole path at a normalised parameter. */
  getPoint(t: number, target?: Vec2): Vec2;
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

/** Maximum allowed chord deviation, in world units. */
const DEFAULT_TOLERANCE = 0.25;

/** Hard upper bound on emitted segments, so a pathological curve cannot hang. */
const DEFAULT_MAX_SEGMENTS = 512;

/** Minimum number of segments, so a straight-ish curve still subdivides. */
const DEFAULT_MIN_SEGMENTS = 1;

/** Recursion depth cap; `2^20` intervals is far beyond any practical need. */
const MAX_DEPTH = 20;

/* -------------------------------------------------------------------------- */
/* Flatness                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Perpendicular distance of `p1` from the chord `p0 -> p2`.
 *
 * This is the flatness error of the chord: the larger it is, the less the chord
 * resembles the curve, and the more subdivision the interval needs. Returns the
 * distance `p1 -> p0` when the chord is degenerate (both endpoints coincide).
 *
 * @param p0 Interval start.
 * @param p1 Interval midpoint sample.
 * @param p2 Interval end.
 */
export function flatnessError(p0: Vec2, p1: Vec2, p2: Vec2): number {
  const dx = p2.x - p0.x;
  const dy = p2.y - p0.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p1.x - p0.x, p1.y - p0.y);
  // |cross(p1 - p0, d)| / |d|
  const cross = (p1.x - p0.x) * dy - (p1.y - p0.y) * dx;
  return Math.abs(cross) / Math.sqrt(lengthSquared);
}

/* -------------------------------------------------------------------------- */
/* Sampling                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Uniformly samples `curve` into `count + 1` points, inclusive of both ends.
 *
 * @param curve Curve to sample.
 * @param count Number of segments; clamped to at least 1.
 */
export function sampleCurve(curve: TessellatableCurve, count: number): Vec2[] {
  const segments = Math.max(1, Math.floor(count));
  const points: Vec2[] = new Array(segments + 1);
  for (let i = 0; i <= segments; i++) points[i] = curve.getPoint(i / segments);
  return points;
}

/* -------------------------------------------------------------------------- */
/* Tessellation                                                               */
/* -------------------------------------------------------------------------- */

/** Mutable accumulator threaded through the recursive subdivision. */
interface SubdivisionState {
  points: Vec2[];
  segments: number;
}

/**
 * Tessellates one curve.
 *
 * With `options.divisions` set (or `options.adaptive === false`) the curve is
 * sampled uniformly. Otherwise the interval `[0, 1]` is bisected recursively and
 * each half is accepted once its flatness error is within `tolerance` **and**
 * the minimum segment count has been reached.
 *
 * The recursion always terminates: a depth cap of {@link MAX_DEPTH} and the
 * `maxSegments` budget both stop it, so a cusp or a self-intersection cannot
 * hang the caller.
 *
 * @param curve Curve to flatten.
 * @param options Tolerance and segment budget.
 * @returns The flattened polyline and its segment count.
 */
export function tessellateCurve(
  curve: TessellatableCurve,
  options: TessellationOptions = {},
): TessellatedPath {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const maxSegments = Math.max(1, Math.floor(options.maxSegments ?? DEFAULT_MAX_SEGMENTS));
  const minSegments = Math.max(1, Math.floor(options.minSegments ?? DEFAULT_MIN_SEGMENTS));
  const adaptive = options.adaptive ?? true;

  if (!adaptive || options.divisions !== undefined) {
    const divisions = Math.max(
      minSegments,
      Math.min(maxSegments, Math.floor(options.divisions ?? DEFAULT_CURVE_DIVISIONS)),
    );
    const points = sampleCurve(curve, divisions);
    return { points, segments: divisions };
  }

  const start = curve.getPoint(0);
  const end = curve.getPoint(1);
  const state: SubdivisionState = { points: [start], segments: 0 };
  if (maxSegments <= 1) {
    state.points.push(end);
    return { points: state.points, segments: 1 };
  }

  // Smallest depth that already provides `minSegments` intervals.
  const minDepth = Math.max(0, Math.ceil(Math.log2(minSegments)));
  subdivide(curve, 0, start, 1, end, 0, minDepth, tolerance, maxSegments, state);
  return { points: state.points, segments: state.segments };
}

/**
 * Recursive bisection step.
 *
 * Emits `p1` (the interval end) into `state.points` once the interval is flat
 * enough or the budget is exhausted; otherwise it recurses into both halves.
 */
function subdivide(
  curve: TessellatableCurve,
  t0: number,
  p0: Vec2,
  t1: number,
  p1: Vec2,
  depth: number,
  minDepth: number,
  tolerance: number,
  maxSegments: number,
  state: SubdivisionState,
): void {
  const exhausted = state.segments >= maxSegments - 1 || depth >= MAX_DEPTH;
  if (exhausted) {
    state.points.push(p1);
    state.segments++;
    return;
  }

  const tm = (t0 + t1) * 0.5;
  const pm = curve.getPoint(tm);
  const flatEnough = depth >= minDepth && flatnessError(p0, pm, p1) <= tolerance;

  if (flatEnough) {
    // Two output segments, but only the endpoints need to be recorded.
    state.points.push(pm, p1);
    state.segments += 2;
    return;
  }

  subdivide(curve, t0, p0, tm, pm, depth + 1, minDepth, tolerance, maxSegments, state);
  subdivide(curve, tm, pm, t1, p1, depth + 1, minDepth, tolerance, maxSegments, state);
}

/**
 * Tessellates every segment of a path, sharing the boundary points.
 *
 * The `maxSegments` budget is divided evenly between the segments so a path with
 * one pathological curve cannot starve the rest of the outline.
 *
 * @param path Path to flatten.
 * @param options Tolerance and segment budget.
 */
export function tessellatePath(
  path: TessellatablePath,
  options: TessellationOptions = {},
): TessellatedPath {
  const curves = path.curves;
  if (curves.length === 0) return { points: [], segments: 0 };

  const totalBudget = Math.max(1, Math.floor(options.maxSegments ?? DEFAULT_MAX_SEGMENTS));
  const perCurveBudget = Math.max(1, Math.floor(totalBudget / curves.length));

  const points: Vec2[] = [];
  let segments = 0;

  for (let i = 0; i < curves.length; i++) {
    const tessellated = tessellateCurve(curves[i], { ...options, maxSegments: perCurveBudget });
    if (tessellated.points.length === 0) continue;
    // The first point of every segment repeats the previous segment's last one.
    const start = i === 0 ? 0 : 1;
    for (let p = start; p < tessellated.points.length; p++) points.push(tessellated.points[p]);
    segments += tessellated.segments;
  }

  return { points, segments };
}

/**
 * Removes consecutive duplicate points.
 *
 * @param points Source polyline.
 * @param tolerance Distance below which two consecutive points are considered equal.
 */
export function flattenPoints(points: readonly Vec2[], tolerance: number = 1e-6): Vec2[] {
  const result: Vec2[] = [];
  let previous: Vec2 | null = null;
  for (const point of points) {
    if (previous && previous.distanceTo(point) <= tolerance) continue;
    result.push(point);
    previous = point;
  }
  return result;
}
