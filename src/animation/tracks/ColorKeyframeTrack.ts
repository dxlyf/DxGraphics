/**
 * `ColorKeyframeTrack` — a stride-3 or stride-4 colour track.
 *
 * Keyframes are `(r, g, b)` or `(r, g, b, a)` with components in the same numeric
 * space as the destination colour object (linear `0..1` for `Color`). Interpolation
 * is component-wise linear; it does **not** rotate through hue, matching three.js.
 *
 * ```ts
 * const track = new ColorKeyframeTrack('.material.color', [0, 1], [1, 0, 0, 0, 0, 1]);
 * track.createInterpolant().evaluate(0.5);   // Float32Array [0.5, 0, 0.5]
 * ```
 *
 * @packageDocumentation
 */

import { KeyframeTrack, type TrackInterpolation } from '../KeyframeTrack';
import type { TrackJSON } from '../types';

/**
 * A track whose keyframes are RGB or RGBA colours.
 */
export class ColorKeyframeTrack extends KeyframeTrack<Float32Array> {
  /**
   * Creates a colour track.
   *
   * @param name Track name.
   * @param times Ascending keyframe times, in seconds.
   * @param values Flattened `(r, g, b[, a])` keyframes.
   * @param valueSize Components per keyframe; defaults to `4`.
   * @throws RangeError When `values.length !== times.length * valueSize`.
   */
  constructor(
    name: string,
    times: ArrayLike<number>,
    values: ArrayLike<number>,
    valueSize: number = 4,
  ) {
    super(name, times, values, valueSize);
  }

  /**
   * @returns A deep copy of this track.
   */
  public override clone(): ColorKeyframeTrack {
    return new ColorKeyframeTrack(this.name, this.times, this.values, this.valueSize).copyExtrasFrom(
      this,
    );
  }

  /**
   * @returns A JSON representation tagged with this class's name.
   */
  public override toJSON(): TrackJSON {
    return { ...super.toJSON(), type: 'ColorKeyframeTrack' };
  }

  /**
   * Restores a colour track from {@link ColorKeyframeTrack.toJSON} output.
   *
   * @param json Serialised track.
   * @returns A new track.
   */
  public static override parse(json: TrackJSON): ColorKeyframeTrack {
    const track = new ColorKeyframeTrack(json.name, json.times, json.values, json.valueSize ?? 4);
    if (json.interpolation !== undefined) {
      track.setInterpolation(json.interpolation as TrackInterpolation);
    }
    return track;
  }
}
