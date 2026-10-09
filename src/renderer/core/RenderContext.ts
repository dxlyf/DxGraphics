/**
 * Per-frame render context.
 *
 * A `RenderContext` is created once by {@link AbstractRenderer} and mutated in
 * place every frame; passes and backends read from it instead of reaching back
 * into the renderer. Reusing a single instance keeps the hot path allocation-free.
 *
 * @packageDocumentation
 */

import type { IRenderer, CameraLike, SceneLike } from '../interfaces/IRenderer';
import type { IRenderTarget } from '../interfaces/IRenderTarget';
import type { RenderStats, ScissorRect, ViewportLike } from '../interfaces/types';
import type { RGBA } from '../utils/colorUtils';
import type { RenderList } from './RenderList';
import type { RenderQueue } from './RenderQueue';
import type { RenderState } from './RenderState';

/* -------------------------------------------------------------------------- */
/* Camera transform helpers                                                   */
/* -------------------------------------------------------------------------- */

/** World→screen pan/zoom transform extracted from a 2D camera. */
export interface Camera2DTransform {
  /** Horizontal pan in world units. */
  x: number;
  /** Vertical pan in world units. */
  y: number;
  /** Uniform scale applied to world units. */
  zoom: number;
  /** Rotation about the view axis, in radians. */
  rotation: number;
  /** `true` when a camera supplied the values; `false` for the identity default. */
  hasCamera: boolean;
}

/** Plain `{ x, y }` reading of a camera position, tolerating extra members. */
function readXY(value: unknown): { x: number; y: number } | null {
  if (value == null || typeof value !== 'object') return null;
  const candidate = value as { x?: unknown; y?: unknown };
  if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number') return null;
  return { x: candidate.x, y: candidate.y };
}

/**
 * Extracts the pan/zoom/rotation a 2D backend needs from a {@link CameraLike}.
 *
 * Cameras are read structurally: a missing `position` contributes `(0, 0)`, a
 * missing `zoom` contributes `1`, and a missing `rotation` contributes `0`.
 *
 * @param camera Camera to read, or `null`/`undefined` for the identity transform.
 * @param target Optional object to write into.
 * @returns The extracted transform.
 */
export function getCamera2DTransform(
  camera: CameraLike | null | undefined,
  target: Camera2DTransform = { x: 0, y: 0, zoom: 1, rotation: 0, hasCamera: false },
): Camera2DTransform {
  if (camera == null) {
    target.x = 0;
    target.y = 0;
    target.zoom = 1;
    target.rotation = 0;
    target.hasCamera = false;
    return target;
  }

  const position = readXY(camera.position) ?? { x: 0, y: 0 };
  target.x = position.x;
  target.y = position.y;
  target.zoom = typeof camera.zoom === 'number' && camera.zoom !== 0 ? camera.zoom : 1;
  target.rotation = typeof camera.rotation === 'number' ? camera.rotation : 0;
  target.hasCamera = true;
  return target;
}

/* -------------------------------------------------------------------------- */
/* RenderContext                                                              */
/* -------------------------------------------------------------------------- */

/**
 * State shared by every pass and backend during one frame.
 *
 * Mutated in place by {@link RenderContext.begin}; consumers must not retain the
 * instance across frames.
 */
export class RenderContext {
  /** Zero-based index of the frame being rendered. */
  public frame: number = -1;

  /** Seconds elapsed since the previous frame. */
  public delta: number = 0;

  /** Seconds elapsed since the renderer was created. */
  public time: number = 0;

  /** Milliseconds since the process/page origin, as reported by the frame clock. */
  public timestamp: number = 0;

  /** Logical (CSS) width of the drawing surface. */
  public width: number = 0;

  /** Logical (CSS) height of the drawing surface. */
  public height: number = 0;

  /** Active device-pixel ratio. */
  public pixelRatio: number = 1;

  /** Viewport for this frame, in device pixels. */
  public viewport: ViewportLike = { x: 0, y: 0, width: 0, height: 0 };

  /** Scissor rectangle for this frame, or `null` when scissoring is disabled. */
  public scissor: ScissorRect | null = null;

  /** Target being drawn into, or `null` when drawing into the canvas. */
  public target: IRenderTarget | null = null;

  /** Camera for this frame, or `null`. */
  public camera: CameraLike | null = null;

  /** Scene for this frame, or `null`. */
  public scene: SceneLike | null = null;

  /** Renderer that owns this context. */
  public renderer: IRenderer | null = null;

  /** Live statistics object owned by the renderer. */
  public stats: RenderStats | null = null;

  /** Background colour for this frame, as 0..1 RGBA channels. */
  public clearColor: RGBA = { r: 0, g: 0, b: 0, a: 1 };

  /** Renderables collected for this frame, when a list was supplied. */
  public renderList: RenderList | null = null;

  /** Sorted draw order produced from {@link RenderContext.renderList}. */
  public renderQueue: RenderQueue | null = null;

  /** Comparable render state for this frame. */
  public renderState: RenderState | null = null;

  /** Pan/zoom extracted from a 2D camera; refreshed by {@link RenderContext.begin}. */
  public readonly camera2D: Camera2DTransform = { x: 0, y: 0, zoom: 1, rotation: 0, hasCamera: false };

  /** Free-form scratch space passes use to hand values to the next pass. */
  public readonly values: Map<string, unknown> = new Map();

  /** `true` when the frame has been cancelled (for example the surface was lost). */
  public cancelled: boolean = false;

  /**
   * Resets the per-frame fields, keeping the scratch map.
   *
   * @param frame Frame index.
   * @param delta Seconds since the previous frame.
   * @param time Seconds since the renderer was created.
   * @param timestamp Raw clock reading for the frame.
   * @returns This context, for chaining.
   */
  public begin(frame: number, delta: number, time: number, timestamp: number): this {
    this.frame = frame;
    this.delta = delta;
    this.time = time;
    this.timestamp = timestamp;
    this.cancelled = false;
    this.viewport = { x: 0, y: 0, width: 0, height: 0 };
    this.scissor = null;
    this.target = null;
    this.camera = null;
    this.scene = null;
    this.renderList = null;
    this.renderQueue = null;
    this.renderState = null;
    this.values.clear();
    this.camera2D.x = 0;
    this.camera2D.y = 0;
    this.camera2D.zoom = 1;
    this.camera2D.rotation = 0;
    this.camera2D.hasCamera = false;
    return this;
  }

  /**
   * Copies the renderer's current sizing, clear colour and camera transform in.
   *
   * @param width Logical width in CSS pixels.
   * @param height Logical height in CSS pixels.
   * @param pixelRatio Device-pixel ratio.
   * @param viewport Current viewport.
   * @param scissor Current scissor rectangle, or `null`.
   * @param clearColor Current clear colour.
   * @param camera Camera for the frame, or `null`.
   * @returns This context, for chaining.
   */
  public setSurface(
    width: number,
    height: number,
    pixelRatio: number,
    viewport: ViewportLike,
    scissor: ScissorRect | null,
    clearColor: Readonly<RGBA>,
    camera: CameraLike | null,
  ): this {
    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;
    this.viewport = { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height };
    this.scissor = scissor === null ? null : { ...scissor };
    this.clearColor.r = clearColor.r;
    this.clearColor.g = clearColor.g;
    this.clearColor.b = clearColor.b;
    this.clearColor.a = clearColor.a;
    this.camera = camera;
    getCamera2DTransform(camera, this.camera2D);
    return this;
  }

  /** Records a renderable count for the frame's statistics. */
  public countObject(culled: boolean = false): void {
    if (this.stats === null) return;
    if (culled) this.stats.culled++;
    else this.stats.objects++;
  }

  /**
   * Adds a draw call, a triangle count and a vertex count to the frame's stats.
   *
   * @param triangles Triangles submitted.
   * @param vertices Vertices submitted.
   * @param drawCalls Draw calls issued; defaults to `1`.
   */
  public countDraw(triangles: number = 0, vertices: number = 0, drawCalls: number = 1): void {
    if (this.stats === null) return;
    this.stats.drawCalls += drawCalls;
    this.stats.triangles += triangles;
    this.stats.vertices += vertices;
  }
}
