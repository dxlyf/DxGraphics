/**
 * Top-level geometry vocabulary shared by the `core`, `2d` and `3d` layers.
 *
 * Only cross-layer concepts live here: what a geometry *is*, what options the
 * geometry factories accept, and the memory layout descriptor the backends
 * consume. Layer-specific types stay in `./core/types` and `./2d/types`.
 *
 * @packageDocumentation
 */

import type { TypedArrayConstructor } from '../types';
import type { AttributeUsage } from './core/types';
import type { BufferGeometry } from './core/BufferGeometry';

/* -------------------------------------------------------------------------- */
/* Kinds and sources                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Which representation a geometry object uses.
 *
 * - `buffer` — a `BufferGeometry`, the recommended path for rendering.
 * - `instanced` — an `InstancedBufferGeometry`.
 * - `legacy` — the authorable `Geometry` (vertices + faces).
 * - `path` / `shape` — 2D authoring curves that can be tessellated.
 * - `polygon` / `polyline` — 2D vertex lists with geometric predicates.
 * - `curve` — a standalone 2D curve segment.
 */
export type GeometryKind =
  | 'buffer'
  | 'instanced'
  | 'legacy'
  | 'path'
  | 'shape'
  | 'polygon'
  | 'polyline'
  | 'curve';

/**
 * Anything that can be turned into a `BufferGeometry`.
 *
 * The structural arm is what lets the 2D layer (`Path`, `Shape`, `Polygon`,
 * `Polyline`) feed the renderer without this file importing it: each of those
 * classes exposes a `toBufferGeometry()` method.
 */
export type GeometrySource =
  | BufferGeometry
  | { toBufferGeometry(): BufferGeometry }
  | { getAttribute(name: string): { array: ArrayLike<number>; itemSize: number } | undefined };

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Options accepted by every geometry-producing factory in the library.
 *
 * Each factory reads the subset it understands and ignores the rest, so a
 * single options object can be threaded through a pipeline.
 */
export interface GeometryOptions {
  /** Debug name assigned to the produced geometry. */
  name?: string;
  /** Curve resolution for 2D/3D generators that tessellate arcs. */
  curveSegments?: number;
  /** Buffer usage hint applied to every attribute the factory creates. */
  usage?: AttributeUsage;
  /** Compute the local bounding box and sphere after generation. */
  computeBounds?: boolean;
  /** Compute smooth vertex normals after generation. */
  computeNormals?: boolean;
  /** Free-form data copied onto the produced geometry. */
  userData?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Memory layout                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Structural description of one attribute's memory layout.
 *
 * Backend code uses this to build vertex buffer descriptors without importing
 * `BufferAttribute`, which keeps the renderer free of a geometry dependency.
 *
 * For an interleaved attribute, `stride` is greater than `itemSize` and
 * `offset` places the view inside one stride. For a plain attribute,
 * `stride === itemSize` and `offset === 0`.
 */
export interface AttributeLayout {
  /** Attribute name as bound in the shader. */
  name: string;
  /** Components per element. */
  itemSize: number;
  /** Component type of the backing array. */
  arrayType: TypedArrayConstructor;
  /** Stride between consecutive elements, in array components. */
  stride: number;
  /** Offset of the first component inside the stride. */
  offset: number;
  /** `true` when integer data must be normalised by the shader. */
  normalized: boolean;
  /** Number of elements. */
  count: number;
}
