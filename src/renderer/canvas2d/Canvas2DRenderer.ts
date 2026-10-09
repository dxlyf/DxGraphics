/**
 * Canvas2D renderer.
 *
 * Renders 2D scenes through `CanvasRenderingContext2D`. Everything about sizing,
 * pixel ratio, the clear colour and the animation loop comes from
 * `AbstractRenderer`; this class adds the four things that are canvas-specific:
 *
 * 1. **device-pixel-ratio aware sizing** — the drawing buffer is
 *    `logicalSize * pixelRatio` while the transform maps logical pixels onto it;
 * 2. **camera → pixel transform setup** — pan/zoom/rotation read structurally from
 *    a 2D camera and applied with `setTransform`;
 * 3. **clear / background and scissor clipping**;
 * 4. **a per-node state stack** — every node is wrapped in `save()`/`restore()` so
 *    it cannot leak a transform, a clip or a style into its neighbours.
 *
 * ## Headless behaviour
 *
 * In Node (no DOM, no `OffscreenCanvas`) the renderer still constructs, tracks its
 * size, and supports `setSize`, `setPixelRatio`, `clear` and `dispose`. Only
 * `render` throws, and it says why.
 *
 * @packageDocumentation
 */

import { BackendNames, type BackendName } from '../../constants';
import { createLogger } from '../../utils/Logger';
import type { CameraLike, SceneLike } from '../interfaces/IRenderer';
import type { IRenderTarget } from '../interfaces/IRenderTarget';
import type { RenderTargetOptions, RendererOptions } from '../interfaces/types';
import { ClearFlags } from '../interfaces/types';
import { RenderContext } from '../core/RenderContext';
import { RenderList, type Renderable2D } from '../core/RenderList';
import { RenderQueue } from '../core/RenderQueue';
import type { RGBA } from '../utils/colorUtils';
import { toCss } from '../utils/colorUtils';
import {
  AbstractRenderer,
  type CanvasSurface,
} from '../core/AbstractRenderer';
import { Canvas2DPainter, type CanvasPoint } from './Canvas2DPainter';
import { Canvas2DState } from './Canvas2DState';

/** Logger for renderer diagnostics. */
const log = createLogger('renderer:canvas2d');

/** Extended options accepted by {@link Canvas2DRenderer}. */
export interface Canvas2DRendererOptions extends RendererOptions {
  /** Extra attributes forwarded to `canvas.getContext('2d', ...)`. */
  contextAttributes?: Record<string, unknown>;
  /** `true` to log once when the 2D context cannot be acquired. */
  reportContextFailure?: boolean;
}

/**
 * A 2D camera expressed as a plain pan/zoom/rotation transform.
 *
 * {@link Canvas2DRenderer} reads this shape through the structural
 * {@link CameraLike} interface; the scene layer's concrete camera can also expose
 * it verbatim.
 */
export interface Canvas2DCamera extends CameraLike {
  /** Pan offset in world units. */
  readonly position?: { x: number; y: number; z?: number };
  /** Uniform world→pixel scale. */
  readonly zoom?: number;
  /** Rotation about the view axis, in radians. */
  readonly rotation?: number;
}

/** Structural view of a 3D renderable, used to sort mixed scenes by depth. */
interface DepthSortable {
  readonly position?: { x: number; y: number; z?: number };
  readonly matrixWorld?: { elements: ArrayLike<number> };
  readonly renderOrder?: number;
  readonly visible?: boolean;
  readonly material?: { readonly transparent?: boolean; readonly id?: string | number } | null;
  readonly id?: string | number;
}

/** A `Path2D`-style builder accepted by `Canvas2DRenderer.strokePath`. */
export type Canvas2DPath = Path2D;

/**
 * Renders 2D and (screen-space) 3D scenes into a canvas.
 *
 * ```ts
 * const renderer = new Canvas2DRenderer({ canvas: '#stage', pixelRatio: 2 });
 * renderer.setClearColor('#101014');
 * renderer.setSize(800, 600);
 * renderer.render(scene, camera);
 * ```
 */
export class Canvas2DRenderer extends AbstractRenderer {
  /** @inheritdoc */
  public readonly backend: BackendName = BackendNames.Canvas2D;

  /** The immediate-mode surface handed to nodes. */
  public readonly painter: Canvas2DPainter;

  /** Per-frame reusable render list. */
  public readonly renderList: RenderList<Renderable2D> = new RenderList<Renderable2D>();

  /** Per-frame reusable draw-order producer. */
  public readonly renderQueue: RenderQueue<Renderable2D> = new RenderQueue<Renderable2D>();

  /** Normalised options, exposed for subclasses and tests. */
  public readonly canvasOptions: Canvas2DRendererOptions;

  /** The acquired 2D context, or `null` on a null painter. */
  private ctx: CanvasRenderingContext2D | null = null;

  /** `true` when `getContext('2d')` has failed and was logged. */
  private reportedContextFailure: boolean = false;

  /** Scratch camera transform reused every frame. */
  private readonly cameraScratch = { x: 0, y: 0, zoom: 1, rotation: 0, hasCamera: false };

  /** Scratch camera world position, for depth sorting. */
  private readonly cameraOrigin = { x: 0, y: 0, z: 0 };

  /**
   * Creates a Canvas2D renderer.
   *
   * @param options Renderer options; `canvas` accepts a canvas, an
   *   `OffscreenCanvas`, a CSS selector, a container element, or a test double.
   */
  constructor(options: Canvas2DRendererOptions = {}) {
    super(options as RendererOptions, BackendNames.Canvas2D);
    this.canvasOptions = options;

    const surface = this.surface as CanvasSurface;
    const context = surface.getContext('2d', {
      alpha: true,
      desynchronized: false,
      willReadFrequently: true,
      ...(options.contextAttributes ?? {}),
    });
    this.ctx = isCanvas2DContext(context) ? context : null;
    this.painter = new Canvas2DPainter(this.ctx);

    this.initialise();
  }

  /* ---------------------------------------------------------------- lifecycle */

  /** @inheritdoc */
  protected override onInitialise(): void {
    if (this.ctx === null) {
      const surface = this.surface as CanvasSurface;
      const context = surface.getContext('2d', {
        alpha: true,
        desynchronized: false,
        willReadFrequently: true,
        ...(this.canvasOptions.contextAttributes ?? {}),
      });
      this.ctx = isCanvas2DContext(context) ? context : null;
      this.painter.setContext(this.ctx);
    }

    if (this.ctx === null && (this.canvasOptions.reportContextFailure ?? true)) {
      log.warn(
        'Canvas2DRenderer: could not acquire a 2D context. The renderer is usable for ' +
          'sizing and clearing, but nothing will be drawn.',
      );
    }

    this.renderState.apply2DDefaults();
    this.renderState.viewport = { x: 0, y: 0, width: this.surface.width, height: this.surface.height };
    this.renderState.pixelRatio = this.pixelRatio;
    this.applyBaseTransform();
  }

  /** @inheritdoc */
  protected override onSizeChanged(_width: number, _height: number, _pixelRatio: number): void {
    this.renderState.viewport = { x: 0, y: 0, width: this.surface.width, height: this.surface.height };
    this.renderState.pixelRatio = _pixelRatio;
    this.applyBaseTransform();
  }

  /** @inheritdoc */
  protected override getCapabilities(): readonly string[] {
    const capabilities = ['immediate-mode', 'clipping', 'gradients', 'shadows', 'image-blit'];
    if (this.ctx !== null && typeof (this.ctx as unknown as { filter?: string }).filter === 'string') {
      capabilities.push('css-filter');
    }
    if (typeof Path2D !== 'undefined') capabilities.push('path2d');
    return capabilities;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    this.painter.restoreAll();
    this.renderList.reset();
    this.renderQueue.reset();
    this.ctx = null;
    this.painter.setContext(null);
  }

  /* ------------------------------------------------------------------- context */

  /** @returns The acquired 2D context, or `null`. */
  public getContext(): CanvasRenderingContext2D | null {
    return this.ctx;
  }

  /* -------------------------------------------------------------------- clear */

  /** @inheritdoc */
  protected override clearSurface(options: {
    color: RGBA;
    depth: number;
    stencil: number;
    flags: ClearFlags;
  }): void {
    const context = this.ctx;
    if (context === null) return;

    this.painter.save();
    this.painter.resetTransform();

    if ((options.flags & ClearFlags.Color) !== 0) {
      if (options.color.a >= 1) {
        context.clearRect(0, 0, this.surface.width, this.surface.height);
      }
      this.painter.fillStyle = toCss(options.color);
      this.painter.fillRect(0, 0, this.surface.width, this.surface.height);
    }

    if ((options.flags & ClearFlags.Depth) !== 0 || (options.flags & ClearFlags.Stencil) !== 0) {
      // The 2D backend has no depth or stencil buffers; the canvas API exposes
      // `depth`/`stencil` context attributes but no per-call clear. The mask is
      // recorded in the stats so callers can see it was requested.
      void options.depth;
      void options.stencil;
    }

    this.painter.restore();

    if ((options.flags & ClearFlags.Color) !== 0) {
      this.stats.drawCalls++;
    }
  }

  /* ------------------------------------------------------------------- render */

  /** @inheritdoc */
  protected override renderScene(
    scene: SceneLike | null,
    camera: CameraLike | null,
    context: RenderContext,
  ): void {
    if (this.ctx === null) {
      // Deliberately not `warnOnce`: a renderer without a 2D context silently
      // producing black frames is exactly the failure a developer needs to see
      // every time it happens.
      log.warn(
        'Canvas2DRenderer: render() called without a 2D context, so the frame is skipped. ' +
          'Pass a canvas that supports `getContext("2d")`, or run in an environment with a DOM.',
      );
      return;
    }

    // The surface may have changed since the last frame (auto-resize, DPR swap).
    this.applyBaseTransform();

    const list = this.renderList;
    list.reset();
    const collected = this.collectScene(scene, camera, list);
    context.renderList = list;
    context.renderQueue = this.renderQueue;
    this.ctx.save();
    this.applyCameraTransform(camera, context);
    this.applyScissorClip();

    this.drawBackground(context.clearColor);

    if (collected) {
      const result = this.renderQueue.sort(list);
      this.paintEntries(result.order);
      context.countObject(false);
    }

    this.ctx.restore();
    this.painter.restoreAll();
    this.stats.stateChanges++;
  }

  /**
   * Collects the renderables of a scene into the render list.
   *
   * The traversal is intentionally shallow-structural: `collectRenderables(list,
   * camera)` is preferred, then `children`, then the scene's own `render` method
   * when it is callable. Nothing here imports `src/scene`.
   *
   * @param scene Scene to walk.
   * @param camera Camera for the frame.
   * @param list List to fill.
   * @returns `true` when at least one renderable was collected.
   */
  protected collectScene(
    scene: SceneLike | null,
    camera: CameraLike | null,
    list: RenderList<Renderable2D>,
  ): boolean {
    if (scene == null || scene.visible === false) return false;

    const collector = (scene as { collectRenderables?: (target: unknown, cam: unknown) => void })
      .collectRenderables;
    if (typeof collector === 'function') {
      collector.call(scene, list, camera);
      return list.length > 0;
    }

    const children = (scene as { children?: readonly unknown[] }).children;
    if (Array.isArray(children)) {
      for (const child of children) this.pushRenderable(child, list, camera);
      return list.length > 0;
    }

    return this.pushRenderable(scene, list, camera);
  }

  /** Submits one child if it looks renderable. */
  private pushRenderable(
    candidate: unknown,
    list: RenderList<Renderable2D>,
    camera: CameraLike | null,
  ): boolean {
    if (candidate == null || typeof candidate !== 'object') return false;
    const object = candidate as Partial<Renderable2D> & DepthSortable;
    if (typeof object.render !== 'function') return false;

    this.updateDepth(object, camera);
    const entry = list.push(object as Renderable2D);
    return entry !== null;
  }

  /** Refreshes an object's sort depth from its position relative to the camera. */
  private updateDepth(object: DepthSortable, camera: CameraLike | null): void {
    if (typeof (object as { updateDepth?: unknown }).updateDepth === 'function') {
      (object as { updateDepth(cam: unknown): void }).updateDepth(camera);
      return;
    }

    const elements = object.matrixWorld?.elements;
    const cameraElements = camera?.viewMatrix?.elements;
    if (elements !== undefined && cameraElements !== undefined) {
      const x = elements[12] ?? 0;
      const y = elements[13] ?? 0;
      const z = elements[14] ?? 0;
      const viewZ =
        (cameraElements[2] ?? 0) * x +
        (cameraElements[6] ?? 0) * y +
        (cameraElements[10] ?? 0) * z +
        (cameraElements[14] ?? 0);
      (object as { depth?: number }).depth = -viewZ;
      return;
    }

    const position = object.position;
    if (position !== undefined) {
      const dx = position.x - this.cameraOrigin.x;
      const dy = position.y - this.cameraOrigin.y;
      (object as { depth?: number }).depth = Math.sqrt(dx * dx + dy * dy);
    }
  }

  /** Draws every entry of a produced draw order. */
  private paintEntries(entries: readonly { object: Renderable2D }[]): void {
    if (entries.length === 0) return;
    const context = this.ctx;
    const painter = this.painter;

    for (const entry of entries) {
      const object = entry.object;
      if (object.visible === false) continue;

      if (context !== null) context.save();
      const depthBefore = painter.depth;
      try {
        object.render(painter);
      } catch (error) {
        log.error(`a renderable threw while drawing (${describeObject(object)})`, error);
      } finally {
        painter.restoreAll();
        if (context !== null) context.restore();
        if (painter.depth !== depthBefore) {
          log.warnOnce('a renderable left the painter state stack unbalanced; it was unwound');
        }
      }
      this.stats.drawCalls++;
    }
  }

  /* ---------------------------------------------------------------- transform */

  /**
   * Applies the device-pixel-ratio base transform.
   *
   * After this call the painter works in logical (CSS) pixels.
   */
  public applyBaseTransform(): void {
    const context = this.ctx;
    if (context === null) return;
    try {
      context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    } catch {
      /* a partial double may not implement setTransform */
    }
  }

  /**
   * Applies a 2D camera's pan/zoom/rotation to the painter.
   *
   * When the camera exposes a projected (3D) matrix pair, the view-projection is
   * applied instead: column-major `projection * view` mapped onto the canvas
   * transform with the Y axis flipped so that world +Y points up.
   *
   * @param camera Camera for the frame, or `null` for the identity transform.
   * @param context Frame context carrying the extracted 2D transform.
   */
  public applyCameraTransform(camera: CameraLike | null, context: RenderContext): void {
    const context2d = this.ctx;
    if (context2d === null) return;

    this.cameraOrigin.x = camera?.position?.x ?? 0;
    this.cameraOrigin.y = camera?.position?.y ?? 0;
    this.cameraOrigin.z = camera?.position?.z ?? 0;

    const view = camera?.viewMatrix?.elements;
    const projection = camera?.projectionMatrix?.elements;

    if (view !== undefined && projection !== undefined) {
      const m = multiplyMat4(projection, view);
      const width = this.width;
      const height = this.height;

      // Column-major m: v' = m * v. Screen = NDC mapped to logical pixels, Y flipped.
      const a = m[0] * (width / 2);
      const b = -m[1] * (height / 2);
      const c = m[4] * (width / 2);
      const d = -m[5] * (height / 2);
      const e = (m[12] + 1) * (width / 2);
      const f = (1 - m[13]) * (height / 2);

      try {
        context2d.transform(a, b, c, d, e, f);
      } catch {
        /* ignore partial implementations */
      }
      this.cameraScratch.hasCamera = true;
      this.cameraScratch.zoom = 1;
      this.cameraScratch.x = this.cameraOrigin.x;
      this.cameraScratch.y = this.cameraOrigin.y;
      this.cameraScratch.rotation = 0;
      return;
    }

    const transform = context.camera2D;
    this.cameraScratch.x = transform.x;
    this.cameraScratch.y = transform.y;
    this.cameraScratch.zoom = transform.zoom;
    this.cameraScratch.rotation = transform.rotation;
    this.cameraScratch.hasCamera = transform.hasCamera;

    const zoom = transform.zoom === 0 ? 1 : transform.zoom;
    const rotation = transform.rotation;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);

    // Logical-pixel space: translate the camera offset to the centre, flip Y so
    // that world +Y points up, then rotate and scale.
    const a = zoom * cos;
    const b = -zoom * sin;
    const c = -zoom * sin;
    const d = -zoom * cos;
    const e = -transform.x * a - transform.y * c + this.width / 2;
    const f = -transform.x * b - transform.y * d + this.height / 2;

    try {
      context2d.transform(a, b, c, d, e, f);
    } catch {
      /* ignore partial implementations */
    }
  }

  /** Applies the current scissor rectangle as a clip region. */
  public applyScissorClip(): void {
    const scissor = this.scissor;
    if (scissor === null || this.ctx === null) return;
    if (scissor.width <= 0 || scissor.height <= 0) {
      // An empty scissor must clip everything away.
      this.painter.beginPath();
      this.painter.rect(scissor.x, scissor.y, 0, 0);
      this.painter.clip();
      return;
    }
    this.painter.beginPath();
    this.painter.rect(scissor.x, scissor.y, scissor.width, scissor.height);
    this.painter.clip();
  }

  /* ------------------------------------------------------------------ helpers */

  /** Fills the whole logical viewport with a colour. */
  private drawBackground(color: Readonly<RGBA>): void {
    if (color.a <= 0) return;
    const context = this.ctx;
    if (context === null) return;

    // Reset to device-pixel space so the clear covers the buffer exactly.
    context.setTransform(1, 0, 0, 1, 0, 0);
    this.painter.fillStyle = toCss(color);
    this.painter.fillRect(0, 0, this.surface.width, this.surface.height);
    // Re-apply the camera transform for the nodes.
    this.applyBaseTransform();
    this.applyCameraTransform(this.context.camera, this.context);
    this.applyScissorClip();
  }

  /**
   * Builds a `Path2D` from a list of points.
   *
   * @param points Vertices, in order.
   * @param close Close the path back to the first point.
   * @returns The path, or `null` when `Path2D` is unavailable.
   */
  public createPathFromPoints(points: readonly CanvasPoint[], close: boolean = true): Path2D | null {
    return this.painter.toPath2D((path) => {
      if (points.length === 0) return;
      path.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, points[i].y);
      if (close) path.closePath();
    });
  }

  /**
   * Fills and/or strokes a `Path2D` on the live context.
   *
   * @param path Path to draw.
   * @param mode `'fill'`, `'stroke'` or `'both'`.
   */
  public drawPath(path: Path2D, mode: 'fill' | 'stroke' | 'both' = 'fill'): void {
    this.painter.drawPath(path, mode);
  }

  /** @inheritdoc */
  protected override onCreateRenderTarget(options: RenderTargetOptions): IRenderTarget {
    throw new Error(
      'Canvas2DRenderer: off-screen render targets are not supported. The Canvas2D backend ' +
        `can only draw into its own canvas (requested ${options.width}x${options.height}). ` +
        'Use a WebGL/WebGPU backend for render-to-texture work.',
    );
  }

  /**
   * Sets the background colour through the shared clear state.
   *
   * @param color Colour input (`'#rrggbb'`, `rgb()`, `hsl()`, keyword or number).
   * @param alpha Optional alpha override in 0..1.
   */
  public setBackground(color: unknown, alpha?: number): void {
    this.clearState.setColor(color as string, alpha);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Narrows an arbitrary context candidate to a real 2D context. */
function isCanvas2DContext(value: unknown): value is CanvasRenderingContext2D {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<CanvasRenderingContext2D>;
  return typeof candidate.fillRect === 'function' && typeof candidate.save === 'function';
}

/** Describes a renderable for error messages. */
function describeObject(object: Renderable2D): string {
  const id = (object as { id?: string | number }).id;
  const name = (object as { name?: string }).name;
  if (typeof name === 'string' && name.length > 0) return name;
  if (id !== undefined) return `id=${String(id)}`;
  const constructor = (object as { constructor?: { name?: string } }).constructor;
  return constructor?.name ?? 'anonymous renderable';
}

/** Multiplies two column-major 4x4 matrices (`left * right`). */
function multiplyMat4(left: ArrayLike<number>, right: ArrayLike<number>): number[] {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += (left[k * 4 + row] ?? 0) * (right[column * 4 + k] ?? 0);
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** Default `Canvas2DState` instance, re-exported for convenience. */
export { Canvas2DState };
