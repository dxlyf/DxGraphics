/**
 * `Glyph` — one character's metrics and its place in an atlas.
 *
 * A glyph is the atom of text rendering: it carries the *metrics* layout needs
 * (advance, bearings, ink size) and the *atlas rectangle* the renderer needs (UVs).
 * Keeping both on one object is what lets `TextLayout` walk a string and emit draw
 * quads without a second lookup table.
 *
 * ```
 *        advance
 *   |<-------------->|
 *   +----------------+          ┌────────────┐  ← region (with padding)
 *   │  ^             │          │ ┌────────┐ │
 *   │  | bearingY    │   maps   │ │  ink   │ │  ← uvRect (padding cropped)
 *   │  v             │  ----->  │ └────────┘ │
 *   +----------------+          └────────────┘
 *   bearingX
 * ```
 *
 * ## Padding
 *
 * The atlas region is always `padding` texels larger than the ink on every side. The
 * padding exists to stop bilinear filtering from bleeding a neighbouring glyph into
 * this one at small sizes. {@link Glyph.getUV} therefore takes a `padding` argument:
 * `true` (the default) returns the **ink** rectangle, cropped inside the padded one,
 * and `false` returns the full region for a caller that wants the bleed.
 *
 * @packageDocumentation
 */

import { GLYPH_PADDING } from '../constants';
import type { GlyphRegion, GlyphUV } from './types';

/** Construction options for a {@link Glyph}. */
export interface GlyphOptions {
  /** Codepoint. */
  codepoint: number;
  /** Pen advance in pixels. */
  advance: number;
  /** Ink width in pixels. */
  width?: number;
  /** Ink height in pixels. */
  height?: number;
  /** Horizontal bearing in pixels. */
  bearingX?: number;
  /** Vertical bearing from the baseline, in pixels. */
  bearingY?: number;
  /** Atlas rectangle, including padding. */
  region?: GlyphRegion;
  /** Atlas page. */
  page?: number;
  /** Padding around the ink inside {@link Glyph.region}. */
  padding?: number;
  /** `false` for a glyph with no bitmap (a space, or a missing character). */
  hasBitmap?: boolean;
  /** Raw atlas pixel data, when the atlas keeps a CPU copy. */
  bitmap?: Uint8Array | null;
}

/**
 * One character's metrics and atlas placement.
 */
export class Glyph {
  /** Codepoint this glyph represents. */
  public readonly codepoint: number;

  /** Pen advance in pixels. */
  public advance: number;

  /** Ink width in pixels. */
  public width: number;

  /** Ink height in pixels. */
  public height: number;

  /** Horizontal bearing: distance from the pen to the ink's left edge. */
  public bearingX: number;

  /** Vertical bearing: distance from the baseline up to the ink's bottom edge. */
  public bearingY: number;

  /** Atlas rectangle, **including** padding. */
  public region: GlyphRegion;

  /** Atlas page index. */
  public page: number;

  /** Padding around the ink inside {@link Glyph.region}, in texels. */
  public padding: number;

  /** `false` for a glyph with no bitmap (whitespace, or an unmapped codepoint). */
  public hasBitmap: boolean;

  /** Raw atlas pixels for this glyph, when the atlas keeps a CPU copy. */
  public bitmap: Uint8Array | null;

  /**
   * Creates a glyph.
   *
   * @param options Codepoint, metrics and atlas placement.
   */
  constructor(options: GlyphOptions) {
    this.codepoint = options.codepoint;
    this.advance = options.advance;
    this.width = options.width ?? 0;
    this.height = options.height ?? 0;
    this.bearingX = options.bearingX ?? 0;
    this.bearingY = options.bearingY ?? 0;
    this.padding = Math.max(0, options.padding ?? GLYPH_PADDING);
    this.page = options.page ?? options.region?.page ?? 0;
    // Parenthesised because `??` and `&&` may not be mixed without grouping: the
    // precedence is not obvious to a reader and esbuild rejects the unparenthesised
    // form outright during the bundle step.
    this.hasBitmap = options.hasBitmap ?? (this.width > 0 && this.height > 0);
    this.bitmap = options.bitmap ?? null;

    this.region = options.region ?? {
      x: 0,
      y: 0,
      width: this.width + this.padding * 2,
      height: this.height + this.padding * 2,
      page: this.page,
    };
  }

  /**
   * The character this glyph represents.
   *
   * @returns A one-character string.
   */
  public get char(): string {
    return String.fromCodePoint(this.codepoint);
  }

  /**
   * The glyph's texture coordinates.
   *
   * @param padding `true` (the default) crops inside the padded region so bilinear
   *   filtering cannot sample a neighbour; `false` returns the whole region.
   * @returns Normalised `u0, v0, u1, v1`.
   */
  public getUV(padding = true): GlyphUV {
    const pad = padding ? this.padding : 0;
    const width = Math.max(1, this.region.width);
    const height = Math.max(1, this.region.height);

    // A glyph whose ink is empty has nothing to sample; collapse the UVs to the centre
    // of its region so a caller that draws it anyway samples a single transparent texel.
    if (width <= pad * 2 || height <= pad * 2) {
      const u = (this.region.x + width * 0.5) / width;
      const v = (this.region.y + height * 0.5) / height;
      return { u0: u, v0: v, u1: u, v1: v };
    }

    return {
      // Note: the denominator is the *region* size, which is only the atlas size when
      // the region covers the whole page. Use `getUVFor` with a real atlas size for
      // any other case; this overload exists for the single-glyph-per-page layout.
      u0: pad / width,
      v0: pad / height,
      u1: (width - pad) / width,
      v1: (height - pad) / height,
    };
  }

  /**
   * The glyph's texture coordinates against an explicit atlas size.
   *
   * The preferred form, because {@link Glyph.getUV} has to assume the region is a
   * whole atlas page, which is only true for a single-glyph page.
   *
   * @param atlasWidth Atlas width in texels.
   * @param atlasHeight Atlas height in texels.
   * @param padding `true` to crop inside the padded region.
   * @returns Normalised `u0, v0, u1, v1`.
   */
  public getUVFor(atlasWidth: number, atlasHeight: number, padding = true): GlyphUV {
    const pad = padding ? this.padding : 0;
    const safeWidth = Math.max(1, atlasWidth);
    const safeHeight = Math.max(1, atlasHeight);

    const left = this.region.x + pad;
    const top = this.region.y + pad;
    const right = Math.max(left, this.region.x + this.region.width - pad);
    const bottom = Math.max(top, this.region.y + this.region.height - pad);

    return {
      u0: left / safeWidth,
      v0: top / safeHeight,
      u1: right / safeWidth,
      v1: bottom / safeHeight,
    };
  }

  /**
   * The draw-quad size of this glyph, in pixels.
   *
   * @returns The ink size.
   */
  public getQuadSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /**
   * The offset from the pen position to the quad's bottom-left corner.
   *
   * @returns The offset, with `y` measured **up** from the baseline.
   */
  public getQuadOffset(): { x: number; y: number } {
    return { x: this.bearingX, y: this.bearingY };
  }

  /**
   * The total height this glyph occupies on a line.
   *
   * @returns `bearingY + height` when positive, otherwise `height`.
   */
  public getAscender(): number {
    return Math.max(this.height, this.bearingY + this.height);
  }

  /**
   * Copies another glyph's values into this one.
   *
   * @param source Glyph to copy.
   * @returns This glyph, for chaining.
   */
  public copy(source: Glyph): this {
    this.advance = source.advance;
    this.width = source.width;
    this.height = source.height;
    this.bearingX = source.bearingX;
    this.bearingY = source.bearingY;
    this.region = { ...source.region };
    this.page = source.page;
    this.padding = source.padding;
    this.hasBitmap = source.hasBitmap;
    this.bitmap = source.bitmap;
    return this;
  }

  /**
   * @returns A deep copy of this glyph.
   */
  public clone(): Glyph {
    return new Glyph({
      codepoint: this.codepoint,
      advance: this.advance,
      width: this.width,
      height: this.height,
      bearingX: this.bearingX,
      bearingY: this.bearingY,
      region: { ...this.region },
      page: this.page,
      padding: this.padding,
      hasBitmap: this.hasBitmap,
      bitmap: this.bitmap,
    });
  }

  /**
   * @returns A JSON-friendly representation.
   */
  public toJSON(): {
    codepoint: number;
    char: string;
    advance: number;
    width: number;
    height: number;
    bearingX: number;
    bearingY: number;
    page: number;
    padding: number;
    region: GlyphRegion;
  } {
    return {
      codepoint: this.codepoint,
      char: this.char,
      advance: this.advance,
      width: this.width,
      height: this.height,
      bearingX: this.bearingX,
      bearingY: this.bearingY,
      page: this.page,
      padding: this.padding,
      region: { ...this.region },
    };
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return (
      `Glyph("${this.char}" U+${this.codepoint.toString(16).toUpperCase().padStart(4, '0')}, ` +
      `advance=${this.advance}, ink=${this.width}x${this.height}, page=${this.page})`
    );
  }
}

/**
 * Builds a whitespace glyph.
 *
 * Whitespace has an advance but no ink, and creating it through the constructor would
 * otherwise produce a zero-size atlas region.
 *
 * @param codepoint Codepoint (usually `32`).
 * @param advance Pen advance in pixels.
 * @param page Atlas page.
 * @returns A glyph with `hasBitmap === false` and a zero-size region.
 */
export function createWhitespaceGlyph(codepoint = 32, advance = 0, page = 0): Glyph {
  return new Glyph({
    codepoint,
    advance,
    width: 0,
    height: 0,
    bearingX: 0,
    bearingY: 0,
    hasBitmap: false,
    region: { x: 0, y: 0, width: 0, height: 0, page },
    page,
    padding: 0,
  });
}

/**
 * Convenience factory mirroring `new Glyph(options)`.
 *
 * @param options Codepoint, metrics and atlas placement.
 * @returns A new glyph.
 */
export function glyph(options: GlyphOptions): Glyph {
  return new Glyph(options);
}
