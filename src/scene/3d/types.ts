/**
 * Shared type vocabulary for the 3D scene graph.
 *
 * The renderer, geometry, material and picking layers are written by other
 * agents in parallel with this one. Nothing here imports those modules: every
 * cross-layer dependency is expressed as a **structural interface**
 * ({@link GeometryLike}, {@link MaterialLike}, {@link RaycasterLike}, ...) so
 * the scene graph compiles on its own and stays assignable from the concrete
 * classes once they land. Where a real class already exists (`Vec2`, `Vec3`,
 * `Mat4`, ...) the property types use it directly.
 *
 * @packageDocumentation
 */

import type { EulerOrder } from '../../math/Euler';
import type { Vec3 } from '../../math/Vec3';
import type { Object3D } from './Object3D';
import type { LightColor } from './LightColor';

/* -------------------------------------------------------------------------- */
/* Geometry / material contracts                                              */
/* -------------------------------------------------------------------------- */

/**
 * Structural view of a GPU vertex attribute.
 *
 * `BufferAttribute` is expected to satisfy this shape: a flat `array` of
 * numbers plus an `itemSize` describing how many components belong to one
 * element. Raycasting implementations defined here only ever read `array` and
 * `itemSize`.
 */
export interface AttributeLike {
  /** Flat backing storage; three components per vertex for positions. */
  readonly array: ArrayLike<number>;
  /** Components per element (3 for a position attribute). */
  readonly itemSize: number;
  /** Number of elements, when the attribute reports it. */
  readonly count?: number;
  /** Reads one component; provided by `BufferAttribute`. */
  getX?(index: number): number;
  /** Reads one component; provided by `BufferAttribute`. */
  getY?(index: number): number;
  /** Reads one component; provided by `BufferAttribute`. */
  getZ?(index: number): number;
}

/** Optional bounding sphere used to reject rays early. */
export interface BoundingSphereLike {
  /** Sphere centre. */
  readonly center: { x: number; y: number; z: number };
  /** Sphere radius. */
  readonly radius: number;
}

/**
 * Structural view of a `BufferGeometry`.
 *
 * `position` is the only attribute required by the picking code in this
 * directory. A type alias (rather than an interface) is used so the named
 * attributes can coexist with the attribute dictionary index signature.
 */
export type GeometryLike = {
  /** Dictionary of vertex attributes (`'position'`, `'normal'`, `'uv'`, ...). */
  readonly attributes: Record<string, AttributeLike | undefined>;
  /** Index buffer; a flat sequence of vertex indices when present. */
  readonly index?: AttributeLike | ArrayLike<number> | null;
  /** Position attribute, when named directly. */
  readonly position?: AttributeLike | null;
  /** Cached bounding sphere, when the geometry computed one. */
  readonly boundingSphere?: BoundingSphereLike | null;
  /** Optional display name. */
  readonly name?: string;
  /** Optional draw range. */
  readonly drawRange?: { start: number; count: number };
  /** Recomputes the bounding sphere and returns the geometry. */
  computeBoundingSphere?(): unknown;
  /** Applies a column-major 4x4 matrix to every position. */
  applyMatrix?(m: import('../../math/Mat4').Mat4): unknown;
  /** Releases GPU-side resources; implemented by `BufferGeometry`. */
  dispose?(): void;
};

/** Values accepted wherever a geometry is expected. */
export type GeometryLikeSource = GeometryLike | null | undefined;

/**
 * Structural view of a material.
 *
 * Raycasting cares about visibility and transparency; the renderer needs the
 * rest. Every field is optional so any material class in `src/materials` is
 * assignable without edits here.
 */
export interface MaterialLike {
  /** Skips the material during rendering when `false`. */
  visible?: boolean;
  /** `true` when the material is not fully opaque. */
  transparent?: boolean;
  /** Resolved opacity. */
  opacity?: number;
  /** Opacity combined with `transparent`, exposed by some materials. */
  readonly effectiveOpacity?: number;
  /** Back-face culling hint (`'front'`, `'back'`, `'double'`). */
  side?: string;
  /** Whether the material writes to the depth buffer. */
  depthWrite?: boolean;
  /** Whether the material tests against the depth buffer. */
  depthTest?: boolean;
  /** Render bucket/identifier supplied by the material class. */
  readonly type?: string;
  /** Releases GPU-side resources; implemented by every material. */
  dispose?(): void;
}

/** A single material or an ordered material-per-group array. */
export type MaterialLikeSource = MaterialLike | readonly MaterialLike[] | null | undefined;

/** Structural view of a texture (used by `SpotLight.map`). */
export interface TextureLike {
  /** Source image, kept opaque. */
  readonly image?: unknown;
  /** Releases GPU-side resources; implemented by `Texture`. */
  dispose?(): void;
}

/* -------------------------------------------------------------------------- */
/* Raycasting contracts                                                       */
/* -------------------------------------------------------------------------- */

/** The ray carried by a raycaster. */
export interface RayLike {
  /** Ray origin in world space. */
  readonly origin: Vec3;
  /** Unit direction in world space. */
  readonly direction: Vec3;
}

/**
 * Structural view of the picking layer's raycaster.
 *
 * `Raycaster` lives in `src/picking`, which did not exist when this file was
 * written; declaring the contract here keeps `src/scene` free of that import
 * while still accepting the real instance.
 */
export interface RaycasterLike {
  /** The ray being cast. */
  readonly ray: RayLike;
  /** Near plane distance in world units. */
  readonly near?: number;
  /** Far plane distance in world units. */
  readonly far?: number;
  /** Layer bitmask the raycaster tests against. */
  readonly layers?: number;
  /** Back-face culling flag. */
  readonly params?: {
    /** Hit radius used by `Points` and `Sprite3D`. */
    Points?: { threshold?: number };
    /** Hit radius used by `Line` and `LineSegments`. */
    Line?: { threshold?: number };
    /** `true` to discard back-facing triangles. */
    backfaceCulling?: boolean;
  };
}

/** One ray/object hit. */
export interface Intersection3D<TTarget extends Object3D = Object3D> {
  /** Distance from the ray origin to {@link Intersection3D.point}. */
  distance: number;
  /** Hit position in world space. */
  point: Vec3;
  /** The object that was hit. */
  object: TTarget;
  /** Index of the hit vertex for `Points`. */
  index?: number;
  /** Index of the hit triangle, for meshes. */
  faceIndex?: number;
  /** Index of the hit instance, for `InstancedMesh`. */
  instanceId?: number;
  /** Local-space hit position, when the shape computed one. */
  pointOnLine?: Vec3;
  /** Interpolated UV of the hit, when the geometry supplies `uv`. */
  uv?: Vector2Like;
}

/** An array the raycast implementations append their hits to. */
export type Intersects<TTarget extends Object3D = Object3D> = Intersection3D<TTarget>[];

/* -------------------------------------------------------------------------- */
/* Node configuration                                                         */
/* -------------------------------------------------------------------------- */

/** A `[x, y]` pair or object literal accepted by the 2D-style setters. */
export interface Vector2Like {
  x: number;
  y: number;
}

/** A plain `[x, y, z]`/`{x, y, z}` triple accepted by the setters. */
export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

/** A rotation accepted by the setters: either Euler angles or a quaternion. */
export interface Object3DRotation {
  /** Rotation about X, in radians. */
  x: number;
  /** Rotation about Y, in radians. */
  y: number;
  /** Rotation about Z, in radians. */
  z: number;
  /** Euler order, when the source is an `Euler` triple. */
  order?: string;
}

/** Options accepted by the {@link Object3D} constructor. */
export interface Object3DOptions {
  /** Human-readable name; defaults to `''`. */
  name?: string;
  /** Initial world/local position. */
  position?: Partial<Vector3Like>;
  /** Initial rotation, in radians. */
  rotation?: Partial<Object3DRotation>;
  /** Initial scale. */
  scale?: Partial<Vector3Like>;
  /** `false` freezes the local matrix until {@link Object3D.matrixAutoUpdate} is restored. */
  matrixAutoUpdate?: boolean;
  /** Initial visibility. */
  visible?: boolean;
  /** Initial render order. */
  renderOrder?: number;
  /** Initial layer bitmask. */
  layers?: number;
  /** Whether the node casts shadows. */
  castShadow?: boolean;
  /** Whether the node receives shadows. */
  receiveShadow?: boolean;
  /** Whether the node is frustum culled. */
  frustumCulled?: boolean;
  /** Serialised payload the node carries for the user. */
  userData?: Record<string, unknown>;
}

/** Close-up payload used by `dispose()` and the serialisation helpers. */
export interface Object3DSnapshot {
  /** `'Object3D'`, `'Mesh'`, ... */
  type: string;
  /** Stable identifier. */
  id?: string;
  /** Name at the time of the snapshot. */
  name?: string;
  /** Position of the node. */
  position?: Vector3Like;
  /** Rotation of the node (radians). */
  rotation?: Object3DRotation;
  /** Scale of the node. */
  scale?: Vector3Like;
  /** Child snapshots. */
  children?: Object3DSnapshot[];
}

/** Callback accepted by the traversal helpers. */
export type TraverseCallback<TNode extends Object3D = Object3D> = (node: TNode) => void;

/* -------------------------------------------------------------------------- */
/* Cameras                                                                    */
/* -------------------------------------------------------------------------- */

/** Options accepted by `PerspectiveCamera`. */
export interface PerspectiveCameraOptions extends Object3DOptions {
  /** Vertical field of view, in degrees. */
  fov?: number;
  /** Width divided by height. */
  aspect?: number;
  /** Distance to the near clipping plane. */
  near?: number;
  /** Distance to the far clipping plane. */
  far?: number;
  /** Zoom factor; values above `1` narrow the field of view. */
  zoom?: number;
  /** Distance to the focus plane, used by depth-of-field style effects. */
  focus?: number;
  /** Film gauge in millimetres, used together with `filmOffset`. */
  filmGauge?: number;
  /** Horizontal film offset in millimetres. */
  filmOffset?: number;
}

/** Options accepted by `OrthographicCamera`. */
export interface OrthographicCameraOptions extends Object3DOptions {
  /** Left frustum plane. */
  left?: number;
  /** Right frustum plane. */
  right?: number;
  /** Top frustum plane. */
  top?: number;
  /** Bottom frustum plane. */
  bottom?: number;
  /** Distance to the near clipping plane. */
  near?: number;
  /** Distance to the far clipping plane. */
  far?: number;
  /** Zoom factor. */
  zoom?: number;
}

/** Options accepted by `CubeCamera`. */
export interface CubeCameraOptions extends Object3DOptions {
  /** Distance to the near clipping plane of each face. */
  near?: number;
  /** Distance to the far clipping plane of each face. */
  far?: number;
  /** Render target supplied by the renderer, stored on the camera. */
  renderTarget?: unknown;
}

/** Options accepted by the frustum-style `setViewOffset` helpers. */
export interface ViewOffset {
  /** Width of the full view, in pixels. */
  fullWidth: number;
  /** Height of the full view, in pixels. */
  fullHeight: number;
  /** Horizontal offset of the sub-view. */
  offsetX: number;
  /** Vertical offset of the sub-view. */
  offsetY: number;
  /** Width of the sub-view, in pixels. */
  width: number;
  /** Height of the sub-view, in pixels. */
  height: number;
}

/**
 * Minimal renderer contract required by `CubeCamera.update`.
 *
 * Keeping this structural avoids importing `src/renderer` (which is still being
 * written) and lets any renderer exposing a cube-target render entry point
 * drive the camera.
 */
export interface CubeRenderHost<TCamera = unknown, TScene = unknown, TTarget = unknown> {
  /** Renders one of the six cube faces into the camera's render target. */
  renderToCube(camera: TCamera, scene: TScene, target: TTarget): void;
}

/* -------------------------------------------------------------------------- */
/* Lights                                                                     */
/* -------------------------------------------------------------------------- */

/** Shadow configuration placeholder shared by the lights. */
export interface LightShadowLike {
  /** Whether the shadow map is refreshed this frame. */
  enabled?: boolean;
  /** Resolution of the shadow map, in pixels. */
  mapSize?: { width: number; height: number };
  /** Camera bias applied while sampling the map. */
  bias?: number;
  /** Normal-scaled bias applied while sampling the map. */
  normalBias?: number;
  /** Distance from the light to the shadow camera near plane. */
  near?: number;
  /** Distance from the light to the shadow camera far plane. */
  far?: number;
  /** Releases the shadow map. */
  dispose?(): void;
}

/** Common constructor options for every light. */
export interface LightOptions extends Object3DOptions {
  /** Light colour as a hex integer (`0xffffff`), a CSS string (`'#fff'`) or a record. */
  color?: number | string | LightColor;
  /** Colour multiplier. */
  intensity?: number;
}

/** Options accepted by `DirectionalLight`. */
export interface DirectionalLightOptions extends LightOptions {
  /** Parallel-light target; a fresh `Object3D` is created when omitted. */
  target?: Object3D;
  /** Overrides the default shadow configuration. */
  shadow?: LightShadowLike;
}

/** Options accepted by `PointLight`. */
export interface PointLightOptions extends LightOptions {
  /** Maximum reach of the light; `0` means "no limit". */
  distance?: number;
  /** Physical falloff exponent. */
  decay?: number;
}

/** Options accepted by `SpotLight`. */
export interface SpotLightOptions extends PointLightOptions {
  /** Half-angle of the cone, in radians. */
  angle?: number;
  /** Soft-edge fraction of the cone, in `[0, 1]`. */
  penumbra?: number;
  /** Parallel-light style target; a fresh `Object3D` is created when omitted. */
  target?: Object3D;
  /** Projected texture. */
  map?: TextureLike | null;
  /** Overrides the default shadow configuration. */
  shadow?: LightShadowLike;
}

/** Options accepted by `HemisphereLight`. */
export interface HemisphereLightOptions extends LightOptions {
  /** Colour of the lower hemisphere. */
  groundColor?: number | string;
}

/** Options accepted by `RectAreaLight`. */
export interface RectAreaLightOptions extends LightOptions {
  /** Width of the emissive rectangle. */
  width?: number;
  /** Height of the emissive rectangle. */
  height?: number;
}

/* -------------------------------------------------------------------------- */
/* Skinning                                                                   */
/* -------------------------------------------------------------------------- */

/** Skinning modes supported by `SkinnedMesh.bind`. */
export type BindMode = 'attached' | 'detached';

/** A bone weight set, used by the CPU reference skinning path. */
export interface SkinWeight {
  /** Index of the bone affecting the vertex. */
  index: number;
  /** Normalised influence of that bone, in `[0, 1]`. */
  weight: number;
}

/* -------------------------------------------------------------------------- */
/* Scene options                                                              */
/* -------------------------------------------------------------------------- */

/** Fog descriptor stored on a `Scene3D`. */
export interface FogLike {
  /** Fog colour as a hex integer or CSS string. */
  color: number | string;
  /** Near distance for linear fog / density for exponential fog. */
  near?: number;
  /** Far distance for linear fog. */
  far?: number;
  /** `'linear'`, `'exp2'` or `'none'`. */
  type?: string;
}

/** Options accepted by `Scene3D`. */
export interface Scene3DOptions extends Object3DOptions {
  /** Clear colour: a hex integer, a CSS string, or `null` for "do not clear". */
  background?: number | string | null;
  /** Fog applied to the scene. */
  fog?: FogLike | null;
  /** Number of rendered frames kept on the scene; the renderer owns it. */
  frame?: number;
  /** Environment map hook consumed by the renderer. */
  environment?: unknown;
  /** Exposure multiplier applied to `environment`. */
  environmentIntensity?: number;
  /** Rotation applied to the environment map, in radians (`[x, y, z, order]`). */
  environmentRotation?: [number, number, number, EulerOrder?];
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

/** Options accepted by `InstancedMesh.raycast` when limiting the search. */
export interface InstancedRaycastOptions {
  /** First instance to test; defaults to `0`. */
  start?: number;
  /** Number of instances to test; defaults to `count - start`. */
  count?: number;
}

/** JSON representation produced by {@link Object3D.toJSON}. */
export interface Object3DJson {
  /** Serialisation metadata (`{ version, generator }`). */
  metadata: { version: number; generator: string };
  /** Class name of the serialised node. */
  type: string;
  /** Stable identifier. */
  uuid: string;
  /** Name of the node. */
  name: string;
  /** Column-major local matrix. */
  matrix: number[];
  /** Serialised children, when `recursive` is set. */
  children?: Object3DJson[];
  [key: string]: unknown;
}

/** Version stamped into `Object3DJson.metadata`. */
export const SCENE_JSON_VERSION = 1;

/** Generator name stamped into `Object3DJson.metadata`. */
export const SCENE_JSON_GENERATOR = '@dxyl/graphics';
