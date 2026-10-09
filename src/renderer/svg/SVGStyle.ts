/**
 * SVG presentation attributes.
 *
 * Converts a backend-agnostic fill/stroke/opacity description into the attribute
 * bag an SVG element wants. The converter never touches the DOM, so it can be unit
 * tested directly and reused by the `<defs>` builder for gradient stops.
 *
 * @packageDocumentation
 */

import { normalizeColor, toCss } from '../utils/colorUtils';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** SVG `stroke-linecap` values. */
export type SVGLineCap = 'butt' | 'round' | 'square';

/** SVG `stroke-linejoin` values. */
export type SVGLineJoin = 'miter' | 'round' | 'bevel' | 'miter-clip' | 'arcs';

/** SVG `vector-effect` values. */
export type SVGVectorEffect =
  | 'none'
  | 'non-scaling-stroke'
  | 'non-scaling-size'
  | 'non-rotation'
  | 'fixed-position';

/** SVG `text-anchor` values. */
export type SVGTextAnchor = 'start' | 'middle' | 'end';

/** SVG `dominant-baseline` values. */
export type SVGDominantBaseline =
  | 'auto'
  | 'middle'
  | 'central'
  | 'hanging'
  | 'text-before-edge'
  | 'text-after-edge'
  | 'alphabetic'
  | 'ideographic';

/** Anything the style converter accepts as a paint. */
export type SVGPaintInput = string | number | { r: number; g: number; b: number; a?: number } | null | undefined;

/** Dash pattern description. */
export type SVGDashArray = readonly number[] | string | null;

/** A description of how a shape should be painted. */
export interface SVGStyleDescription {
  /** Fill paint; `'none'` or `null` disables filling. */
  fill?: SVGPaintInput;
  /** Fill opacity in 0..1. */
  fillOpacity?: number;
  /** `fill-rule`. */
  fillRule?: 'nonzero' | 'evenodd';
  /** Stroke paint; `'none'` or `null` disables stroking. */
  stroke?: SVGPaintInput;
  /** Stroke opacity in 0..1. */
  strokeOpacity?: number;
  /** Stroke width in user units. */
  strokeWidth?: number;
  /** Stroke line cap. */
  strokeLineCap?: SVGLineCap;
  /** Stroke line join. */
  strokeLineJoin?: SVGLineJoin;
  /** Stroke miter limit. */
  strokeMiterLimit?: number;
  /** Dash pattern; `null`/`[]` restores a solid line. */
  strokeDashArray?: SVGDashArray;
  /** Dash offset in user units. */
  strokeDashOffset?: number;
  /** Overall element opacity in 0..1. */
  opacity?: number;
  /** `mix-blend-mode`. */
  mixBlendMode?: string;
  /** `isolation: isolate` when `true`. */
  isolate?: boolean;
  /** Non-scaling stroke handling. */
  vectorEffect?: SVGVectorEffect;
  /** `paint-order` (`'stroke fill markers'`). */
  paintOrder?: string;
  /** `shape-rendering`. */
  shapeRendering?: 'auto' | 'optimizeSpeed' | 'crispEdges' | 'geometricPrecision';
  /** `pointer-events`. */
  pointerEvents?: string;
  /** CSS font shorthand parts. */
  fontFamily?: string;
  fontSize?: number | string;
  fontWeight?: number | string;
  fontStyle?: 'normal' | 'italic' | 'oblique';
  /** `text-decoration`. */
  textDecoration?: string;
  /** `letter-spacing`, in user units. */
  letterSpacing?: number | string;
  /** `word-spacing`, in user units. */
  wordSpacing?: number | string;
  /** `text-anchor`. */
  textAnchor?: SVGTextAnchor;
  /** `dominant-baseline`. */
  dominantBaseline?: SVGDominantBaseline;
  /** `filter` reference (`'url(#id)'`). */
  filter?: string;
  /** `clip-path` reference (`'url(#id)'`). */
  clipPath?: string;
  /** `mask` reference (`'url(#id)'`). */
  mask?: string;
  /** `marker-start` reference. */
  markerStart?: string;
  /** `marker-mid` reference. */
  markerMid?: string;
  /** `marker-end` reference. */
  markerEnd?: string;
  /** `color-interpolation`. */
  colorInterpolation?: 'auto' | 'sRGB' | 'linearRGB';
}

/* -------------------------------------------------------------------------- */
/* Resolution helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Converts a paint input into an SVG paint value.
 *
 * @param paint Paint input. `null` and `'none'` become the explicit `'none'`
 *   value; `undefined` means "leave the attribute unset".
 * @returns A `#rrggbb`, `rgba(...)` or `'none'` string, or `undefined`.
 */
export function toSvgPaint(paint: SVGPaintInput): string | undefined {
  if (paint === undefined) return undefined;
  if (paint === null) return 'none';
  if (typeof paint === 'string' && paint.trim().toLowerCase() === 'none') return 'none';

  const rgba = normalizeColor(paint);
  if (rgba.a >= 1) {
    const hex = ((Math.round(rgba.r * 255) << 16) | (Math.round(rgba.g * 255) << 8) | Math.round(rgba.b * 255))
      .toString(16)
      .padStart(6, '0');
    return `#${hex}`;
  }
  return toCss(rgba);
}

/** Formats a dash pattern as the SVG `stroke-dasharray` value. */
export function toSvgDashArray(dash: SVGDashArray): string | undefined {
  if (dash === undefined) return undefined;
  if (dash === null) return 'none';
  if (typeof dash === 'string') return dash.length === 0 ? 'none' : dash;
  if (dash.length === 0) return 'none';
  return dash.map((value) => formatNumber(value)).join(' ');
}

/** Formats a number without trailing zeros. */
export function formatNumber(value: number, precision: number = 4): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Number(value.toFixed(precision));
  return String(rounded === 0 ? 0 : rounded);
}

/** Formats a font size, accepting bare numbers (user units) or CSS strings. */
export function formatFontSize(size: number | string): string {
  return typeof size === 'number' ? formatNumber(size) : size;
}

/* -------------------------------------------------------------------------- */
/* Converter                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The attribute keys {@link SVGStyle.toPresentationAttributes} can emit.
 *
 * Listed explicitly so consumers get autocomplete and typos are caught.
 */
export type SVGPresentationAttributes = Record<string, string>;

/**
 * Converts style descriptions into SVG presentation attributes.
 *
 * ```ts
 * SVGStyle.toPresentationAttributes({ fill: '#ff0000', strokeWidth: 2 });
 * // { fill: '#ff0000', 'stroke-width': '2' }
 * ```
 */
export class SVGStyle {
  /** Fill paint. */
  public fill: SVGPaintInput = '#000000';

  /** Fill opacity in 0..1. */
  public fillOpacity: number = 1;

  /** `fill-rule`. */
  public fillRule: 'nonzero' | 'evenodd' = 'nonzero';

  /** Stroke paint. */
  public stroke: SVGPaintInput = null;

  /** Stroke opacity in 0..1. */
  public strokeOpacity: number = 1;

  /** Stroke width in user units. */
  public strokeWidth: number = 1;

  /** Stroke line cap. */
  public strokeLineCap: SVGLineCap = 'butt';

  /** Stroke line join. */
  public strokeLineJoin: SVGLineJoin = 'miter';

  /** Stroke miter limit. */
  public strokeMiterLimit: number = 4;

  /** Dash pattern. */
  public strokeDashArray: SVGDashArray = null;

  /** Dash offset. */
  public strokeDashOffset: number = 0;

  /** Overall element opacity. */
  public opacity: number = 1;

  /** `mix-blend-mode`. */
  public mixBlendMode: string | null = null;

  /** `isolation: isolate` when `true`. */
  public isolate: boolean = false;

  /** `vector-effect`. */
  public vectorEffect: SVGVectorEffect = 'none';

  /** `paint-order`. */
  public paintOrder: string | null = null;

  /** `shape-rendering`. */
  public shapeRendering: 'auto' | 'optimizeSpeed' | 'crispEdges' | 'geometricPrecision' = 'auto';

  /** `pointer-events`. */
  public pointerEvents: string | null = null;

  /** Font family. */
  public fontFamily: string | null = null;

  /** Font size. */
  public fontSize: number | string | null = null;

  /** Font weight. */
  public fontWeight: number | string | null = null;

  /** Font style. */
  public fontStyle: 'normal' | 'italic' | 'oblique' | null = null;

  /** `text-decoration`. */
  public textDecoration: string | null = null;

  /** `letter-spacing`. */
  public letterSpacing: number | string | null = null;

  /** `word-spacing`. */
  public wordSpacing: number | string | null = null;

  /** `text-anchor`. */
  public textAnchor: SVGTextAnchor = 'start';

  /** `dominant-baseline`. */
  public dominantBaseline: SVGDominantBaseline = 'auto';

  /** `filter` reference. */
  public filter: string | null = null;

  /** `clip-path` reference. */
  public clipPath: string | null = null;

  /** `mask` reference. */
  public mask: string | null = null;

  /** `marker-start` reference. */
  public markerStart: string | null = null;

  /** `marker-mid` reference. */
  public markerMid: string | null = null;

  /** `marker-end` reference. */
  public markerEnd: string | null = null;

  /** `color-interpolation`. */
  public colorInterpolation: 'auto' | 'sRGB' | 'linearRGB' = 'sRGB';

  /**
   * Builds a style from a partial description.
   *
   * @param description Fields to assign.
   * @returns A new style.
   */
  public static from(description: SVGStyleDescription): SVGStyle {
    const style = new SVGStyle();
    style.assign(description);
    return style;
  }

  /**
   * Builds SVG presentation attributes in one call.
   *
   * @param description Fields to convert.
   * @param target Optional object to write into.
   * @returns The attribute bag.
   */
  public static toPresentationAttributes(
    description: SVGStyleDescription,
    target: SVGPresentationAttributes = {},
  ): SVGPresentationAttributes {
    return SVGStyle.from(description).writeInto(target);
  }

  /**
   * Assigns a partial description.
   *
   * @param description Fields to assign.
   * @returns This style, for chaining.
   */
  public assign(description: SVGStyleDescription): this {
    for (const [key, value] of Object.entries(description)) {
      if (value === undefined) continue;
      (this as unknown as Record<string, unknown>)[key] = value;
    }
    return this;
  }

  /**
   * Writes this style as SVG presentation attributes.
   *
   * `undefined`-valued attributes are omitted entirely; `'none'`/absent paints are
   * written explicitly, because SVG's default fill is black and *not* "none".
   *
   * @param target Optional object to write into.
   * @returns The attribute bag.
   */
  public writeInto(target: SVGPresentationAttributes = {}): SVGPresentationAttributes {
    const fill = toSvgPaint(this.fill);
    target['fill'] = fill ?? 'none';

    if (this.fillOpacity < 1) target['fill-opacity'] = formatNumber(this.fillOpacity);
    if (this.fillRule !== 'nonzero') target['fill-rule'] = this.fillRule;

    const stroke = toSvgPaint(this.stroke);
    if (stroke !== undefined) {
      target['stroke'] = stroke;
      if (stroke !== 'none') {
        if (this.strokeWidth !== 1) target['stroke-width'] = formatNumber(this.strokeWidth);
        if (this.strokeLineCap !== 'butt') target['stroke-linecap'] = this.strokeLineCap;
        if (this.strokeLineJoin !== 'miter') target['stroke-linejoin'] = this.strokeLineJoin;
        if (this.strokeMiterLimit !== 4) target['stroke-miterlimit'] = formatNumber(this.strokeMiterLimit);
        if (this.strokeOpacity < 1) target['stroke-opacity'] = formatNumber(this.strokeOpacity);
        const dash = toSvgDashArray(this.strokeDashArray);
        if (dash !== undefined) target['stroke-dasharray'] = dash;
        if (this.strokeDashOffset !== 0) target['stroke-dashoffset'] = formatNumber(this.strokeDashOffset);
      }
    }

    if (this.opacity < 1) target['opacity'] = formatNumber(this.opacity);
    if (this.mixBlendMode !== null) target['mix-blend-mode'] = this.mixBlendMode;
    if (this.isolate) target['isolation'] = 'isolate';
    if (this.vectorEffect !== 'none') target['vector-effect'] = this.vectorEffect;
    if (this.paintOrder !== null) target['paint-order'] = this.paintOrder;
    if (this.shapeRendering !== 'auto') target['shape-rendering'] = this.shapeRendering;
    if (this.pointerEvents !== null) target['pointer-events'] = this.pointerEvents;

    if (this.fontFamily !== null) target['font-family'] = this.fontFamily;
    if (this.fontSize !== null) target['font-size'] = formatFontSize(this.fontSize);
    if (this.fontWeight !== null) target['font-weight'] = String(this.fontWeight);
    if (this.fontStyle !== null && this.fontStyle !== 'normal') target['font-style'] = this.fontStyle;
    if (this.textDecoration !== null) target['text-decoration'] = this.textDecoration;
    if (this.letterSpacing !== null) {
      target['letter-spacing'] =
        typeof this.letterSpacing === 'number' ? formatNumber(this.letterSpacing) : this.letterSpacing;
    }
    if (this.wordSpacing !== null) {
      target['word-spacing'] =
        typeof this.wordSpacing === 'number' ? formatNumber(this.wordSpacing) : this.wordSpacing;
    }
    if (this.textAnchor !== 'start') target['text-anchor'] = this.textAnchor;
    if (this.dominantBaseline !== 'auto') target['dominant-baseline'] = this.dominantBaseline;

    if (this.filter !== null) target['filter'] = this.filter;
    if (this.clipPath !== null) target['clip-path'] = this.clipPath;
    if (this.mask !== null) target['mask'] = this.mask;
    if (this.markerStart !== null) target['marker-start'] = this.markerStart;
    if (this.markerMid !== null) target['marker-mid'] = this.markerMid;
    if (this.markerEnd !== null) target['marker-end'] = this.markerEnd;
    if (this.colorInterpolation !== 'sRGB') target['color-interpolation'] = this.colorInterpolation;

    return target;
  }

  /**
   * Reports the `stroke-width` a consumer should use.
   *
   * A non-scaling stroke keeps its device-pixel width regardless of the camera
   * transform, which is what a 2D scene almost always wants.
   *
   * @param pixelRatio Device-pixel ratio the caller is drawing at.
   * @returns The effective stroke width.
   */
  public getEffectiveStrokeWidth(pixelRatio: number = 1): number {
    if (this.vectorEffect === 'non-scaling-stroke') return this.strokeWidth;
    return this.strokeWidth * Math.max(1, pixelRatio);
  }

  /**
   * Applies `vector-effect: non-scaling-stroke`.
   *
   * @param enabled Whether strokes should ignore the camera scale.
   * @returns This style, for chaining.
   */
  public setNonScalingStroke(enabled: boolean = true): this {
    this.vectorEffect = enabled ? 'non-scaling-stroke' : 'none';
    return this;
  }

  /** @returns The attributes as a `style=""` declaration list. */
  public toStyleAttribute(): string {
    const attributes = this.writeInto({});
    const declarations: string[] = [];
    for (const [key, value] of Object.entries(attributes)) {
      declarations.push(`${key}:${value}`);
    }
    if (this.strokeOpacity < 1 && !('stroke-opacity' in attributes)) {
      declarations.push(`stroke-opacity:${formatNumber(this.strokeOpacity)}`);
    }
    return declarations.join(';');
  }

  /** @returns A copy of this style. */
  public clone(): SVGStyle {
    return new SVGStyle().assign(this.toObject());
  }

  /** @returns A plain description of this style. */
  public toObject(): SVGStyleDescription {
    return {
      fill: this.fill,
      fillOpacity: this.fillOpacity,
      fillRule: this.fillRule,
      stroke: this.stroke,
      strokeOpacity: this.strokeOpacity,
      strokeWidth: this.strokeWidth,
      strokeLineCap: this.strokeLineCap,
      strokeLineJoin: this.strokeLineJoin,
      strokeMiterLimit: this.strokeMiterLimit,
      strokeDashArray: this.strokeDashArray,
      strokeDashOffset: this.strokeDashOffset,
      opacity: this.opacity,
      mixBlendMode: this.mixBlendMode ?? undefined,
      isolate: this.isolate,
      vectorEffect: this.vectorEffect,
      paintOrder: this.paintOrder ?? undefined,
      shapeRendering: this.shapeRendering,
      pointerEvents: this.pointerEvents ?? undefined,
      fontFamily: this.fontFamily ?? undefined,
      fontSize: this.fontSize ?? undefined,
      fontWeight: this.fontWeight ?? undefined,
      fontStyle: this.fontStyle ?? undefined,
      textDecoration: this.textDecoration ?? undefined,
      letterSpacing: this.letterSpacing ?? undefined,
      wordSpacing: this.wordSpacing ?? undefined,
      textAnchor: this.textAnchor,
      dominantBaseline: this.dominantBaseline,
      filter: this.filter ?? undefined,
      clipPath: this.clipPath ?? undefined,
      mask: this.mask ?? undefined,
      markerStart: this.markerStart ?? undefined,
      markerMid: this.markerMid ?? undefined,
      markerEnd: this.markerEnd ?? undefined,
      colorInterpolation: this.colorInterpolation,
    };
  }
}

/**
 * Resolves a `url(#id)` reference, or `'none'`.
 *
 * @param id Identifier without the `url(#` wrapper, or `null`.
 * @returns The reference string.
 */
export function svgUrlReference(id: string | null | undefined): string {
  return id == null || id.length === 0 ? 'none' : `url(#${id})`;
}
