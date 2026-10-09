/**
 * `FlyControls` — six-degrees-of-freedom flight, for free-look inspection.
 *
 * Where an orbit control keeps a target in front of the camera, a fly control lets the
 * camera go anywhere and point anywhere, including rolling. It is the right control for
 * flying through an architectural model or a level, and the wrong one for looking at a
 * single object.
 *
 * ## Controls
 *
 * | Input | Effect |
 * | --- | --- |
 * | `W`/`S` | forward / back along the view axis |
 * | `A`/`D` | strafe left / right |
 * | `R`/`F` | move up / down along world `+Y` |
 * | `Q`/`E` | roll left / right |
 * | Arrow keys | pitch and yaw |
 * | Pointer drag | look (only when {@link FlyControls.dragToLook} is set) |
 *
 * ## Why the movement state is a mutable object
 *
 * {@link FlyControls.movementState} is a public mutable record rather than a private
 * field so an application can drive it directly — an on-screen d-pad, a gamepad, a
 * scripted fly-through — without synthesising keyboard events. The keyboard handlers
 * are a *binding* onto that state, not the state itself.
 *
 * ```ts
 * const controls = new FlyControls(camera, canvas);
 * controls.movementSpeed = 20;
 * controls.rollSpeed = Math.PI / 6;
 * controls.dragToLook = true;
 * // each frame:
 * controls.update(clock.getDelta());
 * ```
 *
 * @packageDocumentation
 */

import { Quat } from '../../math/Quat';
import { Vec3 } from '../../math/Vec3';
import { clamp } from '../../utils/MathUtils';
import { Controls } from '../Controls';
import {
  createChangeDelta,
  type ControlsObjectLike,
  type ControlsOptions,
  type EventTargetLike,
  type KeyEventLike,
  type PointerEventLike,
} from '../types';

/** Options accepted by the {@link FlyControls} constructor. */
export interface FlyControlsOptions extends ControlsOptions {
  /** Movement speed in world units per second; defaults to `1`. */
  movementSpeed?: number;
  /** Roll speed in radians per second; defaults to `1`. */
  rollSpeed?: number;
  /** `true` requires a drag to look; defaults to `false` (the camera follows the pointer). */
  dragToLook?: boolean;
  /** `true` keeps moving forward without `W`; defaults to `false`. */
  autoForward?: boolean;
  /** Pitch/yaw speed multiplier for the arrow keys. */
  lookSpeed?: number;
}

/** The mutable movement state a fly control integrates. */
export interface MovementState {
  /** Move up along world `+Y`. */
  up: boolean;
  /** Move down along world `+Y`. */
  down: boolean;
  /** Strafe left. */
  left: boolean;
  /** Strafe right. */
  right: boolean;
  /** Move forward along the view axis. */
  forward: boolean;
  /** Move backward. */
  back: boolean;
  /** Pitch up. */
  pitchUp: boolean;
  /** Pitch down. */
  pitchDown: boolean;
  /** Yaw left. */
  yawLeft: boolean;
  /** Yaw right. */
  yawRight: boolean;
  /** Roll left. */
  rollLeft: boolean;
  /** Roll right. */
  rollRight: boolean;
}

/** A fresh, all-false movement state. */
export function createMovementState(): MovementState {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    forward: false,
    back: false,
    pitchUp: false,
    pitchDown: false,
    yawLeft: false,
    yawRight: false,
    rollLeft: false,
    rollRight: false,
  };
}

/**
 * Six-degrees-of-freedom flight control.
 */
export class FlyControls extends Controls {
  /** Movement speed in world units per second. */
  public movementSpeed = 1;

  /** Roll speed in radians per second. */
  public rollSpeed = 1;

  /** Pitch/yaw speed multiplier for the arrow keys. */
  public lookSpeed = 1;

  /** `true` requires a drag before the pointer looks around. */
  public dragToLook = false;

  /** `true` keeps the camera moving forward without input. */
  public autoForward = false;

  /** Mutable movement state; drive it directly for non-keyboard input. */
  public readonly movementState: MovementState = createMovementState();

  /** Pointer id of the active look drag, or `null`. */
  protected lookPointer: number | null = null;

  /** Last look position, in CSS pixels. */
  protected readonly lastLook = { x: 0, y: 0 };

  /** Accumulated pitch/yaw/roll delta for this frame, in radians. */
  protected readonly rotationDelta = { pitch: 0, yaw: 0, roll: 0 };

  /** Accumulated translation for this frame, in world units. */
  protected readonly translationDelta = new Vec3();

  /** Keys currently held, normalised to code-style names. */
  protected readonly heldKeys = new Set<string>();

  /** Reusable quaternion scratch. */
  private readonly scratchQuat = new Quat();

  /**
   * Creates a fly control.
   *
   * @param object Camera to drive.
   * @param element Element to attach to, or `null`.
   * @param options Speeds and look behaviour.
   */
  constructor(
    object: ControlsObjectLike,
    element: EventTargetLike | null = null,
    options: FlyControlsOptions = {},
  ) {
    super(object, { ...options, domElement: null });

    this.movementSpeed = options.movementSpeed ?? 1;
    this.rollSpeed = options.rollSpeed ?? 1;
    this.lookSpeed = options.lookSpeed ?? 1;
    this.dragToLook = options.dragToLook ?? false;
    this.autoForward = options.autoForward ?? false;

    this.saveState();
    if (element !== null) this.connect(element);
  }

  /* -------------------------------------------------------------- listeners */

  /** @inheritdoc */
  protected override bindListeners(element: EventTargetLike): void {
    this.addDomListener(element, 'keydown', this.handleKeyDown as (event: never) => void);
    this.addDomListener(element, 'keyup', this.handleKeyUp as (event: never) => void);
    this.addDomListener(element, 'pointerdown', this.handlePointerDown as (event: never) => void);
    this.addDomListener(element, 'pointermove', this.handlePointerMove as (event: never) => void);
    this.addDomListener(element, 'pointerup', this.handlePointerUp as (event: never) => void);
    this.addDomListener(element, 'pointercancel', this.handlePointerUp as (event: never) => void);
    this.addDomListener(element, 'contextmenu', this.handleContextMenu as (event: never) => void);
  }

  /* ---------------------------------------------------------------- handlers */

  /** `keydown` handler: latches a movement flag. */
  protected handleKeyDown(event: KeyEventLike): void {
    if (!this.enabled) return;
    const code = normalizeKeyCode(event);
    if (code.length === 0) return;

    this.heldKeys.add(code);
    if (this.applyKeyState(code, true)) this.suppressDefault(event);
  }

  /** `keyup` handler: releases a movement flag. */
  protected handleKeyUp(event: KeyEventLike): void {
    const code = normalizeKeyCode(event);
    if (code.length === 0) return;
    this.heldKeys.delete(code);
    this.applyKeyState(code, false);
  }

  /** `pointerdown` handler. */
  protected handlePointerDown(event: PointerEventLike): void {
    if (!this.enabled) return;
    if (!this.dragToLook) return;
    if (this.lookPointer !== null) return;

    this.suppressDefault(event);
    this.lookPointer = event.pointerId ?? 1;
    this.lastLook.x = event.clientX;
    this.lastLook.y = event.clientY;
    this.interacting = true;
    this.emitChangeStart(createChangeDelta());
  }

  /** `pointermove` handler. */
  protected handlePointerMove(event: PointerEventLike): void {
    if (!this.enabled) return;

    // Without `dragToLook` the camera follows the pointer without a button held,
    // which is how a web-based fly-through usually behaves.
    if (!this.dragToLook) {
      this.lookByPixels(event.movementX ?? 0, event.movementY ?? 0);
      return;
    }

    if (this.lookPointer === null) return;
    const dx = event.clientX - this.lastLook.x;
    const dy = event.clientY - this.lastLook.y;
    this.lastLook.x = event.clientX;
    this.lastLook.y = event.clientY;

    this.suppressDefault(event);
    this.lookByPixels(dx, dy);
  }

  /** `pointerup` handler. */
  protected handlePointerUp(event: PointerEventLike): void {
    if (this.lookPointer === null) return;
    if (event.pointerId !== undefined && event.pointerId !== this.lookPointer) return;
    this.lookPointer = null;
    this.interacting = false;
    this.emitChangeEnd(createChangeDelta());
  }

  /** `contextmenu` handler. */
  protected handleContextMenu(event: PointerEventLike): void {
    if (!this.dragToLook) return;
    this.suppressDefault(event);
  }

  /* ------------------------------------------------------------------ state */

  /**
   * Sets one movement flag.
   *
   * The single place the keyboard binding writes, so a caller driving
   * {@link FlyControls.movementState} directly and a caller pressing a key take
   * identical paths.
   *
   * @param code Normalised key code.
   * @param down `true` on keydown, `false` on keyup.
   * @returns `true` when the code mapped to a movement flag.
   */
  public applyKeyState(code: string, down: boolean): boolean {
    const state = this.movementState;
    switch (code) {
      case 'KeyW':
        state.forward = down;
        return true;
      case 'KeyS':
        state.back = down;
        return true;
      case 'KeyA':
        state.left = down;
        return true;
      case 'KeyD':
        state.right = down;
        return true;
      case 'KeyR':
        state.up = down;
        return true;
      case 'KeyF':
        state.down = down;
        return true;
      case 'KeyQ':
        state.rollLeft = down;
        return true;
      case 'KeyE':
        state.rollRight = down;
        return true;
      case 'ArrowUp':
        state.pitchUp = down;
        return true;
      case 'ArrowDown':
        state.pitchDown = down;
        return true;
      case 'ArrowLeft':
        state.yawLeft = down;
        return true;
      case 'ArrowRight':
        state.yawRight = down;
        return true;
      default:
        return false;
    }
  }

  /**
   * Adds a look delta, in pixels.
   *
   * @param dx Horizontal movement in CSS pixels.
   * @param dy Vertical movement in CSS pixels.
   */
  public lookByPixels(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    // The sign is chosen so that dragging right turns the view right, matching every
    // first-person control.
    this.rotationDelta.yaw -= (Math.PI * 2 * dx) / 1000 * this.lookSpeed;
    this.rotationDelta.pitch -= (Math.PI * 2 * dy) / 1000 * this.lookSpeed;
  }

  /**
   * Clears every movement flag.
   *
   * @returns This control, for chaining.
   */
  public releaseAll(): this {
    const state = this.movementState;
    state.up = false;
    state.down = false;
    state.left = false;
    state.right = false;
    state.forward = false;
    state.back = false;
    state.pitchUp = false;
    state.pitchDown = false;
    state.yawLeft = false;
    state.yawRight = false;
    state.rollLeft = false;
    state.rollRight = false;
    this.heldKeys.clear();
    return this;
  }

  /* --------------------------------------------------------------- update */

  /**
   * Integrates movement and look input.
   *
   * @param delta Seconds since the previous call.
   * @returns `true` when the camera moved.
   */
  public update(delta: number): boolean {
    if (!this.enabled) return false;

    const step = clamp(delta, 0, 0.1);
    const change = createChangeDelta();
    const state = this.movementState;

    // ---- rotation ----------------------------------------------------------
    const rollRate = this.rollSpeed;
    const lookRate = this.lookSpeed;

    if (state.rollLeft) this.rotationDelta.roll += rollRate * step;
    if (state.rollRight) this.rotationDelta.roll -= rollRate * step;
    if (state.pitchUp) this.rotationDelta.pitch += lookRate * step;
    if (state.pitchDown) this.rotationDelta.pitch -= lookRate * step;
    if (state.yawLeft) this.rotationDelta.yaw += lookRate * step;
    if (state.yawRight) this.rotationDelta.yaw -= lookRate * step;

    if (
      this.rotationDelta.pitch !== 0 ||
      this.rotationDelta.yaw !== 0 ||
      this.rotationDelta.roll !== 0
    ) {
      // Apply in the object's own frame: yaw about local Y, pitch about local X, roll
      // about local Z. Composing them as three axis rotations in that order is what
      // gives a fly camera its familiar feel.
      this.scratchQuat.set(0, 0, 0, 1);
      const yaw = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), this.rotationDelta.yaw);
      const pitch = new Quat().setFromAxisAngle(new Vec3(1, 0, 0), this.rotationDelta.pitch);
      const roll = new Quat().setFromAxisAngle(new Vec3(0, 0, 1), this.rotationDelta.roll);

      this.scratchQuat.multiply(yaw).multiply(pitch).multiply(roll).normalize();
      this.object.quaternion.multiply(this.scratchQuat).normalize();

      change.rotated = true;
    }

    this.rotationDelta.pitch = 0;
    this.rotationDelta.yaw = 0;
    this.rotationDelta.roll = 0;

    // ---- translation -------------------------------------------------------
    const quaternion = this.object.quaternion;
    const forward = new Vec3(0, 0, -1).applyQuat(quaternion);
    const right = new Vec3(1, 0, 0).applyQuat(quaternion);
    const up = new Vec3(0, 1, 0);

    const distance = this.movementSpeed * step;
    const move = this.translationDelta;
    move.set(0, 0, 0);

    if (state.forward || this.autoForward) move.addScaledVector(forward, distance);
    if (state.back) move.addScaledVector(forward, -distance);
    if (state.left) move.addScaledVector(right, -distance);
    if (state.right) move.addScaledVector(right, distance);
    if (state.up) move.addScaledVector(up, distance);
    if (state.down) move.addScaledVector(up, -distance);

    if (move.lengthSquared() > 0) {
      this.object.position.add(move);
      change.panned = true;
      move.set(0, 0, 0);
    }

    if (change.rotated || change.panned) {
      this.markObjectDirty();
      this.emitChange(change);
      return true;
    }
    return false;
  }

  /**
   * The camera's forward direction.
   *
   * @param target Vector to write; a new one is allocated when omitted.
   * @returns `target`.
   */
  public getForward(target: Vec3 = new Vec3()): Vec3 {
    return target.set(0, 0, -1).applyQuat(this.object.quaternion).normalize();
  }

  /** @inheritdoc */
  protected override onReset(): void {
    this.releaseAll();
    this.rotationDelta.pitch = 0;
    this.rotationDelta.yaw = 0;
    this.rotationDelta.roll = 0;
    this.translationDelta.set(0, 0, 0);
    this.lookPointer = null;
    this.interacting = false;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    super.onDispose();
    this.releaseAll();
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    const state = this.movementState;
    const active = Object.entries(state)
      .filter(([, value]) => value)
      .map(([key]) => key);
    return (
      `FlyControls(speed=${this.movementSpeed}, rollSpeed=${this.rollSpeed}, ` +
      `dragToLook=${this.dragToLook}, active=[${active.join(',')}])`
    );
  }
}

/** Normalises a key event to a `KeyboardEvent.code`-style name. */
function normalizeKeyCode(event: KeyEventLike): string {
  if (typeof event.code === 'string' && event.code.length > 0) return event.code;
  const key = event.key ?? '';
  if (key.startsWith('Arrow')) return key;
  return key.length === 1 ? `Key${key.toUpperCase()}` : key;
}

/**
 * Convenience factory mirroring `new FlyControls(object, element, options)`.
 *
 * @param object Camera to drive.
 * @param element Element to attach to.
 * @param options Speeds and look behaviour.
 * @returns A new fly control.
 */
export function flyControls(
  object: ControlsObjectLike,
  element: EventTargetLike | null = null,
  options: FlyControlsOptions = {},
): FlyControls {
  return new FlyControls(object, element, options);
}
