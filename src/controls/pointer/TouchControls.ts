/**
 * `TouchControls` — discrete touch gestures: tap, double-tap, long-press, swipe.
 *
 * A touch surface produces a stream of positions; an *interface* is built from the
 * handful of discrete gestures a user actually performs. This control is the
 * recogniser for those: it watches one contact, decides which gesture was intended,
 * and reports it once.
 *
 * | Gesture | Recognised when |
 * | --- | --- |
 * | `tap` | released within {@link TouchControls.tapMaxDuration} after moving less than {@link TouchControls.tapMaxMovement} |
 * | `doubletap` | a second tap within {@link TouchControls.doubleTapDelay} of the first |
 * | `longpress` | held for {@link TouchControls.longPressDuration} without moving |
 * | `swipe` | released after moving at least {@link TouchControls.swipeMinDistance} within {@link TouchControls.swipeMaxDuration} |
 * | `press` / `release` | every contact down / up, regardless of classification |
 *
 * ## Thresholds are the whole design
 *
 * There is no way to recognise a double-tap without a maximum inter-tap interval, and
 * no way to distinguish a swipe from a scroll without a minimum distance. Every one of
 * those numbers is a public field, so an application can tune the feel rather than
 * reimplement the control — and so a test can drive the recogniser deterministically.
 *
 * ## Mouse fallback
 *
 * `pointerdown`/`pointerup` are handled too, so the same recogniser works on a desktop
 * and the behaviour can be exercised without a touch surface. The mouse path is
 * disabled by {@link TouchControls.mouseFallback}.
 *
 * ```ts
 * const touch = new TouchControls(canvas);
 * touch.onGesture((gesture) => {
 *   if (gesture.type === 'swipe') console.log(gesture.direction, gesture.velocity);
 * });
 * ```
 *
 * @packageDocumentation
 */

import { Vec2 } from '../../math/Vec2';
import { Quat } from '../../math/Quat';
import { Vec3 } from '../../math/Vec3';
import { Controls } from '../Controls';
import {
  createChangeDelta,
  type ControlsObjectLike,
  type ControlsOptions,
  type EventTargetLike,
  type GestureInfo,
  type PointerEventLike,
  type SwipeDirection,
  type TouchEventLike,
  type TouchLike,
} from '../types';

/** Options accepted by the {@link TouchControls} constructor. */
export interface TouchControlsOptions extends ControlsOptions {
  /** Movement in CSS pixels that still counts as a tap; defaults to `10`. */
  tapMaxMovement?: number;
  /** Longest press that still counts as a tap, in milliseconds; defaults to `300`. */
  tapMaxDuration?: number;
  /** Longest gap between two taps of a double-tap, in milliseconds; defaults to `300`. */
  doubleTapDelay?: number;
  /** Hold time before a long press is recognised, in milliseconds; defaults to `500`. */
  longPressDuration?: number;
  /** Movement in CSS pixels that still allows a long press; defaults to `10`. */
  longPressMaxMovement?: number;
  /** Minimum swipe distance in CSS pixels; defaults to `40`. */
  swipeMinDistance?: number;
  /** Longest swipe duration in milliseconds; defaults to `600`. */
  swipeMaxDuration?: number;
  /** `true` (the default) also recognises gestures from a mouse. */
  mouseFallback?: boolean;
}

/** A recognised gesture. */
export type TouchGestureListener = (gesture: GestureInfo) => void;

/** One active contact. */
interface Contact {
  /** Contact identifier. */
  id: number;
  /** Start position, in CSS pixels. */
  start: Vec2;
  /** Latest position, in CSS pixels. */
  current: Vec2;
  /** Milliseconds since the press. */
  duration: number;
  /** `true` once a long press has been reported for this contact. */
  longPressed: boolean;
  /** The element the contact started on. */
  target?: unknown;
}

/**
 * Discrete touch gesture recognition.
 */
export class TouchControls extends Controls {
  /** Movement in CSS pixels that still counts as a tap. */
  public tapMaxMovement = 10;

  /** Longest press that still counts as a tap, in milliseconds. */
  public tapMaxDuration = 300;

  /** Longest gap between two taps of a double-tap, in milliseconds. */
  public doubleTapDelay = 300;

  /** Hold time before a long press is recognised, in milliseconds. */
  public longPressDuration = 500;

  /** Movement in CSS pixels that still allows a long press. */
  public longPressMaxMovement = 10;

  /** Minimum swipe distance in CSS pixels. */
  public swipeMinDistance = 40;

  /** Longest swipe duration in milliseconds. */
  public swipeMaxDuration = 600;

  /** `true` also recognises gestures from a mouse. */
  public mouseFallback = true;

  /** `true` while a contact is down. */
  public touching = false;

  /** Time of the last recognised tap, in milliseconds; `-1` when none. */
  public lastTapTime = -1;

  /** Position of the last recognised tap. */
  public readonly lastTapPosition = new Vec2();

  /** Active contacts, keyed by identifier. */
  private readonly contacts = new Map<number, Contact>();

  /** Gesture listeners. */
  private readonly gestureListeners = new Set<TouchGestureListener>();

  /** Long-press timers, keyed by contact identifier. */
  private readonly longPressTimers = new Map<number, ReturnType<typeof setTimeout>>();

  /**
   * Creates a touch control.
   *
   * @param object Object the control is nominally attached to.
   * @param element Element to attach to, or `null`.
   * @param options Thresholds and fallback configuration.
   */
  constructor(
    object: ControlsObjectLike = { position: new Vec3(), quaternion: new Quat() },
    element: EventTargetLike | null = null,
    options: TouchControlsOptions = {},
  ) {
    super(object, { ...options, domElement: null });

    this.tapMaxMovement = options.tapMaxMovement ?? 10;
    this.tapMaxDuration = options.tapMaxDuration ?? 300;
    this.doubleTapDelay = options.doubleTapDelay ?? 300;
    this.longPressDuration = options.longPressDuration ?? 500;
    this.longPressMaxMovement = options.longPressMaxMovement ?? 10;
    this.swipeMinDistance = options.swipeMinDistance ?? 40;
    this.swipeMaxDuration = options.swipeMaxDuration ?? 600;
    this.mouseFallback = options.mouseFallback ?? true;

    if (element !== null) this.connect(element);
  }

  /* -------------------------------------------------------------- listeners */

  /** @inheritdoc */
  protected override bindListeners(element: EventTargetLike): void {
    this.addDomListener(element, 'touchstart', this.handleTouchStart as (event: never) => void, {
      passive: false,
    });
    this.addDomListener(element, 'touchmove', this.handleTouchMove as (event: never) => void, {
      passive: false,
    });
    this.addDomListener(element, 'touchend', this.handleTouchEnd as (event: never) => void);
    this.addDomListener(element, 'touchcancel', this.handleTouchCancel as (event: never) => void);

    if (this.mouseFallback) {
      this.addDomListener(element, 'pointerdown', this.handlePointerDown as (event: never) => void);
      this.addDomListener(element, 'pointermove', this.handlePointerMove as (event: never) => void);
      this.addDomListener(element, 'pointerup', this.handlePointerUp as (event: never) => void);
      this.addDomListener(element, 'pointercancel', this.handlePointerCancel as (event: never) => void);
    }
  }

  /* ----------------------------------------------------------- touch handlers */

  /** `touchstart` handler. */
  protected handleTouchStart(event: TouchEventLike): void {
    if (!this.enabled) return;
    const touches = listToArray(event.touches);
    if (touches.length > 0) this.suppressDefault(event);

    for (const touch of touches) {
      if (this.contacts.has(touch.identifier)) continue;
      const contact: Contact = {
        id: touch.identifier,
        start: new Vec2(touch.clientX, touch.clientY),
        current: new Vec2(touch.clientX, touch.clientY),
        duration: 0,
        longPressed: false,
        ...(touch.target === undefined ? {} : { target: touch.target }),
      };
      this.contacts.set(touch.identifier, contact);
      this.scheduleLongPress(contact);
      this.emitGesture({
        type: 'press',
        position: contact.start,
        pointerCount: this.contacts.size,
        source: event,
      });
    }

    this.touching = this.contacts.size > 0;
    this.interacting = this.touching;
    if (this.touching) this.emitChangeStart(createChangeDelta());
  }

  /** `touchmove` handler. */
  protected handleTouchMove(event: TouchEventLike): void {
    if (!this.enabled) return;
    const touches = listToArray(event.touches);
    if (touches.length > 0) this.suppressDefault(event);

    for (const touch of touches) {
      const contact = this.contacts.get(touch.identifier);
      if (contact === undefined) continue;
      contact.current.set(touch.clientX, touch.clientY);
      // Movement beyond the threshold cancels a pending long press.
      if (contact.start.distanceTo(contact.current) > this.longPressMaxMovement) {
        this.clearLongPressTimer(contact.id);
      }
    }
  }

  /** `touchend` handler. */
  protected handleTouchEnd(event: TouchEventLike): void {
    const ended = listToArray(event.changedTouches);
    for (const touch of ended) {
      const contact = this.contacts.get(touch.identifier);
      if (contact === undefined) continue;
      this.contacts.delete(touch.identifier);
      this.clearLongPressTimer(touch.identifier);
      this.finishContact(contact, event, false);
    }

    this.touching = this.contacts.size > 0;
    if (!this.touching) {
      this.interacting = false;
      this.emitChangeEnd(createChangeDelta());
    }
  }

  /** `touchcancel` handler. */
  protected handleTouchCancel(event: TouchEventLike): void {
    const cancelled = listToArray(event.changedTouches);
    for (const touch of cancelled) {
      this.contacts.delete(touch.identifier);
      this.clearLongPressTimer(touch.identifier);
    }
    this.touching = this.contacts.size > 0;
    if (!this.touching) this.interacting = false;
  }

  /* --------------------------------------------------------- mouse fallback */

  /** `pointerdown` handler for the mouse fallback. */
  protected handlePointerDown(event: PointerEventLike): void {
    if (!this.enabled || event.pointerType === 'touch') return;
    if (this.contacts.has(event.pointerId ?? 1)) return;

    const id = event.pointerId ?? 1;
    const contact: Contact = {
      id,
      start: new Vec2(event.clientX, event.clientY),
      current: new Vec2(event.clientX, event.clientY),
      duration: 0,
      longPressed: false,
    };
    this.contacts.set(id, contact);
    this.scheduleLongPress(contact);
    this.touching = true;
    this.interacting = true;
    this.emitChangeStart(createChangeDelta());
    this.emitGesture({ type: 'press', position: contact.start, pointerCount: 1 });
  }

  /** `pointermove` handler for the mouse fallback. */
  protected handlePointerMove(event: PointerEventLike): void {
    if (!this.enabled || event.pointerType === 'touch') return;
    const contact = this.contacts.get(event.pointerId ?? 1);
    if (contact === undefined) return;
    contact.current.set(event.clientX, event.clientY);
    if (contact.start.distanceTo(contact.current) > this.longPressMaxMovement) {
      this.clearLongPressTimer(contact.id);
    }
  }

  /** `pointerup` handler for the mouse fallback. */
  protected handlePointerUp(event: PointerEventLike): void {
    if (event.pointerType === 'touch') return;
    const id = event.pointerId ?? 1;
    const contact = this.contacts.get(id);
    if (contact === undefined) return;
    contact.current.set(event.clientX, event.clientY);
    this.contacts.delete(id);
    this.clearLongPressTimer(id);
    this.finishContact(contact, event, true);
    this.touching = this.contacts.size > 0;
    if (!this.touching) {
      this.interacting = false;
      this.emitChangeEnd(createChangeDelta());
    }
  }

  /** `pointercancel` handler for the mouse fallback. */
  protected handlePointerCancel(event: PointerEventLike): void {
    const id = event.pointerId ?? 1;
    this.contacts.delete(id);
    this.clearLongPressTimer(id);
  }

  /* ------------------------------------------------------------ recognition */

  /** Classifies a contact that has ended and emits the resulting gesture. */
  private finishContact(
    contact: Contact,
    source: TouchEventLike | PointerEventLike,
    fromMouse: boolean,
  ): void {
    const movement = contact.start.distanceTo(contact.current);
    const position = contact.current.clone();

    this.emitGesture({
      type: 'release',
      position,
      pointerCount: fromMouse ? 1 : this.contacts.size + 1,
      source,
    });

    // A swipe is checked before a tap: its distance threshold subsumes the tap's, so a
    // long fast drag cannot be misread as a tap.
    if (movement >= this.swipeMinDistance && contact.duration <= this.swipeMaxDuration) {
      const direction = swipeDirection(contact.start, contact.current);
      const duration = Math.max(1, contact.duration);
      this.emitGesture({
        type: 'swipe',
        position,
        direction,
        velocity: movement / duration,
        pointerCount: 1,
        source,
      });
      this.lastTapTime = -1;
      return;
    }

    const isTap = movement <= this.tapMaxMovement && contact.duration <= this.tapMaxDuration;
    if (!isTap) return;

    const now = Date.now();
    const gap = this.lastTapTime < 0 ? Infinity : now - this.lastTapTime;

    if (gap <= this.doubleTapDelay) {
      this.emitGesture({
        type: 'doubletap',
        position,
        pointerCount: 1,
        source,
      });
      // Reset so a third tap starts a new pair rather than reporting two double-taps.
      this.lastTapTime = -1;
      return;
    }

    this.emitGesture({
      type: 'tap',
      position,
      pointerCount: 1,
      source,
    });

    this.lastTapTime = now;
    this.lastTapPosition.copy(position);
  }

  /** Arms the long-press timer for a contact. */
  private scheduleLongPress(contact: Contact): void {
    if (this.longPressDuration <= 0) return;
    const timer = setTimeout(() => {
      this.longPressTimers.delete(contact.id);
      const current = this.contacts.get(contact.id);
      if (current === undefined) return;
      if (current.start.distanceTo(current.current) > this.longPressMaxMovement) return;
      if (current.longPressed) return;
      current.longPressed = true;
      this.emitGesture({
        type: 'longpress',
        position: current.current.clone(),
        pointerCount: this.contacts.size,
      });
    }, this.longPressDuration);
    this.longPressTimers.set(contact.id, timer);
  }

  /** Clears a pending long-press timer. */
  private clearLongPressTimer(id: number): void {
    const timer = this.longPressTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.longPressTimers.delete(id);
    }
  }

  /* ---------------------------------------------------------------- gestures */

  /**
   * Registers a gesture listener.
   *
   * @param listener Callback.
   * @returns An unsubscribe function.
   */
  public onGesture(listener: TouchGestureListener): () => void {
    this.gestureListeners.add(listener);
    return () => {
      this.gestureListeners.delete(listener);
    };
  }

  /**
   * Removes a gesture listener.
   *
   * @param listener Callback previously passed to {@link TouchControls.onGesture}.
   * @returns `true` when a listener was removed.
   */
  public offGesture(listener: TouchGestureListener): boolean {
    return this.gestureListeners.delete(listener);
  }

  /** Dispatches a gesture to every listener. */
  private emitGesture(gesture: GestureInfo): void {
    for (const listener of Array.from(this.gestureListeners)) {
      try {
        listener(gesture);
      } catch {
        /* a listener must not break event handling */
      }
    }
  }

  /* ----------------------------------------------------------------- update */

  /**
   * Accumulates contact durations and recognises long presses without a timer.
   *
   * A caller that drives `update` every frame gets long-press recognition that does
   * not depend on `setTimeout`, which is what makes the behaviour testable with a
   * manual clock.
   *
   * @param delta Seconds since the previous call.
   * @returns `true` when a long press was recognised this frame.
   */
  public update(delta: number): boolean {
    if (!this.enabled) return false;
    const milliseconds = Math.max(0, delta) * 1000;
    let recognised = false;

    for (const contact of this.contacts.values()) {
      contact.duration += milliseconds;
      if (
        !contact.longPressed &&
        this.longPressTimers.size === 0 &&
        contact.duration >= this.longPressDuration &&
        contact.start.distanceTo(contact.current) <= this.longPressMaxMovement
      ) {
        contact.longPressed = true;
        recognised = true;
        this.emitGesture({
          type: 'longpress',
          position: contact.current.clone(),
          pointerCount: this.contacts.size,
        });
      }
    }

    return recognised;
  }

  /* --------------------------------------------------------------- queries */

  /**
   * Number of contacts currently down.
   *
   * @returns The contact count.
   */
  public getContactCount(): number {
    return this.contacts.size;
  }

  /**
   * `true` when a contact is down.
   *
   * @returns The touch state.
   */
  public get isTouching(): boolean {
    return this.touching;
  }

  /**
   * Releases every contact and cancels pending timers.
   *
   * @returns The number of contacts released.
   */
  public cancelAll(): number {
    const count = this.contacts.size;
    for (const id of Array.from(this.longPressTimers.keys())) this.clearLongPressTimer(id);
    this.contacts.clear();
    this.touching = false;
    this.interacting = false;
    return count;
  }

  /**
   * Resets the double-tap window, so the next tap cannot pair with a previous one.
   *
   * @returns This control, for chaining.
   */
  public resetTapHistory(): this {
    this.lastTapTime = -1;
    return this;
  }

  /** @inheritdoc */
  protected override onReset(): void {
    this.cancelAll();
    this.resetTapHistory();
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
    return `TouchControls(contacts=${this.contacts.size}, touching=${this.touching})`;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Converts an array-like touch list into a real array. */
function listToArray(list: TouchEventLike['touches'] | undefined): TouchLike[] {
  if (list === undefined || list === null) return [];
  const out: TouchLike[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = typeof list.item === 'function' ? list.item(i) : list[i];
    if (item != null) out.push(item);
  }
  return out;
}

/** Names the direction of a swipe from its start and end points. */
export function swipeDirection(start: Vec2, end: Vec2): SwipeDirection {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // The dominant axis wins, so a mostly-horizontal diagonal is a left/right swipe.
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

/**
 * Convenience factory mirroring `new TouchControls(object, element, options)`.
 *
 * @param object Object the control is attached to.
 * @param element Element to attach to.
 * @param options Thresholds and fallback configuration.
 * @returns A new touch control.
 */
export function touchControls(
  object: ControlsObjectLike,
  element: EventTargetLike | null = null,
  options: TouchControlsOptions = {},
): TouchControls {
  return new TouchControls(object, element, options);
}
