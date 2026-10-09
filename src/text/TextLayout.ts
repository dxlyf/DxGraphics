/**
 * `TextLayout` — measuring and laying out strings as positioned glyph quads.
 *
 * This is the piece that turns a string plus a style into the numbers a renderer needs:
 * line breaks, per-glyph positions, and atlas UVs. It is deliberately independent of any
 * font-loading machinery, working against the {@link GlyphProvider} interface, so it is
 * exactly testable with a hand-built provider.
 *
 * ## Wrapping algorithm
 *
 * ```
 *   for each paragraph (split on \n):
 *     for each word (split on spaces):
 *       if line + word fits within maxWidth:  append
 *       else if line is empty and word is too long:
 *                 hard-break the word at the last glyph that fits
 *       else:                                flush the line, start a new one
 * ```
 *
 * A line is measured as the **sum of glyph advances** plus letter spacing between glyphs
 * and word spacing per space — not by measuring a whole string — because that is the only
 * way to place each glyph individually, which an atlas renderer requires.
 *
 * ## `measure` versus `layout`
 *
 * `measure` answers "how big will this be?" and stops as soon as it knows, which is what
 * a virtualised list needs when deciding which rows to build. `layout` produces the quads.
 * Both share one wrapping pass, so the two can never disagree.
 *
 * ## Direction
 *
 * **Left-to-right only.** The `direction` option is accepted and stored so a future bidi
 * implementation has somewhere to plug in, and so a caller can already record intent, but
 * no reordering, mirroring or bidi algorithm is applied. Text set in a right-to-left
 * script renders in logical order, which is legible for single-script runs and wrong for
 * mixed runs. This is a documented limitation, not an oversight.
 *
 * ```ts
 * const layout = new TextLayout(provider);
 * const result = layout.layout('Hello world', new TextStyle({ fontSize: 16 }), { maxWidth: 100 });
 * result.lines.length;   // 2, if 100px is not enough for one line
 * result.glyphs[0];      // { char: 'H', x, y, u0, v0, u1, v1, ... }
 * ```
 *
 * @packageDocumentation
 */

import { TextStyle } from './TextStyle';
import type { GlyphProvider, GlyphUV, TextLayoutOptions, TextStyleInit } from './types';

/** The subset of `TextStyle` the layout code reads. */
export interface LayoutStyle {
  /** Font size in pixels. */
  fontSize: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** Horizontal alignment. */
  align: string;
  /** Vertical baseline. */
  baseline: string;
  /** Letter spacing in pixels. */
  letterSpacing: number;
  /** Extra per-word spacing in pixels. */
  wordSpacing: number;
  /** Maximum line width in pixels; `0` disables wrapping. */
  maxWidth: number;
  /** Padding in pixels. */
  padding: number;
  /** Word-break strategy. */
  wordBreak: string;
}

/** Structural glyph record the providers return. */
export interface GlyphLikeRecord {
  /** Codepoint. */
  codepoint: number;
  /** Pen advance. */
  advance: number;
  /** Ink width. */
  width: number;
  /** Ink height. */
  height: number;
  /** Horizontal bearing. */
  bearingX: number;
  /** Vertical bearing from the baseline. */
  bearingY: number;
  /** Atlas page. */
  page: number;
  /** Atlas rectangle. */
  region: { x: number; y: number; width: number; height: number; page: number };
}

/** One positioned glyph in a laid-out block. */
export interface LayoutGlyphQuad {
  /** Source character. */
  char: string;
  /** Codepoint. */
  codepoint: number;
  /** Left edge, in layout pixels. */
  x: number;
  /** Top edge, in layout pixels. */
  y: number;
  /** Quad width in pixels. */
  width: number;
  /** Quad height in pixels. */
  height: number;
  /** Left U. */
  u0: number;
  /** Top V. */
  v0: number;
  /** Right U. */
  u1: number;
  /** Bottom V. */
  v1: number;
  /** Line index. */
  lineIndex: number;
  /** Atlas page. */
  page: number;
}

/** One laid-out line. */
export interface LayoutLine {
  /** Text of the line, after wrapping. */
  text: string;
  /** Left edge of the line's first glyph. */
  x: number;
  /** Baseline Y from the top of the block. */
  y: number;
  /** Measured width. */
  width: number;
  /** Glyphs on the line. */
  glyphs: LayoutGlyphQuad[];
  /** `true` when the line ended at an explicit newline. */
  hardBreak: boolean;
}

/** The full result of a layout pass. */
export interface LayoutResult {
  /** Lines, top to bottom. */
  lines: LayoutLine[];
  /** Every glyph, flattened. */
  glyphs: LayoutGlyphQuad[];
  /** Width of the widest line. */
  width: number;
  /** Block height. */
  height: number;
  /** Line height used, in pixels. */
  lineHeight: number;
  /** Baseline offset of the first line. */
  baseline: number;
  /** Line count. */
  lineCount: number;
  /** Glyph count. */
  glyphCount: number;
  /** The source string. */
  text: string;
}

/** The result of a measurement. */
export interface LayoutMeasurement {
  /** Width of the widest line. */
  width: number;
  /** Block height. */
  height: number;
  /** Line count. */
  lineCount: number;
  /** The wrapped lines. */
  lines: string[];
  /** Line height used. */
  lineHeight: number;
}

/** A measured word, cached across lines. */
interface WordMetrics {
  /** Codepoint per glyph. */
  codepoints: number[];
  /** Total advance including letter and word spacing. */
  width: number;
}

/** A wrapped line before alignment is applied. */
interface WrappedLine {
  /** Line text. */
  text: string;
  /** Line codepoints. */
  codepoints: number[];
  /** Measured width. */
  width: number;
  /** `true` when the line ended at an explicit newline. */
  hardBreak: boolean;
}

/**
 * A provider that produces square glyphs of a fixed advance.
 *
 * The deterministic fallback every text path can rely on: no font file, no atlas, no
 * measurement API — and a layouter that still produces correct-looking output with an
 * exactly predictable width (`glyphs * size`). It is what makes `TextLayout` testable,
 * and what a renderer uses before a font has finished loading.
 */
export class MonospaceGlyphProvider implements GlyphProvider {
  /** Ink size and advance, in pixels. */
  public readonly size: number;

  /** Font size the metrics describe. */
  public readonly fontSize: number;

  /** Line height recommendation. */
  public readonly lineHeight: number;

  /**
   * Creates a monospace provider.
   *
   * @param size Ink size and advance, in pixels; defaults to `8`.
   */
  constructor(size = 8) {
    this.size = size;
    this.fontSize = size;
    this.lineHeight = size * 1.2;
  }

  /**
   * Returns a fixed-size glyph for any codepoint.
   *
   * @param codepoint Codepoint.
   * @returns A glyph-shaped record; whitespace has zero ink.
   */
  public getGlyph(codepoint: number): GlyphLikeRecord {
    const isSpace = codepoint === 32 || codepoint === 9 || codepoint === 10;
    return {
      codepoint,
      advance: this.size,
      width: isSpace ? 0 : this.size,
      height: isSpace ? 0 : this.size,
      bearingX: 0,
      bearingY: isSpace ? 0 : this.size,
      page: 0,
      region: {
        x: 0,
        y: 0,
        width: isSpace ? 0 : this.size,
        height: isSpace ? 0 : this.size,
        page: 0,
      },
    };
  }

  /**
   * Advances are uniform, so kerning is always zero.
   *
   * @param left Left codepoint.
   * @param right Right codepoint.
   * @returns `0`.
   */
  public getKerning(left: number, right: number): number {
    void left;
    void right;
    return 0;
  }

  /**
   * The uniform advance.
   *
   * @param codepoint Codepoint.
   * @returns The advance.
   */
  public getAdvance(codepoint: number): number {
    void codepoint;
    return this.size;
  }
}

/**
 * Lays out strings into positioned glyph quads.
 */
export class TextLayout {
  /** Provider supplying glyph metrics. */
  public glyphProvider: GlyphProvider | null;

  /** Total layouts performed, for diagnostics. */
  public layoutCount = 0;

  /** Atlas width used to normalise UVs; `0` when unknown. */
  private atlasWidth = 0;

  /** Atlas height used to normalise UVs; `0` when unknown. */
  private atlasHeight = 0;

  /** Letter spacing of the style being laid out. */
  private letterSpacing = 0;

  /**
   * Creates a layout engine.
   *
   * @param provider Glyph metrics provider, or `null` to require one per call.
   */
  constructor(provider: GlyphProvider | null = null) {
    this.glyphProvider = provider;
  }

  /**
   * Replaces the glyph provider.
   *
   * @param provider New provider.
   * @returns This layout, for chaining.
   */
  public setGlyphProvider(provider: GlyphProvider | null): this {
    this.glyphProvider = provider;
    return this;
  }

  /**
   * Sets the atlas size used to normalise UVs.
   *
   * Without it, UVs fall back to a whole-region normalisation, which is only correct for a
   * one-glyph-per-page atlas. A caller rendering from a real atlas should always set this.
   *
   * @param width Atlas width in texels.
   * @param height Atlas height in texels.
   * @returns This layout, for chaining.
   */
  public setAtlasSize(width: number, height: number): this {
    this.atlasWidth = Math.max(1, width);
    this.atlasHeight = Math.max(1, height);
    return this;
  }

  /* -------------------------------------------------------------- public API */

  /**
   * Measures a string without producing quads.
   *
   * @param text String to measure.
   * @param style Style, a partial initialiser, or a bare style record.
   * @param options Layout overrides.
   * @returns The measurement.
   */
  public measure(
    text: string,
    style: TextStyle | LayoutStyle | TextStyleInit = {},
    options: TextLayoutOptions = {},
  ): LayoutMeasurement {
    const resolved = resolveStyle(style);
    const effective = mergeOptions(resolved, options);
    this.letterSpacing = resolved.letterSpacing;

    const wrapped = this.wrap(text, effective, resolved);
    let width = 0;
    for (const line of wrapped) if (line.width > width) width = line.width;

    const lineHeight = resolved.lineHeight * resolved.fontSize;
    return {
      width,
      height: wrapped.length * lineHeight,
      lineCount: wrapped.length,
      lines: wrapped.map((line) => line.text),
      lineHeight,
    };
  }

  /**
   * Lays out a string.
   *
   * @param text String to lay out.
   * @param style Style, a partial initialiser, or a bare style record.
   * @param options Layout overrides.
   * @returns The layout result.
   */
  public layout(
    text: string,
    style: TextStyle | LayoutStyle | TextStyleInit = {},
    options: TextLayoutOptions = {},
  ): LayoutResult {
    const resolved = resolveStyle(style);
    const effective = mergeOptions(resolved, options);
    this.letterSpacing = resolved.letterSpacing;
    this.layoutCount++;

    const wrapped = this.wrap(text, effective, resolved);

    let widest = 0;
    for (const line of wrapped) if (line.width > widest) widest = line.width;

    const lineHeight = resolved.lineHeight * resolved.fontSize;
    const baseline = baselineOffsetFor(resolved.baseline, resolved.fontSize, lineHeight);

    const lines: LayoutLine[] = [];
    const allGlyphs: LayoutGlyphQuad[] = [];

    for (let lineIndex = 0; lineIndex < wrapped.length; lineIndex++) {
      const entry = wrapped[lineIndex];
      const originX = alignLineX(entry.width, widest, resolved, effective);
      const lineY = lineIndex * lineHeight;
      const baselineY = baseline + lineY;

      const glyphs: LayoutGlyphQuad[] = [];
      const extraPerGap = justifiedExtra(entry, widest, resolved, effective);
      let penX = originX;

      for (let i = 0; i < entry.codepoints.length; i++) {
        const codepoint = entry.codepoints[i];
        const glyph = this.glyphProvider?.getGlyph(codepoint);

        if (glyph !== undefined && glyph.width > 0 && glyph.height > 0) {
          const uv = this.uvFor(glyph);
          glyphs.push({
            char: String.fromCodePoint(codepoint),
            codepoint,
            x: penX + glyph.bearingX,
            // `bearingY` is measured up from the baseline, so the quad's top edge is
            // `baseline - bearingY - height` in a y-down coordinate system.
            y: baselineY - glyph.bearingY,
            width: glyph.width,
            height: glyph.height,
            u0: uv.u0,
            v0: uv.v0,
            u1: uv.u1,
            v1: uv.v1,
            lineIndex,
            page: glyph.page,
          });
        }

        penX += this.advanceFor(codepoint, entry.codepoints[i + 1]);
        if (codepoint === 32) penX += resolved.wordSpacing;
        penX += extraPerGap;
      }

      lines.push({
        text: entry.text,
        x: originX,
        y: lineY,
        width: entry.width,
        glyphs,
        hardBreak: entry.hardBreak,
      });

      for (const glyph of glyphs) allGlyphs.push(glyph);
    }

    return {
      lines,
      glyphs: allGlyphs,
      width: widest,
      height: wrapped.length * lineHeight,
      lineHeight,
      baseline,
      lineCount: lines.length,
      glyphCount: allGlyphs.length,
      text,
    };
  }

  /**
   * The advance of one codepoint, including kerning toward the next.
   *
   * @param codepoint Codepoint.
   * @param nextCodepoint Following codepoint, when known.
   * @returns The advance in pixels.
   */
  public advanceFor(codepoint: number, nextCodepoint?: number): number {
    const provider = this.glyphProvider;
    let advance: number;

    if (provider === null) {
      // No provider: a half-em advance keeps a layout's proportions usable instead of
      // collapsing every line to zero width.
      advance = 0.5;
    } else {
      const direct = provider.getAdvance?.(codepoint);
      const glyph = provider.getGlyph(codepoint);
      advance = direct !== undefined && direct > 0 ? direct : glyph !== undefined ? glyph.advance : 0.5;
    }

    const kerning =
      nextCodepoint === undefined ? 0 : (this.glyphProvider?.getKerning?.(codepoint, nextCodepoint) ?? 0);

    return advance + kerning + this.letterSpacing;
  }

  /* --------------------------------------------------------------- wrapping */

  /** Wraps a string into lines. */
  private wrap(text: string, options: ResolvedLayoutOptions, style: LayoutStyle): WrappedLine[] {
    const maxWidth = options.maxWidth > 0 ? options.maxWidth : Infinity;
    const tabSpaces = Math.max(1, options.tabSize);

    const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
    const lines: WrappedLine[] = [];

    for (let p = 0; p < paragraphs.length; p++) {
      const paragraph = paragraphs[p];
      const isLastParagraph = p === paragraphs.length - 1;

      const codepoints: number[] = [];
      for (const char of paragraph) {
        if (char === '\t') {
          for (let i = 0; i < tabSpaces; i++) codepoints.push(32);
          continue;
        }
        const value = char.codePointAt(0);
        if (value !== undefined) codepoints.push(value);
      }

      if (codepoints.length === 0) {
        lines.push({ text: '', codepoints: [], width: 0, hardBreak: !isLastParagraph });
        continue;
      }

      const wrapped = this.wrapParagraph(codepoints, maxWidth, options, style);
      for (let i = 0; i < wrapped.length; i++) {
        const last = i === wrapped.length - 1;
        lines.push({ ...wrapped[i], hardBreak: last && !isLastParagraph });
      }
    }

    if (lines.length === 0) lines.push({ text: '', codepoints: [], width: 0, hardBreak: false });
    return lines;
  }

  /** Wraps one paragraph. */
  private wrapParagraph(
    codepoints: number[],
    maxWidth: number,
    options: ResolvedLayoutOptions,
    style: LayoutStyle,
  ): WrappedLine[] {
    const lines: WrappedLine[] = [];
    const words = this.splitWords(codepoints, options);

    let lineCodepoints: number[] = [];
    let lineWidth = 0;

    const flush = (): void => {
      let final = lineCodepoints;
      let text = codepointsToText(final);
      let width = lineWidth;

      if (options.trimLines) {
        let start = 0;
        let end = final.length;
        while (start < end && final[start] === 32) start++;
        while (end > start && final[end - 1] === 32) end--;
        final = final.slice(start, end);
        text = codepointsToText(final);
        width = this.measureCodepoints(final);
      }

      lines.push({ text, codepoints: final, width, hardBreak: false });
      lineCodepoints = [];
      lineWidth = 0;
    };

    for (const word of words) {
      const wordWidth = word.width;

      if (lineCodepoints.length === 0) {
        if (wordWidth > maxWidth) {
          // A single word wider than the line: break it, which may open several lines.
          const broken = this.breakWord(word.codepoints, maxWidth, options, style, lines);
          lineCodepoints = broken.codepoints;
          lineWidth = broken.width;
        } else {
          lineCodepoints = word.codepoints.slice();
          lineWidth = wordWidth;
        }
        continue;
      }

      if (lineWidth + wordWidth <= maxWidth) {
        lineCodepoints.push(...word.codepoints);
        lineWidth += wordWidth;
        continue;
      }

      flush();

      if (wordWidth > maxWidth) {
        const broken = this.breakWord(word.codepoints, maxWidth, options, style, lines);
        lineCodepoints = broken.codepoints;
        lineWidth = broken.width;
      } else {
        lineCodepoints = word.codepoints.slice();
        lineWidth = wordWidth;
      }
    }

    if (lineCodepoints.length > 0 || lines.length === 0) flush();
    return lines;
  }

  /** Splits codepoints into words, keeping each trailing space with its word. */
  private splitWords(codepoints: number[], options: ResolvedLayoutOptions): WordMetrics[] {
    const words: WordMetrics[] = [];
    let current: number[] = [];

    for (const codepoint of codepoints) {
      const isSpace = codepoint === 32;
      if (isSpace && options.collapseWhitespace && current.length > 0 && current[current.length - 1] === 32) {
        continue;
      }
      current.push(codepoint);
      if (isSpace) {
        words.push({ codepoints: current, width: this.measureCodepoints(current) });
        current = [];
      }
    }

    if (current.length > 0) {
      words.push({ codepoints: current, width: this.measureCodepoints(current) });
    }
    return words;
  }

  /** Hard-breaks a word that exceeds the line width. */
  private breakWord(
    codepoints: number[],
    maxWidth: number,
    options: ResolvedLayoutOptions,
    style: LayoutStyle,
    lines: WrappedLine[],
  ): { codepoints: number[]; width: number } {
    if (!options.breakLongWords || options.wordBreak === 'keep-all' || maxWidth === Infinity) {
      return { codepoints: codepoints.slice(), width: this.measureCodepoints(codepoints) };
    }

    let accumulator: number[] = [];
    let accumulatorWidth = 0;

    for (let i = 0; i < codepoints.length; i++) {
      const codepoint = codepoints[i];
      const advance = this.advanceFor(codepoint, codepoints[i + 1]);

      if (accumulator.length > 0 && accumulatorWidth + advance > maxWidth) {
        lines.push({
          text: codepointsToText(accumulator),
          codepoints: accumulator,
          width: accumulatorWidth,
          hardBreak: false,
        });
        accumulator = [];
        accumulatorWidth = 0;
      }

      accumulator.push(codepoint);
      accumulatorWidth += advance;
    }

    return { codepoints: accumulator, width: accumulatorWidth };
  }

  /** Measures a run of codepoints, honouring kerning and spacing. */
  private measureCodepoints(codepoints: readonly number[]): number {
    let width = 0;
    for (let i = 0; i < codepoints.length; i++) {
      width += this.advanceFor(codepoints[i], codepoints[i + 1]);
    }
    return width;
  }

  /** Computes UVs for a glyph, using the atlas size when known. */
  private uvFor(glyph: GlyphLikeRecord): GlyphUV {
    if (this.atlasWidth > 0 && this.atlasHeight > 0) {
      return {
        u0: glyph.region.x / this.atlasWidth,
        v0: glyph.region.y / this.atlasHeight,
        u1: (glyph.region.x + glyph.region.width) / this.atlasWidth,
        v1: (glyph.region.y + glyph.region.height) / this.atlasHeight,
      };
    }

    // No atlas size: whole-region normalisation is the only well-defined answer, and it is
    // exactly right for a one-glyph-per-page atlas.
    return { u0: 0, v0: 0, u1: 1, v1: 1 };
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return `TextLayout(provider=${this.glyphProvider === null ? 'none' : 'set'}, layouts=${this.layoutCount})`;
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/** Fully resolved layout options. */
interface ResolvedLayoutOptions {
  /** Wrap width, or `0` for none. */
  maxWidth: number;
  /** Line height override in pixels, or `0` when the style's ratio is used. */
  lineHeight: number;
  /** Word-break strategy. */
  wordBreak: string;
  /** `true` breaks an over-long word. */
  breakLongWords: boolean;
  /** Tab width in spaces. */
  tabSize: number;
  /** `true` trims each line. */
  trimLines: boolean;
  /** `true` collapses whitespace runs. */
  collapseWhitespace: boolean;
}

/** Resolves a style-like argument into a {@link LayoutStyle}. */
function resolveStyle(style: TextStyle | LayoutStyle | TextStyleInit): LayoutStyle {
  if (style instanceof TextStyle) {
    return {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      align: style.align,
      baseline: style.baseline,
      letterSpacing: style.letterSpacing,
      wordSpacing: style.wordSpacing,
      maxWidth: style.maxWidth,
      padding: style.padding,
      wordBreak: style.wordBreak,
    };
  }

  const candidate = style as Partial<LayoutStyle>;
  if (typeof candidate.fontSize === 'number' && typeof candidate.lineHeight === 'number') {
    return {
      fontSize: candidate.fontSize,
      lineHeight: candidate.lineHeight,
      align: candidate.align ?? 'left',
      baseline: candidate.baseline ?? 'top',
      letterSpacing: candidate.letterSpacing ?? 0,
      wordSpacing: candidate.wordSpacing ?? 0,
      maxWidth: candidate.maxWidth ?? 0,
      padding: candidate.padding ?? 0,
      wordBreak: candidate.wordBreak ?? 'normal',
    };
  }

  const built = TextStyle.from(style as TextStyleInit);
  return {
    fontSize: built.fontSize,
    lineHeight: built.lineHeight,
    align: built.align,
    baseline: built.baseline,
    letterSpacing: built.letterSpacing,
    wordSpacing: built.wordSpacing,
    maxWidth: built.maxWidth,
    padding: built.padding,
    wordBreak: built.wordBreak,
  };
}

/** Merges explicit options over a style's own values. */
function mergeOptions(style: LayoutStyle, options: TextLayoutOptions): ResolvedLayoutOptions {
  return {
    maxWidth: options.maxWidth ?? style.maxWidth,
    lineHeight: options.lineHeight ?? 0,
    wordBreak: options.wordBreak ?? style.wordBreak,
    breakLongWords: options.breakLongWords ?? true,
    tabSize: options.tabSize ?? 4,
    trimLines: options.trimLines ?? false,
    collapseWhitespace: options.collapseWhitespace ?? false,
  };
}

/** Converts codepoints back into a string. */
function codepointsToText(codepoints: readonly number[]): string {
  let out = '';
  for (const codepoint of codepoints) out += String.fromCodePoint(codepoint);
  return out;
}

/** The baseline offset from the top of a line. */
function baselineOffsetFor(baseline: string, fontSize: number, lineHeight: number): number {
  switch (baseline) {
    case 'top':
      return fontSize;
    case 'hanging':
      return fontSize * 0.8;
    case 'middle':
      return lineHeight * 0.5 + fontSize * 0.35;
    case 'ideographic':
    case 'bottom':
      return lineHeight;
    case 'alphabetic':
    default:
      return fontSize * 0.8;
  }
}

/** The X origin of a line under the active alignment. */
function alignLineX(
  lineWidth: number,
  blockWidth: number,
  style: LayoutStyle,
  options: ResolvedLayoutOptions,
): number {
  const padding = style.padding;
  const available = options.maxWidth > 0 ? options.maxWidth : blockWidth;

  switch (style.align) {
    case 'center':
      return padding + Math.max(0, (available - lineWidth) * 0.5);
    case 'right':
      return padding + Math.max(0, available - lineWidth);
    case 'justify':
    case 'left':
    default:
      return padding;
  }
}

/** Per-gap extra spacing for a justified line. */
function justifiedExtra(
  line: WrappedLine,
  blockWidth: number,
  style: LayoutStyle,
  options: ResolvedLayoutOptions,
): number {
  if (style.align !== 'justify') return 0;
  const available = options.maxWidth > 0 ? options.maxWidth : blockWidth;
  const gaps = countGaps(line.codepoints);
  if (gaps === 0) return 0;
  const slack = available - line.width;
  // Never shrink a line to justify it; only positive slack is distributed.
  return slack > 0 ? slack / gaps : 0;
}

/** Counts the inter-glyph gaps that justification distributes slack across. */
function countGaps(codepoints: readonly number[]): number {
  let gaps = 0;
  for (let i = 0; i < codepoints.length; i++) {
    if (codepoints[i] === 32) {
      // A space contributes the gap on either side of itself.
      gaps += 2;
    } else if (i < codepoints.length - 1) {
      gaps += 1;
    }
  }
  return gaps;
}

/**
 * Convenience factory mirroring `new TextLayout(provider)`.
 *
 * @param provider Glyph metrics provider.
 * @returns A new layout engine.
 */
export function textLayout(provider: GlyphProvider | null = null): TextLayout {
  return new TextLayout(provider);
}
