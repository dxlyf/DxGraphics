/**
 * The scene layer: 2D and 3D scene graphs.
 *
 * ```ts
 * import { Object3D, Mesh, PerspectiveCamera } from '@dxyl/graphics/scene';
 * ```
 *
 * The two dimensions live in their own folders (`./2d`, `./3d`) so a 3D-only
 * bundle never pulls in the 2D nodes and vice versa. This entry point re-exports
 * both trees plus the handful of names that exist in both, disambiguated with a
 * `2D`/`3D` suffix.
 *
 * @packageDocumentation
 */

/* ------------------------------------------------------------------- 3D API */
export * from './3d';

/* ------------------------------------------------------------------- 2D API */
export * from './2d';

/* ---------------------------------------------------------- shared aliases */
export type { Object3D, Object3DEventMap, LookAtTarget } from './3d/Object3D';
export type { Node2D, Node2DEventMap } from './2d/Node2D';
export type { Object3DOptions } from './3d/types';
export type { Node2DOptions } from './2d/types';

/* ------------------------------------------------------------- event emitter */
export {
  TypedEventEmitter,
} from './internal/emitter';
export type {
  EventMap,
  EventMapShape,
  EventPayload,
  Handler,
  HandlerFor,
} from './internal/emitter';
