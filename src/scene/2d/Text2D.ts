/**
 * `Text2D` - a text label node.
 *
 * The node owns the typographic state; the backend turns it into glyphs (a
 * canvas `fillText` call, an SVG `<text>` element, a glyph-atlas quad). Layout
 * metrics are requested through the painter, so a node can size itself to its
 * content with {@link Text2D.measure}.
 *
 * @packageDocumentation
 */

import { Rect } from '../../math/Rect';
import { Vec2 } from '../../math/Vec2';
import { Node2D } from './Node2D';
import type { Material2DLike, Node2DOptions, Painter2D } from './types';

/** Horizontal alignment of the label inside its bounds. */
export type TextAlign2D = 'left' | 'center' | 'right' | 'justify';

/** Vertical alignment of the label inside its bounds. */
export type TextBaseline2D = 'top' | 'middle' | 'bottom' | 'alphabetic' | 'hanging';

/** Options accepted by the {@link Text2D} constructor. */
export interface Text2DOptions extends Node2DOptions {
  /** String rendered by the node; defaults to `''`. */
  text?: string;
  /** Font shorthand (`'16px Inter, sans-serif'`) or family name. */
  font?: string;
  /** Font size in local units. */
  fontSize?: number;
  /** Font family, used when {@link Text2DOptions.font} is not supplied. */
  fontFamily?: string;
  /** Font weight (`400`, `'bold'`, ...). */
  fontWeight?: string | number;
  /** Font style (`'normal'`, `'italic'`, `'oblique'`). */
  fontStyle?: string;
  /** Fill colour. */
  color?: unknown;
  /** Stroke colour; `null` disables the outline. */
  strokeColor?: unknown;
  /** Stroke width, in local units. */
  strokeWidth?: number;
  /** Horizontal alignment. */
  align?: TextAlign2D;
  /** Vertical alignment. */
  baseline?: TextBaseline2D;
  /** Maximum line width before wrapping; `0` disables wrapping. */
  wrapWidth?: number;
  /** Line height as a multiple of the font size. */
  lineHeight?: number;
  /** Extra spacing between characters, in local units. */
  letterSpacing?: number;
  /** Material override. */
  material?: Material2DLike | null;
}

/** A text label. */
export class Text2D extends Node2D {
  /** Allows consumers to detect a label without an `instanceof` check. */
  public readonly isText2D: true = true;

  /** Class name used by serialisation and the backend's dispatch. */
  public override readonly type: string = 'Text2D';

  /** Backing field of the `text` accessor. */
  private content: string;

  /** Font shorthand understood by the backend. */
  public font: string;

  /** Font size in local units. */
  public fontSize: number;

  /** Font family name. */
  public fontFamily: string;

  /** Font weight. */
  public fontWeight: string | number;

  /** Font style. */
  public fontStyle: string;

  /** Fill colour. */
  public color: unknown;

  /** Stroke colour, or `null` for a fill-only label. */
  public strokeColor: unknown;

  /** Stroke width, in local units. */
  public strokeWidth: number;

  /** Horizontal alignment. */
  public align: TextAlign2D;

  /** Vertical alignment. */
  public baseline: TextBaseline2D;

  /** Maximum line width before wrapping; `0` disables wrapping. */
  public wrapWidth: number;

  /** Line height as a multiple of {@link Text2D.fontSize}. */
  public lineHeight: number;

  /** Extra spacing between characters, in local units. */
  public letterSpacing: number;

  /** Material override, when the backend supports one. */
  public material: Material2DLike | null;

  /** Measured width of the label, in local units; `0` until measured. */
  public measuredWidth = 0;

  /** Measured height of the label, in local units; `0` until measured. */
  public measuredHeight = 0;

  /** Top-left anchor of the rendered text inside the node's bounds. */
  public readonly anchor: Vec2 = new Vec2(0, 0);

  /** Creates a text label. */
  constructor(options: Text2DOptions = {}) {
    super(options);
    this.content = options.text ?? '';
    this.fontSize = options.fontSize ?? 16;
    this.fontFamily = options.fontFamily ?? 'sans-serif';
    this.fontWeight = options.fontWeight ?? 'normal';
    this.fontStyle = options.fontStyle ?? 'normal';
    this.font = options.font ?? this.buildFont();
    this.color = options.color ?? '#ffffff';
    this.strokeColor = options.strokeColor ?? null;
    this.strokeWidth = options.strokeWidth ?? 0;
    this.align = options.align ?? 'left';
    this.baseline = options.baseline ?? 'top';
    this.wrapWidth = options.wrapWidth ?? 0;
    this.lineHeight = options.lineHeight ?? 1.2;
    this.letterSpacing = options.letterSpacing ?? 0;
    this.material = options.material ?? null;
    if (!this.bounds) this.setBounds(new Rect(0, 0, 0, 0));
  }

  /** String rendered by this node. */
  public get text(): string {
    return this.content;
  }

  public set text(value: string) {
    if (this.content === value) return;
    this.content = value;
    this.notifyBoundsChanged();
  }

  /** Sets the text and, when `resize` is set, refreshes the cached metrics. */
  public setText(text: string, resize = false): this {
    this.text = text;
    if (resize) {
      const rect = this.bounds ?? new Rect(0, 0, 0, 0);
      rect.set(0, 0, Math.max(this.measuredWidth, 0), Math.max(this.measuredHeight, 0));
      this.setBounds(rect);
    }
    return this;
  }

  /**
   * Measures the label with a painter and caches the result.
   *
   * @param painter Backend exposing `measureText`.
   * @returns The measured size, in local units.
   */
  public measure(painter: Painter2D | unknown): { width: number; height: number } {
    const host = painter as Painter2D;
    const lines = this.getLines();
    let width = 0;
    if (typeof host?.measureText === 'function') {
      for (const line of lines) {
        const metrics = host.measureText(line);
        width = Math.max(width, metrics.width ?? 0);
      }
    } else {
      width = this.content.length * this.fontSize * 0.5;
    }
    const height = lines.length * this.fontSize * this.lineHeight;
    this.measuredWidth = width + Math.max(0, this.content.length - 1) * this.letterSpacing;
    this.measuredHeight = height;
    return { width: this.measuredWidth, height: this.measuredHeight };
  }

  /** Splits the content into drawn lines, honouring {@link Text2D.wrapWidth}. */
  public getLines(): string[] {
    const lines = this.content.split('\n');
    if (this.wrapWidth <= 0) return lines;

    const wrapped: string[] = [];
    const approximateCharacterWidth = Math.max(1, this.fontSize * 0.5);
    const charactersPerLine = Math.max(1, Math.floor(this.wrapWidth / approximateCharacterWidth));
    for (const line of lines) {
      for (let i = 0; i < line.length; i += charactersPerLine) {
        wrapped.push(line.slice(i, i + charactersPerLine));
      }
      if (line.length === 0) wrapped.push('');
    }
    return wrapped;
  }

  /** Rebuilds {@link Text2D.font} from the individual font fields. */
  public updateFont(): this {
    this.font = this.buildFont();
    this.notifyBoundsChanged();
    return this;
  }

  /** Copies the typographic state of `source`. */
  public override copy(source: Node2D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof Text2D) {
      this.content = source.content;
      this.font = source.font;
      this.fontSize = source.fontSize;
      this.fontFamily = source.fontFamily;
      this.fontWeight = source.fontWeight;
      this.fontStyle = source.fontStyle;
      this.color = source.color;
      this.strokeColor = source.strokeColor;
      this.strokeWidth = source.strokeWidth;
      this.align = source.align;
      this.baseline = source.baseline;
      this.wrapWidth = source.wrapWidth;
      this.lineHeight = source.lineHeight;
      this.letterSpacing = source.letterSpacing;
      this.material = source.material;
      this.measuredWidth = source.measuredWidth;
      this.measuredHeight = source.measuredHeight;
      this.anchor.copy(source.anchor);
    }
    return this;
  }

  /** Serialises the label alongside the node data. */
  public override toJSON(recursive = true): ReturnType<Node2D['toJSON']> {
    const json = super.toJSON(recursive);
    json.text = this.content;
    json.font = this.font;
    json.fontSize = this.fontSize;
    json.fontFamily = this.fontFamily;
    json.fontWeight = this.fontWeight;
    json.fontStyle = this.fontStyle;
    json.align = this.align;
    json.baseline = this.baseline;
    json.wrapWidth = this.wrapWidth;
    json.lineHeight = this.lineHeight;
    json.letterSpacing = this.letterSpacing;
    json.measuredWidth = this.measuredWidth;
    json.measuredHeight = this.measuredHeight;
    return json;
  }

  /** Returns a new label with the same state. */
  public override clone(recursive = true): Text2D {
    return this.createInstance().copy(this, recursive) as Text2D;
  }

  /** Creates an empty `Text2D`, used by `clone()`. */
  protected override createInstance(): Node2D {
    return new Text2D();
  }

  /** Builds the CSS-style font shorthand the backends understand. */
  private buildFont(): string {
    return `${this.fontStyle} ${this.fontWeight} ${this.fontSize}px ${this.fontFamily}`;
  }
}
