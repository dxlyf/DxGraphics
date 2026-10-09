/**
 * `PerspectiveCamera` - a perspective (pin-hole) projection camera.
 *
 * ```ts
 * const camera = new PerspectiveCamera({ fov: 50, aspect: 16 / 9, near: 0.1, far: 2000 });
 * camera.position.set(0, 0, 5);
 * camera.updateProjectionMatrix();
 * ```
 *
 * The projection matrix targets the OpenGL depth range `[-1, 1]`, which is what
 * WebGL and `Mat4.makePerspective` produce; `updateProjectionMatrix` refreshes
 * {@link Camera3D.projectionMatrixInverse} in the same call.
 *
 * @packageDocumentation
 */

import { DEG2RAD } from '../../constants';
import { Camera3D } from './Camera3D';
import type { Object3D } from './Object3D';
import type { PerspectiveCameraOptions, ViewOffset } from './types';

/** A camera with a frustum defined by a vertical field of view. */
export class PerspectiveCamera extends Camera3D {
  /** Allows consumers to detect the class without an `instanceof` check. */
  public readonly isPerspectiveCamera: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'PerspectiveCamera';

  /** Vertical field of view, in degrees (before {@link PerspectiveCamera.zoom}). */
  public fov: number;

  /** Width divided by height of the target surface. */
  public aspect: number;

  /** Distance to the near clipping plane; always positive. */
  public near: number;

  /** Distance to the far clipping plane; always greater than `near`. */
  public far: number;

  /** Focal-length multiplier; values above `1` narrow the field of view. */
  public zoom: number;

  /** Distance to the focus plane, used by depth-of-field style effects. */
  public focus: number;

  /** Height of the virtual film in millimetres. */
  public filmGauge: number;

  /** Horizontal film offset in millimetres. */
  public filmOffset: number;

  /** Frustum sub-rectangle for tiled/multi-monitor rendering, or `null`. */
  public view: ViewOffset | null = null;

  /** Creates a perspective camera. */
  constructor(options: PerspectiveCameraOptions = {}) {
    super(options);
    this.fov = options.fov ?? 50;
    this.aspect = options.aspect ?? 1;
    this.near = options.near ?? 0.1;
    this.far = options.far ?? 2000;
    this.zoom = options.zoom ?? 1;
    this.focus = options.focus ?? 10;
    this.filmGauge = options.filmGauge ?? 35;
    this.filmOffset = options.filmOffset ?? 0;
    this.updateProjectionMatrix();
  }

  /** Rebuilds the projection matrices from the current parameters. */
  public override updateProjectionMatrix(): void {
    const near = Math.max(this.near, 1e-6);
    const far = Math.max(this.far, near + 1e-6);
    let top = (near * Math.tan(DEG2RAD * 0.5 * this.getEffectiveFOV())) / this.zoom;
    let height = 2 * top;
    let width = this.aspect * height;
    let left = -0.5 * width;

    const view = this.view;
    if (view && view.width > 0 && view.height > 0 && view.fullWidth > 0 && view.fullHeight > 0) {
      const fullWidth = view.fullWidth;
      const fullHeight = view.fullHeight;
      const centerX = view.offsetX + view.width * 0.5;
      const centerY = view.offsetY + view.height * 0.5;
      left = left + (width * (2 * centerX - fullWidth)) / (2 * fullWidth);
      top = top - (height * (2 * centerY - fullHeight)) / (2 * fullHeight);
      width = view.width * (width / fullWidth);
      height = view.height * (height / fullHeight);
    }

    let skew = 0;
    if (this.filmOffset !== 0 && this.filmGauge !== 0) {
      // The film offset is stored in millimetres, which is the same unit the
      // near-plane frustum extents use, so the gauge cancels out here.
      skew = near * this.filmOffset;
    }

    this.projectionMatrix.makePerspectiveOffCenter(
      left,
      left + width,
      top,
      top - height,
      near,
      far,
    );
    if (skew !== 0) this.projectionMatrix.elements[8] = skew;
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }

  /** Field of view actually used: {@link PerspectiveCamera.fov} divided by the zoom. */
  public getEffectiveFOV(): number {
    return (2 * Math.atan(Math.tan((this.fov * DEG2RAD) / 2) / this.zoom)) / DEG2RAD;
  }

  /** Focal length in millimetres implied by the current field of view. */
  public getFocalLength(): number {
    const vExtentSlope = Math.tan(DEG2RAD * 0.5 * this.getEffectiveFOV());
    return (this.filmGauge * 0.5) / vExtentSlope;
  }

  /**
   * Renders a sub-rectangle of a larger view.
   *
   * @param fullWidth Width of the full view, in pixels.
   * @param fullHeight Height of the full view, in pixels.
   * @param x Horizontal offset of the sub-view.
   * @param y Vertical offset of the sub-view.
   * @param width Width of the sub-view.
   * @param height Height of the sub-view.
   */
  public setViewOffset(
    fullWidth: number,
    fullHeight: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): this {
    this.aspect = fullWidth / fullHeight;
    this.view = { fullWidth, fullHeight, offsetX: x, offsetY: y, width, height };
    this.updateProjectionMatrix();
    return this;
  }

  /** Restores the full-frame projection. */
  public clearViewOffset(): this {
    this.view = null;
    this.updateProjectionMatrix();
    return this;
  }

  /** Serialises the camera parameters alongside the node data. */
  public override toJSON(recursive = true): ReturnType<Camera3D['toJSON']> {
    const json = super.toJSON(recursive);
    json.fov = this.fov;
    json.aspect = this.aspect;
    json.near = this.near;
    json.far = this.far;
    json.zoom = this.zoom;
    json.focus = this.focus;
    json.filmGauge = this.filmGauge;
    json.filmOffset = this.filmOffset;
    json.view = this.view;
    return json;
  }

  /** Copies the projection parameters of `source`. */
  public override copy(source: Object3D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof PerspectiveCamera) {
      this.fov = source.fov;
      this.aspect = source.aspect;
      this.near = source.near;
      this.far = source.far;
      this.zoom = source.zoom;
      this.focus = source.focus;
      this.filmGauge = source.filmGauge;
      this.filmOffset = source.filmOffset;
      this.view = source.view ? { ...source.view } : null;
      this.updateProjectionMatrix();
    }
    return this;
  }

  /** Returns a clone of this camera; children are cloned when `recursive` is set. */
  public override clone(recursive = true): PerspectiveCamera {
    return new PerspectiveCamera().copy(this, recursive) as PerspectiveCamera;
  }
}
