/**
 * `animation/tracks` — the concrete keyframe track types.
 *
 * Every track shares `KeyframeTrack`'s storage model (`times` plus flattened
 * `values`) and differs only in stride and default interpolation:
 *
 * | Class                      | Stride | Default interpolation |
 * | -------------------------- | ------ | --------------------- |
 * | `NumberKeyframeTrack`      | 1      | linear                |
 * | `VectorKeyframeTrack`      | 2/3/4  | linear                |
 * | `QuaternionKeyframeTrack`  | 4      | spherical (slerp)     |
 * | `ColorKeyframeTrack`       | 3/4    | linear, component-wise |
 *
 * @packageDocumentation
 */

export { NumberKeyframeTrack } from './NumberKeyframeTrack';
export { VectorKeyframeTrack } from './VectorKeyframeTrack';
export { QuaternionKeyframeTrack } from './QuaternionKeyframeTrack';
export { ColorKeyframeTrack } from './ColorKeyframeTrack';
