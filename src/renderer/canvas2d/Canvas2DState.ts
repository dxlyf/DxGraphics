/**
 * Canvas2D painter state.
 *
 * A `Canvas2DState` captures the subset of state that
 * `CanvasRenderingContext2D.save()`/`restore()` round-trips: styles, line
 * attributes, text attributes, transforms, clipping/alpha/compositing and shadows.
 * It exists so that the SVG backend, the render list and the tests can reason
 * about painter state without a live context.
 *
 * @packageDocumentation
 */

/** Canvas 2D line-cap values. */
export type CanvasLineCap = 'butt' | 'round' | 'square';

/** Canvas 2D line-join values. */
export type CanvasLineJoin = 'bevel' | 'round' | 'miter';

/** Canvas 2D text alignment values. */
export type CanvasTextAlign = 'start' | 'end' | 'left' | 'right' | 'center';

/** Canvas 2D text baseline values. */
export type CanvasTextBaseline =
  | 'top'
  | 'hanging'
  | 'middle'
  | 'alphabetic'
  | 'ideographic'
  | 'bottom';

/** Anything the painter accepts where a paint is expected. */
export type CanvasPaint = string | CanvasGradient | CanvasPattern;

/** Options accepted by {@link Canvas2DState.from}. */
export interface Canvas2DStateInit {
  fillStyle?: CanvasPaint;
  strokeStyle?: CanvasPaint;
  lineWidth?: number;
  lineCap?: CanvasLineCap;
  lineJoin?: CanvasLineJoin;
  miterLimit?: number;
  font?: string;
  textAlign?: CanvasTextAlign;
  textBaseline?: CanvasTextBaseline;
  globalAlpha?: number;
  globalCompositeOperation?: string;
  shadowBlur?: number;
  shadowColor?: string;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  /** Transform as `[a, b, c, d, e, f]`. Defaults to the identity. */
  transform?: readonly [number, number, number, number, number, number];
  /** Current clip region, when one is known. */
  clip?: unknown;
}

/** Default font used when a caller never sets one. */
export const DEFAULT_CANVAS_FONT = '10px sans-serif';

/**
 * The save/restore-able subset of painter state.
 *
 * ```ts
 * const state = new Canvas2DState().set({ fillStyle: '#f00' });
 * const copy = state.clone();
 * copy.equals(state);   // true
 * copy.apply(painter);  // writes every field back into a live context
 * ```
 */
export class Canvas2DState {
  /** Fill paint. */
  public fillStyle: CanvasPaint = '#000000';

  /** Stroke paint. */
  public strokeStyle: CanvasPaint = '#000000';

  /** Stroke width in user-space units. */
  public lineWidth: number = 1;

  /** Line cap style. */
  public lineCap: CanvasLineCap = 'butt';

  /** Line join style. */
  public lineJoin: CanvasLineJoin = 'miter';

  /** Miter limit. */
  public miterLimit: number = 10;

  /** CSS font shorthand. */
  public font: string = DEFAULT_CANVAS_FONT;

  /** Horizontal text alignment. */
  public textAlign: CanvasTextAlign = 'start';

  /** Vertical text baseline. */
  public textBaseline: CanvasTextBaseline = 'alphabetic';

  /** Global alpha in 0..1. */
  public globalAlpha: number = 1;

  /** Compositing operator. */
  public globalCompositeOperation: string = 'source-over';

  /** Shadow blur radius in user-space units. */
  public shadowBlur: number = 0;

  /** Shadow colour. */
  public shadowColor: string = 'rgba(0, 0, 0, 0)';

  /** Shadow horizontal offset. */
  public shadowOffsetX: number = 0;

  /** Shadow vertical offset. */
  public shadowOffsetY: number = 0;

  /** Current transform as `[a, b, c, d, e, f]`. */
  public transform: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

  /** Current clip region, when one has been established. */
  public clip: unknown = null;

  /**
   * Builds a state from a partial description.
   *
   * @param init Initial values.
   * @returns A new state.
   */
  public static from(init: Canvas2DStateInit): Canvas2DState {
    const state = new Canvas2DState();
    if (init.fillStyle !== undefined) state.fillStyle = init.fillStyle;
    if (init.strokeStyle !== undefined) state.strokeStyle = init.strokeStyle;
    if (init.lineWidth !== undefined) state.lineWidth = init.lineWidth;
    if (init.lineCap !== undefined) state.lineCap = init.lineCap;
    if (init.lineJoin !== undefined) state.lineJoin = init.lineJoin;
    if (init.miterLimit !== undefined) state.miterLimit = init.miterLimit;
    if (init.font !== undefined) state.font = init.font;
    if (init.textAlign !== undefined) state.textAlign = init.textAlign;
    if (init.textBaseline !== undefined) state.textBaseline = init.textBaseline;
    if (init.globalAlpha !== undefined) state.globalAlpha = init.globalAlpha;
    if (init.globalCompositeOperation !== undefined) {
      state.globalCompositeOperation = init.globalCompositeOperation;
    }
    if (init.shadowBlur !== undefined) state.shadowBlur = init.shadowBlur;
    if (init.shadowColor !== undefined) state.shadowColor = init.shadowColor;
    if (init.shadowOffsetX !== undefined) state.shadowOffsetX = init.shadowOffsetX;
    if (init.shadowOffsetY !== undefined) state.shadowOffsetY = init.shadowOffsetY;
    if (init.transform !== undefined) state.transform = [...init.transform];
    if (init.clip !== undefined) state.clip = init.clip;
    return state;
  }

  /**
   * Assigns every field of a partial description.
   *
   * @param init Values to assign.
   * @returns This state, for chaining.
   */
  public set(init: Canvas2DStateInit): this {
    if (init.fillStyle !== undefined) this.fillStyle = init.fillStyle;
    if (init.strokeStyle !== undefined) this.strokeStyle = init.strokeStyle;
    if (init.lineWidth !== undefined) this.lineWidth = init.lineWidth;
    if (init.lineCap !== undefined) this.lineCap = init.lineCap;
    if (init.lineJoin !== undefined) this.lineJoin = init.lineJoin;
    if (init.miterLimit !== undefined) this.miterLimit = init.miterLimit;
    if (init.font !== undefined) this.font = init.font;
    if (init.textAlign !== undefined) this.textAlign = init.textAlign;
    if (init.textBaseline !== undefined) this.textBaseline = init.textBaseline;
    if (init.globalAlpha !== undefined) this.globalAlpha = init.globalAlpha;
    if (init.globalCompositeOperation !== undefined) {
      this.globalCompositeOperation = init.globalCompositeOperation;
    }
    if (init.shadowBlur !== undefined) this.shadowBlur = init.shadowBlur;
    if (init.shadowColor !== undefined) this.shadowColor = init.shadowColor;
    if (init.shadowOffsetX !== undefined) this.shadowOffsetX = init.shadowOffsetX;
    if (init.shadowOffsetY !== undefined) this.shadowOffsetY = init.shadowOffsetY;
    if (init.transform !== undefined) this.transform = [...init.transform];
    if (init.clip !== undefined) this.clip = init.clip;
    return this;
  }

  /**
   * Copies every field of another state.
   *
   * @param source State to read.
   * @returns This state, for chaining.
   */
  public copy(source: Canvas2DState): this {
    this.fillStyle = source.fillStyle;
    this.strokeStyle = source.strokeStyle;
    this.lineWidth = source.lineWidth;
    this.lineCap = source.lineCap;
    this.lineJoin = source.lineJoin;
    this.miterLimit = source.miterLimit;
    this.font = source.font;
    this.textAlign = source.textAlign;
    this.textBaseline = source.textBaseline;
    this.globalAlpha = source.globalAlpha;
    this.globalCompositeOperation = source.globalCompositeOperation;
    this.shadowBlur = source.shadowBlur;
    this.shadowColor = source.shadowColor;
    this.shadowOffsetX = source.shadowOffsetX;
    this.shadowOffsetY = source.shadowOffsetY;
    this.transform = [...source.transform];
    this.clip = source.clip;
    return this;
  }

  /** Restores every field to its default value. */
  public reset(): this {
    return this.copy(new Canvas2DState());
  }

  /** @returns A deep-enough copy: arrays are duplicated. */
  public clone(): Canvas2DState {
    return new Canvas2DState().copy(this);
  }

  /**
   * Compares two states.
   *
   * Gradient and pattern objects are compared by reference, because the canvas
   * API exposes no way to compare them structurally.
   *
   * @param other State to compare against.
   * @returns `true` when every field matches.
   */
  public equals(other: Canvas2DState | null | undefined): boolean {
    if (other == null) return false;
    return (
      this.fillStyle === other.fillStyle &&
      this.strokeStyle === other.strokeStyle &&
      this.lineWidth === other.lineWidth &&
      this.lineCap === other.lineCap &&
      this.lineJoin === other.lineJoin &&
      this.miterLimit === other.miterLimit &&
      this.font === other.font &&
      this.textAlign === other.textAlign &&
      this.textBaseline === other.textBaseline &&
      this.globalAlpha === other.globalAlpha &&
      this.globalCompositeOperation === other.globalCompositeOperation &&
      this.shadowBlur === other.shadowBlur &&
      this.shadowColor === other.shadowColor &&
      this.shadowOffsetX === other.shadowOffsetX &&
      this.shadowOffsetY === other.shadowOffsetY &&
      equalTransform(this.transform, other.transform) &&
      this.clip === other.clip
    );
  }

  /** @returns The names of the fields that differ from `other`. */
  public diff(other: Canvas2DState | null | undefined): string[] {
    if (other == null) {
      return [
        'fillStyle',
        'strokeStyle',
        'lineWidth',
        'lineCap',
        'lineJoin',
        'miterLimit',
        'font',
        'textAlign',
        'textBaseline',
        'globalAlpha',
        'globalCompositeOperation',
        'shadowBlur',
        'shadowColor',
        'shadowOffsetX',
        'shadowOffsetY',
        'transform',
        'clip',
      ];
    }

    const changed: string[] = [];
    if (this.fillStyle !== other.fillStyle) changed.push('fillStyle');
    if (this.strokeStyle !== other.strokeStyle) changed.push('strokeStyle');
    if (this.lineWidth !== other.lineWidth) changed.push('lineWidth');
    if (this.lineCap !== other.lineCap) changed.push('lineCap');
    if (this.lineJoin !== other.lineJoin) changed.push('lineJoin');
    if (this.miterLimit !== other.miterLimit) changed.push('miterLimit');
    if (this.font !== other.font) changed.push('font');
    if (this.textAlign !== other.textAlign) changed.push('textAlign');
    if (this.textBaseline !== other.textBaseline) changed.push('textBaseline');
    if (this.globalAlpha !== other.globalAlpha) changed.push('globalAlpha');
    if (this.globalCompositeOperation !== other.globalCompositeOperation) {
      changed.push('globalCompositeOperation');
    }
    if (this.shadowBlur !== other.shadowBlur) changed.push('shadowBlur');
    if (this.shadowColor !== other.shadowColor) changed.push('shadowColor');
    if (this.shadowOffsetX !== other.shadowOffsetX) changed.push('shadowOffsetX');
    if (this.shadowOffsetY !== other.shadowOffsetY) changed.push('shadowOffsetY');
    if (!equalTransform(this.transform, other.transform)) changed.push('transform');
    if (this.clip !== other.clip) changed.push('clip');
    return changed;
  }

  /** @returns A plain object copy, useful for snapshots. */
  public toObject(): Required<Omit<Canvas2DStateInit, 'clip'>> & { clip: unknown } {
    return {
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
      miterLimit: this.miterLimit,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation,
      shadowBlur: this.shadowBlur,
      shadowColor: this.shadowColor,
      shadowOffsetX: this.shadowOffsetX,
      shadowOffsetY: this.shadowOffsetY,
      transform: this.transform,
      clip: this.clip,
    };
  }

  /**
   * Reads the corresponding fields out of a live context.
   *
   * @param painter Context (or any painter-like object) to read.
   * @returns This state, for chaining.
   */
  public fromContext(painter: Canvas2DStateTarget): this {
    if (typeof painter.fillStyle === 'string' || painter.fillStyle != null) {
      this.fillStyle = painter.fillStyle as CanvasPaint;
    }
    if (typeof painter.strokeStyle === 'string' || painter.strokeStyle != null) {
      this.strokeStyle = painter.strokeStyle as CanvasPaint;
    }
    if (typeof painter.lineWidth === 'number') this.lineWidth = painter.lineWidth;
    if (typeof painter.lineCap === 'string') this.lineCap = painter.lineCap as CanvasLineCap;
    if (typeof painter.lineJoin === 'string') this.lineJoin = painter.lineJoin as CanvasLineJoin;
    if (typeof painter.miterLimit === 'number') this.miterLimit = painter.miterLimit;
    if (typeof painter.font === 'string' && painter.font.length > 0) this.font = painter.font;
    if (typeof painter.textAlign === 'string') this.textAlign = painter.textAlign as CanvasTextAlign;
    if (typeof painter.textBaseline === 'string') {
      this.textBaseline = painter.textBaseline as CanvasTextBaseline;
    }
    if (typeof painter.globalAlpha === 'number') this.globalAlpha = painter.globalAlpha;
    if (typeof painter.globalCompositeOperation === 'string') {
      this.globalCompositeOperation = painter.globalCompositeOperation;
    }
    if (typeof painter.shadowBlur === 'number') this.shadowBlur = painter.shadowBlur;
    if (typeof painter.shadowColor === 'string' && painter.shadowColor.length > 0) {
      this.shadowColor = painter.shadowColor;
    }
    if (typeof painter.shadowOffsetX === 'number') this.shadowOffsetX = painter.shadowOffsetX;
    if (typeof painter.shadowOffsetY === 'number') this.shadowOffsetY = painter.shadowOffsetY;
    if (typeof painter.getTransform === 'function') {
      try {
        const matrix = painter.getTransform();
        this.transform = [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
      } catch {
        /* headless doubles may not implement getTransform */
      }
    }
    return this;
  }

  /**
   * Writes every field into a live context.
   *
   * @param painter Context (or painter) to write into.
   * @returns This state, for chaining.
   */
  public apply(painter: Canvas2DStateTarget): this {
    painter.fillStyle = this.fillStyle;
    painter.strokeStyle = this.strokeStyle;
    painter.lineWidth = this.lineWidth;
    painter.lineCap = this.lineCap;
    painter.lineJoin = this.lineJoin;
    painter.miterLimit = this.miterLimit;
    painter.font = this.font;
    painter.textAlign = this.textAlign;
    painter.textBaseline = this.textBaseline;
    painter.globalAlpha = this.globalAlpha;
    painter.globalCompositeOperation = this.globalCompositeOperation;
    painter.shadowBlur = this.shadowBlur;
    painter.shadowColor = this.shadowColor;
    painter.shadowOffsetX = this.shadowOffsetX;
    painter.shadowOffsetY = this.shadowOffsetY;
    if (typeof painter.setTransform === 'function') {
      painter.setTransform(
        this.transform[0],
        this.transform[1],
        this.transform[2],
        this.transform[3],
        this.transform[4],
        this.transform[5],
      );
    }
    if (this.clip != null && typeof painter.clip === 'function') {
      painter.clip(this.clip);
    }
    return this;
  }
}

/**
 * The subset of a canvas context {@link Canvas2DState} reads and writes.
 *
 * Kept structural so the same state object can drive a real context, a
 * `Canvas2DPainter`, or a test double.
 */
export interface Canvas2DStateTarget {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  miterLimit: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  globalAlpha: number;
  globalCompositeOperation: string;
  shadowBlur: number;
  shadowColor: string;
  shadowOffsetX: number;
  shadowOffsetY: number;
  getTransform?(): { a: number; b: number; c: number; d: number; e: number; f: number };
  setTransform?(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clip?(path?: unknown): void;
}

/** Compares two 6-element transforms exactly. */
function equalTransform(
  a: readonly [number, number, number, number, number, number],
  b: readonly [number, number, number, number, number, number],
): boolean {
  return (
    a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && a[5] === b[5]
  );
}
