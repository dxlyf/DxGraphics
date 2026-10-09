/**
 * `animation/skeleton` — the animation-side view of a skinned rig.
 *
 * ## Why `Bone` here is a re-export
 *
 * `src/scene/3d/Bone.ts` already defines a `Bone` as *an `Object3D` with a marker
 * flag* (`isBone`). A skeleton is nothing more than an array of those, so an
 * animation-side `Bone` would have to be either
 *
 * - an identical subclass — which would break `skeleton.bones` type identity and
 *   make a real `scene/3d/Skeleton` reject the animation-side instances, or
 * - a genuinely different thing (a "bone *binding*" carrying an offset), which
 *   nothing in the mixer needs, because tracks address bones by name through
 *   `PropertyBinding` (`.bones[hand].position`).
 *
 * Neither is worth a second class, so this module **re-exports** the scene graph's
 * `Bone` rather than duplicating it. There is exactly one `Bone` in the library.
 *
 * ## What this module adds
 *
 * {@link SkeletonUtils} — the operations that only make sense once a rig is being
 * animated: finding bones, computing bind-pose inverses, retargeting a pose between
 * two hierarchies of the same proportions, and flattening a rig into a name map for
 * fast track resolution.
 *
 * @packageDocumentation
 */

export { Bone } from '../../scene/3d/Bone';
export { SkeletonUtils, skeletonUtils } from './Skeleton';
export type { BoneLike, SkeletonLike, BonePose, RetargetOptions } from './Skeleton';
