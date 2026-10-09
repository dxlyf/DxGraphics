/**
 * `Font` — the base class that owns glyph metrics and an atlas.
 *
 * A font is, concretely, four things:
 *
 * 1. a **glyph table** (codepoint → metrics + atlas region),
 * 2. a **kerning table**,
 * 3. **vertical metrics** (`unitsPerEm`, `ascent`, `descent`, `lineGap`) so a line height
 *    can be derived rather than guessed, and
 * 4. an **atlas** holding the bitmaps.
 *
 * `Font` owns those and nothing else. It implements {@link GlyphProvider}, so a
 * `TextLayout` can measure against it directly, and it exposes `getTexture()` so a
 * renderer can upload the atlas without knowing which font produced it.
 *
 * ```ts
 * const font = createFallbackFont({ family: 'Inter', size: 16 });
 * font.hasGlyph('A');            // true — the fallback synthesises every glyph
 * font.measure('Hello', style);  // { width, height, lineCount }
 * font.getTexture();             // an atlas-shaped texture
 * ```
 *
 * ## Subclasses
 *
 * {@link BitmapFont} loads real metrics from a BMFont file; `createFallbackFont` builds a
 * deterministic square-glyph font with no assets at all. Both are `Font`s, and the layout
 * and renderer code cannot tell them apart.
 *
 * @packageDocumentation
 */

import { DEFAULT_FONT_SIZE, GLYPH_PADDING } from '../constants';
import { Disposable } from '../core/Disposable';
import { createId } from '../utils/Id';
import { Glyph, createWhitespaceGlyph } from './Glyph';
import { GlyphAtlas } from './GlyphAtlas';
import { TextLayout, type LayoutResult } from './TextLayout';
import { TextStyle } from './TextStyle';
import type { GlyphProvider, GlyphUV, TextureLike } from './types';

/** Construction options for a {@link Font}. */
export interface FontOptions {
  /** Family name. */
  family?: string;
  /** Nominal size in pixels. */
  size?: number;
  /** Weight. */
  weight?: string | number;
  /** Style. */
  style?: string;
  /** Em size the metrics are expressed in; defaults to the font size. */
  unitsPerEm?: number;
  /** Distance from the baseline to the top of the ascent. */
  ascent?: number;
  /** Distance from the baseline down to the descent. */
  descent?: number;
  /** Extra leading between lines. */
  lineGap?: number;
  /** Atlas to pack into; a fresh one is created when omitted. */
  atlas?: GlyphAtlas;
}

/**
 * A set of glyph metrics, a kerning table and an atlas.
 */
export class Font extends Disposable<'Font'> {
  /** @inheritdoc */
  public override readonly label = 'Font' as const;

  /** Unique identifier. */
  public override readonly id: string = createId('font');

  /** Family name. */
  public family: string;

  /** Nominal size in pixels. */
  public size: number;

  /** Weight. */
  public weight: string | number;

  /** Style. */
  public style: string;

  /** Em size the metrics are expressed in. */
  public unitsPerEm: number;

  /** Distance from the baseline to the top of the ascent, in pixels. */
  public ascent: number;

  /** Distance from the baseline down to the descent, in pixels. */
  public descent: number;

  /** Extra leading between lines, in pixels. */
  public lineGap: number;

  /** Atlas holding the bitmaps. */
  public readonly atlas: GlyphAtlas;

  /** Glyphs by codepoint. */
  protected readonly glyphTable = new Map<number, Glyph>();

  /** Kerning pairs, keyed by `"left,right"`. */
  protected readonly kerningTable = new Map<string, number>();

  /**
   * Creates a font.
   *
   * @param options Family, vertical metrics and atlas.
   */
  constructor(options: FontOptions = {}) {
    super();

    this.family = options.family ?? 'sans-serif';
    this.size = options.size ?? DEFAULT_FONT_SIZE;
    this.weight = options.weight ?? 'normal';
    this.style = options.style ?? 'normal';
    this.unitsPerEm = options.unitsPerEm ?? this.size;
    this.ascent = options.ascent ?? this.size * 0.8;
    this.descent = options.descent ?? this.size * 0.2;
    this.lineGap = options.lineGap ?? 0;

    this.atlas = options.atlas ?? new GlyphAtlas({ padding: GLYPH_PADDING });
    this.addDisposable(this.atlas);
  }

  /* ---------------------------------------------------------------- glyphs */

  /**
   * Adds a glyph, packing its bitmap into the atlas.
   *
   * @param glyph Glyph to add.
   * @returns `true` when it was added and packed.
   */
  public addGlyph(glyph: Glyph): boolean {
    this.assertUsable();
    if (!this.atlas.addGlyph(glyph)) return false;
    this.glyphTable.set(glyph.codepoint, glyph);
    return true;
  }

  /**
   * Adds a whitespace glyph, which occupies no atlas space.
   *
   * @param codepoint Codepoint; defaults to space.
   * @param advance Pen advance in pixels.
   * @returns The created glyph.
   */
  public addWhitespace(codepoint = 32, advance = this.size * 0.25): Glyph {
    const glyph = createWhitespaceGlyph(codepoint, advance);
    this.glyphTable.set(codepoint, glyph);
    return glyph;
  }

  /**
   * Registers a kerning pair.
   *
   * @param left Left codepoint.
   * @param right Right codepoint.
   * @param amount Advance adjustment in pixels.
   * @returns This font, for chaining.
   */
  public addKerning(left: number, right: number, amount: number): this {
    this.kerningTable.set(`${left},${right}`, amount);
    return this;
  }

  /**
   * Looks a glyph up.
   *
   * @param charOrCodepoint Character or codepoint.
   * @returns The glyph, or `undefined`.
   */
  public getGlyph(charOrCodepoint: string | number): Glyph | undefined {
    const codepoint = toCodepoint(charOrCodepoint);
    if (codepoint < 0) return undefined;
    return this.glyphTable.get(codepoint);
  }

  /**
   * `true` when a glyph is present.
   *
   * @param charOrCodepoint Character or codepoint.
   * @returns The presence flag.
   */
  public hasGlyph(charOrCodepoint: string | number): boolean {
    const codepoint = toCodepoint(charOrCodepoint);
    return codepoint >= 0 && this.glyphTable.has(codepoint);
  }

  /**
   * The pen advance of a codepoint.
   *
   * @param codepoint Codepoint.
   * @param fallback Value returned when the glyph is missing.
   * @returns The advance in pixels.
   */
  public getAdvance(codepoint: number, fallback = this.size * 0.5): number {
    const glyph = this.glyphTable.get(codepoint);
    return glyph?.advance ?? fallback;
  }

  /**
   * The kerning adjustment between two codepoints.
   *
   * @param left Left codepoint.
   * @param right Right codepoint.
   * @returns The adjustment in pixels, or `0`.
   */
  public getKerning(left: number, right: number): number {
    return this.kerningTable.get(`${left},${right}`) ?? 0;
  }

  /**
   * The glyphs' texture coordinates.
   *
   * @param charOrCodepoint Character or codepoint.
   * @param padding `true` to crop inside the padded region.
   * @returns The UVs, or `null` when the glyph is absent.
   */
  public getGlyphUV(charOrCodepoint: string | number, padding = true): GlyphUV | null {
    const glyph = this.getGlyph(charOrCodepoint);
    if (glyph === undefined || !glyph.hasBitmap) return null;
    return glyph.getUVFor(this.atlas.width, this.atlas.height, padding);
  }

  /**
   * Every glyph.
   *
   * @returns The glyphs, in insertion order.
   */
  public getGlyphs(): Glyph[] {
    return Array.from(this.glyphTable.values());
  }

  /**
   * Number of glyphs, including whitespace.
   *
   * @returns The glyph count.
   */
  public get glyphCount(): number {
    return this.glyphTable.size;
  }

  /**
   * Every kerning pair.
   *
   * @returns One entry per pair.
   */
  public getKerningPairs(): { left: number; right: number; amount: number }[] {
    const pairs: { left: number; right: number; amount: number }[] = [];
    for (const [key, amount] of this.kerningTable) {
      const comma = key.indexOf(',');
      pairs.push({ left: Number(key.slice(0, comma)), right: Number(key.slice(comma + 1)), amount });
    }
    return pairs;
  }

  /* ------------------------------------------------------------ line metrics */

  /**
   * The recommended line height for a font size.
   *
   * @param size Font size; defaults to {@link Font.size}.
   * @returns `ascent + descent + lineGap`, scaled to `size`.
   */
  public getLineHeight(size: number = this.size): number {
    const scale = this.unitsPerEm > 0 ? size / this.unitsPerEm : 1;
    return (this.ascent + this.descent + this.lineGap) * scale;
  }

  /**
   * The scale factor between {@link Font.unitsPerEm} and a target size.
   *
   * @param size Target size in pixels.
   * @returns The multiplier.
   */
  public getScaleForSize(size: number): number {
    return this.unitsPerEm > 0 ? size / this.unitsPerEm : 1;
  }

  /**
   * The baseline offset from the top of a line of `size`.
   *
   * @param size Font size; defaults to {@link Font.size}.
   * @returns The offset in pixels.
   */
  public getBaselineOffset(size: number = this.size): number {
    return this.ascent * this.getScaleForSize(size);
  }

  /* ---------------------------------------------------------------- measuring */

  /**
   * Measures text using a throwaway {@link TextLayout}.
   *
   * @param text String to measure.
   * @param style Style, or a size in pixels.
   * @param maxWidth Wrap width in pixels; `0` disables wrapping.
   * @returns Width, height and line count.
   */
  public measure(
    text: string,
    style: TextStyle | number = this.size,
    maxWidth = 0,
  ): { width: number; height: number; lineCount: number } {
    const resolved = typeof style === 'number' ? new TextStyle({ fontSize: style }) : style;
    const layout = new TextLayout(this);
    const measurement = layout.measure(text, resolved, {
      maxWidth: maxWidth > 0 ? maxWidth : resolved.maxWidth,
    });
    return { width: measurement.width, height: measurement.height, lineCount: measurement.lineCount };
  }

  /**
   * Lays text out using a throwaway {@link TextLayout}.
   *
   * @param text String to lay out.
   * @param style Style, or a size in pixels.
   * @param maxWidth Wrap width in pixels; `0` disables wrapping.
   * @returns The layout result.
   */
  public layout(text: string, style: TextStyle | number = this.size, maxWidth = 0): LayoutResult {
    const resolved = typeof style === 'number' ? new TextStyle({ fontSize: style }) : style;
    const layout = new TextLayout(this);
    layout.setAtlasSize(this.atlas.width, this.atlas.height);
    return layout.layout(text, resolved, {
      maxWidth: maxWidth > 0 ? maxWidth : resolved.maxWidth,
    });
  }

  /* ------------------------------------------------------------------ texture */

  /**
   * The atlas texture.
   *
   * @returns The texture, or `null` when nothing is packed.
   */
  public getTexture(): TextureLike | null {
    return this.atlas.getTexture();
  }

  /**
   * The atlas size.
   *
   * @returns Width and height in texels.
   */
  public getAtlasSize(): { width: number; height: number } {
    return this.atlas.getAtlasSize();
  }

  /**
   * `true` when the atlas changed since the last upload.
   *
   * @returns The dirty flag.
   */
  public get needsUpdate(): boolean {
    return this.atlas.isDirty;
  }

  /**
   * Marks the atlas as uploaded.
   *
   * @returns This font, for chaining.
   */
  public clearNeedsUpdate(): this {
    this.atlas.clearDirty();
    return this;
  }

  /* ---------------------------------------------------------------- provider */

  /**
   * A {@link GlyphProvider} view of this font.
   *
   * @returns This font, typed as a provider.
   */
  public asProvider(): GlyphProvider {
    return this as unknown as GlyphProvider;
  }

  /* ---------------------------------------------------------------- disposal */

  /**
   * Removes every glyph and kerning pair, keeping the atlas allocated.
   *
   * @returns This font, for chaining.
   */
  public clear(): this {
    this.glyphTable.clear();
    this.kerningTable.clear();
    return this;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    this.glyphTable.clear();
    this.kerningTable.clear();
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `Font("${this.family}", ${this.size}px, glyphs=${this.glyphTable.size}, ` +
      `atlas=${this.atlas.width}x${this.atlas.height})`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Fallback font                                                              */
/* -------------------------------------------------------------------------- */

/** Options accepted by {@link createFallbackFont}. */
export interface FallbackFontOptions {
  /** Family name; defaults to `'fallback'`. */
  family?: string;
  /** Size in pixels; defaults to `DEFAULT_FONT_SIZE`. */
  size?: number;
  /** Advance as a fraction of the size; defaults to `0.6`. */
  advanceRatio?: number;
  /** Codepoints to synthesise; defaults to printable ASCII. */
  codepoints?: readonly number[];
  /** `true` (the default) adds a whitespace glyph for the space character. */
  includeSpace?: boolean;
}

/**
 * Builds a deterministic square-glyph font with no assets.
 *
 * Every requested codepoint gets an identical glyph, so a layout's width is exactly
 * `glyphCount * advance` and a test can assert it. This is what a renderer displays
 * before a real font has loaded, and what the layout tests measure against.
 *
 * @param options Family, size, advance ratio and codepoint set.
 * @returns A font ready for layout.
 */
export function createFallbackFont(options: FallbackFontOptions = {}): Font {
  const size = options.size ?? DEFAULT_FONT_SIZE;
  const advanceRatio = options.advanceRatio ?? 0.6;
  const advance = size * advanceRatio;

  const font = new Font({
    family: options.family ?? 'fallback',
    size,
    unitsPerEm: size,
    ascent: size * 0.8,
    descent: size * 0.2,
    lineGap: size * 0.2,
  });

  const codepoints = options.codepoints ?? defaultCodepoints();
  const includeSpace = options.includeSpace ?? true;

  // Glyphs are packed smallest-first so the shelf packer's "tallest first" assumption is
  // satisfied by the sort inside `GlyphAtlas.packAll`; here they are all the same size, so
  // the order does not matter and insertion order is kept for a predictable region layout.
  for (const codepoint of codepoints) {
    if (codepoint === 32 && includeSpace) {
      font.addWhitespace(32, advance);
      continue;
    }

    const ink = size * 0.7;
    font.addGlyph(
      new Glyph({
        codepoint,
        advance,
        width: ink,
        height: ink,
        bearingX: (advance - ink) * 0.5,
        bearingY: ink,
        padding: GLYPH_PADDING,
      }),
    );
  }

  if (includeSpace && !font.hasGlyph(32)) font.addWhitespace(32, advance);

  font.atlas.resizeToPowerOfTwo();
  return font;
}

/** Printable ASCII, the default fallback glyph set. */
export function defaultCodepoints(): number[] {
  const codepoints: number[] = [];
  for (let codepoint = 32; codepoint < 127; codepoint++) codepoints.push(codepoint);
  return codepoints;
}

/** Resolves a character or codepoint into a codepoint. */
function toCodepoint(charOrCodepoint: string | number): number {
  if (typeof charOrCodepoint === 'number') return charOrCodepoint;
  if (charOrCodepoint.length === 0) return -1;
  return charOrCodepoint.codePointAt(0) ?? -1;
}

/**
 * Convenience factory mirroring `new Font(options)`.
 *
 * @param options Family, vertical metrics and atlas.
 * @returns A new font.
 */
export function font(options: FontOptions = {}): Font {
  return new Font(options);
}
