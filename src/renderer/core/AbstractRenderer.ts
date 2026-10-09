/**
 * Shared renderer implementation.
 *
 * `AbstractRenderer` owns everything a backend does not have to think about:
 * surface creation and sizing, device-pixel-ratio handling, the viewport/scissor
 * bookkeeping, the clear colour, the animation loop, render statistics and
 * disposal. Concrete backends implement three hooks:
 *
 * - {@link AbstractRenderer.renderScene} — draw a scene for a frame;
 * - {@link AbstractRenderer.clearSurface} — clear the current target;
 * - {@link AbstractRenderer.createRenderTarget} — allocate an off-screen target.
 *
 * ## Coordination note
 *
 * `src/core/` did not exist when this layer was written, so the renderer carries
 * its own minimal structural listener registry ({@link ResizeListenerRegistry})
 * instead of importing `src/core/EventEmitter`. Swapping it for the real emitter
 * later is a one-line change: the registry only exposes `add`, `remove`, `emit`
 * and `clear`.
 *
 * ## Headless behaviour
 *
 * When no canvas can be created (plain Node), the renderer binds a *null surface*
 * whose dimensions are still tracked. Construction, `setSize`, `setPixelRatio`,
 * `clear` and `dispose` therefore all work; only `render` throws, with an
 * explanatory message.
 *
 * @packageDocumentation
 */

import { BackendNames, DEFAULT_BACKGROUND_COLOR, MAX_DELTA, type BackendName } from '../../constants';
import { cancelFrame, requestFrame } from '../../utils/BrowserUtils';
import { getPixelRatio as readDevicePixelRatio } from '../../utils/DomUtils';
import { createLogger } from '../../utils/Logger';
import type {
  AnimationLoopCallback,
  CameraLike,
  IRenderer,
  ResizeCallback,
  ResizeUnsubscribe,
  SceneLike,
} from '../interfaces/IRenderer';
import type { IRenderTarget } from '../interfaces/IRenderTarget';
import type {
  AnimationLoopOptions,
  ClearColorInput,
  ClearOptions,
  RendererInfo,
  RendererOptions,
  RenderStats,
  RenderTargetOptions,
  ScissorRect,
  ViewportLike,
} from '../interfaces/types';
import { ClearFlags } from '../interfaces/types';
import { ClearState } from './Clear';
import { RenderContext } from './RenderContext';
import { RenderPipeline } from './RenderPipeline';
import { RenderState } from './RenderState';
import { Viewport } from './Viewport';
import { Scissor } from './Scissor';
import { asCanvasLike, createCanvas, type CanvasLike } from '../utils/createCanvas';
import { normalizeColor, type RGBA } from '../utils/colorUtils';

/** Logger for renderer lifecycle diagnostics. */
const log = createLogger('renderer');

/* -------------------------------------------------------------------------- */
/* Surface abstraction                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Renderer-facing view of a drawing surface.
 *
 * A DOM `HTMLCanvasElement`, an `OffscreenCanvas` and the hand-written doubles
 * used by the unit tests all satisfy this shape.
 */
export interface CanvasSurface extends CanvasLike {
  /** Inline style block, when the surface is a DOM element. */
  readonly style?: { width: string; height: string };
  /**
   * Requests a rendering context.
   *
   * Deliberately typed with a permissive signature so that the DOM's narrower
   * `getContext` overloads remain structurally assignable.
   */
  getContext(contextId: string, options?: Record<string, unknown>): unknown;
  /** Converts the surface to a data URL, when supported. */
  toDataURL?(type?: string): string;
}

/**
 * Reads the CSS size of a DOM-backed surface.
 *
 * @param surface Surface to measure.
 * @param fallback Size used when the element reports nothing usable.
 * @returns The measured logical size.
 */
export function readSurfaceDisplaySize(
  surface: CanvasSurface,
  fallback: { width: number; height: number },
): { width: number; height: number } {
  const element = surface as unknown as {
    getBoundingClientRect?(): { width: number; height: number };
    clientWidth?: number;
    clientHeight?: number;
  };

  if (typeof element.getBoundingClientRect === 'function') {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    }
  }
  if ((element.clientWidth ?? 0) > 0 && (element.clientHeight ?? 0) > 0) {
    return { width: Math.round(element.clientWidth ?? 0), height: Math.round(element.clientHeight ?? 0) };
  }
  return { ...fallback };
}

/** A surface that stores its size and ignores every drawing call. */
function createNullSurface(width: number, height: number): CanvasSurface {
  return {
    width,
    height,
    getContext(): unknown {
      return null;
    },
  };
}

/** `true` when the surface has an inline style block (i.e. is a DOM element). */
function hasInlineStyle(surface: CanvasSurface): boolean {
  return 'style' in surface && surface.style != null;
}

/* -------------------------------------------------------------------------- */
/* Structural listener registry                                               */
/* -------------------------------------------------------------------------- */

/**
 * Minimal listener registry used for resize notifications.
 *
 * Stands in for `src/core/EventEmitter`, which did not exist when this module was
 * written. Listener errors are caught so a broken callback cannot abort a resize.
 */
export class ResizeListenerRegistry {
  /** Registered listeners. */
  private readonly listeners = new Set<ResizeCallback>();

  /**
   * Registers a listener.
   *
   * @param listener Callback to add.
   * @returns A function removing the listener again.
   */
  public add(listener: ResizeCallback): ResizeUnsubscribe {
    this.listeners.add(listener);
    return () => this.remove(listener);
  }

  /**
   * Removes a listener.
   *
   * @param listener Callback to remove.
   * @returns `true` when the listener was registered.
   */
  public remove(listener: ResizeCallback): boolean {
    return this.listeners.delete(listener);
  }

  /**
   * Invokes every listener.
   *
   * @param width New logical width in CSS pixels.
   * @param height New logical height in CSS pixels.
   * @param pixelRatio Active device-pixel ratio.
   */
  public emit(width: number, height: number, pixelRatio: number): void {
    for (const listener of this.listeners) {
      try {
        listener(width, height, pixelRatio);
      } catch (error) {
        log.warn('resize listener threw', error);
      }
    }
  }

  /** Removes every listener. */
  public clear(): void {
    this.listeners.clear();
  }

  /** Number of registered listeners. */
  public get size(): number {
    return this.listeners.size;
  }
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/** Internal, fully-resolved form of {@link RendererOptions}. */
export interface ResolvedRendererOptions {
  canvas: unknown;
  container: unknown;
  width: number | undefined;
  height: number | undefined;
  pixelRatio: number | undefined;
  clearColor: unknown;
  clearAlpha: number;
  autoResize: boolean;
  updateStyle: boolean;
  autoClear: boolean;
  maxPixelRatio: number;
  name: string;
}

/**
 * Normalises a {@link RendererOptions} bag.
 *
 * @param options Caller-supplied options.
 * @param backend Backend label used for the default name.
 * @returns A fully populated option bag.
 */
export function resolveRendererOptions(
  options: RendererOptions,
  backend: BackendName,
): ResolvedRendererOptions {
  return {
    canvas: options.canvas,
    container: options.container ?? null,
    width: options.width,
    height: options.height,
    pixelRatio: options.pixelRatio,
    clearColor: options.clearColor ?? DEFAULT_BACKGROUND_COLOR,
    clearAlpha: options.clearAlpha ?? 1,
    autoResize: options.autoResize ?? false,
    updateStyle: options.updateStyle ?? true,
    autoClear: options.autoClear ?? true,
    maxPixelRatio: Math.max(1, options.maxPixelRatio ?? 4),
    name: options.name ?? `${backend}-renderer`,
  };
}

/* -------------------------------------------------------------------------- */
/* Factory context passed to subclasses                                       */
/* -------------------------------------------------------------------------- */

/** Everything a subclass needs while it initialises. */
export interface RendererSetupContext {
  /** Backend label. */
  readonly backend: BackendName;
  /** Normalised options. */
  readonly resolved: ResolvedRendererOptions;
  /** The surface the renderer will draw into (possibly a null surface). */
  readonly surface: CanvasSurface;
  /** Logical width the renderer starts with. */
  readonly width: number;
  /** Logical height the renderer starts with. */
  readonly height: number;
  /** Device-pixel ratio the renderer starts with. */
  readonly pixelRatio: number;
}

/* -------------------------------------------------------------------------- */
/* AbstractRenderer                                                           */
/* -------------------------------------------------------------------------- */

/** Base class every backend renderer extends. */
export abstract class AbstractRenderer implements IRenderer {
  /** Backend identifier. */
  public abstract readonly backend: BackendName;

  /** Normalised construction options. */
  public readonly options: Readonly<RendererOptions>;

  /** Clear-colour configuration owned by the renderer. */
  public readonly clearState: ClearState = new ClearState();

  /** Comparable render state for the frame; backends may mutate it freely. */
  public readonly renderState: RenderState = new RenderState();

  /** Per-frame state handed to passes. */
  public readonly context: RenderContext = new RenderContext();

  /** Optional pass pipeline executed by {@link AbstractRenderer.render}. */
  public pipeline: RenderPipeline | null = null;

  /** Drawing surface, or a null surface in headless mode. */
  protected readonly surface: CanvasSurface;

  /** `true` when no real canvas could be bound. */
  protected readonly headless: boolean;

  /** Registry of resize listeners. */
  protected readonly resizeListeners: ResizeListenerRegistry = new ResizeListenerRegistry();

  /** Internal normalised options. */
  protected readonly resolved: ResolvedRendererOptions;

  /** Mutable per-frame counters. */
  private readonly statistics: RenderStats = createRenderStats();

  /** Logical width in CSS pixels. */
  private logicalWidth: number;

  /** Logical height in CSS pixels. */
  private logicalHeight: number;

  /** Active device-pixel ratio. */
  private ratio: number;

  /** Current viewport in device pixels. */
  private readonly currentViewport: Viewport = new Viewport();

  /** Current scissor rectangle, or `null` when disabled. */
  private currentScissor: Scissor | null = null;

  /** `true` when the drawing buffer must be resized before the next frame. */
  private sizeDirty: boolean = false;

  /** Installed animation-loop callback, or `null`. */
  private animationCallback: AnimationLoopCallback | null = null;

  /** `true` while the animation loop is scheduled. */
  private running: boolean = false;

  /** Cancel handle for the scheduled frame. */
  private frameHandle: number | null = null;

  /** Raw clock reading of the previous frame. */
  private lastTime: number | null = null;

  /** Seconds elapsed since the renderer was created. */
  private elapsed: number = 0;

  /** Zero-based frame index; incremented once per {@link AbstractRenderer.beginFrame}. */
  private frameIndex: number = -1;

  /** Scene passed to the most recent {@link AbstractRenderer.render} call. */
  private lastScene: SceneLike | null = null;

  /** Camera passed to the most recent {@link AbstractRenderer.render} call. */
  private lastCamera: CameraLike | null = null;

  /** `true` once {@link AbstractRenderer.dispose} has run. */
  private disposed: boolean = false;

  /** Currently bound off-screen target, or `null` for the canvas. */
  private currentTarget: IRenderTarget | null = null;

  /** `true` once {@link AbstractRenderer.initialise} has run. */
  private ready: boolean = false;

  /**
   * Creates a renderer.
   *
   * Subclasses should call `super(options, setup)` and then perform their own
   * context acquisition inside {@link AbstractRenderer.initialise}.
   *
   * @param options Caller-supplied renderer options.
   * @param backend Backend label implementation detail.
   */
  protected constructor(options: RendererOptions, backend: BackendName) {
    this.resolved = resolveRendererOptions(options, backend);
    this.options = Object.freeze({ ...options });

    const bound = bindSurface(this.resolved);
    this.surface = bound.surface;
    this.headless = bound.headless;
    this.logicalWidth = bound.width;
    this.logicalHeight = bound.height;
    this.ratio = bound.pixelRatio;

    this.clearState.setColor(this.resolved.clearColor as ClearColorInput, this.resolved.clearAlpha);
    this.renderState.apply2DDefaults();

    this.syncSurfaceSize();
    this.currentViewport.set(0, 0, this.surface.width, this.surface.height);
    this.renderState.viewport = this.currentViewport.toObject();
    this.renderState.pixelRatio = this.ratio;
  }

  /* --------------------------------------------------------------- identity */

  /** @inheritdoc */
  public get surfaceSize(): { width: number; height: number } {
    return { width: this.surface.width, height: this.surface.height };
  }

  /** @inheritdoc */
  public get domElement(): HTMLElement | null {
    return hasInlineStyle(this.surface) ? (this.surface as unknown as HTMLElement) : null;
  }

  /** @inheritdoc */
  public get canvas(): HTMLCanvasElement | null {
    if (this.headless) return null;
    if (typeof HTMLCanvasElement === 'undefined') return null;
    return this.surface instanceof HTMLCanvasElement ? this.surface : null;
  }

  /** @inheritdoc */
  public get width(): number {
    return this.logicalWidth;
  }

  /** @inheritdoc */
  public get height(): number {
    return this.logicalHeight;
  }

  /** @inheritdoc */
  public get pixelRatio(): number {
    return this.ratio;
  }

  /** Drawing-buffer width in device pixels. */
  public get drawingBufferWidth(): number {
    return this.surface.width;
  }

  /** Drawing-buffer height in device pixels. */
  public get drawingBufferHeight(): number {
    return this.surface.height;
  }

  /** @inheritdoc */
  public get viewport(): ViewportLike {
    return this.currentViewport.toObject();
  }

  /** @inheritdoc */
  public get scissor(): ScissorRect | null {
    return this.currentScissor === null ? null : this.currentScissor.toObject();
  }

  /** @inheritdoc */
  public get clearColor(): RGBA {
    return this.clearState.getEffectiveColor();
  }

  /** @inheritdoc */
  public get stats(): RenderStats {
    return this.statistics;
  }

  /** @inheritdoc */
  public get info(): RendererInfo {
    return this.buildInfo();
  }

  /** `true` when the renderer runs without a real canvas. */
  public get isHeadless(): boolean {
    return this.headless;
  }

  /* ------------------------------------------------------------ initialise */

  /**
   * Finishes construction: subclasses acquire their context here.
   *
   * Called by the concrete constructor once its own fields are assigned. Safe to
   * call twice; the second call is a no-op.
   *
   * @returns `true` when the backend is usable, `false` in headless mode.
   */
  public initialise(): boolean {
    if (this.ready) return !this.headless;
    this.ready = true;

    if (this.headless) {
      log.warn(
        `${this.backend}: no canvas could be bound (no OffscreenCanvas and no DOM). ` +
          'The renderer will track its size but `render()` throws until a canvas is supplied.',
      );
      return false;
    }

    this.onInitialise();
    return true;
  }

  /**
   * Backend hook: acquire contexts and allocate resources.
   *
   * Called exactly once, from {@link AbstractRenderer.initialise}, and only when a
   * real surface exists.
   */
  protected abstract onInitialise(): void;

  /**
   * Builds the {@link RendererInfo} snapshot.
   *
   * @returns A fresh description of the live renderer.
   */
  protected buildInfo(): RendererInfo {
    return {
      backend: this.backend,
      width: this.surface.width,
      height: this.surface.height,
      logicalWidth: this.logicalWidth,
      logicalHeight: this.logicalHeight,
      pixelRatio: this.ratio,
      capabilities: this.headless ? [] : this.getCapabilities(),
    };
  }

  /**
   * Backend hook: capability names reported through {@link AbstractRenderer.info}.
   *
   * @returns Capability labels; defaults to an empty list.
   */
  protected getCapabilities(): readonly string[] {
    return [];
  }

  /* ------------------------------------------------------------------ sizing */

  /** @inheritdoc */
  public setSize(width: number, height: number, updateStyle: boolean = true): void {
    const nextWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
    const nextHeight = Math.max(1, Math.floor(Number.isFinite(height) ? height : 1));

    this.logicalWidth = nextWidth;
    this.logicalHeight = nextHeight;

    if (updateStyle && this.resolved.updateStyle !== false && hasInlineStyle(this.surface)) {
      applySurfaceStyle(this.surface, nextWidth, nextHeight);
    }

    this.syncSurfaceSize();
    this.currentViewport.set(0, 0, this.surface.width, this.surface.height);
    this.renderState.viewport = this.currentViewport.toObject();
    this.sizeDirty = false;
    this.onSizeChanged(nextWidth, nextHeight, this.ratio);

    this.pipeline?.notifyResize(nextWidth, nextHeight, this.ratio);
    this.resizeListeners.emit(nextWidth, nextHeight, this.ratio);
    this.renderState.viewport = this.currentViewport.toObject();
  }

  /** @inheritdoc */
  public setPixelRatio(ratio: number): void {
    const max = this.resolved.maxPixelRatio;
    const next = Number.isFinite(ratio) ? Math.min(max, Math.max(1, ratio)) : 1;
    if (next === this.ratio) return;

    this.ratio = next;
    this.renderState.pixelRatio = next;
    this.syncSurfaceSize();
    this.currentViewport.set(0, 0, this.surface.width, this.surface.height);
    this.renderState.viewport = this.currentViewport.toObject();
    this.sizeDirty = false;
    this.onSizeChanged(this.logicalWidth, this.logicalHeight, next);

    this.pipeline?.notifyResize(this.logicalWidth, this.logicalHeight, next);
    this.resizeListeners.emit(this.logicalWidth, this.logicalHeight, next);
  }

  /** @inheritdoc */
  public getPixelRatio(): number {
    return this.ratio;
  }

  /** @inheritdoc */
  public setViewport(viewport: ViewportLike): void {
    this.currentViewport.copy(viewport);
    this.renderState.viewport = this.currentViewport.toObject();
    this.onViewportChanged(this.currentViewport);
  }

  /** @inheritdoc */
  public setScissor(scissor: ScissorRect | null): void {
    if (scissor === null) {
      this.currentScissor = null;
      this.renderState.scissor = null;
      this.onScissorChanged(null);
      return;
    }
    const next = new Scissor(scissor.x, scissor.y, scissor.width, scissor.height).clampTo(
      this.surface.width,
      this.surface.height,
    );
    this.currentScissor = next;
    this.renderState.scissor = next.toObject();
    this.onScissorChanged(next);
  }

  /**
   * Backend hook: react to a size or pixel-ratio change.
   *
   * @param width New logical width in CSS pixels.
   * @param height New logical height in CSS pixels.
   * @param pixelRatio Active device-pixel ratio.
   */
  protected onSizeChanged(width: number, height: number, pixelRatio: number): void {
    void width;
    void height;
    void pixelRatio;
  }

  /**
   * Backend hook: react to a viewport change.
   *
   * @param viewport The new viewport, in device pixels.
   */
  protected onViewportChanged(viewport: Viewport): void {
    void viewport;
  }

  /**
   * Backend hook: react to a scissor change.
   *
   * @param scissor The new scissor, or `null` when scissoring was disabled.
   */
  protected onScissorChanged(scissor: Scissor | null): void {
    void scissor;
  }

  /* ------------------------------------------------------------------- clear */

  /** @inheritdoc */
  public setClearColor(color: ClearColorInput, alpha?: number): void {
    this.clearState.setColor(color, alpha);
  }

  /** @inheritdoc */
  public setClearAlpha(alpha: number): void {
    this.clearState.setAlpha(alpha);
  }

  /** @inheritdoc */
  public clear(color?: ClearColorInput | null, depth?: number, stencil?: number): void {
    this.ensureUsable('clear');
    this.requireReadyFor('clear');
    const resolved = this.clearState.resolve({
      color: color ?? null,
      depth,
      stencil,
      flags: ClearFlags.All,
    });
    this.clearSurface(resolved);
  }

  /** @inheritdoc */
  public clearWith(options: ClearOptions): void {
    this.ensureUsable('clearWith');
    this.requireReadyFor('clearWith');
    this.clearSurface(this.clearState.resolve(options));
  }

  /**
   * Backend hook: whether clearing is safe without a drawing surface.
   *
   * The SVG backend overrides this with `true`, because its output lives in the
   * DOM rather than in a colour buffer: with no DOM there is simply nothing to
   * fill, which is not an error.
   *
   * @returns `true` when {@link AbstractRenderer.clear} may run while headless.
   */
  protected allowsHeadlessClear(): boolean {
    return false;
  }

  /** Throws when the operation needs a surface the renderer does not have. */
  private requireReadyFor(operation: string): void {
    if (operation === 'clear' || operation === 'clearWith') {
      if (this.allowsHeadlessClear()) return;
    }
    this.requireReady();
  }

  /**
   * Backend hook: clear the current target.
   *
   * @param options Fully resolved clear description.
   */
  protected abstract clearSurface(options: {
    color: RGBA;
    depth: number;
    stencil: number;
    flags: ClearFlags;
  }): void;

  /* ------------------------------------------------------------------ render */

  /** @inheritdoc */
  public render(scene: SceneLike | null, camera?: CameraLike | null): void {
    this.ensureUsable('render');
    this.requireReady();
    if (this.disposed) return;

    this.lastScene = scene;
    this.lastCamera = camera ?? null;
    this.renderFrame();
  }

  /** @inheritdoc */
  public renderFrame(): void {
    this.ensureUsable('renderFrame');
    this.requireReady();
    if (this.disposed) return;

    this.updateAutoResize();

    const rawTime = now();
    const delta = this.computeDelta(rawTime);
    const frame = this.beginFrame(rawTime, delta);

    const pipeline = this.pipeline;
    if (pipeline !== null && pipeline.enabled) pipeline.render(frame);

    this.renderScene(this.lastScene, this.lastCamera, frame);
    this.endFrame(rawTime, delta);
  }

  /**
   * Backend hook: draw one frame.
   *
   * @param scene Scene handed to {@link AbstractRenderer.render}, or `null`.
   * @param camera Camera handed to {@link AbstractRenderer.render}, or `null`.
   * @param context Per-frame state, already sized and stamped.
   */
  protected abstract renderScene(
    scene: SceneLike | null,
    camera: CameraLike | null,
    context: RenderContext,
  ): void;

  /* -------------------------------------------------------------- animation */

  /** @inheritdoc */
  public setAnimationLoop(callback: AnimationLoopCallback | null, options: AnimationLoopOptions = {}): void {
    this.animationCallback = callback;
    if (options.maxDelta !== undefined) this.maxDelta = Math.max(0, options.maxDelta);

    if (callback === null) {
      this.stop();
      return;
    }
    if (options.autoStart ?? false) this.start();
  }

  /** Maximum delta (seconds) the loop reports. */
  protected maxDelta: number = MAX_DELTA;

  /** @inheritdoc */
  public start(): void {
    if (this.disposed || this.running || this.animationCallback === null) return;
    this.running = true;
    this.lastTime = null;
    this.scheduleNextFrame();
  }

  /** @inheritdoc */
  public stop(): void {
    this.running = false;
    if (this.frameHandle !== null) {
      cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  /** @inheritdoc */
  public isRunning(): boolean {
    return this.running;
  }

  /** Schedules the next animation frame. */
  private scheduleNextFrame(): void {
    if (!this.running) return;
    this.frameHandle = requestFrame((time: number) => {
      this.frameHandle = null;
      if (!this.running || this.disposed) return;

      const delta = this.computeDelta(time);
      const callback = this.animationCallback;
      this.elapsed += delta;

      try {
        callback?.(time, delta);
      } catch (error) {
        log.error('animation loop callback threw', error);
      }

      this.scheduleNextFrame();
    });
  }

  /** Computes and accumulates the frame delta. */
  private computeDelta(time: number): number {
    if (this.lastTime === null) {
      this.lastTime = time;
      return 0;
    }
    const seconds = (time - this.lastTime) / 1000;
    this.lastTime = time;
    return Math.min(this.maxDelta, Math.max(0, seconds));
  }

  /* ---------------------------------------------------------- frame plumbing */

  /**
   * Prepares the shared {@link RenderContext} for a frame.
   *
   * @param timestamp Raw clock reading.
   * @param delta Seconds since the previous frame.
   * @returns The prepared context.
   */
  protected beginFrame(timestamp: number, delta: number): RenderContext {
    this.frameIndex++;
    const frame = this.context;
    frame.begin(this.frameIndex, delta, this.elapsed, timestamp);
    frame.renderer = this;
    frame.stats = this.statistics;
    frame.target = this.currentTarget;
    frame.setSurface(
      this.logicalWidth,
      this.logicalHeight,
      this.ratio,
      this.currentViewport,
      this.scissor,
      this.clearState.getEffectiveColor(),
      this.lastCamera,
    );
    frame.renderState = this.renderState;

    this.statistics.drawCalls = 0;
    this.statistics.triangles = 0;
    this.statistics.vertices = 0;
    this.statistics.lines = 0;
    this.statistics.points = 0;
    this.statistics.objects = 0;
    this.statistics.culled = 0;
    return frame;
  }

  /**
   * Finalises frame statistics.
   *
   * @param timestamp Raw clock reading taken before the frame started.
   * @param delta Seconds since the previous frame.
   */
  protected endFrame(timestamp: number, delta: number): void {
    this.statistics.frame = this.frameIndex;
    this.statistics.frameTime = delta > 0 ? delta * 1000 : Math.max(0, now() - timestamp);
    this.statistics.fps = updateFps(this.statistics.fps, this.statistics.frameTime);
    this.elapsed += delta;
  }

  /** @inheritdoc */
  public resetStats(): void {
    resetRenderStats(this.statistics);
  }

  /* ---------------------------------------------------------- render targets */

  /** @inheritdoc */
  public createRenderTarget(options: RenderTargetOptions): IRenderTarget {
    this.ensureUsable('createRenderTarget');
    return this.onCreateRenderTarget(options);
  }

  /**
   * Backend hook: allocate an off-screen render target.
   *
   * The default implementation throws, which is the correct behaviour for
   * backends that can only draw into their own surface.
   *
   * @param options Target description.
   * @throws Error Always, unless a subclass overrides this method.
   */
  protected onCreateRenderTarget(options: RenderTargetOptions): IRenderTarget {
    throw new Error(
      `${this.backend}: off-screen render targets are not supported by this backend ` +
        `(requested ${options.width}x${options.height}). Use a GPU backend, or render ` +
        'directly into the canvas.',
    );
  }

  /** @inheritdoc */
  public setRenderTarget(target: IRenderTarget | null): void {
    if (target !== null && target.isDisposed) {
      throw new Error('setRenderTarget: the supplied target has already been disposed.');
    }
    this.currentTarget = target;
  }

  /** @inheritdoc */
  public getRenderTarget(): IRenderTarget | null {
    return this.currentTarget;
  }

  /* ------------------------------------------------------------------ resize */

  /** @inheritdoc */
  public onResize(callback: ResizeCallback): ResizeUnsubscribe {
    return this.resizeListeners.add(callback);
  }

  /* ----------------------------------------------------------------- dispose */

  /** @inheritdoc */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.stop();
    this.animationCallback = null;
    this.pipeline?.dispose();
    this.pipeline = null;
    this.resizeListeners.clear();
    this.currentTarget?.dispose();
    this.currentTarget = null;

    try {
      this.onDispose();
    } catch (error) {
      log.warn(`${this.backend}: onDispose threw`, error);
    }

    this.ready = false;
  }

  /**
   * Backend hook: release contexts and GPU resources.
   *
   * Errors thrown here are logged and swallowed by
   * {@link AbstractRenderer.dispose}.
   */
  protected onDispose(): void {
    /* backends override */
  }

  /** @inheritdoc */
  public isDisposed(): boolean {
    return this.disposed;
  }

  /* ----------------------------------------------------------------- helpers */

  /** Synchronises `surface.width`/`height` with the logical size and ratio. */
  private syncSurfaceSize(): void {
    const width = Math.max(1, Math.floor(this.logicalWidth * this.ratio));
    const height = Math.max(1, Math.floor(this.logicalHeight * this.ratio));
    if (this.surface.width === width && this.surface.height === height) return;

    this.surface.width = width;
    this.surface.height = height;
    this.sizeDirty = true;
  }

  /** Re-reads the display size when `autoResize` is enabled. */
  private updateAutoResize(): void {
    if (!this.resolved.autoResize) return;
    const display = readSurfaceDisplaySize(this.surface, {
      width: this.logicalWidth,
      height: this.logicalHeight,
    });
    if (display.width === this.logicalWidth && display.height === this.logicalHeight) return;
    this.setSize(display.width, display.height, false);
  }

  /** Throws a descriptive error when the renderer has no usable surface. */
  private requireReady(): void {
    if (!this.headless) return;
    throw new Error(
      `${this.backend}: the renderer has no drawing surface, so this operation cannot ` +
        'be performed. Provide `options.canvas` (a canvas or an OffscreenCanvas) or run ' +
        'in an environment with a DOM. Construction, `setSize`, `setPixelRatio`, `clear` ' +
        'and `dispose` remain safe in this state.',
    );
  }

  /** Throws a descriptive error when the renderer has been disposed. */
  private ensureUsable(operation: string): void {
    if (this.disposed) {
      throw new Error(`${this.backend}.${operation}(): the renderer has already been disposed.`);
    }
  }

  /** @returns A human-readable description of the renderer. */
  public toString(): string {
    return (
      `${this.constructor.name}(${this.backend}, ${this.logicalWidth}x${this.logicalHeight}` +
      ` @${this.ratio}x${this.headless ? ', headless' : ''})`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Free helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Result of binding a surface to the options the caller supplied. */
interface BoundSurface {
  surface: CanvasSurface;
  headless: boolean;
  width: number;
  height: number;
  pixelRatio: number;
}

/** Resolves the canvas option into a {@link CanvasSurface}. */
function bindSurface(options: ResolvedRendererOptions): BoundSurface {
  const ratio = resolvePixelRatio(options);
  const supplied = options.canvas;

  // 1. A DOM selector.
  if (typeof supplied === 'string') {
    const element = queryCanvas(supplied);
    if (element !== null) return finishBinding(element, options, ratio, false);
    log.warn(`no canvas matched the selector '${supplied}'; falling back to a created canvas`);
  }

  // 2. A canvas-like object supplied by the caller.
  const explicit = asCanvasLike(supplied);
  if (explicit !== null) return finishBinding(explicit, options, ratio, false);

  // 3. A container element: create a canvas inside it.
  const container = supplied != null && typeof supplied === 'object' ? (supplied as HTMLElement) : null;
  if (container !== null && typeof container.appendChild === 'function') {
    const created = tryCreateCanvas(options);
    if (created !== null) {
      container.appendChild(created as unknown as Node);
      return finishBinding(created, options, ratio, false);
    }
  }

  // 4. Create a detached canvas.
  const created = tryCreateCanvas(options);
  if (created !== null) return finishBinding(created, options, ratio, false);

  // 5. Headless.
  const width = Math.max(1, Math.floor(options.width ?? 300));
  const height = Math.max(1, Math.floor(options.height ?? 150));
  return { surface: createNullSurface(width, height), headless: true, width, height, pixelRatio: ratio };
}

/** Finalises a binding once a surface is known. */
function finishBinding(
  raw: unknown,
  options: ResolvedRendererOptions,
  ratio: number,
  headless: boolean,
): BoundSurface {
  const surface = raw as CanvasSurface;
  const measured = readSurfaceDisplaySize(surface, {
    width: typeof surface.width === 'number' && surface.width > 0 ? surface.width : 300,
    height: typeof surface.height === 'number' && surface.height > 0 ? surface.height : 150,
  });

  const width = Math.max(1, Math.floor(options.width ?? measured.width));
  const height = Math.max(1, Math.floor(options.height ?? measured.height));

  if (options.updateStyle) applySurfaceStyle(surface, width, height);

  return { surface, headless, width, height, pixelRatio: ratio };
}

/** Resolves the starting device-pixel ratio. */
function resolvePixelRatio(options: ResolvedRendererOptions): number {
  const max = options.maxPixelRatio;
  if (typeof options.pixelRatio === 'number' && Number.isFinite(options.pixelRatio)) {
    return Math.min(max, Math.max(1, options.pixelRatio));
  }
  return Math.min(max, readDevicePixelRatio(max));
}

/** Applies the CSS size, when the surface is a DOM element. */
function applySurfaceStyle(surface: CanvasSurface, width: number, height: number): void {
  if (!hasInlineStyle(surface)) return;
  const style = surface.style as { width: string; height: string };
  style.width = `${width}px`;
  style.height = `${height}px`;
}

/** Looks up a canvas through a selector, tolerating a missing DOM. */
function queryCanvas(selector: string): CanvasLike | null {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
  try {
    const found = document.querySelector(selector);
    if (found === null) return null;
    const canvas = asCanvasLike(found);
    return canvas;
  } catch {
    return null;
  }
}

/** Creates a canvas, returning `null` instead of throwing. */
function tryCreateCanvas(options: ResolvedRendererOptions): CanvasLike | null {
  try {
    return createCanvas({ width: options.width ?? 300, height: options.height ?? 150 });
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Statistics                                                                 */
/* -------------------------------------------------------------------------- */

/** Creates a zeroed {@link RenderStats}. */
export function createRenderStats(): RenderStats {
  return {
    frame: 0,
    drawCalls: 0,
    triangles: 0,
    vertices: 0,
    lines: 0,
    points: 0,
    objects: 0,
    culled: 0,
    textureUploads: 0,
    bufferUploads: 0,
    programCompiles: 0,
    stateChanges: 0,
    frameTime: 0,
    fps: 0,
  };
}

/** Resets the per-frame counters, keeping the cumulative ones. */
export function resetRenderStats(stats: RenderStats): void {
  stats.drawCalls = 0;
  stats.triangles = 0;
  stats.vertices = 0;
  stats.lines = 0;
  stats.points = 0;
  stats.objects = 0;
  stats.culled = 0;
  stats.frameTime = 0;
}

/** Smoothing factor applied to the frames-per-second estimate. */
const FPS_SMOOTHING = 0.1;

/** Blends a new frame duration into the FPS estimate. */
function updateFps(current: number, frameTimeMs: number): number {
  if (frameTimeMs <= 0) return current;
  const sample = 1000 / frameTimeMs;
  if (current <= 0) return sample;
  return current + (sample - current) * FPS_SMOOTHING;
}

/* -------------------------------------------------------------------------- */
/* Clock                                                                      */
/* -------------------------------------------------------------------------- */

/** Monotonic clock reading in milliseconds. */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Backend names supported by {@link AbstractRenderer}'s option resolution. */
export const SUPPORTED_BACKENDS: readonly BackendName[] = [
  BackendNames.Canvas2D,
  BackendNames.SVG,
  BackendNames.WebGL,
  BackendNames.WebGL2,
  BackendNames.WebGPU,
];
