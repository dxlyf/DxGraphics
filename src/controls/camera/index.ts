/**
 * `controls/camera` — the camera-driving controls.
 *
 * | Control | Model | Reach for it when |
 * | --- | --- | --- |
 * | {@link OrbitControls} | spherical orbit about a target | showing one object |
 * | {@link MapControls} | pan-first orbit | maps, floor plans, large flat scenes |
 * | {@link TrackballControls} | free rotation, no up vector | inspecting a model from any angle |
 * | {@link FlyControls} | six degrees of freedom | flying through a scene |
 * | {@link FirstPersonControls} | walking camera, level horizon | on-foot navigation |
 *
 * All five extend {@link Controls}, so they share listener tracking, `saveState`/
 * `reset`, the `change`/`changeStart`/`changeEnd` events, and a guaranteed-clean
 * `dispose`.
 *
 * @packageDocumentation
 */

export * from './OrbitControls';
export * from './MapControls';
export * from './TrackballControls';
export * from './FlyControls';
export * from './FirstPersonControls';
