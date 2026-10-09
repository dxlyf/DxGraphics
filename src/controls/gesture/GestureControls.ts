/**
 * `GestureControls` — two-finger pinch, rotate and pan.
 *
 * The three gestures a two-finger trackpad or touchscreen produces are not
 * independent: a real pinch almost always includes some rotation and some drift. This
 * control derives all three from the same pair of contacts, so a caller can consume
 * just the one it wants and the others remain consistent:
 *
 * ```
 *        before                    after
 *     A ●───────● B            A' ●───────● B'
 *
 *     scale      = |A'B'| / |AB|
 *     rotation   = atan2 of B'-A' minus atan2 of B-A
 *     translation= centroid' - centroid
 * ```
 *
 * ## Why incremental deltas
 *
 * Every event reports the change since the **previous frame**, not since the gesture
 * began. Incremental deltas compose: a caller can apply them to a camera, a canvas
 * transform, or a zoom-and-rotate pair without caring how the gesture started, and a
 * gesture that pauses and resumes does not jump. The cumulative values are available
 * too, through {@link GestureControls.totalScale} and
 * {@link GestureControls.totalRotation}.
 *
 * ## Thresholds
 *
 * Nothing is emitted until the gesture exceeds its threshold
 * ({@link GestureControls.pinchThreshold}, {@link GestureControls.rotationThreshold},
 * {@link GestureControls.panThreshold}), which is what stops a two-finger tap from
 * being reported as a tiny pinch. {@link GestureControls.gesturestart} fires when the
 * second contact lands and {@link GestureControls.gestureend} when one lifts.
 *
 * ```ts
 * const gestures = new GestureControls(canvas);
 * gestures.onGesture((gesture) => {
 *   if (gesture.type === 'pinch') zoom *= gesture.scale ?? 1;
 *   if (gesture.type === 'rotate') angle += gesture.rotation ?? 0;
 *   if (gesture.type === 'pan') pan.add(gesture.translation ?? new Vec2());
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
  type GestureInfo,
  type PointerEventLike,
  type TouchEventLike,
  type TouchLike,
} from '../types';

/** Options accepted by the {@link GestureControls} constructor. */
export interface GestureControlsOptions extends ControlsOptions {
  /** `false` disables pinch recognition. */
  enablePinch?: boolean;
  /** `false` disables rotation recognition. */
  enableRotate?: boolean;
  /** `false` disables pan recognition. */
  enablePan?: boolean;
  /** Minimum scale deviation from `1` before a pinch is reported; defaults to `0.01`. */
  pinchThreshold?: number;
  /** Minimum radians before a rotation is reported; defaults to `0.01`. */
  rotationThreshold?: number;
  /** Minimum pixels before a pan is reported; defaults to `1`. */
  panThreshold?: number;
  /** Sensitivity multipliers. */
  pinchSpeed?: number;
  /** Sensitivity multiplier for rotation; defaults to `1`. */
  rotationSpeed?: number;
  /** Sensitivity multiplier for pan; defaults to `1`. */
  panSpeed?: number;
  /** `true` (the default) also recognises gestures from the mouse wheel and drag. */
  mouseFallback?: boolean;
}

/** A recognised two-pointer gesture. */
export type GestureListener = (gesture: GestureInfo) => void;

/** One contact. */
interface Contact {
  /** Contact identifier. */
  id: number;
  /** Latest position, in CSS pixels. */
  position: Vec2;
}

/**
 * Two-pointer pinch, rotate and pan recognition.
 */
export class GestureControls extends Controls {
  /** `false` disables pinch recognition. */
  public enablePinch = true;

  /** `false` disables rotation recognition. */
  public enableRotate = true;

  /** `false` disables pan recognition. */
  public enablePan = true;

  /** Minimum scale deviation from `1` before a pinch is reported. */
  public pinchThreshold = 0.01;

  /** Minimum radians before a rotation is reported. */
  public rotationThreshold = 0.01;

  /** Minimum pixels before a pan is reported. */
  public panThreshold = 1;

  /** Pinch sensitivity multiplier. */
  public pinchSpeed = 1;

  /** Rotation sensitivity multiplier. */
  public rotationSpeed = 1;

  /** Pan sensitivity multiplier. */
  public panSpeed = 1;

  /** `true` also recognises mouse gestures. */
  public mouseFallback = true;

  /** `true` while two or more contacts are down. */
  public gesturing = false;

  /** Cumulative scale since the gesture began. */
  public totalScale = 1;

  /** Cumulative rotation since the gesture began, in radians. */
  public totalRotation = 0;

  /** Cumulative translation since the gesture began, in pixels. */
  public readonly totalTranslation = new Vec2();

  /** Contacts currently down, keyed by identifier. */
  private readonly contacts = new Map<number, Contact>();

  /** Distance between the two contacts at the previous sample. */
  private previousDistance = 0;

  /** Angle between the two contacts at the previous sample, in radians. */
  private previousAngle = 0;

  /** Centroid at the previous sample. */
  private readonly previousCentroid = new Vec2();

  /** Gesture listeners. */
  private readonly gestureListeners = new Set<GestureListener>();

  /** Wheel accumulator for the mouse fallback. */
  private wheelAccumulator = 0;

  /**
   * Creates a gesture control.
   *
   * @param object Object the control is nominally attached to.
   * @param element Element to attach to, or `null`.
   * @param options Feature flags and thresholds.
   */
  constructor(
    object: ControlsObjectLike = { position: new Vec3(), quaternion: new Quat() },
    element: EventTargetLike | null = null,
    options: GestureControlsOptions = {},
  ) {
    super(object, { ...options, domElement: null });

    this.enablePinch = options.enablePinch ?? true;
    this.enableRotate = options.enableRotate ?? true;
    this.enablePan = options.enablePan ?? true;
    this.pinchThreshold = options.pinchThreshold ?? 0.01;
    this.rotationThreshold = options.rotationThreshold ?? 0.01;
    this.panThreshold = options.panThreshold ?? 1;
    this.pinchSpeed = options.pinchSpeed ?? 1;
    this.rotationSpeed = options.rotationSpeed ?? 1;
    this.panSpeed = options.panSpeed ?? 1;
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
    this.addDomListener(element, 'touchcancel', this.handleTouchEnd as (event: never) => void);
    this.addDomListener(element, 'pointerdown', this.handlePointerDown as (event: never) => void);
    this.addDomListener(element, 'pointermove', this.handlePointerMove as (event: never) => void);
    this.addDomListener(element, 'pointerup', this.handlePointerUp as (event: never) => void);
    this.addDomListener(element, 'pointercancel', this.handlePointerUp as (event: never) => void);

    if (this.mouseFallback) {
      this.addDomListener(element, 'wheel', this.handleWheel as (event: never) => void, {
        passive: false,
      });
    }
  }

  /* ----------------------------------------------------------- touch handlers */

  /** `touchstart` handler. */
  protected handleTouchStart(event: TouchEventLike): void {
    if (!this.enabled) return;
    const touches = listToArray(event.touches);
    if (touches.length >= 2) this.suppressDefault(event);

    for (const touch of touches) {
      this.contacts.set(touch.identifier, {
        id: touch.identifier,
        position: new Vec2(touch.clientX, touch.clientY),
      });
    }

    if (this.contacts.size === 2 && !this.gesturing) this.beginGesture(event);
  }

  /** `touchmove` handler. */
  protected handleTouchMove(event: TouchEventLike): void {
    if (!this.enabled) return;
    const touches = listToArray(event.touches);
    if (touches.length >= 2) this.suppressDefault(event);

    for (const touch of touches) {
      const contact = this.contacts.get(touch.identifier);
      if (contact !== undefined) contact.position.set(touch.clientX, touch.clientY);
    }

    if (this.contacts.size === 2 && this.gesturing) {
      this.sampleGesture(event);
      return;
    }

    // A second finger arrived mid-move: start the gesture now rather than waiting for
    // the next `touchstart`, which some hosts never deliver for the second contact.
    if (this.contacts.size === 2 && !this.gesturing) this.beginGesture(event);
  }

  /** `touchend`/`touchcancel` handler. */
  protected handleTouchEnd(event: TouchEventLike): void {
    for (const touch of listToArray(event.changedTouches)) this.contacts.delete(touch.identifier);

    if (this.contacts.size < 2 && this.gesturing) this.endGesture(event);
  }

  /* --------------------------------------------------------- pointer fallback */

  /** `pointerdown` handler for the pointer/trackpad path. */
  protected handlePointerDown(event: PointerEventLike): void {
    if (!this.enabled || event.pointerType === 'touch') return;
    this.contacts.set(event.pointerId ?? 1, {
      id: event.pointerId ?? 1,
      position: new Vec2(event.clientX, event.clientY),
    });
    if (this.contacts.size === 2 && !this.gesturing) this.beginGesture(event);
  }

  /** `pointermove` handler for the pointer/trackpad path. */
  protected handlePointerMove(event: PointerEventLike): void {
    if (!this.enabled || event.pointerType === 'touch') return;
    const id = event.pointerId ?? 1;
    const contact = this.contacts.get(id);
    if (contact === undefined) return;
    contact.position.set(event.clientX, event.clientY);
    if (this.contacts.size === 2 && this.gesturing) this.sampleGesture(event);
  }

  /** `pointerup` handler for the pointer/trackpad path. */
  protected handlePointerUp(event: PointerEventLike): void {
    if (event.pointerType === 'touch') return;
    this.contacts.delete(event.pointerId ?? 1);
    if (this.contacts.size < 2 && this.gesturing) this.endGesture(event);
  }

  /** `wheel` handler for the mouse fallback: Ctrl+wheel reads as a pinch. */
  protected handleWheel(event: PointerEventLike): void {
    if (!this.enabled || !this.mouseFallback) return;
    // Browsers synthesise a `wheel` with `ctrlKey` for a trackpad pinch, which is the
    // only way a pinch reaches a desktop page.
    if (event.ctrlKey !== true) return;

    this.suppressDefault(event);
    const notches = (event.deltaY ?? 0) / 100;
    this.wheelAccumulator += notches;

    // A wheel pinch has no contacts, so the gesture lifecycle is driven here.
    if (!this.gesturing) {
      this.gesturing = true;
      this.totalScale = 1;
      this.totalRotation = 0;
      this.totalTranslation.set(0, 0);
      this.emitChangeStart(createChangeDelta());
    }

    const scale = Math.pow(0.99, notches * this.pinchSpeed);
    if (Math.abs(scale - 1) < this.pinchThreshold) return;

    this.totalScale *= scale;
    this.emitGesture({
      type: 'pinch',
      position: new Vec2(event.clientX, event.clientY),
      scale,
      pointerCount: 0,
    });
  }

  /* ------------------------------------------------------------ recognition */

  /** Starts a gesture from the two current contacts. */
  protected beginGesture(source: TouchEventLike | PointerEventLike): void {
    const [first, second] = Array.from(this.contacts.values());
    if (first === undefined || second === undefined) return;

    this.gesturing = true;
    this.totalScale = 1;
    this.totalRotation = 0;
    this.totalTranslation.set(0, 0);

    this.previousDistance = first.position.distanceTo(second.position);
    this.previousAngle = angleBetween(first.position, second.position);
    this.previousCentroid.set(
      (first.position.x + second.position.x) * 0.5,
      (first.position.y + second.position.y) * 0.5,
    );

    this.interacting = true;
    this.emitChangeStart(createChangeDelta());
    this.emitGesture({
      type: 'pan',
      position: this.previousCentroid.clone(),
      translation: new Vec2(0, 0),
      scale: 1,
      rotation: 0,
      pointerCount: 2,
      source,
    });
  }

  /** Emits the incremental deltas for the current contact positions. */
  protected sampleGesture(source: TouchEventLike | PointerEventLike): void {
    const [first, second] = Array.from(this.contacts.values());
    if (first === undefined || second === undefined) return;

    const distance = first.position.distanceTo(second.position);
    const angle = angleBetween(first.position, second.position);
    const centroid = new Vec2(
      (first.position.x + second.position.x) * 0.5,
      (first.position.y + second.position.y) * 0.5,
    );

    // ---- pinch ------------------------------------------------------------
    if (this.enablePinch && this.previousDistance > 0) {
      const rawScale = distance / this.previousDistance;
      const scale = 1 + (rawScale - 1) * this.pinchSpeed;
      if (Math.abs(scale - 1) >= this.pinchThreshold) {
        this.totalScale *= scale;
        this.emitGesture({
          type: 'pinch',
          position: centroid.clone(),
          scale,
          deltaScale: rawScale - 1,
          pointerCount: 2,
          source,
        });
      }
    }

    // ---- rotate -----------------------------------------------------------
    if (this.enableRotate) {
      // `angleDelta` keeps the shortest-arc difference, so crossing the +/-PI seam
      // does not produce a two-pi jump.
      const rawDelta = shortestAngleDelta(this.previousAngle, angle);
      const rotation = rawDelta * this.rotationSpeed;
      if (Math.abs(rotation) >= this.rotationThreshold) {
        this.totalRotation += rotation;
        this.emitGesture({
          type: 'rotate',
          position: centroid.clone(),
          rotation,
          pointerCount: 2,
          source,
        });
      }
    }

    // ---- pan --------------------------------------------------------------
    if (this.enablePan) {
      const dx = centroid.x - this.previousCentroid.x;
      const dy = centroid.y - this.previousCentroid.y;
      const magnitude = Math.hypot(dx, dy);
      if (magnitude >= this.panThreshold) {
        const translation = new Vec2(dx * this.panSpeed, dy * this.panSpeed);
        this.totalTranslation.add(translation);
        this.emitGesture({
          type: 'pan',
          position: centroid.clone(),
          translation,
          pointerCount: 2,
          source,
        });
      }
    }

    this.previousDistance = distance;
    this.previousAngle = angle;
    this.previousCentroid.copy(centroid);

    void this.wheelAccumulator;
  }

  /** Ends the gesture. */
  protected endGesture(source?: TouchEventLike | PointerEventLike): void {
    if (!this.gesturing) return;
    this.gesturing = false;
    this.interacting = false;
    this.emitChangeEnd(createChangeDelta());

    // Report the final cumulative state so a caller can commit it in one step.
    this.emitGesture({
      type: 'pan',
      position: this.previousCentroid.clone(),
      translation: this.totalTranslation.clone(),
      scale: this.totalScale,
      rotation: this.totalRotation,
      pointerCount: this.contacts.size,
      ...(source === undefined ? {} : { source }),
    });
  }

  /* ---------------------------------------------------------------- gestures */

  /**
   * Registers a gesture listener.
   *
   * @param listener Callback.
   * @returns An unsubscribe function.
   */
  public onGesture(listener: GestureListener): () => void {
    this.gestureListeners.add(listener);
    return () => {
      this.gestureListeners.delete(listener);
    };
  }

  /**
   * Removes a gesture listener.
   *
   * @param listener Callback previously passed to {@link GestureControls.onGesture}.
   * @returns `true` when a listener was removed.
   */
  public offGesture(listener: GestureListener): boolean {
    return this.gestureListeners.delete(listener);
  }

  /** Dispatches a gesture to every listener. */
  private emitGesture(gesture: GestureInfo & { deltaScale?: number }): void {
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
   * Gesture recognition is event-driven; this only keeps the interaction flag honest.
   *
   * @param delta Seconds since the previous call; unused.
   * @returns `false`; a gesture control never moves anything by itself.
   */
  public override update(delta: number): boolean {
    void delta;
    return false;
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
   * The current distance between the two contacts.
   *
   * Named `getContactDistance` rather than `getDistance` because `Controls.getDistance`
   * already means "distance from the controlled object to its target"; overloading the
   * name would make one of the two silently wrong at a call site.
   *
   * @returns The distance in CSS pixels, or `0` when fewer than two contacts are down.
   */
  public getContactDistance(): number {
    const [first, second] = Array.from(this.contacts.values());
    if (first === undefined || second === undefined) return 0;
    return first.position.distanceTo(second.position);
  }

  /**
   * The current midpoint of the two contacts.
   *
   * @returns The centroid, or the origin when fewer than two contacts are down.
   */
  public getCentroid(): Vec2 {
    const [first, second] = Array.from(this.contacts.values());
    if (first === undefined || second === undefined) return new Vec2();
    return new Vec2((first.position.x + second.position.x) * 0.5, (first.position.y + second.position.y) * 0.5);
  }

  /**
   * Releases every contact and ends the gesture.
   *
   * @returns The number of contacts released.
   */
  public cancelAll(): number {
    const count = this.contacts.size;
    this.contacts.clear();
    this.endGesture();
    this.gesturing = false;
    this.interacting = false;
    return count;
  }

  /** @inheritdoc */
  protected override onReset(): void {
    this.cancelAll();
    this.totalScale = 1;
    this.totalRotation = 0;
    this.totalTranslation.set(0, 0);
    this.wheelAccumulator = 0;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    this.contacts.clear();
    this.gestureListeners.clear();
    super.onDispose();
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `GestureControls(contacts=${this.contacts.size}, scale=${this.totalScale.toFixed(3)}, ` +
      `rotation=${this.totalRotation.toFixed(3)})`
    );
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

/** Angle of the vector from `a` to `b`, in radians. */
function angleBetween(a: Vec2, b: Vec2): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** Shortest signed angular difference from `a` to `b`, in `(-PI, PI]`. */
function shortestAngleDelta(a: number, b: number): number {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta <= -Math.PI) delta += Math.PI * 2;
  return delta;
}

/**
 * Convenience factory mirroring `new GestureControls(object, element, options)`.
 *
 * @param object Object the control is attached to.
 * @param element Element to attach to.
 * @param options Feature flags and thresholds.
 * @returns A new gesture control.
 */
export function gestureControls(
  object: ControlsObjectLike,
  element: EventTargetLike | null = null,
  options: GestureControlsOptions = {},
): GestureControls {
  return new GestureControls(object, element, options);
}
