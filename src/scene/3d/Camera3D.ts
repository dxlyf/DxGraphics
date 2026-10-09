/**
 * `Camera3D` - the abstract base of every 3D camera.
 *
 * A camera is an `Object3D` whose `matrixWorld` acts as the *inverse* view
 * matrix; the renderer composes `projectionMatrix * matrixWorldInverse` to get
 * the matrix it uploads. Subclasses only have to implement
 * {@link Camera3D.updateProjectionMatrix}.
 *
 * @packageDocumentation
 */

import { Frustum } from '../../math/Frustum';
import { Mat4 } from '../../math/Mat4';
import { Object3D } from './Object3D';

/** Base class for perspective, orthographic and cube cameras. */
export abstract class Camera3D extends Object3D {
  /** Allows consumers to detect a camera without an `instanceof` check. */
  public readonly isCamera3D: true = true;

  /** Projects view space (`-Z` forward) into clip space. */
  public readonly projectionMatrix: Mat4 = new Mat4();

  /** Inverse of {@link Camera3D.projectionMatrix}; used by picking. */
  public readonly projectionMatrixInverse: Mat4 = new Mat4();

  /** Inverse of {@link Object3D.matrixWorld}: view space <- world space. */
  public readonly matrixWorldInverse: Mat4 = new Mat4();

  /**
   * Alias of {@link Camera3D.matrixWorldInverse}, for the renderer contract.
   *
   * `CameraLike` in `renderer/interfaces/IRenderer.ts` reads a `viewMatrix`, and both
   * the WebGL backend and the Canvas2D 3D path upload it. Without this alias a
   * `PerspectiveCamera` does not satisfy `CameraLike`, so the renderer silently falls
   * back to its 2D pan/zoom path and the scene is drawn from the wrong place — a
   * failure with no error attached to it.
   *
   * It returns the *same* matrix object rather than a copy, so it stays in sync with
   * {@link Camera3D.updateMatrixWorld} and never allocates in a frame loop. Treat it
   * as read-only: mutate `matrixWorldInverse` (or the camera's transform) instead.
   */
  public get viewMatrix(): Mat4 {
    return this.matrixWorldInverse;
  }

  /** Reusable frustum filled by {@link Camera3D.updateFrustum}. */
  public readonly frustum: Frustum = new Frustum();

  /** Rebuilds {@link Camera3D.projectionMatrix} from the camera parameters. */
  public abstract updateProjectionMatrix(): void;

  /**
   * Refreshes the world matrix, its inverse and the cached {@link Camera3D.frustum}.
   *
   * Refreshing the frustum here, rather than only in {@link Camera3D.updateFrustum}, is
   * what makes `camera.frustum` safe to read after the documented
   * `camera.updateMatrixWorld(true)` call. A `Frustum` starts with every plane at
   * `normal = (0, 0, 1), constant = 0`, and against those planes
   * `distanceToSphere(sphere)` is `-radius`, which is negative for any non-empty
   * volume — so a stale frustum **rejects every object**, i.e. anything that culls
   * through it draws nothing at all. That is a silent failure with no error attached.
   *
   * The cost is one 6-plane extraction per camera per frame, which is what every
   * renderer does anyway on the first frame it uses the camera.
   */
  public override updateMatrixWorld(force = false): void {
    super.updateMatrixWorld(force);
    this.matrixWorldInverse.copy(this.matrixWorld).invert();
    this.updateFrustum();
  }

  /**
   * Rebuilds the cached frustum from {@link Camera3D.projectionMatrix}.
   *
   * Also called by {@link Camera3D.updateMatrixWorld}, so a caller that changes the
   * projection and then reads `frustum` without touching the transform still gets a
   * current frustum. Subclasses overriding `updateProjectionMatrix` should call it
   * once their matrix is ready.
   */
  public updateFrustum(): Frustum {
    this.frustum.setFromProjectionMatrix(
      scratchFrustumMatrix.multiplyMatrices(this.projectionMatrix, this.matrixWorldInverse),
    );
    return this.frustum;
  }

  /** `true` for nodes that look down `-Z`; cameras always do. */
  protected override isCameraLike(): boolean {
    return true;
  }

  /** Copies the camera state of `source`, including both projection matrices. */
  public override copy(source: Object3D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof Camera3D) {
      this.projectionMatrix.copy(source.projectionMatrix);
      this.projectionMatrixInverse.copy(source.projectionMatrixInverse);
      this.matrixWorldInverse.copy(source.matrixWorldInverse);
    }
    return this;
  }
}

/** Scratch matrix used when composing the frustum. */
const scratchFrustumMatrix = new Mat4();
