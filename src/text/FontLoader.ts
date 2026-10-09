/**
 * `FontLoader` (text) — fetching and parsing fonts on the text side.
 *
 * `src/assets/loaders/FontLoader` owns the *asset pipeline*: retries, backoff, progress,
 * cancellation. This loader owns the *text* side: deciding from a URL and a payload which
 * dialect it is, producing a ready-to-use {@link BitmapFont} or `Font`, and resolving the
 * page images relative to the font's own URL so a caller does not have to.
 *
 * ```ts
 * const loader = new FontLoader();
 * const font = await loader.loadFont('fonts/arial-32.fnt');
 * font.getGlyph('A').advance;      // usable immediately
 * loader.resolvePageUrl('fonts/arial-32.fnt', 0);   // 'fonts/arial-32_0.png'
 * ```
 *
 * ## Inline first
 *
 * `parse()` and `loadFromString()` need no host at all, which is what makes the whole text
 * stack testable and what lets a build step bake fonts into a bundle.
 *
 * @packageDocumentation
 */

import { Disposable } from '../core/Disposable';
import { EventEmitter } from '../core/EventEmitter';
import { extname } from '../utils/PathUtils';
import { createLogger } from '../utils/Logger';
import { BitmapFont, parseBMFont, parseBMFontJSON, parseBMFontText } from './BitmapFont';
import { createFallbackFont, Font } from './Font';
import type { BMFontData } from './types';

/** Logger shared by the text font loader. */
const log = createLogger('text:fontloader');

/** The subset of `fetch` this loader uses. */
export interface FontFetchResponseLike {
  /** `true` for a 2xx status. */
  readonly ok?: boolean;
  /** HTTP status. */
  readonly status?: number;
  /** Status text. */
  readonly statusText?: string;
  /** Reads the body as text. */
  text(): Promise<string>;
  /** Reads the body as bytes. */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The subset of `fetch` this loader uses. */
export type FontFetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FontFetchResponseLike>;

/** Events emitted by the text font loader. */
export interface TextFontLoaderEvents {
  /** A font finished loading. */
  load: [url: string, font: Font];
  /** A load failed. */
  error: [url: string, error: Error];
  /** Byte or character progress. */
  progress: [url: string, loaded: number, total: number];
  /** The loader was disposed. */
  dispose: [];
  /** A resource was disposed. */
  disposed: [];
}

/** Options accepted by {@link FontLoader.loadFont}. */
export interface FontLoadOptions {
  /** Force a dialect instead of detecting it. */
  format?: 'text' | 'json' | 'auto';
  /** Aborts the request. */
  signal?: AbortSignal;
  /** Progress callback. */
  onProgress?: (loaded: number, total: number) => void;
  /** `fetch` implementation override. */
  fetcher?: FontFetchLike;
  /** Page images, keyed by page index. */
  pages?: Map<number, unknown>;
  /** Scale applied to every metric. */
  scale?: number;
}

/** Options accepted by {@link FontLoader.loadFromString}. */
export interface FontParseOptions {
  /** Dialect of the payload. */
  format?: 'text' | 'json' | 'auto';
  /** Source URL, used for page resolution. */
  url?: string;
  /** Page images, keyed by page index. */
  pages?: Map<number, unknown>;
  /** Scale applied to every metric. */
  scale?: number;
}

/**
 * Loads and parses BMFont files into {@link Font} instances.
 */
export class FontLoader extends Disposable<'FontLoader'> {
  /** @inheritdoc */
  public override readonly label = 'FontLoader' as const;

  /** Base path prefixed to relative URLs. */
  public path = '';

  /** `fetch` implementation in use. */
  public fetcher: FontFetchLike | null = null;

  /** Dialect used when the caller does not specify one. */
  public format: 'text' | 'json' | 'auto' = 'auto';

  /** Lifecycle events. */
  public override readonly events = new EventEmitter<TextFontLoaderEvents>() as unknown as EventEmitter<
    TextFontLoaderEvents
  > &
    EventEmitter<{ dispose: []; disposed: [] }>;
  /** Number of fonts produced. */
  public loadedCount = 0;

  /**
   * Creates a font loader.
   *
   * @param options Transport and dialect overrides.
   */
  constructor(options: FontLoadOptions = {}) {
    super();
    this.fetcher = options.fetcher ?? null;
    this.format = options.format ?? 'auto';
  }

  /**
   * Sets the base path.
   *
   * @param path Base path.
   * @returns This loader, for chaining.
   */
  public setPath(path: string): this {
    this.path = path;
    return this;
  }

  /**
   * Installs a `fetch` implementation.
   *
   * @param fetcher Fetcher, or `null` for the global one.
   * @returns This loader, for chaining.
   */
  public setFetcher(fetcher: FontFetchLike | null): this {
    this.fetcher = fetcher;
    return this;
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

  /* ------------------------------------------------------------------ loading */

  /**
   * Fetches and parses a BMFont file.
   *
   * @param url Font URL.
   * @param options Dialect, cancellation and page overrides.
   * @returns A bitmap font.
   * @throws Error When no `fetch` is available, or the payload is not a BMFont file.
   */
  public async loadFont(url: string, options: FontLoadOptions = {}): Promise<BitmapFont> {
    this.assertUsable();

    const resolved = this.resolveUrl(url);
    const fetcher = this.resolveFetcher(options);
    if (fetcher === null) {
      throw new Error(
        `FontLoader("${resolved}"): no \`fetch\` implementation is available. Use ` +
          '`loadFromString()` or `parse()` with inline data when running on a host ' +
          'without fetch.',
      );
    }

    const response = await fetcher(resolved, {
      method: 'GET',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (response.ok === false) {
      throw new Error(
        `FontLoader("${resolved}"): HTTP ${response.status ?? '?'} ${response.statusText ?? ''}`.trim(),
      );
    }

    const text = await response.text();
    options.onProgress?.(text.length, text.length);
    this.events.emit('progress', resolved, text.length, text.length);

    const font = this.parse(text, {
      format: options.format ?? this.format,
      url: resolved,
      ...(options.pages === undefined ? {} : { pages: options.pages }),
      ...(options.scale === undefined ? {} : { scale: options.scale }),
    });

    this.loadedCount++;
    this.events.emit('load', resolved, font);
    return font;
  }

  /**
   * Parses an inline BMFont payload.
   *
   * @param source Font contents.
   * @param options Dialect, source URL and page overrides.
   * @returns A bitmap font.
   * @throws Error When the payload is not a BMFont file.
   */
  public loadFromString(source: string, options: FontParseOptions = {}): BitmapFont {
    return this.parse(source, options);
  }

  /**
   * Parses an inline BMFont payload.
   *
   * @param source Font contents.
   * @param options Dialect, source URL and page overrides.
   * @returns A bitmap font.
   * @throws Error When the payload has no `common` block.
   */
  public parse(source: string, options: FontParseOptions = {}): BitmapFont {
    this.assertUsable();

    const url = options.url ?? '<inline>';
    const format = options.format ?? this.format;
    const extension = extname(url).toLowerCase();

    let data: BMFontData;
    if (format === 'json' || (format === 'auto' && extension === 'json')) {
      data = parseBMFontJSON(source, url);
    } else if (format === 'text' || (format === 'auto' && extension === 'fnt')) {
      data = source.trimStart().startsWith('{') ? parseBMFontJSON(source, url) : parseBMFontText(source, url);
    } else {
      data = parseBMFont(source, url);
    }

    const font = new BitmapFont(data, {
      url,
      ...(options.pages === undefined ? {} : { pages: options.pages }),
      ...(options.scale === undefined ? {} : { scale: options.scale }),
    });

    this.loadedCount++;
    log.debug(`parsed "${url}" into a ${font.glyphCount}-glyph BitmapFont`);
    return font;
  }

  /**
   * Parses a payload, falling back to a synthesised font when it cannot be read.
   *
   * The right entry point for a loader that must never fail: a missing font is a cosmetic
   * problem, and a deterministic fallback (with correct proportions but no real glyph
   * shapes) is far better than an exception in a render loop.
   *
   * @param source Font contents, or `null` to skip parsing.
   * @param options Dialect, source URL and page overrides.
   * @param size Font size for the fallback.
   * @returns A bitmap font, or a fallback font.
   */
  public parseOrFallback(source: string | null, options: FontParseOptions = {}, size = 16): Font {
    if (source === null) return createFallbackFont({ family: 'fallback', size });
    try {
      return this.parse(source, options);
    } catch (error) {
      const resolved = error instanceof Error ? error : new Error(String(error));
      const url = options.url ?? '<inline>';
      log.warn(`falling back for "${url}": ${resolved.message}`);
      this.events.emit('error', url, resolved);
      return createFallbackFont({ family: 'fallback', size });
    }
  }

  /* -------------------------------------------------------------------- URLs */

  /**
   * Resolves a font URL against {@link FontLoader.path}.
   *
   * @param url Relative or absolute URL.
   * @returns The resolved URL.
   */
  public resolveUrl(url: string): string {
    if (this.path.length === 0) return url;
    if (/^(https?:|data:|blob:|\/)/i.test(url)) return url;
    const base = this.path.endsWith('/') ? this.path : `${this.path}/`;
    return `${base}${url}`;
  }

  /**
   * Resolves a page image's URL against the font's own URL.
   *
   * @param fontUrl The font file's URL.
   * @param page Page index.
   * @param file Optional explicit file name; read from the font when omitted.
   * @returns The resolved URL, or `null` when the page is unknown.
   */
  public resolvePageUrl(fontUrl: string, page = 0, file?: string): string | null {
    const name = file ?? null;
    if (name === null) return null;
    if (/^(https?:|data:|blob:|\/)/i.test(name)) return name;
    const slash = fontUrl.lastIndexOf('/');
    const base = slash < 0 ? '' : fontUrl.slice(0, slash + 1);
    return `${base}${name}`;
  }

  /**
   * Resolves every page URL for a font.
   *
   * @param font Font whose page files should be resolved.
   * @returns One URL per declared page, in page order.
   */
  public resolvePageUrls(font: BitmapFont): (string | null)[] {
    const urls: (string | null)[] = [];
    for (let page = 0; page < font.pageCount; page++) {
      const file = font.getPageFile(page);
      urls.push(this.resolvePageUrl(font.data.url, page, file ?? undefined));
    }
    return urls;
  }

  /** Resolves the `fetch` implementation to use. */
  private resolveFetcher(options: FontLoadOptions): FontFetchLike | null {
    if (options.fetcher !== undefined) return options.fetcher;
    if (this.fetcher !== null) return this.fetcher;
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    return typeof globalFetch === 'function' ? (globalFetch as FontFetchLike) : null;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    this.fetcher = null;
    this.events.emit('dispose');
    this.events.dispose();
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return `FontLoader(path="${this.path}", loaded=${this.loadedCount})`;
  }
}

/**
 * Convenience factory mirroring `new FontLoader(options)`.
 *
 * @param options Transport and dialect overrides.
 * @returns A new text font loader.
 */
export function fontLoader(options: FontLoadOptions = {}): FontLoader {
  return new FontLoader(options);
}
