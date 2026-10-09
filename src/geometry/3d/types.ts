/**
 * Type vocabulary for the 3D geometry layer.
 *
 * Generators describe *how* to build geometry; these types describe *what the
 * caller gets*. Keeping them separate means the generator signatures stay stable
 * while the concrete attribute layout lives in `geometry/core`.
 *
 * @packageDocumentation
 */

import type { Vec2 } from '../../math/Vec2';
import type { Vec3 } from '../../math/Vec3';
import type { Curve } from '../2d/Curve';

/* -------------------------------------------------------------------------- */
/* Shared generator vocabulary                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every generator accepts these options in addition to its own.
 *
 * The two segment fields are deliberately separate: `segments` counts *radial*
 * divisions (around an axis), `heightSegments`/`widthSegments` count divisions
 * along the other parameter. A generator documents which it uses.
 */
export interface GeometryGeneratorOptions {
  /** Debug name applied to the produced geometry. */
  name?: string;
  /**
   * Radial (or longitudinal) division count.
   *
   * @default 32
   */
  segments?: number;
  /**
   * Write the geometry with a shared index buffer (the default) or as a
   * triangle soup with unique vertices per corner.
   *
   * Non-indexed output is required by some importers and is what
   * `BufferGeometry.toNonIndexed()` produces after the fact.
   *
   * @default true
   */
  indexed?: boolean;
  /**
   * Emit `uv` texture coordinates.
   *
   * @default true
   */
  uv?: boolean;
  /**
   * Emit vertex `normal` data.
   *
   * @default true
   */
  normals?: boolean;
}

/** Options accepted by every primitive in `geometry/3d/primitives`. */
export interface PrimitiveOptions extends GeometryGeneratorOptions {
  /** Radius of the primitive, where the shape has one. */
  radius?: number;
  /** Height of the primitive, where the shape has one. */
  height?: number;
  /** Diameter alias of {@link PrimitiveOptions.radius} (radius * 2). */
  diameter?: number;
}

/* -------------------------------------------------------------------------- */
/* Polyhedron                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A convex polyhedron described by its vertices and triangular faces.
 *
 * Used by the Platonic-solid generators, which differ only in this table.
 */
export interface PolyhedronDefinition {
  /** Human-readable name (`'tetrahedron'`, `'icosahedron'`, ...). */
  name: string;
  /** Unique vertices; every face indexes into this list. */
  vertices: readonly Vec3[];
  /** Triangular faces as `[a, b, c]` vertex indices, counter-clockwise outward. */
  faces: readonly (readonly [number, number, number])[];
}

/** Options accepted by the polyhedron generators. */
export interface PolyhedronOptions extends GeometryGeneratorOptions {
  /**
   * Subdivision passes applied to each triangular face before projection.
   *
   * `0` keeps the base solid; each pass splits every triangle into four.
   * Subdivided vertices are projected back onto the circumscribed sphere, which
   * turns a Platonic solid into a geodesic approximation.
   *
   * @default 0
   */
  detail?: number;
  /** Explicit circumradius; defaults to the definition's natural radius. */
  radius?: number;
}

/* -------------------------------------------------------------------------- */
/* Tube                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The minimum shape `TubeGeometry` needs from a curve.
 *
 * Structural rather than a concrete `Curve<Vec3>` so a tube can be built from any
 * object that can sample a point and a tangent — including a hand-written
 * callback in tests.
 */
export interface TubePathSource {
  /** Point at the normalised parameter `t` in `[0, 1]`. */
  getPointAt(t: number, target?: Vec3): Vec3;
  /** Unit tangent at the normalised parameter `t` in `[0, 1]`. */
  getTangentAt(t: number, target?: Vec3): Vec3;
}

/** Options accepted by `TubeGeometry`. */
export interface TubeOptions extends GeometryGeneratorOptions {
  /** Samples along the path. */
  tubularSegments?: number;
  /** Vertices around the tube. */
  radialSegments?: number;
  /** Tube radius. */
  radius?: number;
  /** `false` leaves the tube ends open. */
  closed?: boolean;
  /**
   * Compute the Frenet frames from a fixed up vector instead of the curve's
   * derivative of the tangent.
   *
   * `false` (the default) uses the numerically stable parallel-transport frame,
   * which does not flip on an inflection.
   */
  uniformFrames?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Modifiers                                                                  */
/* -------------------------------------------------------------------------- */

/** A structural geometry view the modifiers operate on. */
export interface ModifierGeometryLike {
  /** Attribute name -> attribute. */
  attributes: Record<string, { array: ArrayLike<number>; itemSize: number; count: number }>;
  /** Index buffer, when the geometry is indexed. */
  index?: { array: ArrayLike<number>; count: number } | undefined;
  /** Add or replace an indexed buffer. */
  setIndex(index: ArrayLike<number> | null): unknown;
  /** Add or replace an attribute. */
  setAttribute(name: string, attribute: unknown): unknown;
  /** Extract the geometry as a non-indexed triangle soup. */
  toNonIndexed?(): ModifierGeometryLike;
}

/** Options accepted by `SubdivisionModifier`. */
export interface SubdivisionOptions {
  /** Catmull-Clark passes to apply. */
  iterations?: number;
  /** Blend factor towards the subdivided result, in `[0, 1]`. */
  weight?: number;
  /** Keep the original boundary edges sharp. */
  preserveBoundary?: boolean;
}

/** Options accepted by `SimplifyModifier`. */
export interface SimplifyOptions {
  /** Fraction of vertices to remove, in `[0, 1)`. */
  ratio?: number;
  /** Absolute number of vertices to remove; overrides `ratio`. */
  count?: number;
  /** Refuse to collapse an edge longer than this (world units). */
  maxEdgeLength?: number;
}

/** Options accepted by `TessellateModifier`. */
export interface TessellateOptions {
  /** Maximum edge length after tessellation. */
  maxEdgeLength?: number;
  /** Maximum passes; bounds the vertex explosion. */
  maxIterations?: number;
}

/** Options accepted by `EdgeSplitModifier`. */
export interface EdgeSplitOptions {
  /** Split an edge once its dihedral angle exceeds this, in radians. */
  maxAngle?: number;
  /** Recompute vertex normals after splitting. */
  recomputeNormals?: boolean;
}

/** Options accepted by `MergeModifier`. */
export interface MergeOptions {
  /** Merge tolerance; vertices closer than this collapse into one. */
  tolerance?: number;
  /** Also merge UVs (otherwise UV seams keep vertices apart). */
  mergeUv?: boolean;
  /** Also merge normals. */
  mergeNormals?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Normals and tangents                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How `computeNormals` should treat a shared vertex.
 *
 * - `smooth`: average every incident face normal (default).
 * - `flat`: write the face normal to all three corners, which requires
 *   non-indexed geometry.
 * - `angle`: average only faces whose normal is within `smoothingAngle` of the
 *   reference face.
 */
export type NormalMode = 'smooth' | 'flat' | 'angle';

/** Options accepted by `computeNormals`. */
export interface ComputeNormalsOptions {
  /** Vertex-sharing policy. @default 'smooth' */
  mode?: NormalMode;
  /** Smoothing threshold in radians, used when `mode` is `'angle'`. */
  smoothingAngle?: number;
  /** Overwrite an existing `normal` attribute. @default true */
  overwrite?: boolean;
}

/** Options accepted by `computeTangents`. */
export interface ComputeTangentsOptions {
  /** Rewrite the `w` handedness component from the mirrored UV winding. @default true */
  handedness?: boolean;
  /** UV channel to derive tangents from. @default 'uv' */
  uvAttribute?: string;
  /** Overwrite an existing `tangent` attribute. @default true */
  overwrite?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Wireframe                                                                  */
/* -------------------------------------------------------------------------- */

/** Options accepted by `toWireframe`. */
export interface WireframeOptions {
  /** Emit `LineSegments`-style index pairs (the default) rather than a line strip. */
  segments?: boolean;
  /** Deduplicate shared edges. @default true */
  unique?: boolean;
  /** Keep vertex attributes on the produced geometry. @default true */
  copyAttributes?: boolean;
  /**
   * Drop edges whose two vertices are closer than this.
   *
   * A degenerate edge draws nothing but still occupies a slot in the index buffer,
   * so the default removes them.
   *
   * @default 0
   */
  degenerateThreshold?: number;
  /** Debug name for the produced geometry. */
  name?: string;
}

/* -------------------------------------------------------------------------- */
/* Curves (3D)                                                                */
/* -------------------------------------------------------------------------- */

/** A 3D curve; identical surface to the 2D `Curve` but in three dimensions. */
export type Curve3Like = Curve<Vec3>;

/** A point sampled from a 3D curve together with its arc-length parameter. */
export interface Curve3Sample {
  /** Position on the curve. */
  point: Vec3;
  /** Unit tangent at that position. */
  tangent: Vec3;
  /** Normalised arc-length parameter in `[0, 1]`. */
  u: number;
}

/** Convenience tuple used by callers that build a path from points. */
export type Point3Tuple = readonly [number, number, number];

/** Convenience tuple used by callers that build a path from UVs. */
export type Point2Tuple = readonly [number, number];
