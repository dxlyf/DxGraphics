/**
 * `ShaderCache` — a bounded, per-backend LRU of compiled program handles.
 *
 * The cache is keyed by `shaderKey(source)` (see `StringUtils.shaderKey`), which
 * strips comments and insignificant whitespace, so a program is reused whenever
 * the *effective* source matches.
 *
 * Namespacing: every entry is stored under `"<backend>\u0000<key>"`. A WebGL
 * program and a WebGPU pipeline for the same source are therefore independent
 * entries, while the eviction order is shared across backends so a single limit
 * bounds total GPU memory.
 *
 * Eviction: `Map` preserves insertion order, and every hit re-inserts its entry,
 * so iteration order *is* least-recently-used order. When the size exceeds the
 * limit the oldest entries are dropped until it fits.
 *
 * @packageDocumentation
 */

import { DEFAULT_CACHE_LIMIT } from '../constants';
import { shaderKey } from '../utils/StringUtils';

/** Counters reported by {@link ShaderCache.stats}. */
export interface ShaderCacheStats {
  /** Entries currently stored. */
  size: number;
  /** Maximum number of entries; `0` means unbounded. */
  limit: number;
  /** Lookups that found an entry. */
  hits: number;
  /** Lookups that found nothing. */
  misses: number;
  /** Entries dropped to respect the limit. */
  evictions: number;
  /** Entry count per backend namespace. */
  backends: Record<string, number>;
}

/** One cached value plus its metadata. */
export interface ShaderCacheEntry<T> {
  /** Cache key, without the backend prefix. */
  key: string;
  /** Backend namespace. */
  backend: string;
  /** Cached value. */
  value: T;
  /** Insertion/access sequence number, for diagnostics. */
  sequence: number;
}

/** Separator between the backend namespace and the key. */
const NAMESPACE_SEPARATOR = '\u0000';

/**
 * A bounded LRU cache.
 *
 * @typeParam T Value type; program handles in the compiler's case.
 */
export class ShaderCache<T = unknown> {
  /** Entries in least-recently-used order. */
  private readonly entries = new Map<string, ShaderCacheEntry<T>>();

  /** Maximum number of entries; `0` disables eviction. */
  private limit: number;

  /** Monotonic access counter. */
  private sequence = 0;

  /** Lookup counters. */
  private hits = 0;

  /** Miss counters. */
  private misses = 0;

  /** Eviction counter. */
  private evictions = 0;

  /**
   * @param limit Maximum number of entries; `0` means unbounded.
   */
  constructor(limit: number = DEFAULT_CACHE_LIMIT) {
    this.limit = Math.max(0, Math.floor(limit));
  }

  /* ---------------------------------------------------------------- keys */

  /**
   * Canonical cache key for a source: comments and padding removed.
   *
   * @param source Shader source text.
   */
  public static keyFor(source: string): string {
    return shaderKey(source);
  }

  /** Composes the internal key for a backend namespace. */
  private static scoped(backend: string, key: string): string {
    return `${backend}${NAMESPACE_SEPARATOR}${key}`;
  }

  /* -------------------------------------------------------------- queries */

  /** Number of stored entries. */
  public get size(): number {
    return this.entries.size;
  }

  /** Current limit; `0` means unbounded. */
  public getLimit(): number {
    return this.limit;
  }

  /**
   * Reads an entry and marks it as most recently used.
   *
   * @param key Cache key.
   * @param backend Backend namespace; defaults to `'default'`.
   * @returns The cached value, or `undefined` when absent.
   */
  public get(key: string, backend: string = 'default'): T | undefined {
    const scoped = ShaderCache.scoped(backend, key);
    const entry = this.entries.get(scoped);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    // Re-insert to move the entry to the most-recently-used end.
    this.entries.delete(scoped);
    entry.sequence = this.sequence++;
    this.entries.set(scoped, entry);
    return entry.value;
  }

  /**
   * Reads a full entry, including its metadata, and refreshes its recency.
   *
   * @param key Cache key.
   * @param backend Backend namespace.
   */
  public getEntry(key: string, backend: string = 'default'): ShaderCacheEntry<T> | undefined {
    const scoped = ShaderCache.scoped(backend, key);
    const entry = this.entries.get(scoped);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.entries.delete(scoped);
    entry.sequence = this.sequence++;
    this.entries.set(scoped, entry);
    return entry;
  }

  /**
   * Reads an entry without touching recency or the hit/miss counters.
   *
   * Used by `ShaderCompiler.invalidate()`/`releaseAll()`, which must not make an
   * entry look hot just because it is about to be released.
   *
   * @param key Cache key.
   * @param backend Backend namespace.
   */
  public peek(key: string, backend: string = 'default'): T | undefined {
    return this.entries.get(ShaderCache.scoped(backend, key))?.value;
  }

  /**
   * Stores a value.
   *
   * @param key Cache key.
   * @param value Value to store.
   * @param backend Backend namespace; defaults to `'default'`.
   * @returns This cache, for chaining.
   */
  public set(key: string, value: T, backend: string = 'default'): this {
    const scoped = ShaderCache.scoped(backend, key);
    const existing = this.entries.get(scoped);
    if (existing) this.entries.delete(scoped);
    this.entries.set(scoped, { key, backend, value, sequence: this.sequence++ });
    this.evict();
    return this;
  }

  /** `true` when an entry exists. Does not affect recency or statistics. */
  public has(key: string, backend?: string): boolean {
    if (backend === undefined) {
      for (const entry of this.entries.values()) {
        if (entry.key === key) return true;
      }
      return false;
    }
    return this.entries.has(ShaderCache.scoped(backend, key));
  }

  /**
   * Removes one entry.
   *
   * @returns `true` when an entry was removed.
   */
  public delete(key: string, backend: string = 'default'): boolean {
    return this.entries.delete(ShaderCache.scoped(backend, key));
  }

  /**
   * Marks an entry as most recently used without reading its value.
   *
   * @returns `true` when the entry exists.
   */
  public touch(key: string, backend: string = 'default'): boolean {
    const scoped = ShaderCache.scoped(backend, key);
    const entry = this.entries.get(scoped);
    if (!entry) return false;
    this.entries.delete(scoped);
    entry.sequence = this.sequence++;
    this.entries.set(scoped, entry);
    return true;
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Updates the entry limit, evicting the least-recently-used entries when the
   * cache is already larger.
   *
   * @param limit New limit; `0` means unbounded.
   * @returns This cache, for chaining.
   */
  public setLimit(limit: number): this {
    this.limit = Math.max(0, Math.floor(limit));
    this.evict();
    return this;
  }

  /**
   * Empties the cache.
   *
   * @param backend When given, only that namespace is cleared.
   * @returns The number of entries removed.
   */
  public clear(backend?: string): number {
    if (backend === undefined) {
      const removed = this.entries.size;
      this.entries.clear();
      return removed;
    }
    let removed = 0;
    for (const [scoped, entry] of Array.from(this.entries)) {
      if (entry.backend === backend) {
        this.entries.delete(scoped);
        removed++;
      }
    }
    return removed;
  }

  /** Every key in least-recently-used order, optionally for one backend. */
  public keys(backend?: string): string[] {
    const out: string[] = [];
    for (const entry of this.entries.values()) {
      if (backend === undefined || entry.backend === backend) out.push(entry.key);
    }
    return out;
  }

  /** Every backend namespace currently holding at least one entry. */
  public backends(): string[] {
    const out = new Set<string>();
    for (const entry of this.entries.values()) out.add(entry.backend);
    return Array.from(out);
  }

  /** Current counters. */
  public stats(): ShaderCacheStats {
    const backends: Record<string, number> = {};
    for (const entry of this.entries.values()) {
      backends[entry.backend] = (backends[entry.backend] ?? 0) + 1;
    }
    return {
      size: this.entries.size,
      limit: this.limit,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      backends,
    };
  }

  /** Resets the hit/miss/eviction counters. */
  public resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /** Drops least-recently-used entries until the size fits the limit. */
  private evict(): void {
    if (this.limit <= 0) return;
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const entry = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      this.evictions++;
      if (entry) this.onEvict?.(entry);
    }
  }

  /** Optional hook invoked for every evicted entry; set by `ShaderCompiler`. */
  public onEvict: ((entry: ShaderCacheEntry<T>) => void) | null = null;
}
