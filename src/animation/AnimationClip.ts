/**
 * `AnimationClip` — a named, timed collection of keyframe tracks.
 *
 * A clip is pure data: it knows its name, its duration and its tracks, and it can
 * be optimised, retimed and serialised. It holds **no** reference to the objects it
 * animates — that is `AnimationMixer`'s job — so one clip can drive many objects
 * and can be safely shared between scenes.
 *
 * ```ts
 * const clip = new AnimationClip('Walk', -1, [
 *   new NumberKeyframeTrack('.speed', [0, 1, 2], [0, 4, 0]),
 *   new VectorKeyframeTrack('.position', [0, 2], [0, 0, 0, 6, 0, 0]),
 * ]);
 * clip.duration;          // 2 (resetDuration)
 * clip.optimize();        // drops redundant keys
 * clip.trim(0.5);         // moves t=0 to t=0.5 and shortens the clip
 * ```
 *
 * @packageDocumentation
 */

import { createId } from '../utils/Id';
import { KeyframeTrack, type TrackInterpolation } from './KeyframeTrack';
import { ColorKeyframeTrack } from './tracks/ColorKeyframeTrack';
import { NumberKeyframeTrack } from './tracks/NumberKeyframeTrack';
import { QuaternionKeyframeTrack } from './tracks/QuaternionKeyframeTrack';
import { VectorKeyframeTrack } from './tracks/VectorKeyframeTrack';
import {
  ANIMATION_JSON_GENERATOR,
  ANIMATION_JSON_VERSION,
  type AnimationClipJSON,
  type TrackJSON,
} from './types';

/** Options accepted by {@link AnimationClip.trim}. */
export interface TrimOptions {
  /** Seconds added to every keyframe time. */
  startTime?: number;
  /** New clip duration in seconds; defaults to the current duration. */
  endTime?: number;
}

/**
 * A named sequence of keyframe tracks.
 */
export class AnimationClip {
  /** Friendly name; used by `AnimationMixer.clipAction` caches and by tools. */
  public name: string;

  /** Length of the clip in seconds. */
  public duration: number;

  /** Keyframe tracks making up the clip. */
  public tracks: KeyframeTrack<Float32Array>[];

  /** Unique identifier, stable across serialisation round-trips. */
  public readonly uuid: string = createId('clip');

  /** Default blend mode applied to actions created from this clip. */
  public blendMode: 'normal' | 'additive' | 'override' = 'normal';

  /**
   * Creates a clip.
   *
   * @param name Friendly name.
   * @param duration Clip length in seconds, or `-1` to derive it from the tracks.
   * @param tracks Keyframe tracks.
   * @param blendMode Default blend mode for actions built from this clip.
   */
  constructor(
    name = '',
    duration = -1,
    tracks: readonly KeyframeTrack<Float32Array>[] = [],
    blendMode: 'normal' | 'additive' | 'override' = 'normal',
  ) {
    this.name = name;
    this.tracks = tracks.slice();
    this.duration = duration;
    this.blendMode = blendMode;
    this.resetDuration();
  }

  /* ----------------------------------------------------------------- timing */

  /**
   * Recomputes {@link AnimationClip.duration} from the tracks.
   *
   * A negative or non-finite duration is replaced by the last keyframe time across
   * every track. A clip with no tracks, or with only zero-length tracks, gets a
   * duration of `-1` — the three.js convention meaning "instantaneous" — so that
   * `AnimationAction` knows not to try to loop it.
   *
   * @returns This clip, for chaining.
   */
  public resetDuration(): this {
    if (this.duration < 0 || !Number.isFinite(this.duration)) {
      let end = 0;
      for (const track of this.tracks) {
        const trackEnd = track.endTime;
        if (Number.isFinite(trackEnd) && trackEnd > end) end = trackEnd;
      }
      this.duration = this.tracks.length > 0 && end > 0 ? end : -1;
    }
    return this;
  }

  /* ---------------------------------------------------------------- editing */

  /**
   * Adds a track, or replaces an existing track with the same name.
   *
   * @param track Track to add.
   * @returns `true` when a new track was appended, `false` when one was replaced.
   */
  public addTrack(track: KeyframeTrack<Float32Array>): boolean {
    const index = this.tracks.findIndex((candidate) => candidate.name === track.name);
    if (index >= 0) {
      this.tracks[index] = track;
      return false;
    }
    this.tracks.push(track);
    return true;
  }

  /**
   * Removes a track by name.
   *
   * @param trackName Name of the track to remove.
   * @returns `true` when a track was removed.
   */
  public removeTrack(trackName: string): boolean {
    const index = this.tracks.findIndex((track) => track.name === trackName);
    if (index < 0) return false;
    this.tracks.splice(index, 1);
    return true;
  }

  /**
   * Looks a track up by name.
   *
   * @param trackName Track name.
   * @returns The track, or `undefined`.
   */
  public getTrack(trackName: string): KeyframeTrack<Float32Array> | undefined {
    return this.tracks.find((track) => track.name === trackName);
  }

  /**
   * Removes every track.
   *
   * @returns This clip, for chaining.
   */
  public clearTracks(): this {
    this.tracks.length = 0;
    return this;
  }

  /* -------------------------------------------------------------- optimize */

  /**
   * Runs {@link KeyframeTrack.optimize} on every track.
   *
   * @param tolerance Relative tolerance for the collinearity test.
   * @returns The total number of keyframes removed across all tracks.
   */
  public optimize(tolerance = 1e-6): number {
    let removed = 0;
    for (const track of this.tracks) removed += track.optimize(tolerance);
    return removed;
  }

  /**
   * Retimes the clip.
   *
   * Overloaded so both call styles read naturally:
   *
   * ```ts
   * clip.trim(0.5);                          // delay by 0.5s, keep duration
   * clip.trim({ startTime: 1, endTime: 3 }); // window 1s..3s
   * ```
   *
   * @param startOrOptions Seconds to delay by, or an explicit window.
   * @param endTime End of the window; only used by the numeric overload.
   * @returns This clip, for chaining.
   */
  public trim(startOrOptions: number | TrimOptions, endTime?: number): this {
    let startTime: number;
    let end: number;

    if (typeof startOrOptions === 'number') {
      startTime = startOrOptions;
      end = endTime ?? startTime + this.duration;
    } else {
      startTime = startOrOptions.startTime ?? 0;
      end = startOrOptions.endTime ?? this.duration;
    }

    if (!Number.isFinite(startTime)) startTime = 0;
    if (!Number.isFinite(end)) end = this.duration;

    const window = Math.max(0, end - startTime);
    const trimmed: KeyframeTrack<Float32Array>[] = [];

    for (const track of this.tracks) {
      // Trim against the track's own timeline, then rebase so that the clip's new
      // t=0 sits `startTime` seconds into the old clip. The trimmed track's own origin is
      // its first surviving key (which is `track.startTime + startTime`), so subtracting it
      // and adding `startTime` would move the window; subtracting only the origin is what
      // makes the clip's new t=0 land on the old `startTime`.
      const next = track.trim(track.startTime + startTime, track.startTime + end);
      next.shift(-next.startTime);
      trimmed.push(next);
    }

    this.tracks = trimmed;
    this.duration = window;
    return this;
  }

  /* ------------------------------------------------------------------ query */

  /**
   * Total number of keyframes across every track.
   *
   * @returns The keyframe count.
   */
  public getKeyframeCount(): number {
    let total = 0;
    for (const track of this.tracks) total += track.keyCount;
    return total;
  }

  /**
   * Validates every track.
   *
   * @returns `true` when the clip has at least one track and every track is well
   *   formed.
   */
  public validate(): boolean {
    if (this.tracks.length === 0) return false;
    for (const track of this.tracks) {
      if (!track.validate()) return false;
    }
    return true;
  }

  /**
   * The first validation failure, for diagnostics.
   *
   * @returns A description, or `null` when the clip is valid.
   */
  public getValidationError(): string | null {
    if (this.tracks.length === 0) return 'clip has no tracks';
    for (const track of this.tracks) {
      const error = track.getValidationError();
      if (error !== null) return `track "${track.name}": ${error}`;
    }
    return null;
  }

  /* --------------------------------------------------------- serialisation */

  /**
   * @returns A JSON-friendly representation of the clip.
   */
  public toJSON(): AnimationClipJSON {
    return {
      metadata: { version: ANIMATION_JSON_VERSION, generator: ANIMATION_JSON_GENERATOR },
      name: this.name,
      duration: this.duration,
      uuid: this.uuid,
      blendMode: this.blendMode,
      tracks: this.tracks.map((track) => track.toJSON()),
    };
  }

  /**
   * Rebuilds a clip from {@link AnimationClip.toJSON} output.
   *
   * The concrete track class is recovered from each entry's `type` field, falling
   * back to `KeyframeTrack` for unknown types so a newer serialiser cannot break an
   * older reader.
   *
   * @param json Serialised clip.
   * @returns A new clip.
   */
  public static parse(json: AnimationClipJSON): AnimationClip {
    const tracks = (json.tracks ?? []).map((entry: TrackJSON) => parseTrack(entry));
    return new AnimationClip(
      json.name ?? '',
      json.duration ?? -1,
      tracks,
      (json.blendMode as 'normal' | 'additive' | 'override') ?? 'normal',
    );
  }

  /**
   * Rebuilds a clip from its JSON representation.
   *
   * @param json Serialised clip.
   * @returns A new clip.
   */
  public static fromJSON(json: AnimationClipJSON): AnimationClip {
    return AnimationClip.parse(json);
  }

  /**
   * @returns A deep copy of this clip; tracks are cloned individually.
   */
  public clone(): AnimationClip {
    const tracks = this.tracks.map((track) => track.clone());
    return new AnimationClip(this.name, this.duration, tracks, this.blendMode);
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return `AnimationClip(name="${this.name}", duration=${this.duration}, tracks=${this.tracks.length})`;
  }
}

/**
 * Restores one track from its serialised form.
 *
 * @param json Serialised track.
 * @returns A concrete track instance.
 */
export function parseTrack(json: TrackJSON): KeyframeTrack<Float32Array> {
  const track = instantiateTrack(json);
  if (json.interpolation !== undefined) {
    track.setInterpolation(json.interpolation as TrackInterpolation);
  }
  return track;
}

/** Builds the concrete track class named by `json.type`. */
function instantiateTrack(json: TrackJSON): KeyframeTrack<Float32Array> {
  switch (json.type) {
    case 'NumberKeyframeTrack':
      return new NumberKeyframeTrack(json.name, json.times, json.values);
    case 'VectorKeyframeTrack':
      return new VectorKeyframeTrack(json.name, json.times, json.values, json.valueSize ?? 3);
    case 'QuaternionKeyframeTrack':
      return new QuaternionKeyframeTrack(json.name, json.times, json.values);
    case 'ColorKeyframeTrack':
      return new ColorKeyframeTrack(json.name, json.times, json.values, json.valueSize ?? 4);
    case 'KeyframeTrack':
    default:
      return new KeyframeTrack<Float32Array>(json.name, json.times, json.values, json.valueSize ?? 1);
  }
}

/**
 * Convenience factory mirroring `new AnimationClip(name, duration, tracks)`.
 *
 * @param name Friendly name.
 * @param duration Clip length, or `-1` to derive it.
 * @param tracks Keyframe tracks.
 * @returns A new clip.
 */
export function animationClip(
  name = '',
  duration = -1,
  tracks: readonly KeyframeTrack<Float32Array>[] = [],
): AnimationClip {
  return new AnimationClip(name, duration, tracks);
}
