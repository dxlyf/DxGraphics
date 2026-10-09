/**
 * `TextStyle` — the typography description a layout is produced from.
 *
 * A style is a *value*: immutable in intent, cheap to clone, and serialisable. That is
 * what lets a layout be cached by style identity, an editor offer "copy formatting",
 * and a theme be a list of partial styles merged over a base.
 *
 * ```ts
 * const style = TextStyle.from({ fontFamily: 'Inter', fontSize: 18, align: 'center' });
 * const next = style.merge({ color: '#ff8800', letterSpacing: 1 });
 * style === next;            // false — merge returns a new style
 * next.toCss();              // 'italic 400 18px Inter, sans-serif'
 * next.toCanvasFont();       // '400 18px "Inter", sans-serif'
 * ```
 *
 * ## `lineHeight` semantics
 *
 * `lineHeight` is a **multiple of the font size**, matching CSS. `merge` resolves a
 * pixel value into a multiple, so `merge({ lineHeight: 27, fontSize: 18 })` stores
 * `1.5`; a caller that wants pixels reads {@link TextStyle.getLineHeightPx}. Storing
 * the ratio is what makes a style survive a font-size change without drifting.
 *
 * @packageDocumentation
 */

import { DEFAULT_FONT_SIZE } from '../constants';
import { Color } from '../math/Color';
import type {
  FontStyle,
  FontWeight,
  TextAlign,
  TextBaseline,
  TextDirection,
  TextShadowOptions,
  TextStrokeOptions,
  TextStyleInit,
  WordBreak,
} from './types';

/** CSS-style default line-height multiple. */
export const DEFAULT_LINE_HEIGHT = 1.2;

/** Font stacks that need no webfont. */
export const DEFAULT_FONT_FAMILY =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * A text style.
 */
export class TextStyle {
  /** Font family list. */
  public fontFamily: string;

  /** Size in pixels. */
  public fontSize: number;

  /** Weight. */
  public fontWeight: FontWeight;

  /** Style. */
  public fontStyle: FontStyle;

  /** Horizontal alignment. */
  public align: TextAlign;

  /** Vertical alignment relative to the baseline. */
  public baseline: TextBaseline;

  /** Line height as a multiple of {@link TextStyle.fontSize}. */
  public lineHeight: number;

  /** Letter spacing in pixels. */
  public letterSpacing: number;

  /** Extra space per word, in pixels. */
  public wordSpacing: number;

  /** Fill colour. */
  public readonly color: Color;

  /** Opacity in `[0, 1]`. */
  public opacity: number;

  /** Outline, or `null`. */
  public stroke: (TextStrokeOptions & { width: number; join: string }) | null;

  /** Shadow, or `null`. */
  public shadow: (TextShadowOptions & { offsetX: number; offsetY: number; blur: number }) | null;

  /** Maximum line width in pixels; `0` disables wrapping. */
  public maxWidth: number;

  /** Padding inside the text box, in pixels. */
  public padding: number;

  /** Word-break strategy. */
  public wordBreak: WordBreak;

  /** Writing direction. */
  public direction: TextDirection;

  /**
   * Creates a style.
   *
   * @param init Partial style; omitted fields take their defaults.
   */
  constructor(init: TextStyleInit = {}) {
    this.fontFamily = init.fontFamily ?? DEFAULT_FONT_FAMILY;
    this.fontSize = init.fontSize ?? DEFAULT_FONT_SIZE;
    this.fontWeight = init.fontWeight ?? 'normal';
    this.fontStyle = init.fontStyle ?? 'normal';
    this.align = init.align ?? 'left';
    this.baseline = init.baseline ?? 'top';
    this.lineHeight = resolveLineHeight(init.lineHeight, this.fontSize);
    this.letterSpacing = init.letterSpacing ?? 0;
    this.wordSpacing = init.wordSpacing ?? 0;
    this.color = init.color === undefined ? Color.white() : Color.from(init.color);
    this.opacity = clamp01(init.opacity ?? 1);
    this.maxWidth = init.maxWidth ?? 0;
    this.padding = init.padding ?? 0;
    this.wordBreak = init.wordBreak ?? 'normal';
    this.direction = init.direction ?? 'ltr';

    this.stroke = normalizeStroke(init.stroke);
    this.shadow = normalizeShadow(init.shadow);
  }

  /* --------------------------------------------------------------- factories */

  /**
   * The default style.
   *
   * @returns A fresh default style.
   */
  public static default(): TextStyle {
    return new TextStyle();
  }

  /**
   * Builds a style from a partial description.
   *
   * @param init Partial style.
   * @returns A new style.
   */
  public static from(init: TextStyleInit = {}): TextStyle {
    return new TextStyle(init);
  }

  /**
   * Builds a style with every measurement multiplied by `scale`.
   *
   * The right way to render the same text at a different device-pixel ratio: scaling the
   * style (rather than the resulting quads) keeps hinting, kerning and line breaking
   * correct at the new size.
   *
   * @param style Base style.
   * @param scale Multiplier.
   * @returns A new style.
   */
  public static scaled(style: TextStyle, scale: number): TextStyle {
    return new TextStyle({
      fontFamily: style.fontFamily,
      fontSize: style.fontSize * scale,
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle,
      align: style.align,
      baseline: style.baseline,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing * scale,
      wordSpacing: style.wordSpacing * scale,
      color: style.color,
      opacity: style.opacity,
      maxWidth: style.maxWidth > 0 ? style.maxWidth * scale : 0,
      padding: style.padding * scale,
      wordBreak: style.wordBreak,
      direction: style.direction,
      stroke:
        style.stroke === null
          ? null
          : { ...style.stroke, width: style.stroke.width * scale },
      shadow:
        style.shadow === null
          ? null
          : {
              ...style.shadow,
              offsetX: style.shadow.offsetX * scale,
              offsetY: style.shadow.offsetY * scale,
              blur: style.shadow.blur * scale,
            },
    });
  }

  /* ------------------------------------------------------------------- output */

  /**
   * The line height in pixels.
   *
   * @returns `lineHeight * fontSize`.
   */
  public getLineHeightPx(): number {
    return this.lineHeight * this.fontSize;
  }

  /**
   * The CSS `font` shorthand.
   *
   * @returns A string such as `'italic 700 18px Inter, sans-serif'`.
   */
  public toCss(): string {
    const family = this.toFontString();
    return `font: ${this.fontStyle} ${String(this.fontWeight)} ${this.fontSize}px ${family};`;
  }

  /**
   * The `font` value alone, without the property name.
   *
   * @returns A string such as `'italic 700 18px Inter, sans-serif'`.
   */
  public toFontString(): string {
    return `${this.fontStyle} ${String(this.fontWeight)} ${this.fontSize}px ${this.fontFamily}`;
  }

  /**
   * A canvas `font` value, with the family quoted when it contains a space.
   *
   * @returns A string suitable for `CanvasRenderingContext2D.font`.
   */
  public toCanvasFont(): string {
    return `${this.fontStyle === 'normal' ? '' : `${this.fontStyle} `}${String(this.fontWeight)} ${this.fontSize}px ${quoteFamily(this.fontFamily)}`.trim();
  }

  /**
   * A full CSS rule set for this style, for a DOM-backed renderer.
   *
   * @returns A CSS declaration block, without braces.
   */
  public toCssDeclaration(): string {
    const parts = [
      `font-family: ${this.fontFamily}`,
      `font-size: ${this.fontSize}px`,
      `font-weight: ${String(this.fontWeight)}`,
      `font-style: ${this.fontStyle}`,
      `line-height: ${this.getLineHeightPx()}px`,
      `text-align: ${this.align}`,
      `color: ${this.color.toCssString()}`,
    ];
    if (this.letterSpacing !== 0) parts.push(`letter-spacing: ${this.letterSpacing}px`);
    if (this.wordSpacing !== 0) parts.push(`word-spacing: ${this.wordSpacing}px`);
    if (this.opacity !== 1) parts.push(`opacity: ${this.opacity}`);
    if (this.stroke !== null) {
      parts.push(`-webkit-text-stroke: ${this.stroke.width}px ${Color.from(this.stroke.color).toCssString()}`);
    }
    if (this.shadow !== null) {
      parts.push(
        `text-shadow: ${this.shadow.offsetX}px ${this.shadow.offsetY}px ${this.shadow.blur}px ` +
          `${Color.from(this.shadow.color).toCssString()}`,
      );
    }
    return parts.join('; ');
  }

  /* ------------------------------------------------------------------ merging */

  /**
   * Returns a new style with `init` merged over this one.
   *
   * `this` is never modified, which is what makes a base style + per-element overrides a
   * safe pattern.
   *
   * @param init Overrides.
   * @returns A new style.
   */
  public merge(init: TextStyleInit): TextStyle {
    const fontSize = init.fontSize ?? this.fontSize;

    return new TextStyle({
      fontFamily: init.fontFamily ?? this.fontFamily,
      fontSize,
      fontWeight: init.fontWeight ?? this.fontWeight,
      fontStyle: init.fontStyle ?? this.fontStyle,
      align: init.align ?? this.align,
      baseline: init.baseline ?? this.baseline,
      // A pixel line height from the caller is converted against the *new* font size; a
      // ratio is carried across unchanged.
      lineHeight:
        init.lineHeight === undefined
          ? this.lineHeight
          : init.lineHeight > 4
            ? init.lineHeight / fontSize
            : init.lineHeight,
      letterSpacing: init.letterSpacing ?? this.letterSpacing,
      wordSpacing: init.wordSpacing ?? this.wordSpacing,
      color: init.color ?? this.color,
      opacity: init.opacity ?? this.opacity,
      stroke: init.stroke === undefined ? this.stroke : init.stroke,
      shadow: init.shadow === undefined ? this.shadow : init.shadow,
      maxWidth: init.maxWidth ?? this.maxWidth,
      padding: init.padding ?? this.padding,
      wordBreak: init.wordBreak ?? this.wordBreak,
      direction: init.direction ?? this.direction,
    });
  }

  /**
   * Copies another style's values into this one.
   *
   * @param source Style to copy.
   * @returns This style, for chaining.
   */
  public copy(source: TextStyle): this {
    this.fontFamily = source.fontFamily;
    this.fontSize = source.fontSize;
    this.fontWeight = source.fontWeight;
    this.fontStyle = source.fontStyle;
    this.align = source.align;
    this.baseline = source.baseline;
    this.lineHeight = source.lineHeight;
    this.letterSpacing = source.letterSpacing;
    this.wordSpacing = source.wordSpacing;
    this.color.copy(source.color);
    this.opacity = source.opacity;
    this.stroke = source.stroke === null ? null : { ...source.stroke };
    this.shadow = source.shadow === null ? null : { ...source.shadow };
    this.maxWidth = source.maxWidth;
    this.padding = source.padding;
    this.wordBreak = source.wordBreak;
    this.direction = source.direction;
    return this;
  }

  /**
   * @returns A deep copy of this style.
   */
  public clone(): TextStyle {
    return new TextStyle().copy(this);
  }

  /**
   * `true` when every field matches.
   *
   * @param other Style to compare.
   * @param tolerance Colour tolerance.
   * @returns The equality flag.
   */
  public equals(other: TextStyle, tolerance = 1e-6): boolean {
    return (
      this.fontFamily === other.fontFamily &&
      this.fontSize === other.fontSize &&
      this.fontWeight === other.fontWeight &&
      this.fontStyle === other.fontStyle &&
      this.align === other.align &&
      this.baseline === other.baseline &&
      Math.abs(this.lineHeight - other.lineHeight) <= tolerance &&
      Math.abs(this.letterSpacing - other.letterSpacing) <= tolerance &&
      Math.abs(this.wordSpacing - other.wordSpacing) <= tolerance &&
      this.color.equals(other.color, tolerance) &&
      Math.abs(this.opacity - other.opacity) <= tolerance &&
      this.maxWidth === other.maxWidth &&
      this.padding === other.padding &&
      this.wordBreak === other.wordBreak &&
      this.direction === other.direction
    );
  }

  /**
   * A stable key for caching a layout against this style.
   *
   * @returns A string that changes whenever a layout-affecting field changes.
   */
  public getLayoutKey(): string {
    return [
      this.fontFamily,
      this.fontSize,
      String(this.fontWeight),
      this.fontStyle,
      this.align,
      this.baseline,
      this.lineHeight,
      this.letterSpacing,
      this.wordSpacing,
      this.maxWidth,
      this.padding,
      this.wordBreak,
      this.direction,
    ].join('|');
  }

  /**
   * @returns A JSON-friendly representation.
   */
  public toJSON(): Record<string, unknown> {
    return {
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      fontWeight: this.fontWeight,
      fontStyle: this.fontStyle,
      align: this.align,
      baseline: this.baseline,
      lineHeight: this.lineHeight,
      letterSpacing: this.letterSpacing,
      wordSpacing: this.wordSpacing,
      color: this.color.toJSON(),
      opacity: this.opacity,
      maxWidth: this.maxWidth,
      padding: this.padding,
      wordBreak: this.wordBreak,
      direction: this.direction,
    };
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return (
      `TextStyle(${this.fontStyle} ${String(this.fontWeight)} ${this.fontSize}px "${this.fontFamily}", ` +
      `align=${this.align}, color=${this.color.toCssString()})`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Resolves a line height, accepting either a ratio or a pixel count. */
function resolveLineHeight(value: number | undefined, fontSize: number): number {
  if (value === undefined) return DEFAULT_LINE_HEIGHT;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LINE_HEIGHT;
  // Values at or below 4 are treated as ratios, above as pixel counts. That threshold is
  // the same heuristic CSS engines and design tools use, and no real font has a line
  // height of four pixels at a readable size.
  return value > 4 ? value / fontSize : value;
}

/** Normalises a stroke description, filling in its defaults. */
function normalizeStroke(
  stroke: TextStrokeOptions | null | undefined,
): (TextStrokeOptions & { width: number; join: string }) | null {
  if (stroke === null || stroke === undefined) return null;
  return {
    color: stroke.color,
    width: stroke.width ?? 1,
    join: stroke.join ?? 'round',
    ...(stroke.miterLimit === undefined ? {} : { miterLimit: stroke.miterLimit }),
  };
}

/** Normalises a shadow description, filling in its defaults. */
function normalizeShadow(
  shadow: TextShadowOptions | null | undefined,
): (TextShadowOptions & { offsetX: number; offsetY: number; blur: number }) | null {
  if (shadow === null || shadow === undefined) return null;
  return {
    color: shadow.color,
    offsetX: shadow.offsetX ?? 0,
    offsetY: shadow.offsetY ?? 0,
    blur: shadow.blur ?? 0,
  };
}

/** Quotes each family in a stack when it contains a space and is not already quoted. */
function quoteFamily(family: string): string {
  return family
    .split(',')
    .map((entry) => {
      const trimmed = entry.trim();
      if (trimmed.length === 0) return trimmed;
      if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed;
      if (!trimmed.includes(' ')) return trimmed;
      return `"${trimmed}"`;
    })
    .join(', ');
}

/** Clamps a value into `[0, 1]`. */
function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Convenience factory mirroring `new TextStyle(init)`.
 *
 * @param init Partial style.
 * @returns A new style.
 */
export function textStyle(init: TextStyleInit = {}): TextStyle {
  return new TextStyle(init);
}
