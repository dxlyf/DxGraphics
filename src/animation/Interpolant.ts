/**
 * `Interpolant` — the numeric core of keyframe animation.
 *
 * An interpolant owns a copy of a track's flattened times and values and answers
 * one question: *"what is the value at time `t`?"* Keeping this in a separate
 * object from the track means a track can be re-bound to several objects and
 * several mixers while sharing its key data, and it means the search/interpolation
 * hot path has no property lookups at all.
 *
 * ```
 * Interpolant                          binary search + clamping
 * ├── DiscreteInterpolant               step / "hold previous"
 * ├── LinearInterpolant                 component-wise linear
 * │   ├── NumberInterpolant             stride 1
 * │   ├── VectorInterpolant             stride 2/3/4
 * │   └── ColorInterpolant              stride 4, RGBA
 * ├── QuaternionLinearInterpolant       stride 4, shortest-arc slerp
 * ├── SmoothInterpolant                 cubic smoothstep within each interval
 * └── CubicSplineInterpolant            Catmull-Rom with finite-difference tangents
 * ```
 *
 * ## Out-of-range behaviour
 *
 * Every interpolant **clamps**: `t` before the first key returns the first value,
 * `t` after the last key returns the last value. No interpolant ever extrapolates
 * — an animation that has run past its end holds its final pose, which is the
 * behaviour `AnimationAction.clampWhenFinished` relies on. This is asserted by the
 * test suite.
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';

/* -------------------------------------------------------------------------- */
/* Base                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Abstract keyframe interpolator.
 *
 * @typeParam TValueSize Number of components one keyframe occupies.
 */
export abstract class Interpolant<TValueSize extends number = number> {
  /** Keyframe times, in seconds; strictly ascending by contract. */
  public readonly times: Float32Array;

  /** Flattened keyframe values: `keyCount * valueSize` numbers. */
  public values: Float32Array;

  /** Components per keyframe. */
  public readonly valueSize: TValueSize;

  /** Number of keyframes. */
  public readonly keyCount: number;

  /** Backing store for the value returned by {@link Interpolant.evaluate}. */
  protected readonly result: Float32Array;

  /**
   * Cache of the interval found by the previous {@link Interpolant.evaluate} call.
   *
   * Sequential playback moves forward one interval at a time, so seeding the
   * search from here turns the common case into a couple of comparisons instead of
   * a full binary search.
   */
  protected cachedIndex = 0;

  /**
   * Creates an interpolant.
   *
   * The arrays are **copied** so that mutating the caller's track data cannot
   * silently invalidate an interpolant that is already bound to a mixer.
   *
   * @param times Ascending keyframe times.
   * @param values Flattened keyframe values.
   * @param valueSize Components per keyframe.
   * @throws RangeError When `valueSize < 1`, or when the value array is shorter
   *   than `times.length * valueSize`.
   */
  protected constructor(
    times: ArrayLike<number>,
    values: ArrayLike<number>,
    valueSize: TValueSize,
  ) {
    if (!Number.isFinite(valueSize) || valueSize < 1) {
      throw new RangeError(`Interpolant: valueSize must be a positive integer, received ${valueSize}`);
    }
    this.valueSize = valueSize;
    this.times = times instanceof Float32Array ? times.slice() : Float32Array.from(times);
    this.values = values instanceof Float32Array ? values.slice() : Float32Array.from(values);
    this.keyCount = Math.floor(this.times.length);
    this.result = new Float32Array(valueSize);

    if (this.values.length < this.keyCount * valueSize) {
      throw new RangeError(
        `Interpolant: values array holds ${this.values.length} numbers but ` +
          `${this.keyCount} keyframes x ${valueSize} components needs ` +
          `${this.keyCount * valueSize}`,
      );
    }
  }

  /**
   * Copies `times`/`values` from another interpolant.
   *
   * @param source Interpolant to copy from; its lengths must match.
   * @returns This interpolant, for chaining.
   */
  public copy(source: Interpolant<number>): this {
    this.times.set(source.times);
    this.values.set(source.values);
    this.cachedIndex = 0;
    return this;
  }

  /**
   * @returns A new interpolant of the same concrete type carrying the same data.
   */
  public abstract clone(): Interpolant<TValueSize>;

  /**
   * Evaluates the interpolant.
   *
   * @param t Time to sample, in the same unit as {@link Interpolant.times}.
   * @returns A view into the result buffer, valid until the next `evaluate` call.
   */
  public abstract evaluate(t: number): Float32Array;

  /* ------------------------------------------------------------- interval */

  /**
   * Finds the interval containing `t` and the normalised position inside it.
   *
   * @param t Time to locate.
   * @returns `{ index, alpha }` where `index` is the index of the interval's
   *   **left** keyframe (`keyCount - 1` when `t` is at or past the last key) and
   *   `alpha` is `0` at the left key and `1` at the right key.
   */
  protected findInterval(t: number): { index: number; alpha: number } {
    const last = this.keyCount - 1;
    if (last <= 0) return { index: 0, alpha: 0 };

    // Clamp first: this makes the method total, so the loops below only ever see
    // an interior `t`.
    if (t <= this.times[0]) return { index: 0, alpha: 0 };
    if (t >= this.times[last]) return { index: last, alpha: 0 };

    let index = Math.min(Math.max(this.cachedIndex, 0), last - 1);

    // Walk one step at a time before falling back to a search; monotonic playback
    // almost never leaves this loop's first iteration.
    if (this.times[index] > t) {
      while (index > 0 && this.times[index] > t) index--;
    } else {
      while (index < last - 1 && this.times[index + 1] <= t) index++;
    }

    if (t < this.times[index] || t >= this.times[index + 1]) {
      index = this.binarySearch(t);
    }

    this.cachedIndex = index;

    const span = this.times[index + 1] - this.times[index];
    // A zero-length interval (two identical keys) is a legal authoring mistake:
    // hold the left value instead of dividing by zero.
    const alpha = span > EPSILON ? (t - this.times[index]) / span : 0;
    return { index, alpha };
  }

  /** Classic half-open binary search over {@link Interpolant.times}. */
  private binarySearch(t: number): number {
    let low = 0;
    let high = this.keyCount - 1;
    while (low < high - 1) {
      const mid = (low + high) >> 1;
      if (this.times[mid] <= t) low = mid;
      else high = mid;
    }
    return low;
  }

  /** Writes keyframe `index` into the result buffer and returns it. */
  protected readKey(index: number): Float32Array {
    const stride = this.valueSize;
    const offset = Math.max(0, Math.min(index, this.keyCount - 1)) * stride;
    for (let i = 0; i < stride; i++) this.result[i] = this.values[offset + i];
    return this.result;
  }

  /**
   * @returns `true` when the keyframe times are strictly ascending.
   */
  public validate(): boolean {
    for (let i = 1; i < this.keyCount; i++) {
      if (!(this.times[i] > this.times[i - 1])) return false;
    }
    return true;
  }

  /**
   * @returns The first key's time, or `0` when the interpolant is empty.
   */
  public get startTime(): number {
    return this.keyCount > 0 ? this.times[0] : 0;
  }

  /**
   * @returns The last key's time, or `0` when the interpolant is empty.
   */
  public get endTime(): number {
    return this.keyCount > 0 ? this.times[this.keyCount - 1] : 0;
  }

  /**
   * @returns A human-readable description, e.g.
   *   `LinearInterpolant(keys=4, valueSize=3, range=[0, 1.5])`.
   */
  public toString(): string {
    return (
      `${this.constructor.name}(keys=${this.keyCount}, valueSize=${this.valueSize}, ` +
      `range=[${this.startTime}, ${this.endTime}])`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Discrete                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Step interpolant: the value jumps at each key and holds until the next one.
 *
 * `t` in `[times[i], times[i + 1])` yields key `i`; `t` at or after the last key
 * yields the last key.
 */
export class DiscreteInterpolant extends Interpolant<number> {
  /**
   * Creates a step interpolant.
   *
   * @param times Ascending keyframe times.
   * @param values Flattened keyframe values.
   * @param valueSize Components per keyframe.
   */
  constructor(times: ArrayLike<number>, values: ArrayLike<number>, valueSize: number) {
    super(times, values, valueSize);
  }

  /** @inheritdoc */
  public override clone(): DiscreteInterpolant {
    return new DiscreteInterpolant(this.times, this.values, this.valueSize);
  }

  /** @inheritdoc */
  public override evaluate(t: number): Float32Array {
    const last = this.keyCount - 1;
    if (last <= 0) return this.readKey(0);
    if (t <= this.times[0]) return this.readKey(0);
    if (t >= this.times[last]) return this.readKey(last);

    let index = Math.min(Math.max(this.cachedIndex, 0), last);
    while (index < last && this.times[index + 1] <= t) index++;
    while (index > 0 && this.times[index] > t) index--;
    this.cachedIndex = index;
    return this.readKey(index);
  }
}

/* -------------------------------------------------------------------------- */
/* Linear                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Component-wise linear interpolant.
 *
 * This is also the base for every stride-specialised variant, so a caller that
 * does not need quaternion slerp can use it directly for any `valueSize`.
 */
export class LinearInterpolant extends Interpolant<number> {
  /**
   * Creates a linear interpolant.
   *
   * @param times Ascending keyframe times.
   * @param values Flattened keyframe values.
   * @param valueSize Components per keyframe.
   */
  constructor(times: ArrayLike<number>, values: ArrayLike<number>, valueSize: number) {
    super(times, values, valueSize);
  }

  /** @inheritdoc */
  public override clone(): LinearInterpolant {
    return new LinearInterpolant(this.times, this.values, this.valueSize);
  }

  /** @inheritdoc */
  public override evaluate(t: number): Float32Array {
    const last = this.keyCount - 1;
    if (last <= 0) return this.readKey(0);

    const { index, alpha } = this.findInterval(t);
    const stride = this.valueSize;
    const left = index * stride;
    const right = left + stride;

    if (alpha <= 0) return this.readKey(index);

    for (let i = 0; i < stride; i++) {
      const a = this.values[left + i];
      const b = this.values[right + i];
      this.result[i] = a + (b - a) * alpha;
    }
    return this.result;
  }
}

/** Linear interpolant for a single scalar channel. */
export class NumberInterpolant extends LinearInterpolant {
  /**
   * Creates a scalar interpolant.
   *
   * @param times Ascending keyframe times.
   * @param values Flattened scalar keyframe values.
   */
  constructor(times: ArrayLike<number>, values: ArrayLike<number>) {
    super(times, values, 1);
  }

  /** @inheritdoc */
  public override clone(): NumberInterpolant {
    return new NumberInterpolant(this.times, this.values);
  }
}

/**
 * Linear interpolant for `valueSize`-component vectors.
 *
 * `valueSize` defaults to `3`; pass `2` or `4` for `Vec2`/`Vec4` tracks.
 */
export class VectorInterpolant extends LinearInterpolant {
  /**
   * Creates a vector interpolant.
   *
   * @param times Ascending keyframe times.
   * @param values Flattened vector keyframe values.
   * @param valueSize Components per keyframe; defaults to `3`.
   */
  constructor(times: ArrayLike<number>, values: ArrayLike<number>, valueSize: number = 3) {
    super(times, values, valueSize);
  }

  /** @inheritdoc */
  public override clone(): VectorInterpolant {
    return new VectorInterpolant(this.times, this.values, this.valueSize);
  }

  /**
   * Reads the last evaluated result as an `[x, y]` pair.
   *
   * @returns A new array; the interpolant's internal buffer is not exposed.
   */
  public toVec2(): [number, number] {
    return [this.result[0], this.result[1]];
  }

  /**
   * Reads the last evaluated result as an `[x, y, z]` triple.
   *
   * @returns A new array.
   */
  public toVec3(): [number, number, number] {
    return [this.result[0], this.result[1], this.result[2]];
  }

  /**
   * Reads the last evaluated result as an `[x, y, z, w]` tuple.
   *
   * @returns A new array.
   */
  public toVec4(): [number, number, number, number] {
    return [this.result[0], this.result[1], this.result[2], this.result[3]];
  }
}

/**
 * Component-wise interpolant for RGBA colours stored as `(r, g, b, a)`.
 *
 * Interpolation is **linear in the stored component space**, matching three.js; it
 * does not rotate through hue.
 */
export class ColorInterpolant extends LinearInterpolant {
  /**
   * Creates a colour interpolant.
   *
   * @param times Ascending keyframe times.
   * @param values Flattened `(r, g, b[, a])` keyframe values.
   * @param valueSize Components per keyframe; defaults to `4`.
   */
  constructor(times: ArrayLike<number>, values: ArrayLike<number>, valueSize: number = 4) {
    super(times, values, valueSize);
  }

  /** @inheritdoc */
  public override clone(): ColorInterpolant {
    return new ColorInterpolant(this.times, this.values, this.valueSize);
  }

  /**
   * Reads the last evaluated result as an `[r, g, b, a]` tuple.
   *
   * @returns A new array; alpha defaults to `1` for three-component tracks.
   */
  public toRGBA(): [number, number, number, number] {
    return [this.result[0], this.result[1], this.result[2], this.valueSize >= 4 ? this.result[3] : 1];
  }
}

/**
 * Quaternion interpolant using shortest-arc spherical linear interpolation.
 *
 * Values are stored as `(x, y, z, w)` per keyframe. Slerp flips a keyframe's sign
 * when its dot product with the previous one is negative, so `q` and `-q` — the
 * same rotation — never produce a 360° spin. A near-parallel pair falls back to
 * normalised linear interpolation, which is exact in the limit and avoids dividing
 * by a vanishing `sin(theta)`.
 */
export class QuaternionLinearInterpolant extends Interpolant<4> {
  /**
   * Creates a quaternion interpolant.
   *
   * @param times Ascending keyframe times.
   * @param values Flattened `(x, y, z, w)` keyframe values.
   */
  constructor(times: ArrayLike<number>, values: ArrayLike<number>) {
    super(times, values, 4);
  }

  /** @inheritdoc */
  public override clone(): QuaternionLinearInterpolant {
    return new QuaternionLinearInterpolant(this.times, this.values);
  }

  /** @inheritdoc */
  public override evaluate(t: number): Float32Array {
    const last = this.keyCount - 1;
    if (last <= 0) return this.readKey(0);

    const { index, alpha } = this.findInterval(t);
    const left = index * 4;
    const right = left + 4;

    const ax = this.values[left];
    const ay = this.values[left + 1];
    const az = this.values[left + 2];
    const aw = this.values[left + 3];

    let bx = this.values[right];
    let by = this.values[right + 1];
    let bz = this.values[right + 2];
    let bw = this.values[right + 3];

    if (alpha <= 0) return this.readKey(index);

    let cos = ax * bx + ay * by + az * bz + aw * bw;
    if (cos < 0) {
      // Take the short way round: `-q` is the same rotation.
      cos = -cos;
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }

    if (cos > 1 - EPSILON) {
      // Almost parallel: lerp then normalise. Lerping the offset from `a` keeps
      // the interpolation exact at alpha = 0.
      const x = ax + (bx - ax) * alpha;
      const y = ay + (by - ay) * alpha;
      const z = az + (bz - az) * alpha;
      const w = aw + (bw - aw) * alpha;
      const inverse = 1 / (Math.sqrt(x * x + y * y + z * z + w * w) || 1);
      this.result[0] = x * inverse;
      this.result[1] = y * inverse;
      this.result[2] = z * inverse;
      this.result[3] = w * inverse;
      return this.result;
    }

    const theta = Math.acos(Math.min(1, cos));
    const sinTheta = Math.sin(theta);
    const wa = Math.sin((1 - alpha) * theta) / sinTheta;
    const wb = Math.sin(alpha * theta) / sinTheta;

    this.result[0] = ax * wa + bx * wb;
    this.result[1] = ay * wa + by * wb;
    this.result[2] = az * wa + bz * wb;
    this.result[3] = aw * wa + bw * wb;
    return this.result;
  }
}

/* -------------------------------------------------------------------------- */
/* Smooth                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Cubic smoothstep interpolant.
 *
 * Within each interval `alpha` is remapped through `alpha²(3 - 2alpha)` before the
 * component-wise lerp, so the value leaves and arrives with zero velocity. This is
 * the "the animation should feel soft" option that needs no extra keyframes.
 */
export class SmoothInterpolant extends Interpolant<number> {
  /**
   * Creates a smoothstep interpolant.
   *
   * @param times Ascending keyframe times.
   * @param values Flattened keyframe values.
   * @param valueSize Components per keyframe.
   */
  constructor(times: ArrayLike<number>, values: ArrayLike<number>, valueSize: number) {
    super(times, values, valueSize);
  }

  /** @inheritdoc */
  public override clone(): SmoothInterpolant {
    return new SmoothInterpolant(this.times, this.values, this.valueSize);
  }

  /** @inheritdoc */
  public override evaluate(t: number): Float32Array {
    const last = this.keyCount - 1;
    if (last <= 0) return this.readKey(0);

    const { index, alpha } = this.findInterval(t);
    const stride = this.valueSize;
    const left = index * stride;
    const right = left + stride;

    if (alpha <= 0) return this.readKey(index);

    const smooth = alpha * alpha * (3 - 2 * alpha);
    for (let i = 0; i < stride; i++) {
      const a = this.values[left + i];
      const b = this.values[right + i];
      this.result[i] = a + (b - a) * smooth;
    }
    return this.result;
  }
}

/**
 * Catmull-Rom cubic-spline interpolant.
 *
 * Tangents are estimated from the neighbouring keyframes with the standard
 * `(p[i+1] - p[i-1]) / (t[i+1] - t[i-1])` finite difference, using one-sided
 * differences at the ends so the curve passes exactly through the first and last
 * keys. Unlike {@link SmoothInterpolant} this produces continuous *velocity*, at
 * the cost of possible overshoot when keyframes alternate sharply.
 */
export class CubicSplineInterpolant extends Interpolant<number> {
  /**
   * Creates a Catmull-Rom interpolant.
   *
   * @param times Ascending keyframe times.
   * @param values Flattened keyframe values.
   * @param valueSize Components per keyframe.
   */
  constructor(times: ArrayLike<number>, values: ArrayLike<number>, valueSize: number) {
    super(times, values, valueSize);
  }

  /** @inheritdoc */
  public override clone(): CubicSplineInterpolant {
    return new CubicSplineInterpolant(this.times, this.values, this.valueSize);
  }

  /** @inheritdoc */
  public override evaluate(t: number): Float32Array {
    const last = this.keyCount - 1;
    if (last <= 0) return this.readKey(0);

    const { index, alpha } = this.findInterval(t);
    const stride = this.valueSize;
    const p1 = index * stride;
    const p2 = p1 + stride;

    if (alpha <= 0) return this.readKey(index);

    const i0 = index > 0 ? index - 1 : index;
    const i3 = index + 2 <= last ? index + 2 : last;
    const p0 = i0 * stride;
    const p3 = i3 * stride;

    const t0 = this.times[i0];
    const t1 = this.times[index];
    const t2 = this.times[index + 1];
    const t3 = this.times[i3];

    const a2 = alpha * alpha;
    const a3 = a2 * alpha;
    // Hermite basis for a unit interval.
    const h00 = 2 * a3 - 3 * a2 + 1;
    const h10 = a3 - 2 * a2 + alpha;
    const h01 = -2 * a3 + 3 * a2;
    const h11 = a3 - a2;

    const span = t2 - t1 || 1;

    for (let i = 0; i < stride; i++) {
      const v0 = this.values[p0 + i];
      const v1 = this.values[p1 + i];
      const v2 = this.values[p2 + i];
      const v3 = this.values[p3 + i];

      const m1 = (v2 - v0) / ((t2 - t0) || 1);
      const m2 = (v3 - v1) / ((t3 - t1) || 1);

      this.result[i] = h00 * v1 + h10 * span * m1 + h01 * v2 + h11 * span * m2;
    }
    return this.result;
  }
}

/* -------------------------------------------------------------------------- */
/* Factories                                                                  */
/* -------------------------------------------------------------------------- */

/** Interpolation modes accepted by {@link createInterpolant}. */
export type InterpolantKind =
  | 'discrete'
  | 'step'
  | 'linear'
  | 'smooth'
  | 'smoothstep'
  | 'spline'
  | 'catmullrom'
  | 'quaternion'
  | 'color'
  | 'number'
  | 'vector';

/**
 * Builds the interpolant for an interpolation mode.
 *
 * @param kind Mode name; unknown names fall back to `'linear'`.
 * @param times Ascending keyframe times.
 * @param values Flattened keyframe values.
 * @param valueSize Components per keyframe; defaults to `1`.
 * @returns A concrete interpolant.
 */
export function createInterpolant(
  kind: InterpolantKind,
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  valueSize: number = 1,
): Interpolant<number> {
  switch (kind) {
    case 'discrete':
    case 'step':
      return new DiscreteInterpolant(times, values, valueSize);
    case 'smooth':
    case 'smoothstep':
      return new SmoothInterpolant(times, values, valueSize);
    case 'spline':
    case 'catmullrom':
      return new CubicSplineInterpolant(times, values, valueSize);
    case 'quaternion':
      return new QuaternionLinearInterpolant(times, values);
    case 'color':
      return new ColorInterpolant(times, values, valueSize || 4);
    case 'number':
      return new NumberInterpolant(times, values);
    case 'vector':
      return new VectorInterpolant(times, values, valueSize || 3);
    case 'linear':
    default:
      return new LinearInterpolant(times, values, valueSize);
  }
}

/**
 * @param value Candidate value.
 * @returns `true` when `value` is an {@link Interpolant}.
 */
export function isInterpolant(value: unknown): value is Interpolant<number> {
  return value instanceof Interpolant;
}
