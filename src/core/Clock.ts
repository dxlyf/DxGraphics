/**
 * `Clock` — frame timing with a smoothed, clamped delta.
 *
 * ```ts
 * const clock = new Clock();
 * function frame() {
 *   const delta = clock.getDelta();   // seconds, clamped to MAX_DELTA
 *   update(delta);
 *   requestAnimationFrame(frame);
 * }
 * ```
 *
 * The delta is clamped (default {@link MAX_DELTA}) so a backgrounded tab does not
 * make physics explode on resume, and an exponential moving average is exposed
 * through {@link Clock.smoothedDelta} for animation blending.
 *
 * @packageDocumentation
 */

import { DEFAULT_FPS, MAX_DELTA } from '../constants';
import { clamp } from '../utils/MathUtils';

/** Options accepted by {@link Clock}. */
export interface ClockOptions {
  /** Start the clock immediately (default `true`). */
  autoStart?: boolean;
  /** Lower bound applied to every delta, in seconds. */
  minDelta?: number;
  /** Upper bound applied to every delta, in seconds. */
  maxDelta?: number;
  /** Smoothing factor for {@link Clock.smoothedDelta} in `[0, 1)`. */
  smoothing?: number;
  /** Fixed timestep mode; when set, deltas are quantised to this value. */
  fixedDelta?: number;
  /** Assumed frames per second used to seed the smoothing average. */
  assumedFps?: number;
}

/** Frame timing source. */
export class Clock {
  /** `true` while the clock accumulates time. */
  public running = false;

  /** `true` when the clock has been started at least once. */
  public autoStart: boolean;

  /** Lower bound applied to each delta. */
  public minDelta: number;

  /** Upper bound applied to each delta. */
  public maxDelta: number;

  /** Smoothing factor for {@link smoothedDelta}. */
  public smoothing: number;

  /** When set, deltas are quantised to this exact value. */
  public fixedDelta: number | null;

  /** Total elapsed time in seconds (excluding paused periods). */
  public elapsed = 0;

  /** Number of {@link getDelta} calls made. */
  public frameCount = 0;

  /** Timestamp (ms) of the previous tick. */
  protected previousTime = 0;

  /** Timestamp (ms) when the clock (re)started. */
  private startTime = 0;

  /** Accumulated time while paused, used to keep `elapsed` monotonic. */
  private pausedDuration = 0;

  /** Timestamp (ms) when {@link stop} was called. */
  private pausedAt = 0;

  /** Exponential moving average of the delta, in seconds. */
  private average = 0;

  /** Delta reported by the most recent {@link getDelta} call. */
  private lastDelta = 0;

  /** Creates a clock. */
  constructor(options: ClockOptions = {}) {
    this.autoStart = options.autoStart ?? true;
    this.minDelta = options.minDelta ?? 0;
    this.maxDelta = options.maxDelta ?? MAX_DELTA;
    this.smoothing = clamp(options.smoothing ?? 0.2, 0, 0.999);
    this.fixedDelta = options.fixedDelta ?? null;
    this.average = 1 / (options.assumedFps ?? DEFAULT_FPS);

    if (this.autoStart) this.start();
  }

  /** Delta reported by the last {@link getDelta} call, in seconds. */
  public get delta(): number {
    return this.lastDelta;
  }

  /** Smoothed delta, in seconds. */
  public get smoothedDelta(): number {
    return this.average;
  }

  /** `1 / smoothedDelta`, i.e. the estimated instantaneous frame rate. */
  public get fps(): number {
    return this.average > 0 ? 1 / this.average : 0;
  }

  /** Milliseconds since the clock was constructed. */
  public get elapsedMilliseconds(): number {
    return this.elapsed * 1000;
  }

  /** Timestamp (ms) of the previous tick, in the host's time base. */
  public get previousTimestamp(): number {
    return this.previousTime;
  }

  /**
   * Starts (or restarts) the clock.
   *
   * @param now Optional timestamp in milliseconds; defaults to
   *   `performance.now()`.
   */
  public start(now: number = Clock.now()): this {
    this.running = true;
    this.startTime = now;
    this.previousTime = now;
    this.pausedDuration = 0;
    this.pausedAt = 0;
    this.elapsed = 0;
    this.frameCount = 0;
    this.lastDelta = 0;
    return this;
  }

  /** Pauses the clock. Elapsed time stops accumulating until {@link start}. */
  public stop(now: number = Clock.now()): this {
    if (!this.running) return this;
    this.running = false;
    this.pausedAt = now;
    return this;
  }

  /** Resumes after {@link stop} without resetting the elapsed time. */
  public resume(now: number = Clock.now()): this {
    if (this.running) return this;
    if (this.pausedAt > 0) this.pausedDuration += now - this.pausedAt;
    this.pausedAt = 0;
    this.previousTime = now;
    this.running = true;
    return this;
  }

  /** Clears the elapsed time and frame counter and restarts. */
  public reset(now: number = Clock.now()): this {
    return this.start(now);
  }

  /**
   * Advances the clock and returns the delta since the previous call.
   *
   * The reported delta is quantised to `fixedDelta` when one is set and clamped to
   * `[minDelta, maxDelta]`, so a consumer that steps an animation cannot be teleported
   * by a backgrounded tab. {@link elapsed} accumulates **that same reported delta**,
   * not the raw wall-clock gap: otherwise `elapsed` and `getDelta()` would describe two
   * different timelines, and a caller summing the deltas it was handed could never
   * reconcile them with `getElapsedTime()`.
   *
   * @param now Optional timestamp in milliseconds.
   * @returns Delta in seconds, quantised and clamped. Returns `0` while the clock is
   *   stopped.
   */
  public getDelta(now: number = Clock.now()): number {
    if (!this.running) return 0;

    let delta = (now - this.previousTime) / 1000;
    this.previousTime = now;

    if (delta < 0) delta = 0; // Clock went backwards (system time adjustment).

    if (this.fixedDelta !== null) delta = this.fixedDelta;
    delta = clamp(delta, this.minDelta, this.maxDelta);

    this.frameCount++;
    this.elapsed += delta;

    this.lastDelta = delta;
    this.average += (delta - this.average) * this.smoothing;
    return delta;
  }

  /**
   * Total elapsed time in seconds.
   *
   * A **read**, not an advance. It does not call {@link getDelta}, so reading it never
   * mutates the clock and never produces a delta. To advance and read in one step, use
   * {@link getDelta} followed by this.
   *
   * This was previously an advancing read, which made it unusable for its two obvious
   * purposes: sampling the current time, and interpolating against a time that was set
   * explicitly. On a {@link ManualClock} it was worse than useless — with no argument it
   * measured from timestamp `0` to the host's wall clock, so
   * `clock.setTime(0); clock.advance(0.5); clock.getElapsedTime()` returned roughly the
   * age of the browser process rather than `0.5`.
   */
  public getElapsedTime(): number {
    return this.elapsed;
  }

  /**
   * The most recent delta in milliseconds.
   *
   * A **read**, not an advance: it returns the delta the last {@link getDelta} produced.
   * Advancing here as well double-counted every call, so a loop that stepped the clock
   * with `getDelta()` and then displayed `getDeltaMilliseconds()` reported a delta the
   * clock had never used.
   */
  public getDeltaMilliseconds(): number {
    return this.lastDelta * 1000;
  }

  /**
   * Number of fixed steps that fit into `delta`.
   *
   * A convenience for fixed-timestep loops:
   * ```ts
   * let accumulator = 0;
   * accumulator += clock.getDelta();
   * const steps = clock.fixedStepCount(accumulator, 1 / 60);
   * ```
   */
  public fixedStepCount(delta: number, step: number): number {
    return step > 0 ? Math.floor(delta / step) : 0;
  }

  /** Snapshot of the clock's current state. */
  public toJSON(): {
    running: boolean;
    elapsed: number;
    delta: number;
    smoothedDelta: number;
    fps: number;
    frameCount: number;
  } {
    return {
      running: this.running,
      elapsed: this.elapsed,
      delta: this.lastDelta,
      smoothedDelta: this.average,
      fps: this.fps,
      frameCount: this.frameCount,
    };
  }

  /** Human-readable state. */
  public toString(): string {
    return `Clock(${this.running ? 'running' : 'stopped'}, elapsed=${this.elapsed.toFixed(3)}s, fps≈${this.fps.toFixed(1)})`;
  }

  /** Monotonic timestamp in milliseconds. */
  public static now(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }
}

/**
 * A clock that never advances time.
 *
 * Used by deterministic tests and by tooling that drives frames manually.
 */
export class ManualClock extends Clock {
  /**
   * Creates a stopped manual clock.
   *
   * `maxDelta` is disabled (`Infinity`). The base class clamps every delta to
   * {@link MAX_DELTA} (0.1 s) so that a backgrounded tab cannot teleport an animation —
   * correct for a clock reading the wall clock, and exactly wrong here: `advance(0.25)`
   * would silently step the clock by 0.1 s, and `advance(2)` by the same 0.1 s. A manual
   * clock exists to move by the amount it is told to.
   */
  constructor() {
    super({ autoStart: false, smoothing: 0, assumedFps: 60, maxDelta: Infinity });
    this.running = true;
    this.previousTime = 0;
  }

  /**
   * Starts (or restarts) the clock at `now`, defaulting to the manual time base.
   *
   * Overridden because the base class defaults `now` to `Clock.now()`, the host's wall
   * clock. Mixing that into a manual clock makes it non-deterministic: an omitted
   * argument would jump the clock by however long the machine had been running.
   *
   * @param now Timestamp in milliseconds on the manual time base. Defaults to this
   *   clock's own current timestamp.
   */
  public override start(now: number = this.previousTime): this {
    return super.start(now);
  }

  /**
   * Advances the clock and returns the delta since the previous call.
   *
   * @param now Timestamp in milliseconds on the manual time base. Defaults to this
   *   clock's own current timestamp, so calling it without an argument advances nothing
   *   and returns `0` rather than reading the wall clock.
   */
  public override getDelta(now: number = this.previousTime): number {
    return super.getDelta(now);
  }

  /**
   * Advances time by `delta` seconds and returns that delta.
   *
   * The timestamp is derived from the clock's own accumulated time, never from
   * `performance.now()`.
   *
   * @param delta Seconds to advance. Negative values are ignored by `getDelta`, which
   *   clamps a backwards clock to `0`.
   */
  public advance(delta: number): number {
    return this.getDelta(this.previousTime + delta * 1000);
  }

  /**
   * Sets the elapsed time directly, without producing a delta.
   *
   * Resets the manual time base to match, so a following {@link ManualClock.advance}
   * measures from here. Without that the base would still be at its old value and the
   * next `advance` would report a delta that has nothing to do with `seconds`.
   *
   * @param seconds The elapsed time to adopt.
   */
  public setTime(seconds: number): this {
    this.elapsed = seconds;
    this.previousTime = 0;
    return this;
  }
}
