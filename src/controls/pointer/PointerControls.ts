/**
 * `PointerControls` — raw, multi-pointer bookkeeping with capture.
 *
 * Every control above this one answers a *high-level* question ("how much did the
 * camera rotate?"). This one answers the low-level question a tool actually needs:
 * *"which pointers are down, where did each start, how far has each moved, and has
 * one crossed the drag threshold?"*
 *
 * It is the control you build an editor gizmo, a box-select marquee or a custom
 * gesture on — and it is the only one in this package that keeps **per-pointer** state
 * rather than a single active pointer.
 *
 * ## Pointer capture
 *
 * `setPointerCapture` is used when the host provides it, so a drag that leaves the
 * element keeps delivering `pointermove` to it. That is the difference between a
 * marquee that works and one that silently stops when the cursor crosses a panel
 * boundary. Capture is released on `pointerup`, on `pointercancel`, and on
 * `lostpointercapture`.
 *
 * ## Drag threshold
 *
 * A press does not become a drag until the pointer has moved
 * {@link PointerControls.dragThreshold} CSS pixels. That single number is what lets
 * the same control distinguish a click from a drag without the caller implementing a
 * timer.
 *
 * ```ts
 * const pointers = new PointerControls(canvas);
 * pointers.onGesture((gesture) => {
 *   if (gesture.type === 'drag') console.log(gesture.pointer.current);
 * });
 * ```
 *
 * @packageDocumentation
 */

import { Quat } from '../../math/Quat';
import { Vec2 } from '../../math/Vec2';
import { Vec3 } from '../../math/Vec3';
import { Controls } from '../Controls';
import {
  createChangeDelta,
  type ControlsObjectLike,
  type ControlsOptions,
  type EventTargetLike,
  type PointerEventLike,
  type PointerState,
} from '../types';

/** Options accepted by the {@link PointerControls} constructor. */
export interface PointerControlsOptions extends ControlsOptions {
  /** Movement in CSS pixels before a press becomes a drag; defaults to `4`. */
  dragThreshold?: number;
  /** Milliseconds after which a press becomes a long press; defaults to `500`. */
  longPressDuration?: number;
  /** `false` disables pointer capture; defaults to `true`. */
  capturePointers?: boolean;
  /** `false` ignores secondary buttons; defaults to `true`. */
  allowSecondary?: boolean;
  /** `true` (the default) cancels the browser default on press. */
  allowDefaultOnPress?: boolean;
}

/** A pointer event reported by {@link PointerControls}. */
export interface PointerGesture {
  /** Event name. */
  type: 'press' | 'release' | 'drag' | 'dragstart' | 'dragend' | 'move' | 'wheel' | 'longpress' | 'cancel';
  /** The pointer the event belongs to. */
  pointer: PointerState;
  /** Position of the event, in CSS pixels. */
  position: Vec2;
  /** Movement since the previous event, in CSS pixels. */
  movement: Vec2;
  /** Movement since the press, in CSS pixels. */
  totalMovement: Vec2;
  /** Milliseconds the pointer has been down. */
  duration: number;
  /** `true` when the total movement has crossed the drag threshold. */
  isDragging: boolean;
  /** Wheel delta Y, when the event is a wheel event. */
  deltaY?: number;
}

/** Callback shape for {@link PointerControls.onGesture}. */
export type PointerGestureListener = (gesture: PointerGesture) => void;

/**
 * Multi-pointer bookkeeping with capture and drag thresholds.
 */
export class PointerControls extends Controls {
  /** Movement in CSS pixels before a press becomes a drag. */
  public dragThreshold = 4;

  /** Milliseconds after which a press becomes a long press. */
  public longPressDuration = 500;

  /** `false` disables pointer capture. */
  public capturePointers = true;

  /** `false` ignores buttons other than the primary one. */
  public allowSecondary = true;

  /** Pointer states, keyed by pointer id. */
  public readonly pointers = new Map<number, PointerState>();

  /** Gesture listeners. */
  private readonly gestureListeners = new Set<PointerGestureListener>();

  /** Long-press timers, keyed by pointer id. */
  private readonly longPressTimers = new Map<number, ReturnType<typeof setTimeout>>();

  /** Reused movement scratch. */
  private readonly scratchMovement = new Vec2();

  /** Reused total-movement scratch. */
  private readonly scratchTotal = new Vec2();

  /** Reused position scratch. */
  private readonly scratchPosition = new Vec2();

  /**
   * Creates a pointer control.
   *
   * @param object Object the control is nominally attached to.
   * @param element Element to attach to, or `null`.
   * @param options Thresholds and capture behaviour.
   */
  constructor(
    object: ControlsObjectLike = { position: new Vec3(), quaternion: new Quat() },
    element: EventTargetLike | null = null,
    options: PointerControlsOptions = {},
  ) {
    super(object, { ...options, domElement: null });

    this.dragThreshold = Math.max(0, options.dragThreshold ?? 4);
    this.longPressDuration = Math.max(0, options.longPressDuration ?? 500);
    this.capturePointers = options.capturePointers ?? true;
    this.allowSecondary = options.allowSecondary ?? true;

    if (element !== null) this.connect(element);
  }

  /* -------------------------------------------------------------- listeners */

  /** @inheritdoc */
  protected override bindListeners(element: EventTargetLike): void {
    this.addDomListener(element, 'pointerdown', this.handlePointerDown as (event: never) => void);
    this.addDomListener(element, 'pointermove', this.handlePointerMove as (event: never) => void);
    this.addDomListener(element, 'pointerup', this.handlePointerUp as (event: never) => void);
    this.addDomListener(element, 'pointercancel', this.handlePointerCancel as (event: never) => void);
    this.addDomListener(element, 'pointerleave', this.handlePointerLeave as (event: never) => void);
    this.addDomListener(element, 'lostpointercapture', this.handleLostCapture as (event: never) => void);
    this.addDomListener(element, 'wheel', this.handleWheel as (event: never) => void, { passive: false });
    this.addDomListener(element, 'contextmenu', this.handleContextMenu as (event: never) => void);
  }

  /* ---------------------------------------------------------------- handlers */

  /** `pointerdown` handler. */
  protected handlePointerDown(event: PointerEventLike): void {
    if (!this.enabled) return;
    const button = event.button ?? 0;
    if (!this.allowSecondary && button !== 0) return;

    const id = event.pointerId ?? 1;
    const state: PointerState = {
      id,
      type: event.pointerType ?? 'mouse',
      down: true,
      start: new Vec2(event.clientX, event.clientY),
      current: new Vec2(event.clientX, event.clientY),
      previous: new Vec2(event.clientX, event.clientY),
      movement: 0,
      duration: 0,
      button,
    };
    this.pointers.set(id, state);

    if (this.capturePointers) capturePointer(event.currentTarget ?? event.target, id);

    this.interacting = true;
    this.emitChangeStart(createChangeDelta());

    this.emitGesture({
      type: 'press',
      pointer: state,
      position: state.current,
      movement: new Vec2(0, 0),
      totalMovement: new Vec2(0, 0),
      duration: 0,
      isDragging: false,
    });

    // A long press only fires if the pointer is still down when the timer expires.
    if (this.longPressDuration > 0) {
      const timer = setTimeout(() => {
        this.longPressTimers.delete(id);
        const current = this.pointers.get(id);
        if (current === undefined || !current.down) return;
        this.emitGesture({
          type: 'longpress',
          pointer: current,
          position: current.current,
          movement: new Vec2(0, 0),
          totalMovement: new Vec2(
            current.current.x - current.start.x,
            current.current.y - current.start.y,
          ),
          duration: current.duration,
          isDragging: current.movement >= this.dragThreshold,
        });
      }, this.longPressDuration);
      this.longPressTimers.set(id, timer);
    }
  }

  /** `pointermove` handler. */
  protected handlePointerMove(event: PointerEventLike): void {
    if (!this.enabled) return;
    const id = event.pointerId ?? 1;
    const state = this.pointers.get(id);

    if (state === undefined) {
      // A hover move with no press: report it without creating a persistent state, so
      // a caller can implement hover highlighting without leaking entries.
      const transient: PointerState = {
        id,
        type: event.pointerType ?? 'mouse',
        down: false,
        start: new Vec2(event.clientX, event.clientY),
        current: new Vec2(event.clientX, event.clientY),
        previous: new Vec2(event.clientX, event.clientY),
        movement: 0,
        duration: 0,
        button: -1,
      };
      this.emitGesture({
        type: 'move',
        pointer: transient,
        position: transient.current,
        movement: new Vec2(0, 0),
        totalMovement: new Vec2(0, 0),
        duration: 0,
        isDragging: false,
      });
      return;
    }

    const dx = event.clientX - state.previous.x;
    const dy = event.clientY - state.previous.y;
    state.previous.set(event.clientX, event.clientY);
    state.current.set(event.clientX, event.clientY);

    const totalX = state.current.x - state.start.x;
    const totalY = state.current.y - state.start.y;
    state.movement = Math.hypot(totalX, totalY);
    state.duration += 0;

    this.scratchMovement.set(dx, dy);
    this.scratchTotal.set(totalX, totalY);
    this.scratchPosition.set(state.current.x, state.current.y);

    const dragging = state.movement >= this.dragThreshold;

    this.emitGesture({
      type: 'drag',
      pointer: state,
      position: this.scratchPosition,
      movement: this.scratchMovement,
      totalMovement: this.scratchTotal,
      duration: state.duration,
      isDragging: dragging,
    });

    if (dragging && !this.draggingIds.has(id)) {
      this.draggingIds.add(id);
      this.emitGesture({
        type: 'dragstart',
        pointer: state,
        position: this.scratchPosition,
        movement: this.scratchMovement,
        totalMovement: this.scratchTotal,
        duration: state.duration,
        isDragging: true,
      });
    }
  }

  /** Pointer ids that have crossed the drag threshold. */
  private readonly draggingIds = new Set<number>();

  /** `pointerup` handler. */
  protected handlePointerUp(event: PointerEventLike): void {
    const id = event.pointerId ?? 1;
    const state = this.pointers.get(id);
    if (state === undefined) return;

    state.down = false;
    state.current.set(event.clientX, event.clientY);

    this.clearLongPressTimer(id);

    if (this.draggingIds.has(id)) {
      this.emitGesture({
        type: 'dragend',
        pointer: state,
        position: state.current,
        movement: new Vec2(0, 0),
        totalMovement: new Vec2(state.current.x - state.start.x, state.current.y - state.start.y),
        duration: state.duration,
        isDragging: true,
      });
    }

    this.emitGesture({
      type: 'release',
      pointer: state,
      position: state.current,
      movement: new Vec2(0, 0),
      totalMovement: new Vec2(state.current.x - state.start.x, state.current.y - state.start.y),
      duration: state.duration,
      isDragging: this.draggingIds.has(id),
    });

    this.draggingIds.delete(id);
    if (this.capturePointers) releasePointer(event.currentTarget ?? event.target, id);
    this.pointers.delete(id);

    if (this.pointers.size === 0) {
      this.interacting = false;
      this.emitChangeEnd(createChangeDelta());
    }
  }

  /** `pointercancel` handler. */
  protected handlePointerCancel(event: PointerEventLike): void {
    const id = event.pointerId ?? 1;
    const state = this.pointers.get(id);
    if (state === undefined) return;

    this.clearLongPressTimer(id);
    this.draggingIds.delete(id);

    this.emitGesture({
      type: 'cancel',
      pointer: state,
      position: state.current,
      movement: new Vec2(0, 0),
      totalMovement: new Vec2(0, 0),
      duration: state.duration,
      isDragging: false,
    });

    this.pointers.delete(id);
    if (this.pointers.size === 0) {
      this.interacting = false;
      this.emitChangeEnd(createChangeDelta());
    }
  }

  /** `pointerleave` handler: a pointer that left without capture is gone. */
  protected handlePointerLeave(event: PointerEventLike): void {
    if (this.capturePointers) return;
    this.handlePointerCancel(event);
  }

  /** `lostpointercapture` handler: a pointer released its capture. */
  protected handleLostCapture(event: PointerEventLike): void {
    const id = event.pointerId ?? 1;
    this.clearLongPressTimer(id);
    this.draggingIds.delete(id);
    this.pointers.delete(id);
  }

  /** `wheel` handler. */
  protected handleWheel(event: PointerEventLike): void {
    if (!this.enabled) return;
    this.suppressDefault(event);

    const id = event.pointerId ?? 1;
    const state = this.pointers.get(id) ?? {
      id,
      type: event.pointerType ?? 'mouse',
      down: false,
      start: new Vec2(event.clientX, event.clientY),
      current: new Vec2(event.clientX, event.clientY),
      previous: new Vec2(event.clientX, event.clientY),
      movement: 0,
      duration: 0,
      button: -1,
    };

    this.emitGesture({
      type: 'wheel',
      pointer: state,
      position: state.current,
      movement: new Vec2(0, 0),
      totalMovement: new Vec2(0, 0),
      duration: 0,
      isDragging: false,
      deltaY: event.deltaY ?? 0,
    });
  }

  /** `contextmenu` handler. */
  protected handleContextMenu(event: PointerEventLike): void {
    if (!this.allowSecondary) return;
    this.suppressDefault(event);
  }

  /* --------------------------------------------------------------- queries */

  /**
   * A pointer's state.
   *
   * @param id Pointer identifier.
   * @returns The state, or `undefined`.
   */
  public getPointer(id: number): PointerState | undefined {
    return this.pointers.get(id);
  }

  /**
   * `true` when a pointer is down.
   *
   * @param id Pointer identifier.
   * @returns `true` when the pointer is tracked and down.
   */
  public isPointerDown(id: number): boolean {
    return this.pointers.get(id)?.down === true;
  }

  /**
   * Every tracked pointer.
   *
   * @returns The states.
   */
  public getActivePointers(): PointerState[] {
    return Array.from(this.pointers.values());
  }

  /**
   * Number of pointers currently down.
   *
   * @returns The count.
   */
  public getPointerCount(): number {
    return this.pointers.size;
  }

  /**
   * The first pointer that went down.
   *
   * @returns The state, or `undefined` when nothing is down.
   */
  public getPrimaryPointer(): PointerState | undefined {
    for (const state of this.pointers.values()) return state;
    return undefined;
  }

  /**
   * `true` when any tracked pointer has crossed the drag threshold.
   *
   * @returns The drag state.
   */
  public isDragging(): boolean {
    return this.draggingIds.size > 0;
  }

  /**
   * Releases every pointer.
   *
   * Call this when the element is removed while a drag is in flight, so a subsequent
   * `pointerup` on another element does not leave a ghost entry behind.
   *
   * @returns The number of pointers released.
   */
  public cancelAll(): number {
    const count = this.pointers.size;
    for (const id of this.longPressTimers.keys()) this.clearLongPressTimer(id);
    this.pointers.clear();
    this.draggingIds.clear();
    this.interacting = false;
    return count;
  }

  /* ---------------------------------------------------------------- gestures */

  /**
   * Registers a gesture listener.
   *
   * @param listener Callback.
   * @returns An unsubscribe function.
   */
  public onGesture(listener: PointerGestureListener): () => void {
    this.gestureListeners.add(listener);
    return () => {
      this.gestureListeners.delete(listener);
    };
  }

  /**
   * Removes a gesture listener.
   *
   * @param listener Callback previously passed to {@link PointerControls.onGesture}.
   * @returns `true` when a listener was removed.
   */
  public offGesture(listener: PointerGestureListener): boolean {
    return this.gestureListeners.delete(listener);
  }

  /** Dispatches a gesture to every listener. */
  private emitGesture(gesture: PointerGesture): void {
    for (const listener of Array.from(this.gestureListeners)) {
      try {
        listener(gesture);
      } catch {
        /* a listener must not break event handling */
      }
    }
  }

  /** Clears a pending long-press timer. */
  private clearLongPressTimer(id: number): void {
    const timer = this.longPressTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.longPressTimers.delete(id);
    }
  }

  /* ----------------------------------------------------------------- update */

  /**
   * Advances the per-pointer durations.
   *
   * Pointer state is otherwise event-driven, so this only accumulates time.
   *
   * @param delta Seconds since the previous call.
   * @returns `true` when any pointer duration advanced.
   */
  public update(delta: number): boolean {
    if (!this.enabled) return false;
    const milliseconds = Math.max(0, delta) * 1000;
    let changed = false;
    for (const state of this.pointers.values()) {
      if (!state.down) continue;
      state.duration += milliseconds;
      changed = true;
    }
    return changed;
  }

  /** @inheritdoc */
  protected override onReset(): void {
    this.cancelAll();
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    for (const id of Array.from(this.longPressTimers.keys())) this.clearLongPressTimer(id);
    this.cancelAll();
    this.gestureListeners.clear();
    super.onDispose();
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `PointerControls(pointers=${this.pointers.size}, dragging=${this.draggingIds.size}, ` +
      `dragThreshold=${this.dragThreshold})`
    );
  }
}

/** Calls `setPointerCapture` when the host supports it. */
function capturePointer(target: unknown, pointerId: number): void {
  const candidate = target as { setPointerCapture?(id: number): void } | null | undefined;
  try {
    candidate?.setPointerCapture?.(pointerId);
  } catch {
    /* capture is best-effort */
  }
}

/** Calls `releasePointerCapture` when the host supports it. */
function releasePointer(target: unknown, pointerId: number): void {
  const candidate = target as { releasePointerCapture?(id: number): void } | null | undefined;
  try {
    candidate?.releasePointerCapture?.(pointerId);
  } catch {
    /* capture is best-effort */
  }
}

/**
 * Convenience factory mirroring `new PointerControls(object, element, options)`.
 *
 * @param object Object the control is attached to.
 * @param element Element to attach to.
 * @param options Thresholds and capture behaviour.
 * @returns A new pointer control.
 */
export function pointerControls(
  object: ControlsObjectLike,
  element: EventTargetLike | null = null,
  options: PointerControlsOptions = {},
): PointerControls {
  return new PointerControls(object, element, options);
}
