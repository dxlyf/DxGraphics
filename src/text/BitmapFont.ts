/**
 * `BitmapFont` — a `Font` backed by a BMFont file.
 *
 * BMFont (`bmfont`, Hiero, Glyph Designer) is the format practically every 2D engine
 * speaks, in two dialects:
 *
 * ```
 * # text                                 | // JSON
 * info face="Arial" size=32              | { "info": { "face": "Arial", "size": 32 },
 * common lineHeight=38 base=30           |   "common": { "lineHeight": 38, "base": 30 },
 *   scaleW=256 scaleH=256 pages=1        |   "pages": ["arial-32_0.png"],
 * page id=0 file="arial-32_0.png"        |   "chars": [ { "id": 65, "x": 0, ... } ],
 * chars count=2                          |   "kernings": [ { "first": 65, ... } ] }
 * char id=65 x=0 y=0 width=20 ...        |
 * kerning first=65 second=86 amount=-2   |
 * ```
 *
 * Both are parsed here, including the traps:
 *
 * - `chars`/`kernings` may be an **array** or an **object keyed by codepoint**, depending
 *   on the exporter;
 * - quoted values may contain `=`, spaces and escaped quotes;
 * - comments appear as `;`, `//` and `#`;
 * - `padding`/`spacing` are comma-separated lists;
 * - a UTF-8 BOM is common;
 * - `\r\n` is common.
 *
 * ## Metrics mapping
 *
 * BMFont's `common.base` is the distance from the top of a line to the baseline, and
 * `common.lineHeight` is the full line box. Those map onto `Font.ascent`/`descent`/
 * `lineGap` as:
 *
 * ```
 * ascent  = base
 * descent = lineHeight - base
 * lineGap = 0
 * ```
 *
 * `unitsPerEm` is set to `lineHeight` so that `getScaleForSize(size)` reproduces the
 * file's proportions when a caller renders at a different size.
 *
 * ```ts
 * const font = BitmapFont.parseText(fntText);
 * font.getGlyph('A').advance;   // xadvance from the file
 * font.getKerning(65, 86);      // -2
 * ```
 *
 * @packageDocumentation
 */

import { GLYPH_PADDING } from '../constants';
import { createLogger } from '../utils/Logger';
import { Font } from './Font';
import { Glyph } from './Glyph';
import { GlyphAtlas } from './GlyphAtlas';
import type {
  BMFontCommon,
  BMFontData,
  BMFontGlyph,
  BMFontInfo,
  BMFontKerning,
  BMFontPage,
  BitmapFontOptions,
  TextureLike,
} from './types';

/** Logger shared by the BMFont path. */
const log = createLogger('text:bmfont');

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/** Parses the `key=value` pairs of one BMFont line. */
function parseAttributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*("([^"]*)"|'([^']*)'|[^\s,]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const quoted = match[3] ?? match[4];
    out[match[1]] = quoted !== undefined ? quoted : match[2];
  }
  return out;
}

/** Reads a numeric attribute. */
function numberAttr(attributes: Record<string, string>, key: string, fallback = 0): number {
  const raw = attributes[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Reads a `0`/`1`/`true`/`false` attribute. */
function boolAttr(attributes: Record<string, string>, key: string, fallback = false): boolean {
  const raw = attributes[key];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/** Splits a comma-separated numeric list. */
function numberList(raw: string | undefined, length: number, fallback: number): number[] {
  const parts = (raw ?? '').split(',');
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    const value = Number(parts[i]);
    out.push(Number.isFinite(value) ? value : fallback);
  }
  return out;
}

/**
 * Parses the BMFont **text** dialect.
 *
 * @param source File contents.
 * @param url Source URL, recorded on the result.
 * @returns The parsed font data.
 * @throws Error When the source has no `common` line.
 */
export function parseBMFontText(source: string, url = '<inline>'): BMFontData {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  const info: BMFontInfo = {
    face: '',
    size: 0,
    bold: false,
    italic: false,
    charset: '',
    unicode: false,
    padding: [0, 0, 0, 0],
    spacing: [0, 0],
    outline: 0,
  };
  const common: BMFontCommon = {
    lineHeight: 0,
    base: 0,
    scaleW: 0,
    scaleH: 0,
    pages: 1,
    packed: false,
    alphaChnl: 0,
    redChnl: 0,
    greenChnl: 0,
    blueChnl: 0,
  };

  const glyphs = new Map<number, BMFontGlyph>();
  const glyphList: BMFontGlyph[] = [];
  const pages: BMFontPage[] = [];
  const kerning = new Map<string, number>();
  const kerningList: BMFontKerning[] = [];

  let sawCommon = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith(';') || line.startsWith('//') || line.startsWith('#')) continue;

    const space = line.indexOf(' ');
    const keyword = space < 0 ? line : line.slice(0, space);
    const attributes = parseAttributes(space < 0 ? '' : line.slice(space + 1));

    switch (keyword) {
      case 'info': {
        info.face = attributes.face ?? '';
        info.size = numberAttr(attributes, 'size');
        info.bold = boolAttr(attributes, 'bold');
        info.italic = boolAttr(attributes, 'italic');
        info.charset = attributes.charset ?? '';
        info.unicode = boolAttr(attributes, 'unicode', true);
        if (attributes.padding !== undefined) {
          const padding = numberList(attributes.padding, 4, 0);
          info.padding = [padding[0], padding[1], padding[2], padding[3]];
        }
        if (attributes.spacing !== undefined) {
          const spacing = numberList(attributes.spacing, 2, 0);
          info.spacing = [spacing[0], spacing[1]];
        }
        info.outline = numberAttr(attributes, 'outline');
        break;
      }
      case 'common': {
        sawCommon = true;
        common.lineHeight = numberAttr(attributes, 'lineHeight');
        common.base = numberAttr(attributes, 'base');
        common.scaleW = numberAttr(attributes, 'scaleW');
        common.scaleH = numberAttr(attributes, 'scaleH');
        common.pages = Math.max(1, numberAttr(attributes, 'pages', 1));
        common.packed = boolAttr(attributes, 'packed');
        common.alphaChnl = numberAttr(attributes, 'alphaChnl');
        common.redChnl = numberAttr(attributes, 'redChnl');
        common.greenChnl = numberAttr(attributes, 'greenChnl');
        common.blueChnl = numberAttr(attributes, 'blueChnl');
        break;
      }
      case 'page': {
        pages.push({ id: numberAttr(attributes, 'id'), file: attributes.file ?? '' });
        break;
      }
      case 'char':
      case 'chars': {
        if (keyword === 'chars') break;
        const glyph: BMFontGlyph = {
          id: numberAttr(attributes, 'id'),
          x: numberAttr(attributes, 'x'),
          y: numberAttr(attributes, 'y'),
          width: numberAttr(attributes, 'width'),
          height: numberAttr(attributes, 'height'),
          xoffset: numberAttr(attributes, 'xoffset'),
          yoffset: numberAttr(attributes, 'yoffset'),
          xadvance: numberAttr(attributes, 'xadvance'),
          page: numberAttr(attributes, 'page'),
          chnl: numberAttr(attributes, 'chnl', 15),
        };
        glyphs.set(glyph.id, glyph);
        glyphList.push(glyph);
        break;
      }
      case 'kerning': {
        const pair: BMFontKerning = {
          first: numberAttr(attributes, 'first'),
          second: numberAttr(attributes, 'second'),
          amount: numberAttr(attributes, 'amount'),
        };
        kerning.set(`${pair.first},${pair.second}`, pair.amount);
        kerningList.push(pair);
        break;
      }
      case 'kernings':
      default:
        // `kernings count=N` carries no data, and unknown keywords are ignored: the format
        // has grown fields over time and rejecting them helps nobody.
        break;
    }
  }

  if (!sawCommon) {
    throw new Error(
      `BitmapFont("${url}"): the source has no "common" line, so it is not a BMFont text ` +
        'file. Expected `common lineHeight=38 base=30 scaleW=256 scaleH=256 pages=1`.',
    );
  }

  return {
    url,
    format: 'text',
    info,
    common,
    glyphs,
    glyphList,
    pages,
    kerning,
    kerningList,
    source: text,
  };
}

/** The loose JSON shape a BMFont JSON exporter produces. */
export interface BMFontJSON {
  /** `info` object. */
  info?: Record<string, unknown>;
  /** `common` object. */
  common?: Record<string, unknown>;
  /** Page list; strings or objects. */
  pages?: (string | { id?: number; file?: string })[];
  /** Glyphs; an array, or an object keyed by codepoint. */
  chars?: Record<string, unknown>[] | Record<string, Record<string, unknown>>;
  /** Kerning pairs; an array, or an object keyed by `"first,second"`. */
  kernings?: Record<string, unknown>[] | Record<string, Record<string, unknown>>;
}

/** Normalises an array-or-object collection into an array. */
function toRecordArray(
  value: Record<string, unknown>[] | Record<string, Record<string, unknown>> | undefined,
): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return Object.values(value);
}

/** Reads a numeric field from a loose record. */
function readNumber(record: Record<string, unknown>, key: string, fallback = 0): number {
  const raw = record[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

/** Reads a boolean field from a loose record. */
function readBoolean(record: Record<string, unknown>, key: string, fallback = false): boolean {
  const raw = record[key];
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') return raw === '1' || raw.toLowerCase() === 'true';
  return fallback;
}

/** Reads a string field from a loose record. */
function readString(record: Record<string, unknown>, key: string, fallback = ''): string {
  const raw = record[key];
  return typeof raw === 'string' ? raw : fallback;
}

/**
 * Parses the BMFont **JSON** dialect.
 *
 * @param source JSON text or an already-parsed document.
 * @param url Source URL, recorded on the result.
 * @returns The parsed font data.
 * @throws Error When the payload has no `common` object.
 */
export function parseBMFontJSON(source: string | BMFontJSON, url = '<inline>'): BMFontData {
  let data: BMFontJSON;

  if (typeof source === 'string') {
    try {
      data = JSON.parse(source) as BMFontJSON;
    } catch (error) {
      throw new Error(
        `BitmapFont("${url}"): the source is neither BMFont text nor valid BMFont JSON ` +
          `(${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  } else {
    data = source;
  }

  const commonRecord = data.common;
  if (commonRecord === undefined) {
    throw new Error(
      `BitmapFont("${url}"): the JSON payload has no "common" object, so it is not a ` +
        'BMFont JSON file.',
    );
  }

  const infoRecord = data.info ?? {};

  const paddingRaw = infoRecord.padding;
  const spacingRaw = infoRecord.spacing;
  const padding =
    typeof paddingRaw === 'string'
      ? numberList(paddingRaw, 4, 0)
      : Array.isArray(paddingRaw)
        ? numberList(paddingRaw.map(String).join(','), 4, 0)
        : [0, 0, 0, 0];
  const spacing =
    typeof spacingRaw === 'string'
      ? numberList(spacingRaw, 2, 0)
      : Array.isArray(spacingRaw)
        ? numberList(spacingRaw.map(String).join(','), 2, 0)
        : [0, 0];

  const info: BMFontInfo = {
    face: readString(infoRecord, 'face'),
    size: readNumber(infoRecord, 'size'),
    bold: readBoolean(infoRecord, 'bold'),
    italic: readBoolean(infoRecord, 'italic'),
    charset: readString(infoRecord, 'charset'),
    unicode: readBoolean(infoRecord, 'unicode', true),
    padding: [padding[0], padding[1], padding[2], padding[3]],
    spacing: [spacing[0], spacing[1]],
    outline: readNumber(infoRecord, 'outline'),
  };

  const common: BMFontCommon = {
    lineHeight: readNumber(commonRecord, 'lineHeight'),
    base: readNumber(commonRecord, 'base'),
    scaleW: readNumber(commonRecord, 'scaleW'),
    scaleH: readNumber(commonRecord, 'scaleH'),
    pages: Math.max(1, readNumber(commonRecord, 'pages', 1)),
    packed: readBoolean(commonRecord, 'packed'),
    alphaChnl: readNumber(commonRecord, 'alphaChnl'),
    redChnl: readNumber(commonRecord, 'redChnl'),
    greenChnl: readNumber(commonRecord, 'greenChnl'),
    blueChnl: readNumber(commonRecord, 'blueChnl'),
  };

  const pages: BMFontPage[] = (data.pages ?? []).map((entry, index) => {
    if (typeof entry === 'string') return { id: index, file: entry };
    return { id: readNumber(entry, 'id', index), file: readString(entry, 'file') };
  });

  const glyphs = new Map<number, BMFontGlyph>();
  const glyphList: BMFontGlyph[] = [];
  for (const record of toRecordArray(data.chars)) {
    const glyph: BMFontGlyph = {
      id: readNumber(record, 'id'),
      x: readNumber(record, 'x'),
      y: readNumber(record, 'y'),
      width: readNumber(record, 'width'),
      height: readNumber(record, 'height'),
      xoffset: readNumber(record, 'xoffset'),
      yoffset: readNumber(record, 'yoffset'),
      xadvance: readNumber(record, 'xadvance'),
      page: readNumber(record, 'page'),
      chnl: readNumber(record, 'chnl', 15),
    };
    glyphs.set(glyph.id, glyph);
    glyphList.push(glyph);
  }

  const kerning = new Map<string, number>();
  const kerningList: BMFontKerning[] = [];
  for (const record of toRecordArray(data.kernings)) {
    const pair: BMFontKerning = {
      first: readNumber(record, 'first'),
      second: readNumber(record, 'second'),
      amount: readNumber(record, 'amount'),
    };
    kerning.set(`${pair.first},${pair.second}`, pair.amount);
    kerningList.push(pair);
  }

  return {
    url,
    format: 'json',
    info,
    common,
    glyphs,
    glyphList,
    pages,
    kerning,
    kerningList,
    source: typeof source === 'string' ? source : JSON.stringify(source),
  };
}

/**
 * Parses either BMFont dialect, detecting it from the content.
 *
 * @param source File contents.
 * @param url Source URL, recorded on the result.
 * @returns The parsed font data.
 */
export function parseBMFont(source: string, url = '<inline>'): BMFontData {
  return source.trimStart().startsWith('{') ? parseBMFontJSON(source, url) : parseBMFontText(source, url);
}

/* -------------------------------------------------------------------------- */
/* BitmapFont                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A `Font` built from a BMFont file.
 */
export class BitmapFont extends Font {
  /** The parsed source data. */
  public readonly data: BMFontData;

  /** Atlas page images, keyed by page index. */
  public readonly pageImages = new Map<number, unknown>();

  /** Nominal face size from the `info` block. */
  public readonly faceSize: number;

  /**
   * Creates a bitmap font from parsed data.
   *
   * @param data Parsed BMFont data.
   * @param options Page images and a scale override.
   */
  constructor(data: BMFontData, options: BitmapFontOptions = {}) {
    const lineHeight = data.common.lineHeight > 0 ? data.common.lineHeight : data.info.size || 16;
    const base = data.common.base > 0 ? data.common.base : lineHeight * 0.8;

    super({
      family: data.info.face.length > 0 ? data.info.face : 'bitmap',
      size: data.info.size > 0 ? data.info.size : lineHeight,
      unitsPerEm: lineHeight,
      ascent: base,
      descent: Math.max(0, lineHeight - base),
      lineGap: 0,
      atlas: new GlyphAtlas({
        width: Math.max(1, data.common.scaleW || 256),
        height: Math.max(1, data.common.scaleH || 256),
        padding: paddingOf(data),
        // A BMFont atlas is a finished layout: growing it would invalidate every UV.
        grow: false,
      }),
    });

    this.data = data;
    this.faceSize = data.info.size;

    if (options.pages !== undefined) {
      for (const [page, image] of options.pages) this.pageImages.set(page, image);
    }

    this.buildGlyphs(options.scale ?? 1);
  }

  /** Materialises glyph records from the parsed char table. */
  private buildGlyphs(scale: number): void {
    const padding = paddingOf(this.data);

    for (const record of this.data.glyphList) {
      const isWhitespace = record.width <= 0 || record.height <= 0;

      if (isWhitespace) {
        this.addWhitespace(record.id, record.xadvance * scale);
        continue;
      }

      const glyph = new Glyph({
        codepoint: record.id,
        advance: record.xadvance * scale,
        width: record.width * scale,
        height: record.height * scale,
        // BMFont's `xoffset` is the left bearing and its `yoffset` is measured **down**
        // from the top of the cell; `Glyph.bearingY` is measured up from the baseline.
        bearingX: record.xoffset * scale,
        bearingY: (record.height + record.yoffset) * scale,
        padding,
        page: record.page,
        hasBitmap: true,
        region: {
          x: record.x,
          y: record.y,
          width: record.width + padding * 2,
          height: record.height + padding * 2,
          page: record.page,
        },
      });

      // The atlas is authoritative about the region: it re-packs nothing here, but going
      // through `addGlyph` keeps the region and the glyph table consistent.
      this.addGlyph(glyph);
    }

    for (const pair of this.data.kerningList) {
      this.addKerning(pair.first, pair.second, pair.amount * scale);
    }

    log.debug(
      `built BitmapFont "${this.family}" with ${this.glyphCount} glyphs, ` +
        `${this.data.kerningList.length} kerning pairs`,
    );
  }

  /* ---------------------------------------------------------------- factories */

  /**
   * Parses a BMFont **text** file.
   *
   * @param source File contents.
   * @param options Page images and a scale override.
   * @param url Source URL.
   * @returns A bitmap font.
   */
  public static parseText(source: string, options: BitmapFontOptions = {}, url = '<inline>'): BitmapFont {
    return new BitmapFont(parseBMFontText(source, url), options);
  }

  /**
   * Parses a BMFont **JSON** file.
   *
   * @param source JSON text or document.
   * @param options Page images and a scale override.
   * @param url Source URL.
   * @returns A bitmap font.
   */
  public static parseJSON(
    source: string | BMFontJSON,
    options: BitmapFontOptions = {},
    url = '<inline>',
  ): BitmapFont {
    return new BitmapFont(parseBMFontJSON(source, url), options);
  }

  /**
   * Parses either dialect.
   *
   * @param source File contents.
   * @param options Page images and a scale override.
   * @param url Source URL.
   * @returns A bitmap font.
   */
  public static parse(source: string, options: BitmapFontOptions = {}, url = '<inline>'): BitmapFont {
    return new BitmapFont(parseBMFont(source, url), options);
  }

  /**
   * Wraps already-parsed data in a font.
   *
   * @param data Parsed BMFont data.
   * @param options Page images and a scale override.
   * @returns A bitmap font.
   */
  public static from(data: BMFontData, options: BitmapFontOptions = {}): BitmapFont {
    return new BitmapFont(data, options);
  }

  /* ------------------------------------------------------------------ pages */

  /**
   * Number of atlas pages the file declares.
   *
   * @returns The page count.
   */
  public get pageCount(): number {
    return Math.max(1, this.data.common.pages, this.data.pages.length);
  }

  /**
   * A page's image file name.
   *
   * @param page Page index.
   * @returns The file name, or `null`.
   */
  public getPageFile(page = 0): string | null {
    const entry = this.data.pages.find((candidate) => candidate.id === page) ?? this.data.pages[page];
    return entry?.file ?? null;
  }

  /**
   * Attaches an image to a page.
   *
   * @param page Page index.
   * @param image Page image.
   * @returns This font, for chaining.
   */
  public setPageImage(page: number, image: unknown): this {
    this.pageImages.set(page, image);
    if (page === 0) this.atlas.setImage(image);
    return this;
  }

  /**
   * The atlas texture, with the page-0 image attached.
   *
   * @returns The texture, or `null`.
   */
  public override getTexture(): TextureLike | null {
    const texture = this.atlas.getTexture();
    if (texture === null) return null;
    const image = this.pageImages.get(0);
    if (image !== undefined && texture.image == null) {
      texture.image = image;
      texture.source = image;
    }
    return texture;
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `BitmapFont("${this.family}", ${this.faceSize}px, glyphs=${this.glyphCount}, ` +
      `pages=${this.pageCount})`
    );
  }
}

/** Reads the padding recorded in a BMFont `info` block. */
function paddingOf(data: BMFontData): number {
  const padding = data.info.padding;
  const max = Math.max(padding[0] ?? 0, padding[1] ?? 0, padding[2] ?? 0, padding[3] ?? 0);
  // Fall back to the library default rather than zero: an unpacked BMFont with no declared
  // padding still needs the bleed guard the default provides.
  return max > 0 ? max : GLYPH_PADDING;
}

/**
 * Convenience factory mirroring `BitmapFont.parse(source, options)`.
 *
 * @param source BMFont file contents.
 * @param options Page images and a scale override.
 * @returns A bitmap font.
 */
export function bitmapFont(source: string, options: BitmapFontOptions = {}): BitmapFont {
  return BitmapFont.parse(source, options);
}
