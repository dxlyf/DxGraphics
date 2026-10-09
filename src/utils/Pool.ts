/**
 * Object pooling to avoid per-frame allocation in render loops.
 *
 * @packageDocumentation
 */

import { DEFAULT_POOL_SIZE } from '../constants';

/**
 * A fixed-capacity pool of reusable objects.
 *
 * Objects are created lazily through `factory`; {@link acquire} pops from the
 * free list and {@link release} pushes back (up to `capacity`, beyond which the
 * object is dropped so a runaway leak cannot grow without bound).
 *
 * ```ts
 * const pool = new Pool(() => new Vec3(), { reset: (v) => v.set(0, 0, 0) });
 * const v = pool.acquire();
 * // ... use v ...
 * pool.release(v);
 * ```
 */
export class Pool<T> {
  /** Creates a new instance when the pool is empty. */
  private readonly factory: () => T;

  /** Optional hook invoked on {@link acquire}. */
  private readonly onAcquire: ((item: T) => void) | undefined;

  /** Optional hook invoked on {@link release}. */
  private readonly onRelease: ((item: T) => void) | undefined;

  /** Upper bound on retained objects. */
  public readonly capacity: number;

  /** Currently free objects. */
  private readonly free: T[] = [];

  /** Objects handed out and not yet returned. */
  private readonly inUse = new Set<T>();

  /** Total number of objects the factory has produced. */
  public created = 0;

  /**
   * @param factory Creates a fresh object when the free list is empty.
   * @param options `capacity` (default {@link DEFAULT_POOL_SIZE}), `prewarm`
   *   (number of objects to create eagerly), `onAcquire` and `onRelease` hooks.
   */
  constructor(
    factory: () => T,
    options: {
      capacity?: number;
      prewarm?: number;
      onAcquire?: (item: T) => void;
      onRelease?: (item: T) => void;
    } = {},
  ) {
    this.factory = factory;
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_POOL_SIZE);
    this.onAcquire = options.onAcquire;
    this.onRelease = options.onRelease;

    const prewarm = Math.min(options.prewarm ?? 0, this.capacity);
    for (let i = 0; i < prewarm; i++) {
      this.free.push(this.factory());
      this.created++;
    }
  }

  /** Number of objects currently available for reuse. */
  public get size(): number {
    return this.free.length;
  }

  /** Number of objects currently checked out. */
  public get activeCount(): number {
    return this.inUse.size;
  }

  /** `true` when the free list is empty. */
  public get isEmpty(): boolean {
    return this.free.length === 0;
  }

  /** Takes an object from the pool, creating one when needed. */
  public acquire(): T {
    let item = this.free.pop();
    if (item === undefined) {
      item = this.factory();
      this.created++;
    }
    this.inUse.add(item);
    this.onAcquire?.(item);
    return item;
  }

  /** Returns an object to the pool. Unknown or duplicate items are ignored. */
  public release(item: T): void {
    if (!this.inUse.delete(item)) return;
    this.onRelease?.(item);
    if (this.free.length < this.capacity) this.free.push(item);
  }

  /** Releases every checked-out object (call at the end of a frame). */
  public releaseAll(): void {
    for (const item of Array.from(this.inUse)) this.release(item);
  }

  /** Empties the pool, dropping both free and in-use references. */
  public clear(dispose?: (item: T) => void): void {
    if (dispose) {
      for (const item of this.free) dispose(item);
      for (const item of this.inUse) dispose(item);
    }
    this.free.length = 0;
    this.inUse.clear();
  }

  /** Runs `callback` with a pooled object, releasing it even on throw. */
  public use<R>(callback: (item: T) => R): R {
    const item = this.acquire();
    try {
      return callback(item);
    } finally {
      this.release(item);
    }
  }

  /** Pre-allocates `count` additional objects (clamped to capacity). */
  public prewarm(count: number): void {
    const target = Math.min(count, this.capacity);
    while (this.free.length < target) {
      this.free.push(this.factory());
      this.created++;
    }
  }
}

/**
 * Pool of fixed-length numeric arrays.
 *
 * Used by the geometry generators and the picking system, which need many
 * short-lived vectors per frame.
 */
export class ArrayPool<T extends Float32Array | Float64Array | Uint32Array | Int32Array> {
  private readonly pool: Pool<T>;

  /** Creates a pool of typed arrays of `length` elements. */
  constructor(
    private readonly Type: new (length: number) => T,
    private readonly length: number,
    capacity: number = DEFAULT_POOL_SIZE,
  ) {
    this.pool = new Pool(() => new Type(this.length), { capacity });
  }

  /** Number of arrays available for reuse. */
  public get size(): number {
    return this.pool.size;
  }

  /** Takes an array from the pool and zero-fills it. */
  public acquire(): T {
    const array = this.pool.acquire();
    array.fill(0);
    return array;
  }

  /** Returns an array to the pool. */
  public release(array: T): void {
    this.pool.release(array);
  }

  /** Releases every checked-out array. */
  public releaseAll(): void {
    this.pool.releaseAll();
  }
}

/**
 * A monotonic counter used as a cheap allocation-free ring buffer index.
 *
 * ```ts
 * const cursor = new Cursor(3);
 * cursor.next(); // 0, 1, 2, 0, ...
 * ```
 */
export class Cursor {
  private index = 0;

  /** Creates a cursor cycling through `size` slots. */
  constructor(public readonly size: number) {
    if (size <= 0) throw new RangeError('Cursor size must be greater than zero');
  }

  /** Current slot. */
  public get value(): number {
    return this.index;
  }

  /** Returns the current slot and advances. */
  public next(): number {
    const current = this.index;
    this.index = (this.index + 1) % this.size;
    return current;
  }

  /** Resets the cursor to slot `0`. */
  public reset(): void {
    this.index = 0;
  }
}
