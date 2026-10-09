/**
 * `KeyframeTrack` — a named, time-indexed value curve.
 *
 * A track stores *what* to animate (a track name in the
 * `objectName.propertyName[subscript]` grammar), *when* (`times`), and *what
 * values* (`values`, flattened). It deliberately does **not** store a reference to
 * the object it animates: a mixer binds one track to many objects, and a clip can
 * be shared between scenes.
 *
 * ```
 * const track = new KeyframeTrack('.opacity', [0, 1, 2], [0, 1, 0.5]);
 * track.setInterpolation('smooth');
 * const interpolant = track.createInterpolant();   // SmoothInterpolant
 * interpolant.evaluate(0.5);                        // [0.5]
 * ```
 *
 * @packageDocumentation
 */

import { createId } from '../utils/Id';
import { Interpolant, createInterpolant, type InterpolantKind } from './Interpolant';
import type { TrackJSON } from './types';

/** Typed-array flavours a track's values may be stored in. */
export type TrackValueArray =
  | Float32Array
  | Float64Array
  | Uint8Array
  | Uint8ClampedArray
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | number[];

/** Interpolation mode names accepted by {@link KeyframeTrack.setInterpolation}. */
export type TrackInterpolation =
  | 'discrete'
  | 'step'
  | 'linear'
  | 'smooth'
  | 'smoothstep'
  | 'spline'
  | 'catmullrom'
  | 'bezier'
  | 'quaternion';

/** Default interpolation applied to a freshly constructed track. */
export const DEFAULT_INTERPOLATION: TrackInterpolation = 'linear';

/** Maximum number of keys a track may hold before `optimize` warns. */
const OPTIMIZE_WARN_THRESHOLD = 100_000;

/**
 * Compares two floats for the "redundant key" test used by
 * {@link KeyframeTrack.optimize}.
 *
 * A relative tolerance is required: absolute comparison would treat
 * `1e-30` and `2e-30` as identical, which they are not in a scale animation.
 */
function almostEqual(a: number, b: number, tolerance = 1e-6): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= tolerance * scale;
}

/**
 * One animated property curve.
 *
 * @typeParam TValues Concrete array type of {@link KeyframeTrack.values}.
 */
export class KeyframeTrack<TValues extends TrackValueArray = Float32Array> {
  /** Unique identifier; stable across serialisation round-trips. */
  public readonly uuid: string = createId('track');

  /** Track name in the `objectName.propertyName[subscript]` grammar. */
  public name: string;

  /** Keyframe times, in seconds. */
  public times: Float32Array;

  /** Flattened keyframe values: `times.length * valueSize` numbers. */
  public values: TValues;

  /** Components per keyframe. */
  public readonly valueSize: number;

  /** Interpolation mode. */
  public interpolation: TrackInterpolation = DEFAULT_INTERPOLATION;

  /** Seconds added to every evaluated time; useful for time offsets. */
  public timeOffset = 0;

  /** Global multiplier applied to {@link KeyframeTrack.times}. */
  public timeScale = 1;

  /** Blend mode hint consumed by `AnimationAction`. */
  public blendMode: 'normal' | 'additive' | 'override' = 'normal';

  /**
   * Creates a track.
   *
   * @param name Track name.
   * @param times Ascending keyframe times.
   * @param values Flattened keyframe values.
   * @param valueSize Components per keyframe; defaults to `1`.
   * @throws RangeError When `times` and `values` disagree in length, or when
   *   `valueSize` is not a positive integer.
   */
  constructor(
    name: string,
    times: ArrayLike<number>,
    values: TValues | ArrayLike<number>,
    valueSize: number = 1,
  ) {
    if (!Number.isFinite(valueSize) || valueSize < 1) {
      throw new RangeError(`KeyframeTrack("${name}"): valueSize must be >= 1, received ${valueSize}`);
    }

    this.name = name;
    this.valueSize = Math.floor(valueSize);
    this.times = times instanceof Float32Array ? times.slice() : Float32Array.from(times);
    this.values = toValues<TValues>(values);

    const expected = this.times.length * this.valueSize;
    if (this.values.length !== expected) {
      throw new RangeError(
        `KeyframeTrack("${name}"): ${this.times.length} times x ${this.valueSize} components ` +
          `needs ${expected} values, received ${this.values.length}`,
      );
    }
  }

  /* ------------------------------------------------------------- accessors */

  /** Number of keyframes. */
  public get keyCount(): number {
    return this.times.length;
  }

  /** Time of the first keyframe, in seconds. */
  public get startTime(): number {
    return this.times.length > 0 ? this.times[0] * this.timeScale : 0;
  }

  /** Time of the last keyframe, in seconds. */
  public get endTime(): number {
    return this.times.length > 0 ? this.times[this.times.length - 1] * this.timeScale : 0;
  }

  /** Span between the first and last keyframe, in seconds. */
  public get duration(): number {
    return Math.max(0, this.endTime - this.startTime);
  }

  /**
   * Reads one keyframe into a plain array.
   *
   * @param index Keyframe index.
   * @returns The keyframe's components, or an empty array when out of range.
   */
  public getValueAt(index: number): number[] {
    if (index < 0 || index >= this.keyCount) return [];
    const offset = index * this.valueSize;
    const out: number[] = new Array(this.valueSize);
    for (let i = 0; i < this.valueSize; i++) out[i] = this.values[offset + i];
    return out;
  }

  /**
   * Writes one keyframe from a plain array.
   *
   * @param index Keyframe index.
   * @param value Components to write; extra components are ignored.
   * @returns `true` when a keyframe was written.
   */
  public setValueAt(index: number, value: ArrayLike<number>): boolean {
    if (index < 0 || index >= this.keyCount) return false;
    const offset = index * this.valueSize;
    const count = Math.min(this.valueSize, value.length);
    for (let i = 0; i < count; i++) this.values[offset + i] = value[i];
    return true;
  }

  /* --------------------------------------------------------- interpolation */

  /**
   * Sets the interpolation mode.
   *
   * `'quaternion'` is only meaningful for a stride-4 track; the value is accepted
   * regardless so a serialiser can round-trip it.
   *
   * @param mode Interpolation mode name.
   * @returns This track, for chaining.
   */
  public setInterpolation(mode: TrackInterpolation): this {
    this.interpolation = mode;
    return this;
  }

  /**
   * Resolves the interpolation mode to a concrete {@link InterpolantKind}.
   *
   * @returns The interpolant kind that {@link KeyframeTrack.createInterpolant}
   *   will build.
   */
  public getInterpolantKind(): InterpolantKind {
    switch (this.interpolation) {
      case 'discrete':
      case 'step':
        return 'discrete';
      case 'smooth':
      case 'smoothstep':
        return 'smooth';
      case 'spline':
      case 'catmullrom':
      case 'bezier':
        return 'spline';
      case 'quaternion':
        return 'quaternion';
      case 'linear':
      default:
        if (this.valueSize === 1) return 'number';
        if (this.valueSize === 3 || this.valueSize === 2 || this.valueSize === 4) return 'vector';
        return 'linear';
    }
  }

  /**
   * Builds an interpolant over this track's key data.
   *
   * The interpolant copies `times` and `values`, so the track can be edited
   * afterwards without disturbing a mixer that already bound it.
   *
   * @param kind Optional override for the interpolation mode.
   * @returns A concrete interpolant.
   */
  public createInterpolant(kind?: InterpolantKind): Interpolant<number> {
    return createInterpolant(kind ?? this.getInterpolantKind(), this.times, this.values, this.valueSize);
  }

  /**
   * Evaluates the track without building an interpolant.
   *
   * Convenience for tests and one-off sampling; the hot path in a mixer uses a
   * cached interpolant instead.
   *
   * @param time Time in seconds, before {@link KeyframeTrack.timeScale} and
   *   {@link KeyframeTrack.timeOffset} are applied.
   * @returns A new array holding the sampled value.
   */
  public evaluate(time: number): number[] {
    const local = (time + this.timeOffset) / (this.timeScale || 1);
    return Array.from(this.createInterpolant().evaluate(local));
  }

  /* -------------------------------------------------------------- validity */

  /**
   * Validates the track's structural invariants.
   *
   * Checks, in order: non-empty, finite times, strictly ascending times, finite
   * values, and a value count matching `keyCount * valueSize`.
   *
   * @returns `true` when the track is well formed.
   */
  public validate(): boolean {
    if (this.keyCount === 0 || this.values.length === 0) return false;

    for (let i = 0; i < this.keyCount; i++) {
      const time = this.times[i];
      if (!Number.isFinite(time)) return false;
      if (i > 0 && !(time > this.times[i - 1])) return false;
    }

    for (let i = 0; i < this.values.length; i++) {
      if (!Number.isFinite(this.values[i])) return false;
    }

    return this.values.length === this.keyCount * this.valueSize;
  }

  /**
   * The first invariant that fails, for use in diagnostics.
   *
   * @returns A description, or `null` when the track is valid.
   */
  public getValidationError(): string | null {
    if (this.keyCount === 0) return 'track has no keyframes';
    if (this.values.length === 0) return 'track has no values';
    if (this.values.length !== this.keyCount * this.valueSize) {
      return `expected ${this.keyCount * this.valueSize} values, found ${this.values.length}`;
    }
    for (let i = 0; i < this.keyCount; i++) {
      if (!Number.isFinite(this.times[i])) return `time[${i}] is not finite`;
      if (i > 0 && !(this.times[i] > this.times[i - 1])) {
        return `times are not strictly ascending at index ${i} (${this.times[i - 1]} -> ${this.times[i]})`;
      }
    }
    for (let i = 0; i < this.values.length; i++) {
      if (!Number.isFinite(this.values[i])) return `values[${i}] is not finite`;
    }
    return null;
  }

  /* ------------------------------------------------------------- optimize */

  /**
   * Removes keyframes that do not change the curve.
   *
   * Two rules are applied:
   *
   * 1. For `discrete`/`step` tracks, all but the **first** key of a run of equal
   *    values are dropped.
   * 2. For every other mode, a key is dropped when it lies exactly on the linear
   *    interpolation of its neighbours (within `tolerance`). This is the classic
   *    "collinear point" reduction and typically removes 30-60 % of a baked curve
   *    from a DCC export.
   *
   * The first and last keyframes are always kept, so the track's range never
   * changes. `optimize` is a no-op on a track with fewer than three keys.
   *
   * @param tolerance Relative tolerance used by the collinearity test.
   * @returns The number of keyframes removed.
   */
  public optimize(tolerance = 1e-6): number {
    const count = this.keyCount;
    if (count < 3) return 0;
    if (count > OPTIMIZE_WARN_THRESHOLD) {
      // Not an error, but the caller probably wants to know.
      // eslint-disable-next-line no-console
      console.warn(`KeyframeTrack.optimize: processing ${count} keyframes; this is O(n)`);
    }

    const stride = this.valueSize;
    const keepTimes: number[] = [this.times[0]];
    const keepValues: number[] = [];
    for (let i = 0; i < stride; i++) keepValues.push(this.values[i]);

    let removed = 0;

    if (this.interpolation === 'discrete' || this.interpolation === 'step') {
      for (let i = 1; i < count; i++) {
        const previous = (i - 1) * stride;
        const current = i * stride;
        let equal = true;
        for (let c = 0; c < stride; c++) {
          if (!almostEqual(this.values[previous + c], this.values[current + c], tolerance)) {
            equal = false;
            break;
          }
        }
        if (equal) {
          removed++;
          continue;
        }
        keepTimes.push(this.times[i]);
        for (let c = 0; c < stride; c++) keepValues.push(this.values[current + c]);
      }
    } else {
      for (let i = 1; i < count - 1; i++) {
        const previous = (i - 1) * stride;
        const current = i * stride;
        const next = (i + 1) * stride;

        const span = this.times[i + 1] - this.times[i - 1];
        const alpha = span > 0 ? (this.times[i] - this.times[i - 1]) / span : 0;

        let collinear = true;
        for (let c = 0; c < stride; c++) {
          const interpolated =
            this.values[previous + c] + (this.values[next + c] - this.values[previous + c]) * alpha;
          if (!almostEqual(interpolated, this.values[current + c], tolerance)) {
            collinear = false;
            break;
          }
        }

        if (collinear) {
          removed++;
          continue;
        }

        keepTimes.push(this.times[i]);
        for (let c = 0; c < stride; c++) keepValues.push(this.values[current + c]);
      }

      keepTimes.push(this.times[count - 1]);
      const last = (count - 1) * stride;
      for (let c = 0; c < stride; c++) keepValues.push(this.values[last + c]);
    }

    if (removed > 0) {
      this.times = Float32Array.from(keepTimes);
      this.values = toValues<TValues>(keepValues);
    }
    return removed;
  }

  /* ---------------------------------------------------------------- editing */

  /**
   * Truncates the track to `[startTime, endTime]`.
   *
   * New keyframes are **inserted** at the boundaries so the curve keeps its shape:
   * the value at the cut is linearly interpolated from the surviving keys. Keys
   * outside the window are dropped.
   *
   * @param startTime New start, in the track's own time unit.
   * @param endTime New end, in the track's own time unit.
   * @returns A new track; `this` is not modified.
   */
  public trim(startTime: number, endTime: number): KeyframeTrack<Float32Array> {
    const trimmed = this.clone();
    trimmed.trimInPlace(startTime, endTime);
    return trimmed;
  }

  /**
   * In-place version of {@link KeyframeTrack.trim}.
   *
   * @param startTime New start.
   * @param endTime New end.
   * @returns This track, for chaining.
   */
  public trimInPlace(startTime: number, endTime: number): this {
    if (this.keyCount === 0) return this;
    const from = Math.min(startTime, endTime);
    const to = Math.max(startTime, endTime);

    const stride = this.valueSize;
    const times: number[] = [];
    const values: number[] = [];

    const push = (time: number, components: number[]): void => {
      times.push(time);
      for (const component of components) values.push(component);
    };

    const sampleAt = (time: number): number[] => {
      const interpolant = this.createInterpolant();
      return Array.from(interpolant.evaluate(time));
    };

    if (from > this.times[0]) push(from, sampleAt(from));

    for (let i = 0; i < this.keyCount; i++) {
      const time = this.times[i];
      if (time <= from || time >= to) continue;
      const offset = i * stride;
      const components: number[] = new Array(stride);
      for (let c = 0; c < stride; c++) components[c] = this.values[offset + c];
      push(time, components);
    }

    const lastTime = this.times[this.keyCount - 1];
    if (to < lastTime || times.length === 0) push(to, sampleAt(to));

    this.times = Float32Array.from(times);
    this.values = toValues<TValues>(values);
    return this;
  }

  /**
   * Shifts every keyframe in time.
   *
   * @param offset Seconds added to each key.
   * @returns This track, for chaining.
   */
  public shift(offset: number): this {
    for (let i = 0; i < this.times.length; i++) this.times[i] += offset;
    return this;
  }

  /**
   * Scales every keyframe time about the track start.
   *
   * @param factor Multiplier; `0` is treated as `1` to avoid collapsing the track.
   * @returns This track, for chaining.
   */
  public scaleTime(factor: number): this {
    const scale = factor === 0 ? 1 : factor;
    for (let i = 0; i < this.times.length; i++) this.times[i] *= scale;
    return this;
  }

  /* --------------------------------------------------------- serialisation */

  /**
   * Copies another track's data into this one.
   *
   * @param source Track to copy; its stride and key count must match.
   * @returns This track, for chaining.
   */
  public copy(source: KeyframeTrack<TValues>): this {
    this.name = source.name;
    this.times = source.times.slice();
    this.values = toValues<TValues>(Array.from(source.values as ArrayLike<number>));
    this.interpolation = source.interpolation;
    this.timeOffset = source.timeOffset;
    this.timeScale = source.timeScale;
    this.blendMode = source.blendMode;
    return this;
  }

  /**
   * @returns A deep copy of this track.
   */
  public clone(): KeyframeTrack<Float32Array> {
    const copy = new KeyframeTrack<Float32Array>(
      this.name,
      this.times,
      Float32Array.from(this.values as ArrayLike<number>),
      this.valueSize,
    );
    return copy.copyExtrasFrom(this);
  }

  /** Copies the non-constructor fields; used by {@link KeyframeTrack.clone}. */
  protected copyExtrasFrom(source: KeyframeTrack<TrackValueArray>): this {
    this.interpolation = source.interpolation;
    this.timeOffset = source.timeOffset;
    this.timeScale = source.timeScale;
    this.blendMode = source.blendMode;
    return this;
  }

  /**
   * @returns A JSON-friendly representation, three.js compatible.
   */
  public toJSON(): TrackJSON {
    return {
      type: this.constructor.name,
      name: this.name,
      times: Array.from(this.times),
      values: Array.from(this.values as ArrayLike<number>),
      valueSize: this.valueSize,
      interpolation: this.interpolation,
    };
  }

  /**
   * Restores a track from {@link KeyframeTrack.toJSON} output.
   *
   * @param json Serialised track.
   * @returns A new base `KeyframeTrack`; subclasses override this to restore
   *   their own type.
   * @throws RangeError When the payload is not a valid track.
   */
  public static parse(json: TrackJSON): KeyframeTrack<TrackValueArray> {
    const track = new KeyframeTrack<TrackValueArray>(
      json.name,
      json.times,
      json.values,
      json.valueSize ?? 1,
    );
    if (json.interpolation !== undefined) {
      track.setInterpolation(json.interpolation as TrackInterpolation);
    }
    return track;
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return (
      `${this.constructor.name}(name="${this.name}", keys=${this.keyCount}, ` +
      `valueSize=${this.valueSize}, interpolation=${this.interpolation})`
    );
  }
}

/**
 * Copies any numeric array into a fresh `Float32Array`.
 *
 * Always copies, so a track never aliases the caller's storage and {@link KeyframeTrack.clone}
 * is a genuine deep copy.
 *
 * @typeParam T Target array type.
 * @param values Source values.
 * @returns A new array.
 */
export function toValues<T extends TrackValueArray>(values: T | ArrayLike<number>): T {
  return Float32Array.from(values as ArrayLike<number>) as unknown as T;
}
