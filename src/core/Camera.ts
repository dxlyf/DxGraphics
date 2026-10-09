/**
 * `Camera` — the abstract core camera shared by 2D and 3D cameras.
 *
 * A core camera owns the view matrix and the projection matrices, plus the logic
 * for turning a world point into screen pixels and back. It deliberately knows
 * nothing about perspective vs. orthographic: subclasses call
 * {@link Camera.setProjectionMatrix} after computing their own projection.
 *
 * ```ts
 * const camera = new Camera();
 * camera.setOrthographic(-1, 1, 1, -1, 0.1, 100);
 * camera.setViewportSize(1280, 720);
 * camera.updateMatrixWorld();
 * ```
 *
 * @packageDocumentation
 */

import { Frustum } from '../math/Frustum';
import { Mat4 } from '../math/Mat4';
import { Ray } from '../math/Ray';
import { Vec2 } from '../math/Vec2';
import { Vec3 } from '../math/Vec3';
import { clamp } from '../utils/MathUtils';
import type { CoreEventMap } from './events';
import { Node, type NodeOptions } from './Node';

/** Events emitted by {@link Camera}. */
export interface CameraEvents {
  /** Fired when the projection matrix or viewport changes. */
  projectionchange: [];
  /** Fired when the viewport size changes. */
  viewportchange: [width: number, height: number];
}

/** Effective event map of a {@link Camera}: the shared core map plus camera events. */
export type CameraEventMap = CoreEventMap & CameraEvents;

/** Options accepted by the {@link Camera} constructor. */
export interface CameraOptions extends NodeOptions {
  /** Near clipping distance. */
  near?: number;
  /** Far clipping distance. */
  far?: number;
  /** Viewport width in pixels. */
  width?: number;
  /** Viewport height in pixels. */
  height?: number;
  /** `true` to build an orthographic projection; `false` for perspective. */
  orthographic?: boolean;
}

/**
 * Abstract camera: view + projection state, frustum, and screen-space helpers.
 */
export class Camera extends Node {
  /** Overrides {@link Node.type}. */
  public override get type(): 'Camera3D' | 'Camera2D' {
    return 'Camera3D';
  }

  /** Distance to the near clipping plane. */
  public near: number;

  /** Distance to the far clipping plane. */
  public far: number;

  /** Zoom factor; higher values magnify the scene. */
  public zoom = 1;

  /** Viewport width in pixels. */
  public viewportWidth = 1;

  /** Viewport height in pixels. */
  public viewportHeight = 1;

  /** Projection matrix. */
  public readonly projectionMatrix: Mat4 = new Mat4();

  /** Inverse of {@link projectionMatrix}, refreshed with it. */
  public readonly projectionMatrixInverse: Mat4 = new Mat4();

  /** View matrix: the inverse of {@link Node.matrixWorld}. */
  public readonly matrixWorldInverse: Mat4 = new Mat4();

  /** View-projection matrix, refreshed by {@link Camera.updateFrustum}. */
  public readonly matrixWorldProjection: Mat4 = new Mat4();

  /** Six-plane frustum built from the view-projection matrix. */
  public readonly frustum: Frustum = new Frustum();

  /** `true` when the projection is orthographic; subclasses override. */
  public get isOrthographic(): boolean {
    return false;
  }

  /** `true` to mark this object as a camera for fast type checks. */
  public readonly isCamera = true;

  /** `true` when the projection matrix needs recomputing. */
  protected projectionNeedsUpdate = true;

  /** Creates a camera. */
  constructor(options: CameraOptions = {}) {
    super(options);
    this.near = options.near ?? 0.1;
    this.far = options.far ?? 2000;
    this.viewportWidth = options.width ?? 1;
    this.viewportHeight = options.height ?? 1;
    this.projectionNeedsUpdate = true;
  }

  /* ------------------------------------------------------------ projection */

  /** Aspect ratio of the viewport. */
  public get aspect(): number {
    return this.viewportHeight === 0 ? 1 : this.viewportWidth / this.viewportHeight;
  }

  /**
   * Installs a projection matrix.
   *
   * Subclasses call this from {@link Camera.updateProjectionMatrix}; it keeps the
   * inverse in sync, flags the frustum stale and notifies listeners.
   */
  public setProjectionMatrix(matrix: Mat4): this {
    this.projectionMatrix.copy(matrix);
    this.projectionMatrixInverse.copy(matrix).invert();
    this.projectionNeedsUpdate = false;
    this.emit('projectionchange');
    return this;
  }

  /**
   * Builds an orthographic projection for the current viewport.
   *
   * Provided here because both 2D cameras and 3D orthographic cameras use it.
   */
  public setOrthographic(
    left: number,
    right: number,
    top: number,
    bottom: number,
    near: number = this.near,
    far: number = this.far,
  ): this {
    this.near = near;
    this.far = far;
    return this.setProjectionMatrix(
      Mat4.identity().makeOrthographic(left, right, top, bottom, near, far),
    );
  }

  /**
   * Builds a perspective projection for the current viewport.
   *
   * @param fovYRadians Vertical field of view in radians.
   */
  public setPerspective(fovYRadians: number, near: number = this.near, far: number = this.far, aspect: number = this.aspect): this {
    this.near = near;
    this.far = far;
    return this.setProjectionMatrix(Mat4.identity().makePerspective(fovYRadians, aspect, near, far));
  }

  /** Recomputes the projection matrix. Subclasses override with real maths. */
  public updateProjectionMatrix(): this {
    return this;
  }

  /* -------------------------------------------------------------- viewport */

  /** Sets the viewport size and rebuilds the projection. */
  public setViewportSize(width: number, height: number): this {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this.viewportWidth && nextHeight === this.viewportHeight) return this;
    this.viewportWidth = nextWidth;
    this.viewportHeight = nextHeight;
    this.emit('viewportchange', nextWidth, nextHeight);
    this.updateProjectionMatrix();
    return this;
  }

  /* -------------------------------------------------------------- matrices */

  /**
   * Recomputes the world matrix, the view matrix, the view-projection matrix and
   * the frustum.
   */
  public override updateMatrixWorld(force: boolean = false): this {
    super.updateMatrixWorld(force);
    this.matrixWorldInverse.copy(this.matrixWorld).invert();
    this.matrixWorldProjection.multiplyMatrices(this.projectionMatrix, this.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrixWorldProjection);
    return this;
  }

  /** Alias for {@link Camera.updateMatrixWorld} with an explicit frustum refresh. */
  public updateFrustum(): Frustum {
    this.updateMatrixWorld();
    return this.frustum;
  }

  /* ---------------------------------------------------------- screen space */

  /**
   * Projects a world point into normalised device coordinates (`-1..1`).
   *
   * The `z` component is the depth in NDC, which the picking layer uses for
   * depth comparisons.
   */
  public projectPoint(worldPoint: Vec3, target: Vec3 = new Vec3()): Vec3 {
    return target.copy(worldPoint).applyMat4(this.matrixWorldProjection);
  }

  /**
   * Un-projects a normalised device coordinate into a world point.
   *
   * The composition order matters: `A.multiply(B)` applies `B` first, so the
   * matrix here is `matrixWorld * projectionMatrixInverse` — NDC → camera space
   * (inverse projection), then camera space → world (the camera's world matrix).
   *
   * @param ndc Coordinates in `-1..1` for `x`/`y` and `-1..1` (or `0..1`) for `z`.
   */
  public unprojectPoint(ndc: Vec3, target: Vec3 = new Vec3()): Vec3 {
    return target
      .copy(ndc)
      .applyMat4(
        Camera.scratchUnproject.multiplyMatrices(this.matrixWorld, this.projectionMatrixInverse),
      );
  }

  /**
   * Builds a world-space ray through a viewport pixel.
   *
   * @param x Pixel x, measured from the left edge of the viewport.
   * @param y Pixel y, measured from the **top** edge.
   */
  public screenPointToRay(x: number, y: number, target: Ray = new Ray()): Ray {
    const ndcX = (x / this.viewportWidth) * 2 - 1;
    const ndcY = -((y / this.viewportHeight) * 2 - 1);

    const nearPoint = this.unprojectPoint(Camera.scratchNear.set(ndcX, ndcY, -1));
    const farPoint = this.unprojectPoint(Camera.scratchFar.set(ndcX, ndcY, 1));

    target.origin.copy(nearPoint);
    target.direction.copy(farPoint).sub(nearPoint).normalize();
    return target;
  }

  /**
   * Projects a world point to viewport pixels.
   *
   * @returns `{ x, y, depth }` where `x`/`y` are measured from the top-left and
   *   `depth` is the NDC `z` (`-1` at the near plane). Points behind the camera
   *   are reported with `behind: true`.
   */
  public worldToScreen(
    worldPoint: Vec3,
    target: { x: number; y: number; depth: number; behind: boolean } = { x: 0, y: 0, depth: 0, behind: false },
  ): { x: number; y: number; depth: number; behind: boolean } {
    const ndc = this.projectPoint(worldPoint, Camera.scratchNdc);
    target.x = (ndc.x * 0.5 + 0.5) * this.viewportWidth;
    target.y = (-ndc.y * 0.5 + 0.5) * this.viewportHeight;
    target.depth = ndc.z;
    // A point is "behind" the camera when its view-space z is positive, i.e. it
    // lies behind the eye plane rather than merely outside the depth range.
    const viewZ = Camera.scratchViewZ.copy(worldPoint).applyMat4(this.matrixWorldInverse).z;
    target.behind = viewZ > 0;
    return target;
  }

  /** Viewport pixel measured from the top-left, as a `Vec2`. */
  public worldToScreenVec2(worldPoint: Vec3, target: Vec2 = new Vec2()): Vec2 {
    const ndc = this.projectPoint(worldPoint, Camera.scratchNdc);
    return target.set((ndc.x * 0.5 + 0.5) * this.viewportWidth, (-ndc.y * 0.5 + 0.5) * this.viewportHeight);
  }

  /** Builds the world-space ray through a viewport pixel as a `Ray` value object. */
  public screenPointToWorld(x: number, y: number, depth: number = 0, target: Vec3 = new Vec3()): Vec3 {
    const ndcX = (x / this.viewportWidth) * 2 - 1;
    const ndcY = -((y / this.viewportHeight) * 2 - 1);
    return this.unprojectPoint(Camera.scratchNear.set(ndcX, ndcY, clamp(depth, -1, 1)), target);
  }

  /** Composed view-projection matrix. */
  public getViewProjectionMatrix(target: Mat4 = new Mat4()): Mat4 {
    return target.multiplyMatrices(this.projectionMatrix, this.matrixWorldInverse);
  }

  /** Near/far plane distances as a tuple, ordered for the renderer. */
  public getDepthRange(): [number, number] {
    return [this.near, this.far];
  }

  /** Overrides {@link Node.copy}. */
  public override copy(source: Node, recursive: boolean = true): this {
    super.copy(source, recursive);
    if (source instanceof Camera) {
      this.near = source.near;
      this.far = source.far;
      this.zoom = source.zoom;
      this.viewportWidth = source.viewportWidth;
      this.viewportHeight = source.viewportHeight;
      this.projectionMatrix.copy(source.projectionMatrix);
      this.projectionMatrixInverse.copy(source.projectionMatrixInverse);
    }
    return this;
  }

  /** JSON-friendly representation. */
  public override toJSON(recursive: boolean = true): Record<string, unknown> {
    return {
      ...super.toJSON(recursive),
      type: this.type,
      near: this.near,
      far: this.far,
      zoom: this.zoom,
      viewport: [this.viewportWidth, this.viewportHeight],
      aspect: this.aspect,
      orthographic: this.isOrthographic,
      projectionMatrix: this.projectionMatrix.toArray(),
    };
  }

  /** Scratch objects reused by the projection helpers. */
  private static readonly scratchUnproject = new Mat4();
  private static readonly scratchNear = new Vec3();
  private static readonly scratchFar = new Vec3();
  private static readonly scratchNdc = new Vec3();
  private static readonly scratchViewZ = new Vec3();
}

/** `true` when `value` is a camera. */
export function isCamera(value: unknown): value is Camera {
  return value instanceof Camera;
}

/** `true` when `value` looks like a camera (structural check). */
export function isCameraLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isCamera?: boolean }).isCamera === true
  );
}
