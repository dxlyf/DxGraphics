/**
 * `EventEmitter` — a small, typed, allocation-conscious event bus.
 *
 * Public API:
 * ```ts
 * type Events = { resize: [width: number, height: number]; ready: [] };
 * const emitter = new EventEmitter<Events>();
 * const off = emitter.on('resize', (w, h) => console.log(w, h));
 * emitter.emit('resize', 800, 600);
 * off();
 * ```
 *
 * Design notes:
 *  - listeners are stored in insertion order and deduplicated by identity;
 *  - `once` listeners are wrapped but the wrapper keeps a `listener` back-pointer
 *    so `off(listener)` still removes them;
 *  - emitting while listeners are added/removed is safe: the iteration runs over
 *    a snapshot only when the list actually mutates during dispatch.
 *
 * @packageDocumentation
 */

import { log } from '../utils/Logger';

/** Event names of `T` that are usable as string keys. */
export type EventName<T> = Extract<keyof T, string>;

/**
 * The argument tuple of `T`, or `any[]` when `T` is not an array type.
 *
 * Needed because `TEvents` carries no constraint (see `EventMap`), so
 * `TEvents[K]` is an unresolved indexed access: TypeScript cannot prove it is an
 * array, which would make it illegal to use as a rest parameter. Resolving it
 * through this conditional keeps `emit(name, ...args)` fully type-checked while
 * keeping the generic open. For every concrete map in this library `T` is a
 * tuple such as `[width: number, height: number]`, so `EventArgs<T>` is it.
 */
export type EventArgs<T> = T extends unknown[] ? T : any[];

/** A listener function for the argument tuple `A`. */
export type EventListener<A extends unknown[] = unknown[]> = (...args: A) => void;

/**
 * Maps event names to their listener argument tuples.
 *
 * The index signature is intentionally `any[]` rather than `unknown[]`: a map
 * whose values are concrete tuples (`{ resize: [w: number, h: number] }`) is not
 * assignable to `Record<string, unknown[]>` because function parameter types are
 * compared contravariantly. Every concrete map in this library is declared as an
 * `interface X { name: [args] }`, which *is* assignable to this index signature,
 * so `TEvents[K]` resolves to `any[]` and stays usable as a rest parameter while
 * `emit`/`on` keep per-event argument checking.
 */
export type EventMap = { [event: string]: any[] };

/** Options accepted by {@link EventEmitter.on}. */
export interface ListenerOptions {
  /** Remove the listener after the first call. */
  once?: boolean;
  /** Listeners with a lower priority run first. Defaults to `0`. */
  priority?: number;
  /** `this` value used when invoking the listener. */
  context?: unknown;
}

/** Internal listener record. */
interface ListenerRecord {
  listener: EventListener;
  original: EventListener;
  once: boolean;
  priority: number;
  context: unknown;
  order: number;
}

/** A minimal error record handed to {@link EventEmitter.onError}. */
export interface EventEmitterError {
  event: string;
  error: unknown;
  listener: EventListener;
}

/**
 * A typed event emitter.
 *
 * @typeParam TEvents Maps each event name to its listener argument tuple, e.g.
 *   `{ change: [value: number]; dispose: [] }`.
 *
 * `TEvents` is deliberately **not** constrained to {@link EventMap}. A concrete
 * `interface` has no index signature, so `interface Foo { a: [number] }` does not
 * satisfy `{ [event: string]: any[] }` even though it is structurally compatible
 * for every key it declares. Constraining it would force every caller to add an
 * index signature. Leaving it open costs nothing: `emit`/`on` still validate both
 * the event name and its argument tuple through `EventName<TEvents>` and
 * `TEvents[K]`.
 */
export class EventEmitter<TEvents = EventMap> {
  /** Registered listeners, keyed by event name. */
  private readonly listeners = new Map<string, ListenerRecord[]>();

  /** Monotonic counter used to keep insertion order stable across priorities. */
  private order = 0;

  /** Optional handler invoked when a listener throws. */
  private errorHandler: ((error: EventEmitterError) => void) | null = null;

  /** Counts {@link emit} calls per event name; used by diagnostics only. */
  private readonly emitCounts = new Map<string, number>();

  /* ------------------------------------------------------------ registration */

  /**
   * Registers a listener.
   *
   * @returns An unsubscribe function.
   */
  public on<K extends EventName<TEvents>>(
    event: K,
    listener: EventListener<EventArgs<TEvents[K]>>,
    options: ListenerOptions = {},
  ): () => void {
    return this.addListener(event, listener, options);
  }

  /** Registers a listener that removes itself after the first call. */
  public once<K extends EventName<TEvents>>(
    event: K,
    listener: EventListener<EventArgs<TEvents[K]>>,
    options: ListenerOptions = {},
  ): () => void {
    return this.addListener(event, listener, { ...options, once: true });
  }

  /**
   * Registers a listener that runs before the others.
   *
   * @param priority Higher values run first; defaults to `1`.
   */
  public prependListener<K extends EventName<TEvents>>(
    event: K,
    listener: EventListener<EventArgs<TEvents[K]>>,
    priority: number = 1,
  ): () => void {
    return this.addListener(event, listener, { priority });
  }

  /** Registers a listener or removes it when it is already registered (toggle). */
  public toggleListener<K extends EventName<TEvents>>(
    event: K,
    listener: EventListener<EventArgs<TEvents[K]>>,
  ): boolean {
    if (this.hasListener(event, listener)) {
      this.off(event, listener);
      return false;
    }
    this.on(event, listener);
    return true;
  }

  /** Shared implementation behind `on`, `once` and `prependListener`. */
  private addListener<K extends EventName<TEvents>>(
    event: K,
    listener: EventListener<EventArgs<TEvents[K]>>,
    options: ListenerOptions,
  ): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError(`EventEmitter.on("${event}") expects a function`);
    }

    let records = this.listeners.get(event);
    if (!records) {
      records = [];
      this.listeners.set(event, records);
    }

    // Deduplicate by identity so the same handler cannot be attached twice.
    for (const record of records) {
      if (record.original === listener && record.once === (options.once ?? false)) {
        return () => this.off(event, listener);
      }
    }

    const record: ListenerRecord = {
      listener: listener as EventListener,
      original: listener as EventListener,
      once: options.once ?? false,
      priority: options.priority ?? 0,
      context: options.context,
      order: this.order++,
    };

    if (record.once) {
      // Keep a back-pointer so `off(originalListener)` can still remove it.
      const wrapper: EventListener = (...args: unknown[]) => {
        this.off(event, listener);
        (listener as EventListener)(...args);
      };
      (wrapper as unknown as { listener?: EventListener }).listener = listener as EventListener;
      record.listener = wrapper;
    }

    records.push(record);
    if (records.length > 1) this.sortListeners(records);

    return () => this.off(event, listener);
  }

  /** Keeps listeners ordered by descending priority, then insertion order. */
  private sortListeners(records: ListenerRecord[]): void {
    records.sort((a, b) => (b.priority === a.priority ? a.order - b.order : b.priority - a.priority));
  }

  /* -------------------------------------------------------------- removal */

  /**
   * Removes a listener.
   *
   * @returns `true` when a listener was actually removed.
   */
  public off<K extends EventName<TEvents>>(event: K, listener: EventListener<EventArgs<TEvents[K]>>): boolean {
    const records = this.listeners.get(event);
    if (!records) return false;

    const index = records.findIndex(
      (record) => record.original === listener || record.listener === listener,
    );
    if (index < 0) return false;

    records.splice(index, 1);
    if (records.length === 0) this.listeners.delete(event);
    return true;
  }

  /** Removes every listener for `event`, or every listener at all when omitted. */
  public removeAllListeners<K extends EventName<TEvents>>(event?: K): this {
    if (event === undefined) {
      this.listeners.clear();
      this.emitCounts.clear();
    } else {
      this.listeners.delete(event);
    }
    return this;
  }

  /** Alias of `removeAllListeners` matching the DOM `EventTarget` naming. */
  public removeAll(event?: EventName<TEvents>): this {
    return this.removeAllListeners(event as never);
  }

  /* ------------------------------------------------------------- dispatch */

  /**
   * Invokes every listener registered for `event`, in priority order.
   *
   * A throwing listener never prevents the others from running: the error is
   * routed to {@link onError} when set, and logged otherwise.
   *
   * @returns `true` when at least one listener ran.
   */
  public emit<K extends EventName<TEvents>>(event: K, ...args: EventArgs<TEvents[K]>): boolean {
    const records = this.listeners.get(event);
    if (!records || records.length === 0) return false;

    this.emitCounts.set(event as string, (this.emitCounts.get(event as string) ?? 0) + 1);

    // Snapshot only when there is a real risk of mutation during dispatch, which
    // is exactly when a once-listener is present or more than one listener exists.
    const snapshot = records.length > 1 || records[0].once ? records.slice() : records;

    for (const record of snapshot) {
      // The record may have been removed by an earlier listener.
      if (!this.hasRecord(event, record)) continue;
      try {
        record.listener.apply(record.context, args as unknown[]);
      } catch (error) {
        this.handleError({ event: event as string, error, listener: record.original });
      }
    }
    return true;
  }

  /** `true` when `record` is still registered for `event`. */
  private hasRecord(event: EventName<TEvents>, record: ListenerRecord): boolean {
    const records = this.listeners.get(event);
    return records !== undefined && records.includes(record);
  }

  /** Dispatches asynchronously on the microtask queue. */
  public emitAsync<K extends EventName<TEvents>>(event: K, ...args: EventArgs<TEvents[K]>): Promise<boolean> {
    return Promise.resolve().then(() => this.emit(event, ...args));
  }

  /** Routes a listener error to the registered handler or the logger. */
  private handleError(error: EventEmitterError): void {
    if (this.errorHandler) {
      try {
        this.errorHandler(error);
        return;
      } catch {
        /* fall through to logging */
      }
    }
    log.error(`Unhandled listener error for "${error.event}"`, error.error);
  }

  /** Installs a handler that receives listener errors instead of the logger. */
  public onError(handler: ((error: EventEmitterError) => void) | null): this {
    this.errorHandler = handler;
    return this;
  }

  /* -------------------------------------------------------------- queries */

  /** `true` when at least one listener is registered for `event`. */
  public hasListener<K extends EventName<TEvents>>(event: K, listener?: EventListener<EventArgs<TEvents[K]>>): boolean {
    const records = this.listeners.get(event);
    if (!records || records.length === 0) return false;
    if (!listener) return true;
    return records.some((record) => record.original === listener || record.listener === listener);
  }

  /** Number of listeners registered for `event`. */
  public listenerCount<K extends EventName<TEvents>>(event: K): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  /** Total number of listeners across every event. */
  public get totalListenerCount(): number {
    let total = 0;
    for (const records of this.listeners.values()) total += records.length;
    return total;
  }

  /** Every event name that currently has listeners. */
  public eventNames(): string[] {
    return Array.from(this.listeners.keys());
  }

  /** Number of times {@link emit} was called for `event`. */
  public getEmitCount<K extends EventName<TEvents>>(event: K): number {
    return this.emitCounts.get(event as string) ?? 0;
  }

  /** Every listener registered for `event`, in dispatch order (a copy). */
  public getListeners<K extends EventName<TEvents>>(event: K): EventListener<EventArgs<TEvents[K]>>[] {
    const records = this.listeners.get(event);
    if (!records) return [];
    return records.map((record) => record.original as EventListener<EventArgs<TEvents[K]>>);
  }

  /**
   * Waits for a single emission of `event`.
   *
   * @param timeout Optional milliseconds before the promise rejects.
   * @returns The event's argument tuple, e.g. `[width, height]`.
   */
  public waitFor<K extends EventName<TEvents>>(
    event: K,
    timeout?: number,
  ): Promise<EventArgs<TEvents[K]>> {
    type TResult = EventArgs<TEvents[K]>;
    return new Promise<TResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = this.once(event, ((...args: unknown[]) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(args as unknown as TResult);
      }) as EventListener<EventArgs<TEvents[K]>>);

      if (timeout !== undefined) {
        timer = setTimeout(() => {
          off();
          reject(new Error(`Timed out after ${timeout}ms waiting for "${String(event)}"`));
        }, timeout);
      }
    });
  }

  /** Removes every listener and resets the emitter to its initial state. */
  public dispose(): void {
    this.listeners.clear();
    this.emitCounts.clear();
    this.errorHandler = null;
    this.order = 0;
  }
}

/**
 * Creates a standalone `EventEmitter`.
 *
 * @typeParam TEvents Event-name to argument-tuple map.
 */
export function createEventEmitter<TEvents = EventMap>(): EventEmitter<TEvents> {
  return new EventEmitter<TEvents>();
}
