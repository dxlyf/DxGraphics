/**
 * Polygon triangulation: ear clipping with hole bridging.
 *
 * ## Algorithm
 *
 * 1. **Normalise winding.** The outer contour is forced counter-clockwise and
 *    every hole clockwise, which is the orientation the ear test assumes.
 * 2. **Bridge the holes.** Each hole is cut into the outer contour along a
 *    mutually visible pair of vertices, producing one simply-connected polygon
 *    with coincident "bridge" edges. Holes are bridged right-to-left (largest
 *    rightmost x first), which is what keeps a later bridge from crossing an
 *    earlier one.
 * 3. **Clip ears.** A vertex is an ear when its triangle is convex, contains no
 *    other vertex of the remaining polygon, and its new diagonal crosses no
 *    existing edge. Ears are removed until three vertices remain.
 *
 * **Complexity**: the ear search is `O(n)` per candidate, `O(n²)` per pass and
 * `O(n³)` per polygon in the worst case. That is fine for shapes an authoring
 * tool produces and avoids the `O(n log n)` machinery (monotone decomposition,
 * sweep-line) that would dominate the bundle. Triangulate once and cache the
 * result if a shape is rebuilt every frame.
 *
 * ## Limitations
 *
 * The input must be a **simple** polygon (and simple holes). Self-intersecting
 * contours are not detected here — run `isSimplePolygon` from `BooleanOps`
 * first if the input is untrusted. Degenerate slivers can be produced when three
 * vertices are collinear; they have zero area and render harmlessly.
 *
 * @packageDocumentation
 */

import { Vec2 } from '../../math/Vec2';
import type { TriangulationOptions, TriangulationResult } from './types';

/** Tolerance used by the orientation and containment predicates. */
const EPSILON = 1e-9;

/* -------------------------------------------------------------------------- */
/* Basic predicates                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Signed area of a contour (the shoelace formula).
 *
 * Positive means counter-clockwise in a y-up coordinate system; negative means
 * clockwise. The magnitude is the enclosed area.
 *
 * @param points Contour vertices, without a repeated closing point.
 */
export function signedArea(points: readonly Vec2[]): number {
  const n = points.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    total += a.x * b.y - b.x * a.y;
  }
  return total * 0.5;
}

/**
 * `true` when the contour winds clockwise.
 *
 * Uses the signed area, so it is exact for simple polygons and merely indicative
 * for self-intersecting ones.
 */
export function isClockWise(points: readonly Vec2[]): boolean {
  return signedArea(points) < 0;
}

/** Twice the signed area of the triangle `(a, b, c)`. */
function cross3(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * `true` when the two segments cross at a point interior to both.
 *
 * Collinear overlap and endpoint touching are deliberately **not** reported:
 * every caller treats those as non-blocking, which is what allows bridge edges
 * and shared vertices to pass the tests.
 */
export function segmentsIntersect(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): boolean {
  const d1 = cross3(b0, b1, a0);
  const d2 = cross3(b0, b1, a1);
  const d3 = cross3(a0, a1, b0);
  const d4 = cross3(a0, a1, b1);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** `true` when `point` lies inside the (counter-clockwise) triangle `(a, b, c)`. */
function pointInTriangleStrict(point: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  return cross3(a, b, point) > EPSILON && cross3(b, c, point) > EPSILON && cross3(c, a, point) > EPSILON;
}

/**
 * Even-odd point-in-polygon test.
 *
 * Works for any simple polygon, convex or not. Points exactly on an edge are
 * reported as inside or outside depending on the scan direction; callers that
 * need a definite answer for boundary points should test the edges first.
 */
export function pointInPolygon(point: Vec2, polygon: readonly Vec2[]): boolean {
  const n = polygon.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > point.y !== b.y > point.y) {
      const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (point.x < x) inside = !inside;
    }
  }
  return inside;
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

/** Removes a repeated closing point and consecutive duplicates. */
function dedupe(points: readonly Vec2[], tolerance: number = 1e-9): Vec2[] {
  const result: Vec2[] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (last && Math.abs(last.x - point.x) <= tolerance && Math.abs(last.y - point.y) <= tolerance) {
      continue;
    }
    result.push(point);
  }
  while (
    result.length > 1 &&
    Math.abs(result[0].x - result[result.length - 1].x) <= tolerance &&
    Math.abs(result[0].y - result[result.length - 1].y) <= tolerance
  ) {
    result.pop();
  }
  return result;
}

/** Returns `points` reversed in a new array. */
function reversed(points: readonly Vec2[]): Vec2[] {
  const result = points.slice();
  result.reverse();
  return result;
}

/* -------------------------------------------------------------------------- */
/* Hole bridging                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `true` when the bridge `a -> b` crosses no edge of `polygon`.
 *
 * @param a Bridge start.
 * @param b Bridge end.
 * @param polygon Contour to test against.
 * @param skipIndex Vertex of `polygon` the bridge is attached to; the two edges
 *   incident to it are skipped because they share that endpoint.
 */
function bridgeIsClear(a: Vec2, b: Vec2, polygon: readonly Vec2[], skipIndex: number): boolean {
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (i === skipIndex || j === skipIndex) continue;
    if (segmentsIntersect(a, b, polygon[i], polygon[j])) return false;
  }
  return true;
}

/**
 * Bridges one hole into the outer contour.
 *
 * Exposed through {@link removeHoles}; kept separate so the per-hole step can be
 * reasoned about (and tested) on its own.
 *
 * @param contour Outer contour, counter-clockwise, no repeated closing point.
 * @param hole Hole contour, clockwise, no repeated closing point.
 * @throws Error when no mutually visible vertex pair exists, which means the
 *   hole is degenerate or lies outside the contour.
 */
export function bridgeHole(contour: readonly Vec2[], hole: readonly Vec2[]): Vec2[] {
  // Rightmost hole vertex: the standard starting point, because a ray cast from
  // it to +x is guaranteed to leave the polygon.
  let holeIndex = 0;
  for (let i = 1; i < hole.length; i++) {
    if (hole[i].x > hole[holeIndex].x) holeIndex = i;
  }
  const holeVertex = hole[holeIndex];

  const candidates: number[] = [];
  for (let i = 0; i < contour.length; i++) candidates.push(i);
  candidates.sort(
    (a, b) =>
      contour[a].distanceToSquared(holeVertex) - contour[b].distanceToSquared(holeVertex),
  );

  for (const candidate of candidates) {
    const outerVertex = contour[candidate];
    if (!bridgeIsClear(holeVertex, outerVertex, contour, candidate)) continue;

    // The bridge must also avoid every edge of the hole itself.
    if (!bridgeIsClear(holeVertex, outerVertex, hole, holeIndex)) continue;

    // And its midpoint must be inside the contour and outside the hole,
    // otherwise the bridge would leave the polygon.
    const midX = (holeVertex.x + outerVertex.x) * 0.5;
    const midY = (holeVertex.y + outerVertex.y) * 0.5;
    const midpoint = new Vec2(midX, midY);
    if (!pointInPolygon(midpoint, contour)) continue;
    if (pointInPolygon(midpoint, hole)) continue;

    const result: Vec2[] = [];
    for (let i = 0; i <= candidate; i++) result.push(contour[i]);
    for (let i = 0; i < hole.length; i++) result.push(hole[(holeIndex + i) % hole.length]);
    result.push(holeVertex);
    for (let i = candidate; i < contour.length; i++) result.push(contour[i]);
    return result;
  }

  throw new Error(
    'removeHoles(): no mutually visible vertex pair connects the hole to the contour; the hole is degenerate, self-intersecting or lies outside the contour',
  );
}

/**
 * Bridges every hole into the outer contour, producing one simple polygon.
 *
 * Holes are processed right-to-left (largest rightmost x first) and each hole is
 * normalised to clockwise while the contour is normalised to counter-clockwise.
 * The returned polygon repeats two vertices per bridge, which is intentional:
 * the duplicated vertices form the zero-width channel that makes the result
 * simply connected.
 *
 * @param contour Outer contour.
 * @param holes Hole contours.
 */
export function removeHoles(contour: readonly Vec2[], holes: ReadonlyArray<readonly Vec2[]>): Vec2[] {
  let outer = dedupe(contour);
  if (outer.length < 3) return outer;
  if (isClockWise(outer)) outer = reversed(outer);

  const prepared = holes
    .map((hole) => dedupe(hole))
    .filter((hole) => hole.length >= 3)
    .map((hole) => (isClockWise(hole) ? hole : reversed(hole)));

  prepared.sort((a, b) => rightmostX(b) - rightmostX(a));

  let combined = outer;
  for (const hole of prepared) combined = bridgeHole(combined, hole);
  return combined;
}

/** Largest x over the contour. */
function rightmostX(points: readonly Vec2[]): number {
  let max = -Infinity;
  for (const point of points) if (point.x > max) max = point.x;
  return max;
}

/* -------------------------------------------------------------------------- */
/* Ear clipping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `true` when the vertex at working-list position `i` can be clipped.
 *
 * @param working Indices of the vertices still in the polygon, in order.
 * @param polygon All vertices, indexed by {@link working}.
 * @param i Position inside `working`.
 * @param areaEpsilon Minimum triangle area, used to reject slivers.
 */
function isEar(working: number[], polygon: readonly Vec2[], i: number, areaEpsilon: number): boolean {
  const n = working.length;
  const i0 = working[(i + n - 1) % n];
  const i1 = working[i];
  const i2 = working[(i + 1) % n];
  const a = polygon[i0];
  const b = polygon[i1];
  const c = polygon[i2];

  // A counter-clockwise polygon has a convex vertex exactly when the cross
  // product is positive.
  if (cross3(a, b, c) <= areaEpsilon) return false;

  for (let j = 0; j < n; j++) {
    const vj = working[j];
    if (vj === i0 || vj === i1 || vj === i2) continue;
    const p = polygon[vj];
    // Coincident bridge duplicates must not block the ear.
    if (
      (p.x === a.x && p.y === a.y) ||
      (p.x === b.x && p.y === b.y) ||
      (p.x === c.x && p.y === c.y)
    ) {
      continue;
    }
    if (pointInTriangleStrict(p, a, b, c)) return false;
  }

  // The new diagonal must not cross an existing edge.
  for (let j = 0; j < n; j++) {
    const e0 = working[j];
    const e1 = working[(j + 1) % n];
    if (e0 === i0 || e0 === i1 || e0 === i2) continue;
    if (e1 === i0 || e1 === i1 || e1 === i2) continue;
    if (segmentsIntersect(a, c, polygon[e0], polygon[e1])) return false;
  }

  return true;
}

/**
 * Clips a simply-connected polygon into triangles.
 *
 * @param polygon Vertices of a simple, counter-clockwise polygon. Coincident
 *   bridge duplicates are allowed.
 * @param areaEpsilon Minimum accepted triangle area.
 * @returns Flat `[i0, i1, i2, ...]` indices into `polygon`.
 */
export function earClip(polygon: readonly Vec2[], areaEpsilon: number = 1e-12): number[] {
  const n = polygon.length;
  if (n < 3) return [];

  const working: number[] = [];
  for (let i = 0; i < n; i++) working.push(i);

  const triangles: number[] = [];
  let guard = 0;
  const guardLimit = n * n + 16;

  while (working.length > 3 && guard++ < guardLimit) {
    let clipped = false;
    for (let i = 0; i < working.length; i++) {
      if (!isEar(working, polygon, i, areaEpsilon)) continue;
      const count = working.length;
      const i0 = working[(i + count - 1) % count];
      const i1 = working[i];
      const i2 = working[(i + 1) % count];
      triangles.push(i0, i1, i2);
      working.splice(i, 1);
      clipped = true;
      break;
    }

    if (clipped) continue;

    // No valid ear: the polygon is degenerate (all vertices collinear, or a
    // vertex sits exactly on another edge). Clip the most convex remaining
    // vertex so the loop always makes progress and never returns NaN. The
    // resulting sliver has near-zero area.
    let best = 0;
    let bestCross = -Infinity;
    for (let i = 0; i < working.length; i++) {
      const count = working.length;
      const a = polygon[working[(i + count - 1) % count]];
      const b = polygon[working[i]];
      const c = polygon[working[(i + 1) % count]];
      const value = cross3(a, b, c);
      if (value > bestCross) {
        bestCross = value;
        best = i;
      }
    }
    const count = working.length;
    triangles.push(working[(best + count - 1) % count], working[best], working[(best + 1) % count]);
    working.splice(best, 1);
  }

  if (working.length === 3) triangles.push(working[0], working[1], working[2]);
  return triangles;
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Triangulates a contour with optional holes.
 *
 * @param contour Outer contour, in any winding.
 * @param holes Hole contours, in any winding.
 * @param options Validation and pruning switches.
 * @returns Flat vertex/index/uv arrays; `uvs` is normalised into the contour's
 *   bounding box.
 * @throws Error when a hole cannot be bridged (see {@link bridgeHole}).
 */
export function triangulate(
  contour: readonly Vec2[],
  holes: ReadonlyArray<readonly Vec2[]> = [],
  options: TriangulationOptions = {},
): TriangulationResult {
  const areaEpsilon = options.areaEpsilon ?? 1e-12;
  const outer = dedupe(contour);
  if (outer.length < 3) return { vertices: [], indices: [], uvs: [] };

  let normalizedHoles = holes
    .map((hole) => dedupe(hole))
    .filter((hole) => hole.length >= 3);

  if (options.pruneOutsideHoles !== false) {
    normalizedHoles = normalizedHoles.filter((hole) => pointInPolygon(hole[0], outer));
  }

  const combined = normalizedHoles.length > 0 ? removeHoles(outer, normalizedHoles) : outer;
  const triangles = earClip(combined, areaEpsilon);
  if (triangles.length === 0) return { vertices: [], indices: [], uvs: [] };

  // Emit only the vertices the triangles actually reference.
  const remap = new Map<number, number>();
  const used: number[] = [];
  for (const index of triangles) {
    if (!remap.has(index)) {
      remap.set(index, used.length);
      used.push(index);
    }
  }

  // UVs are normalised against the *outer* contour so a hole cannot skew them.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of outer) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  const sizeX = maxX - minX;
  const sizeY = maxY - minY;

  const vertices: number[] = [];
  const uvs: number[] = [];
  for (const index of used) {
    const point = combined[index];
    vertices.push(point.x, point.y);
    uvs.push(sizeX > 0 ? (point.x - minX) / sizeX : 0.5, sizeY > 0 ? (point.y - minY) / sizeY : 0.5);
  }

  const indices = triangles.map((index) => remap.get(index) ?? 0);
  return { vertices, indices, uvs };
}

/**
 * Convenience alias with the argument order used by the geometry public API.
 *
 * @param contour Outer contour.
 * @param holes Hole contours.
 * @param options Validation and pruning switches.
 */
export function triangulateShape(
  contour: readonly Vec2[],
  holes: ReadonlyArray<readonly Vec2[]> = [],
  options: TriangulationOptions = {},
): TriangulationResult {
  return triangulate(contour, holes, options);
}
