/**
 * `QuaternionKeyframeTrack` — a stride-4 rotation track using slerp.
 *
 * Keyframes are `(x, y, z, w)` and interpolation is **spherical** with the
 * shortest-arc correction, so `q` and `-q` never produce a spurious 360° spin.
 * Setting a different interpolation mode degrades gracefully to component-wise
 * interpolation, which is occasionally what a caller wants for a
 * "cheap and approximately right" rotation curve.
 *
 * ```ts
 * const track = new QuaternionKeyframeTrack(
 *   '.quaternion',
 *   [0, 1],
 *   [0, 0, 0, 1, 0, 0, 1, 0],
 * );
 * track.createInterpolant().evaluate(0.5);   // halfway rotation
 * ```
 *
 * @packageDocumentation
 */

import { KeyframeTrack, type TrackInterpolation } from '../KeyframeTrack';
import type { TrackJSON } from '../types';

/**
 * A track whose keyframes are unit quaternions in `(x, y, z, w)` order.
 */
export class QuaternionKeyframeTrack extends KeyframeTrack<Float32Array> {
  /**
   * Creates a quaternion track.
   *
   * @param name Track name.
   * @param times Ascending keyframe times, in seconds.
   * @param values Flattened `(x, y, z, w)` keyframes.
   * @throws RangeError When `values.length !== times.length * 4`.
   */
  constructor(name: string, times: ArrayLike<number>, values: ArrayLike<number>) {
    super(name, times, values, 4);
    this.setInterpolation('quaternion');
  }

  /**
   * @returns A deep copy of this track.
   */
  public override clone(): QuaternionKeyframeTrack {
    return new QuaternionKeyframeTrack(this.name, this.times, this.values).copyExtrasFrom(this);
  }

  /**
   * @returns A JSON representation tagged with this class's name.
   */
  public override toJSON(): TrackJSON {
    return { ...super.toJSON(), type: 'QuaternionKeyframeTrack' };
  }

  /**
   * Restores a quaternion track from {@link QuaternionKeyframeTrack.toJSON} output.
   *
   * @param json Serialised track.
   * @returns A new track.
   */
  public static override parse(json: TrackJSON): QuaternionKeyframeTrack {
    const track = new QuaternionKeyframeTrack(json.name, json.times, json.values);
    if (json.interpolation !== undefined) {
      track.setInterpolation(json.interpolation as TrackInterpolation);
    }
    return track;
  }
}
