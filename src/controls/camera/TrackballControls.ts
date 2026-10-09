/**
 * `TrackballControls` — free rotation with no gimbal lock and no up-vector.
 *
 * An orbit control constrains the camera to a sphere parameterised by *azimuth and
 * polar angle about a fixed up vector*. That constraint is convenient, and it is also
 * exactly what produces gimbal lock: as the camera approaches the pole the azimuth
 * becomes undefined and the view snaps.
 *
 * A trackball has no such parameterisation. A pointer position is projected onto a
 * virtual sphere **in front of the camera**, and the rotation between the sphere
 * points under the previous and current pointer is applied directly as a quaternion.
 * There is no pole to fall through, the camera can be rolled (brought upside down),
 * and a drag of a given length always rotates the scene by the same visual amount —
 * the property that makes a trackball feel attached to the object.
 *
 * ```
 *   screen                       virtual sphere
 *     +----------------+              .-''-.
 *     |            o   |            .'      '.     o
 *     |           /    |  project  (    .     )   /
 *     |    centre+     |  ------->   '.    .'   +    rotate by
 *     |                |               '----'         the arc between
 *     +----------------+                              the two points
 * ```
 *
 * ## Damping
 *
 * {@link TrackballControls.staticMoving} turns damping off entirely (the camera stops
 * the instant the pointer does). With it off, {@link TrackballControls.dynamicDampingFactor}
 * scales how long the momentum lasts — implemented as an `update()` that keeps applying
 * a decaying share of the last delta, not as a spring, so the motion stays predictable.
 *
 * ## Roll
 *
 * {@link TrackballControls.noRoll} (the default) removes the roll component from each
 * rotation, keeping the horizon level. `noRoll = false` allows full free rotation,
 * which is what inspecting a model from arbitrary angles wants.
 *
 * ```ts
 * const controls = new TrackballControls(camera, canvas);
 * controls.rotateSpeed = 2;
 * controls.staticMoving = false;
 * ```
 *
 * @packageDocumentation
 */

import { Quat } from '../../math/Quat';
import { Vec3 } from '../../math/Vec3';
import { clamp, clamp01 } from '../../utils/MathUtils';
import { Controls } from '../Controls';
import {
  createChangeDelta,
  type ControlsObjectLike,
  type ControlsOptions,
  type EventTargetLike,
  type KeyEventLike,
  type PointerEventLike,
  type WheelEventLike,
} from '../types';

/** Options accepted by the {@link TrackballControls} constructor. */
export interface TrackballControlsOptions extends ControlsOptions {
  /** Rotation sensitivity; defaults to `1`. */
  rotateSpeed?: number;
  /** Dolly sensitivity; defaults to `1.2`. */
  zoomSpeed?: number;
  /** Pan sensitivity; defaults to `0.3`. */
  panSpeed?: number;
  /** `true` stops the camera as soon as the pointer does; defaults to `false`. */
  staticMoving?: boolean;
  /** Momentum retention per frame in `[0, 1]`; defaults to `0.2`. */
  dynamicDampingFactor?: number;
  /** Minimum camera distance; defaults to `0`. */
  minDistance?: number;
  /** Maximum camera distance; defaults to `Infinity`. */
  maxDistance?: number;
  /** `true` (the default) keeps the horizon level. */
  noRoll?: boolean;
  /** `true` disables rotation. */
  noRotate?: boolean;
  /** `true` disables the dolly. */
  noZoom?: boolean;
  /** `true` disables panning. */
  noPan?: boolean;
  /** Reference height used to normalise pixel drags; defaults to `clientHeight`. */
  screenHeight?: number;
}

/** One of the six faces of the virtual trackball sphere. */
type BallFace = 'z+' | 'z-' | 'x+' | 'x-' | 'y+' | 'y-' | 'none';

/**
 * Free-rotation trackball control.
 */
export class TrackballControls extends Controls {
  /** Rotation sensitivity. */
  public rotateSpeed = 1;

  /** Dolly sensitivity. */
  public zoomSpeed = 1.2;

  /** Pan sensitivity. */
  public panSpeed = 0.3;

  /** `true` stops the camera when the pointer stops. */
  public staticMoving = false;

  /** Momentum retention per frame in `[0, 1]`. */
  public dynamicDampingFactor = 0.2;

  /** Minimum camera distance. */
  public minDistance = 0;

  /** Maximum camera distance. */
  public maxDistance = Infinity;

  /** `true` keeps the horizon level by discarding roll. */
  public noRoll = true;

  /** `true` disables rotation. */
  public noRotate = false;

  /** `true` disables the dolly. */
  public noZoom = false;

  /** `true` disables panning. */
  public noPan = false;

  /**
   * Reference height for pixel-to-angle scaling.
   *
   * Defaults to the element's `clientHeight`; supply a number when the control is
   * driven headlessly.
   */
  public screenHeight: number | null = null;

  /** Rotation delta accumulated since the last `update`, as a quaternion. */
  public readonly rotateDelta = new Quat();

  /** Pan delta in world units, accumulated since the last `update`. */
  public readonly panDelta = new Vec3();

  /** Dolly scale accumulated since the last `update`. */
  public zoomScale = 1;

  /** Mutable object the eye/target are read from, kept for three.js parity. */
  public readonly eye = new Vec3();

  /** Look-at point. */
  public readonly lookAt = new Vec3();

  /** Last rotation applied, replayed while damping. */
  protected readonly lastRotation = new Quat();

  /** Last pan applied, replayed while damping. */
  protected readonly lastPan = new Vec3();

  /** Previous pointer position on the virtual sphere. */
  protected readonly lastBallPoint = new Vec3();

  /** Pointer id of the active drag, or `null`. */
  protected dragPointer: number | null = null;

  /** Button that started the drag. */
  protected dragButton = -1;

  /** Keyboard state for arrow-key panning and `+`/`-` dolly. */
  protected readonly keys = new Set<string>();

  /** Reusable quaternion scratch. */
  private readonly scratchQuat = new Quat();

  /** Reusable vector scratch. */
  private readonly scratchVec = new Vec3();

  /**
   * Creates a trackball control.
   *
   * @param object Camera to drive.
   * @param element Element to attach to, or `null`.
   * @param options Speeds, damping and feature flags.
   */
  constructor(
    object: ControlsObjectLike,
    element: EventTargetLike | null = null,
    options: TrackballControlsOptions = {},
  ) {
    super(object, { ...options, domElement: null });

    this.rotateSpeed = options.rotateSpeed ?? 1;
    this.zoomSpeed = options.zoomSpeed ?? 1.2;
    this.panSpeed = options.panSpeed ?? 0.3;
    this.staticMoving = options.staticMoving ?? false;
    this.dynamicDampingFactor = clamp01(options.dynamicDampingFactor ?? 0.2);
    this.minDistance = options.minDistance ?? 0;
    this.maxDistance = options.maxDistance ?? Infinity;
    this.noRoll = options.noRoll ?? true;
    this.noRotate = options.noRotate ?? false;
    this.noZoom = options.noZoom ?? false;
    this.noPan = options.noPan ?? false;
    this.screenHeight = options.screenHeight ?? null;

    this.eye.copy(object.position);
    this.lookAt.copy(this.target);

    this.saveState();
    if (element !== null) this.connect(element);
  }

  /* -------------------------------------------------------------- listeners */

  /** @inheritdoc */
  protected override bindListeners(element: EventTargetLike): void {
    this.addDomListener(element, 'pointerdown', this.handlePointerDown as (event: never) => void);
    this.addDomListener(element, 'pointermove', this.handlePointerMove as (event: never) => void);
    this.addDomListener(element, 'pointerup', this.handlePointerUp as (event: never) => void);
    this.addDomListener(element, 'pointercancel', this.handlePointerUp as (event: never) => void);
    this.addDomListener(element, 'wheel', this.handleWheel as (event: never) => void, { passive: false });
    this.addDomListener(element, 'contextmenu', this.handleContextMenu as (event: never) => void);
    this.addDomListener(element, 'keydown', this.handleKeyDown as (event: never) => void);
    this.addDomListener(element, 'keyup', this.handleKeyUp as (event: never) => void);
  }

  /* ---------------------------------------------------------------- handlers */

  /** `pointerdown` handler. */
  protected handlePointerDown(event: PointerEventLike): void {
    if (!this.enabled || event.pointerType === 'touch') return;
    if (this.dragPointer !== null) return;

    this.suppressDefault(event);
    this.dragPointer = event.pointerId ?? 1;
    this.dragButton = event.button ?? 0;
    this.interacting = true;

    this.projectOnBall(event.clientX, event.clientY, this.lastBallPoint);
    this.emitChangeStart(createChangeDelta());
  }

  /** `pointermove` handler. */
  protected handlePointerMove(event: PointerEventLike): void {
    if (!this.enabled || this.dragPointer === null) return;
    if (event.pointerType === 'touch') return;

    this.suppressDefault(event);

    const button = this.dragButton;
    if ((button === 0 || button === 1) && !this.noRotate) {
      const ballPoint = this.projectOnBall(event.clientX, event.clientY, this.scratchVec);
      this.rotateCamera(this.lastBallPoint, ballPoint);
      this.lastBallPoint.copy(ballPoint);
      return;
    }

    if (button === 2 && !this.noPan) {
      this.panByPixels(event.movementX ?? 0, event.movementY ?? 0);
    }
  }

  /** `pointerup`/`pointercancel` handler. */
  protected handlePointerUp(event: PointerEventLike): void {
    if (this.dragPointer === null) return;
    if (event.pointerId !== undefined && event.pointerId !== this.dragPointer) return;
    this.dragPointer = null;
    this.dragButton = -1;
    this.interacting = false;
    this.emitChangeEnd(createChangeDelta());
  }

  /** `wheel` handler. */
  protected handleWheel(event: WheelEventLike): void {
    if (!this.enabled || this.noZoom) return;
    this.suppressDefault(event);
    const notches = (event.deltaY ?? 0) / 100;
    this.zoomScale *= Math.pow(0.95, this.zoomSpeed * notches);
  }

  /** `contextmenu` handler. */
  protected handleContextMenu(event: PointerEventLike): void {
    if (!this.enabled || this.noPan) return;
    this.suppressDefault(event);
  }

  /** `keydown` handler. */
  protected handleKeyDown(event: KeyEventLike): void {
    if (!this.enabled) return;
    const code = normalizeKey(event);
    if (code.length === 0) return;
    this.keys.add(code);
    this.suppressDefault(event);
  }

  /** `keyup` handler. */
  protected handleKeyUp(event: KeyEventLike): void {
    this.keys.delete(normalizeKey(event));
  }

  /* -------------------------------------------------------------- geometry */

  /**
   * Projects a pointer position onto the virtual trackball.
   *
   * The sphere has radius 1 and is centred at the element's midpoint. Outside the
   * sphere's silhouette the projection falls back to a hyperbola, which is what makes
   * a drag near the edge of the viewport still produce a sensible rotation instead of
   * a discontinuity.
   *
   * @param clientX Pointer X in CSS pixels.
   * @param clientY Pointer Y in CSS pixels.
   * @param target Vector to write.
   * @returns `target`, normalised.
   */
  public projectOnBall(clientX: number, clientY: number, target: Vec3 = new Vec3()): Vec3 {
    const width = readNumeric(this.domElement, 'clientWidth', 1);
    const height = this.screenHeight ?? readNumeric(this.domElement, 'clientHeight', 1);

    // Normalise to [-1, 1] with the origin at the element's midpoint and `+y` up.
    const x = ((clientX - width * 0.5) / (width * 0.5)) * this.rotateSpeed;
    const y = (-(clientY - height * 0.5) / (height * 0.5)) * this.rotateSpeed;

    const lengthSquared = x * x + y * y;

    if (lengthSquared <= 0.25) {
      // Inside the unit circle: the point is on the sphere's near hemisphere.
      target.set(x, y, Math.sqrt(1 - lengthSquared));
    } else {
      // Outside: project onto the hyperbola so the mapping stays continuous.
      const scale = 1 / Math.sqrt(lengthSquared);
      target.set(x * scale, y * scale, 0);
    }

    return target.normalize();
  }

  /**
   * Rotates the camera by the arc between two points on the virtual sphere.
   *
   * @param from Previous sphere point.
   * @param to Current sphere point.
   */
  public rotateCamera(from: Vec3, to: Vec3): void {
    if (this.noRotate) return;

    // The rotation axis is the cross product of the two sphere points, and the angle
    // is the angle between them — the exact rotation that carries one onto the other.
    const axis = new Vec3().crossVectors(from, to);
    const length = axis.length();

    if (length < 1e-9) return;

    axis.multiplyScalar(1 / length);
    const angle = Math.acos(clamp(from.dot(to), -1, 1)) * this.rotateSpeed;

    this.scratchQuat.setFromAxisAngle(axis, angle);

    if (this.noRoll) {
      // Remove the component of the axis that points along the view direction, which
      // is precisely the roll component.
      const view = new Vec3().subVectors(this.lookAt, this.eye).normalize();
      const rollComponent = view.clone().multiplyScalar(view.dot(axis));
      const flatAxis = axis.clone().sub(rollComponent);
      if (flatAxis.lengthSquared() < 1e-12) return;
      flatAxis.normalize();
      this.scratchQuat.setFromAxisAngle(flatAxis, angle);
    }

    this.lastRotation.copy(this.scratchQuat);
    this.rotateDelta.premultiply(this.scratchQuat);
  }

  /**
   * Pans the camera and target by a pixel delta.
   *
   * @param dx Horizontal movement in CSS pixels.
   * @param dy Vertical movement in CSS pixels.
   */
  public panByPixels(dx: number, dy: number): void {
    if (this.noPan || (dx === 0 && dy === 0)) return;

    const height = this.screenHeight ?? readNumeric(this.domElement, 'clientHeight', 1);
    const distance = Math.max(this.eye.distanceTo(this.lookAt), this.minDistance);
    const worldPerPixel = (2 * distance) / height;

    const quaternion = this.object.quaternion;
    const right = new Vec3().set(1, 0, 0).applyQuat(quaternion).normalize();
    const up = new Vec3().set(0, 1, 0).applyQuat(quaternion).normalize();

    this.panDelta
      .addScaledVector(right, -dx * worldPerPixel * this.panSpeed)
      .addScaledVector(up, dy * worldPerPixel * this.panSpeed);

    this.lastPan.copy(this.panDelta);
  }

  /**
   * Dollys the camera by a scale factor.
   *
   * @param scale Scale to apply; `> 1` moves away from the target.
   */
  public zoomCamera(scale: number): void {
    if (this.noZoom || scale === 1) return;
    const offset = new Vec3().subVectors(this.eye, this.lookAt);
    const radius = clamp(offset.length() * scale, this.minDistance, this.maxDistance);
    offset.setLength(radius);
    this.eye.copy(this.lookAt).add(offset);
  }

  /* --------------------------------------------------------------- update */

  /**
   * Applies the accumulated rotation, pan and dolly.
   *
   * @param delta Seconds since the previous call; only used for keyboard panning.
   * @returns `true` when the camera moved.
   */
  public update(delta: number): boolean {
    if (!this.enabled) return false;

    const change = createChangeDelta();

    // ---- keyboard panning ---------------------------------------------------
    if (!this.noPan && this.keys.size > 0) {
      const speed = this.panSpeed * 500 * Math.max(0, delta);
      if (this.keys.has('ArrowUp')) this.panByPixels(0, speed);
      if (this.keys.has('ArrowDown')) this.panByPixels(0, -speed);
      if (this.keys.has('ArrowLeft')) this.panByPixels(speed, 0);
      if (this.keys.has('ArrowRight')) this.panByPixels(-speed, 0);
    }

    if (!this.noZoom && this.keys.size > 0) {
      if (this.keys.has('Equal')) this.zoomScale *= 0.98;
      if (this.keys.has('Minus')) this.zoomScale *= 1.02;
    }

    // ---- dolly --------------------------------------------------------------
    if (this.zoomScale !== 1) {
      const applied = this.staticMoving ? this.zoomScale : 1 + (this.zoomScale - 1) * (1 - this.dynamicDampingFactor);
      this.zoomCamera(applied);
      if (this.staticMoving) this.zoomScale = 1;
      else {
        this.zoomScale = 1 + (this.zoomScale - 1) * this.dynamicDampingFactor;
        if (Math.abs(this.zoomScale - 1) < 1e-6) this.zoomScale = 1;
      }
      change.zoomed = true;
    }

    // ---- pan ---------------------------------------------------------------
    if (this.panDelta.lengthSquared() > 0) {
      const applied = this.staticMoving ? this.panDelta.clone() : this.panDelta.clone().multiplyScalar(1 - this.dynamicDampingFactor);
      this.eye.add(applied);
      this.lookAt.add(applied);
      if (this.staticMoving) this.panDelta.set(0, 0, 0);
      else {
        this.panDelta.multiplyScalar(this.dynamicDampingFactor);
        if (this.panDelta.lengthSquared() < 1e-12) this.panDelta.set(0, 0, 0);
      }
      change.panned = true;
    }

    // ---- rotate ------------------------------------------------------------
    if (!this.noRotate && this.rotateDelta.lengthSquared() > 1e-18) {
      // Rotate the eye about the look-at point, then rotate the camera's own
      // orientation, so the object stays framed while the view tumbles.
      const offset = new Vec3().subVectors(this.eye, this.lookAt);
      offset.applyQuat(this.rotateDelta);
      this.eye.copy(this.lookAt).add(offset);

      this.object.quaternion.premultiply(this.rotateDelta).normalize();

      if (this.staticMoving) {
        this.rotateDelta.set(0, 0, 0, 1);
      } else {
        // Blend the delta back toward identity so the motion decays.
        const identity = new Quat();
        this.rotateDelta.slerpQuaternions(this.rotateDelta, identity, this.dynamicDampingFactor);
        if (Math.abs(this.rotateDelta.w) > 1 - 1e-6) this.rotateDelta.set(0, 0, 0, 1);
      }
      change.rotated = true;
    }

    this.object.position.copy(this.eye);
    this.target.copy(this.lookAt);

    if (change.rotated || change.panned || change.zoomed) {
      this.markObjectDirty();
      this.emitChange(change);
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- state */

  /**
   * Copies the object's transform into the control's own eye/target.
   *
   * @returns This control, for chaining.
   */
  public syncFromObject(): this {
    this.eye.copy(this.object.position);
    this.lookAt.copy(this.target);
    return this;
  }

  /**
   * Copies the control's eye/target back onto the object.
   *
   * @returns This control, for chaining.
   */
  public syncToObject(): this {
    this.object.position.copy(this.eye);
    this.lookAtTarget();
    return this;
  }

  /**
   * Reinflates the camera from the saved state.
   *
   * @param state Saved state.
   */
  protected override onReset(state: import('../types').ControlsState): void {
    this.eye.set(state.position[0], state.position[1], state.position[2]);
    this.lookAt.set(state.target[0], state.target[1], state.target[2]);
    this.rotateDelta.set(0, 0, 0, 1);
    this.panDelta.set(0, 0, 0);
    this.zoomScale = 1;
    this.dragPointer = null;
    this.interacting = false;
    this.keys.clear();
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    super.onDispose();
    this.keys.clear();
    this.rotateDelta.set(0, 0, 0, 1);
    this.panDelta.set(0, 0, 0);
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `TrackballControls(distance=${this.eye.distanceTo(this.lookAt).toFixed(3)}, ` +
      `staticMoving=${this.staticMoving}, noRoll=${this.noRoll})`
    );
  }
}

/** Reads a numeric property off an element-like host, with a fallback. */
function readNumeric(element: EventTargetLike | null, key: string, fallback: number): number {
  if (element === null) return fallback;
  const value = (element as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' && value > 0 ? value : fallback;
}

/** Normalises a key event to a code-style name. */
function normalizeKey(event: KeyEventLike): string {
  if (typeof event.code === 'string' && event.code.length > 0) return event.code;
  const key = event.key ?? '';
  if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') return key;
  if (key === '+') return 'Equal';
  if (key === '-') return 'Minus';
  return key.length === 1 ? `Key${key.toUpperCase()}` : key;
}

/**
 * Convenience factory mirroring `new TrackballControls(object, element, options)`.
 *
 * @param object Camera to drive.
 * @param element Element to attach to.
 * @param options Speeds, damping and feature flags.
 * @returns A new trackball control.
 */
export function trackballControls(
  object: ControlsObjectLike,
  element: EventTargetLike | null = null,
  options: TrackballControlsOptions = {},
): TrackballControls {
  return new TrackballControls(object, element, options);
}
