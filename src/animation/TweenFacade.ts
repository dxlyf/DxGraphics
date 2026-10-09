/**
 * `Tween` — a chainable, callback-driven property animator.
 *
 * The implementation lives in `./Tween`; this module is a thin re-export of it, kept
 * so that the `animation` barrel has one stable entry point for the Tween surface
 * even if the class is ever split across files.
 *
 * ```ts
 * import { Tween } from './Tween';
 * const tween = new Tween({ x: 0 }).to({ x: 10 }, 0.5).easing('cubicOut');
 * tween.update(1 / 60);
 * ```
 *
 * @packageDocumentation
 */

export { Tween, tween, DEFAULT_TWEEN_DURATION } from './Tween';

export type {
  TweenTarget,
  TweenSetter,
  TweenValues,
  TweenStep,
  TweenStepKind,
  TweenOptions,
  TweenState,
} from './Tween';
