/**
 * `EventDispatcher` — the mixin that gives every scene object a typed event bus.
 *
 * Two ways to use it:
 *
 * ```ts
 * // 1. As a base class
 * class Mesh extends EventDispatcher<{ dispose: [] }> {}
 *
 * // 2. As a composed member
 * class Renderer {
 *   readonly events = new EventDispatcher<{ resize: [number, number] }>();
 *   get on() { return this.events.on; }
 * }
 * ```
 *
 * The bus itself is an {@link EventEmitter}; this class adds the scene-graph
 * conveniences that every `Node`/`Object3D` needs (`dispatchEvent`, bubbling
 * through parents, and a `disposed` flag).
 *
 * @packageDocumentation
 */

import {
  EventEmitter,
  type EventListener,
  type EventMap,
  type EventArgs,
  type EventName,
  type ListenerOptions,
} from './EventEmitter';

/** An object that can receive an event through bubbling. */
export interface EventTargetLike<TEvents = EventMap> {
  dispatchEvent<K extends EventName<TEvents>>(event: K, ...args: EventArgs<TEvents[K]>): void;
  parent?: EventTargetLike<TEvents> | null;
}

/**
 * A standard event object for bubbling dispatches.
 *
 * `type` is the event name; `target` is the node that emitted it and
 * `currentTarget` changes as the event bubbles.
 */
export interface DispatchEvent<TTarget = unknown> {
  type: string;
  target: TTarget | null;
  currentTarget: TTarget | null;
  /** Set to `true` by a listener to stop further bubbling. */
  propagationStopped: boolean;
  /** Set to `true` by a listener to stop other listeners on the same node. */
  immediatePropagationStopped: boolean;
  /** Stops the event from reaching ancestors. */
  stopPropagation(): void;
  /** Stops the remaining listeners on the current node. */
  stopImmediatePropagation(): void;
}

/** Creates a bubbling event record. */
export function createDispatchEvent<TTarget>(type: string, target: TTarget | null): DispatchEvent<TTarget> {
  const event: DispatchEvent<TTarget> = {
    type,
    target,
    currentTarget: target,
    propagationStopped: false,
    immediatePropagationStopped: false,
    stopPropagation() {
      event.propagationStopped = true;
    },
    stopImmediatePropagation() {
      event.propagationStopped = true;
      event.immediatePropagationStopped = true;
    },
  };
  return event;
}

/**
 * Base class (or member) providing `on`/`off`/`once`/`emit` and bubbling.
 *
 * @typeParam TEvents Event-name to argument-tuple map.
 */
export class EventDispatcher<TEvents = EventMap> {
  /** The backing emitter. Exposed so callers can pass it to `EventEmitter`-only APIs. */
  public readonly events: EventEmitter<TEvents> = new EventEmitter<TEvents>();

  /** Parent used for bubbling; `null` for detached objects. */
  public parent: EventDispatcher<TEvents> | null = null;

  /** `true` while the object is being disposed; guards late async callbacks. */
  protected disposed = false;

  /* ------------------------------------------------------------ registration */

  /** Registers a listener; returns an unsubscribe function. */
  public on<K extends EventName<TEvents>>(
    event: K,
    listener: EventListener<EventArgs<TEvents[K]>>,
    options?: ListenerOptions,
  ): () => void {
    return this.events.on(event, listener, options);
  }

  /** Registers a one-shot listener; returns an unsubscribe function. */
  public once<K extends EventName<TEvents>>(
    event: K,
    listener: EventListener<EventArgs<TEvents[K]>>,
    options?: ListenerOptions,
  ): () => void {
    return this.events.once(event, listener, options);
  }

  /** Registers a high-priority listener; returns an unsubscribe function. */
  public prependListener<K extends EventName<TEvents>>(
    event: K,
    listener: EventListener<EventArgs<TEvents[K]>>,
    priority?: number,
  ): () => void {
    return this.events.prependListener(event, listener, priority);
  }

  /** Removes a listener; returns `true` when it was registered. */
  public off<K extends EventName<TEvents>>(event: K, listener: EventListener<EventArgs<TEvents[K]>>): boolean {
    return this.events.off(event, listener);
  }

  /** `true` when a listener is registered for `event`. */
  public hasListener<K extends EventName<TEvents>>(
    event: K,
    listener?: EventListener<EventArgs<TEvents[K]>>,
  ): boolean {
    return this.events.hasListener(event, listener);
  }

  /** Number of listeners registered for `event`. */
  public listenerCount<K extends EventName<TEvents>>(event: K): number {
    return this.events.listenerCount(event);
  }

  /* ------------------------------------------------------------- dispatch */

  /**
   * Emits `event` locally.
   *
   * @returns `true` when at least one listener ran.
   */
  public emit<K extends EventName<TEvents>>(event: K, ...args: EventArgs<TEvents[K]>): boolean {
    return this.events.emit(event, ...args);
  }

  /** Emits `event` locally without allocating a bubbling event record. */
  public dispatchEventLocal<K extends EventName<TEvents>>(event: K, ...args: EventArgs<TEvents[K]>): boolean {
    return this.events.emit(event, ...args);
  }

  /**
   * Emits `event` on this object and then on every ancestor.
   *
   * A listener can call `event.stopPropagation()` to halt the walk. Bubble-aware
   * listeners are registered with {@link onDispatch}.
   */
  public dispatchEvent<K extends EventName<TEvents>>(
    event: K,
    detail?: Record<string, unknown>,
  ): DispatchEvent<this> {
    const record = createDispatchEvent<this>(event as string, this);
    if (detail) Object.assign(record, detail);

    let node: EventDispatcher<TEvents> | null = this;
    while (node) {
      record.currentTarget = node as unknown as this;
      node.emitBubbled(record as DispatchEvent<unknown>);
      if (record.propagationStopped) break;
      node = node.parent;
    }
    return record;
  }

  /** Emits to bubble-aware listeners registered through {@link onDispatch}. */
  private readonly bubbleListeners = new Map<string, Set<(event: DispatchEvent<unknown>) => void>>();

  /** Invokes the bubble-aware listeners registered on this object. */
  private emitBubbled(record: DispatchEvent<unknown>): void {
    const listeners = this.bubbleListeners.get(record.type);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
      if (record.immediatePropagationStopped) break;
      listener(record);
    }
  }

  /**
   * Registers a bubble-aware listener that receives the full
   * {@link DispatchEvent} record and therefore sees events from descendants.
   */
  public onDispatch(
    type: string,
    listener: (event: DispatchEvent<unknown>) => void,
  ): () => void {
    let listeners = this.bubbleListeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.bubbleListeners.set(type, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners && listeners.size === 0) this.bubbleListeners.delete(type);
    };
  }

  /** Removes every listener (both direct and bubble-aware). */
  public removeAllListeners(event?: EventName<TEvents>): this {
    this.events.removeAllListeners(event as never);
    if (event === undefined) this.bubbleListeners.clear();
    else this.bubbleListeners.delete(event as string);
    return this;
  }

  /* -------------------------------------------------------------- disposal */

  /** `true` once {@link dispose} has run. */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Releases listeners so the object can be collected.
   *
   * Subclasses overriding this **must** call `super.dispose()`.
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeAllListeners();
    this.parent = null;
  }
}

/**
 * Mixin factory that adds {@link EventDispatcher} behaviour to any base class.
 *
 * ```ts
 * class Base {}
 * class Widget extends withEvents(Base, { click: [] as [] }) {}
 * ```
 *
 * Prefer extending `EventDispatcher` directly when possible; the mixin exists for
 * classes that must already extend something else (for example native DOM types).
 */
export function withEvents<TBase extends abstract new (...args: any[]) => object>(
  Base: TBase,
): TBase & (abstract new (...args: any[]) => EventDispatcher) {
  abstract class WithEvents extends (Base as abstract new (...args: any[]) => object) {
    /** The composed dispatcher. */
    public readonly dispatcher = new EventDispatcher();

    /** See {@link EventDispatcher.on}. */
    public on(event: string, listener: EventListener, options?: ListenerOptions): () => void {
      return this.dispatcher.on(event, listener, options);
    }

    /** See {@link EventDispatcher.off}. */
    public off(event: string, listener: EventListener): boolean {
      return this.dispatcher.off(event, listener);
    }

    /** See {@link EventDispatcher.emit}. */
    public emit(event: string, ...args: unknown[]): boolean {
      return this.dispatcher.emit(event, ...args);
    }

    /** See {@link EventDispatcher.once}. */
    public once(event: string, listener: EventListener, options?: ListenerOptions): () => void {
      return this.dispatcher.once(event, listener, options);
    }
  }
  return WithEvents as unknown as TBase & (abstract new (...args: any[]) => EventDispatcher);
}

/** `true` when `value` exposes the dispatcher API. */
export function isEventDispatcher(value: unknown): value is EventDispatcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as EventDispatcher).emit === 'function' &&
    typeof (value as EventDispatcher).on === 'function'
  );
}
