/**
 * `VectorKeyframeTrack` — a stride-N vector keyframe track.
 *
 * Defaults to `Vec3` stride (`3`); pass `valueSize: 2` for `Vec2` properties such
 * as `.uv` or `.anchor`, and `4` for a `Vec4`.
 *
 * ```ts
 * const track = new VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 10, 0, 0]);
 * track.createInterpolant().evaluate(0.5);   // Float32Array [5, 0, 0]
 * ```
 *
 * @packageDocumentation
 */

import { KeyframeTrack, type TrackInterpolation } from '../KeyframeTrack';
import type { TrackJSON } from '../types';

/**
 * A track whose keyframes are `valueSize`-component vectors.
 */
export class VectorKeyframeTrack extends KeyframeTrack<Float32Array> {
  /**
   * Creates a vector track.
   *
   * @param name Track name.
   * @param times Ascending keyframe times, in seconds.
   * @param values Flattened vector keyframes.
   * @param valueSize Components per keyframe; defaults to `3`.
   * @throws RangeError When `values.length !== times.length * valueSize`.
   */
  constructor(
    name: string,
    times: ArrayLike<number>,
    values: ArrayLike<number>,
    valueSize: number = 3,
  ) {
    super(name, times, values, valueSize);
  }

  /**
   * @returns A deep copy of this track.
   */
  public override clone(): VectorKeyframeTrack {
    return new VectorKeyframeTrack(this.name, this.times, this.values, this.valueSize).copyExtrasFrom(
      this,
    );
  }

  /**
   * @returns A JSON representation tagged with this class's name.
   */
  public override toJSON(): TrackJSON {
    return { ...super.toJSON(), type: 'VectorKeyframeTrack' };
  }

  /**
   * Restores a vector track from {@link VectorKeyframeTrack.toJSON} output.
   *
   * @param json Serialised track.
   * @returns A new track.
   */
  public static override parse(json: TrackJSON): VectorKeyframeTrack {
    const track = new VectorKeyframeTrack(json.name, json.times, json.values, json.valueSize ?? 3);
    if (json.interpolation !== undefined) {
      track.setInterpolation(json.interpolation as TrackInterpolation);
    }
    return track;
  }
}
