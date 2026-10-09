/**
 * `Camera2D` - an orthographic camera for 2D scenes.
 *
 * The camera describes a rectangular window onto the scene. Unlike a 3D camera it
 * keeps the window in *design units* and resolves it against a viewport size,
 * which is what a 2D layout system needs: `zoom` scales the world, `viewport`
 * changes the visible extent, and the anchor pins the camera origin to a corner or
 * to the centre of that window.
 *
 * ```ts
 * const camera = new Camera2D({ viewport: new Vec2(1280, 720), zoom: 2 });
 * camera.moveTo(400, 300);
 * camera.updateProjectionMatrix();
 * ```
 *
 * @packageDocumentation
 */

import { Mat4 } from '../../math/Mat4';
import { Rect } from '../../math/Rect';
import { Vec2 } from '../../math/Vec2';
import { Node2D } from './Node2D';
import type { Node2DOptions } from './types';

/** Where the camera's origin sits inside the viewport. */
export type CameraAnchor2D =
  | 'topLeft'
  | 'top'
  | 'topRight'
  | 'left'
  | 'center'
  | 'right'
  | 'bottomLeft'
  | 'bottom'
  | 'bottomRight';

/** Options accepted by the {@link Camera2D} constructor. */
export interface Camera2DOptions extends Node2DOptions {
  /** Viewport size in device pixels. */
  viewport?: Vec2;
  /** View scale; values above `1` zoom in. */
  zoom?: number;
  /** Rotation of the camera, in radians. */
  cameraRotation?: number;
  /** Where the camera origin sits inside the viewport. */
  anchor?: CameraAnchor2D;
}

/** An orthographic 2D camera. */
export class Camera2D extends Node2D {
  /** Allows consumers to detect a camera without an `instanceof` check. */
  public readonly isCamera2D: true = true;

  /** Class name used by serialisation and the backend's dispatch. */
  public override readonly type: string = 'Camera2D';

  /** Viewport size, in device pixels. */
  public readonly viewport: Vec2;

  /** View scale. */
  public zoomValue: number;

  /** Camera rotation, in radians. */
  public cameraRotation: number;

  /** Where the camera origin sits inside the viewport. */
  public anchor: CameraAnchor2D;

  /**
   * Rectangle of world space the camera sees.
   *
   * Refreshed by {@link Camera2D.updateProjectionMatrix}.
   */
  public readonly worldView: Rect = new Rect();

  /** Projects world space into clip space, rotation included. */
  public readonly projectionMatrix: Mat4 = new Mat4();

  /** Inverse of {@link Camera2D.projectionMatrix}. */
  public readonly projectionMatrixInverse: Mat4 = new Mat4();

  /** Creates a camera. */
  constructor(options: Camera2DOptions = {}) {
    super(options);
    this.viewport = options.viewport ? options.viewport.clone() : new Vec2(1, 1);
    this.zoomValue = options.zoom ?? 1;
    this.cameraRotation = options.cameraRotation ?? 0;
    this.anchor = options.anchor ?? 'topLeft';
    this.updateProjectionMatrix();
  }

  /** View scale; setting it recomputes the projection. */
  public get zoom(): number {
    return this.zoomValue;
  }

  public set zoom(value: number) {
    if (this.zoomValue === value) return;
    this.zoomValue = value;
    this.updateProjectionMatrix();
  }

  /** Resizes the viewport and recomputes the projection. */
  public setViewport(width: number, height: number): this {
    this.viewport.set(width, height);
    this.updateProjectionMatrix();
    return this;
  }

  /** Moves the camera so `(x, y)` appears at the anchor point of the viewport. */
  public moveTo(x: number, y: number): this {
    this.x = x;
    this.y = y;
    this.updateProjectionMatrix();
    return this;
  }

  /** Sets the camera rotation, in radians. */
  public setRotation(radians: number): this {
    this.cameraRotation = radians;
    this.updateProjectionMatrix();
    return this;
  }

  /** Rotates the camera by `radians`. */
  public rotateCamera(radians: number): this {
    return this.setRotation(this.cameraRotation + radians);
  }

  /**
   * Rebuilds {@link Camera2D.projectionMatrix} and {@link Camera2D.worldView}.
   *
   * The projection maps the camera's world rectangle onto `[-1, 1]` in both axes.
   * Because the 2D scene convention puts the origin at the top-left with `+Y`
   * pointing down, the second row is negative.
   */
  public updateProjectionMatrix(): void {
    const width = Math.max(this.viewport.x, 1e-6);
    const height = Math.max(this.viewport.y, 1e-6);
    const zoom = this.zoomValue === 0 ? 1e-6 : this.zoomValue;
    const anchor = anchorFactors(this.anchor);

    const viewWidth = width / zoom;
    const viewHeight = height / zoom;
    const left = this.x - viewWidth * anchor.x;
    const top = this.y - viewHeight * anchor.y;
    this.worldView.set(left, top, viewWidth, viewHeight);

    const scaleX = (2 * zoom) / width;
    const scaleY = (-2 * zoom) / height;
    this.projectionMatrix.set(
      scaleX,
      0,
      0,
      0,
      0,
      scaleY,
      0,
      0,
      0,
      0,
      1,
      0,
      -scaleX * left - 1,
      -scaleY * top + 1,
      0,
      1,
    );

    if (this.cameraRotation !== 0) {
      rotationMatrix.makeRotationZ(this.cameraRotation);
      this.projectionMatrix.multiply(rotationMatrix);
    }

    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }

  /**
   * Converts a viewport pixel into world units.
   *
   * @param point Pixel coordinates, with the origin at the viewport's top-left.
   * @param target Receives the result; a new `Vec2` is allocated when omitted.
   */
  public screenToWorld(point: Vec2, target: Vec2 = new Vec2()): Vec2 {
    const zoom = this.zoomValue === 0 ? 1e-6 : this.zoomValue;
    let px = point.x;
    let py = point.y;
    if (this.cameraRotation !== 0) {
      // Undo the camera rotation about the viewport centre.
      const cos = Math.cos(-this.cameraRotation);
      const sin = Math.sin(-this.cameraRotation);
      const rotated = rotate2D(px, py, cos, sin);
      px = rotated.x;
      py = rotated.y;
    }
    return target.set(this.worldView.left + px / zoom, this.worldView.top + py / zoom);
  }

  /**
   * Converts a world point into viewport pixels.
   *
   * @param point Point in world units.
   * @param target Receives the result; a new `Vec2` is allocated when omitted.
   */
  public worldToScreen(point: Vec2, target: Vec2 = new Vec2()): Vec2 {
    const zoom = this.zoomValue === 0 ? 1e-6 : this.zoomValue;
    const px = (point.x - this.worldView.left) * zoom;
    const py = (point.y - this.worldView.top) * zoom;
    if (this.cameraRotation === 0) return target.set(px, py);
    const cos = Math.cos(this.cameraRotation);
    const sin = Math.sin(this.cameraRotation);
    const rotated = rotate2D(px, py, cos, sin);
    return target.set(rotated.x, rotated.y);
  }

  /** `true` when `point` (world space) lies inside the camera's view rectangle. */
  public containsWorldPoint(point: Vec2): boolean {
    return this.worldView.contains(point);
  }

  /** Copies the camera state of `source`. */
  public override copy(source: Node2D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof Camera2D) {
      this.viewport.copy(source.viewport);
      this.zoomValue = source.zoomValue;
      this.cameraRotation = source.cameraRotation;
      this.anchor = source.anchor;
      this.updateProjectionMatrix();
    }
    return this;
  }

  /** Serialises the camera alongside the node data. */
  public override toJSON(recursive = true): ReturnType<Node2D['toJSON']> {
    const json = super.toJSON(recursive);
    json.viewport = this.viewport.toJSON();
    json.zoom = this.zoomValue;
    json.cameraRotation = this.cameraRotation;
    json.anchor = this.anchor;
    json.worldView = this.worldView.toJSON();
    return json;
  }

  /** Returns a new camera with the same state. */
  public override clone(recursive = true): Camera2D {
    return this.createInstance().copy(this, recursive) as Camera2D;
  }

  /** Creates an empty `Camera2D`, used by `clone()`. */
  protected override createInstance(): Node2D {
    return new Camera2D();
  }
}

/** Scratch matrix used to apply the camera rotation. */
const rotationMatrix = new Mat4();

/** Rotates `(x, y)` by the given cosine/sine pair. */
function rotate2D(x: number, y: number, cos: number, sin: number): { x: number; y: number } {
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** Normalised anchor factors, in `[0, 1]`. */
function anchorFactors(anchor: CameraAnchor2D): { x: number; y: number } {
  switch (anchor) {
    case 'top':
      return { x: 0.5, y: 0 };
    case 'topRight':
      return { x: 1, y: 0 };
    case 'left':
      return { x: 0, y: 0.5 };
    case 'center':
      return { x: 0.5, y: 0.5 };
    case 'right':
      return { x: 1, y: 0.5 };
    case 'bottomLeft':
      return { x: 0, y: 1 };
    case 'bottom':
      return { x: 0.5, y: 1 };
    case 'bottomRight':
      return { x: 1, y: 1 };
    default:
      return { x: 0, y: 0 };
  }
}
