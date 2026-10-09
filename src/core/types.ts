/**
 * Shared types for the core layer.
 *
 * These describe the contracts that `Node`, `Scene`, `Camera`, `Layer` and the
 * renderable/updateable mixins agree on. Keeping them in one file means the
 * renderer and scene layers can import the shape of a node without importing the
 * node implementation.
 *
 * @packageDocumentation
 */

import type { Box3 } from '../math/Box3';
import type { Mat4 } from '../math/Mat4';
import type { Plane } from '../math/Plane';
import type { Sphere } from '../math/Sphere';
import type { Vec3 } from '../math/Vec3';

/** Monotonic frame counter plus wall-clock timing for one update. */
export interface FrameInfo {
  /** Zero-based index of the current frame. */
  frame: number;
  /** Seconds since the previous frame, clamped by `Clock`. */
  delta: number;
  /** Seconds since the render loop started. */
  elapsed: number;
  /** `performance.now()`-style timestamp. */
  timestamp: number;
  /** Smoothed frame rate, in frames per second. */
  fps: number;
}

/** Every kind of object a scene graph can contain. */
export type NodeType =
  | 'Node'
  | 'Node2D'
  | 'Scene2D'
  | 'Layer2D'
  | 'Group2D'
  | 'Sprite'
  | 'Text2D'
  | 'Shape2D'
  | 'Path2DObject'
  | 'Mesh2D'
  | 'Particle2D'
  | 'Camera2D'
  | 'Light2D'
  | 'Object3D'
  | 'Scene3D'
  | 'Group3D'
  | 'Mesh'
  | 'InstancedMesh'
  | 'SkinnedMesh'
  | 'Points'
  | 'Line'
  | 'LineSegments'
  | 'Sprite3D'
  | 'Camera3D'
  | 'PerspectiveCamera'
  | 'OrthographicCamera'
  | 'CubeCamera'
  | 'Light'
  | 'AmbientLight'
  | 'DirectionalLight'
  | 'PointLight'
  | 'SpotLight'
  | 'HemisphereLight'
  | 'RectAreaLight'
  | 'Bone'
  | 'Skeleton';

/** A bitmask of layers; objects and cameras must share at least one bit. */
export type LayerMask = number;

/** Per-node user data bag. */
export type UserData = Record<string, unknown>;

/** Anything with a world matrix that can take part in a traversal. */
export interface TransformNode {
  readonly matrixWorld: Mat4;
  visible: boolean;
  parent: TransformNode | null;
}

/** A node that can be updated every frame. */
export interface Updateable {
  /** Called once per frame while the node is active. */
  update(delta: number, frame?: FrameInfo): void;
  /** Optional late update, run after every `update`. */
  lateUpdate?(delta: number, frame?: FrameInfo): void;
}

/** A node that can be drawn. */
export interface Renderable {
  /** Draw order hint; higher values draw later. */
  renderOrder: number;
  /** Set to `false` to skip the node without removing it. */
  visible: boolean;
}

/** A node that participates in hit testing. */
export interface Raycastable {
  /** Appends every intersection with `ray` to `intersects`. */
  raycast(ray: RayLike, intersects: BoundsIntersection[]): void;
}

/** A record appended by {@link Raycastable.raycast}. */
export interface BoundsIntersection<TTarget = unknown> {
  distance: number;
  point: Vec3;
  object: TTarget;
  faceIndex?: number;
  instanceId?: number;
}

/** A ray with an origin, a unit direction and an optional world-space tolerance. */
export interface RayLike {
  origin: Vec3;
  direction: Vec3;
  near?: number;
  far?: number;
}

/** Anything carrying a bounding sphere/box for culling. */
export interface Bounded {
  /** Bounding sphere in world space; `null` when not computed yet. */
  boundingSphere: Sphere | null;
  /** Bounding box in world space; `null` when not computed yet. */
  boundingBox: Box3 | null;
  /** Cached world-space radius used by quick reject tests. */
  boundingRadius: number;
}

/** Frustum culling inputs, kept structural so `renderer` need not import `math`. */
export interface Cullable {
  /** `true` to let the renderer skip this node when outside the frustum. */
  frustumCulled: boolean;
}

/** Axis-aligned plane identifiers used by shadow/light code. */
export type WorldAxis = 'x' | 'y' | 'z';

/** A camera's projection description, shared by 2D and 3D cameras. */
export interface ProjectionInfo {
  /** Projection matrix for the current viewport. */
  projectionMatrix: Mat4;
  /** Inverse of {@link ProjectionInfo.projectionMatrix}. */
  projectionMatrixInverse: Mat4;
  /** View matrix (inverse world matrix of the camera). */
  matrixWorldInverse: Mat4;
  /** `true` when the camera uses an orthographic projection. */
  isOrthographic: boolean;
}

/** A scene background: a colour, a texture or nothing. */
export type SceneBackground = { r: number; g: number; b: number; a?: number } | unknown | null;

/** Fog description consumed by materials that support it. */
export interface FogLike {
  /** `'linear'`, `'exponential'` or `'none'`. */
  type: string;
  /** Colour of the fog. */
  color: { r: number; g: number; b: number };
  /** Near distance for linear fog. */
  near: number;
  /** Far distance for linear fog. */
  far: number;
  /** Density for exponential fog. */
  density: number;
  /** `true` when the fog is disabled. */
  disabled: boolean;
}

/** A clipping plane attached to a renderer or material. */
export interface ClippingPlane {
  plane: Plane;
  /** How the plane combines with the existing clip volume. */
  type?: 'intersection' | 'union';
}

/** Statistics a scene reports about its own contents. */
export interface SceneStatistics {
  objects: number;
  meshes: number;
  lights: number;
  cameras: number;
  triangles: number;
  estimatedDrawCalls: number;
}

/** Reasons a node can be skipped during rendering. */
export enum CullReason {
  /** The node was drawn. */
  None = 'none',
  /** `visible === false`. */
  Invisible = 'invisible',
  /** Outside the camera frustum. */
  FrustumCulled = 'frustum-culled',
  /** Layer mask does not intersect the camera's. */
  LayerMismatch = 'layer-mismatch',
  /** The node's material is not ready. */
  MaterialNotReady = 'material-not-ready',
}

/** Result of asking a scene whether a node should be drawn. */
export interface CullResult {
  visible: boolean;
  reason: CullReason;
}
