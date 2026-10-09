/**
 * `Cache` — a bounded LRU cache with optional reference counting.
 *
 * Asset caches have three requirements that a plain `Map` does not meet:
 *
 * 1. **Bounded memory.** A long-running editor that streams thousands of textures
 *    must not grow without limit, so the oldest *unreferenced* entry is evicted when
 *    the cache is full.
 * 2. **Reference counting.** Two materials may share one texture; the texture must
 *    survive until *both* release it. {@link Cache.retain}/{@link Cache.release}
 *    model that.
 * 3. **Observability.** Hit rate and byte totals are the numbers that tell you
 *    whether the cache is sized correctly, so they are tracked, not guessed.
 *
 * ```ts
 * const cache = new Cache<TextureLike>({ limit: 64 });
 * const texture = cache.getOrCreate('hero.png', () => load('hero.png'));
 * cache.retain('hero.png');
 * cache.release('hero.png');   // only evicts at zero
 * cache.stats;                 // { entries, hits, misses, evictions, ... }
 * ```
 *
 * ## Eviction
 *
 * Entries are ordered most-recently-used first. Eviction walks from the back,
 * skipping any entry whose reference count is above zero, and stops once the entry
 * count is within the limit. An entry that is only reachable through a retain can be
 * *pinned*: {@link Cache.pinnedCount} reports how many exist, and `set` will exceed
 * the limit rather than throw — a debug overlay can flag that, but silently dropping
 * a pinned resource would be a use-after-free.
 *
 * @packageDocumentation
 */

import { DEFAULT_CACHE_LIMIT } from '../constants';
import type { CacheStats } from './types';

/** Callback invoked when an entry is evicted or deleted. */
export type CacheEvictCallback<T> = (key: string, value: T, reason: 'evicted' | 'deleted' | 'cleared') => void;

/** Construction options for {@link Cache}. */
export interface CacheOptions<T> {
  /** Maximum number of entries; defaults to `DEFAULT_CACHE_LIMIT`. */
  limit?: number;
  /** Maximum total bytes, when values report `byteLength`; `0` disables the cap. */
  byteLimit?: number;
  /** Releases a value when it leaves the cache. */
  onEvict?: CacheEvictCallback<T>;
  /** `true` counts references; defaults to `false`. */
  refCounting?: boolean;
}

/** Internal cache record. */
interface CacheEntry<T> {
  /** Cached value. */
  value: T;
  /** Approximate size in bytes. */
  bytes: number;
  /** Reference count; `0` when reference counting is disabled. */
  refs: number;
  /** Insertion sequence number, used to keep LRU order deterministic. */
  seq: number;
}

/**
 * A bounded least-recently-used cache.
 *
 * @typeParam T Value type.
 */
export class Cache<T = unknown> {
  /** Maximum number of entries. */
  public limit: number;

  /** Maximum total bytes; `0` disables the byte cap. */
  public byteLimit: number;

  /** `true` when {@link Cache.retain}/{@link Cache.release} are meaningful. */
  public readonly refCounting: boolean;

  /** Entries, ordered most-recently-used first. */
  private readonly entries = new Map<string, CacheEntry<T>>();

  /** Monotonic sequence source; keeps LRU order total and deterministic. */
  private sequence = 0;

  /** Running byte total. */
  private bytes = 0;

  /** Hit counter. */
  private hits = 0;

  /** Miss counter. */
  private misses = 0;

  /** Eviction counter. */
  private evictions = 0;

  /** Eviction hook. */
  private readonly onEvict: CacheEvictCallback<T> | undefined;

  /**
   * Creates a cache.
   *
   * @param options Entry limit, byte limit, eviction hook and refcounting flag.
   */
  constructor(options: CacheOptions<T> = {}) {
    this.limit = Math.max(0, Math.floor(options.limit ?? DEFAULT_CACHE_LIMIT));
    this.byteLimit = Math.max(0, options.byteLimit ?? 0);
    this.refCounting = options.refCounting ?? false;
    this.onEvict = options.onEvict;
  }

  /* ---------------------------------------------------------------- reading */

  /**
   * Looks a key up, marking it as most-recently-used.
   *
   * @param key Cache key.
   * @returns The value, or `undefined`.
   */
  public get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.promote(key, entry);
    return entry.value;
  }

  /**
   * Looks a key up **without** changing its LRU position or the hit/miss counters.
   *
   * @param key Cache key.
   * @returns The value, or `undefined`.
   */
  public peek(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  /**
   * Looks a key up and creates it on a miss.
   *
   * @param key Cache key.
   * @param factory Producer invoked on a miss.
   * @returns The cached or newly created value.
   */
  public getOrCreate(key: string, factory: () => T): T {
    const existing = this.peek(key);
    if (existing !== undefined) {
      this.get(key);
      return existing;
    }
    const created = factory();
    this.set(key, created);
    return created;
  }

  /**
   * `true` when a key is present.
   *
   * @param key Cache key.
   * @returns `true` when the key is cached.
   */
  public has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Number of entries.
   *
   * @returns The entry count.
   */
  public get size(): number {
    return this.entries.size;
  }

  /**
   * Total tracked bytes.
   *
   * @returns The byte total.
   */
  public get bytesUsed(): number {
    return this.bytes;
  }

  /* ---------------------------------------------------------------- writing */

  /**
   * Inserts or replaces an entry, evicting from the back when over the limit.
   *
   * @param key Cache key.
   * @param value Value to cache.
   * @param bytes Optional explicit size; defaults to `value.byteLength` when the
   *   value exposes one.
   * @returns This cache, for chaining.
   */
  public set(key: string, value: T, bytes?: number): this {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.bytes -= existing.bytes;
      existing.value = value;
      existing.bytes = this.measure(value, bytes);
      this.bytes += existing.bytes;
      this.promote(key, existing);
    } else {
      const entry: CacheEntry<T> = {
        value,
        bytes: this.measure(value, bytes),
        refs: 0,
        seq: this.sequence++,
      };
      this.entries.set(key, entry);
      this.bytes += entry.bytes;
    }

    this.enforceLimits();
    return this;
  }

  /**
   * Removes an entry.
   *
   * @param key Cache key.
   * @returns `true` when an entry was removed.
   */
  public delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    this.notify(key, entry.value, 'deleted');
    return true;
  }

  /**
   * Removes every entry.
   *
   * @param dispose When `true`, the eviction hook is invoked for each entry with
   *   the reason `'cleared'`.
   * @returns This cache, for chaining.
   */
  public clear(dispose = false): this {
    if (dispose && this.onEvict !== undefined) {
      for (const [key, entry] of this.entries) this.notify(key, entry.value, 'cleared');
    }
    this.entries.clear();
    this.bytes = 0;
    return this;
  }

  /* ------------------------------------------------------------------ keys */

  /**
   * Every cached key.
   *
   * @returns The keys, most-recently-used first.
   */
  public keys(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Every cached value.
   *
   * @returns The values, most-recently-used first.
   */
  public values(): T[] {
    const out: T[] = [];
    for (const entry of this.entries.values()) out.push(entry.value);
    return out;
  }

  /**
   * Every `[key, value]` pair.
   *
   * @returns The entries, most-recently-used first.
   */
  public entriesList(): [string, T][] {
    const out: [string, T][] = [];
    for (const [key, entry] of this.entries) out.push([key, entry.value]);
    return out;
  }

  /* ------------------------------------------------------------- refcounting */

  /**
   * Increments an entry's reference count.
   *
   * @param key Cache key.
   * @param count Amount to add; defaults to `1`.
   * @returns This cache, for chaining.
   */
  public retain(key: string, count = 1): this {
    const entry = this.entries.get(key);
    if (entry === undefined) return this;
    entry.refs = Math.max(0, entry.refs + Math.max(0, Math.floor(count)));
    return this;
  }

  /**
   * Decrements an entry's reference count.
   *
   * When the count reaches zero the entry becomes evictable; it is **not** removed
   * immediately, so a caller that re-retains within the same frame still finds it.
   *
   * @param key Cache key.
   * @param count Amount to drop; defaults to `1`.
   * @returns `true` when the entry existed and dropped to zero references.
   */
  public release(key: string, count = 1): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    entry.refs = Math.max(0, entry.refs - Math.max(0, Math.floor(count)));
    const zero = entry.refs === 0;
    this.enforceLimits();
    return zero;
  }

  /**
   * Reference count of an entry.
   *
   * @param key Cache key.
   * @returns The count, or `0` for a missing entry.
   */
  public refCount(key: string): number {
    return this.entries.get(key)?.refs ?? 0;
  }

  /**
   * Number of entries that cannot currently be evicted.
   *
   * @returns The pinned count.
   */
  public get pinnedCount(): number {
    let pinned = 0;
    for (const entry of this.entries.values()) if (entry.refs > 0) pinned++;
    return pinned;
  }

  /* ----------------------------------------------------------------- limits */

  /**
   * Changes the entry limit and evicts if needed.
   *
   * @param limit New limit.
   * @returns This cache, for chaining.
   */
  public setLimit(limit: number): this {
    this.limit = Math.max(0, Math.floor(limit));
    this.enforceLimits();
    return this;
  }

  /**
   * Changes the byte limit and evicts if needed.
   *
   * @param byteLimit New byte limit; `0` disables the cap.
   * @returns This cache, for chaining.
   */
  public setByteLimit(byteLimit: number): this {
    this.byteLimit = Math.max(0, byteLimit);
    this.enforceLimits();
    return this;
  }

  /**
   * Evicts least-recently-used entries until both limits are satisfied.
   *
   * @param targetEntries Optional entry count to shrink to; defaults to
   *   {@link Cache.limit}.
   * @returns The number of entries evicted.
   */
  public trim(targetEntries?: number): number {
    const target = Math.max(0, Math.floor(targetEntries ?? this.limit));
    let evicted = 0;

    // Iterate the LRU order from the back (least recent) forwards.
    for (const key of Array.from(this.entries.keys()).reverse()) {
      const overEntries = this.entries.size > target;
      const overBytes = this.byteLimit > 0 && this.bytes > this.byteLimit;
      if (!overEntries && !overBytes) break;

      const entry = this.entries.get(key);
      if (entry === undefined) continue;
      if (entry.refs > 0) continue;

      this.entries.delete(key);
      this.bytes -= entry.bytes;
      this.evictions++;
      evicted++;
      this.notify(key, entry.value, 'evicted');
    }

    return evicted;
  }

  /** Applies the configured limits. */
  private enforceLimits(): void {
    this.trim();
  }

  /** Moves an entry to the front of the LRU order. */
  private promote(key: string, entry: CacheEntry<T>): void {
    this.entries.delete(key);
    entry.seq = this.sequence++;
    this.entries.set(key, entry);
  }

  /** Measures a value, preferring an explicit size. */
  private measure(value: T, explicit?: number): number {
    if (explicit !== undefined) return Math.max(0, explicit);
    if (value !== null && typeof value === 'object') {
      const sized = value as { byteLength?: unknown };
      if (typeof sized.byteLength === 'number') return sized.byteLength;
    }
    return 0;
  }

  /** Invokes the eviction hook, swallowing its errors. */
  private notify(key: string, value: T, reason: 'evicted' | 'deleted' | 'cleared'): void {
    if (this.onEvict === undefined) return;
    try {
      this.onEvict(key, value, reason);
    } catch {
      /* an eviction hook must never break the cache */
    }
  }

  /* ------------------------------------------------------------------ stats */

  /**
   * Cache bookkeeping numbers.
   *
   * @returns A snapshot; the counters are not reset.
   */
  public get stats(): CacheStats {
    const lookups = this.hits + this.misses;
    return {
      entries: this.entries.size,
      limit: this.limit,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      bytes: this.bytes,
      hitRate: lookups > 0 ? this.hits / lookups : 0,
    };
  }

  /**
   * Resets the hit/miss/eviction counters, keeping the entries.
   *
   * @returns This cache, for chaining.
   */
  public resetStats(): this {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    return this;
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return (
      `Cache(entries=${this.entries.size}/${this.limit}, bytes=${this.bytes}` +
      `${this.byteLimit > 0 ? `/${this.byteLimit}` : ''}, hitRate=${this.stats.hitRate.toFixed(2)})`
    );
  }
}

/**
 * Convenience factory mirroring `new Cache<T>(options)`.
 *
 * @typeParam T Value type.
 * @param options Entry limit, byte limit, eviction hook and refcounting flag.
 * @returns A new cache.
 */
export function cache<T = unknown>(options: CacheOptions<T> = {}): Cache<T> {
  return new Cache<T>(options);
}
