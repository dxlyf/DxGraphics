/**
 * `Timer` — scheduling primitives on top of the frame loop.
 *
 * Everything here is *polled* rather than callback-driven: the owner calls
 * {@link Timer.update} once per frame with the frame delta, and the timer reports
 * whether it fired. That keeps ordering deterministic, which matters when an
 * animation and the logic that reacts to it run in the same frame.
 *
 * ```ts
 * const spawn = new Timer(0.5, { repeat: true });
 * if (spawn.update(delta)) spawnEnemy();
 * ```
 *
 * @packageDocumentation
 */

import { DEFAULT_FPS } from '../constants';
import { clamp } from '../utils/MathUtils';
import { EventEmitter } from './EventEmitter';

/** Events emitted by {@link Timer}. */
export interface TimerEvents {
  /** Fired on every tick where the timer elapsed. */
  tick: [count: number];
  /** Fired when a non-repeating timer completes. */
  complete: [];
  /** Fired when {@link Timer.start} is called. */
  start: [];
  /** Fired when {@link Timer.stop} is called. */
  stop: [];
  /** Fired when {@link Timer.reset} is called. */
  reset: [];
}

/** Options accepted by {@link Timer}. */
export interface TimerOptions {
  /** Repeat after each tick (default `false`). */
  repeat?: boolean;
  /** Start running immediately (default `true`). */
  autoStart?: boolean;
  /** Skip the first tick so the callback only fires after one full interval. */
  skipFirst?: boolean;
  /** Time scale applied to every update (default `1`). */
  timeScale?: number;
  /** Raise the interval to this multiple of itself on each tick. */
  growFactor?: number;
  /** Upper bound for the interval when `growFactor` is used. */
  maxInterval?: number;
}

/**
 * A polled interval timer.
 */
export class Timer {
  /** Event bus. */
  public readonly events = new EventEmitter<TimerEvents>();

  /** Interval in seconds. */
  public interval: number;

  /** `true` to keep firing; `false` to complete after one tick. */
  public repeat: boolean;

  /** Multiplier applied to the delta passed to {@link update}. */
  public timeScale: number;

  /** Multiplier applied to `interval` after every tick (`1` disables growth). */
  public growFactor: number;

  /** Upper bound for `interval` when {@link growFactor} is in use. */
  public maxInterval: number;

  /** Seconds accumulated inside the current interval. */
  public elapsed = 0;

  /** Number of ticks fired so far. */
  public count = 0;

  /** `true` while the timer accumulates time. */
  public running: boolean;

  /** `true` once a non-repeating timer has fired. */
  public completed = false;

  /** `true` to suppress the first tick. */
  private awaitingFirst: boolean;

  /**
   * @param interval Seconds between ticks.
   * @param options See {@link TimerOptions}.
   */
  constructor(interval: number, options: TimerOptions = {}) {
    this.interval = interval;
    this.repeat = options.repeat ?? false;
    this.timeScale = options.timeScale ?? 1;
    this.growFactor = options.growFactor ?? 1;
    this.maxInterval = options.maxInterval ?? Infinity;
    this.running = options.autoStart ?? true;
    this.awaitingFirst = options.skipFirst ?? false;
  }

  /** Fraction of the current interval that has elapsed, in `[0, 1]`. */
  public get progress(): number {
    return this.interval > 0 ? clamp(this.elapsed / this.interval, 0, 1) : 1;
  }

  /** Seconds remaining before the next tick. */
  public get remaining(): number {
    return Math.max(0, this.interval - this.elapsed);
  }

  /** `true` when the timer will still fire. */
  public get isPending(): boolean {
    return this.running || (this.repeat && !this.completed);
  }

  /* -------------------------------------------------------------- controls */

  /** Starts (or resumes) accumulation. */
  public start(): this {
    if (this.running) return this;
    this.running = true;
    this.events.emit('start');
    return this;
  }

  /** Pauses accumulation, keeping `elapsed` and `count`. */
  public stop(): this {
    if (!this.running) return this;
    this.running = false;
    this.events.emit('stop');
    return this;
  }

  /** Clears `elapsed` and `count` and starts again. */
  public reset(): this {
    this.elapsed = 0;
    this.count = 0;
    this.completed = false;
    this.running = true;
    this.events.emit('reset');
    return this;
  }

  /** Sets the interval, clamped to a positive value. */
  public setInterval(interval: number): this {
    this.interval = Math.max(0, interval);
    return this;
  }

  /** Multiplies the interval by `factor` (for back-off schedules). */
  public scaleInterval(factor: number): this {
    this.interval = clamp(this.interval * factor, 0, this.maxInterval);
    return this;
  }

  /**
   * Advances the timer.
   *
   * @param delta Elapsed seconds since the previous update.
   * @returns `true` when the timer fired during this update. A large `delta` can
   *   produce several ticks; each one fires the `tick` event.
   */
  public update(delta: number): boolean {
    if (!this.running || (this.completed && !this.repeat)) return false;

    const scaled = delta * this.timeScale;
    if (scaled <= 0) return false;

    if (this.awaitingFirst) {
      this.awaitingFirst = false;
      // `skipFirst` consumes the first interval without firing.
      this.elapsed += scaled;
      if (this.elapsed >= this.interval) this.elapsed -= this.interval;
      return false;
    }

    if (this.interval <= 0) {
      // A zero interval fires once per update.
      return this.fire();
    }

    this.elapsed += scaled;

    let fired = false;
    // Guard against pathological deltas producing thousands of ticks.
    let guard = 0;
    while (this.elapsed >= this.interval && guard < 1000) {
      this.elapsed -= this.interval;
      fired = this.fire() || fired;
      guard++;
      if (this.completed && !this.repeat) break;
    }
    if (guard >= 1000) this.elapsed = 0;
    return fired;
  }

  /** Records one tick and emits the corresponding events. */
  private fire(): boolean {
    this.count++;
    this.events.emit('tick', this.count);
    if (this.growFactor !== 1) this.scaleInterval(this.growFactor);
    if (!this.repeat) {
      this.completed = true;
      this.running = false;
      this.events.emit('complete');
    }
    return true;
  }

  /* -------------------------------------------------------------- helpers */

  /** Registers a tick listener; returns an unsubscribe function. */
  public onTick(listener: (count: number) => void): () => void {
    return this.events.on('tick', listener);
  }

  /** Registers a completion listener; returns an unsubscribe function. */
  public onComplete(listener: () => void): () => void {
    return this.events.on('complete', listener);
  }

  /** JSON-friendly state snapshot. */
  public toJSON(): {
    interval: number;
    elapsed: number;
    count: number;
    running: boolean;
    repeat: boolean;
    completed: boolean;
  } {
    return {
      interval: this.interval,
      elapsed: this.elapsed,
      count: this.count,
      running: this.running,
      repeat: this.repeat,
      completed: this.completed,
    };
  }

  /** Human-readable state. */
  public toString(): string {
    return `Timer(interval=${this.interval.toFixed(3)}s, progress=${(this.progress * 100).toFixed(1)}%, ticks=${this.count})`;
  }
}

/**
 * Fixed-step accumulator.
 *
 * Separates "how much time passed" from "how many simulation steps to run",
 * which is the standard way to keep a physics/update loop stable when the frame
 * rate varies.
 */
export class FrameAccumulator {
  /** Fixed step in seconds. */
  public step: number;

  /** Largest number of steps allowed per frame (spiral-of-death guard). */
  public maxSteps: number;

  /** Seconds accumulated but not yet consumed. */
  public accumulator = 0;

  /** Interpolation alpha in `[0, 1)` describing how far into the next step we are. */
  public alpha = 0;

  /** Total steps consumed since the last {@link reset}. */
  public totalSteps = 0;

  /** Creates an accumulator; defaults to a 60 Hz step. */
  constructor(step: number = 1 / DEFAULT_FPS, maxSteps: number = 5) {
    this.step = step;
    this.maxSteps = maxSteps;
  }

  /**
   * Adds `delta` seconds.
   *
   * @returns The number of fixed steps to run this frame.
   */
  public advance(delta: number): number {
    this.accumulator += delta;
    let steps = 0;
    while (this.accumulator >= this.step && steps < this.maxSteps) {
      this.accumulator -= this.step;
      steps++;
    }
    if (steps >= this.maxSteps) {
      // Drop the backlog rather than letting it grow without bound.
      this.accumulator = Math.min(this.accumulator, this.step);
    }
    this.totalSteps += steps;
    this.alpha = this.step > 0 ? this.accumulator / this.step : 0;
    return steps;
  }

  /** Clears the accumulator. */
  public reset(): this {
    this.accumulator = 0;
    this.alpha = 0;
    this.totalSteps = 0;
    return this;
  }

  /**
   * Runs `callback` once per pending fixed step.
   *
   * @returns The number of steps executed.
   */
  public run(delta: number, callback: (step: number) => void): number {
    const steps = this.advance(delta);
    for (let i = 0; i < steps; i++) callback(i);
    return steps;
  }
}

/**
 * Counts down to zero and reports done.
 *
 * ```ts
 * const cooldown = new Countdown(1.5);
 * cooldown.update(delta);
 * if (cooldown.finished) attack();
 * ```
 */
export class Countdown {
  /** Seconds remaining. */
  public remaining: number;

  /** Duration the countdown was created with. */
  public readonly duration: number;

  /** `true` once `remaining` reaches zero, until {@link reset}. */
  public finished = false;

  /** Creates a countdown of `duration` seconds. */
  constructor(duration: number, autoStart: boolean = true) {
    this.duration = duration;
    this.remaining = autoStart ? duration : Infinity;
    this.finished = !autoStart && duration <= 0;
  }

  /** Fraction still remaining, in `[0, 1]`. */
  public get progress(): number {
    return this.duration > 0 ? clamp(this.remaining / this.duration, 0, 1) : 0;
  }

  /** Advances the countdown. Returns `true` on the frame it reaches zero. */
  public update(delta: number): boolean {
    if (this.finished) return false;
    this.remaining -= delta;
    if (this.remaining <= 0) {
      this.remaining = 0;
      this.finished = true;
      return true;
    }
    return false;
  }

  /** Restarts the countdown with the original duration. */
  public reset(duration: number = this.duration): this {
    this.remaining = duration;
    this.finished = false;
    return this;
  }

  /** Skips the countdown immediately. */
  public finish(): this {
    this.remaining = 0;
    this.finished = true;
    return this;
  }
}
