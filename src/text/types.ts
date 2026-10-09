/**
 * Shared type vocabulary for the text subsystem.
 *
 * Text rendering has an unusual dependency profile: the *layout* code needs a way to
 * measure a glyph, the *atlas* code needs to hand a texture to a renderer, and both
 * need to work before any of those subsystems exist. Everything cross-module is
 * therefore a structural interface here, so `src/text` imports nothing but `src/math`,
 * `src/core` and `src/utils`.
 *
 * @packageDocumentation
 */

import type { Color } from '../math/Color';
import type { Rect } from '../math/Rect';
import type { Vec2 } from '../math/Vec2';

/* -------------------------------------------------------------------------- */
/* Typography                                                                 */
/* -------------------------------------------------------------------------- */

/** Horizontal alignment of a text block. */
export type TextAlign = 'left' | 'center' | 'right' | 'justify';

/** Vertical alignment of a single line relative to its baseline. */
export type TextBaseline = 'top' | 'hanging' | 'middle' | 'alphabetic' | 'ideographic' | 'bottom';

/** Font weight, as a CSS-style number or a keyword. */
export type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 'normal' | 'bold';

/** Font style. */
export type FontStyle = 'normal' | 'italic' | 'oblique';

/** Writing direction. */
export type TextDirection = 'ltr' | 'rtl';

/** Word-breaking strategy applied when a word does not fit. */
export type WordBreak = 'normal' | 'break-all' | 'keep-all';

/* -------------------------------------------------------------------------- */
/* Glyph metrics                                                              */
/* -------------------------------------------------------------------------- */

/** The metrics one glyph contributes to a layout. */
export interface GlyphMetrics {
  /** Codepoint. */
  codepoint: number;
  /** Pen advance, in font units scaled to pixels. */
  advance: number;
  /** Horizontal bearing, in pixels. */
  bearingX: number;
  /** Vertical bearing from the baseline, in pixels. */
  bearingY: number;
  /** Ink width, in pixels. */
  width: number;
  /** Ink height, in pixels. */
  height: number;
  /** Atlas page the glyph lives on. */
  page: number;
}

/** A glyph's atlas rectangle. */
export interface GlyphRegion {
  /** Left edge in texels. */
  x: number;
  /** Top edge in texels. */
  y: number;
  /** Region width in texels, including padding on both sides. */
  width: number;
  /** Region height in texels, including padding on both sides. */
  height: number;
  /** Atlas page. */
  page: number;
}

/** Normalised texture coordinates for a glyph. */
export interface GlyphUV {
  /** Left U. */
  u0: number;
  /** Top V. */
  v0: number;
  /** Right U. */
  u1: number;
  /** Bottom V. */
  v1: number;
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

/** One positioned glyph in a laid-out block. */
export interface GlyphQuad {
  /** Source character. */
  char: string;
  /** Codepoint. */
  codepoint: number;
  /** Left edge in layout space, in pixels. */
  x: number;
  /** Top edge in layout space, in pixels. */
  y: number;
  /** Quad width in pixels. */
  width: number;
  /** Quad height in pixels. */
  height: number;
  /** Left U in the atlas. */
  u0: number;
  /** Top V in the atlas. */
  v0: number;
  /** Right U in the atlas. */
  u1: number;
  /** Bottom V in the atlas. */
  v1: number;
  /** Zero-based line index. */
  lineIndex: number;
  /** Atlas page. */
  page: number;
}

/** One laid-out line. */
export interface TextLayoutLine {
  /** Line text, after wrapping. */
  text: string;
  /** Left edge of the line's first glyph, in pixels. */
  x: number;
  /** Baseline Y, in pixels from the top of the block. */
  baseline: number;
  /** Measured advance width of the line. */
  width: number;
  /** Glyphs on this line. */
  glyphs: GlyphQuad[];
  /** `true` when the line was ended by an explicit newline. */
  hardBreak: boolean;
}

/** The result of laying out a string. */
export interface TextLayoutResult {
  /** Lines, top to bottom. */
  lines: TextLayoutLine[];
  /** Every glyph, flattened across lines. */
  glyphs: GlyphQuad[];
  /** Longest line width, in pixels. */
  width: number;
  /** Total block height, in pixels. */
  height: number;
  /** Line height actually used, in pixels. */
  lineHeight: number;
  /** Baseline offset from the top of the first line, in pixels. */
  baseline: number;
  /** Number of lines. */
  lineCount: number;
  /** Number of glyphs. */
  glyphCount: number;
  /** The source string. */
  text: string;
}

/** A measurement without a full layout. */
export interface TextMeasurement {
  /** Longest line width, in pixels. */
  width: number;
  /** Block height, in pixels. */
  height: number;
  /** Number of lines the text wraps to. */
  lineCount: number;
  /** The wrapped lines. */
  lines: string[];
  /** Line height used, in pixels. */
  lineHeight: number;
}

/** Options accepted by the layout helpers. */
export interface TextLayoutOptions {
  /** Maximum line width, in pixels; `0` or `Infinity` disables wrapping. */
  maxWidth?: number;
  /** Explicit line break, in pixels; defaults to `lineHeight * fontSize`. */
  lineHeight?: number;
  /** Horizontal alignment. */
  align?: TextAlign;
  /** Extra space between glyphs, in pixels. */
  letterSpacing?: number;
  /** Extra space added to each space character, in pixels. */
  wordSpacing?: number;
  /** Word-break strategy. */
  wordBreak?: WordBreak;
  /** Hard-break a single word longer than `maxWidth`; defaults to `true`. */
  breakLongWords?: boolean;
  /** Width of a tab stop, in space widths; defaults to `4`. */
  tabSize?: number;
  /** Spaces inserted for a tab character. */
  tabCharacter?: string;
  /** Drop leading/trailing whitespace on every line. */
  trimLines?: boolean;
  /** Collapse runs of whitespace into one space. */
  collapseWhitespace?: boolean;
  /** Writing direction; only `'ltr'` is implemented — see the module note. */
  direction?: TextDirection;
}

/* -------------------------------------------------------------------------- */
/* Atlases                                                                    */
/* -------------------------------------------------------------------------- */

/** Construction options for a glyph atlas. */
export interface GlyphAtlasOptions {
  /** Initial width in texels; defaults to `256`. */
  width?: number;
  /** Initial height in texels; defaults to `256`. */
  height?: number;
  /** Padding around every glyph, in texels; defaults to `GLYPH_PADDING`. */
  padding?: number;
  /** Grow by doubling when full; defaults to `true`. */
  grow?: boolean;
  /** Largest page dimension growth is allowed to reach; defaults to `4096`. */
  maxSize?: number;
  /** Page index this atlas represents; defaults to `0`. */
  page?: number;
}

/** Atlas fill statistics. */
export interface GlyphAtlasStats {
  /** Page width in texels. */
  width: number;
  /** Page height in texels. */
  height: number;
  /** Glyph cells packed. */
  glyphCount: number;
  /** Rows (shelves) used. */
  rowCount: number;
  /** Texels covered by glyph cells, excluding padding. */
  usedArea: number;
  /** Total texels on the page. */
  totalArea: number;
  /** `usedArea / totalArea`. */
  fillRatio: number;
  /** Number of times the page grew. */
  growthCount: number;
  /** Page index. */
  page: number;
}

/** One shelf in the packer. */
export interface AtlasShelf {
  /** Top edge of the shelf, in texels. */
  y: number;
  /** Shelf height, in texels. */
  height: number;
  /** Next free X on the shelf. */
  cursorX: number;
}

/** Structural view of a texture the atlas hands to a renderer. */
export interface TextureLike {
  /** Atlas page index. */
  page?: number;
  /** Backing image; the atlas stores a plain record it can be uploaded from. */
  image?: unknown;
  /** Alias of `image`, matching the DOM convention. */
  source?: unknown;
  /** Width in texels. */
  width?: number;
  /** Height in texels. */
  height?: number;
  /** `true` when the bytes changed and the renderer must re-upload. */
  needsUpdate?: boolean;
  /** `true` when the atlas holds an alpha-only page. */
  alphaOnly?: boolean;
  /** Releases GPU resources. */
  dispose?(): void;
}

/* -------------------------------------------------------------------------- */
/* SDF                                                                        */
/* -------------------------------------------------------------------------- */

/** Options accepted by the signed-distance-field generator. */
export interface SDFOptions {
  /**
   * Distance spread in pixels. The field saturates at `+/-radius`, so a larger radius
   * gives a smoother edge and a wider usable font size range.
   */
  radius?: number;
  /** Iso-value the field is normalised around; defaults to `0.5`. */
  cutoff?: number;
  /**
   * `true` (the default) makes inside pixels positive.
   *
   * The opposite convention is available because some engines sample `1 - d`.
   */
  insideIsPositive?: boolean;
  /** Inverts the alpha bitmap before computing distances. */
  invert?: boolean;
  /** Alpha threshold above which a pixel counts as "inside"; defaults to `0.5`. */
  threshold?: number;
}

/** A generated signed distance field. */
export interface SDFResult {
  /** Field values in `[-1, 1]`, row-major. */
  data: Float32Array;
  /** Field width in samples. */
  width: number;
  /** Field height in samples. */
  height: number;
  /** Spread used to generate it. */
  radius: number;
  /** Iso-value the field is centred on. */
  cutoff: number;
  /** `true` when inside pixels are positive. */
  insideIsPositive: boolean;
}

/* -------------------------------------------------------------------------- */
/* Bitmap fonts                                                               */
/* -------------------------------------------------------------------------- */

/** One glyph record from a BMFont file. */
export interface BMFontGlyph {
  /** Codepoint. */
  id: number;
  /** Atlas X. */
  x: number;
  /** Atlas Y. */
  y: number;
  /** Cell width. */
  width: number;
  /** Cell height. */
  height: number;
  /** Horizontal bearing. */
  xoffset: number;
  /** Vertical bearing. */
  yoffset: number;
  /** Pen advance. */
  xadvance: number;
  /** Atlas page. */
  page: number;
  /** Channel selector. */
  chnl: number;
}

/** The `info` block of a BMFont file. */
export interface BMFontInfo {
  /** Typeface name. */
  face: string;
  /** Nominal size. */
  size: number;
  /** `true` for a bold face. */
  bold: boolean;
  /** `true` for an italic face. */
  italic: boolean;
  /** Character set. */
  charset: string;
  /** `true` when glyphs are anti-aliased. */
  unicode: boolean;
  /** Padding, as `[up, right, down, left]`. */
  padding: [number, number, number, number];
  /** Spacing, as `[horizontal, vertical]`. */
  spacing: [number, number];
  /** Outline thickness. */
  outline: number;
}

/** The `common` block of a BMFont file. */
export interface BMFontCommon {
  /** Baseline distance. */
  lineHeight: number;
  /** Distance from the line top to the baseline. */
  base: number;
  /** Atlas width in texels. */
  scaleW: number;
  /** Atlas height in texels. */
  scaleH: number;
  /** Page count. */
  pages: number;
  /** `true` when the glyphs were packed into one channel. */
  packed: boolean;
  /** Channel bit fields. */
  alphaChnl: number;
  /** Channel bit field. */
  redChnl: number;
  /** Channel bit field. */
  greenChnl: number;
  /** Channel bit field. */
  blueChnl: number;
}

/** One atlas page of a BMFont file. */
export interface BMFontPage {
  /** Page index. */
  id: number;
  /** Image file name. */
  file: string;
}

/** One kerning pair. */
export interface BMFontKerning {
  /** Left codepoint. */
  first: number;
  /** Right codepoint. */
  second: number;
  /** Advance adjustment. */
  amount: number;
}

/** A parsed BMFont file. */
export interface BMFontData {
  /** Source URL or `'<inline>'`. */
  url: string;
  /** `'text'` or `'json'`. */
  format: 'text' | 'json';
  /** `info` block. */
  info: BMFontInfo;
  /** `common` block. */
  common: BMFontCommon;
  /** Glyphs, keyed by codepoint. */
  glyphs: Map<number, BMFontGlyph>;
  /** Glyphs in file order. */
  glyphList: BMFontGlyph[];
  /** Atlas pages. */
  pages: BMFontPage[];
  /** Kerning pairs, keyed by `"first,second"`. */
  kerning: Map<string, number>;
  /** Kerning pairs in file order. */
  kerningList: BMFontKerning[];
  /** The raw source. */
  source: string;
}

/** Options accepted by the BMFont-backed font. */
export interface BitmapFontOptions {
  /** Source URL, recorded for page resolution. */
  url?: string;
  /** Atlas page images, keyed by page index. */
  pages?: Map<number, unknown>;
  /** Scale applied to every metric; `1` uses the file's own pixel sizes. */
  scale?: number;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/** One draw command produced by the text renderer. */
export interface TextDrawCommand {
  /** Command kind; text goes through `'text'`. */
  kind: 'text';
  /** The source string. */
  text: string;
  /** Layout result the command renders. */
  layout: TextLayoutResult;
  /** Font the layout used, when one was supplied. */
  font?: unknown;
  /** TextStyle snapshot, when one was supplied. */
  style?: unknown;
  /** Atlas page this command draws from. */
  page: number;
  /** Colour as `[r, g, b, a]` in `[0, 1]`. */
  color: [number, number, number, number];
  /** Opacity multiplier. */
  opacity: number;
  /** Blend mode name. */
  blendMode: string;
  /** Interleaved `x, y, u, v` vertex data, six vertices per glyph. */
  vertices: Float32Array;
  /** Vertex count. */
  vertexCount: number;
  /** `true` when the command should be drawn with an SDF shader. */
  sdf: boolean;
  /** Render order. */
  order: number;
}

/** Construction options for the text renderer. */
export interface TextRendererOptions {
  /** Device-pixel ratio applied to the vertex data; defaults to `1`. */
  pixelRatio?: number;
  /** Y axis direction; `'up'` flips the vertex data. */
  axis?: 'up' | 'down';
  /** Colour applied when a style omits one. */
  color?: number | string | Color;
  /** Blend mode name written into the commands. */
  blendMode?: string;
  /** `true` writes SDF-ready commands. */
  sdf?: boolean;
}

/** Renderer statistics. */
export interface TextRendererStats {
  /** Commands produced. */
  commands: number;
  /** Glyphs written. */
  glyphs: number;
  /** Vertices written. */
  vertices: number;
  /** Bytes of vertex data written. */
  bytes: number;
}

/* -------------------------------------------------------------------------- */
/* Style                                                                      */
/* -------------------------------------------------------------------------- */

/** Text outline description. */
export interface TextStrokeOptions {
  /** Stroke colour. */
  color: number | string | Color;
  /** Stroke width in pixels; defaults to `1`. */
  width?: number;
  /** Line join style name; defaults to `'round'`. */
  join?: string;
  /** Miter limit, when `join` is `'miter'`. */
  miterLimit?: number;
}

/** Text shadow description. */
export interface TextShadowOptions {
  /** Shadow colour. */
  color: number | string | Color;
  /** Horizontal offset in pixels; defaults to `0`. */
  offsetX?: number;
  /** Vertical offset in pixels; defaults to `0`. */
  offsetY?: number;
  /** Blur radius in pixels; defaults to `0`. */
  blur?: number;
}

/** A partial style, accepted by `TextStyle.merge` and `TextStyle.from`. */
export interface TextStyleInit {
  /** Font family list, e.g. `'Inter, sans-serif'`. */
  fontFamily?: string;
  /** Size in pixels. */
  fontSize?: number;
  /** Weight. */
  fontWeight?: FontWeight;
  /** Style. */
  fontStyle?: FontStyle;
  /** Horizontal alignment. */
  align?: TextAlign;
  /** Vertical alignment. */
  baseline?: TextBaseline;
  /** Line height in pixels, or a multiple of the font size when `< 4`. */
  lineHeight?: number;
  /** Letter spacing in pixels. */
  letterSpacing?: number;
  /** Extra space per word in pixels. */
  wordSpacing?: number;
  /** Colour. */
  color?: number | string | Color;
  /** Opacity in `[0, 1]`. */
  opacity?: number;
  /** Outline. */
  stroke?: TextStrokeOptions | null;
  /** Shadow. */
  shadow?: TextShadowOptions | null;
  /** Maximum line width in pixels. */
  maxWidth?: number;
  /** Padding inside the text box, in pixels. */
  padding?: number;
  /** Word-break strategy. */
  wordBreak?: WordBreak;
  /** Writing direction. */
  direction?: TextDirection;
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The measurement contract layout depends on.
 *
 * A `GlyphAtlas`, a `BitmapFont`, a DOM-backed measurer and a fixed-width test double
 * all satisfy it, which is what lets `TextLayout` be tested exactly.
 */
export interface GlyphProvider {
  /** Returns the glyph for a codepoint, or `undefined` when the font lacks it. */
  getGlyph(codepoint: number): GlyphLike | undefined;
  /** Returns the kerning adjustment between two codepoints, or `undefined`. */
  getKerning?(left: number, right: number): number | undefined;
  /** Returns the advance of one codepoint, when it is cheaper than a full glyph. */
  getAdvance?(codepoint: number): number | undefined;
  /** Font size the metrics are expressed in. */
  readonly fontSize?: number;
  /** Line height recommendation. */
  readonly lineHeight?: number;
}

/** Structural view of a glyph, as the layout code reads it. */
export interface GlyphLike {
  /** Codepoint. */
  readonly codepoint: number;
  /** Pen advance. */
  readonly advance: number;
  /** Ink width. */
  readonly width: number;
  /** Ink height. */
  readonly height: number;
  /** Horizontal bearing. */
  readonly bearingX: number;
  /** Vertical bearing from the baseline. */
  readonly bearingY: number;
  /** Atlas page. */
  readonly page: number;
  /** Atlas rectangle. */
  readonly region: GlyphRegion;
  /** Texture coordinates. */
  getUV?(padding?: boolean): GlyphUV;
}

/** Structural view of a texture-producing font. */
export interface GlyphTextureSource {
  /** Returns the atlas texture, or `null` when nothing is packed yet. */
  getTexture(): TextureLike | null;
  /** Returns the atlas page size. */
  getAtlasSize(): { width: number; height: number };
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

/** A rectangle-shaped value accepted by the layout helpers. */
export type RectLike = Rect;

/** A point-shaped value accepted by the layout helpers. */
export type PointLike = Vec2;
