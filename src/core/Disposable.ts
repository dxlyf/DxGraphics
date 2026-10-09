/**
 * Lifetime management for GPU/CPU resources.
 *
 * `Disposable` centralises the four things that go wrong with manual resource
 * management:
 *  1. double disposal,
 *  2. use-after-dispose,
 *  3. resources created *after* disposal (async loads finishing late),
 *  4. leaks because a child was never released by its parent.
 *
 * ```ts
 * class Buffer extends Disposable {
 *   protected onDispose(): void { gl.deleteBuffer(this.handle); }
 * }
 * const buffer = new Buffer();
 * buffer.addDisposable(childTexture);
 * buffer.assertUsable();      // throws if already disposed
 * buffer.dispose();           // disposes the child too
 * ```
 *
 * @packageDocumentation
 */

import { createId } from '../utils/Id';
import { log } from '../utils/Logger';
import { EventEmitter } from './EventEmitter';

/** The minimal contract: something that can be released. */
export interface IDisposable {
  /** `true` once the object has been released. */
  readonly isDisposed: boolean;
  /** Releases the object. Calling it twice is a no-op. */
  dispose(): void;
}

/** An error thrown when a disposed resource is used. */
export class DisposedError extends Error {
  /** Identifier of the disposed object, when it had one. */
  public readonly objectId: string | undefined;

  /** Creates the error for `label`. */
  constructor(label: string, objectId?: string) {
    super(`${label} has been disposed and can no longer be used`);
    this.name = 'DisposedError';
    this.objectId = objectId;
  }
}

/** Events emitted by {@link Disposable}. */
export interface DisposableEvents {
  dispose: [];
  disposed: [];
}

/**
 * Base class tracking a disposal lifecycle and owning child resources.
 *
 * @typeParam TLabel A string literal describing the kind of resource, used in
 *   error messages such as `"Buffer has been disposed"`.
 */
export abstract class Disposable<TLabel extends string = string> implements IDisposable {
  /** Unique identifier, useful for logging and debug overlays. */
  public readonly id: string = createId('res');

  /** Human-readable label used in diagnostics. */
  public abstract readonly label: TLabel;

  /** `true` once {@link dispose} has completed. */
  private disposed = false;

  /** `true` while {@link dispose} is running (guards re-entrancy). */
  private disposing = false;

  /** Child resources released together with this one. */
  private readonly disposables = new Set<IDisposable>();

  /** Callbacks invoked exactly once, during disposal. */
  private readonly disposeCallbacks = new Set<() => void>();

  /** Lifecycle event bus; emits `dispose` then `disposed`. */
  public readonly events = new EventEmitter<DisposableEvents>();

  /* -------------------------------------------------------------- queries */

  /**
   * Registers a lifecycle listener; returns an unsubscribe function.
   *
   * @param event Event name (`'dispose'` or `'disposed'`).
   * @param listener Listener for that event.
   * @returns An unsubscribe function.
   */
  public on<K extends keyof DisposableEvents & string>(
    event: K,
    listener: (...args: DisposableEvents[K]) => void,
  ): () => void {
    return this.events.on(event, listener);
  }

  /** `true` once {@link dispose} has completed. */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /** `true` while {@link dispose} is running. */
  public get isDisposing(): boolean {
    return this.disposing;
  }

  /** `true` while the object is still usable (not disposed, not disposing). */
  public get isUsable(): boolean {
    return !this.disposed && !this.disposing;
  }

  /** Number of child disposables currently owned. */
  public get disposableCount(): number {
    return this.disposables.size;
  }

  /**
   * Throws {@link DisposedError} when the object has been disposed.
   *
   * Call this at the top of every method that touches a released resource so
   * bugs surface as an explicit error instead of a silent no-op.
   */
  public assertUsable(): void {
    if (this.disposed) throw new DisposedError(this.label, this.id);
  }

  /* ------------------------------------------------------------ ownership */

  /**
   * Registers a child resource.
   *
   * If `this` is already disposed the child is disposed immediately, which is
   * what callers want when an async load resolves after teardown.
   *
   * @returns The child, so calls can be chained.
   */
  public addDisposable<T extends IDisposable>(child: T): T {
    if (!child) return child;
    if (this.disposed) {
      child.dispose();
      return child;
    }
    this.disposables.add(child);
    return child;
  }

  /** Convenience wrapper over `addDisposable` for several children. */
  public addDisposables(...children: IDisposable[]): this {
    for (const child of children) this.addDisposable(child);
    return this;
  }

  /** Stops owning `child` without disposing it. */
  public removeDisposable(child: IDisposable): boolean {
    return this.disposables.delete(child);
  }

  /**
   * Registers a callback to run during disposal.
   *
   * Named `addDisposeCallback` (not `onDispose`) because `onDispose` is the
   * protected subclass hook. Use this for quick teardown that does not deserve a
   * subclass.
   */
  public addDisposeCallback(callback: () => void): () => void {
    if (this.disposed) {
      callback();
      return () => undefined;
    }
    this.disposeCallbacks.add(callback);
    return () => this.disposeCallbacks.delete(callback);
  }

  /* ------------------------------------------------------------- disposal */

  /**
   * Releases the resource.
   *
   * Order of operations: mark disposing → `onDispose()` → children →
   * callbacks → mark disposed. Idempotent and re-entrancy safe.
   */
  public dispose(): void {
    if (this.disposed || this.disposing) return;
    this.disposing = true;
    this.events.emit('dispose');

    try {
      this.onDispose();
    } catch (error) {
      log.error(`Error while disposing ${this.label} (${this.id})`, error);
    }

    // Children are disposed in registration order; a child that throws must not
    // prevent the remaining children from being released.
    for (const child of Array.from(this.disposables)) {
      try {
        child.dispose();
      } catch (error) {
        log.error(`Error while disposing a child of ${this.label} (${this.id})`, error);
      }
    }
    this.disposables.clear();

    for (const callback of Array.from(this.disposeCallbacks)) {
      try {
        callback();
      } catch (error) {
        log.error(`Error in a dispose callback of ${this.label} (${this.id})`, error);
      }
    }
    this.disposeCallbacks.clear();

    this.disposing = false;
    this.disposed = true;
    this.events.emit('disposed');
    this.events.dispose();
  }

  /** Releases the object and returns the given value, for use in `finally`. */
  public disposeWith<T>(value: T): T {
    this.dispose();
    return value;
  }

  /**
   * Subclass hook invoked exactly once, before children are released.
   *
   * Native handles (GL buffers, DOM nodes, workers) should be released here.
   */
  protected abstract onDispose(): void;
}

/**
 * Reference-counted wrapper around a disposable resource.
 *
 * Every {@link retain} must be balanced by a {@link release}; the wrapped object
 * is disposed when the count reaches zero. This is what the texture/material
 * caches use to share GPU resources between objects.
 */
export class DisposableRef<T extends IDisposable> implements IDisposable {
  /** Number of outstanding retains. */
  private count: number;

  /** `true` once the wrapped resource has been released for good. */
  private released = false;

  /**
   * @param target The shared resource.
   * @param label Optional label used in diagnostics.
   */
  constructor(
    public readonly target: T,
    public readonly label: string = 'DisposableRef',
  ) {
    this.count = 1;
  }

  /** Current reference count. */
  public get refCount(): number {
    return this.count;
  }

  /** `true` once the wrapped resource has been disposed. */
  public get isDisposed(): boolean {
    return this.released;
  }

  /** Adds a reference. Returns `this` so calls chain. */
  public retain(): this {
    if (this.released) {
      throw new DisposedError(this.label);
    }
    this.count++;
    return this;
  }

  /** Drops a reference, disposing the target when it reaches zero. */
  public release(): void {
    if (this.released) return;
    this.count--;
    if (this.count <= 0) this.dispose();
  }

  /** Drops every outstanding reference immediately. */
  public dispose(): void {
    if (this.released) return;
    this.released = true;
    this.count = 0;
    this.target.dispose();
  }
}

/** `true` when `value` implements the {@link IDisposable} contract. */
export function isDisposable(value: unknown): value is IDisposable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as IDisposable).dispose === 'function' &&
    typeof (value as IDisposable).isDisposed === 'boolean'
  );
}

/**
 * Disposes every entry of an iterable, ignoring individual failures.
 *
 * @returns The number of entries that were disposed without throwing.
 */
export function disposeAll(resources: Iterable<IDisposable> | null | undefined): number {
  if (!resources) return 0;
  let disposed = 0;
  for (const resource of resources) {
    try {
      resource.dispose();
      disposed++;
    } catch (error) {
      log.error('disposeAll: a resource failed to dispose', error);
    }
  }
  return disposed;
}

/**
 * Ties a resource's lifetime to an `AbortSignal`.
 *
 * Useful when an async load should be cancelled because the owning scene went
 * away before the request completed.
 */
export function disposeOnAbort<T extends IDisposable>(resource: T, signal: AbortSignal): T {
  if (signal.aborted) {
    resource.dispose();
    return resource;
  }
  signal.addEventListener('abort', () => resource.dispose(), { once: true });
  return resource;
}

/**
 * Callback-style disposal without a subclass.
 *
 * ```ts
 * const handle = createDisposable('glBuffer', () => gl.deleteBuffer(buffer));
 * ```
 */
export function createDisposable(label: string, callback: () => void): IDisposable {
  let disposed = false;
  const handle: IDisposable & { toString(): string } = {
    get isDisposed(): boolean {
      return disposed;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      callback();
    },
    toString(): string {
      return `${label}${disposed ? ' (disposed)' : ''}`;
    },
  };
  return handle;
}
