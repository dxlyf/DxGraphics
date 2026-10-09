/**
 * `JSONLoader` — JSON with a revision hook and a tolerant parse mode.
 *
 * JSON is the format every pipeline ends up using for sidecar data: revision
 * manifests, animation descriptors, atlas metadata, material presets. What those
 * files have in common is that the *shape* changes between versions, so a loader
 * that only returns `JSON.parse(text)` pushes the version handling into every call
 * site.
 *
 * This loader adds two things a raw `JSON.parse` does not:
 *
 * - **`setReviver`.** A `(key, value) => value` hook, identical in spirit to
 *   `JSON.parse`'s second argument, installed once on the loader.
 * - **Tolerant mode.** `setTolerant(true)` strips `//` and `/* *\/` comments and
 *   trailing commas — the two things that stop a hand-edited config file from
 *   parsing — while still rejecting genuinely malformed input with the original
 *   parser's message plus the byte offset.
 *
 * ```ts
 * const loader = new JSONLoader();
 * loader.setReviver((key, value) => (key === 'shader' ? resolve(value) : value));
 * const manifest = await loader.loadAsync('assets.json', { onProgress });
 * ```
 *
 * @packageDocumentation
 */

import { Loader, type LoadedSource } from './Loader';
import type { FetchLike, LoadOptions } from '../types';

/** A `JSON.parse` reviver. */
export type JSONReviver = (this: unknown, key: string, value: unknown) => unknown;

/** Options accepted by {@link JSONLoader.loadAsync}. */
export interface JSONLoadOptions extends LoadOptions {
  /** `fetch` implementation override. */
  fetcher?: FetchLike;
  /** Per-call reviver, overriding the loader's own. */
  reviver?: JSONReviver;
  /** Per-call tolerance flag, overriding the loader's own. */
  tolerant?: boolean;
}

/**
 * Loads and parses JSON documents.
 *
 * @typeParam T Parsed shape; caller-asserted, as JSON cannot be typed statically.
 */
export class JSONLoader<T = unknown> extends Loader<T, string> {
  /** `fetch` implementation in use. */
  public fetcher: FetchLike | null = null;

  /** Reviver applied to every parse. */
  public reviver: JSONReviver | null = null;

  /** `true` strips comments and trailing commas before parsing. */
  public tolerant = false;

  /** Number of documents parsed. */
  public parsedCount = 0;

  /** Bytes parsed, for diagnostics. */
  public parsedBytes = 0;

  /**
   * Creates a JSON loader.
   *
   * @param options Transport, reviver and tolerance configuration.
   */
  constructor(options: JSONLoadOptions = {}) {
    super();
    this.fetcher = options.fetcher ?? null;
    this.reviver = options.reviver ?? null;
    this.tolerant = options.tolerant ?? false;
  }

  /**
   * Installs a reviver.
   *
   * @param reviver Reviver, or `null` to clear it.
   * @returns This loader, for chaining.
   */
  public setReviver(reviver: JSONReviver | null): this {
    this.reviver = reviver;
    return this;
  }

  /**
   * Enables or disables tolerant parsing.
   *
   * @param tolerant New flag.
   * @returns This loader, for chaining.
   */
  public setTolerant(tolerant: boolean): this {
    this.tolerant = tolerant;
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
    const jsonOptions = options as JSONLoadOptions;
    const fetcher = this.resolveFetcher(jsonOptions);
    if (fetcher === null) {
      throw new Error(
        `JSONLoader("${url}"): no \`fetch\` implementation is available. Use \`parse()\` ` +
          'on an inline string when running on a host without fetch.',
      );
    }

    const response = await fetcher(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...this.requestHeaders,
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (response.ok === false) {
      throw new Error(`JSONLoader("${url}"): HTTP ${response.status ?? '?'} ${response.statusText ?? ''}`.trim());
    }

    const text = await response.text();
    this.reportProgress(url, text.length, text.length, options);
    return { data: text, fromCache: false, byteLength: text.length };
  }

  /**
   * @inheritdoc
   *
   * @throws Error When the text is not valid JSON, with the parser's position
   *   appended.
   */
  public override parse(source: string, url = '<inline>', options?: LoadOptions): T {
    const jsonOptions = (options ?? {}) as JSONLoadOptions;
    const tolerant = jsonOptions.tolerant ?? this.tolerant;
    const reviver = jsonOptions.reviver ?? this.reviver ?? undefined;

    const text = tolerant ? stripJSONNoise(source) : source;

    try {
      const value = reviver === undefined ? JSON.parse(text) : JSON.parse(text, reviver);
      this.parsedCount++;
      this.parsedBytes += source.length;
      return value as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const position = extractPosition(message);
      throw new Error(
        `JSONLoader("${url}"): malformed JSON${position === null ? '' : ` at ${position}`} — ${message}` +
          (tolerant ? '' : '. Enable `setTolerant(true)` to allow comments and trailing commas.'),
      );
    }
  }

  /** Resolves the `fetch` implementation to use. */
  private resolveFetcher(options: JSONLoadOptions): FetchLike | null {
    if (options.fetcher !== undefined) return options.fetcher;
    if (this.fetcher !== null) return this.fetcher;
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    return typeof globalFetch === 'function' ? (globalFetch as FetchLike) : null;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    super.onDispose();
    this.fetcher = null;
    this.reviver = null;
  }
}

/**
 * Strips `//` line comments, block comments and trailing commas from JSON text.
 *
 * The scanner tracks string state, so a `//` inside a URL value survives intact. It
 * does not attempt to be a general JSON5 parser: only the two constructs that
 * actually trip up hand-edited files are handled.
 *
 * @param source JSON-with-comments text.
 * @returns Equivalent strict JSON.
 */
export function stripJSONNoise(source: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    out += char;
  }

  // Trailing commas: `,` followed only by whitespace then `}` or `]`.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Extracts a `position N` fragment from a `JSON.parse` error message. */
function extractPosition(message: string): string | null {
  const match = /position (\d+)/.exec(message);
  return match === null ? null : `position ${match[1]}`;
}

/**
 * Convenience factory mirroring `new JSONLoader(options)`.
 *
 * @typeParam T Parsed shape.
 * @param options Transport, reviver and tolerance configuration.
 * @returns A new JSON loader.
 */
export function jsonLoader<T = unknown>(options: JSONLoadOptions = {}): JSONLoader<T> {
  return new JSONLoader<T>(options);
}
