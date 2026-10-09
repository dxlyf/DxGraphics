/**
 * Backend-agnostic renderer contract.
 *
 * `IRenderer` is the only interface a scene, an application or a UI control needs
 * to talk to. Concrete implementations (`Canvas2DRenderer`, `SVGRenderer`, and
 * the WebGL/WebGPU backends owned by other layers) all satisfy it.
 *
 * ## Canvas semantics
 *
 * - `width`/`height` are **logical (CSS) pixels**.
 * - `canvas.width`/`canvas.height` are **device pixels**, equal to
 *   `width * pixelRatio` (rounded).
 * - `setViewport`/`setScissor` take device pixels unless the backend documents
 *   otherwise on the method.
 *
 * @packageDocumentation
 */

import type { BackendName } from '../../constants';
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
} from './types';
import type { IRenderTarget } from './IRenderTarget';

/**
 * A camera, structurally described.
 *
 * The renderer only needs a view/projection pair (and, for 2D backends, optional
 * pan/zoom). Anything satisfying this shape is accepted; the scene layer's
 * concrete `Camera` classes all do.
 */
export interface CameraLike {
  /** Column-major 4x4 world→view matrix, when the camera is 3D. */
  readonly viewMatrix?: { elements: ArrayLike<number> } | null;
  /** Column-major 4x4 view→clip matrix, when the camera is 3D. */
  readonly projectionMatrix?: { elements: ArrayLike<number> } | null;
  /**
   * `true` when this is an orthographic/2D camera whose transform is a plain
   * pan/zoom rather than a full 3D projection.
   */
  readonly isOrthographic?: boolean;
  /** Pan offset in world units, for 2D cameras. */
  readonly position?: { x: number; y: number; z?: number };
  /** Zoom/scale factor, for 2D cameras. */
  readonly zoom?: number;
  /** Rotation in radians about the view axis, for 2D cameras. */
  readonly rotation?: number;
  /** Marks the camera as usable; defaults to `true` when absent. */
  readonly visible?: boolean;
}

/**
 * A scene, structurally described.
 *
 * `renderer.render` walks the scene's renderables in the order it reports them;
 * the traversal itself stays owned by the scene layer.
 */
export interface SceneLike {
  /** `true` when the scene should contribute geometry this frame. */
  readonly visible?: boolean;
  /**
   * Collects the scene's renderables into the supplied render list.
   *
   * When absent, the renderer falls back to reading {@link SceneLike.children}.
   *
   * @param list Render list to fill.
   * @param camera Camera for the frame.
   */
  collectRenderables?: (list: unknown, camera: unknown) => void;
  /** Direct children, used by the fallback traversal. */
  readonly children?: readonly unknown[];
  /** Background override for this scene, when present. */
  readonly background?: unknown;
}

/**
 * Callback invoked for every animation frame.
 *
 * @param time Milliseconds since the page/process origin (`performance.now()`).
 * @param delta Seconds since the previous frame, clamped by the renderer.
 */
export type AnimationLoopCallback = (time: number, delta: number) => void;

/** Unsubscribe handle returned by {@link IRenderer.onResize}. */
export type ResizeUnsubscribe = () => void;

/**
 * Callback invoked after the drawing buffer has been resized.
 *
 * @param width New logical width in CSS pixels.
 * @param height New logical height in CSS pixels.
 * @param pixelRatio Active device-pixel ratio.
 */
export type ResizeCallback = (width: number, height: number, pixelRatio: number) => void;

/** The contract every backend implementation fulfils. */
export interface IRenderer {
  /** Backend identifier. */
  readonly backend: BackendName;

  /**
   * Host element the renderer owns.
   *
   * For canvas backends this is the canvas itself when it is a DOM node; for the
   * SVG backend it is a wrapper `<div>`. `null` on a headless/null surface.
   */
  readonly domElement: HTMLElement | null;

  /** Drawing surface, or `null` when the renderer runs without a canvas. */
  readonly canvas: HTMLCanvasElement | null;

  /** Logical width in CSS pixels. */
  readonly width: number;

  /** Logical height in CSS pixels. */
  readonly height: number;

  /** Active device-pixel ratio. */
  readonly pixelRatio: number;

  /** Immutable-ish description of the live renderer. */
  readonly info: RendererInfo;

  /** Mutable per-frame counters. Reset by {@link IRenderer.resetStats}. */
  readonly stats: RenderStats;

  /** Options the renderer was constructed with, normalised. */
  readonly options: Readonly<RendererOptions>;

  /** Current viewport, in device pixels. */
  readonly viewport: ViewportLike;

  /** Current scissor rectangle, or `null` when scissoring is disabled. */
  readonly scissor: ScissorRect | null;

  /** Current clear colour as 0..1 RGBA channels. */
  readonly clearColor: { r: number; g: number; b: number; a: number };

  /**
   * Resizes the renderer.
   *
   * @param width New logical width in CSS pixels.
   * @param height New logical height in CSS pixels.
   * @param updateStyle Also update the canvas' CSS size. Defaults to `true`.
   */
  setSize(width: number, height: number, updateStyle?: boolean): void;

  /**
   * Sets the device-pixel ratio and resizes the drawing buffer accordingly.
   *
   * @param ratio New ratio, clamped to `[1, options.maxPixelRatio]`.
   */
  setPixelRatio(ratio: number): void;

  /** @returns The active device-pixel ratio. */
  getPixelRatio(): number;

  /**
   * Sets the drawing-buffer viewport.
   *
   * @param viewport Rectangle in device pixels, relative to the top-left corner
   *   for the 2D backends.
   */
  setViewport(viewport: ViewportLike): void;

  /**
   * Enables or disables scissor clipping.
   *
   * @param scissor Rectangle in device pixels, or `null` to disable.
   */
  setScissor(scissor: ScissorRect | null): void;

  /**
   * Sets the clear/background colour.
   *
   * @param color CSS string, 24-bit integer or `{ r, g, b }` object.
   * @param alpha Optional alpha override in 0..1.
   */
  setClearColor(color: ClearColorInput, alpha?: number): void;

  /**
   * Sets the alpha used by {@link IRenderer.clear} while keeping the RGB colour.
   *
   * @param alpha Alpha in 0..1.
   */
  setClearAlpha(alpha: number): void;

  /**
   * Clears the current render target.
   *
   * @param color Colour override, or `null` to use the configured clear colour.
   * @param depth Depth value to write, when the backend has a depth buffer.
   * @param stencil Stencil value to write, when the backend has a stencil buffer.
   */
  clear(color?: ClearColorInput | null, depth?: number, stencil?: number): void;

  /**
   * Clears with explicit flags, for backends that expose buffer masks.
   *
   * @param options Clear description.
   */
  clearWith(options: ClearOptions): void;

  /**
   * Renders a scene with a camera.
   *
   * @param scene Scene to render; structurally typed as {@link SceneLike}.
   * @param camera Camera for the frame; structurally typed as {@link CameraLike}.
   * @throws Error When the renderer has no usable surface (headless Node).
   */
  render(scene: SceneLike | null, camera?: CameraLike | null): void;

  /**
   * Creates an off-screen render target.
   *
   * @param options Target description.
   * @throws Error When the backend does not support render targets.
   */
  createRenderTarget(options: RenderTargetOptions): IRenderTarget;

  /**
   * Binds a render target, or `null` to draw into the canvas.
   *
   * @param target Target to bind.
   */
  setRenderTarget(target: IRenderTarget | null): void;

  /** @returns The currently bound render target, or `null` for the canvas. */
  getRenderTarget(): IRenderTarget | null;

  /**
   * Registers a resize listener.
   *
   * @param callback Invoked after every size/pixel-ratio change.
   * @returns A function that removes the listener.
   */
  onResize(callback: ResizeCallback): ResizeUnsubscribe;

  /**
   * Installs (or clears) the animation loop callback.
   *
   * Passing `null` stops the loop and clears the callback.
   *
   * @param callback Per-frame callback, or `null`.
   * @param options Loop tuning.
   */
  setAnimationLoop(callback: AnimationLoopCallback | null, options?: AnimationLoopOptions): void;

  /** Starts the animation loop. A no-op when no callback is installed. */
  start(): void;

  /** Stops the animation loop, keeping the installed callback. */
  stop(): void;

  /** @returns `true` while the animation loop is running. */
  isRunning(): boolean;

  /** Renders a single frame without involving the animation loop. */
  renderFrame(): void;

  /** Resets the per-frame {@link IRenderer.stats} counters. */
  resetStats(): void;

  /** Releases every resource owned by the renderer. */
  dispose(): void;

  /** @returns `true` once {@link IRenderer.dispose} has run. */
  isDisposed(): boolean;
}
