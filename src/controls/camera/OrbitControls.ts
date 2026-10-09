/**
 * `OrbitControls` — rotate, zoom and pan around a target point.
 *
 * The workhorse camera control: a spherical orbit about {@link Controls.target}, with
 * a dolly that changes the radius, a screen-space pan that moves the target, and
 * damping that smooths all three.
 *
 * ## Input map
 *
 * | Input | Left | Middle | Right | Wheel |
 * | --- | --- | --- | --- | --- |
 * | Mouse | rotate | dolly | pan | dolly |
 *
 * | Input | 1 finger | 2 fingers |
 * | --- | --- | --- |
 * | Touch | rotate | pinch dolly + pan |
 *
 * Every one of those can be switched off individually (`enableRotate`, `enableZoom`,
 * `enablePan`, `enableDamping`), and the mouse buttons can be remapped through
 * {@link OrbitControls.mouseButtons}.
 *
 * ## Damping
 *
 * With damping on, input accumulates into {@link OrbitControls.sphericalDelta},
 * {@link OrbitControls.panOffset} and {@link OrbitControls.scale}, and every
 * `update(delta)` applies a frame-rate-independent fraction of what remains. That is
 * what makes a flick feel like it coasts instead of stopping dead — and it is also why
 * `update` must be called every frame, not only on input.
 *
 * ## Coordinates
 *
 * Angles are measured about `+Y`, with `theta` from `+Z` and `phi` from `+Y`, matching
 * {@link Controls.getAzimuthalAngle} and {@link Controls.getPolarAngle}. Limits are
 * applied *after* damping, so a damped flick comes to rest against the limit rather
 * than snapping to it.
 *
 * ```ts
 * const controls = new OrbitControls(camera, canvas);
 * controls.minDistance = 1;
 * controls.maxPolarAngle = Math.PI / 2;
 * controls.enableDamping = true;
 * // each frame:
 * controls.update(clock.getDelta());
 * ```
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../math/Vec3';
import { clamp, degToRad, wrapAngle360 } from '../../utils/MathUtils';
import { Controls } from '../Controls';
import {
  createChangeDelta,
  MouseAction,
  type ChangeDelta,
  type ControlsObjectLike,
  type ControlsOptions,
  type EventTargetLike,
  type KeyEventLike,
  type PointerEventLike,
  type SphericalState,
  type TouchEventLike,
  type TouchLike,
  type WheelEventLike,
} from '../types';

/** Options accepted by the {@link OrbitControls} constructor. */
export interface OrbitControlsOptions extends ControlsOptions {
  /** Minimum camera distance; defaults to `0`. */
  minDistance?: number;
  /** Maximum camera distance; defaults to `Infinity`. */
  maxDistance?: number;
  /** Minimum polar angle; defaults to `0`. */
  minPolarAngle?: number;
  /** Maximum polar angle; defaults to `PI`. */
  maxPolarAngle?: number;
  /** Minimum azimuthal angle; defaults to `-Infinity` (unbounded). */
  minAzimuthAngle?: number;
  /** Maximum azimuthal angle; defaults to `Infinity` (unbounded). */
  maxAzimuthAngle?: number;
  /** Rotation sensitivity multiplier; defaults to `1`. */
  rotateSpeed?: number;
  /** Dolly sensitivity multiplier; defaults to `1`. */
  zoomSpeed?: number;
  /** Pan sensitivity multiplier; defaults to `1`. */
  panSpeed?: number;
  /** `false` disables rotation entirely. */
  enableRotate?: boolean;
  /** `false` disables the dolly. */
  enableZoom?: boolean;
  /** `false` disables panning. */
  enablePan?: boolean;
  /** Pan in the camera's screen plane rather than the world ground plane. */
  screenSpacePanning?: boolean;
  /** Invert vertical drag. */
  reverseOrbit?: boolean;
  /** Invert the wheel direction. */
  invertZoom?: boolean;
}

/** The mouse-button map. */
export interface OrbitMouseButtons {
  /** Action for the left button; defaults to {@link MouseAction.Rotate}. */
  left: number;
  /** Action for the middle button; defaults to {@link MouseAction.Zoom}. */
  middle: number;
  /** Action for the right button; defaults to {@link MouseAction.Pan}. */
  right: number;
}

/** The modifier-key map, mirroring three.js. */
export interface OrbitKeyModifiers {
  /** Action when Ctrl is held; defaults to {@link MouseAction.Pan}. */
  ctrl: number;
  /** Action when Shift is held; defaults to {@link MouseAction.Zoom}. */
  shift: number;
  /** Action when Meta is held; defaults to {@link MouseAction.Pan}. */
  meta: number;
  /** Action when Alt is held; defaults to {@link MouseAction.Pan}. */
  alt: number;
}

/**
 * Spherical orbit control with a dolly and a screen-space pan.
 */
export class OrbitControls extends Controls {
  /** Minimum distance from the target. */
  public minDistance = 0;

  /** Maximum distance from the target. */
  public maxDistance = Infinity;

  /** Minimum polar angle, in radians. */
  public minPolarAngle = 0;

  /** Maximum polar angle, in radians. */
  public maxPolarAngle = Math.PI;

  /** Minimum azimuthal angle, in radians. */
  public minAzimuthAngle = -Infinity;

  /** Maximum azimuthal angle, in radians. */
  public maxAzimuthAngle = Infinity;

  /** Rotation sensitivity. */
  public rotateSpeed = 1;

  /** Dolly sensitivity. */
  public zoomSpeed = 1;

  /** Pan sensitivity. */
  public panSpeed = 1;

  /** `false` disables rotation. */
  public enableRotate = true;

  /** `false` disables the dolly. */
  public enableZoom = true;

  /** `false` disables panning. */
  public enablePan = true;

  /** Pan in the camera's screen plane instead of the world ground plane. */
  public screenSpacePanning = false;

  /** Invert vertical drag. */
  public reverseOrbit = false;

  /** Invert the wheel direction. */
  public invertZoom = false;

  /** `true` lets a single pointer drag pan without a modifier. */
  public enableTwoFingerPan = true;

  /** Mouse-button map. */
  public readonly mouseButtons: OrbitMouseButtons = {
    left: MouseAction.Rotate,
    middle: MouseAction.Zoom,
    right: MouseAction.Pan,
  };

  /** Modifier-key map. */
  public readonly keyModifiers: OrbitKeyModifiers = {
    ctrl: MouseAction.Pan,
    shift: MouseAction.Zoom,
    meta: MouseAction.Pan,
    alt: MouseAction.Pan,
  };

  /** Accumulated rotation, applied on the next `update`. */
  public readonly sphericalDelta: SphericalState = { radius: 0, phi: 0, theta: 0 };

  /** Accumulated pan, applied on the next `update`. */
  public readonly panOffset = new Vec3();

  /** Accumulated dolly scale, applied on the next `update`. */
  public scale = 1;

  /** Internal target used while a pan is being damped. */
  protected readonly panTarget = new Vec3();

  /** Internal spherical state between updates. */
  protected readonly orbitState: SphericalState = { radius: 1, phi: 0, theta: 0 };

  /** Pointer id of the active single-pointer drag, or `null`. */
  protected activePointer: number | null = null;

  /** Button that started the active drag. */
  protected activeButton = -1;

  /** Action the active drag performs. */
  protected activeAction: number = MouseAction.None;

  /** Last pointer position, in CSS pixels. */
  protected readonly lastPointer = { x: 0, y: 0 };

  /** Active touch contacts, keyed by identifier. */
  protected readonly touches = new Map<number, { x: number; y: number }>();

  /** Distance between two fingers when the pinch started. */
  protected pinchStartDistance = 0;

  /** Midpoint between two fingers when the pinch started. */
  protected readonly pinchStartMidpoint = { x: 0, y: 0 };

  /** `true` while two fingers are down. */
  protected pinching = false;

  /**
   * Creates an orbit control.
   *
   * @param object Camera (or camera-like object) to drive.
   * @param element Element to attach to, or `null` to attach later.
   * @param options Limits, speeds and feature flags.
   */
  constructor(
    object: ControlsObjectLike,
    element: EventTargetLike | null = null,
    options: OrbitControlsOptions = {},
  ) {
    super(object, { ...options, domElement: null });

    this.minDistance = options.minDistance ?? 0;
    this.maxDistance = options.maxDistance ?? Infinity;
    this.minPolarAngle = options.minPolarAngle ?? 0;
    this.maxPolarAngle = options.maxPolarAngle ?? Math.PI;
    this.minAzimuthAngle = options.minAzimuthAngle ?? -Infinity;
    this.maxAzimuthAngle = options.maxAzimuthAngle ?? Infinity;
    this.rotateSpeed = options.rotateSpeed ?? 1;
    this.zoomSpeed = options.zoomSpeed ?? 1;
    this.panSpeed = options.panSpeed ?? 1;
    this.enableRotate = options.enableRotate ?? true;
    this.enableZoom = options.enableZoom ?? true;
    this.enablePan = options.enablePan ?? true;
    this.screenSpacePanning = options.screenSpacePanning ?? false;
    this.reverseOrbit = options.reverseOrbit ?? false;
    this.invertZoom = options.invertZoom ?? false;

    this.captureInitialState();

    if (element !== null) this.connect(element);
  }

  /** Captures the starting transform so `reset()` has something to restore. */
  protected captureInitialState(): void {
    const spherical = this.getSpherical();
    if (spherical !== null) {
      this.orbitState.radius = spherical.radius;
      this.orbitState.phi = spherical.phi;
      this.orbitState.theta = spherical.theta;
    }
    this.saveState();
  }

  /* -------------------------------------------------------------- listeners */

  /** @inheritdoc */
  protected override bindListeners(element: EventTargetLike): void {
    const pointer = this.handlePointerDown as (event: never) => void;
    const move = this.handlePointerMove as (event: never) => void;
    const up = this.handlePointerUp as (event: never) => void;
    const wheel = this.handleWheel as (event: never) => void;
    const touchStart = this.handleTouchStart as (event: never) => void;
    const touchMove = this.handleTouchMove as (event: never) => void;
    const touchEnd = this.handleTouchEnd as (event: never) => void;
    const contextMenu = this.handleContextMenu as (event: never) => void;
    const key = this.handleKeyDown as (event: never) => void;

    this.addDomListener(element, 'pointerdown', pointer);
    this.addDomListener(element, 'pointermove', move);
    this.addDomListener(element, 'pointerup', up);
    this.addDomListener(element, 'pointercancel', up);
    this.addDomListener(element, 'wheel', wheel, { passive: false });
    this.addDomListener(element, 'touchstart', touchStart, { passive: false });
    this.addDomListener(element, 'touchmove', touchMove, { passive: false });
    this.addDomListener(element, 'touchend', touchEnd);
    this.addDomListener(element, 'touchcancel', touchEnd);
    this.addDomListener(element, 'contextmenu', contextMenu);
    this.addDomListener(element, 'keydown', key);
  }

  /* ------------------------------------------------------------- handlers */

  /** Resolves the action a pointer event should perform. */
  protected resolveAction(event: PointerEventLike): number {
    if (event.ctrlKey === true) return this.keyModifiers.ctrl;
    if (event.shiftKey === true) return this.keyModifiers.shift;
    if (event.metaKey === true) return this.keyModifiers.meta;
    if (event.altKey === true) return this.keyModifiers.alt;

    switch (event.button ?? 0) {
      case 0:
        return this.mouseButtons.left;
      case 1:
        return this.mouseButtons.middle;
      case 2:
        return this.mouseButtons.right;
      default:
        return MouseAction.None;
    }
  }

  /** `pointerdown` handler. */
  protected handlePointerDown(event: PointerEventLike): void {
    if (!this.enabled || event.pointerType === 'touch') return;
    if (this.activePointer !== null) return;

    const action = this.resolveAction(event);
    if (action === MouseAction.None) return;

    this.suppressDefault(event);
    this.activePointer = event.pointerId ?? 1;
    this.activeButton = event.button ?? 0;
    this.activeAction = action;
    this.lastPointer.x = event.clientX;
    this.lastPointer.y = event.clientY;

    const capture = event.currentTarget ?? event.target;
    capturePointer(capture, this.activePointer);

    this.interacting = true;
    this.emitChangeStart(createChangeDelta());
  }

  /** `pointermove` handler. */
  protected handlePointerMove(event: PointerEventLike): void {
    if (!this.enabled || !this.interacting) return;
    if (event.pointerType === 'touch') return;
    if (this.activePointer !== null && event.pointerId !== undefined && event.pointerId !== this.activePointer) {
      return;
    }

    const dx = event.clientX - this.lastPointer.x;
    const dy = event.clientY - this.lastPointer.y;
    this.lastPointer.x = event.clientX;
    this.lastPointer.y = event.clientY;

    this.suppressDefault(event);
    this.applyPointerAction(this.activeAction, dx, dy);
  }

  /** `pointerup`/`pointercancel` handler. */
  protected handlePointerUp(event: PointerEventLike): void {
    if (this.activePointer === null) return;
    if (event.pointerId !== undefined && event.pointerId !== this.activePointer) return;

    releasePointer(event.currentTarget ?? event.target, this.activePointer);
    this.activePointer = null;
    this.activeButton = -1;
    this.activeAction = MouseAction.None;
    this.interacting = false;
    this.emitChangeEnd(createChangeDelta());
  }

  /** `wheel` handler. */
  protected handleWheel(event: WheelEventLike): void {
    if (!this.enabled || !this.enableZoom) return;
    this.suppressDefault(event);

    // `deltaMode` is 1 for lines and 2 for pages; normalise both to pixels so a
    // Firefox wheel notch and a Chrome one produce comparable motion.
    const lineHeight = 16;
    const pageHeight = 800;
    const mode = event.deltaMode ?? 0;
    const raw =
      mode === 1 ? (event.deltaY ?? 0) * lineHeight : mode === 2 ? (event.deltaY ?? 0) * pageHeight : (event.deltaY ?? 0);

    const direction = this.invertZoom ? -1 : 1;
    // `0.95^notches` keeps a small wheel movement small and a big one big, which a
    // linear mapping cannot do.
    const notches = raw / 100;
    this.scale *= Math.pow(0.95, this.zoomSpeed * direction * notches);
  }

  /** `touchstart` handler. */
  protected handleTouchStart(event: TouchEventLike): void {
    if (!this.enabled) return;
    const touches = listToArray(event.touches);
    if (touches.length > 0) this.suppressDefault(event);

    for (const touch of touches) {
      this.touches.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
    }

    if (this.touches.size === 1 && this.enableRotate) {
      this.interacting = true;
      this.emitChangeStart(createChangeDelta());
    }

    if (this.touches.size === 2) {
      this.pinching = true;
      const [first, second] = Array.from(this.touches.values());
      this.pinchStartDistance = distanceBetween(first, second);
      this.pinchStartMidpoint.x = (first.x + second.x) * 0.5;
      this.pinchStartMidpoint.y = (first.y + second.y) * 0.5;
    }
  }

  /** `touchmove` handler. */
  protected handleTouchMove(event: TouchEventLike): void {
    if (!this.enabled) return;
    const touches = listToArray(event.touches);
    if (touches.length === 0) return;
    this.suppressDefault(event);

    if (touches.length === 1 && !this.pinching) {
      const touch = touches[0];
      const previous = this.touches.get(touch.identifier);
      if (previous !== undefined) {
        const dx = touch.clientX - previous.x;
        const dy = touch.clientY - previous.y;
        if (this.enableRotate) this.rotateByPixels(dx, dy);
      }
      this.touches.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
      return;
    }

    if (touches.length >= 2) {
      const [first, second] = touches;
      const currentDistance = distanceBetween(
        { x: first.clientX, y: first.clientY },
        { x: second.clientX, y: second.clientY },
      );
      const midpoint = {
        x: (first.clientX + second.clientX) * 0.5,
        y: (first.clientY + second.clientY) * 0.5,
      };

      if (this.enableZoom && this.pinchStartDistance > 0) {
        const ratio = currentDistance / this.pinchStartDistance;
        if (ratio > 0) this.scale *= 1 / ratio;
        this.pinchStartDistance = currentDistance;
      }

      if (this.enablePan && this.enableTwoFingerPan) {
        const dx = midpoint.x - this.pinchStartMidpoint.x;
        const dy = midpoint.y - this.pinchStartMidpoint.y;
        this.panByPixels(dx, dy);
      }

      this.pinchStartMidpoint.x = midpoint.x;
      this.pinchStartMidpoint.y = midpoint.y;

      this.touches.clear();
      for (const touch of touches) this.touches.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
    }
  }

  /** `touchend`/`touchcancel` handler. */
  protected handleTouchEnd(event: TouchEventLike): void {
    const changed = listToArray(event.changedTouches);
    for (const touch of changed) this.touches.delete(touch.identifier);

    if (this.touches.size < 2) this.pinching = false;
    if (this.touches.size === 0) {
      this.interacting = false;
      this.emitChangeEnd(createChangeDelta());
    }
  }

  /** `contextmenu` handler: suppress the menu so a right-drag can pan. */
  protected handleContextMenu(event: PointerEventLike): void {
    if (!this.enabled || !this.enablePan) return;
    this.suppressDefault(event);
  }

  /** `keydown` handler: arrow keys pan, `+`/`-` dolly. */
  protected handleKeyDown(event: KeyEventLike): void {
    if (!this.enabled) return;
    const code = normalizeKeyCode(event);

    switch (code) {
      case 'ArrowUp':
        if (this.enablePan) this.panByPixels(0, 50 * this.panSpeed);
        break;
      case 'ArrowDown':
        if (this.enablePan) this.panByPixels(0, -50 * this.panSpeed);
        break;
      case 'ArrowLeft':
        if (this.enablePan) this.panByPixels(50 * this.panSpeed, 0);
        break;
      case 'ArrowRight':
        if (this.enablePan) this.panByPixels(-50 * this.panSpeed, 0);
        break;
      case 'Equal':
      case 'NumpadAdd':
        if (this.enableZoom) this.scale *= 0.9;
        break;
      case 'Minus':
      case 'NumpadSubtract':
        if (this.enableZoom) this.scale *= 1.1;
        break;
      default:
        return;
    }

    this.suppressDefault(event);
  }

  /* --------------------------------------------------------------- motion */

  /** Applies the action selected for a pointer drag. */
  protected applyPointerAction(action: number, dx: number, dy: number): void {
    if (action === MouseAction.Rotate && this.enableRotate) {
      this.rotateByPixels(dx, dy);
      return;
    }
    if (action === MouseAction.Pan && this.enablePan) {
      this.panByPixels(dx, dy);
      return;
    }
    if (action === MouseAction.Zoom && this.enableZoom) {
      // Vertical drag dollies, which is the convention every 3D tool uses.
      const notches = dy / 100;
      this.scale *= Math.pow(0.95, this.zoomSpeed * notches);
    }
  }

  /**
   * Rotates by a pixel delta.
   *
   * @param dx Horizontal movement in CSS pixels.
   * @param dy Vertical movement in CSS pixels.
   */
  public rotateByPixels(dx: number, dy: number): void {
    // Two pi across the element's height/width is the standard mapping: dragging the
    // full height rotates a full turn.
    const height = readDimension(this.domElement, 'clientHeight', 1);
    const width = readDimension(this.domElement, 'clientWidth', 1);

    const verticalSign = this.reverseOrbit ? 1 : -1;

    this.sphericalDelta.theta -= (2 * Math.PI * dx * this.rotateSpeed) / width;
    this.sphericalDelta.phi -= (verticalSign * 2 * Math.PI * dy * this.rotateSpeed) / height;
  }

  /**
   * Pans by a pixel delta.
   *
   * @param dx Horizontal movement in CSS pixels.
   * @param dy Vertical movement in CSS pixels.
   */
  public panByPixels(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;

    const height = readDimension(this.domElement, 'clientHeight', 1);
    // Scale the pan by the distance so a pan near the target moves less world units
    // than the same gesture far away, which is what "grab the scene" means.
    const distance = Math.max(this.getDistance(), this.minDistance);
    const worldPerPixel = (2 * distance * Math.tan(degToRad(45))) / height;

    const right = new Vec3();
    const up = new Vec3();
    this.getCameraBasis(right, up);

    if (this.screenSpacePanning) {
      this.panOffset.addScaledVector(right, -dx * worldPerPixel * this.panSpeed);
      this.panOffset.addScaledVector(up, dy * worldPerPixel * this.panSpeed);
    } else {
      this.panOffset.addScaledVector(right, -dx * worldPerPixel * this.panSpeed);
      // Ground-plane panning: keep the horizontal component, drop the vertical one.
      const horizontal = up.clone().multiplyScalar(dy * worldPerPixel * this.panSpeed);
      horizontal.y = 0;
      this.panOffset.add(horizontal);
    }
  }

  /** Reads the camera's right/up axes from its quaternion. */
  protected getCameraBasis(right: Vec3, up: Vec3): void {
    const quaternion = this.object.quaternion;
    right.set(1, 0, 0).applyQuat(quaternion).normalize();
    up.set(0, 1, 0).applyQuat(quaternion).normalize();
  }

  /* --------------------------------------------------------------- update */

  /**
   * Applies the accumulated deltas.
   *
   * @param delta Seconds since the previous call; only used by damping.
   * @returns `true` when the camera moved.
   */
  public update(delta: number): boolean {
    if (!this.enabled) return false;

    const change: ChangeDelta = createChangeDelta();
    const alpha = this.dampingAlpha(delta);

    // ---- pan ---------------------------------------------------------------
    if (this.panOffset.lengthSquared() > 0) {
      const applied = this.panOffset.clone().multiplyScalar(this.enableDamping ? alpha : 1);
      this.target.add(applied);
      this.object.position.add(applied);
      // When damping, keep the un-applied remainder for the next frame.
      if (this.enableDamping) {
        this.panOffset.multiplyScalar(1 - alpha);
        if (this.panOffset.lengthSquared() < 1e-12) this.panOffset.set(0, 0, 0);
      } else {
        this.panOffset.set(0, 0, 0);
      }
      change.panned = true;
    }

    // ---- dolly -------------------------------------------------------------
    let scale = this.scale;
    if (this.enableDamping) {
      scale = 1 + (this.scale - 1) * alpha;
      this.scale = 1 + (this.scale - 1) * (1 - alpha);
      if (Math.abs(this.scale - 1) < 1e-6) this.scale = 1;
    } else {
      this.scale = 1;
    }

    const offset = new Vec3().subVectors(this.object.position, this.target);
    const currentRadius = offset.length();

    if (scale !== 1 && this.enableZoom && currentRadius > 0) {
      const radius = clamp(currentRadius * scale, this.minDistance, this.maxDistance);
      change.distance = radius - currentRadius;
      change.zoomed = Math.abs(change.distance) > 1e-9;
      offset.setLength(radius);
      this.object.position.copy(this.target).add(offset);
    } else if (currentRadius > 0) {
      const radius = clamp(currentRadius, this.minDistance, this.maxDistance);
      if (radius !== currentRadius) {
        offset.setLength(radius);
        this.object.position.copy(this.target).add(offset);
        change.distance = radius - currentRadius;
        change.zoomed = true;
      }
    }

    // ---- rotate ------------------------------------------------------------
    let theta = this.sphericalDelta.theta;
    let phi = this.sphericalDelta.phi;

    if (this.enableDamping) {
      theta *= alpha;
      phi *= alpha;
      this.sphericalDelta.theta *= 1 - alpha;
      this.sphericalDelta.phi *= 1 - alpha;
      if (Math.abs(this.sphericalDelta.theta) < 1e-6) this.sphericalDelta.theta = 0;
      if (Math.abs(this.sphericalDelta.phi) < 1e-6) this.sphericalDelta.phi = 0;
    } else {
      this.sphericalDelta.theta = 0;
      this.sphericalDelta.phi = 0;
    }

    if (this.enableRotate && (theta !== 0 || phi !== 0)) {
      const spherical = this.getSpherical();
      if (spherical !== null && spherical.radius > 0) {
        const nextTheta = this.clampAzimuth(spherical.theta + theta);
        const nextPhi = clamp(
          spherical.phi + phi,
          Math.max(1e-4, this.minPolarAngle),
          Math.min(Math.PI - 1e-4, this.maxPolarAngle),
        );

        change.azimuth = nextTheta - spherical.theta;
        change.polar = nextPhi - spherical.phi;
        change.rotated = Math.abs(change.azimuth) > 1e-9 || Math.abs(change.polar) > 1e-9;

        this.orbitState.radius = spherical.radius;
        this.orbitState.phi = nextPhi;
        this.orbitState.theta = nextTheta;
        this.applySpherical(nextTheta, nextPhi, spherical.radius);
      }
    }

    if (change.rotated || change.panned || change.zoomed) {
      this.lookAtTarget();
      this.markObjectDirty();
      this.emitChange(change);
      return true;
    }
    return false;
  }

  /** Constrains an azimuth to the configured window, wrapping when unbounded. */
  protected clampAzimuth(angle: number): number {
    const unbounded = !Number.isFinite(this.minAzimuthAngle) && !Number.isFinite(this.maxAzimuthAngle);
    if (unbounded) return wrapAngle360(angle);
    return clamp(angle, this.minAzimuthAngle, this.maxAzimuthAngle);
  }

  /** Writes a spherical position relative to the target. */
  protected applySpherical(theta: number, phi: number, radius: number): void {
    const sinPhi = Math.sin(phi);
    this.object.position.set(
      this.target.x + radius * sinPhi * Math.sin(theta),
      this.target.y + radius * Math.cos(phi),
      this.target.z + radius * sinPhi * Math.cos(theta),
    );
  }

  /* ---------------------------------------------------------------- limits */

  /**
   * Sets the dolly limits.
   *
   * @param minDistance Minimum distance.
   * @param maxDistance Maximum distance.
   * @returns This control, for chaining.
   */
  public setDistanceLimits(minDistance: number, maxDistance: number): this {
    this.minDistance = Math.max(0, minDistance);
    this.maxDistance = Math.max(this.minDistance, maxDistance);
    return this;
  }

  /**
   * Sets the polar limits, in radians.
   *
   * @param min Minimum polar angle.
   * @param max Maximum polar angle.
   * @returns This control, for chaining.
   */
  public setPolarLimits(min: number, max: number): this {
    this.minPolarAngle = clamp(min, 0, Math.PI);
    this.maxPolarAngle = clamp(max, this.minPolarAngle, Math.PI);
    return this;
  }

  /**
   * Sets the azimuth window, in radians.
   *
   * @param min Minimum azimuth, or `-Infinity` for unbounded.
   * @param max Maximum azimuth, or `Infinity` for unbounded.
   * @returns This control, for chaining.
   */
  public setAzimuthLimits(min: number, max: number): this {
    this.minAzimuthAngle = min;
    this.maxAzimuthAngle = max;
    return this;
  }

  /**
   * Sets the polar limits in degrees, for UI code that thinks in degrees.
   *
   * @param minDegrees Minimum polar angle.
   * @param maxDegrees Maximum polar angle.
   * @returns This control, for chaining.
   */
  public setPolarLimitsDegrees(minDegrees: number, maxDegrees: number): this {
    return this.setPolarLimits(degToRad(minDegrees), degToRad(maxDegrees));
  }

  /** @inheritdoc */
  protected override onReset(state: import('../types').ControlsState): void {
    const spherical = state.spherical;
    if (spherical !== null && spherical !== undefined) {
      this.orbitState.radius = spherical.radius;
      this.orbitState.phi = spherical.phi;
      this.orbitState.theta = spherical.theta;
    }
    this.sphericalDelta.theta = 0;
    this.sphericalDelta.phi = 0;
    this.panOffset.set(0, 0, 0);
    this.scale = 1;
    this.activePointer = null;
    this.interacting = false;
    this.touches.clear();
    this.pinching = false;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    super.onDispose();
    this.touches.clear();
    this.panOffset.set(0, 0, 0);
    this.sphericalDelta.theta = 0;
    this.sphericalDelta.phi = 0;
  }

  /**
   * @returns A human-readable description including the current orbit angles.
   */
  public override toString(): string {
    return (
      `${this.constructor.name}(distance=${this.getDistance().toFixed(3)}, ` +
      `polar=${this.getPolarAngleDegrees().toFixed(1)}deg, ` +
      `azimuth=${this.getAzimuthalAngleDegrees().toFixed(1)}deg, damping=${this.enableDamping})`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Shared helpers (used by the sibling camera controls)                       */
/* -------------------------------------------------------------------------- */

/** Reads a numeric dimension off an element-like host, with a fallback. */
export function readDimension(element: EventTargetLike | null, key: string, fallback: number): number {
  if (element === null) return fallback;
  const value = (element as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' && value > 0 ? value : fallback;
}

/** Converts an array-like touch list into a real array. */
export function listToArray(list: TouchEventLike['touches'] | undefined): TouchLike[] {
  if (list === undefined || list === null) return [];
  const out: TouchLike[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = typeof list.item === 'function' ? list.item(i) : list[i];
    if (item != null) out.push(item);
  }
  return out;
}

/** Euclidean distance between two `{ x, y }` pairs. */
export function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Calls `setPointerCapture` when the host supports it. */
export function capturePointer(target: unknown, pointerId: number): void {
  const candidate = target as { setPointerCapture?(id: number): void } | null | undefined;
  try {
    candidate?.setPointerCapture?.(pointerId);
  } catch {
    /* capture is best-effort */
  }
}

/** Calls `releasePointerCapture` when the host supports it. */
export function releasePointer(event: unknown, pointerId: number): void {
  const candidate = (event ?? null) as { releasePointerCapture?(id: number): void } | null;
  try {
    candidate?.releasePointerCapture?.(pointerId);
  } catch {
    /* capture is best-effort */
  }
}

/** Normalises a keyboard event to a `KeyboardEvent.code`-style string. */
export function normalizeKeyCode(event: KeyEventLike): string {
  if (typeof event.code === 'string' && event.code.length > 0) return event.code;
  const key = event.key ?? '';
  switch (key) {
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight':
      return key;
    case '+':
      return 'Equal';
    case '-':
      return 'Minus';
    default:
      // `w` -> `KeyW`, so a caller using `key` still maps to the code table.
      return key.length === 1 ? `Key${key.toUpperCase()}` : key;
  }
}

/**
 * Convenience factory mirroring `new OrbitControls(object, element, options)`.
 *
 * @param object Camera to drive.
 * @param element Element to attach to.
 * @param options Limits, speeds and feature flags.
 * @returns A new orbit control.
 */
export function orbitControls(
  object: ControlsObjectLike,
  element: EventTargetLike | null = null,
  options: OrbitControlsOptions = {},
): OrbitControls {
  return new OrbitControls(object, element, options);
}
