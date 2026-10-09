/**
 * Type vocabulary for the geometry core: attribute layouts, draw ranges,
 * morph targets and the JSON shape produced by `BufferGeometry.toJSON()`.
 *
 * These types never reference runtime values, so they are safe to import from
 * every layer (including the renderer) without pulling geometry code into a
 * bundle.
 *
 * @packageDocumentation
 */

import type { TypedArray } from '../../types';
import type { Vec2 } from '../../math/Vec2';
import type { Vec3 } from '../../math/Vec3';
import type { Color } from '../../math/Color';
import type { BufferAttribute } from './BufferAttribute';
import type { InterleavedBufferAttribute } from './InterleavedBuffer';

/* -------------------------------------------------------------------------- */
/* Attributes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Hint describing how often an attribute's contents change.
 *
 * Mapped by the backend to its native buffer usage:
 *
 * | Value      | WebGL            | WebGPU                 | Meaning                             |
 * | ---------- | ---------------- | ---------------------- | ----------------------------------- |
 * | `static`   | `STATIC_DRAW`    | `GPUBufferUsage` + no  | Uploaded once.                      |
 * | `dynamic`  | `DYNAMIC_DRAW`   | `COPY_DST`             | Rewritten occasionally.             |
 * | `stream`   | `STREAM_DRAW`    | `COPY_DST` + mapping   | Rewritten almost every frame.       |
 */
export type AttributeUsage = 'static' | 'dynamic' | 'stream';

/**
 * Canonical attribute names.
 *
 * The open `(string & {})` arm keeps autocomplete for the well-known names
 * while still accepting engine- and user-defined attributes such as
 * `'aBendFactor'` or `'instanceColor2'`.
 */
export type AttributeName =
  | 'position'
  | 'normal'
  | 'tangent'
  | 'uv'
  | 'uv1'
  | 'uv2'
  | 'uv3'
  | 'color'
  | 'skinIndex'
  | 'skinWeight'
  | 'instanceMatrix'
  | 'instanceColor'
  | 'morphTarget'
  | (string & {});

/**
 * How {@link BufferAttribute.applyMat4} should interpret the attribute's data.
 *
 * - `position`: transform as a point (translation applied, perspective divide).
 * - `normal`: transform by the inverse-transpose of the upper-left 3x3 block so
 *   non-uniform scaling cannot shear the normal away from the surface.
 * - `tangent`: transform the xyz part like a direction (no translation) and
 *   rescale the `w` handedness sign by the sign of the matrix determinant.
 */
export type TransformTarget = 'position' | 'normal' | 'tangent';

/** Element array used by an index buffer and by integer attributes. */
export type IndexArray = Uint16Array | Uint32Array;

/**
 * A `BufferAttribute` or an `InterleavedBufferAttribute`.
 *
 * Both expose the same read/write surface, which is what lets
 * `BufferGeometry.attributes` stay a single homogeneous record.
 */
export type AnyBufferAttribute = BufferAttribute | InterleavedBufferAttribute;

/* -------------------------------------------------------------------------- */
/* Geometry description                                                       */
/* -------------------------------------------------------------------------- */

/** A contiguous run of the index buffer drawn with one material. */
export interface GeometryGroup {
  /** First index (or first vertex, for non-indexed geometry) of the run. */
  start: number;
  /** Number of indices (or vertices) in the run. */
  count: number;
  /** Index into the object's material array; omitted means "material 0". */
  materialIndex?: number;
}

/** The sub-range of the buffers the renderer is allowed to touch. */
export interface DrawRange {
  /** First index/vertex drawn. */
  start: number;
  /** Number of indices/vertices drawn; `Infinity` means "all of them". */
  count: number;
}

/** A named set of attributes holding one morph target's deltas. */
export interface MorphTarget {
  /** Debug name (`'smile'`, `'blink'`, ...). */
  name: string;
  /** Attribute name -> delta attribute (same item size as the base attribute). */
  attributes: Record<string, AnyBufferAttribute>;
  /** Index into the owning geometry's `morphTargetsRelative` interpretation. */
  materialIndex?: number;
}

/** Constructor options accepted by `BufferGeometry`. */
export interface BufferGeometryOptions {
  /** Debug name. */
  name?: string;
  /** Initial attributes, keyed by attribute name. */
  attributes?: Record<string, AnyBufferAttribute>;
  /** Initial index buffer, as an array or a ready-made attribute. */
  index?: ArrayLike<number> | AnyBufferAttribute | null;
  /** Initial draw range; `count` defaults to `Infinity`. */
  drawRange?: DrawRange;
  /** Initial groups. */
  groups?: GeometryGroup[];
  /** Free-form user data carried through serialisation. */
  userData?: Record<string, unknown>;
}

/** Constructor options accepted by `BufferAttribute`. */
export interface BufferAttributeOptions {
  /** Debug name used in diagnostics. */
  name?: string;
  /** Store integer attributes normalised to `[0, 1]` / `[-1, 1]`. */
  normalized?: boolean;
  /** Buffer usage hint. */
  usage?: AttributeUsage;
}

/** Constructor options accepted by `InterleavedBuffer`. */
export interface InterleavedBufferOptions {
  /** Number of components between two consecutive values of the same view. */
  stride: number;
  /** Buffer usage hint. */
  usage?: AttributeUsage;
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                              */
/* -------------------------------------------------------------------------- */

/** JSON form of a `BufferAttribute`. */
export interface AttributeJSON {
  /** Attribute name, when known. */
  name?: string;
  /** Component type name (`'Float32Array'`, ...). */
  arrayType: string;
  /** Flattened element data. */
  array: number[];
  /** Components per element. */
  itemSize: number;
  /** Number of elements. */
  count: number;
  /** `true` when integer data is normalised. */
  normalized: boolean;
  /** Buffer usage hint. */
  usage: AttributeUsage;
}

/** JSON form of an `InterleavedBufferAttribute`. */
export interface InterleavedAttributeJSON extends AttributeJSON {
  /** Distinguishes the interleaved form during deserialisation. */
  interleaved: true;
  /** Components between two elements of this view. */
  stride: number;
  /** Offset of this view inside one stride. */
  offset: number;
}

/** JSON form of a `GeometryGroup`. */
export interface GeometryGroupJSON extends GeometryGroup {}

/** JSON form of a draw range. */
export interface DrawRangeJSON extends DrawRange {}

/**
 * JSON form of a `BufferGeometry`.
 *
 * Round-trips losslessly through `BufferGeometry.fromJSON`.
 */
export interface BufferGeometryJSON {
  /** Serialisation marker; narrowed to `'InstancedBufferGeometry'` by the subclass. */
  type: 'BufferGeometry' | 'InstancedBufferGeometry';
  /** Debug name. */
  name: string;
  /** Attribute name -> serialised attribute. */
  attributes: Record<string, AttributeJSON | InterleavedAttributeJSON>;
  /** Serialised index buffer, or `null` for non-indexed geometry. */
  index: (AttributeJSON & { arrayType: string }) | null;
  /** Serialised groups. */
  groups: GeometryGroupJSON[];
  /** Serialised draw range. */
  drawRange: DrawRangeJSON;
  /** Serialised local bounding box, or `null` when never computed. */
  boundingBox: { min: number[]; max: number[] } | null;
  /** Serialised local bounding sphere, or `null` when never computed. */
  boundingSphere: { center: number[]; radius: number } | null;
  /** Morph target name -> serialised attributes. */
  morphAttributes: Record<string, AttributeJSON[]>;
  /** Free-form user data. */
  userData: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Legacy authoring representation                                            */
/* -------------------------------------------------------------------------- */

/** JSON form of a legacy `Face`. */
export interface FaceJSON {
  /** Vertex indices, `d` is `-1` for triangles. */
  a: number;
  b: number;
  c: number;
  d: number;
  /** Face normal as `[x, y, z]`, or `null` when not authored. */
  normal: number[] | null;
  /** Per-corner normals, or `null`. */
  vertexNormals: number[][] | null;
  /** Face colour as `[r, g, b, a]`, or `null`. */
  color: number[] | null;
  /** Per-corner colours, or `null`. */
  vertexColors: number[][] | null;
  /** Material slot index. */
  materialIndex: number;
}

/**
 * JSON form of a legacy `Geometry`.
 *
 * Round-trips through `Geometry.fromJSON`.
 */
export interface GeometryJSON {
  /** Serialisation marker. */
  type: 'Geometry';
  /** Debug name. */
  name: string;
  /** Flat `[x, y, z, ...]` vertex positions. */
  vertices: number[];
  /** Flat `[r, g, b, ...]` per-vertex colours. */
  colors: number[];
  /** Flat `[x, y, z, ...]` per-vertex normals. */
  normals: number[];
  /** UV channel -> flat `[u, v, ...]` values. */
  uvs: number[][];
  /** Serialised faces. */
  faces: FaceJSON[];
  /** Free-form user data. */
  userData: Record<string, unknown>;
}

/** Convenience alias used by callers that only need positions and uvs. */
export interface VertexUv {
  /** Position. */
  position: Vec3;
  /** Texture coordinate. */
  uv: Vec2;
  /** Optional vertex colour. */
  color?: Color;
}

/** Anything a `BufferAttribute` constructor can take as its data source. */
export type AttributeData = TypedArray | ArrayLike<number>;
