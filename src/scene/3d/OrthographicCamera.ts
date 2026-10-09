/**
 * `OrthographicCamera` - a box-frustum camera with no perspective divide.
 *
 * `Camera3D` and `PerspectiveCamera` cover the perspective case; this one is
 * used for isometric content, shadow maps, and 2D-in-3D layers.
 *
 * ```ts
 * const camera = new OrthographicCamera({ left: -4, right: 4, top: 3, bottom: -3 });
 * ```
 *
 * @packageDocumentation
 */

import { Camera3D } from './Camera3D';
import type { Object3D } from './Object3D';
import type { OrthographicCameraOptions, ViewOffset } from './types';

/** A camera whose frustum is an axis-aligned box. */
export class OrthographicCamera extends Camera3D {
  /** Allows consumers to detect the class without an `instanceof` check. */
  public readonly isOrthographicCamera: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'OrthographicCamera';

  /** Left frustum plane, in world units at the near plane. */
  public left: number;

  /** Right frustum plane. */
  public right: number;

  /** Top frustum plane. */
  public top: number;

  /** Bottom frustum plane. */
  public bottom: number;

  /** Distance to the near clipping plane; may be negative. */
  public near: number;

  /** Distance to the far clipping plane. */
  public far: number;

  /** View scale; values above `1` zoom in. */
  public zoom: number;

  /** Frustum sub-rectangle for tiled rendering, or `null`. */
  public view: ViewOffset | null = null;

  /** Creates an orthographic camera; defaults to a `[-1, 1]` box. */
  constructor(options: OrthographicCameraOptions = {}) {
    super(options);
    this.left = options.left ?? -1;
    this.right = options.right ?? 1;
    this.top = options.top ?? 1;
    this.bottom = options.bottom ?? -1;
    this.near = options.near ?? 0.1;
    this.far = options.far ?? 2000;
    this.zoom = options.zoom ?? 1;
    this.updateProjectionMatrix();
  }

  /** Rebuilds the projection matrices from the current parameters. */
  public override updateProjectionMatrix(): void {
    const near = Math.min(this.near, this.far - 1e-6);
    const far = Math.max(this.far, near + 1e-6);
    const dx = (this.right - this.left) / (2 * this.zoom);
    const dy = (this.top - this.bottom) / (2 * this.zoom);
    const cx = (this.right + this.left) / 2;
    const cy = (this.top + this.bottom) / 2;

    let left = cx - dx;
    let right = cx + dx;
    let top = cy + dy;
    let bottom = cy - dy;

    const view = this.view;
    if (view && view.width > 0 && view.height > 0 && view.fullWidth > 0 && view.fullHeight > 0) {
      const scaleW = (right - left) / view.fullWidth / this.zoom;
      const scaleH = (top - bottom) / view.fullHeight / this.zoom;
      const centerX = view.offsetX + view.width * 0.5;
      const centerY = view.offsetY + view.height * 0.5;
      left = cx - dx + scaleW * (view.offsetX - centerX + view.width * 0.5);
      right = left + scaleW * view.width;
      top = cy + dy - scaleH * (view.offsetY - centerY + view.height * 0.5);
      bottom = top - scaleH * view.height;
    }

    this.projectionMatrix.makeOrthographic(left, right, top, bottom, near, far);
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
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
    json.left = this.left;
    json.right = this.right;
    json.top = this.top;
    json.bottom = this.bottom;
    json.near = this.near;
    json.far = this.far;
    json.zoom = this.zoom;
    json.view = this.view;
    return json;
  }

  /** Copies the projection parameters of `source`. */
  public override copy(source: Object3D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof OrthographicCamera) {
      this.left = source.left;
      this.right = source.right;
      this.top = source.top;
      this.bottom = source.bottom;
      this.near = source.near;
      this.far = source.far;
      this.zoom = source.zoom;
      this.view = source.view ? { ...source.view } : null;
      this.updateProjectionMatrix();
    }
    return this;
  }

  /** Returns a clone of this camera; children are cloned when `recursive` is set. */
  public override clone(recursive = true): OrthographicCamera {
    return new OrthographicCamera().copy(this, recursive) as OrthographicCamera;
  }
}
