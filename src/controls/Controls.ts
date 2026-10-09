/**
 * `Controls` — the base class every camera and pointer control shares.
 *
 * A control is a small state machine with a hard lifetime problem: it subscribes to
 * DOM events, and a subscription that outlives its owner is a leak that shows up as a
 * phantom camera move months later. This base class makes that problem structurally
 * impossible:
 *
 * - **Every listener is tracked.** `addDomListener` records the element, type,
 *   listener and options; `disconnect()` removes exactly those, and `onDispose()`
 *   calls `disconnect()`. There is no way to register a listener that is not tracked.
 * - **Events are optional.** `connect(element)` may be called with nothing, and
 *   `update(delta)` still works — which is what a test driving a control by hand, or a
 *   server-side simulation, needs.
 * - **State is restorable.** `saveState()`/`reset()` capture and restore the object's
 *   transform *and* the control's own internal state, so a "reset view" button is one
 *   call.
 *
 * ```ts
 * class MyControls extends Controls {
 *   constructor(object: ControlsObjectLike, element: EventTargetLike) {
 *     super(object);
 *     this.connect(element);
 *   }
 *   protected bindListeners(element: EventTargetLike): void {
 *     this.addDomListener(element, 'pointerdown', this.onDown);
 *   }
 *   public update(delta: number): boolean { ... }
 * }
 * ```
 *
 * @packageDocumentation
 */

import { Disposable } from '../core/Disposable';
import { EventEmitter } from '../core/EventEmitter';
import { EPSILON } from '../constants';
import { Quat } from '../math/Quat';
import { Vec3 } from '../math/Vec3';
import { clamp, clamp01, degToRad, radToDeg } from '../utils/MathUtils';
import {
  createChangeDelta,
  type ChangeDelta,
  type ControlsEventMap,
  type ControlsObjectLike,
  type ControlsOptions,
  type ControlsState,
  type EventTargetLike,
  type SphericalState,
} from './types';

/** One tracked DOM subscription. */
interface DomSubscription {
  /** Element the listener was attached to. */
  target: EventTargetLike;
  /** Event type. */
  type: string;
  /** Listener as registered. */
  listener: (event: never) => void;
  /** Options as registered, so removal matches. */
  options: boolean | { capture?: boolean; passive?: boolean; once?: boolean } | undefined;
}

/**
 * Base class for every control.
 *
 * @typeParam TObject The object being controlled; defaults to the structural
 *   {@link ControlsObjectLike}.
 */
export abstract class Controls<
  TObject extends ControlsObjectLike = ControlsObjectLike,
> extends Disposable<'Controls'> {
  /** @inheritdoc */
  public override readonly label = 'Controls' as const;

  /** The object this control drives. */
  public readonly object: TObject;

  /** Element the control is attached to, or `null` when detached. */
  public domElement: EventTargetLike | null = null;

  /** `false` suspends every handler without detaching. */
  public enabled: boolean;

  /** Point the camera orbits/looks at. */
  public readonly target: Vec3 = new Vec3();

  /** `true` smooths motion across frames. */
  public enableDamping: boolean;

  /** Damping factor in `[0, 1]`; higher means more inertia retention. */
  public dampingFactor: number;

  /** `true` cancels the browser default for every handled event. */
  public preventDefault: boolean;

  /** `true` while a press/drag/gesture is in progress. */
  public interacting = false;

  /** Damping accumulator, integrated by subclasses that support damping. */
  protected readonly dampingDelta = createChangeDelta();

  /** Tracked subscriptions. */
  private readonly subscriptions: DomSubscription[] = [];

  /** Saved state, written by `saveState`. */
  private saved: ControlsState | null = null;

  /** Scratch quaternion for state capture. */
  private readonly scratchQuaternion = new Quat();

  /**
   * Creates a control.
   *
   * @param object Object to drive.
   * @param options Initial flags and target.
   */
  protected constructor(object: TObject, options: ControlsOptions = {}) {
    super();
    this.object = object;
    this.enabled = options.enabled ?? true;
    this.enableDamping = options.enableDamping ?? false;
    this.dampingFactor = clamp01(options.dampingFactor ?? 0.05);
    this.preventDefault = options.preventDefault ?? true;
    if (options.target !== undefined) this.target.copy(options.target);
    if (options.domElement !== undefined && options.domElement !== null) {
      this.connect(options.domElement);
    }
  }

  /* ------------------------------------------------------------------ buses */

  /**
   * Registers a listener.
   *
   * @param event Event name from {@link ControlsEventMap}.
   * @param listener Callback.
   * @returns An unsubscribe function.
   */
  public onEvent<K extends keyof ControlsEventMap & string>(
    event: K,
    listener: (...args: ControlsEventMap[K]) => void,
  ): () => void {
    return this.eventBus.on(event, listener as never);
  }

  /**
   * Removes a listener.
   *
   * @param event Event name.
   * @param listener Callback previously passed to {@link Controls.onEvent}.
   * @returns `true` when a listener was removed.
   */
  public offEvent<K extends keyof ControlsEventMap & string>(
    event: K,
    listener: (...args: ControlsEventMap[K]) => void,
  ): boolean {
    return this.eventBus.off(event, listener as never);
  }

  /**
   * Alias of {@link Controls.onEvent}, matching the DOM naming.
   *
   * @param event Event name.
   * @param listener Callback.
   * @returns An unsubscribe function.
   */
  public addEventListener<K extends keyof ControlsEventMap & string>(
    event: K,
    listener: (...args: ControlsEventMap[K]) => void,
  ): () => void {
    return this.onEvent(event, listener);
  }

  /**
   * Alias of {@link Controls.offEvent}, matching the DOM naming.
   *
   * @param event Event name.
   * @param listener Callback.
   * @returns `true` when a listener was removed.
   */
  public removeEventListener<K extends keyof ControlsEventMap & string>(
    event: K,
    listener: (...args: ControlsEventMap[K]) => void,
  ): boolean {
    return this.offEvent(event, listener);
  }

  /** Emits `change` and reports whether anything moved. */
  protected emitChange(delta: ChangeDelta): boolean {
    if (!delta.rotated && !delta.panned && !delta.zoomed) return false;
    this.controlsEvents.emit('change', delta);
    return true;
  }

  /** Emits `changeStart`. */
  protected emitChangeStart(delta: ChangeDelta = createChangeDelta()): void {
    this.controlsEvents.emit('changeStart', delta);
  }

  /** Emits `changeEnd`. */
  protected emitChangeEnd(delta: ChangeDelta = createChangeDelta()): void {
    this.controlsEvents.emit('changeEnd', delta);
  }

  /**
   * The control's own typed bus.
   *
   * Kept separate from `Disposable.events` so that `dispose`/`disposed` and
   * `change`/`changeStart`/`changeEnd` are both fully typed and neither shadows the
   * other. `onEvent` is the accessor; this getter exists for callers that want the
   * emitter itself.
   */
  public get controlsEvents(): EventEmitter<ControlsEventMap> {
    return this.eventBus;
  }

  /** Backing store for {@link Controls.controlsEvents}. */
  private readonly eventBus = new EventEmitter<ControlsEventMap>();

  /* -------------------------------------------------------------- listeners */

  /**
   * Attaches the control to an element.
   *
   * Connecting while already connected detaches from the previous element first, so
   * `connect` is idempotent and the listener set can never double up.
   *
   * @param element Element to attach to.
   * @returns This control, for chaining.
   */
  public connect(element: EventTargetLike): this {
    if (this.domElement === element) return this;
    this.disconnect();
    this.domElement = element;
    this.bindListeners(element);
    this.eventBus.emit('connect', element);
    return this;
  }

  /**
   * Detaches every listener.
   *
   * @returns This control, for chaining.
   */
  public disconnect(): this {
    for (const subscription of this.subscriptions) {
      try {
        subscription.target.removeEventListener(
          subscription.type,
          subscription.listener as never,
          subscription.options,
        );
      } catch {
        /* a host that rejects removal must not break teardown */
      }
    }
    const had = this.subscriptions.length > 0;
    this.subscriptions.length = 0;
    this.domElement = null;
    if (had) this.eventBus.emit('disconnect');
    return this;
  }

  /**
   * Registers a DOM listener and tracks it for removal.
   *
   * Subclasses call this from {@link Controls.bindListeners}; a listener registered
   * any other way is not removed by `dispose` and is therefore a bug.
   *
   * @param target Element to attach to.
   * @param type Event type.
   * @param listener Listener.
   * @param options Listener options, matched exactly on removal.
   * @returns This control, for chaining.
   */
  protected addDomListener(
    target: EventTargetLike,
    type: string,
    listener: (event: never) => void,
    options?: boolean | { capture?: boolean; passive?: boolean; once?: boolean },
  ): this {
    target.addEventListener(type, listener, options);
    this.subscriptions.push({ target, type, listener, options });
    return this;
  }

  /**
   * Removes one tracked listener.
   *
   * @param target Element the listener was attached to.
   * @param type Event type.
   * @param listener Listener.
   * @returns `true` when a subscription was removed.
   */
  protected removeDomListener(
    target: EventTargetLike,
    type: string,
    listener: (event: never) => void,
  ): boolean {
    const index = this.subscriptions.findIndex(
      (entry) => entry.target === target && entry.type === type && entry.listener === listener,
    );
    if (index < 0) return false;

    const [subscription] = this.subscriptions.splice(index, 1);
    subscription.target.removeEventListener(
      subscription.type,
      subscription.listener as never,
      subscription.options,
    );
    return true;
  }

  /**
   * Number of DOM listeners currently attached.
   *
   * @returns The listener count; `0` after `disconnect()`.
   */
  public get listenerCount(): number {
    return this.subscriptions.length;
  }

  /**
   * `true` when a listener of `type` is attached.
   *
   * @param type Event type.
   * @returns `true` when at least one subscription of that type exists.
   */
  public hasDomListener(type: string): boolean {
    return this.subscriptions.some((entry) => entry.type === type);
  }

  /**
   * Subclass hook: register DOM listeners here.
   *
   * @param element Element to attach to.
   */
  protected abstract bindListeners(element: EventTargetLike): void;

  /**
   * Calls `preventDefault` when the control is configured to.
   *
   * @param event Event carrying an optional `preventDefault`.
   */
  protected suppressDefault(event: { preventDefault?(): void }): void {
    if (!this.preventDefault) return;
    event.preventDefault?.();
  }

  /* ------------------------------------------------------------------ state */

  /**
   * Captures the current transform and internal state.
   *
   * @returns This control, for chaining.
   */
  public saveState(): this {
    this.scratchQuaternion.copy(this.object.quaternion);
    const spherical = this.getSpherical();
    this.saved = {
      position: [this.object.position.x, this.object.position.y, this.object.position.z],
      quaternion: [
        this.scratchQuaternion.x,
        this.scratchQuaternion.y,
        this.scratchQuaternion.z,
        this.scratchQuaternion.w,
      ],
      target: [this.target.x, this.target.y, this.target.z],
      ...(spherical === null ? {} : { spherical }),
    };
    return this;
  }

  /**
   * Restores the state captured by {@link Controls.saveState}.
   *
   * A control that was never saved restores the state captured at construction,
   * which `saveState` is called with implicitly.
   *
   * @returns This control, for chaining.
   */
  public reset(): this {
    if (this.saved === null) {
      // Nothing was captured explicitly; leaving the object untouched is the only
      // honest behaviour, but the event still fires so a UI can react.
      this.eventBus.emit('reset');
      return this;
    }

    this.object.position.set(this.saved.position[0], this.saved.position[1], this.saved.position[2]);
    this.object.quaternion.set(
      this.saved.quaternion[0],
      this.saved.quaternion[1],
      this.saved.quaternion[2],
      this.saved.quaternion[3],
    );
    this.target.set(this.saved.target[0], this.saved.target[1], this.saved.target[2]);

    this.onReset(this.saved);
    this.eventBus.emit('reset');
    return this;
  }

  /**
   * Subclass hook invoked by {@link Controls.reset}, after the transform is restored.
   *
   * @param state The state being restored.
   */
  protected onReset(state: ControlsState): void {
    void state;
  }

  /**
   * `true` when a state has been captured.
   *
   * @returns `true` when {@link Controls.reset} would restore anything.
   */
  public get hasSavedState(): boolean {
    return this.saved !== null;
  }

  /**
   * The captured state, for persistence.
   *
   * @returns A deep copy, or `null`.
   */
  public getState(): ControlsState | null {
    return this.saved === null ? null : structuredCloneState(this.saved);
  }

  /**
   * Installs a previously captured state.
   *
   * @param state State to install.
   * @returns This control, for chaining.
   */
  public setState(state: ControlsState): this {
    this.saved = structuredCloneState(state);
    return this;
  }

  /* ------------------------------------------------------------- spherical */

  /**
   * The object's position expressed relative to {@link Controls.target}.
   *
   * @returns Spherical coordinates, or `null` for a control that has no concept of
   *   a radius (a first-person camera, for instance).
   */
  public getSpherical(): SphericalState | null {
    const offset = new Vec3().subVectors(this.object.position, this.target);
    const radius = offset.length();
    if (radius <= EPSILON) return { radius: 0, phi: 0, theta: 0 };
    return {
      radius,
      phi: Math.acos(clamp(offset.y / radius, -1, 1)),
      theta: Math.atan2(offset.x, offset.z),
    };
  }

  /**
   * Positions the object from spherical coordinates relative to the target.
   *
   * @param spherical Spherical coordinates.
   * @returns This control, for chaining.
   */
  public setSpherical(spherical: SphericalState): this {
    const sinPhi = Math.sin(spherical.phi);
    this.object.position.set(
      this.target.x + spherical.radius * sinPhi * Math.sin(spherical.theta),
      this.target.y + spherical.radius * Math.cos(spherical.phi),
      this.target.z + spherical.radius * sinPhi * Math.cos(spherical.theta),
    );
    this.object.lookAt?.(this.target);
    return this;
  }

  /**
   * Distance from the object to {@link Controls.target}.
   *
   * @returns The distance.
   */
  public getDistance(): number {
    return this.object.position.distanceTo(this.target);
  }

  /**
   * Polar angle of the object about the target, in radians.
   *
   * @returns The angle from `+Y`, in `[0, PI]`.
   */
  public getPolarAngle(): number {
    const offset = new Vec3().subVectors(this.object.position, this.target);
    const radius = offset.length();
    return radius <= EPSILON ? 0 : Math.acos(clamp(offset.y / radius, -1, 1));
  }

  /**
   * Azimuthal angle of the object about the target, in radians.
   *
   * @returns The angle about `+Y`, measured from `+Z`.
   */
  public getAzimuthalAngle(): number {
    const offset = new Vec3().subVectors(this.object.position, this.target);
    return Math.atan2(offset.x, offset.z);
  }

  /**
   * @returns The polar angle in degrees.
   */
  public getPolarAngleDegrees(): number {
    return radToDeg(this.getPolarAngle());
  }

  /**
   * @returns The azimuthal angle in degrees.
   */
  public getAzimuthalAngleDegrees(): number {
    return radToDeg(this.getAzimuthalAngle());
  }

  /**
   * Aims the object at {@link Controls.target}.
   *
   * @returns This control, for chaining.
   */
  public lookAtTarget(): this {
    this.object.lookAt?.(this.target);
    return this;
  }

  /**
   * Marks the object's matrix dirty after a change.
   *
   * @returns This control, for chaining.
   */
  protected markObjectDirty(): this {
    this.object.updateMatrix?.();
    this.object.updateMatrixWorld?.();
    return this;
  }

  /* ----------------------------------------------------------------- update */

  /**
   * Advances the control by one frame.
   *
   * @param delta Seconds since the previous call; used only by damping.
   * @returns `true` when the controlled state changed.
   */
  public abstract update(delta: number): boolean;

  /**
   * Runs `update` and reports the damping factor the subclass should use.
   *
   * @param delta Seconds since the previous call.
   * @returns The damping factor, or `1` when damping is off.
   */
  protected dampingAlpha(delta: number): number {
    if (!this.enableDamping) return 1;
    // `1 - (1 - f)^(delta * 60)` makes the damping frame-rate independent: the same
    // total decay is applied whether one 33 ms step or two 16 ms steps are taken.
    const steps = Math.max(0, delta) * 60;
    return 1 - Math.pow(1 - this.dampingFactor, steps);
  }

  /* ---------------------------------------------------------------- dispose */

  /**
   * Detaches every listener and releases the event bus.
   */
  protected override onDispose(): void {
    this.disconnect();
    this.eventBus.dispose();
    this.enableDamping = false;
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `${this.constructor.name}(enabled=${this.enabled}, attached=${this.domElement !== null}, ` +
      `target=${this.target.toString(3)}, distance=${this.getDistance().toFixed(3)})`
    );
  }

  /* ---------------------------------------------------------------- helpers */

  /**
   * Converts a pixel delta to radians using the element's height.
   *
   * Every camera control needs "how much does a pixel mean?", and the answer is
   * "the vertical field of view divided by the element height". A control with no
   * element falls back to a 90° reference, which keeps the mapping usable in tests
   * and headless simulations.
   *
   * @param pixels Movement in CSS pixels.
   * @param speed Multiplier for the caller's sensitivity setting.
   * @param fovDegrees Vertical field of view; defaults to `90`.
   * @returns The rotation in radians.
   */
  protected pixelsToRadians(pixels: number, speed: number, fovDegrees = 90): number {
    const height = readElementHeight(this.domElement);
    const reference = height > 0 ? height : 1;
    return (pixels / reference) * degToRad(fovDegrees) * speed;
  }
}

/** Reads an element's client height, when it looks like a DOM element. */
function readElementHeight(element: EventTargetLike | null): number {
  if (element === null) return 0;
  const candidate = element as { clientHeight?: unknown; height?: unknown; getBoundingClientRect?: unknown };
  if (typeof candidate.clientHeight === 'number') return candidate.clientHeight;
  if (typeof candidate.height === 'number') return candidate.height;
  return 0;
}

/** Deep-copies a {@link ControlsState}. */
function structuredCloneState(state: ControlsState): ControlsState {
  return {
    position: [state.position[0], state.position[1], state.position[2]],
    quaternion: [state.quaternion[0], state.quaternion[1], state.quaternion[2], state.quaternion[3]],
    target: [state.target[0], state.target[1], state.target[2]],
    ...(state.spherical === undefined ? {} : { spherical: { ...state.spherical } }),
  };
}
