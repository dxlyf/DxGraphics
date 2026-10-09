/**
 * `controls` — camera and pointer input handling.
 *
 * ```ts
 * import { OrbitControls } from '@dxyl/graphics';
 *
 * const controls = new OrbitControls(camera, canvas);
 * controls.enableDamping = true;
 * // each frame, after input:
 * controls.update(clock.getDelta());
 * ```
 *
 * ## Design
 *
 * - **Nothing touches the DOM types.** Every control reads its events and its host
 *   element through the structural interfaces in {@link types}, so a control can be
 *   attached to a fake `EventTarget` and driven headlessly in a test.
 * - **Nothing leaks a listener.** Listeners are only ever added through
 *   `Controls.addDomListener`, which records them; `disconnect()` and `dispose()`
 *   remove every one, and `listenerCount` proves it.
 * - **Nothing owns the frame loop.** `update(delta)` is called by the application, so
 *   controls compose with `Clock`, `UpdateScheduler` or a custom loop.
 *
 * ## Layers
 *
 * | Layer | Contents |
 * | --- | --- |
 * | Base | {@link Controls}, {@link types} |
 * | Camera | {@link OrbitControls}, {@link MapControls}, {@link TrackballControls}, {@link FlyControls}, {@link FirstPersonControls} |
 * | Pointer | {@link PointerControls}, {@link TouchControls} |
 * | Gesture | {@link GestureControls} |
 *
 * @packageDocumentation
 */

export * from './Controls';
export * from './camera/index';
export * from './pointer/index';
export * from './gesture/index';
export type * from './types';
