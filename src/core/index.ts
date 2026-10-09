/**
 * Core abstractions: events, lifecycle, timing, the scene-graph root and cameras.
 *
 * Everything in this layer is **backend-agnostic**. Nothing here imports a
 * renderer, a texture or a material, which is what lets the same graph feed the
 * Canvas2D, SVG, WebGL and WebGPU backends.
 *
 * ```ts
 * import { Node, Scene, Camera, Clock, UpdateScheduler } from '@dxyl/graphics';
 *
 * const scene = new Scene({ background: '#101018' });
 * const camera = new Camera();
 * const clock = new Clock();
 * const scheduler = new UpdateScheduler();
 * scene.add(camera);
 *
 * function frame() {
 *   const delta = clock.getDelta();
 *   scheduler.update(delta);
 *   scene.updateMatrixWorld();
 *   requestAnimationFrame(frame);
 * }
 * ```
 *
 * @packageDocumentation
 */

export * from './EventEmitter';
export {
  EventDispatcher,
  createDispatchEvent,
  withEvents,
  isEventDispatcher,
} from './EventDispatcher';
export type {
  DispatchEvent,
  EventTargetLike,
} from './EventDispatcher';
export * from './Disposable';
export * from './Lifecycle';
export * from './Clock';
export * from './Timer';
export * from './Layer';
export * from './Transform';
export * from './BoundingVolume';
export * from './Raycastable';
export * from './Renderable';
export * from './Updateable';
export * from './Node';
export * from './Scene';
export * from './Camera';
export type * from './types';
