/**
 * Shared type vocabulary for the picking subsystem.
 *
 * Picking spans four quite different problems — world-space ray casting, GPU
 * readback, 2D tree hit testing and billboard tests — so the vocabulary is grouped
 * by problem rather than by class.
 *
 * Everything here is expressed as **structural interfaces** over
 * `{ position, index, attributes }`, `{ children, visible, name }` and
 * `{ x, y, z }`, which keeps `src/picking` independent of `src/scene` and
 * `src/geometry` (both written by other agents) while remaining assignable from
 * the concrete classes.
 *
 * @packageDocumentation
 */

import type { Vec2 } from '../math/Vec2';
import type { Vec3 } from '../math/Vec3';

/* -------------------------------------------------------------------------- */
/* Geometry contracts                                                         */
/* -------------------------------------------------------------------------- */

/** Structural view of a vertex attribute. */
export interface AttributeLike {
  /** Flat backing storage. */
  readonly array: ArrayLike<number>;
  /** Components per element. */
  readonly itemSize: number;
  /** Number of elements. */
  readonly count?: number;
  /** Reads the X component of `index`. */
  getX?(index: number): number;
  /** Reads the Y component of `index`. */
  getY?(index: number): number;
  /** Reads the Z component of `index`. */
  getZ?(index: number): number;
}

/**
 * Structural view of a `BufferGeometry`.
 *
 * `position` is required by every picker; `index` decides whether the geometry is
 * treated as indexed or as a triangle soup.
 */
export interface GeometryLike {
  /** Attribute dictionary (`'position'`, `'normal'`, `'uv'`, ...). */
  readonly attributes: Record<string, AttributeLike | undefined>;
  /** Index buffer, as an attribute or a bare array. */
  readonly index?: AttributeLike | ArrayLike<number> | null;
  /** Position attribute, when named directly. */
  readonly position?: AttributeLike | null;
  /** Name, used only in diagnostics. */
  readonly name?: string;
  /** Draw range, honoured by the pickers. */
  readonly drawRange?: { start: number; count: number };
  /** Groups, honoured by `MeshPicker` when a per-group material is used. */
  readonly groups?: readonly { start: number; count: number; materialIndex?: number }[];
}

/** Structural view of a pickable 3D object. */
export interface Object3DLike {
  /** Human-readable name. */
  name?: string;
  /** `false` removes the object (and its subtree) from consideration. */
  visible?: boolean;
  /** Layer bitmask; a raycaster with `layers` set only considers overlapping bits. */
  layers?: number;
  /** Local transform. */
  matrixWorld?: { elements: ArrayLike<number> };
  /** Children, for recursive traversal. */
  children?: readonly Object3DLike[];
  /** Geometry, for meshes and lines. */
  geometry?: GeometryLike | null;
  /** Material, used for visibility and for `MeshPicker`'s side handling. */
  material?: MaterialLike | readonly MaterialLike[] | null;
  /** Hit radius used by point-cloud objects. */
  threshold?: number;
  /** Discriminating flags the concrete classes set. */
  readonly isMesh?: boolean;
  /** `true` for `Line` and `LineSegments`. */
  readonly isLine?: boolean;
  /** `true` for line strips. */
  readonly isLineSegments?: boolean;
  /** `true` for `Points`. */
  readonly isPoints?: boolean;
  /** `true` for `Sprite3D`. */
  readonly isSprite3D?: boolean;
  /** The object's own raycast, when it implements one. */
  raycast?(raycaster: RaycasterLike, intersects: IntersectionLike[]): void;
}

/** Structural view of a material, for visibility and side handling. */
export interface MaterialLike {
  /** `false` skips the object. */
  visible?: boolean;
  /** `true` when the material is not fully opaque. */
  transparent?: boolean;
  /** Resolved opacity in `[0, 1]`. */
  opacity?: number;
  /** `'front'`, `'back'` or `'double'`. */
  side?: string;
}

/** Structural view of a camera, as `Raycaster.setFromCamera` needs it. */
export interface CameraLike {
  /** World matrix. */
  matrixWorld?: { elements: ArrayLike<number> };
  /** Inverse world matrix, used for unprojection. */
  matrixWorldInverse?: { elements: ArrayLike<number> };
  /** Projection matrix. */
  projectionMatrix?: { elements: ArrayLike<number> };
  /** Inverse projection matrix. */
  projectionMatrixInverse?: { elements: ArrayLike<number> };
  /** Near plane distance. */
  near?: number;
  /** Far plane distance. */
  far?: number;
  /** `true` when the camera is orthographic. */
  readonly isOrthographic?: boolean;
  /** Un-projects an NDC point into world space; preferred when present. */
  unprojectPoint?(ndc: Vec3, target?: Vec3): Vec3;
  /** Builds a world-space ray through a viewport pixel. */
  screenPointToRay?(x: number, y: number, target?: unknown): unknown;
}

/** One ray/object intersection, three.js compatible. */
export interface IntersectionLike<TTarget = unknown> {
  /** Distance along the ray. */
  distance: number;
  /** World-space hit point. */
  point: Vec3;
  /** The object that was hit. */
  object: TTarget;
  /** Index of the hit triangle, when applicable. */
  faceIndex?: number;
  /** Interpolated UV at the hit point. */
  uv?: Vec2;
  /** Barycentric coordinates within the hit triangle. */
  barycoord?: [number, number, number];
  /** Instance index for instanced draws. */
  instanceId?: number;
  /** Interpolated or geometric normal. */
  normal?: Vec3;
  /** Which layer bit matched. */
  layer?: number;
  /** Which primitive produced the hit. */
  type?: 'mesh' | 'line' | 'points' | 'sprite' | 'bounds' | 'custom';
  /** Extra payload for custom pickers. */
  userData?: Record<string, unknown>;
}

/**
 * The raycaster contract the scene graph already expects.
 *
 * `scene/3d/types.ts` declares an identical structure; matching it here is what
 * lets `Mesh.raycast(raycaster, intersects)` accept a real {@link Raycaster}
 * without either module importing the other.
 */
export interface RaycasterLike {
  /** The ray being cast. */
  readonly ray: { origin: Vec3; direction: Vec3 };
  /** Near distance. */
  readonly near?: number;
  /** Far distance. */
  readonly far?: number;
  /** Layer bitmask, or `undefined` to accept every layer. */
  readonly layers?: number;
  /** Tunables read by the geometry-specific raycast implementations. */
  readonly params?: PickThresholds & { backfaceCulling?: boolean };
}

/** Per-primitive hit radii, in world units. */
export interface PickThresholds {
  /** Hit radius for `Mesh` hits; `0` means "exact triangle hit only". */
  Mesh?: { threshold?: number };
  /** Hit radius for `Line`/`LineSegments` hits. */
  Line?: { threshold?: number };
  /** Hit radius for `Points` hits. */
  Points?: { threshold?: number };
  /** Hit radius for `Sprite3D` hits. */
  Sprite?: { threshold?: number };
}

/* -------------------------------------------------------------------------- */
/* Raycaster options                                                          */
/* -------------------------------------------------------------------------- */

/** Options accepted by the {@link import('./Raycaster').Raycaster} constructor. */
export interface RaycasterOptions {
  /** Origin, when the raycaster is not built from a camera. */
  origin?: Vec3;
  /** Unit direction. */
  direction?: Vec3;
  /** Near distance; defaults to `0`. */
  near?: number;
  /** Far distance; defaults to `Infinity`. */
  far?: number;
  /** Layer bitmask; `undefined` accepts every layer. */
  layers?: number;
  /** Per-primitive hit radii. */
  params?: PickThresholds & { backfaceCulling?: boolean };
  /** Maximum hits returned by `intersectObjects`; defaults to
   * `DEFAULT_MAX_PICK_RESULTS`. */
  maxResults?: number;
  /** Discard back-facing triangles. */
  backfaceCulling?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Mesh picking                                                               */
/* -------------------------------------------------------------------------- */

/** Result of a single ray/triangle test. */
export interface TriangleHit {
  /** Distance along the ray. */
  distance: number;
  /** Hit point in the triangle's own space. */
  point: Vec3;
  /** Barycentric coordinates `(u, v, w)` weighting `a`, `b`, `c`. */
  barycoord: [number, number, number];
  /** Interpolated UV, present when the caller supplied per-vertex UVs. */
  uv?: Vec2;
}

/** Options accepted by {@link import('./MeshPicker').MeshPicker.pick}. */
export interface MeshPickOptions {
  /** Interpolate UVs; on by default when a `uv` attribute exists. */
  uv?: boolean;
  /** Interpolate normals. */
  normals?: boolean;
  /** Discard back-facing triangles; defaults to `false`. */
  backfaceCulling?: boolean;
  /** Only test this material group index. */
  materialIndex?: number;
  /** Skip the bounding-sphere pre-test. */
  skipBounds?: boolean;
}

/* -------------------------------------------------------------------------- */
/* 2D hit testing                                                             */
/* -------------------------------------------------------------------------- */

/** Structural view of a 2D node. */
export interface Node2DLike {
  /** Stable identifier. */
  readonly id?: string;
  /** Human-readable name. */
  name?: string;
  /** `false` removes the node and its subtree from consideration. */
  visible?: boolean;
  /** `false` skips the node but still tests its children. */
  interactive?: boolean;
  /** Draw order; higher is on top and is tested first. */
  zIndex?: number;
  /** Node opacity in `[0, 1]`. */
  alpha?: number;
  /** Accumulated world opacity, when the node maintains one. */
  worldAlpha?: number;
  /** Children. */
  children?: readonly Node2DLike[];
  /** Parent, used for world-space conversion. */
  parent?: Node2DLike | null;
  /** Local-space hit test; the preferred contract. */
  hitTest?(point: Vec2, options?: HitTestOptions): Node2DLike | null;
  /** `true` when the node contains `point` in local space. */
  containsPoint?(point: Vec2, tolerance?: number, includeChildren?: boolean): boolean;
  /** Converts a world point into the node's local space. */
  worldToLocal?(point: Vec2, target?: Vec2): Vec2;
  /** Converts a local point into world space. */
  localToWorld?(point: Vec2, target?: Vec2): Vec2;
  /** World-space bounds, when the node caches one. */
  getWorldBounds?(target?: unknown): { x: number; y: number; width: number; height: number } | null;
  /** Local bounds. */
  getBounds?(target?: unknown): { x: number; y: number; width: number; height: number } | null;
}

/** Options accepted by a 2D hit test. */
export interface HitTestOptions {
  /** Extra world-space slack around the node. */
  tolerance?: number;
  /** Convert `point` from the query's space into each node's local space; defaults to `true`. */
  worldSpace?: boolean;
  /** Keep descending past the first hit to collect every overlapping node. */
  all?: boolean;
  /** Skip nodes whose accumulated alpha is below this value. */
  minAlpha?: number;
  /** Treat `interactive === false` nodes as interactive. */
  ignoreInteractive?: boolean;
  /** Only consider nodes at or above this accumulated z-order. */
  minZIndex?: number;
  /** Maximum number of hits returned when `all` is set. */
  limit?: number;
}

/** One ray/volume intersection, produced by `BoundingBoxPicker`. */
export interface BoundsIntersection<TTarget = unknown> extends IntersectionLike<TTarget> {
  /** Discriminator marking this as a bounds-only hit. */
  type: 'bounds';
}

/**
 * A ray accepted by the standalone pickers.
 *
 * Its own type rather than a `Ray` so a caller can pass a plain object; `Ray`
 * satisfies it structurally.
 */
export interface PickRay {
  /** Origin in world space. */
  origin: Vec3;
  /** Unit direction. */
  direction: Vec3;
  /** Minimum distance; defaults to `0`. */
  near?: number;
  /** Maximum distance; defaults to `Infinity`. */
  far?: number;
}

/* -------------------------------------------------------------------------- */
/* GPU picking                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Bit budget of an RGBA8 picking id.
 *
 * The id is written as four 8-bit channels, giving 32 usable bits. One bit is
 * reserved, so ids must satisfy `0 <= id < 2^31`; {@link import('./GPUPicking').GPUPicking}
 * rejects anything larger with a descriptive error rather than silently truncating.
 *
 * Channel layout, as written by the picking shader and read back as bytes:
 *
 * ```
 * R = (id >>>  0) & 0xff
 * G = (id >>>  8) & 0xff
 * B = (id >>> 16) & 0xff
 * A = (id >>> 24) & 0x7f   // high bit unused, keeps the alpha channel opaque-ish
 * ```
 */
export interface PickingIdBitBudget {
  /** Bytes per id. */
  readonly bytes: 4;
  /** Usable bits per id. */
  readonly bits: 31;
  /** Largest encodable id (`2^31 - 1`). */
  readonly maxId: 2147483647;
}

/** The single shared bit-budget description. */
export const PICKING_ID_BUDGET: PickingIdBitBudget = {
  bytes: 4,
  bits: 31,
  maxId: 2147483647,
};

/** Structural view of the renderer `GPUPicking` needs. */
export interface PickingRendererLike {
  /** Creates an off-screen target. */
  createRenderTarget?(options: Record<string, unknown>): unknown;
  /** Releases an off-screen target. */
  destroyRenderTarget?(target: unknown): void;
  /** Binds a target, or `null` for the canvas. */
  setRenderTarget?(target: unknown): void;
  /** Clears the bound target. */
  clear?(options?: unknown): void;
  /** Renders `scene` with `camera` using `overrideMaterial`, if supported. */
  render?(scene: unknown, camera: unknown, overrideMaterial?: unknown): void;
  /** Reads a pixel from the bound target. */
  readPixel?(x: number, y: number): Uint8ClampedArray | number[] | null;
  /** Reads a pixel from a specific target. */
  readPixels?(x: number, y: number, width?: number, height?: number): Uint8ClampedArray | null;
}

/** Result of a GPU pick. */
export interface GPUPickResultLike<TTarget = unknown> {
  /** Decoded id; `0` means "nothing was drawn at that pixel". */
  id: number;
  /** The registered object, when the id is known. */
  object?: TTarget;
  /** Sampled pixel X. */
  x: number;
  /** Sampled pixel Y. */
  y: number;
  /** Raw RGBA bytes at the sampled pixel. */
  color: [number, number, number, number];
}

/** Options accepted by {@link import('./GPUPicking').GPUPicking}. */
export interface GPUPickingOptions {
  /** Target width in device pixels. */
  width?: number;
  /** Target height in device pixels. */
  height?: number;
  /** Device-pixel ratio applied to logical coordinates; defaults to `1`. */
  pixelRatio?: number;
  /** Renderer used for the picking pass. */
  renderer?: PickingRendererLike | null;
  /** Material drawn with the picking id; supplied by the caller. */
  overrideMaterial?: unknown;
  /** Clear colour packed from id `0`; defaults to fully transparent black. */
  clearColor?: [number, number, number, number];
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

/** Options accepted by `BoundingBoxPicker`. */
export interface BoundingBoxPickOptions {
  /** Extra world-space slack added to every box before the test. */
  tolerance?: number;
  /** Test spheres instead of boxes; cheaper and more conservative. */
  useSphere?: boolean;
}

/** Options accepted by `SpritePicker`. */
export interface SpritePickOptions {
  /** Hit radius in world units added to the billboard quad. */
  threshold?: number;
  /** Ignore the billboard's own rotation and test an axis-aligned quad. */
  ignoreRotation?: boolean;
}
