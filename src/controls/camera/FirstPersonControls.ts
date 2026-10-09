/**
 * `FirstPersonControls` — a walking camera with a pitch clamp and a head bob.
 *
 * This is the "on foot" control: the camera stays at eye height above a target,
 * looking is bounded by {@link FirstPersonControls.verticalMin} and
 * {@link FirstPersonControls.verticalMax} so you cannot look past straight up or
 * straight down, and there is an optional {@link FirstPersonControls.heightSpeed}
 * bob that makes movement read as walking rather than gliding.
 *
 * ## Difference from `FlyControls`
 *
 * A fly camera is unconstrained: it can roll and go upside down. A first-person
 * camera is *deliberately* constrained — the horizon stays level and the vertical
 * look is clamped — which is what makes it usable as a walking camera rather than
 * disorienting.
 *
 * | Behaviour | FlyControls | FirstPersonControls |
 * | --- | --- | --- |
 * | Roll | yes | no (horizon locked) |
 * | Vertical look | unlimited | clamped by `verticalMin`/`verticalMax` |
 * | Up/down movement | world axis | optional head bob instead |
 * | Look activation | `dragToLook` | `activeLook` |
 *
 * ## Look activation
 *
 * With {@link FirstPersonControls.activeLook} set (the default), looking follows the
 * pointer position whenever it is inside the element — no button needed — and
 * {@link FirstPersonControls.mouseDragOn} is true while a button is held.
 * `activeLook = false` restores the drag-to-look behaviour.
 *
 * ```ts
 * const controls = new FirstPersonControls(camera, canvas);
 * controls.movementSpeed = 8;
 * controls.lookSpeed = 0.1;
 * controls.heightSpeed = true;
 * // each frame:
 * controls.update(clock.getDelta());
 * ```
 *
 * @packageDocumentation
 */

import { Quat } from '../../math/Quat';
import { Vec3 } from '../../math/Vec3';
import { clamp, smoothstep } from '../../utils/MathUtils';
import { Controls } from '../Controls';
import {
  createChangeDelta,
  type ControlsObjectLike,
  type ControlsOptions,
  type EventTargetLike,
  type KeyEventLike,
  type PointerEventLike,
} from '../types';

/** Options accepted by the {@link FirstPersonControls} constructor. */
export interface FirstPersonControlsOptions extends ControlsOptions {
  /** Movement speed in world units per second; defaults to `1`. */
  movementSpeed?: number;
  /** Look sensitivity; defaults to `0.005`. */
  lookSpeed?: number;
  /** `true` (the default) allows vertical looking. */
  lookVertical?: boolean;
  /** `true` (the default) looks without a button held. */
  activeLook?: boolean;
  /** `true` modulates movement speed by the head-bob curve. */
  heightSpeed?: boolean;
  /** Amplitude of the speed modulation in `[0, 1]`; defaults to `0.5`. */
  heightCoef?: number;
  /** Bottom of the bob's speed range; defaults to `0`. */
  heightMin?: number;
  /** Top of the bob's speed range; defaults to `1`. */
  heightMax?: number;
  /** `true` keeps moving forward without input. */
  autoForward?: boolean;
  /** `true` clamps the vertical look to the configured window; defaults to `true`. */
  constrainVertical?: boolean;
  /** Lower vertical look bound, in radians; defaults to `-PI/2`. */
  verticalMin?: number;
  /** Upper vertical look bound, in radians; defaults to `PI/2`. */
  verticalMax?: number;
}

/**
 * Walking first-person camera control.
 */
export class FirstPersonControls extends Controls {
  /** Movement speed in world units per second. */
  public movementSpeed = 1;

  /** Look sensitivity per pixel. */
  public lookSpeed = 0.005;

  /** `true` allows vertical looking. */
  public lookVertical = true;

  /** `true` looks without a button held. */
  public activeLook = true;

  /** `true` modulates movement speed by the head-bob curve. */
  public heightSpeed = false;

  /** Amplitude of the speed modulation. */
  public heightCoef = 0.5;

  /** Bottom of the bob's speed range. */
  public heightMin = 0;

  /** Top of the bob's speed range. */
  public heightMax = 1;

  /** `true` keeps moving forward without input. */
  public autoForward = false;

  /** `true` clamps the vertical look to the configured window. */
  public constrainVertical = true;

  /** Lower vertical look bound, in radians. */
  public verticalMin = -Math.PI / 2;

  /** Upper vertical look bound, in radians. */
  public verticalMax = Math.PI / 2;

  /** `true` while a button is held, when `activeLook` is off. */
  public mouseDragOn = false;

  /** Normalised pointer position inside the element, in `[-1, 1]`. */
  public readonly pointer = { x: 0, y: 0 };

  /** Total distance travelled, used by the head bob. */
  public distanceTravelled = 0;

  /** Current pitch, in radians. */
  public pitch = 0;

  /** Current yaw, in radians. */
  public yaw = 0;

  /** Latched movement input, matching {@link FlyControls.movementState}. */
  public readonly movement = {
    forward: false,
    back: false,
    left: false,
    right: false,
  };

  /** Keys currently held. */
  protected readonly heldKeys = new Set<string>();

  /** Pointer id of the active drag, or `null`. */
  protected dragPointer: number | null = null;

  /**
   * Creates a first-person control.
   *
   * @param object Camera to drive.
   * @param element Element to attach to, or `null`.
   * @param options Speeds, look behaviour and bob configuration.
   */
  constructor(
    object: ControlsObjectLike,
    element: EventTargetLike | null = null,
    options: FirstPersonControlsOptions = {},
  ) {
    super(object, { ...options, domElement: null });

    this.movementSpeed = options.movementSpeed ?? 1;
    this.lookSpeed = options.lookSpeed ?? 0.005;
    this.lookVertical = options.lookVertical ?? true;
    this.activeLook = options.activeLook ?? true;
    this.heightSpeed = options.heightSpeed ?? false;
    this.heightCoef = clamp(options.heightCoef ?? 0.5, 0, 1);
    this.heightMin = options.heightMin ?? 0;
    this.heightMax = options.heightMax ?? 1;
    this.autoForward = options.autoForward ?? false;
    this.constrainVertical = options.constrainVertical ?? true;
    this.verticalMin = options.verticalMin ?? -Math.PI / 2;
    this.verticalMax = options.verticalMax ?? Math.PI / 2;

    const euler = this.object.quaternion.toEuler();
    this.pitch = euler.x;
    this.yaw = euler.y;

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
    this.addDomListener(element, 'pointerleave', this.handlePointerLeave as (event: never) => void);
    this.addDomListener(element, 'contextmenu', this.handleContextMenu as (event: never) => void);
  }

  /* ---------------------------------------------------------------- handlers */

  /** `keydown` handler. */
  protected handleKeyDown(event: KeyEventLike): void {
    if (!this.enabled) return;
    const code = normalizeKeyCode(event);
    if (code.length === 0) return;
    this.heldKeys.add(code);
    if (this.applyKeyState(code, true)) this.suppressDefault(event);
  }

  /** `keyup` handler. */
  protected handleKeyUp(event: KeyEventLike): void {
    const code = normalizeKeyCode(event);
    if (code.length === 0) return;
    this.heldKeys.delete(code);
    this.applyKeyState(code, false);
  }

  /** `pointerdown` handler. */
  protected handlePointerDown(event: PointerEventLike): void {
    if (!this.enabled) return;
    if (this.activeLook && event.button !== undefined && event.button !== 0) return;

    this.dragPointer = event.pointerId ?? 1;
    this.mouseDragOn = true;
    if (!this.activeLook) this.suppressDefault(event);
    this.emitChangeStart(createChangeDelta());
  }

  /** `pointermove` handler. */
  protected handlePointerMove(event: PointerEventLike): void {
    if (!this.enabled || !this.lookVertical && !this.activeLook) {
      // Even with vertical looking off, the pointer position is still tracked so a
      // caller can read it.
    }

    const width = readDimension(this.domElement, 'clientWidth', 1);
    const height = readDimension(this.domElement, 'clientHeight', 1);

    this.pointer.x = clamp((event.clientX / width) * 2 - 1, -1, 1);
    this.pointer.y = clamp(-((event.clientY / height) * 2 - 1), -1, 1);

    if (!this.activeLook && !this.mouseDragOn) return;
    if (this.activeLook) this.suppressDefault(event);
  }

  /** `pointerup` handler. */
  protected handlePointerUp(event: PointerEventLike): void {
    if (this.dragPointer !== null && event.pointerId !== undefined && event.pointerId !== this.dragPointer) {
      return;
    }
    this.dragPointer = null;
    this.mouseDragOn = false;
    this.emitChangeEnd(createChangeDelta());
  }

  /** `pointerleave` handler: relax the look input so the camera stops turning. */
  protected handlePointerLeave(_event: PointerEventLike): void {
    this.mouseDragOn = false;
  }

  /** `contextmenu` handler. */
  protected handleContextMenu(event: PointerEventLike): void {
    this.suppressDefault(event);
  }

  /* ------------------------------------------------------------------ state */

  /**
   * Sets one movement flag.
   *
   * @param code Normalised key code.
   * @param down `true` on keydown.
   * @returns `true` when the code mapped to a movement flag.
   */
  public applyKeyState(code: string, down: boolean): boolean {
    switch (code) {
      case 'KeyW':
        this.movement.forward = down;
        return true;
      case 'KeyS':
        this.movement.back = down;
        return true;
      case 'KeyA':
        this.movement.left = down;
        return true;
      case 'KeyD':
        this.movement.right = down;
        return true;
      default:
        return false;
    }
  }

  /**
   * Clears every movement flag and the look state.
   *
   * @returns This control, for chaining.
   */
  public releaseAll(): this {
    this.movement.forward = false;
    this.movement.back = false;
    this.movement.left = false;
    this.movement.right = false;
    this.heldKeys.clear();
    this.mouseDragOn = false;
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

    // ---- look --------------------------------------------------------------
    if (this.lookVertical || this.activeLook) {
      const previousYaw = this.yaw;
      const previousPitch = this.pitch;

      this.yaw -= this.pointer.x * this.lookSpeed * (step * 60);
      if (this.lookVertical) {
        this.pitch -= this.pointer.y * this.lookSpeed * (step * 60);
      }

      if (this.constrainVertical) {
        this.pitch = clamp(this.pitch, this.verticalMin, this.verticalMax);
      }

      if (this.yaw !== previousYaw || this.pitch !== previousPitch) {
        this.applyOrientation();
        change.rotated = true;
        change.azimuth = this.yaw - previousYaw;
        change.polar = this.pitch - previousPitch;
      }
    }

    // ---- movement ----------------------------------------------------------
    let speed = this.movementSpeed;
    if (this.heightSpeed) {
      // A smoothstep of the travelled distance gives a natural slow-in/out bob.
      const bob = smoothstep(0, 1, Math.abs(Math.sin(this.distanceTravelled * 0.5)));
      speed = this.movementSpeed * (this.heightMin + bob * (this.heightMax - this.heightMin) * this.heightCoef);
    }

    const distance = speed * step;
    const forward = new Vec3(0, 0, -1).applyQuat(this.object.quaternion);
    forward.y = 0;
    forward.normalize();
    const right = new Vec3(1, 0, 0).applyQuat(this.object.quaternion);
    right.y = 0;
    right.normalize();

    const move = new Vec3();
    if (this.movement.forward || this.autoForward) move.addScaledVector(forward, distance);
    if (this.movement.back) move.addScaledVector(forward, -distance);
    if (this.movement.left) move.addScaledVector(right, -distance);
    if (this.movement.right) move.addScaledVector(right, distance);

    if (move.lengthSquared() > 0) {
      this.object.position.add(move);
      this.distanceTravelled += Math.sqrt(move.lengthSquared());
      change.panned = true;
    }

    if (change.rotated || change.panned) {
      this.markObjectDirty();
      this.emitChange(change);
      return true;
    }
    return false;
  }

  /** Writes {@link FirstPersonControls.yaw} and `pitch` onto the object. */
  protected applyOrientation(): void {
    // A first-person camera never rolls, so the orientation is a pure yaw-then-pitch
    // composition rather than a general quaternion.
    const yawQuat = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), this.yaw);
    const pitchQuat = new Quat().setFromAxisAngle(new Vec3(1, 0, 0), this.pitch);
    this.object.quaternion.copy(yawQuat).multiply(pitchQuat).normalize();
  }

  /**
   * Aims the camera at an explicit direction.
   *
   * @param direction Direction to look along; normalised internally.
   * @returns This control, for chaining.
   */
  public setDirection(direction: Vec3): this {
    const normalized = direction.clone().normalize();
    this.yaw = Math.atan2(-normalized.x, -normalized.z);
    this.pitch = Math.asin(clamp(normalized.y, -1, 1));
    if (this.constrainVertical) {
      this.pitch = clamp(this.pitch, this.verticalMin, this.verticalMax);
    }
    this.applyOrientation();
    return this;
  }

  /**
   * Looks at a world point.
   *
   * @param position Point to look at.
   * @param target The camera's own position; defaults to `object.position`.
   * @param delta Seconds since the previous call; accepted for signature parity with
   *   the three.js API and unused.
   * @returns This control, for chaining.
   */
  public lookAt(position: Vec3, target: Vec3 = this.object.position, delta = 0): this {
    void delta;
    const direction = new Vec3().subVectors(position, target);
    return this.setDirection(direction);
  }

  /** @inheritdoc */
  protected override onReset(): void {
    this.releaseAll();
    this.pointer.x = 0;
    this.pointer.y = 0;
    this.distanceTravelled = 0;
    this.dragPointer = null;
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
    return (
      `FirstPersonControls(speed=${this.movementSpeed}, lookSpeed=${this.lookSpeed}, ` +
      `pitch=${this.pitch.toFixed(3)}, yaw=${this.yaw.toFixed(3)})`
    );
  }
}

/** Reads a numeric dimension off an element-like host. */
function readDimension(element: EventTargetLike | null, key: string, fallback: number): number {
  if (element === null) return fallback;
  const value = (element as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' && value > 0 ? value : fallback;
}

/** Normalises a key event to a `KeyboardEvent.code`-style name. */
function normalizeKeyCode(event: KeyEventLike): string {
  if (typeof event.code === 'string' && event.code.length > 0) return event.code;
  const key = event.key ?? '';
  if (key.startsWith('Arrow')) return key;
  return key.length === 1 ? `Key${key.toUpperCase()}` : key;
}

/**
 * Convenience factory mirroring `new FirstPersonControls(object, element, options)`.
 *
 * @param object Camera to drive.
 * @param element Element to attach to.
 * @param options Speeds, look behaviour and bob configuration.
 * @returns A new first-person control.
 */
export function firstPersonControls(
  object: ControlsObjectLike,
  element: EventTargetLike | null = null,
  options: FirstPersonControlsOptions = {},
): FirstPersonControls {
  return new FirstPersonControls(object, element, options);
}
