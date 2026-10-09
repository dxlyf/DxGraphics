/**
 * `FileLoader` — text, `ArrayBuffer`, `Blob` and JSON over HTTP.
 *
 * ## Two transports, and why
 *
 * `fetch` is the modern path and the only one that composes with `AbortSignal`, but
 * it has one real weakness for an asset pipeline: **it cannot report upload/download
 * progress**. There is no `onprogress` for a response body without reading the
 * stream manually.
 *
 * `XMLHttpRequest` can, through `xhr.onprogress`. So this loader prefers `fetch`
 * and transparently falls back to XHR when **both** of these hold:
 *
 * 1. the caller asked for progress (`options.onProgress`), and
 * 2. an `XMLHttpRequest` implementation is reachable (globally, or injected through
 *    `options.xhrFactory`).
 *
 * The fallback is documented rather than silent: it emits a debug log line the
 * first time it happens per loader. Tests inject a fake `xhrFactory`, which is also
 * how the fallback is covered without a DOM.
 *
 * ```ts
 * const loader = new FileLoader();
 * const text = await loader.loadAsync('notes.txt', { responseType: 'text' });
 * const json = await loader.loadAsync('scene.json', { responseType: 'json' });
 * ```
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import { Loader, LoadAbortError, type LoadedSource } from './Loader';
import type { FetchLike, FetchResponseLike, LoadOptions, XhrFactory, XhrLike } from '../types';

/** Logger shared by the file loader. */
const log = createLogger('assets:file');

/** Response kinds `FileLoader` can produce. */
export type FileResponseType = 'text' | 'json' | 'arraybuffer' | 'blob' | 'document';

/** Options accepted by {@link FileLoader.loadAsync}. */
export interface FileLoadOptions extends LoadOptions {
  /** Response kind; defaults to `'text'`. */
  responseType?: FileResponseType;
  /** MIME type sent in the `Accept` header. */
  mimeType?: string;
  /** `fetch` implementation override, for tests and non-browser hosts. */
  fetcher?: FetchLike;
  /** `XMLHttpRequest` factory override, for the progress fallback. */
  xhrFactory?: XhrFactory;
  /** Force the XHR path even without a progress callback. */
  forceXhr?: boolean;
  /** Cache mode forwarded to `fetch`. */
  cache?: string;
}

/**
 * Loads text, bytes, blobs and JSON.
 *
 * @typeParam T Value type produced; defaults to `string`.
 */
export class FileLoader<T = string> extends Loader<T, unknown> {
  /** Response kind applied when the caller does not specify one. */
  public responseType: FileResponseType = 'text';

  /** MIME type reported in the `Accept` header. */
  public mimeType: string = '';

  /** `fetch` implementation in use. */
  public fetcher: FetchLike | null = null;

  /** `XMLHttpRequest` factory in use, when the fallback is available. */
  public xhrFactory: XhrFactory | null = null;

  /** Response kind used by the most recent successful load. */
  public lastResponseType: FileResponseType = 'text';

  /** `true` once the XHR fallback has been exercised. */
  public usedXhrFallback = false;

  /**
   * Creates a file loader.
   *
   * @param options Default response kind and transport overrides.
   */
  constructor(options: FileLoadOptions = {}) {
    super();
    this.responseType = options.responseType ?? 'text';
    this.mimeType = options.mimeType ?? '';
    this.fetcher = options.fetcher ?? null;
    this.xhrFactory = options.xhrFactory ?? null;
  }

  /**
   * Sets the default response kind.
   *
   * @param responseType New kind.
   * @returns This loader, for chaining.
   */
  public setResponseType(responseType: FileResponseType): this {
    this.responseType = responseType;
    return this;
  }

  /**
   * Sets the `Accept` MIME type.
   *
   * @param mimeType MIME type; `''` removes the header.
   * @returns This loader, for chaining.
   */
  public setMimeType(mimeType: string): this {
    this.mimeType = mimeType;
    return this;
  }

  /**
   * Installs a `fetch` implementation.
   *
   * @param fetcher Fetcher, or `null` to use the global one.
   * @returns This loader, for chaining.
   */
  public setFetcher(fetcher: FetchLike | null): this {
    this.fetcher = fetcher;
    return this;
  }

  /**
   * Installs an `XMLHttpRequest` factory.
   *
   * @param factory Factory, or `null` to use the global constructor.
   * @returns This loader, for chaining.
   */
  public setXhrFactory(factory: XhrFactory | null): this {
    this.xhrFactory = factory;
    return this;
  }

  /**
   * @inheritdoc
   *
   * Chooses between `fetch` and `XMLHttpRequest` and normalises both into the
   * declared response kind.
   */
  protected override async loadData(url: string, options: LoadOptions): Promise<LoadedSource<unknown>> {
    const fileOptions = options as FileLoadOptions;
    const responseType = fileOptions.responseType ?? this.responseType;
    this.lastResponseType = responseType;

    const wantsProgress = typeof fileOptions.onProgress === 'function';
    const factory = this.resolveXhrFactory(fileOptions);

    if (fileOptions.forceXhr === true || (wantsProgress && factory !== null)) {
      const data = await this.loadWithXhr(url, responseType, fileOptions, factory as XhrFactory);
      return { data, fromCache: false };
    }

    const fetchImpl = this.resolveFetcher(fileOptions);
    if (fetchImpl === null) {
      if (factory !== null) {
        const data = await this.loadWithXhr(url, responseType, fileOptions, factory);
        return { data, fromCache: false };
      }
      throw new Error(
        `FileLoader("${url}"): neither \`fetch\` nor \`XMLHttpRequest\` is available. ` +
          'Pass `fetcher` or `xhrFactory` when running on a host without them.',
      );
    }

    const data = await this.loadWithFetch(url, responseType, fileOptions, fetchImpl);
    return { data, fromCache: false };
  }

  /** `fetch` transport. */
  private async loadWithFetch(
    url: string,
    responseType: FileResponseType,
    options: FileLoadOptions,
    fetcher: FetchLike,
  ): Promise<unknown> {
    const headers: Record<string, string> = { ...this.requestHeaders };
    if (this.mimeType.length > 0) headers.Accept = this.mimeType;

    const init: Parameters<FetchLike>[1] = {
      method: 'GET',
      headers,
      credentials: this.withCredentials ? 'include' : 'same-origin',
    };
    if (this.crossOrigin.length > 0) init.mode = 'cors';
    if (options.cache !== undefined) init.cache = options.cache;
    if (options.signal !== undefined) init.signal = options.signal;

    const response = await fetcher(url, init);
    if (response.ok === false) {
      throw new Error(
        `FileLoader("${url}"): HTTP ${response.status ?? '?'} ${response.statusText ?? ''}`.trim(),
      );
    }

    return this.readResponse(response, url, responseType);
  }

  /** Turns a `Response` into the requested value. */
  private async readResponse(
    response: FetchResponseLike,
    url: string,
    responseType: FileResponseType,
  ): Promise<unknown> {
    switch (responseType) {
      case 'arraybuffer':
        return response.arrayBuffer();
      case 'blob': {
        if (typeof response.blob === 'function') return response.blob();
        throw new Error(
          `FileLoader("${url}"): responseType "blob" needs a Response with a blob() method; ` +
            'use "arraybuffer" instead.',
        );
      }
      case 'json': {
        const text = await response.text();
        return JSON.parse(text);
      }
      case 'document':
      case 'text':
      default: {
        const text = await response.text();
        this.reportProgress(url, text.length, text.length, {});
        return text;
      }
    }
  }

  /** `XMLHttpRequest` transport, the only progress-capable path. */
  private loadWithXhr(
    url: string,
    responseType: FileResponseType,
    options: FileLoadOptions,
    factory: XhrFactory,
  ): Promise<unknown> {
    if (!this.usedXhrFallback) {
      this.usedXhrFallback = true;
      log.debug(
        'using the XMLHttpRequest fallback because a progress callback was supplied ' +
          '(fetch cannot report response progress)',
      );
    }

    return new Promise<unknown>((resolve, reject) => {
      const xhr = factory();
      xhr.open('GET', url, true);

      for (const [name, value] of Object.entries(this.requestHeaders)) {
        xhr.setRequestHeader(name, value);
      }
      if (this.mimeType.length > 0) xhr.setRequestHeader('Accept', this.mimeType);
      if (this.withCredentials) xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');

      xhr.responseType = responseType === 'json' ? 'text' : responseType;

      const unregister = this.onAbort(() => {
        try {
          xhr.abort();
        } catch {
          /* already finished */
        }
        reject(new LoadAbortError(url));
      });

      xhr.onprogress = (event: { loaded: number; total: number }) => {
        this.reportProgress(url, event.loaded, event.total, options);
      };

      xhr.onload = () => {
        unregister();
        if (xhr.status !== 0 && (xhr.status < 200 || xhr.status >= 300)) {
          reject(
            new Error(`FileLoader("${url}"): HTTP ${xhr.status} ${xhr.statusText}`.trim()),
          );
          return;
        }

        try {
          resolve(this.readXhrResult(xhr, responseType));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      xhr.onerror = () => {
        unregister();
        reject(new Error(`FileLoader("${url}"): the request failed (network or CORS error)`));
      };

      xhr.onabort = () => {
        unregister();
        reject(new LoadAbortError(url));
      };

      try {
        xhr.send();
      } catch (error) {
        unregister();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Converts an XHR payload into the requested kind. */
  private readXhrResult(xhr: XhrLike, responseType: FileResponseType): unknown {
    switch (responseType) {
      case 'json':
        return JSON.parse(xhr.responseText);
      case 'arraybuffer':
        return xhr.response;
      case 'blob':
        return xhr.response;
      case 'document':
      case 'text':
      default:
        return xhr.responseType === 'text' || xhr.responseType === '' ? xhr.responseText : xhr.response;
    }
  }

  /** Resolves the `fetch` implementation to use. */
  private resolveFetcher(options: FileLoadOptions): FetchLike | null {
    if (options.fetcher !== undefined) return options.fetcher;
    if (this.fetcher !== null) return this.fetcher;
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    return typeof globalFetch === 'function' ? (globalFetch as FetchLike) : null;
  }

  /** Resolves the `XMLHttpRequest` factory to use. */
  private resolveXhrFactory(options: FileLoadOptions): XhrFactory | null {
    if (options.xhrFactory !== undefined) return options.xhrFactory;
    if (this.xhrFactory !== null) return this.xhrFactory;
    const globalXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    return typeof globalXhr === 'function' ? (() => new (globalXhr as new () => XhrLike)()) : null;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    super.onDispose();
    this.fetcher = null;
    this.xhrFactory = null;
  }
}

/**
 * Convenience factory mirroring `new FileLoader(options)`.
 *
 * @typeParam T Value type produced.
 * @param options Default response kind and transport overrides.
 * @returns A new file loader.
 */
export function fileLoader<T = string>(options: FileLoadOptions = {}): FileLoader<T> {
  return new FileLoader<T>(options);
}
