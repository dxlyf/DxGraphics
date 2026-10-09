/**
 * 2D boolean operations on simple polygons.
 *
 * ## Approach: arrangement + boundary extraction
 *
 * Greiner–Hormann and Sutherland–Hodgman both fail on the case that matters
 * most in practice: two axis-aligned rectangles that share part of an edge.
 * Greiner–Hormann has no degenerate case for collinear overlapping edges, and
 * Sutherland–Hodgman only ever clips against a **convex** window. This module
 * therefore uses a third technique, which is slower but has no such blind spot:
 *
 * 1. **Split.** Every edge of `A` is split at every intersection with an edge of
 *    `B`, and vice versa. Collinear overlaps are handled explicitly by
 *    projecting the endpoints of one edge onto the other, so a shared edge
 *    becomes a set of identical sub-segments on both sides.
 * 2. **Classify.** For each sub-segment, two probe points are placed a small
 *    distance either side of its midpoint, and both are tested against the
 *    operation's membership predicate (`inA || inB` for union, `inA && inB` for
 *    intersection, and so on). The sub-segment is on the result boundary exactly
 *    when the two probes disagree.
 * 3. **Orient.** A surviving sub-segment is emitted with the result's interior
 *    on its **left**. That single rule produces counter-clockwise outer loops and
 *    clockwise hole loops automatically, which is what a triangulator or a
 *    nonzero/even-odd fill rule expects.
 * 4. **Chain.** Surviving sub-segments are walked start-to-end into closed loops,
 *    resolving junctions by taking the tightest clockwise turn.
 *
 * The output is a list of contours, each closed implicitly (the first vertex is
 * **not** repeated at the end). Signed areas are positive for outer loops and
 * negative for holes, so `contoursArea()` gives the net area of the result.
 *
 * ## Robustness and limits
 *
 * - Vertices closer together than `1e-6` are treated as identical for topology
 *   purposes (coordinates themselves are not moved).
 * - Probes are placed `max(1e-6, bboxDiagonal · 1e-5)` from the edge, so a
 *   feature thinner than that can be misclassified. Results are therefore only
 *   meaningful for polygons whose thinnest feature exceeds that scale.
 * - The inputs must be simple polygons. Passing a self-intersecting contour is
 *   not detected here; call {@link isSimplePolygon} first when the input is
 *   untrusted. The result of a nonsensical input is not silently "wrong but
 *   plausible" — the chaining step discards any walk that fails to close.
 *
 * @packageDocumentation
 */

import { Vec2 } from '../../math/Vec2';
import { isClockWise, pointInPolygon, segmentsIntersect, signedArea } from './Triangulate';
import type { BooleanOp, BooleanResultJSON } from './types';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                     */
/* -------------------------------------------------------------------------- */

/** Coordinate quantum used to decide whether two vertices are the same. */
const SNAP = 1e-6;

/** Relative probe distance; a feature thinner than this can be misclassified. */
const PROBE_SCALE = 1e-5;

/** Absolute floor for the probe distance. */
const PROBE_MIN = 1e-6;

/** Relative tolerance for the parallel/collinear test. */
const PARALLEL_EPSILON = 1e-9;

/* -------------------------------------------------------------------------- */
/* Predicates                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Signed area of a contour; positive means counter-clockwise in a y-up system.
 *
 * @param points Contour vertices without a repeated closing point.
 */
export function polygonArea(points: readonly Vec2[]): number {
  return signedArea(points);
}

/** Net area of a result set: outer loops add, holes subtract. */
export function contoursArea(contours: ReadonlyArray<readonly Vec2[]>): number {
  let total = 0;
  for (const contour of contours) total += signedArea(contour);
  return total;
}

/** `true` when `point` is inside the contour. */
function inside(point: Vec2, contour: readonly Vec2[]): boolean {
  return pointInPolygon(point, contour);
}

/**
 * `true` when the contour crosses itself.
 *
 * Scans every pair of non-adjacent edges for a proper crossing. Edges that share
 * a vertex are skipped, so a simple polygon with a very acute corner is not
 * misreported.
 */
export function polygonSelfIntersects(points: readonly Vec2[]): boolean {
  const count = points.length;
  if (count < 4) return false;
  for (let i = 0; i < count; i++) {
    const a0 = points[i];
    const a1 = points[(i + 1) % count];
    for (let j = i + 1; j < count; j++) {
      if (j === i) continue;
      if (j === (i + 1) % count) continue;
      if ((j + 1) % count === i) continue;
      const b0 = points[j];
      const b1 = points[(j + 1) % count];
      if (segmentsIntersect(a0, a1, b0, b1)) return true;
    }
  }
  return false;
}

/**
 * `true` when the contour is a simple polygon: at least three vertices, no
 * repeated vertex, and no self-crossing.
 */
export function isSimplePolygon(points: readonly Vec2[]): boolean {
  const count = points.length;
  if (count < 3) return false;
  const seen = new Set<string>();
  for (const point of points) {
    const key = keyOf(point);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return !polygonSelfIntersects(points);
}

/** `true` when every turn of the contour has the same sign. */
export function isConvexPolygon(points: readonly Vec2[]): boolean {
  const count = points.length;
  if (count < 4) return count >= 3;
  let sign = 0;
  for (let i = 0; i < count; i++) {
    const a = points[i];
    const b = points[(i + 1) % count];
    const c = points[(i + 2) % count];
    const value = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(value) < 1e-12) continue;
    const current = value > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (sign !== current) return false;
  }
  return true;
}

/**
 * `true` when the two polygons share a region of non-zero area.
 *
 * Touching along an edge counts as *not* overlapping.
 */
export function polygonsOverlap(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  return Math.abs(contoursArea(intersection(a, b))) > 1e-9;
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Topology key for a point, quantised to {@link SNAP}. */
function keyOf(point: Vec2): string {
  return `${Math.round(point.x / SNAP)}|${Math.round(point.y / SNAP)}`;
}

/** Removes a repeated closing vertex and consecutive duplicates. */
function cleanContour(points: readonly Vec2[]): Vec2[] {
  const result: Vec2[] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (last && keyOf(last) === keyOf(point)) continue;
    result.push(point.clone());
  }
  while (result.length > 1 && keyOf(result[0]) === keyOf(result[result.length - 1])) result.pop();
  return result;
}

/** Bounding-box diagonal of every supplied contour, used to scale the probe. */
function combinedDiagonal(contours: ReadonlyArray<readonly Vec2[]>): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const contour of contours) {
    for (const point of contour) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  if (minX > maxX) return 0;
  return Math.hypot(maxX - minX, maxY - minY);
}

/** A directed sub-segment of an input edge. */
interface SubSegment {
  /** Start point. */
  p: Vec2;
  /** End point. */
  q: Vec2;
}

/** A directed boundary edge of the result, interior on the left. */
interface HalfEdge {
  /** Start point. */
  p: Vec2;
  /** End point. */
  q: Vec2;
  /** Quantised start key. */
  pKey: string;
  /** Quantised end key. */
  qKey: string;
}

/**
 * Adds the parameters at which `r -> s` touches the line `p + t·d`.
 *
 * Handles both the transversal case (one solution) and the collinear case (a
 * range of solutions, represented by the projections of `r` and `s`).
 */
function addIntersectionParameters(
  p: Vec2,
  dx: number,
  dy: number,
  lengthSquared: number,
  r: Vec2,
  s: Vec2,
  parameters: number[],
): void {
  const ex = s.x - r.x;
  const ey = s.y - r.y;
  const otherLengthSquared = ex * ex + ey * ey;
  if (otherLengthSquared === 0) return;

  const rx = r.x - p.x;
  const ry = r.y - p.y;
  const denominator = dx * ey - dy * ex;
  const scale = Math.sqrt(lengthSquared * otherLengthSquared);

  if (Math.abs(denominator) > PARALLEL_EPSILON * scale) {
    const t = (rx * ey - ry * ex) / denominator;
    const u = (rx * dy - ry * dx) / denominator;
    if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) {
      parameters.push(Math.min(1, Math.max(0, t)));
    }
    return;
  }

  // Parallel: only a collinear pair can contribute, and only through the
  // projections of the other edge's endpoints.
  const perpendicular = Math.abs(rx * dy - ry * dx) / Math.sqrt(lengthSquared);
  if (perpendicular > 1e-7) return;

  const t0 = (rx * dx + ry * dy) / lengthSquared;
  const sx = s.x - p.x;
  const sy = s.y - p.y;
  const t1 = (sx * dx + sy * dy) / lengthSquared;
  if (t0 > 0 && t0 < 1) parameters.push(t0);
  if (t1 > 0 && t1 < 1) parameters.push(t1);
}

/** Splits every edge of `self` at its intersections with the edges of `other`. */
function splitEdges(self: readonly Vec2[], other: readonly Vec2[]): SubSegment[] {
  const result: SubSegment[] = [];
  const count = self.length;
  for (let i = 0; i < count; i++) {
    const p = self[i];
    const q = self[(i + 1) % count];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) continue;

    const parameters: number[] = [0, 1];
    for (let j = 0; j < other.length; j++) {
      addIntersectionParameters(p, dx, dy, lengthSquared, other[j], other[(j + 1) % other.length], parameters);
    }
    parameters.sort((a, b) => a - b);

    for (let k = 0; k + 1 < parameters.length; k++) {
      const t0 = parameters[k];
      const t1 = parameters[k + 1];
      if (t1 - t0 < 1e-9) continue;
      const start = new Vec2(p.x + dx * t0, p.y + dy * t0);
      const end = new Vec2(p.x + dx * t1, p.y + dy * t1);
      if (keyOf(start) === keyOf(end)) continue;
      result.push({ p: start, q: end });
    }
  }
  return result;
}

/**
 * Keeps the sub-segments that lie on the result boundary and orients each one so
 * the result's interior is on its left.
 */
function extractBoundary(
  subSegments: readonly SubSegment[],
  contains: (point: Vec2) => boolean,
  probe: number,
): HalfEdge[] {
  const edges: HalfEdge[] = [];
  for (const segment of subSegments) {
    const dx = segment.q.x - segment.p.x;
    const dy = segment.q.y - segment.p.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;

    const midX = (segment.p.x + segment.q.x) * 0.5;
    const midY = (segment.p.y + segment.q.y) * 0.5;
    // Left normal of the directed edge.
    const nx = -dy / length;
    const ny = dx / length;

    const leftInside = contains(new Vec2(midX + nx * probe, midY + ny * probe));
    const rightInside = contains(new Vec2(midX - nx * probe, midY - ny * probe));
    if (leftInside === rightInside) continue;

    const p = leftInside ? segment.p : segment.q;
    const q = leftInside ? segment.q : segment.p;
    edges.push({ p, q, pKey: keyOf(p), qKey: keyOf(q) });
  }

  // Two coincident collinear edges (for example the shared bottom of two
  // rectangles) both survive the probe test; keep only one copy.
  const seen = new Set<string>();
  const unique: HalfEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.pKey}>${edge.qKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(edge);
  }
  return unique;
}

/** Unit direction of a half edge. */
function directionOf(edge: HalfEdge): { x: number; y: number } {
  const dx = edge.q.x - edge.p.x;
  const dy = edge.q.y - edge.p.y;
  const length = Math.hypot(dx, dy);
  return length > 0 ? { x: dx / length, y: dy / length } : { x: 1, y: 0 };
}

/**
 * Walks the oriented half-edges into closed loops.
 *
 * Any walk that cannot be closed is discarded rather than emitted: a partial
 * boundary would be a plausible-looking but wrong polygon, and this module never
 * returns those.
 */
function chainLoops(edges: readonly HalfEdge[]): Vec2[][] {
  const outgoing = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const list = outgoing.get(edges[i].pKey);
    if (list) list.push(i);
    else outgoing.set(edges[i].pKey, [i]);
  }

  const used = new Uint8Array(edges.length);
  const loops: Vec2[][] = [];

  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;

    const startKey = edges[start].pKey;
    const loop: Vec2[] = [];
    let current = start;
    let closed = false;

    while (true) {
      used[current] = 1;
      loop.push(edges[current].p);
      if (edges[current].qKey === startKey) {
        closed = true;
        break;
      }

      const candidates = outgoing.get(edges[current].qKey);
      if (!candidates) break;

      const incoming = directionOf(edges[current]);
      let next = -1;
      let bestTurn = Infinity;
      for (const candidate of candidates) {
        if (used[candidate]) continue;
        const outgoingDirection = directionOf(edges[candidate]);
        const turn = Math.atan2(
          incoming.x * outgoingDirection.y - incoming.y * outgoingDirection.x,
          incoming.x * outgoingDirection.x + incoming.y * outgoingDirection.y,
        );
        if (turn < bestTurn) {
          bestTurn = turn;
          next = candidate;
        }
      }
      if (next < 0) break;
      current = next;
    }

    if (closed && loop.length >= 3) loops.push(loop);
  }

  return loops;
}

/* -------------------------------------------------------------------------- */
/* Core routine                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Runs one boolean operation.
 *
 * @param a First operand.
 * @param b Second operand.
 * @param membership Predicate over `(inA, inB)`.
 * @param areaEpsilon Loops with a smaller absolute area are discarded.
 */
function polygonBoolean(
  a: readonly Vec2[],
  b: readonly Vec2[],
  membership: (inA: boolean, inB: boolean) => boolean,
  areaEpsilon: number,
): Vec2[][] {
  const contourA = cleanContour(a);
  const contourB = cleanContour(b);
  if (contourA.length < 3 || contourB.length < 3) return [];

  const probe = Math.max(PROBE_MIN, combinedDiagonal([contourA, contourB]) * PROBE_SCALE);

  const contains = (point: Vec2): boolean =>
    membership(inside(point, contourA), inside(point, contourB));

  const subSegments = [...splitEdges(contourA, contourB), ...splitEdges(contourB, contourA)];
  const boundary = extractBoundary(subSegments, contains, probe);
  const loops = chainLoops(boundary);

  // Snap the emitted vertices to the topology grid and drop zero-area loops.
  const result: Vec2[][] = [];
  for (const loop of loops) {
    if (Math.abs(signedArea(loop)) <= areaEpsilon) continue;
    const snapped = loop.map(
      (point) => new Vec2(Math.round(point.x / SNAP) * SNAP, Math.round(point.y / SNAP) * SNAP),
    );
    const cleaned = cleanContour(snapped);
    if (cleaned.length < 3) continue;
    if (Math.abs(signedArea(cleaned)) <= areaEpsilon) continue;
    result.push(cleaned);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Public operations                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Everything covered by `a` or `b`.
 *
 * @param a First polygon.
 * @param b Second polygon.
 * @param areaEpsilon Loops smaller than this are dropped; defaults to `1e-12`.
 */
export function union(a: readonly Vec2[], b: readonly Vec2[], areaEpsilon: number = 1e-12): Vec2[][] {
  return polygonBoolean(a, b, (inA, inB) => inA || inB, areaEpsilon);
}

/**
 * Everything covered by both `a` and `b`.
 *
 * @param a First polygon.
 * @param b Second polygon.
 * @param areaEpsilon Loops smaller than this are dropped; defaults to `1e-12`.
 */
export function intersection(
  a: readonly Vec2[],
  b: readonly Vec2[],
  areaEpsilon: number = 1e-12,
): Vec2[][] {
  return polygonBoolean(a, b, (inA, inB) => inA && inB, areaEpsilon);
}

/**
 * Everything covered by `a` but not by `b`.
 *
 * A hole left by `b` is returned as a clockwise contour, so
 * {@link contoursArea} reports the net area.
 *
 * @param a First polygon.
 * @param b Second polygon.
 * @param areaEpsilon Loops smaller than this are dropped; defaults to `1e-12`.
 */
export function difference(
  a: readonly Vec2[],
  b: readonly Vec2[],
  areaEpsilon: number = 1e-12,
): Vec2[][] {
  return polygonBoolean(a, b, (inA, inB) => inA && !inB, areaEpsilon);
}

/**
 * Everything covered by exactly one of `a` and `b` (symmetric difference).
 *
 * @param a First polygon.
 * @param b Second polygon.
 * @param areaEpsilon Loops smaller than this are dropped; defaults to `1e-12`.
 */
export function xor(a: readonly Vec2[], b: readonly Vec2[], areaEpsilon: number = 1e-12): Vec2[][] {
  return polygonBoolean(a, b, (inA, inB) => inA !== inB, areaEpsilon);
}

/* -------------------------------------------------------------------------- */
/* Clipping                                                                   */
/* -------------------------------------------------------------------------- */

/** Signed side of `p` relative to the directed line `a -> b`; positive is left. */
function side(a: Vec2, b: Vec2, p: Vec2): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

/** Intersection of the segments `p -> q` and `a -> b`. */
function lineIntersection(p: Vec2, q: Vec2, a: Vec2, b: Vec2): Vec2 {
  const d1x = q.x - p.x;
  const d1y = q.y - p.y;
  const d2x = b.x - a.x;
  const d2y = b.y - a.y;
  const denominator = d1x * d2y - d1y * d2x;
  if (denominator === 0) return q.clone();
  const t = ((a.x - p.x) * d2y - (a.y - p.y) * d2x) / denominator;
  return new Vec2(p.x + d1x * t, p.y + d1y * t);
}

/**
 * Clips `subject` against a **convex** `clip` window (Sutherland–Hodgman).
 *
 * Sutherland–Hodgman is exact and `O(n·m)` here, which beats the arrangement
 * pipeline, but it is only defined for a convex window: a non-convex window
 * either produces spurious edges or collapses the polygon.
 *
 * @param subject Polygon to clip; may be concave.
 * @param clip Convex clip window; any winding.
 * @throws Error when `clip` is not convex. Use {@link intersection} instead,
 *   which handles arbitrary simple polygons.
 */
export function clipPolygon(subject: readonly Vec2[], clip: readonly Vec2[]): Vec2[] {
  if (subject.length < 3 || clip.length < 3) return [];
  if (!isConvexPolygon(clip)) {
    throw new Error(
      'clipPolygon(): the clip polygon must be convex; use intersection() or difference() for non-convex windows',
    );
  }

  const window = isClockWise(clip) ? [...clip].reverse() : clip.slice();
  let output: Vec2[] = subject.map((point) => point.clone());

  for (let i = 0; i < window.length && output.length > 0; i++) {
    const a = window[i];
    const b = window[(i + 1) % window.length];
    const input = output;
    output = [];

    for (let j = 0; j < input.length; j++) {
      const current = input[j];
      const previous = input[(j + input.length - 1) % input.length];
      const currentInside = side(a, b, current) >= 0;
      const previousInside = side(a, b, previous) >= 0;

      if (currentInside) {
        if (!previousInside) output.push(lineIntersection(previous, current, a, b));
        output.push(current);
      } else if (previousInside) {
        output.push(lineIntersection(previous, current, a, b));
      }
    }
  }

  return cleanContour(output);
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Wraps a boolean result as plain JSON.
 *
 * @param op The operation that produced `contours`.
 * @param contours The result contours.
 */
export function booleanResultToJSON(
  op: BooleanOp,
  contours: ReadonlyArray<readonly Vec2[]>,
): BooleanResultJSON {
  return {
    op,
    contours: contours.map((contour) => {
      const flat: number[] = [];
      for (const point of contour) flat.push(point.x, point.y);
      return flat;
    }),
    areas: contours.map((contour) => signedArea(contour)),
  };
}
