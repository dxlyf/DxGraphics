/**
 * Explicit state machine for objects that are initialised asynchronously.
 *
 * ```ts
 * const lifecycle = new Lifecycle({ label: 'WebGLRenderer' });
 * await lifecycle.initialize(async () => { await acquireDevice(); });
 * lifecycle.assertState('initialized');
 * lifecycle.setError(new Error('context lost'));
 * ```
 *
 * Legal transitions:
 * ```text
 *   created ──initialize()──► initializing ──► initialized ──dispose()──► disposed
 *      │                            │                                        ▲
 *      │                            └────────error                           │
 *      └───────────────────────────────dispose()────────────────────────────►┘
 * ```
 *
 * @packageDocumentation
 */

import { EventEmitter } from './EventEmitter';

/** The five states an asynchronous resource can be in. */
export enum LifecycleState {
  /** Constructed but not yet initialised. */
  Created = 'created',
  /** Initialisation started and is in flight. */
  Initializing = 'initializing',
  /** Initialisation finished successfully. */
  Initialized = 'initialized',
  /** Initialisation failed; {@link Lifecycle.error} explains why. */
  Error = 'error',
  /** Released. */
  Disposed = 'disposed',
}

/** Events emitted by {@link Lifecycle}. */
export interface LifecycleEvents {
  /** Fired when a transition is accepted. */
  statechange: [next: LifecycleState, previous: LifecycleState];
  /** Fired once when initialisation succeeds. */
  'initialized': [];
  /** Fired once when initialisation fails. */
  'error': [error: Error];
  /** Fired once when the object is released. */
  'dispose': [];
}

/** Options for {@link Lifecycle}. */
export interface LifecycleOptions {
  /** Label used in error messages. */
  label?: string;
  /** Start in the `initialized` state (for synchronously built objects). */
  startInitialized?: boolean;
  /** States that must not be left; transitions out of them throw. */
  immutableStates?: LifecycleState[];
}

/** Thrown when an invalid transition is attempted or a state is asserted. */
export class LifecycleError extends Error {
  /** State the object was in. */
  public readonly current: LifecycleState;

  /** State the caller expected or targeted. */
  public readonly expected: LifecycleState;

  /** Creates the error. */
  constructor(message: string, current: LifecycleState, expected: LifecycleState) {
    super(message);
    this.name = 'LifecycleError';
    this.current = current;
    this.expected = expected;
  }
}

/**
 * Tracks the creation → initialised → disposed progression.
 *
 * Guards in {@link initialize}, {@link setError} and {@link dispose} make the
 * corresponding operations idempotent: calling `initialize` twice returns the
 * same promise instead of doing the work twice.
 */
export class Lifecycle {
  /** Event bus for state transitions. */
  public readonly events: EventEmitter<LifecycleEvents> = new EventEmitter<LifecycleEvents>();

  /** Current state. */
  private current: LifecycleState;

  /** Error captured during a failed initialisation. */
  private failure: Error | null = null;

  /** In-flight initialisation, so concurrent calls share one attempt. */
  private pending: Promise<this> | null = null;

  /** States that may not be left once entered. */
  private readonly immutableStates: Set<LifecycleState>;

  /** Label used in diagnostics. */
  public readonly label: string;

  /** Creates a lifecycle tracker. */
  constructor(options: LifecycleOptions = {}) {
    this.label = options.label ?? 'resource';
    this.current = options.startInitialized ? LifecycleState.Initialized : LifecycleState.Created;
    this.immutableStates = new Set(options.immutableStates ?? [LifecycleState.Disposed]);
  }

  /* -------------------------------------------------------------- queries */

  /** Current state. */
  public get state(): LifecycleState {
    return this.current;
  }

  /** The captured failure, or `null`. */
  public get error(): Error | null {
    return this.failure;
  }

  /** `true` when currently initialising. */
  public get isInitializing(): boolean {
    return this.current === LifecycleState.Initializing;
  }

  /** `true` when initialisation succeeded. */
  public get isInitialized(): boolean {
    return this.current === LifecycleState.Initialized;
  }

  /** `true` when the object has been released. */
  public get isDisposed(): boolean {
    return this.current === LifecycleState.Disposed;
  }

  /** `true` when initialisation failed. */
  public get isErrored(): boolean {
    return this.current === LifecycleState.Error;
  }

  /** `true` when the object is initialised and usable. */
  public get isReady(): boolean {
    return this.current === LifecycleState.Initialized;
  }

  /** `true` when `state` may legally transition to `next`. */
  public canTransitionTo(next: LifecycleState): boolean {
    if (this.current === next) return next === LifecycleState.Disposed || next === LifecycleState.Error;
    switch (this.current) {
      case LifecycleState.Created:
        return (
          next === LifecycleState.Initializing ||
          next === LifecycleState.Initialized ||
          next === LifecycleState.Error ||
          next === LifecycleState.Disposed
        );
      case LifecycleState.Initializing:
        return (
          next === LifecycleState.Initialized ||
          next === LifecycleState.Error ||
          next === LifecycleState.Disposed
        );
      case LifecycleState.Initialized:
        return next === LifecycleState.Disposed || next === LifecycleState.Error;
      case LifecycleState.Error:
        return next === LifecycleState.Disposed || next === LifecycleState.Initializing;
      case LifecycleState.Disposed:
        return false;
      default:
        return false;
    }
  }

  /**
   * Throws unless the current state is `expected`.
   *
   * @param expected One state or a set of acceptable states.
   */
  public assertState(...expected: LifecycleState[]): void {
    if (expected.includes(this.current)) return;
    throw new LifecycleError(
      `${this.label} is in state "${this.current}" but ${expected.map((s) => `"${s}"`).join(' or ')} was required`,
      this.current,
      expected[0] ?? this.current,
    );
  }

  /* ------------------------------------------------------------ transitions */

  /**
   * Moves to `next`, emitting `statechange`.
   *
   * @returns `true` when the transition happened.
   * @throws LifecycleError when the transition is illegal.
   */
  public transitionTo(next: LifecycleState): boolean {
    if (this.current === next) return false;
    if (this.immutableStates.has(this.current) && next !== LifecycleState.Disposed) {
      throw new LifecycleError(
        `${this.label} is in immutable state "${this.current}"`,
        this.current,
        next,
      );
    }
    if (!this.canTransitionTo(next)) {
      throw new LifecycleError(
        `Illegal ${this.label} transition from "${this.current}" to "${next}"`,
        this.current,
        next,
      );
    }
    const previous = this.current;
    this.current = next;
    this.events.emit('statechange', next, previous);
    if (next === LifecycleState.Initialized) this.events.emit('initialized');
    if (next === LifecycleState.Disposed) this.events.emit('dispose');
    return true;
  }

  /**
   * Runs `initializer` when needed and resolves once the object is initialised.
   *
   * Concurrent calls share one attempt. Calling it on an already-initialised
   * object resolves immediately; on a disposed object it rejects.
   */
  public async initialize(initializer?: () => void | Promise<void>): Promise<this> {
    if (this.current === LifecycleState.Initialized) return this;
    if (this.current === LifecycleState.Disposed) {
      throw new LifecycleError(`${this.label} has been disposed`, this.current, LifecycleState.Initializing);
    }
    if (this.pending) return this.pending;

    this.transitionTo(LifecycleState.Initializing);

    this.pending = (async () => {
      try {
        await initializer?.();
        if (this.current === LifecycleState.Disposed) {
          throw new LifecycleError(
            `${this.label} was disposed while initialising`,
            this.current,
            LifecycleState.Initialized,
          );
        }
        this.transitionTo(LifecycleState.Initialized);
        return this;
      } catch (error) {
        this.setError(error);
        throw error instanceof Error ? error : new Error(String(error));
      } finally {
        this.pending = null;
      }
    })();

    return this.pending;
  }

  /** Records a failure and moves to the `error` state. */
  public setError(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error(String(error));
    if (this.current !== LifecycleState.Error) {
      this.current = LifecycleState.Error;
      this.events.emit('statechange', LifecycleState.Error, LifecycleState.Initializing);
      this.events.emit('error', this.failure);
    }
  }

  /** Moves to the `disposed` state. Idempotent. */
  public dispose(): void {
    if (this.current === LifecycleState.Disposed) return;
    const previous = this.current;
    this.current = LifecycleState.Disposed;
    this.events.emit('statechange', LifecycleState.Disposed, previous);
    this.events.emit('dispose');
    this.pending = null;
  }

  /* --------------------------------------------------------------- output */

  /** Short human-readable state summary used by debug overlays. */
  public toString(): string {
    const suffix = this.failure ? ` (${this.failure.message})` : '';
    return `${this.label}: ${this.current}${suffix}`;
  }

  /** JSON-friendly state snapshot. */
  public toJSON(): { label: string; state: LifecycleState; error: string | null } {
    return { label: this.label, state: this.current, error: this.failure?.message ?? null };
  }
}

/**
 * Runs `initializer` and reports success/failure through a {@link Lifecycle}.
 *
 * ```ts
 * const { lifecycle, result } = await initializeWithLifecycle('device', () => adapter.requestDevice());
 * ```
 */
export async function initializeWithLifecycle<T>(
  label: string,
  initializer: () => T | Promise<T>,
): Promise<{ lifecycle: Lifecycle; result: T }> {
  const lifecycle = new Lifecycle({ label });
  let result!: T;
  await lifecycle.initialize(async () => {
    result = await initializer();
  });
  return { lifecycle, result };
}

/**
 * Decorator-friendly guard: runs `fn` only while the lifecycle is initialised.
 *
 * @returns `undefined` when the resource is not ready.
 */
export function whenReady<T>(lifecycle: Lifecycle, fn: () => T): T | undefined {
  return lifecycle.isReady ? fn() : undefined;
}
