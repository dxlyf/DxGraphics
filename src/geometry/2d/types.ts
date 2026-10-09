/**
 * Type vocabulary for the 2D geometry layer: curve identifiers, path commands,
 * tessellation and triangulation options/results and the JSON shapes emitted by
 * the 2D classes.
 *
 * @packageDocumentation
 */

import type { Vec2 } from '../../math/Vec2';
import type { Vec3 } from '../../math/Vec3';

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Discriminator carried by every `Curve` subclass.
 *
 * Used by `Curve.fromJSON` and by importers that need to rebuild a concrete
 * curve class from serialised data.
 */
export type CurveType =
  /* 2D */
  | 'LineCurve'
  | 'QuadraticBezierCurve'
  | 'CubicBezierCurve'
  | 'ArcCurve'
  | 'EllipseCurve'
  | 'SplineCurve'
  | 'Path'
  | 'Shape'
  | 'Polygon'
  | 'Polyline'
  /* 3D — the same `Curve` base class is generic over `Vec2 | Vec3` */
  | 'LineCurve3'
  | 'QuadraticBezierCurve3'
  | 'CubicBezierCurve3'
  | 'CatmullRomCurve3'
  | 'SplineCurve3';

/** Which way a closed contour winds. */
export type PolygonOrientation = 'clockwise' | 'counter-clockwise' | 'degenerate';

/** The four boolean set operations supported by `BooleanOps`. */
export type BooleanOp = 'union' | 'intersection' | 'difference' | 'xor';

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A single authoring command of a `Path`.
 *
 * The names deliberately mirror the Canvas2D and SVG path grammar so that
 * importers can map straight onto `Path` methods.
 */
export type PathCommand =
  | 'moveTo'
  | 'lineTo'
  | 'quadraticCurveTo'
  | 'bezierCurveTo'
  | 'splineThru'
  | 'arc'
  | 'arcTo'
  | 'ellipse'
  | 'closePath';

/** A point in 2D with mutable fields (used for plain-data interchange). */
export interface Point2 {
  /** X coordinate. */
  x: number;
  /** Y coordinate. */
  y: number;
}

/* -------------------------------------------------------------------------- */
/* Tessellation                                                               */
/* -------------------------------------------------------------------------- */

/** Options accepted by the adaptive tessellators in `Tessellate.ts`. */
export interface TessellationOptions {
  /**
   * Maximum allowed distance, in world units, between the curve and the
   * polyline that approximates it. Lower values produce more segments.
   * Defaults to `0.25`.
   */
  tolerance?: number;
  /** Hard upper bound on the emitted segment count. Defaults to `512`. */
  maxSegments?: number;
  /** Minimum segment count, so straight-ish curves still subdivide. Defaults to `1`. */
  minSegments?: number;
  /** Use uniform sampling at this resolution instead of adaptive subdivision. */
  divisions?: number;
  /**
   * `true` (default) uses the second-derivative flatness test; `false` samples
   * uniformly at `divisions`.
   */
  adaptive?: boolean;
}

/** Result of tessellating a curve or path. */
export interface TessellatedPath {
  /** The flattened polyline, in curve order. */
  points: Vec2[];
  /** Number of segments, i.e. `points.length - 1`. */
  segments: number;
}

/** Options accepted by the `Shape` factory helpers. */
export interface ShapeOptions {
  /**
   * Hole contours, in the same coordinate space as the outline. Each hole is
   * closed automatically.
   */
  holes?: ReadonlyArray<ReadonlyArray<Point2>>;
  /** Curve resolution used by the geometry-producing helpers. */
  curveSegments?: number;
  /** Whether the outline is closed implicitly. Defaults to `true`. */
  autoClose?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Triangulation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Flat triangulation output.
 *
 * `vertices` is a flat `[x0, y0, x1, y1, ...]` list holding **only the vertices
 * actually referenced** by `indices` (holes included), `indices` is a flat
 * `[i0, i1, i2, ...]` triangle list and `uvs` is a flat `[u0, v0, ...]` list
 * parallel to `vertices`, normalised into the contour's bounding box.
 */
export interface TriangulationResult {
  /** Flat `[x, y, ...]` vertex positions. */
  vertices: number[];
  /** Flat `[i, j, k, ...]` triangle indices into {@link TriangulationResult.vertices}. */
  indices: number[];
  /** Flat `[u, v, ...]` texture coordinates parallel to `vertices`. */
  uvs: number[];
}

/** Options accepted by `triangulateShape`. */
export interface TriangulationOptions {
  /** Remove holes that lie outside the contour before bridging. Defaults to `true`. */
  pruneOutsideHoles?: boolean;
  /** Reject contours that are not simple polygons. Defaults to `false`. */
  validate?: boolean;
  /** Area below which a triangle is discarded. Defaults to `1e-12`. */
  areaEpsilon?: number;
}

/* -------------------------------------------------------------------------- */
/* Curves                                                                     */
/* -------------------------------------------------------------------------- */

/** In-plane Frenet frame returned for `Curve<Vec2>`. */
export interface FrenetFrames2D {
  /** Unit tangent at each sample. */
  tangents: Vec2[];
  /** Unit in-plane normal at each sample (the tangent rotated +90°). */
  normals: Vec2[];
}

/** Full Frenet frame returned for `Curve<Vec3>`. */
export interface FrenetFrames3D {
  /** Unit tangent at each sample. */
  tangents: Vec3[];
  /** Unit normal at each sample. */
  normals: Vec3[];
  /** Unit binormal at each sample. */
  binormals: Vec3[];
}

/** JSON form of a `Curve` subclass. */
export interface CurveJSON {
  /** Concrete class name. */
  type: CurveType;
  /** Number of divisions used for the cached arc-length table. */
  arcLengthDivisions: number;
  /** Class-specific control data. */
  [key: string]: unknown;
}

/** JSON form of a `Path`. */
export interface PathJSON extends CurveJSON {
  /** Narrowed discriminator: `'Path'`, or `'Shape'` on the subclass. */
  type: 'Path' | 'Shape';
  /** Arc-length resolution. */
  arcLengthDivisions: number;
  /** Ordered serialised segments. */
  curves: CurveJSON[];
  /** The current pen position. */
  currentPoint: [number, number];
  /** Whether `closePath()` is applied implicitly. */
  autoClose: boolean;
}

/** JSON form of a `Shape`. */
export interface ShapeJSON extends PathJSON {
  /** Serialised hole contours. */
  holes: PathJSON[];
}

/** JSON form of a `Polygon`. */
export interface PolygonJSON {
  /** Always `'Polygon'`. */
  type: 'Polygon';
  /** Flattened `[x, y, ...]` vertex list. */
  points: number[];
}

/** JSON form of a `Polyline`. */
export interface PolylineJSON {
  /** Always `'Polyline'`. */
  type: 'Polyline';
  /** Flattened `[x, y, ...]` vertex list. */
  points: number[];
}

/** JSON form of a boolean-operation result. */
export interface BooleanResultJSON {
  /** Operation that produced the result. */
  op: BooleanOp;
  /** One flat `[x, y, ...]` array per output contour. */
  contours: number[][];
  /** Signed area of every output contour. */
  areas: number[];
}
