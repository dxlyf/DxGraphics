/**
 * `MapControls` — a pan-first orbit control, for map and floor-plan views.
 *
 * Mechanically this is {@link OrbitControls} with a different input map and
 * screen-space panning enabled:
 *
 * | Input | MapControls | OrbitControls |
 * | --- | --- | --- |
 * | Left drag | **pan** | rotate |
 * | Right drag | rotate | pan |
 * | Middle drag | dolly | dolly |
 * | Wheel | dolly | dolly |
 * | 2-finger drag | pan | pan |
 *
 * That single change is what makes a camera feel like a map: the primary gesture
 * moves the world under the cursor rather than swinging the viewer around it, and
 * because the pan is computed in the camera's screen plane, dragging "left" always
 * moves the content left regardless of the tilt.
 *
 * ```ts
 * const controls = new MapControls(camera, canvas);
 * controls.enableDamping = true;
 * controls.setPolarLimitsDegrees(15, 75);   // keep the horizon visible
 * ```
 *
 * @packageDocumentation
 */

import { MouseAction, type ControlsObjectLike, type EventTargetLike } from '../types';
import { OrbitControls, type OrbitControlsOptions } from './OrbitControls';

/** Options accepted by the {@link MapControls} constructor. */
export type MapControlsOptions = OrbitControlsOptions;

/**
 * Pan-first orbit control.
 */
export class MapControls extends OrbitControls {
  /** `true` keeps a one-finger drag panning instead of rotating. */
  public oneFingerPan = true;

  /**
   * Creates a map control.
   *
   * @param object Camera to drive.
   * @param element Element to attach to, or `null`.
   * @param options Limits, speeds and feature flags.
   */
  constructor(
    object: ControlsObjectLike,
    element: EventTargetLike | null = null,
    options: MapControlsOptions = {},
  ) {
    super(object, element, options);

    // Left button pans; right button rotates. The defaults from `OrbitControls` are
    // overridden here rather than in the option bag so a caller can still remap them.
    this.mouseButtons.left = MouseAction.Pan;
    this.mouseButtons.right = MouseAction.Rotate;
    this.mouseButtons.middle = MouseAction.Zoom;

    // Screen-space panning is what makes a tilted map view behave: the pan follows
    // the cursor rather than sliding along the ground plane.
    this.screenSpacePanning = options.screenSpacePanning ?? true;

    // A slower default rotation suits the secondary role the gesture now plays.
    this.rotateSpeed = options.rotateSpeed ?? 0.8;
    this.panSpeed = options.panSpeed ?? 1;
  }

  /**
   * Applies the action selected for a pointer drag.
   *
   * @param action Resolved action.
   * @param dx Horizontal movement in CSS pixels.
   * @param dy Vertical movement in CSS pixels.
   */
  protected override applyPointerAction(action: number, dx: number, dy: number): void {
    super.applyPointerAction(action, dx, dy);
  }

  /**
   * Rotates by a pixel delta.
   *
   * Overridden so a map's rotation cannot flip the view upside down: the polar
   * limits are tightened to the range a map view can meaningfully show, unless the
   * caller explicitly widened them.
   *
   * @param dx Horizontal movement in CSS pixels.
   * @param dy Vertical movement in CSS pixels.
   */
  public override rotateByPixels(dx: number, dy: number): void {
    // A just-in-case clamp only applies while the caller has left the default
    // unbounded vertical range in place.
    if (this.minPolarAngle === 0 && this.maxPolarAngle === Math.PI) {
      this.minPolarAngle = 0.001;
      this.maxPolarAngle = Math.PI - 0.001;
    }
    super.rotateByPixels(dx, dy);
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return `MapControls(distance=${this.getDistance().toFixed(3)}, pan-first=true)`;
  }
}

/**
 * Convenience factory mirroring `new MapControls(object, element, options)`.
 *
 * @param object Camera to drive.
 * @param element Element to attach to.
 * @param options Limits, speeds and feature flags.
 * @returns A new map control.
 */
export function mapControls(
  object: ControlsObjectLike,
  element: EventTargetLike | null = null,
  options: MapControlsOptions = {},
): MapControls {
  return new MapControls(object, element, options);
}
