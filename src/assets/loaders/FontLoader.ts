/**
 * `FontLoader` — BMFont (text and JSON) parsing on the asset side.
 *
 * `src/text` owns the layout-side `BitmapFont` class; this loader owns the *asset*
 * side: fetching a `.fnt` file (or the JSON BMFont variant), parsing it into a
 * {@link LoadedFont} record, and resolving the glyph page images relative to the
 * font's own URL.
 *
 * ```ts
 * const font = await new FontLoader().loadAsync('fonts/arial-32.fnt');
 * font.info.face;         // 'Arial'
 * font.common.lineHeight; // 38
 * font.glyphs.get(65);    // the 'A' glyph
 * font.pages[0].file;     // 'arial-32_0.png'
 * ```
 *
 * ## Formats
 *
 * The **text** format is the one `bmfont`/`Hiero` emit:
 *
 * ```
 * info face="Arial" size=32
 * common lineHeight=38 base=30 scaleW=256 scaleH=256 pages=1
 * page id=0 file="arial-32_0.png"
 * chars count=2
 * char id=65 x=0 y=0 width=20 height=24 xoffset=0 yoffset=6 xadvance=22 page=0 chnl=15
 * kernings count=1
 * kerning first=65 second=86 amount=-2
 * ```
 *
 * The **JSON** variant stores the same fields as arrays. Both are handled, including
 * a `chars`/`kernings` object keyed by codepoint, which some exporters produce.
 *
 * @packageDocumentation
 */

import { getExtension } from '../../utils/StringUtils';
import { Loader, type LoadedSource } from './Loader';
import type { FetchLike, LoadOptions } from '../types';

/* -------------------------------------------------------------------------- */
/* Parsed model                                                               */
/* -------------------------------------------------------------------------- */

/** `info` block of a BMFont file. */
export interface FontInfo {
  /** Typeface name. */
  face: string;
  /** Nominal size in pixels. */
  size: number;
  /** `true` for a bold face. */
  bold: boolean;
  /** `true` for an italic face. */
  italic: boolean;
  /** Character set name. */
  charset: string;
  /** `true` when the glyphs are anti-aliased. */
  unicode: boolean;
  /** Padding around each glyph. */
  padding: [number, number, number, number];
  /** Spacing between glyphs. */
  spacing: [number, number];
  /** Outline thickness. */
  outline: number;
}

/** `common` block of a BMFont file. */
export interface FontCommon {
  /** Baseline distance from the top of a line. */
  lineHeight: number;
  /** Distance from the top of the line to the baseline. */
  base: number;
  /** Atlas page width in texels. */
  scaleW: number;
  /** Atlas page height in texels. */
  scaleH: number;
  /** Number of atlas pages. */
  pages: number;
  /** `true` when glyphs were packed into a single channel. */
  packed: boolean;
  /** Channel bit field. */
  alphaChnl: number;
  /** Channel bit field. */
  redChnl: number;
  /** Channel bit field. */
  greenChnl: number;
  /** Channel bit field. */
  blueChnl: number;
}

/** One glyph record. */
export interface FontGlyph {
  /** Codepoint. */
  id: number;
  /** Atlas rectangle, in texels. */
  x: number;
  /** Atlas rectangle, in texels. */
  y: number;
  /** Glyph cell width, in pixels. */
  width: number;
  /** Glyph cell height, in pixels. */
  height: number;
  /** Horizontal bearing from the pen position. */
  xoffset: number;
  /** Vertical bearing from the baseline. */
  yoffset: number;
  /** Pen advance after the glyph. */
  xadvance: number;
  /** Atlas page the glyph lives on. */
  page: number;
  /** Channel selector. */
  chnl: number;
}

/** One atlas page record. */
export interface FontPage {
  /** Page index. */
  id: number;
  /** Image file name, as written in the `.fnt`. */
  file: string;
}

/** One kerning pair. */
export interface FontKerning {
  /** Left-hand codepoint. */
  first: number;
  /** Right-hand codepoint. */
  second: number;
  /** Advance adjustment, in pixels. */
  amount: number;
}

/** A parsed BMFont file. */
export interface LoadedFont {
  /** Source URL or `'<inline>'`. */
  url: string;
  /** `'text'` or `'json'`, as detected. */
  format: 'text' | 'json';
  /** `info` block. */
  info: FontInfo;
  /** `common` block. */
  common: FontCommon;
  /** Glyphs, keyed by codepoint. */
  glyphs: Map<number, FontGlyph>;
  /** Glyph list, in file order. */
  glyphList: FontGlyph[];
  /** Atlas pages, in page order. */
  pages: FontPage[];
  /** Kerning pairs, keyed by `${first},${second}`. */
  kernings: Map<string, number>;
  /** Kerning list, in file order. */
  kerningList: FontKerning[];
  /** Raw source text, for callers that want to re-parse it themselves. */
  source: string;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/** Parses the `key=value` pairs of one BMFont line. */
function parseAttributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  // `key=value` where the value is a quoted string, a bare token, or a
  // comma-separated list inside quotes.
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("([^"]*)"|[^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    out[match[1]] = match[3] !== undefined ? match[3] : match[2];
  }
  return out;
}

/** Reads a numeric attribute with a default. */
function numberAttr(attributes: Record<string, string>, key: string, fallback = 0): number {
  const raw = attributes[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Reads a boolean attribute written as `0`/`1`. */
function boolAttr(attributes: Record<string, string>, key: string, fallback = false): boolean {
  const raw = attributes[key];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/** Splits a comma-separated numeric list. */
function numberList(raw: string | undefined, length: number, fallback: number): number[] {
  const out: number[] = [];
  const parts = (raw ?? '').split(',');
  for (let i = 0; i < length; i++) {
    const value = Number(parts[i]);
    out.push(Number.isFinite(value) ? value : fallback);
  }
  return out;
}

/**
 * Parses a BMFont **text** file.
 *
 * @param source File contents.
 * @param url Source URL, recorded on the result.
 * @returns The parsed font.
 * @throws Error When the source has no `common` block, which means it is not a
 *   BMFont file at all.
 */
export function parseBMFontText(source: string, url = '<inline>'): LoadedFont {
  // Strip a UTF-8 BOM and normalise line endings so `\r` never ends up in a value.
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  const info: FontInfo = {
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
  const common: FontCommon = {
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

  const glyphs = new Map<number, FontGlyph>();
  const glyphList: FontGlyph[] = [];
  const pages: FontPage[] = [];
  const kernings = new Map<string, number>();
  const kerningList: FontKerning[] = [];

  let sawCommon = false;
  let declaredChars = 0;
  let declaredKernings = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith(';') || line.startsWith('//') || line.startsWith('#')) continue;

    const space = line.indexOf(' ');
    const keyword = space < 0 ? line : line.slice(0, space);
    const attributes = parseAttributes(line.slice(space + 1));

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
      case 'chars': {
        declaredChars = numberAttr(attributes, 'count');
        break;
      }
      case 'char': {
        const glyph: FontGlyph = {
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
      case 'kernings': {
        declaredKernings = numberAttr(attributes, 'count');
        break;
      }
      case 'kerning': {
        const kerning: FontKerning = {
          first: numberAttr(attributes, 'first'),
          second: numberAttr(attributes, 'second'),
          amount: numberAttr(attributes, 'amount'),
        };
        kernings.set(`${kerning.first},${kerning.second}`, kerning.amount);
        kerningList.push(kerning);
        break;
      }
      default:
        // Unknown keywords are ignored, matching every other BMFont reader: the
        // format has grown fields over time and rejecting them helps nobody.
        break;
    }
  }

  void declaredChars;
  void declaredKernings;

  if (!sawCommon) {
    throw new Error(
      `FontLoader("${url}"): the source has no "common" line, so it is not a BMFont ` +
        'text file. Expected a line such as `common lineHeight=38 base=30 scaleW=256 ' +
        'scaleH=256 pages=1`.',
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
    kernings,
    kerningList,
    source: text,
  };
}

/** Shape of the JSON BMFont variant. */
interface BMFontJSON {
  info?: Record<string, unknown>;
  common?: Record<string, unknown>;
  pages?: (string | { id?: number; file?: string })[];
  chars?: Record<string, unknown>[] | Record<string, Record<string, unknown>>;
  kernings?: Record<string, unknown>[] | Record<string, Record<string, unknown>>;
}

/** Normalises a `chars`/`kernings` collection that may be an array or an object. */
function toRecordArray(
  value: Record<string, unknown>[] | Record<string, Record<string, unknown>> | undefined,
): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return Object.values(value);
}

/** Reads a numeric field from a loose JSON record. */
function readNumber(record: Record<string, unknown>, key: string, fallback = 0): number {
  const raw = record[key];
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

/** Reads a boolean field from a loose JSON record. */
function readBoolean(record: Record<string, unknown>, key: string, fallback = false): boolean {
  const raw = record[key];
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') return raw === '1' || raw.toLowerCase() === 'true';
  return fallback;
}

/** Reads a string field from a loose JSON record. */
function readString(record: Record<string, unknown>, key: string, fallback = ''): string {
  const raw = record[key];
  return typeof raw === 'string' ? raw : fallback;
}

/**
 * Parses a BMFont **JSON** file.
 *
 * @param source JSON text or an already-parsed object.
 * @param url Source URL, recorded on the result.
 * @returns The parsed font.
 * @throws Error When the payload has no `common` object.
 */
export function parseBMFontJSON(source: string | BMFontJSON, url = '<inline>'): LoadedFont {
  let data: BMFontJSON;
  if (typeof source === 'string') {
    try {
      data = JSON.parse(source) as BMFontJSON;
    } catch (error) {
      throw new Error(
        `FontLoader("${url}"): the source is neither a BMFont text file nor valid ` +
          `BMFont JSON (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  } else {
    data = source;
  }

  const infoRecord = data.info ?? {};
  const commonRecord = data.common;

  if (commonRecord === undefined) {
    throw new Error(
      `FontLoader("${url}"): the JSON payload has no "common" object, so it is not a ` +
        'BMFont JSON file.',
    );
  }

  const paddingRaw = infoRecord.padding;
  const spacingRaw = infoRecord.spacing;
  const padding =
    typeof paddingRaw === 'string'
      ? numberList(paddingRaw, 4, 0)
      : Array.isArray(paddingRaw)
        ? numberList(paddingRaw.join(','), 4, 0)
        : [0, 0, 0, 0];
  const spacing =
    typeof spacingRaw === 'string'
      ? numberList(spacingRaw, 2, 0)
      : Array.isArray(spacingRaw)
        ? numberList(spacingRaw.join(','), 2, 0)
        : [0, 0];

  const info: FontInfo = {
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

  const common: FontCommon = {
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

  const pages: FontPage[] = (data.pages ?? []).map((entry, index) => {
    if (typeof entry === 'string') return { id: index, file: entry };
    return { id: readNumber(entry, 'id', index), file: readString(entry, 'file') };
  });

  const glyphs = new Map<number, FontGlyph>();
  const glyphList: FontGlyph[] = [];
  for (const record of toRecordArray(data.chars)) {
    const glyph: FontGlyph = {
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

  const kernings = new Map<string, number>();
  const kerningList: FontKerning[] = [];
  for (const record of toRecordArray(data.kernings)) {
    const kerning: FontKerning = {
      first: readNumber(record, 'first'),
      second: readNumber(record, 'second'),
      amount: readNumber(record, 'amount'),
    };
    kernings.set(`${kerning.first},${kerning.second}`, kerning.amount);
    kerningList.push(kerning);
  }

  return {
    url,
    format: 'json',
    info,
    common,
    glyphs,
    glyphList,
    pages,
    kernings,
    kerningList,
    source: typeof source === 'string' ? source : JSON.stringify(source),
  };
}

/**
 * Parses either BMFont dialect, detecting the format from the content.
 *
 * @param source File contents.
 * @param url Source URL, recorded on the result.
 * @returns The parsed font.
 */
export function parseBMFont(source: string, url = '<inline>'): LoadedFont {
  const trimmed = source.trimStart();
  if (trimmed.startsWith('{')) return parseBMFontJSON(trimmed, url);
  return parseBMFontText(source, url);
}

/* -------------------------------------------------------------------------- */
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

/** Options accepted by {@link FontLoader.loadAsync}. */
export interface FontLoadOptions extends LoadOptions {
  /** Force a dialect instead of detecting it. */
  format?: 'text' | 'json' | 'auto';
  /** `fetch` implementation override. */
  fetcher?: FetchLike;
}

/**
 * Loads BMFont files.
 */
export class FontLoader extends Loader<LoadedFont, string> {
  /** `fetch` implementation in use. */
  public fetcher: FetchLike | null = null;

  /** Dialect applied when the caller does not specify one. */
  public format: 'text' | 'json' | 'auto' = 'auto';

  /** Number of fonts parsed. */
  public parsedCount = 0;

  /**
   * Creates a font loader.
   *
   * @param options Dialect and transport overrides.
   */
  constructor(options: FontLoadOptions = {}) {
    super();
    this.fetcher = options.fetcher ?? null;
    this.format = options.format ?? 'auto';
  }

  /**
   * Sets the dialect.
   *
   * @param format Dialect, or `'auto'`.
   * @returns This loader, for chaining.
   */
  public setFormat(format: 'text' | 'json' | 'auto'): this {
    this.format = format;
    return this;
  }

  /**
   * Installs a `fetch` implementation.
   *
   * @param fetcher Fetcher, or `null` for the global one.
   * @returns This loader, for chaining.
   */
  public setFetcher(fetcher: FetchLike | null): this {
    this.fetcher = fetcher;
    return this;
  }

  /**
   * @inheritdoc
   */
  protected override async loadData(url: string, options: LoadOptions): Promise<LoadedSource<string>> {
    const fontOptions = options as FontLoadOptions;
    const fetcher = this.resolveFetcher(fontOptions);
    if (fetcher === null) {
      throw new Error(
        `FontLoader("${url}"): no \`fetch\` implementation is available. Parse an inline ` +
          'string with `parse()` instead when running on a host without fetch.',
      );
    }

    const response = await fetcher(url, {
      method: 'GET',
      headers: { ...this.requestHeaders },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (response.ok === false) {
      throw new Error(`FontLoader("${url}"): HTTP ${response.status ?? '?'} ${response.statusText ?? ''}`.trim());
    }

    const text = await response.text();
    this.reportProgress(url, text.length, text.length, options);
    return { data: text, fromCache: false, byteLength: text.length };
  }

  /**
   * @inheritdoc
   *
   * Detects the dialect from the content unless the loader was pinned to one.
   */
  public override parse(source: string, url = '<inline>', options?: LoadOptions): LoadedFont {
    const fontOptions = (options ?? {}) as FontLoadOptions;
    const format = fontOptions.format ?? this.format;
    const extension = getExtension(url);

    let font: LoadedFont;
    if (format === 'json' || (format === 'auto' && extension === 'json')) {
      font = parseBMFontJSON(source, url);
    } else if (format === 'text' || (format === 'auto' && extension === 'fnt')) {
      font = source.trimStart().startsWith('{') ? parseBMFontJSON(source, url) : parseBMFontText(source, url);
    } else {
      font = parseBMFont(source, url);
    }

    this.parsedCount++;
    return font;
  }

  /**
   * Resolves a glyph page's image URL against the font's own URL.
   *
   * @param font Parsed font.
   * @param page Page index.
   * @returns The resolved URL, or `null` when the page is missing.
   */
  public resolvePageUrl(font: LoadedFont, page: number): string | null {
    const entry = font.pages.find((candidate) => candidate.id === page) ?? font.pages[page];
    if (entry === undefined || entry.file.length === 0) return null;

    const base = font.url.includes('/') ? font.url.slice(0, font.url.lastIndexOf('/') + 1) : '';
    if (entry.file.startsWith('http') || entry.file.startsWith('data:') || entry.file.startsWith('/')) {
      return entry.file;
    }
    return `${base}${entry.file}`;
  }

  /** Resolves the `fetch` implementation to use. */
  private resolveFetcher(options: FontLoadOptions): FetchLike | null {
    if (options.fetcher !== undefined) return options.fetcher;
    if (this.fetcher !== null) return this.fetcher;
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    return typeof globalFetch === 'function' ? (globalFetch as FetchLike) : null;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    super.onDispose();
    this.fetcher = null;
  }
}

/**
 * Convenience factory mirroring `new FontLoader(options)`.
 *
 * @param options Dialect and transport overrides.
 * @returns A new font loader.
 */
export function fontLoader(options: FontLoadOptions = {}): FontLoader {
  return new FontLoader(options);
}
