/**
 * Minimal, dependency-free typed event emitter used by the scene graph.
 *
 * ## Why this exists alongside `src/core/EventEmitter`
 *
 * The two are not interchangeable, and the difference is deliberate:
 *
 * | | `core/EventEmitter` | here |
 * | --- | --- | --- |
 * | callback arguments | variadic (`(...args: T[K])`) | one optional payload |
 * | `on()` returns | an unsubscribe function | `this`, so calls chain |
 * | `emit()` returns | `void` | `true` when a listener ran |
 *
 * Scene nodes are configured by chained calls (`node.on('added', h).on('removed', g)`),
 * and their events carry a single payload, so this shape is the better fit for them.
 * The core emitter serves the rest of the library, where variadic events and an
 * unsubscribe handle are what callers expect.
 *
 * Both are typed against the shared `CoreEventMap`, and both snapshot their listener
 * list before dispatch so a listener can safely add or remove listeners while an
 * emit is in flight.
 *
 * @packageDocumentation
 */

/** Anything accepted as an event payload. */
export type EventPayload = object | undefined;

/** A typed event map: event name -> payload type (`undefined` = no payload). */
export type EventMap = Record<string, EventPayload>;

/** The shape every event map must have; `object` keeps interface maps usable. */
export type EventMapShape = object;

/** Listener signature for an event carrying `TPayload`. */
export type Handler<TPayload extends EventPayload = undefined> = undefined extends TPayload
  ? [TPayload] extends [undefined]
    ? () => void
    : (payload?: TPayload) => void
  : (payload: TPayload) => void;

/** Listener type for the event named `K` of `TMap`. */
export type HandlerFor<TMap extends EventMapShape, K extends keyof TMap & string> = undefined extends TMap[K]
  ? [TMap[K]] extends [undefined]
    ? () => void
    : (payload?: TMap[K]) => void
  : (payload: TMap[K]) => void;

/** Internal listener record stored per event name. */
interface ListenerRecord {
  /** Listener invoked on every matching emit. */
  callback: (payload: never) => void;
  /** Optional owner used by {@link TypedEventEmitter.off} filtering. */
  context: unknown;
  /** `true` when the listener removes itself after the first emit. */
  once: boolean;
}

/**
 * Bare-handed typed event emitter.
 *
 * Listeners are stored in insertion order and are copied before dispatch so a
 * listener may safely add or remove listeners while an emit is in flight.
 *
 * `TMap` is deliberately constrained to `object` rather than to
 * {@link EventMap}: an `interface` event map has no index signature, so
 * `Record<string, ...>` would reject it. The payload types are still fully
 * checked through the conditional `HandlerFor` aliases.
 */
export class TypedEventEmitter<TMap extends EventMapShape> {
  /** Listeners keyed by event name; the map is empty for most nodes. */
  private listeners: Map<string, ListenerRecord[]> | null = null;

  /**
   * Registers `callback` for `type`.
   *
   * @returns `this`, so registration chains.
   */
  public on<K extends keyof TMap & string>(
    type: K,
    callback: HandlerFor<TMap, K>,
    context?: unknown,
  ): this {
    const map = (this.listeners ??= new Map<string, ListenerRecord[]>());
    const records = map.get(type);
    const record: ListenerRecord = {
      callback: callback as (payload: never) => void,
      context,
      once: false,
    };
    if (records) records.push(record);
    else map.set(type, [record]);
    return this;
  }

  /** Registers `callback` for `type`, removing it after the first emit. */
  public once<K extends keyof TMap & string>(
    type: K,
    callback: HandlerFor<TMap, K>,
    context?: unknown,
  ): this {
    const map = (this.listeners ??= new Map<string, ListenerRecord[]>());
    const records = map.get(type);
    const record: ListenerRecord = {
      callback: callback as (payload: never) => void,
      context,
      once: true,
    };
    if (records) records.push(record);
    else map.set(type, [record]);
    return this;
  }

  /**
   * Removes a previously registered listener.
   *
   * When `callback` is omitted every listener of `type` is removed; when
   * `context` is omitted the context is not compared.
   */
  public off<K extends keyof TMap & string>(
    type: K,
    callback?: HandlerFor<TMap, K>,
    context?: unknown,
  ): this {
    const map = this.listeners;
    if (!map) return this;
    if (callback === undefined) {
      map.delete(type);
      return this;
    }
    const records = map.get(type);
    if (!records) return this;
    const target = callback as (payload: never) => void;
    const remaining = records.filter(
      (record) =>
        record.callback !== target || (context !== undefined && record.context !== context),
    );
    if (remaining.length === 0) map.delete(type);
    else map.set(type, remaining);
    return this;
  }

  /** `true` when at least one listener is registered for `type`. */
  public hasListener<K extends keyof TMap & string>(type: K): boolean {
    const records = this.listeners?.get(type);
    return records !== undefined && records.length > 0;
  }

  /** Removes every listener, for every event; used by `dispose`. */
  public removeAllListeners(): this {
    this.listeners = null;
    return this;
  }

  /**
   * Dispatches an event to every registered listener.
   *
   * @param payload Argument forwarded to the listeners.
   * @returns `true` when at least one listener ran.
   */
  public emit<K extends keyof TMap & string>(
    type: K,
    ...args: undefined extends TMap[K] ? (TMap[K] extends undefined ? [] : [TMap[K]?]) : [TMap[K]]
  ): boolean {
    const map = this.listeners;
    if (!map) return false;
    const records = map.get(type);
    if (!records || records.length === 0) return false;

    const snapshot = records.slice();
    const payload = args[0] as TMap[K];
    for (let i = 0; i < snapshot.length; i++) {
      const record = snapshot[i];
      if (record.once) this.off(type, record.callback as HandlerFor<TMap, K>, record.context);
      (record.callback as (value: TMap[K]) => void).call(record.context, payload);
    }
    return true;
  }
}
