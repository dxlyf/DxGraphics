/**
 * Immediate-mode Canvas2D drawing surface.
 *
 * `Canvas2DPainter` is the object handed to a 2D node's `render(painter)` method.
 * It wraps a `CanvasRenderingContext2D`, exposes the full drawing vocabulary the
 * library promises, and degrades to a *null painter* when no context exists
 * (headless Node) or the backend chose the SVG path.
 *
 * ## Coordinate space
 *
 * The painter draws in the space established by
 * `Canvas2DRenderer`'s camera transform: logical (CSS) pixels after the
 * device-pixel-ratio scale has been applied. Nodes therefore never multiply by
 * `devicePixelRatio` themselves.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import {
  Canvas2DState,
  type Canvas2DStateInit,
  type CanvasLineCap,
  type CanvasLineJoin,
  type CanvasPaint,
  type CanvasTextAlign,
  type CanvasTextBaseline,
} from './Canvas2DState';

/** Logger for painter diagnostics. */
const log = createLogger('renderer:canvas2d');

/** A point accepted by {@link Canvas2DPainter.polygon}. */
export interface CanvasPoint {
  x: number;
  y: number;
}

/** Options accepted by {@link Canvas2DPainter.drawImage}. */
export interface DrawImageOptions {
  /** Destination x. */
  dx: number;
  /** Destination y. */
  dy: number;
  /** Destination width; the source width is used when omitted. */
  dw?: number;
  /** Destination height; the source height is used when omitted. */
  dh?: number;
  /** Source x within the image. */
  sx?: number;
  /** Source y within the image. */
  sy?: number;
  /** Source width. */
  sw?: number;
  /** Source height. */
  sh?: number;
}

/** Text metrics returned by {@link Canvas2DPainter.measureText}. */
export interface PainterTextMetrics {
  /** Advance width of the measured text, in user-space units. */
  width: number;
  /** Distance from the baseline to the top of the em box, when reported. */
  actualBoundingBoxAscent?: number;
  /** Distance from the baseline to the bottom of the em box, when reported. */
  actualBoundingBoxDescent?: number;
  /** Full metrics object when the context reported one. */
  readonly native?: TextMetrics;
}

/**
 * The drawing surface exposed to 2D nodes.
 *
 * Every method is safe to call on a null painter: the call is counted and
 * discarded. That is what lets the same node render into Canvas2D, SVG or
 * nothing at all.
 */
export class Canvas2DPainter {
  /** Number of drawing operations issued through this painter. */
  public commandCount: number = 0;

  /** `true` when no real 2D context is attached. */
  public readonly headless: boolean;

  /** Fallback state used when there is no context. */
  public readonly state: Canvas2DState = new Canvas2DState();

  /** The wrapped context, or `null` on a null painter. */
  private context: CanvasRenderingContext2D | null;

  /** Depth of the explicit save/restore stack maintained by this painter. */
  private saveDepth: number = 0;

  /**
   * Creates a painter.
   *
   * @param context 2D context to draw into, or `null` for a null painter.
   */
  constructor(context: CanvasRenderingContext2D | null) {
    this.context = context;
    this.headless = context === null;
    if (context !== null) {
      try {
        this.state.fromContext(context as unknown as Parameters<Canvas2DState['fromContext']>[0]);
      } catch {
        /* a partial double may not expose every field */
      }
    }
  }

  /* ------------------------------------------------------------------ context */

  /**
   * Returns the wrapped context.
   *
   * @returns The 2D context, or `null` on a null painter.
   */
  public getContext(): CanvasRenderingContext2D | null {
    return this.context;
  }

  /**
   * Swaps in a different context.
   *
   * Used by `Canvas2DRenderer` when it re-acquires a context after a resize or a
   * context loss.
   *
   * @param context New context, or `null`.
   * @returns This painter, for chaining.
   */
  public setContext(context: CanvasRenderingContext2D | null): this {
    this.context = context;
    if (context !== null) {
      try {
        this.state.fromContext(context as unknown as Parameters<Canvas2DState['fromContext']>[0]);
      } catch {
        /* ignore partial implementations */
      }
    }
    return this;
  }

  /** @returns `true` when a real context is attached. */
  public get isReady(): boolean {
    return this.context !== null;
  }

  /** @returns The number of unmatched {@link Canvas2DPainter.save} calls. */
  public get depth(): number {
    return this.saveDepth;
  }

  /* ------------------------------------------------------------ state / stack */

  /** Pushes the current state onto the context stack. */
  public save(): void {
    this.commandCount++;
    if (this.context === null) return;
    this.syncStateToContext();
    this.context.save();
    this.saveDepth++;
  }

  /** Pops the most recent state off the context stack. */
  public restore(): void {
    this.commandCount++;
    if (this.context === null) return;
    if (this.saveDepth <= 0) {
      log.warnOnce('restore() called without a matching save(); the call is ignored');
      return;
    }
    this.context.restore();
    this.saveDepth--;
    try {
      this.state.fromContext(this.context as unknown as Parameters<Canvas2DState['fromContext']>[0]);
    } catch {
      /* ignore partial implementations */
    }
  }

  /**
   * Pops every unmatched {@link Canvas2DPainter.save}.
   *
   * The renderer calls this between nodes so one node cannot leak a transform or
   * a clip into the next.
   *
   * @returns The number of restores performed.
   */
  public restoreAll(): number {
    let restored = 0;
    while (this.saveDepth > 0) {
      this.restore();
      restored++;
    }
    return restored;
  }

  /** Resets every style field to its default. */
  public resetState(): void {
    this.state.reset();
    this.syncStateToContext();
  }

  /* ---------------------------------------------------------------- transform */

  /**
   * Multiplies the current transform.
   *
   * @param a Horizontal scaling.
   * @param b Vertical skewing.
   * @param c Horizontal skewing.
   * @param d Vertical scaling.
   * @param e Horizontal translation.
   * @param f Vertical translation.
   */
  public transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.commandCount++;
    if (this.context === null) return;
    this.context.transform(a, b, c, d, e, f);
    this.state.transform = multiplyTransform(this.state.transform, [a, b, c, d, e, f]);
  }

  /**
   * Translates the coordinate system.
   *
   * @param x Horizontal offset.
   * @param y Vertical offset.
   */
  public translate(x: number, y: number): void {
    this.commandCount++;
    if (this.context === null) return;
    this.context.translate(x, y);
    this.state.transform = multiplyTransform(this.state.transform, [1, 0, 0, 1, x, y]);
  }

  /**
   * Rotates the coordinate system clockwise.
   *
   * @param radians Rotation angle in radians.
   */
  public rotate(radians: number): void {
    this.commandCount++;
    if (this.context === null) return;
    this.context.rotate(radians);
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    this.state.transform = multiplyTransform(this.state.transform, [cos, sin, -sin, cos, 0, 0]);
  }

  /**
   * Scales the coordinate system.
   *
   * @param x Horizontal scale.
   * @param y Vertical scale; defaults to `x`.
   */
  public scale(x: number, y: number = x): void {
    this.commandCount++;
    if (this.context === null) return;
    this.context.scale(x, y);
    this.state.transform = multiplyTransform(this.state.transform, [x, 0, 0, y, 0, 0]);
  }

  /**
   * Replaces the current transform.
   *
   * @param a Horizontal scaling.
   * @param b Vertical skewing.
   * @param c Horizontal skewing.
   * @param d Vertical scaling.
   * @param e Horizontal translation.
   * @param f Vertical translation.
   */
  public setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.commandCount++;
    if (this.context === null) return;
    this.context.setTransform(a, b, c, d, e, f);
    this.state.transform = [a, b, c, d, e, f];
  }

  /** Resets the transform to the identity without touching the state stack. */
  public resetTransform(): void {
    this.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** @returns The current transform as `[a, b, c, d, e, f]`. */
  public getTransform(): [number, number, number, number, number, number] {
    const context = this.context;
    if (context !== null && typeof context.getTransform === 'function') {
      const matrix = context.getTransform();
      return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
    }
    return [...this.state.transform];
  }

  /* --------------------------------------------------------------------- paths */

  /** Starts a new path. */
  public beginPath(): void {
    this.commandCount++;
    this.context?.beginPath();
  }

  /** Closes the current sub-path. */
  public closePath(): void {
    this.commandCount++;
    this.context?.closePath();
  }

  /**
   * Starts a new sub-path at a point.
   *
   * @param x Horizontal position.
   * @param y Vertical position.
   */
  public moveTo(x: number, y: number): void {
    this.commandCount++;
    this.context?.moveTo(x, y);
  }

  /**
   * Adds a straight segment.
   *
   * @param x Horizontal position.
   * @param y Vertical position.
   */
  public lineTo(x: number, y: number): void {
    this.commandCount++;
    this.context?.lineTo(x, y);
  }

  /**
   * Adds a cubic Bézier segment.
   *
   * @param cp1x First control point x.
   * @param cp1y First control point y.
   * @param cp2x Second control point x.
   * @param cp2y Second control point y.
   * @param x End point x.
   * @param y End point y.
   */
  public bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    this.commandCount++;
    this.context?.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }

  /**
   * Adds a quadratic Bézier segment.
   *
   * @param cpx Control point x.
   * @param cpy Control point y.
   * @param x End point x.
   * @param y End point y.
   */
  public quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.commandCount++;
    this.context?.quadraticCurveTo(cpx, cpy, x, y);
  }

  /**
   * Adds a circular arc.
   *
   * @param x Centre x.
   * @param y Centre y.
   * @param radius Radius; must be non-negative.
   * @param startAngle Start angle in radians.
   * @param endAngle End angle in radians.
   * @param counterclockwise Draw anticlockwise.
   */
  public arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise: boolean = false,
  ): void {
    this.commandCount++;
    if (this.context === null) return;
    if (radius < 0) {
      log.warnOnce('arc() called with a negative radius; the call is ignored');
      return;
    }
    this.context.arc(x, y, radius, startAngle, endAngle, counterclockwise);
  }

  /**
   * Adds an arc between the current point and `(x2, y2)`.
   *
   * @param x1 First tangent point x.
   * @param y1 First tangent point y.
   * @param x2 Second tangent point x.
   * @param y2 Second tangent point y.
   * @param radius Corner radius.
   */
  public arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    this.commandCount++;
    this.context?.arcTo(x1, y1, x2, y2, radius);
  }

  /**
   * Adds an axis-aligned rectangle as a closed sub-path.
   *
   * @param x Left edge.
   * @param y Top edge.
   * @param width Width.
   * @param height Height.
   */
  public rect(x: number, y: number, width: number, height: number): void {
    this.commandCount++;
    this.context?.rect(x, y, width, height);
  }

  /**
   * Adds a rectangle with rounded corners.
   *
   * Falls back to `rect()` when the runtime lacks `roundRect` (older Safari).
   *
   * @param x Left edge.
   * @param y Top edge.
   * @param width Width.
   * @param height Height.
   * @param radii Corner radius, or one radius per corner in the order
   *   `[top-left, top-right, bottom-right, bottom-left]`.
   */
  public roundRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radii: number | readonly [number, number, number, number] = 0,
  ): void {
    this.commandCount++;
    const context = this.context;
    if (context === null) return;

    const nativeRoundRect = (context as unknown as { roundRect?: (...args: unknown[]) => void }).roundRect;
    if (typeof nativeRoundRect === 'function') {
      if (Array.isArray(radii)) nativeRoundRect.call(context, x, y, width, height, radii);
      else nativeRoundRect.call(context, x, y, width, height, radii);
      return;
    }

    // Fallback: approximate with arcs.
    const corners = typeof radii === 'number' ? [radii, radii, radii, radii] : radii;
    const maxRadius = Math.min(Math.abs(width), Math.abs(height)) / 2;
    const [tl, tr, br, bl] = corners.map((value) => Math.max(0, Math.min(maxRadius, value)));
    context.moveTo(x + tl, y);
    context.lineTo(x + width - tr, y);
    if (tr > 0) context.arcTo(x + width, y, x + width, y + tr, tr);
    context.lineTo(x + width, y + height - br);
    if (br > 0) context.arcTo(x + width, y + height, x + width - br, y + height, br);
    context.lineTo(x + bl, y + height);
    if (bl > 0) context.arcTo(x, y + height, x, y + height - bl, bl);
    context.lineTo(x, y + tl);
    if (tl > 0) context.arcTo(x, y, x + tl, y, tl);
    context.closePath();
  }

  /**
   * Adds an ellipse.
   *
   * @param x Centre x.
   * @param y Centre y.
   * @param radiusX Horizontal radius.
   * @param radiusY Vertical radius.
   * @param rotation Rotation in radians.
   * @param startAngle Start angle in radians.
   * @param endAngle End angle in radians.
   * @param counterclockwise Draw anticlockwise.
   */
  public ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number = 0,
    startAngle: number = 0,
    endAngle: number = Math.PI * 2,
    counterclockwise: boolean = false,
  ): void {
    this.commandCount++;
    const context = this.context;
    if (context === null) return;
    if (typeof context.ellipse === 'function') {
      context.ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise);
      return;
    }
    // Fallback: scale a circular arc.
    context.save();
    context.translate(x, y);
    context.rotate(rotation);
    context.scale(radiusX, radiusY);
    context.arc(0, 0, 1, startAngle, endAngle, counterclockwise);
    context.restore();
  }

  /**
   * Adds a polygon through a list of points.
   *
   * Convenience wrapper over `beginPath`/`moveTo`/`lineTo`/`closePath`; it leaves
   * the path open (not filled) so the caller can choose `fill()` or `stroke()`.
   *
   * @param points Vertices, in order.
   * @param close Close the path back to the first point. Defaults to `true`.
   * @returns This painter, for chaining.
   */
  public polygon(points: readonly CanvasPoint[], close: boolean = true): this {
    if (points.length === 0) return this;
    this.beginPath();
    this.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) this.lineTo(points[i].x, points[i].y);
    if (close) this.closePath();
    return this;
  }

  /* ------------------------------------------------------------------- painting */

  /** Fills the current path with {@link Canvas2DPainter.fillStyle}. */
  public fill(): void {
    this.commandCount++;
    this.context?.fill();
  }

  /** Strokes the current path with {@link Canvas2DPainter.strokeStyle}. */
  public stroke(): void {
    this.commandCount++;
    this.context?.stroke();
  }

  /**
   * Intersects the clipping region with the current path.
   *
   * @param path Optional `Path2D` to clip against instead of the current path.
   */
  public clip(path?: unknown): void {
    this.commandCount++;
    const context = this.context;
    if (context === null) return;
    if (path === undefined) context.clip();
    else (context.clip as (candidate: unknown) => void)(path);
  }

  /**
   * Fills a rectangle immediately, without touching the current path.
   *
   * @param x Left edge.
   * @param y Top edge.
   * @param width Width.
   * @param height Height.
   */
  public fillRect(x: number, y: number, width: number, height: number): void {
    this.commandCount++;
    this.context?.fillRect(x, y, width, height);
  }

  /**
   * Strokes a rectangle immediately, without touching the current path.
   *
   * @param x Left edge.
   * @param y Top edge.
   * @param width Width.
   * @param height Height.
   */
  public strokeRect(x: number, y: number, width: number, height: number): void {
    this.commandCount++;
    this.context?.strokeRect(x, y, width, height);
  }

  /**
   * Clears a rectangle to transparent black.
   *
   * @param x Left edge.
   * @param y Top edge.
   * @param width Width.
   * @param height Height.
   */
  public clearRect(x: number, y: number, width: number, height: number): void {
    this.commandCount++;
    this.context?.clearRect(x, y, width, height);
  }

  /**
   * Draws an image, a canvas or a bitmap.
   *
   * The three-, five- and nine-argument canvas overloads are all reachable through
   * {@link DrawImageOptions}.
   *
   * @param image Source to draw.
   * @param options Destination and optional source rectangle.
   */
  public drawImage(image: unknown, options: DrawImageOptions): void {
    this.commandCount++;
    const context = this.context;
    if (context === null || image == null) return;

    const { dx, dy, dw, dh, sx, sy, sw, sh } = options;
    const source = image as CanvasImageSource;

    try {
      if (sx !== undefined && sy !== undefined && sw !== undefined && sh !== undefined) {
        context.drawImage(source, sx, sy, sw, sh, dx, dy, dw ?? sw, dh ?? sh);
      } else if (dw !== undefined && dh !== undefined) {
        context.drawImage(source, dx, dy, dw, dh);
      } else {
        context.drawImage(source, dx, dy);
      }
    } catch (error) {
      log.warnOnce(`drawImage() failed: ${(error as Error).message}`);
    }
  }

  /**
   * Fills text immediately.
   *
   * @param text Text to draw.
   * @param x Baseline origin x.
   * @param y Baseline origin y.
   * @param maxWidth Optional maximum advance width.
   */
  public fillText(text: string, x: number, y: number, maxWidth?: number): void {
    this.commandCount++;
    const context = this.context;
    if (context === null) return;
    if (maxWidth === undefined) context.fillText(text, x, y);
    else context.fillText(text, x, y, maxWidth);
  }

  /**
   * Strokes text immediately.
   *
   * @param text Text to draw.
   * @param x Baseline origin x.
   * @param y Baseline origin y.
   * @param maxWidth Optional maximum advance width.
   */
  public strokeText(text: string, x: number, y: number, maxWidth?: number): void {
    this.commandCount++;
    const context = this.context;
    if (context === null) return;
    if (maxWidth === undefined) context.strokeText(text, x, y);
    else context.strokeText(text, x, y, maxWidth);
  }

  /**
   * Measures text with the current font.
   *
   * @param text Text to measure.
   * @returns A {@link PainterTextMetrics}; zero-width on a null painter.
   */
  public measureText(text: string): PainterTextMetrics {
    this.commandCount++;
    const context = this.context;
    if (context === null) return { width: 0 };
    const metrics = context.measureText(text);
    return {
      width: metrics.width,
      actualBoundingBoxAscent: metrics.actualBoundingBoxAscent,
      actualBoundingBoxDescent: metrics.actualBoundingBoxDescent,
      native: metrics,
    };
  }

  /* ------------------------------------------------------------------ gradients */

  /**
   * Creates a linear gradient.
   *
   * @param x0 Start x.
   * @param y0 Start y.
   * @param x1 End x.
   * @param y1 End y.
   * @returns The gradient, or `null` on a null painter.
   */
  public createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient | null {
    this.commandCount++;
    return this.context?.createLinearGradient(x0, y0, x1, y1) ?? null;
  }

  /**
   * Creates a radial gradient.
   *
   * @param x0 Inner circle centre x.
   * @param y0 Inner circle centre y.
   * @param r0 Inner radius.
   * @param x1 Outer circle centre x.
   * @param y1 Outer circle centre y.
   * @param r1 Outer radius.
   * @returns The gradient, or `null` on a null painter.
   */
  public createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): CanvasGradient | null {
    this.commandCount++;
    return this.context?.createRadialGradient(x0, y0, r0, x1, y1, r1) ?? null;
  }

  /**
   * Creates a conic gradient.
   *
   * @param x Centre x.
   * @param y Centre y.
   * @param startAngle Start angle in radians.
   * @returns The gradient, or `null` when the runtime lacks `createConicGradient`.
   */
  public createConicGradient(x: number, y: number, startAngle: number = 0): CanvasGradient | null {
    this.commandCount++;
    const context = this.context;
    if (context === null) return null;
    const create = (context as unknown as {
      createConicGradient?: (angle: number, x: number, y: number) => CanvasGradient;
    }).createConicGradient;
    return typeof create === 'function' ? create.call(context, startAngle, x, y) : null;
  }

  /* -------------------------------------------------------------- pixels / paths */

  /**
   * Reads back a region of the canvas.
   *
   * @param x Left edge.
   * @param y Top edge.
   * @param width Region width.
   * @param height Region height.
   * @returns The pixel data, or `null` when readback is unsupported.
   */
  public getImageData(x: number, y: number, width: number, height: number): ImageData | null {
    const context = this.context;
    if (context === null) return null;
    if (typeof context.getImageData !== 'function') return null;
    try {
      return context.getImageData(x, y, width, height);
    } catch (error) {
      log.warnOnce(`getImageData() failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Writes pixel data into the canvas.
   *
   * @param data Pixel data to write.
   * @param dx Destination x.
   * @param dy Destination y.
   */
  public putImageData(data: ImageData, dx: number, dy: number): void {
    this.commandCount++;
    this.context?.putImageData(data, dx, dy);
  }

  /**
   * Materialises the current path as a `Path2D`.
   *
   * The builder callback receives a `Path2D` when the runtime has one; otherwise a
   * no-op recorder is passed and `null` is returned. Callers that need a real path
   * should feature-detect with `typeof Path2D !== 'undefined'`.
   *
   * @param build Callback that records the path commands.
   * @returns The `Path2D`, or `null` when unsupported.
   */
  public toPath2D(build?: (path: Path2D) => void): Path2D | null {
    const constructor = (globalThis as unknown as { Path2D?: new () => Path2D }).Path2D;
    if (typeof constructor !== 'function') return null;
    const path = new constructor();
    if (build) build(path);
    return path;
  }

  /**
   * Adds a `Path2D` to the current path.
   *
   * @param path Path to add.
   */
  public addPath(path: Path2D): void {
    this.commandCount++;
    const context = this.context as unknown as { addPath?: (candidate: Path2D) => void } | null;
    context?.addPath?.(path);
  }

  /**
   * Draws a `Path2D`.
   *
   * @param path Path to draw.
   * @param mode Whether to fill, stroke, or both.
   */
  public drawPath(path: Path2D, mode: 'fill' | 'stroke' | 'both' = 'fill'): void {
    this.commandCount++;
    const context = this.context;
    if (context === null || path == null) return;
    if (mode === 'fill' || mode === 'both') context.fill(path);
    if (mode === 'stroke' || mode === 'both') context.stroke(path);
  }

  /* -------------------------------------------------------------------- styles */

  /** Current fill paint. */
  public get fillStyle(): CanvasPaint {
    return this.context !== null ? this.context.fillStyle : this.state.fillStyle;
  }

  /** Sets the fill paint. */
  public set fillStyle(value: CanvasPaint) {
    this.state.fillStyle = value;
    if (this.context !== null) this.context.fillStyle = value;
  }

  /** Current stroke paint. */
  public get strokeStyle(): CanvasPaint {
    return this.context !== null ? this.context.strokeStyle : this.state.strokeStyle;
  }

  /** Sets the stroke paint. */
  public set strokeStyle(value: CanvasPaint) {
    this.state.strokeStyle = value;
    if (this.context !== null) this.context.strokeStyle = value;
  }

  /** Current stroke width. */
  public get lineWidth(): number {
    return this.context !== null ? this.context.lineWidth : this.state.lineWidth;
  }

  /** Sets the stroke width. */
  public set lineWidth(value: number) {
    this.state.lineWidth = value;
    if (this.context !== null) this.context.lineWidth = value;
  }

  /** Current line cap. */
  public get lineCap(): CanvasLineCap {
    return this.context !== null ? (this.context.lineCap as CanvasLineCap) : this.state.lineCap;
  }

  /** Sets the line cap. */
  public set lineCap(value: CanvasLineCap) {
    this.state.lineCap = value;
    if (this.context !== null) this.context.lineCap = value;
  }

  /** Current line join. */
  public get lineJoin(): CanvasLineJoin {
    return this.context !== null ? (this.context.lineJoin as CanvasLineJoin) : this.state.lineJoin;
  }

  /** Sets the line join. */
  public set lineJoin(value: CanvasLineJoin) {
    this.state.lineJoin = value;
    if (this.context !== null) this.context.lineJoin = value;
  }

  /** Current miter limit. */
  public get miterLimit(): number {
    return this.context !== null ? this.context.miterLimit : this.state.miterLimit;
  }

  /** Sets the miter limit. */
  public set miterLimit(value: number) {
    this.state.miterLimit = value;
    if (this.context !== null) this.context.miterLimit = value;
  }

  /** Current CSS font shorthand. */
  public get font(): string {
    return this.context !== null ? this.context.font : this.state.font;
  }

  /** Sets the CSS font shorthand. */
  public set font(value: string) {
    this.state.font = value;
    if (this.context !== null) this.context.font = value;
  }

  /** Current horizontal text alignment. */
  public get textAlign(): CanvasTextAlign {
    return this.context !== null ? (this.context.textAlign as CanvasTextAlign) : this.state.textAlign;
  }

  /** Sets the horizontal text alignment. */
  public set textAlign(value: CanvasTextAlign) {
    this.state.textAlign = value;
    if (this.context !== null) this.context.textAlign = value;
  }

  /** Current vertical text baseline. */
  public get textBaseline(): CanvasTextBaseline {
    return this.context !== null
      ? (this.context.textBaseline as CanvasTextBaseline)
      : this.state.textBaseline;
  }

  /** Sets the vertical text baseline. */
  public set textBaseline(value: CanvasTextBaseline) {
    this.state.textBaseline = value;
    if (this.context !== null) this.context.textBaseline = value;
  }

  /** Current compositing operator. */
  public get globalCompositeOperation(): string {
    return this.context !== null ? this.context.globalCompositeOperation : this.state.globalCompositeOperation;
  }

  /** Sets the compositing operator. Unknown operators are passed through as-is. */
  public set globalCompositeOperation(value: string) {
    this.state.globalCompositeOperation = value;
    if (this.context !== null) {
      this.context.globalCompositeOperation = value as GlobalCompositeOperation;
    }
  }

  /** Current shadow blur radius. */
  public get shadowBlur(): number {
    return this.context !== null ? this.context.shadowBlur : this.state.shadowBlur;
  }

  /** Sets the shadow blur radius. */
  public set shadowBlur(value: number) {
    this.state.shadowBlur = value;
    if (this.context !== null) this.context.shadowBlur = value;
  }

  /** Current shadow colour. */
  public get shadowColor(): string {
    return this.context !== null ? this.context.shadowColor : this.state.shadowColor;
  }

  /** Sets the shadow colour. */
  public set shadowColor(value: string) {
    this.state.shadowColor = value;
    if (this.context !== null) this.context.shadowColor = value;
  }

  /** Current shadow horizontal offset. */
  public get shadowOffsetX(): number {
    return this.context !== null ? this.context.shadowOffsetX : this.state.shadowOffsetX;
  }

  /** Sets the shadow horizontal offset. */
  public set shadowOffsetX(value: number) {
    this.state.shadowOffsetX = value;
    if (this.context !== null) this.context.shadowOffsetX = value;
  }

  /** Current shadow vertical offset. */
  public get shadowOffsetY(): number {
    return this.context !== null ? this.context.shadowOffsetY : this.state.shadowOffsetY;
  }

  /** Sets the shadow vertical offset. */
  public set shadowOffsetY(value: number) {
    this.state.shadowOffsetY = value;
    if (this.context !== null) this.context.shadowOffsetY = value;
  }

  /** Current global alpha. */
  public get globalAlpha(): number {
    return this.context !== null ? this.context.globalAlpha : this.state.globalAlpha;
  }

  /** Sets the global alpha, clamped to 0..1. */
  public set globalAlpha(value: number) {
    const clamped = Math.max(0, Math.min(1, value));
    this.state.globalAlpha = clamped;
    if (this.context !== null) this.context.globalAlpha = clamped;
  }

  /**
   * Alias of {@link Canvas2DPainter.globalAlpha} with clamping.
   *
   * @param alpha New alpha in 0..1.
   * @returns This painter, for chaining.
   */
  public setAlpha(alpha: number): this {
    this.globalAlpha = alpha;
    return this;
  }

  /**
   * Sets the line dash pattern.
   *
   * A runtime without `setLineDash` ignores the call.
   *
   * @param segments Dash lengths in user-space units; `[]` restores solid lines.
   * @returns This painter, for chaining.
   */
  public setLineDash(segments: readonly number[]): this {
    this.commandCount++;
    const context = this.context as unknown as { setLineDash?: (value: number[]) => void } | null;
    context?.setLineDash?.([...segments]);
    return this;
  }

  /**
   * Reads the current line dash pattern.
   *
   * @returns The dash segments, or an empty array when unsupported.
   */
  public getLineDash(): number[] {
    const context = this.context as unknown as { getLineDash?: () => number[] } | null;
    return context?.getLineDash?.() ?? [];
  }

  /** @returns A human-readable description of the painter. */
  public toString(): string {
    return `Canvas2DPainter(${this.headless ? 'null painter' : 'live'}, commands=${this.commandCount})`;
  }

  /* -------------------------------------------------------------------- internals */

  /** Flushes the cached state into the context before a `save()`. */
  private syncStateToContext(): void {
    const context = this.context;
    if (context === null) return;
    context.fillStyle = this.state.fillStyle;
    context.strokeStyle = this.state.strokeStyle;
    context.lineWidth = this.state.lineWidth;
    context.lineCap = this.state.lineCap;
    context.lineJoin = this.state.lineJoin;
    context.miterLimit = this.state.miterLimit;
    context.font = this.state.font;
    context.textAlign = this.state.textAlign;
    context.textBaseline = this.state.textBaseline;
    context.globalAlpha = this.state.globalAlpha;
    context.globalCompositeOperation = this.state.globalCompositeOperation as GlobalCompositeOperation;
    context.shadowBlur = this.state.shadowBlur;
    context.shadowColor = this.state.shadowColor;
    context.shadowOffsetX = this.state.shadowOffsetX;
    context.shadowOffsetY = this.state.shadowOffsetY;
  }
}

/**
 * Multiplies two canvas transforms.
 *
 * Both operands are `[a, b, c, d, e, f]`, matching the canvas API's column layout.
 *
 * @param left Outer transform.
 * @param right Transform applied first.
 * @returns The composed transform.
 */
export function multiplyTransform(
  left: readonly [number, number, number, number, number, number],
  right: readonly [number, number, number, number, number, number],
): [number, number, number, number, number, number] {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

/** Re-exported state initialiser type, for callers that build painters by hand. */
export type { Canvas2DStateInit };
