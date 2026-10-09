/**
 * `animation` — keyframe clips, tweens and timelines.
 *
 * Two complementary authoring styles live here:
 *
 * - **Clip based** ({@link AnimationClip} + {@link AnimationMixer} +
 *   {@link AnimationAction}) mirrors three.js: tracks are named property paths,
 *   actions carry weight/speed/loop state, and the mixer blends them. This is the
 *   right tool for imported skeletal animation and for anything that must be
 *   serialised.
 * - **Imperative** ({@link Tween} + {@link Timeline}) is a small fluent animator for
 *   UI and camera motion: no asset pipeline, no name resolution, just
 *   `update(delta)`.
 *
 * ```ts
 * const mixer = new AnimationMixer(character);
 * const walk = mixer.clipAction(walkClip).play();
 * mixer.update(clock.getDelta());
 * ```
 *
 * ## Relationship to `src/scene`
 *
 * This subsystem never imports `src/scene`: it addresses objects structurally
 * (`{ name, children }` plus arbitrary properties) and resolves track names through
 * {@link PropertyBinding}. `Object3D`, `Bone` and `Skeleton` instances satisfy those
 * structural contracts unchanged, and {@link Bone} is **re-exported** from the scene
 * graph rather than redefined — see `animation/skeleton/Bone.ts` for the rationale.
 *
 * @packageDocumentation
 */

export * from './Easing';
export * from './Interpolant';
export * from './KeyframeTrack';
export * from './PropertyBinding';
export * from './AnimationClip';
export * from './AnimationAction';
export * from './AnimationMixer';
export * from './TweenFacade';
export * from './Timeline';
export * from './tracks/index';
export { SkeletonUtils, skeletonUtils } from './skeleton/Skeleton';
export { Bone } from './skeleton/Bone';
export type { BoneLike, SkeletonLike, BonePose, RetargetOptions } from './skeleton/Skeleton';
export type * from './types';
