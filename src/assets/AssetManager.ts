/**
 * `AssetManager` — batched, concurrency-limited, cancellable loading.
 *
 * An `AssetManager` is what turns "load these 200 files" from a `Promise.all` that
 * opens 200 sockets into something a browser and a server both tolerate:
 *
 * - **Concurrency cap.** At most `DEFAULT_MAX_CONCURRENT_LOADS` (6) requests are in
 *   flight; the rest queue. The cap is observable through
 *   {@link AssetManager.stats}, which is how the test asserts it.
 * - **Per-item and aggregate progress.** Each item reports its byte ratio; the batch
 *   reports completion and an averaged ratio.
 * - **Error aggregation.** One failure does not reject the batch. Every item settles,
 *   the failures land in {@link AssetManager.getErrors}, and `loadAll` resolves with
 *   the successful values.
 * - **Cancellation.** `AbortSignal`, plus {@link AssetManager.abort} for the whole
 *   batch.
 * - **Caching.** Results are memoised by key, so a second request for the same asset
 *   is free; `unload` releases one and `dispose` releases all.
 *
 * ```ts
 * const assets = new AssetManager({ concurrency: 4 });
 * assets.register('gltf', gltfLoader, { extensions: ['.glb'] });
 * const { textures, models, errors } = await assets.loadGroup({
 *   textures: ['brick.png', 'grass.png'],
 *   models: ['tree.glb'],
 * });
 * ```
 *
 * @packageDocumentation
 */

import { DEFAULT_MAX_CONCURRENT_LOADS } from '../constants';
import { Disposable, type DisposableEvents } from '../core/Disposable';
import { EventEmitter, type EventMap } from '../core/EventEmitter';
import { createLogger } from '../utils/Logger';
import { basename } from '../utils/PathUtils';
import { Cache } from './Cache';
import { Loader, isAbortError } from './loaders/Loader';
import { LoaderManager } from './loaders/LoaderManager';
import type {
  AssetRequest,
  AssetResult,
  BatchProgress,
  CacheStats,
  LoadOptions,
  LoadProgress,
} from './types';

/** Logger shared by the asset manager. */
const log = createLogger('assets:manager');

/**
 * Events emitted by an {@link AssetManager}.
 *
 * `dispose` and `disposed` come from {@link DisposableEvents}, so the manager's own
 * bus doubles as the base class's lifecycle bus.
 */
export interface AssetManagerEvents {
  /** One item finished, successfully or not. */
  item: [result: AssetResult];
  /** Batch progress changed. */
  progress: [progress: BatchProgress];
  /** Byte progress from one item. */
  bytes: [progress: LoadProgress];
  /** Every item in the batch settled. */
  complete: [progress: BatchProgress];
}

/** Construction options for {@link AssetManager}. */
export interface AssetManagerOptions {
  /** Concurrent request cap; defaults to `DEFAULT_MAX_CONCURRENT_LOADS`. */
  concurrency?: number;
  /** Entry cap for the result cache; defaults to `DEFAULT_CACHE_LIMIT`. */
  cacheLimit?: number;
  /** Reuse one loader for every item instead of resolving through the registry. */
  loader?: Loader<unknown>;
  /** Base path applied to every registered loader. */
  path?: string;
  /** `crossOrigin` applied to every registered loader. */
  crossOrigin?: string;
  /** Manual cache override. */
  cache?: Cache<unknown>;
  /** `true` rejects the batch as soon as one item fails; defaults to `false`. */
  failFast?: boolean;
}

/** Live statistics for an {@link AssetManager}. */
export interface AssetManagerStats {
  /** Requests started. */
  requests: number;
  /** Requests served from the cache. */
  cacheHits: number;
  /** Requests that succeeded. */
  succeeded: number;
  /** Requests that failed. */
  failed: number;
  /** Peak number of requests in flight at once. */
  peakInFlight: number;
  /** Requests currently in flight. */
  inFlight: number;
  /** Requests currently queued. */
  queued: number;
  /** Cached entries. */
  entries: number;
  /** Cache *loader* statistics. */
  cache: CacheStats;
}

/** A grouped batch description. */
export type AssetGroup = Record<string, readonly (string | AssetRequest)[]>;

/** The resolved shape of {@link AssetGroup}. */
export type AssetGroupResult = Record<string, unknown[]>;

/** A queue entry. */
interface QueueEntry {
  /** Function that performs the load. */
  run: () => Promise<void>;
  /** Requested key, for diagnostics. */
  key: string;
  /** Abort callback registered by the running load. */
  cancel?: () => void;
}

/**
 * Batched asset loading with a concurrency cap and a bounded cache.
 */
export class AssetManager extends Disposable<'AssetManager'> {
  /** @inheritdoc */
  public override readonly label = 'AssetManager' as const;

  /** Loader registry used to resolve URLs to loaders. */
  public readonly loaders = new LoaderManager();

  /** Result cache. */
  public readonly cache: Cache<unknown>;

  /**
   * Lifecycle events.
   *
   * Re-declared with a wider map than `Disposable`'s own bus so the manager can
   * publish batch events on the same emitter. The cast is required because
   * `EventEmitter`'s `emit` is contravariant in its argument tuple, so a narrower
   * map is not structurally assignable to a wider one even though every listener
   * registered through either type is called correctly at runtime.
   */
  public override readonly events = new EventEmitter<
    AssetManagerEvents & DisposableEvents
  >() as unknown as EventEmitter<DisposableEvents> & EventEmitter<AssetManagerEvents>;

  /** Concurrent request cap. */
  public concurrency: number;

  /** `true` rejects the batch on the first failure. */
  public failFast: boolean;

  /** Loading statistics. */
  public readonly stats: AssetManagerStats;

  /** Pending queue entries. */
  private readonly queue: QueueEntry[] = [];

  /** Number of requests currently in flight. */
  private inFlight = 0;

  /** Accumulated byte ratios per key, for aggregate progress. */
  private readonly ratios = new Map<string, number>();

  /** Failures collected since the last {@link AssetManager.clearErrors}. */
  private readonly failures: AssetResult[] = [];

  /** Loader used when the registry cannot resolve a URL. */
  private fallbackLoader: Loader<unknown> | null;

  /** Peak in-flight count observed. */
  private peak = 0;

  /**
   * Creates an asset manager.
   *
   * @param options Concurrency, cache and registry configuration.
   */
  constructor(options: AssetManagerOptions = {}) {
    super();
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_MAX_CONCURRENT_LOADS));
    this.failFast = options.failFast ?? false;
    this.cache = options.cache ?? new Cache<unknown>({ limit: options.cacheLimit });
    this.fallbackLoader = options.loader ?? null;

    if (options.path !== undefined) this.loaders.setPath(options.path);
    if (options.crossOrigin !== undefined) this.loaders.setCrossOrigin(options.crossOrigin);

    this.stats = {
      requests: 0,
      cacheHits: 0,
      succeeded: 0,
      failed: 0,
      peakInFlight: 0,
      inFlight: 0,
      queued: 0,
      entries: 0,
      cache: this.cache.stats,
    };
  }

  /* ---------------------------------------------------------------- registry */

  /**
   * Registers a loader.
   *
   * @param name Registration name; `'default'` marks the fallback.
   * @param loader Loader instance.
   * @param options Extensions, MIME types and predicate.
   * @returns The loader.
   */
  public register<T>(
    name: string,
    loader: Loader<T>,
    options: Parameters<LoaderManager['register']>[2] = {},
  ): Loader<T> {
    return this.loaders.register(name, loader, options);
  }

  /**
   * Removes a loader registration.
   *
   * @param name Registration name.
   * @returns `true` when a registration was removed.
   */
  public unregister(name: string): boolean {
    return this.loaders.unregister(name);
  }

  /**
   * Marks a registration as the fallback.
   *
   * @param name Registration name.
   * @returns This manager, for chaining.
   */
  public setDefaultLoader(name: string): this {
    this.loaders.setDefault(name);
    return this;
  }

  /**
   * Uses one loader for every item, bypassing the registry.
   *
   * @param loader Loader, or `null` to go back to registry resolution.
   * @returns This manager, for chaining.
   */
  public setLoader(loader: Loader<unknown> | null): this {
    this.fallbackLoader = loader;
    return this;
  }

  /**
   * Sets the base path on every registered loader.
   *
   * @param path Base path.
   * @returns This manager, for chaining.
   */
  public setPath(path: string): this {
    this.loaders.setPath(path);
    return this;
  }

  /**
   * Sets the `crossOrigin` policy on every registered loader.
   *
   * @param crossOrigin Cross-origin policy.
   * @returns This manager, for chaining.
   */
  public setCrossOrigin(crossOrigin: string): this {
    this.loaders.setCrossOrigin(crossOrigin);
    return this;
  }

  /**
   * Sets a request header on every registered loader.
   *
   * @param name Header name.
   * @param value Header value.
   * @returns This manager, for chaining.
   */
  public setRequestHeader(name: string, value: string | null): this {
    this.loaders.setRequestHeader(name, value);
    return this;
  }

  /**
   * Sets the concurrency cap.
   *
   * Raising the cap immediately starts the queued work that now fits.
   *
   * @param concurrency New cap; clamped to at least `1`.
   * @returns This manager, for chaining.
   */
  public setConcurrency(concurrency: number): this {
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.pump();
    return this;
  }

  /* ----------------------------------------------------------------- loading */

  /**
   * Loads one asset.
   *
   * @typeParam T Value type.
   * @param url URL to load, or an explicit key when `options.key` is set.
   * @param options Cache key, loader override and load options.
   * @returns The loaded value.
   * @throws Error When no loader can handle the URL, or the load failed.
   */
  public async load<T = unknown>(
    url: string,
    options: LoadOptions & { key?: string; loader?: string; value?: T } = {},
  ): Promise<T> {
    this.assertUsable();

    const key = options.key ?? url;

    if (options.value !== undefined) {
      this.cache.set(key, options.value);
      this.refreshStats();
      return options.value;
    }

    const cached = this.cache.get(key);
    if (cached !== undefined && options.bypassCache !== true) {
      this.stats.cacheHits++;
      this.refreshStats();
      return cached as T;
    }

    const loader = this.resolveLoader<T>(url, options.loader);
    if (loader === null) {
      throw new Error(
        `AssetManager.load("${url}"): no loader is registered for this URL. ` +
          `Known extensions: ${this.loaders.extensions().join(', ') || '<none>'}. ` +
          'Register one with `register(name, loader, { extensions: [...] })`.',
      );
    }

    this.stats.requests++;
    const value = await loader.loadAsync(url, {
      ...options,
      onProgress: (progress: LoadProgress) => {
        this.ratios.set(key, progress.ratio);
        this.events.emit('bytes', { ...progress, key });
        const handler = options.onProgress;
        if (typeof handler === 'function') (handler as (p: LoadProgress) => void)(progress);
      },
    });

    this.cache.set(key, value);
    this.stats.succeeded++;
    this.refreshStats();
    return value;
  }

  /**
   * Loads a batch with the concurrency cap applied.
   *
   * Every entry settles: a failure is recorded and the batch continues unless
   * {@link AssetManager.failFast} is set.
   *
   * @typeParam T Value type.
   * @param requests Requests, as URLs or {@link AssetRequest} records.
   * @param options Per-batch load options and progress callback.
   * @returns One result per request, in the input order.
   */
  public async loadAll<T = unknown>(
    requests: readonly (string | AssetRequest<T>)[],
    options: LoadOptions & { onBatchProgress?: (progress: BatchProgress) => void } = {},
  ): Promise<AssetResult<T>[]> {
    this.assertUsable();

    const normalized = requests.map((request, index) => normalizeRequest(request, index));
    const results: AssetResult<T>[] = new Array(normalized.length);
    const total = normalized.length;

    let completed = 0;
    let succeeded = 0;
    let failed = 0;

    this.refreshStats();

    const emit = (): void => {
      const ratio =
        total === 0
          ? 1
          : normalized.reduce((sum, _request, index) => {
              const result = results[index];
              if (result !== undefined && result.ok) return sum + 1;
              const key = normalized[index].key;
              return sum + (this.ratios.get(key) ?? 0);
            }, 0) / total;

      const progress: BatchProgress = { completed, total, succeeded, failed, ratio };
      this.events.emit('progress', progress);
      options.onBatchProgress?.(progress);
    };

    emit();

    const tasks = normalized.map(
      (request) => (): Promise<void> =>
        (async () => {
          try {
            const value = await this.load<T>(request.url ?? request.key, {
              ...options,
              key: request.key,
              value: request.value as T | undefined,
              ...(request.loader === undefined ? {} : { loader: request.loader }),
              ...(request.options ?? {}),
            });
            results[request.index] = { key: request.key, ok: true, value };
            succeeded++;
          } catch (error) {
            const resolved = error instanceof Error ? error : new Error(String(error));
            results[request.index] = { key: request.key, ok: false, error: resolved };
            failed++;
            this.stats.failed++;
            this.failures.push(results[request.index]);
            log.warn(`asset "${request.key}" failed`, resolved.message);
            if (this.failFast) throw resolved;
          } finally {
            completed++;
            emit();
          }
        })(),
    );

    // Run through a shared worker pool rather than `Promise.all`, so the concurrency
    // cap applies across the whole batch instead of per item.
    await this.runLimited(tasks, options.signal);

    const summary: BatchProgress = {
      completed,
      total,
      succeeded,
      failed,
      ratio: this.averageRatio(normalized.map((request) => request.key), results),
    };
    this.events.emit('complete', summary);
    this.refreshStats();

    // Fill any hole left by a fail-fast abort so the array stays aligned.
    for (let i = 0; i < results.length; i++) {
      if (results[i] === undefined) {
        results[i] = {
          key: normalized[i].key,
          ok: false,
          error: new Error('asset was not loaded because the batch was aborted'),
        };
      }
    }

    return results;
  }

  /**
   * Loads a named group of assets.
   *
   * @typeParam T Value type.
   * @param group Map from category name to a list of URLs or requests.
   * @param options Per-batch options.
   * @returns Objects keyed by category, plus the failures.
   */
  public async loadGroup<T = unknown>(
    group: AssetGroup,
    options: LoadOptions = {},
  ): Promise<{ values: Record<string, T[]>; errors: AssetResult<T>[]; all: AssetResult<T>[] }> {
    const keys = Object.keys(group);
    const flat: AssetRequest<T>[] = [];

    for (const category of keys) {
      for (const entry of group[category]) {
        const request = normalizeRequest(entry, flat.length);
        flat.push({
          key: request.key,
          url: request.url,
          loader: request.loader,
          value: request.value as T | undefined,
          options: request.options,
        });
      }
    }

    const results = await this.loadAll<T>(flat, options);
    const values: Record<string, T[]> = {};
    const errors: AssetResult<T>[] = [];

    let cursor = 0;
    for (const category of keys) {
      const bucket: T[] = [];
      for (let i = 0; i < group[category].length; i++) {
        const result = results[cursor++];
        if (result.ok && result.value !== undefined) bucket.push(result.value);
        else errors.push(result);
      }
      values[category] = bucket;
    }

    return { values, errors, all: results };
  }

  /* ------------------------------------------------------------------ lookup */

  /**
   * Reads a cached value.
   *
   * @typeParam T Value type.
   * @param key Cache key.
   * @returns The value, or `undefined`.
   */
  public get<T = unknown>(key: string): T | undefined {
    return this.cache.get(key) as T | undefined;
  }

  /**
   * `true` when a key is cached.
   *
   * @param key Cache key.
   * @returns `true` when the key is present.
   */
  public has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Stores a value under a key without loading anything.
   *
   * @typeParam T Value type.
   * @param key Cache key.
   * @param value Value to store.
   * @returns This manager, for chaining.
   */
  public set<T = unknown>(key: string, value: T): this {
    this.cache.set(key, value);
    this.refreshStats();
    return this;
  }

  /**
   * Releases one cached asset, disposing it when it is disposable.
   *
   * @param key Cache key.
   * @returns `true` when an entry was removed.
   */
  public unload(key: string): boolean {
    const value = this.cache.peek(key);
    const removed = this.cache.delete(key);
    if (removed && value !== null && typeof value === 'object') {
      const disposable = value as { dispose?: () => void };
      if (typeof disposable.dispose === 'function') {
        try {
          disposable.dispose();
        } catch (error) {
          log.warn(`disposing "${key}" threw`, error);
        }
      }
    }
    if (removed) this.refreshStats();
    return removed;
  }

  /**
   * Releases every cached asset.
   *
   * @returns The number of assets released.
   */
  public unloadAll(): number {
    const count = this.cache.size;
    for (const key of this.cache.keys()) this.unload(key);
    this.cache.clear();
    this.refreshStats();
    return count;
  }

  /**
   * `true` when a loader can handle a URL.
   *
   * @param url URL to test.
   * @param mimeType Optional MIME type.
   * @returns `true` when the registry resolves the URL.
   */
  public canLoad(url: string, mimeType?: string): boolean {
    return this.fallbackLoader !== null || this.loaders.canLoad(url, mimeType);
  }

  /* ------------------------------------------------------------------ errors */

  /**
   * Failures recorded since the last {@link AssetManager.clearErrors}.
   *
   * @returns A copy of the failure list.
   */
  public getErrors(): AssetResult[] {
    return this.failures.slice();
  }

  /**
   * Clears the recorded failures.
   *
   * @returns This manager, for chaining.
   */
  public clearErrors(): this {
    this.failures.length = 0;
    return this;
  }

  /* --------------------------------------------------------------- scheduling */

  /** Resolves a loader for a URL. */
  private resolveLoader<T>(url: string, name?: string): Loader<T> | null {
    if (name !== undefined) {
      const named = this.loaders.get<T>(name);
      return named ?? null;
    }
    if (this.fallbackLoader !== null) return this.fallbackLoader as Loader<T>;
    return this.loaders.getLoaderFor<T>(url) ?? null;
  }

  /**
   * Runs a list of thunks through the pool.
   *
   * Implemented as an explicit index-based dispatcher rather than a recursive
   * `Promise` chain so that a very large batch does not build a deep chain that keeps
   * every closure alive.
   */
  private async runLimited(tasks: readonly (() => Promise<void>)[], signal?: AbortSignal): Promise<void> {
    if (tasks.length === 0) return;

    let next = 0;

    const workers: Promise<void>[] = [];
    const workerCount = Math.min(this.concurrency, tasks.length);

    const worker = async (): Promise<void> => {
      while (next < tasks.length) {
        if (signal?.aborted === true) return;
        const index = next++;
        const task = tasks[index];
        this.inFlight++;
        this.peak = Math.max(this.peak, this.inFlight);
        this.refreshStats();
        try {
          await task();
        } finally {
          this.inFlight--;
          this.refreshStats();
        }
      }
    };

    for (let i = 0; i < workerCount; i++) workers.push(worker());
    await Promise.all(workers);
  }

  /** Runs one thunk, recording queue bookkeeping. */
  private async runQueued(key: string, run: () => Promise<void>): Promise<void> {
    void key;
    return run();
  }

  /** Starts queued work that now fits under the cap. */
  private pump(): void {
    while (this.queue.length > 0 && this.inFlight < this.concurrency) {
      const entry = this.queue.shift();
      if (entry === undefined) break;
      entry.cancel?.();
      this.inFlight++;
      this.peak = Math.max(this.peak, this.inFlight);
      void entry.run().finally(() => {
        this.inFlight--;
        this.pump();
      });
    }
    this.refreshStats();
  }
  /* ------------------------------------------------------------------ events */

  /**
   * Registers a listener for a batch event.
   *
   * Named `onEvent` rather than `on` so it does not collide with
   * {@link Disposable.on}, which publishes the lifecycle events (`'dispose'`,
   * `'disposed'`). Use `onEvent` for `'item'`, `'progress'`, `'bytes'` and
   * `'complete'`.
   *
   * @param event Event name.
   * @param listener Callback.
   * @returns An unsubscribe function.
   */
  public onEvent<K extends keyof AssetManagerEvents & string>(
    event: K,
    listener: (...args: AssetManagerEvents[K]) => void,
  ): () => void {
    const emitter = this.events as unknown as EventEmitter<AssetManagerEvents>;
    return emitter.on(event, listener as never);
  }

  /* ------------------------------------------------------------------- stats */

  /** Average byte ratio across a batch, counting a finished item as complete. */
  private averageRatio(keys: readonly string[], results: readonly AssetResult[]): number {
    if (keys.length === 0) return 1;
    let total = 0;
    for (let i = 0; i < keys.length; i++) {
      const result = results[i];
      if (result !== undefined && result.ok) {
        total += 1;
        continue;
      }
      total += this.ratios.get(keys[i]) ?? 0;
    }
    return total / keys.length;
  }

  /** Refreshes the derived statistics fields. */
  private refreshStats(): void {
    this.stats.inFlight = this.inFlight;
    this.stats.peakInFlight = this.peak;
    this.stats.queued = this.queue.length;
    this.stats.entries = this.cache.size;
    this.stats.cache = this.cache.stats;
  }

  /**
   * A snapshot of the live statistics.
   *
   * @returns The statistics.
   */
  public getStats(): AssetManagerStats {
    this.refreshStats();
    return { ...this.stats, cache: { ...this.stats.cache } };
  }

  /**
   * Resets the hit/miss/request counters, keeping the cache and queue.
   *
   * @returns This manager, for chaining.
   */
  public resetStats(): this {
    this.stats.requests = 0;
    this.stats.cacheHits = 0;
    this.stats.succeeded = 0;
    this.stats.failed = 0;
    this.stats.peakInFlight = this.inFlight;
    this.cache.resetStats();
    this.refreshStats();
    return this;
  }

  /* ----------------------------------------------------------------- dispose */

  /**
   * Cancels every in-flight and queued request.
   *
   * @returns This manager, for chaining.
   */
  public abort(): this {
    for (const entry of this.queue) entry.cancel?.();
    this.queue.length = 0;
    this.loaders.abortAll();
    this.refreshStats();
    return this;
  }

  /**
   * Releases every loader, every cached asset and every listener.
   */
  protected override onDispose(): void {
    this.abort();
    for (const key of this.cache.keys()) this.unload(key);
    this.cache.clear();
    this.loaders.dispose();
    this.events.emit('dispose');
    this.events.dispose();
    this.failures.length = 0;
    this.ratios.clear();
    this.fallbackLoader = null;
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `AssetManager(loaders=${this.loaders.names().length}, cached=${this.cache.size}, ` +
      `inFlight=${this.inFlight}/${this.concurrency})`
    );
  }
}

/** Normalises a string-or-request entry into a full request record. */
function normalizeRequest<T>(
  request: string | AssetRequest<T>,
  index: number,
): AssetRequest<T> & { index: number } {
  if (typeof request === 'string') {
    return { key: request, url: request, index };
  }

  const key = request.key ?? request.url ?? `asset-${index}`;
  return {
    ...request,
    key,
    url: request.url ?? (request.value === undefined ? key : undefined),
    index,
  };
}

/**
 * Convenience factory mirroring `new AssetManager(options)`.
 *
 * @param options Concurrency, cache and registry configuration.
 * @returns A new asset manager.
 */
export function assetManager(options: AssetManagerOptions = {}): AssetManager {
  return new AssetManager(options);
}

/** Re-exported so a caller can build a default key from a URL. */
export { basename, isAbortError };

/** `true` when a result represents a cancelled load. */
export function isCancelledResult(result: AssetResult): boolean {
  return !result.ok && result.error !== undefined && isAbortError(result.error);
}
