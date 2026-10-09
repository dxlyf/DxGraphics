/**
 * `NumberKeyframeTrack` — a scalar (stride-1) keyframe track.
 *
 * Animates properties such as `.opacity`, `.intensity`, `.material.roughness` or
 * any custom numeric field. The default interpolation is linear.
 *
 * ```ts
 * const track = new NumberKeyframeTrack('.opacity', [0, 1, 2], [0, 1, 0.25]);
 * track.createInterpolant().evaluate(1.5);   // Float32Array [0.625]
 * ```
 *
 * @packageDocumentation
 */

import { KeyframeTrack, type TrackInterpolation } from '../KeyframeTrack';
import type { TrackJSON } from '../types';

/**
 * A track whose keyframes are single numbers.
 */
export class NumberKeyframeTrack extends KeyframeTrack<Float32Array> {
  /**
   * Creates a scalar track.
   *
   * @param name Track name in the `objectName.propertyName` grammar.
   * @param times Ascending keyframe times, in seconds.
   * @param values One number per keyframe.
   * @throws RangeError When `values.length !== times.length`.
   */
  constructor(name: string, times: ArrayLike<number>, values: ArrayLike<number>) {
    super(name, times, values, 1);
  }

  /**
   * @returns A deep copy of this track.
   */
  public override clone(): NumberKeyframeTrack {
    return new NumberKeyframeTrack(this.name, this.times, this.values).copyExtrasFrom(this);
  }

  /**
   * @returns A JSON representation tagged with this class's name.
   */
  public override toJSON(): TrackJSON {
    return { ...super.toJSON(), type: 'NumberKeyframeTrack' };
  }

  /**
   * Restores a scalar track from {@link NumberKeyframeTrack.toJSON} output.
   *
   * @param json Serialised track.
   * @returns A new track.
   */
  public static override parse(json: TrackJSON): NumberKeyframeTrack {
    const track = new NumberKeyframeTrack(json.name, json.times, json.values);
    if (json.interpolation !== undefined) {
      track.setInterpolation(json.interpolation as TrackInterpolation);
    }
    return track;
  }
}
