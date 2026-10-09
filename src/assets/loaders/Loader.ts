/**
 * `Loader` — the base class every asset loader shares.
 *
 * A loader owns four policies that would otherwise be re-implemented (and
 * re-broken) in every subclass:
 *
 * 1. **URL resolution.** `path` prefixes every request; `resolveUrl` joins them and
 *    leaves absolute URLs, data URIs and blob URLs untouched.
 * 2. **Request policy.** `crossOrigin`, `withCredentials` and `requestHeaders` are
 *    applied to every request the loader makes.
 * 3. **Retry with exponential backoff.** A transient network failure is retried
 *    `retries` times, waiting `retryDelay * 2^(attempt - 1)` milliseconds between
 *    attempts. The sequence is exposed through {@link Loader.getRetryDelays} so a
 *    test can assert it without sleeping.
 * 4. **Cancellation.** {@link Loader.abort} fails the in-flight request with a
 *    {@link LoadAbortError}, and the `AbortSignal` in `LoadOptions` does the same.
 *
 * Subclasses implement {@link Loader.loadData} (fetch bytes or text) and
 * {@link Loader.parse} (turn bytes into a value). Everything else — retries,
 * progress plumbing, events, disposal — is inherited.
 *
 * ```ts
 * class MyLoader extends Loader<Thing> {
 *   protected async loadData(url: string, options: LoadOptions) {
 *     return { data: await fetchText(url), fromCache: false };
 *   }
 *   public parse(source: string): Thing { return new Thing(source); }
 * }
 * ```
 *
 * @packageDocumentation
 */

import { DEFAULT_LOAD_RETRIES, DEFAULT_RETRY_DELAY } from '../../constants';
import { Disposable, type DisposableEvents } from '../../core/Disposable';
import { EventEmitter, type EventMap } from '../../core/EventEmitter';
import { basename, isAbsolutePath, isDataUri, isHttpUrl, resolvePath } from '../../utils/PathUtils';
import { createLogger } from '../../utils/Logger';
import type { LoadError, LoadOptions, LoadProgress } from '../types';

/** Logger shared by every loader. */
const log = createLogger('assets:loader');

/**
 * Events emitted by a {@link Loader}.
 *
 * `dispose` and `disposed` are inherited from `DisposableEvents`, so the loader's own
 * bus doubles as the base class's lifecycle bus and a caller can observe teardown
 * through either API.
 */
export interface LoaderEvents<T> {
  /** A load finished successfully. */
  load: [url: string, value: T];
  /** A load failed after every retry. */
  error: [error: LoadError];
  /** Byte progress. */
  progress: [progress: LoadProgress];
  /** A retry is about to be attempted. */
  retry: [url: string, attempt: number, delay: number];
}

/** Error raised when a load is cancelled. */
export class LoadAbortError extends Error {
  /** URL whose load was cancelled. */
  public readonly url: string;

  /**
   * Creates an abort error.
   *
   * @param url URL that was cancelled.
   */
  constructor(url: string) {
    super(`Load aborted: ${url}`);
    this.name = 'LoadAbortError';
    this.url = url;
  }
}

/** Normalised result of {@link Loader.loadData}. */
export interface LoadedSource<T = unknown> {
  /** Raw payload the parser consumes. */
  data: T;
  /** `true` when the payload came from a cache rather than the network. */
  fromCache: boolean;
  /** Byte length, when known. */
  byteLength?: number;
}

/** Per-loader statistics. */
export interface LoaderStats {
  /** Requests started. */
  requests: number;
  /** Requests that succeeded. */
  successes: number;
  /** Requests that failed after every retry. */
  failures: number;
  /** Individual failed attempts, including retried ones. */
  attempts: number;
  /** Retries performed. */
  retries: number;
  /** Cache hits reported by `loadData`. */
  cacheHits: number;
  /** Summed load duration of successful requests, in milliseconds. */
  totalDuration: number;
}

/**
 * Base class for asset loaders.
 *
 * @typeParam T Value the loader produces.
 * @typeParam TSource Raw payload {@link Loader.parse} consumes.
 */
export abstract class Loader<T = unknown, TSource = ArrayBuffer | string> extends Disposable<'Loader'> {
  /** @inheritdoc */
  public override readonly label = 'Loader' as const;

  /** Base path prefixed to every relative URL. */
  public path: string = '';

  /** `crossOrigin` attribute applied to image/style requests. */
  public crossOrigin: string = 'anonymous';

  /** `true` sends credentials with cross-origin requests. */
  public withCredentials = false;

  /** Extra headers applied to every HTTP request. */
  public readonly requestHeaders: Record<string, string> = {};

  /** Attempts made before a failure is reported. */
  public retries: number;

  /** Delay before the first retry, in milliseconds. */
  public retryDelay: number;

  /** Upper bound on a single backoff delay, in milliseconds. */
  public maxRetryDelay = 30_000;

  /** `true` while a request is in flight. */
  public loading = false;

  /**
   * Lifecycle events.
   *
   * Re-declared with a wider map than `Disposable`'s own bus; see
   * `AssetManager.events` for why the cast is unavoidable with a contravariant
   * `emit` signature.
   */
  public override readonly events = new EventEmitter<LoaderEvents<T>>() as unknown as EventEmitter<
    LoaderEvents<T>
  > &
    EventEmitter<DisposableEvents>;

  /** Cumulative statistics. */
  public readonly stats: LoaderStats = {
    requests: 0,
    successes: 0,
    failures: 0,
    attempts: 0,
    retries: 0,
    cacheHits: 0,
    totalDuration: 0,
  };

  /** `true` once {@link Loader.abort} has been called for the current request. */
  protected aborted = false;

  /** Abort callbacks registered by the in-flight request. */
  private readonly abortHandlers = new Set<() => void>();

  /** Timer handle of a pending retry delay. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Creates a loader.
   *
   * @param retries Attempts before reporting a failure; defaults to
   *   `DEFAULT_LOAD_RETRIES`.
   * @param retryDelay First backoff delay in milliseconds; defaults to
   *   `DEFAULT_RETRY_DELAY`.
   */
  constructor(retries: number = DEFAULT_LOAD_RETRIES, retryDelay: number = DEFAULT_RETRY_DELAY) {
    super();
    this.retries = Math.max(0, Math.floor(retries));
    this.retryDelay = Math.max(0, retryDelay);
  }

  /* ----------------------------------------------------------------- config */

  /**
   * Sets the base path used for relative URLs.
   *
   * @param path Base path; a trailing slash is added when missing.
   * @returns This loader, for chaining.
   */
  public setPath(path: string): this {
    this.path = path;
    return this;
  }

  /**
   * Sets the `crossOrigin` policy.
   *
   * @param crossOrigin `'anonymous'`, `'use-credentials'`, or `''` for none.
   * @returns This loader, for chaining.
   */
  public setCrossOrigin(crossOrigin: string): this {
    this.crossOrigin = crossOrigin;
    return this;
  }

  /**
   * Enables or disables credential sending.
   *
   * @param withCredentials New value.
   * @returns This loader, for chaining.
   */
  public setWithCredentials(withCredentials: boolean): this {
    this.withCredentials = withCredentials;
    return this;
  }

  /**
   * Adds a request header.
   *
   * @param name Header name.
   * @param value Header value; passing `null` removes the header.
   * @returns This loader, for chaining.
   */
  public setRequestHeader(name: string, value: string | null): this {
    if (value === null) delete this.requestHeaders[name];
    else this.requestHeaders[name] = value;
    return this;
  }

  /**
   * Replaces every request header.
   *
   * @param headers New headers.
   * @returns This loader, for chaining.
   */
  public setRequestHeaders(headers: Record<string, string>): this {
    for (const key of Object.keys(this.requestHeaders)) delete this.requestHeaders[key];
    for (const [key, value] of Object.entries(headers)) this.requestHeaders[key] = value;
    return this;
  }

  /**
   * Overrides the retry policy for subsequent loads.
   *
   * @param retries Attempts before failure.
   * @param retryDelay First backoff delay in milliseconds.
   * @returns This loader, for chaining.
   */
  public setRetryPolicy(retries: number, retryDelay: number = this.retryDelay): this {
    this.retries = Math.max(0, Math.floor(retries));
    this.retryDelay = Math.max(0, retryDelay);
    return this;
  }

  /* -------------------------------------------------------------- URL join */

  /**
   * Resolves a URL against {@link Loader.path}.
   *
   * @param url Relative or absolute URL.
   * @returns The resolved URL.
   */
  public resolveUrl(url: string): string {
    if (isDataUri(url) || isAbsolutePath(url) || isHttpUrl(url)) return url;
    if (this.path.length === 0) return url;

    const base = this.path.endsWith('/') ? this.path : `${this.path}/`;
    return resolvePath(base, url);
  }

  /* ---------------------------------------------------------------- loading */

  /**
   * The conventional three.js-style callback API.
   *
   * @param url URL to load.
   * @param onLoad Called with the parsed value on success.
   * @param onProgress Byte progress callback.
   * @param onError Called with the failure on every attempt failing.
   * @returns This loader, for chaining.
   */
  public load(
    url: string,
    onLoad?: (value: T) => void,
    onProgress?: (progress: LoadProgress) => void,
    onError?: (error: LoadError) => void,
  ): this {
    void this.loadAsync(url, { onProgress })
      .then((value) => {
        onLoad?.(value);
      })
      .catch((error: unknown) => {
        const resolved = error instanceof Error ? error : new Error(String(error));
        onError?.({
          url: this.resolveUrl(url),
          error: resolved,
          attempt: 0,
          aborted: resolved instanceof LoadAbortError,
        });
      });
    return this;
  }

  /**
   * Promise API with retry and backoff.
   *
   * @param url URL to load.
   * @param options Cancellation, progress and per-call retry overrides.
   * @returns The parsed value.
   * @throws LoadAbortError When the load was cancelled.
   * @throws Error When every attempt failed; the message names the attempt count.
   */
  public async loadAsync(url: string, options: LoadOptions = {}): Promise<T> {
    this.assertUsable();

    const resolved = this.resolveUrl(url);
    const retries = Math.max(0, Math.floor(options.retries ?? this.retries));
    const baseDelay = Math.max(0, options.retryDelay ?? this.retryDelay);
    const totalAttempts = retries + 1;

    this.loading = true;
    this.aborted = false;
    this.stats.requests++;
    const startedAt = nowMillis();

    let lastError: Error = new Error(`loadAsync("${resolved}"): no attempt was made`);

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      if (this.aborted || options.signal?.aborted === true) {
        this.loading = false;
        const abort = new LoadAbortError(resolved);
        this.reportError(resolved, abort, attempt, true, options);
        throw abort;
      }

      this.stats.attempts++;

      try {
        const source = await this.loadData(resolved, options);
        if (source.fromCache) this.stats.cacheHits++;

        const value = await this.parse(source.data, resolved, options);
        this.loading = false;
        this.stats.successes++;
        this.stats.totalDuration += nowMillis() - startedAt;
        this.events.emit('load', resolved, value);
        return value;
      } catch (error) {
        // `this.aborted` is read through a widening cast: TypeScript narrows the
        // compound condition above, so it would otherwise consider the flag `false`
        // for the rest of the function even though `abort()` can be called while the
        // awaited request is in flight.
        const abortedByFlag: boolean = this.aborted;
        const abortedBySignal: boolean = Boolean(options.signal?.aborted);
        if (abortedByFlag || abortedBySignal || error instanceof LoadAbortError) {
          this.loading = false;
          const abort = error instanceof LoadAbortError ? error : new LoadAbortError(resolved);
          this.stats.failures++;
          this.reportError(resolved, abort, attempt, true, options);
          throw abort;
        }

        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt >= totalAttempts) break;

        const delay = this.getRetryDelay(attempt, baseDelay);
        this.stats.retries++;
        log.debug(`retrying "${resolved}" in ${delay}ms (attempt ${attempt + 1}/${totalAttempts})`);
        this.events.emit('retry', resolved, attempt + 1, delay);
        await this.sleep(delay);
      }
    }

    this.loading = false;
    this.stats.failures++;
    const wrapped = new Error(
      `Loader failed for "${resolved}" after ${totalAttempts} attempt${totalAttempts === 1 ? '' : 's'}: ` +
        lastError.message,
    );
    wrapped.cause = lastError;
    this.reportError(resolved, lastError, totalAttempts, false, options);
    throw wrapped;
  }

  /**
   * Backoff delay before a given retry.
   *
   * Attempt `n` (1-based, so the first **retry** is attempt 1) waits
   * `min(retryDelay * 2^(n - 1), maxRetryDelay)` milliseconds.
   *
   * @param attempt Retry index, starting at `1`.
   * @param baseDelay First delay; defaults to {@link Loader.retryDelay}.
   * @returns The delay in milliseconds.
   */
  public getRetryDelay(attempt: number, baseDelay: number = this.retryDelay): number {
    const index = Math.max(1, Math.floor(attempt));
    return Math.min(this.maxRetryDelay, baseDelay * Math.pow(2, index - 1));
  }

  /**
   * The full delay sequence for `retries` retries.
   *
   * Exposed so a test can assert `[250, 500, 1000]` without manipulating timers.
   *
   * @param retries Number of retries; defaults to {@link Loader.retries}.
   * @param baseDelay First delay; defaults to {@link Loader.retryDelay}.
   * @returns One delay per retry, in milliseconds.
   */
  public getRetryDelays(retries: number = this.retries, baseDelay: number = this.retryDelay): number[] {
    const out: number[] = [];
    for (let attempt = 1; attempt <= Math.max(0, Math.floor(retries)); attempt++) {
      out.push(this.getRetryDelay(attempt, baseDelay));
    }
    return out;
  }

  /**
   * Cancels the in-flight request.
   *
   * A pending backoff timer is cleared and every registered abort handler runs, so a
   * subclass that owns a network request can tear it down.
   *
   * @returns This loader, for chaining.
   */
  public abort(): this {
    this.aborted = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    for (const handler of Array.from(this.abortHandlers)) {
      try {
        handler();
      } catch (error) {
        log.warn('an abort handler threw', error);
      }
    }
    this.abortHandlers.clear();
    this.loading = false;
    return this;
  }

  /**
   * Registers a teardown callback invoked by {@link Loader.abort}.
   *
   * @param handler Callback.
   * @returns A function that unregisters it.
   */
  public onAbort(handler: () => void): () => void {
    this.abortHandlers.add(handler);
    return () => {
      this.abortHandlers.delete(handler);
    };
  }

  /**
   * `true` when the current request has been cancelled.
   *
   * @returns The abort flag.
   */
  public get isAborted(): boolean {
    return this.aborted;
  }

  /* ------------------------------------------------------------- subclass API */

  /**
   * Fetches the raw payload.
   *
   * @param url Resolved URL.
   * @param options Per-call options.
   * @returns The raw payload plus a cache flag.
   */
  protected abstract loadData(url: string, options: LoadOptions): Promise<LoadedSource<TSource>>;

  /**
   * Turns a raw payload into the loader's value type.
   *
   * Subclasses may override the async form when parsing needs an extra fetch; the
   * default implementation simply wraps the synchronous result.
   *
   * @param source Raw payload produced by {@link Loader.loadData}.
   * @param url Resolved URL, for error messages.
   * @param options Per-call options.
   * @returns The parsed value.
   */
  public parse(source: TSource, url?: string, options?: LoadOptions): T | Promise<T> {
    void url;
    void options;
    return source as unknown as T;
  }

  /* --------------------------------------------------------------- progress */

  /**
   * Emits a progress report.
   *
   * @param url URL the report belongs to.
   * @param loaded Bytes transferred.
   * @param total Total bytes, or `0` when unknown.
   * @param options Per-call options carrying the caller's callback.
   */
  protected reportProgress(url: string, loaded: number, total: number, options: LoadOptions = {}): void {
    const progress: LoadProgress = {
      loaded,
      total,
      ratio: total > 0 ? Math.min(1, loaded / total) : 0,
      url,
    };
    this.events.emit('progress', progress);
    options.onProgress?.(progress);
  }

  /** Emits the error event and calls the caller's handler. */
  private reportError(
    url: string,
    error: Error,
    attempt: number,
    aborted: boolean,
    options: LoadOptions,
  ): void {
    const record: LoadError = { url, error, attempt, aborted };
    this.events.emit('error', record);
    const handler = options.onError;
    if (typeof handler === 'function') {
      (handler as (value: LoadError) => void)(record);
    }
  }

  /** Sleeps for `delay` milliseconds, honouring {@link Loader.abort}. */
  private sleep(delay: number): Promise<void> {
    if (delay <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        resolve();
      }, delay);
    });
  }

  /**
   * Releases the loader.
   *
   * Aborts any in-flight request, clears listeners and hands the label back.
   */
  protected override onDispose(): void {
    this.abort();
    this.events.emit('dispose');
    this.events.dispose();
    this.abortHandlers.clear();
  }

  /**
   * @returns A short name for the loader's value type, used in diagnostics.
   */
  public get type(): string {
    return this.constructor.name;
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return `${this.type}(path="${this.path}", retries=${this.retries}, loading=${this.loading})`;
  }
}

/**
 * The file name portion of a URL, used as a default asset key.
 *
 * @param url URL to inspect.
 * @returns The base name.
 */
export function assetKey(url: string): string {
  return basename(url);
}

/** Monotonic clock reading in milliseconds. */
function nowMillis(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * `true` when `error` represents a cancelled load.
 *
 * @param error Value to test.
 * @returns `true` for a {@link LoadAbortError} or an `AbortError`.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof LoadAbortError) return true;
  return (
    error instanceof Error && (error.name === 'AbortError' || error.name === 'LoadAbortError')
  );
}
