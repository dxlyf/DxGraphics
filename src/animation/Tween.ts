/**
 * `Tween` — a chainable, callback-driven property animator.
 *
 * Where `AnimationClip`/`AnimationMixer` serve skeletal, clip-based animation, a
 * tween serves one-off motion: a panel that slides in, a value that oscillates, a
 * number that counts up. Tweens are imperative and allocation-light, and they
 * advance from an explicit `update(delta)` call, so they are trivially
 * unit-testable with a manual clock.
 *
 * ```ts
 * const tween = new Tween(panel)
 *   .to({ opacity: 1 }, 0.3)
 *   .by({ scale: 0.5 }, 0.2)
 *   .delay(0.1)
 *   .easing('cubicOut')
 *   .yoyo(true)
 *   .repeat(2)
 *   .onUpdate((p) => {})
 *   .onComplete(() => {});
 *
 * tween.update(1 / 60);   // call once per frame
 * ```
 *
 * ## Duration semantics
 *
 * `Tween` supports two modes and they measure duration differently, which is worth
 * knowing before reading {@link Tween.totalDuration}:
 *
 * - **object mode** (`new Tween({ x: 0 })`): steps are *sequential*.
 *   {@link Tween.animationDuration} is the accumulated chain `sum(delay + duration)`, so
 *   `.to({x:1}, 1).to({y:2}, 1)` lasts two seconds.
 * - **map mode** (`new Tween((values) => ...)`): there is no target object to
 *   sequence against, so steps are treated as *parallel* and the duration is the
 *   longest single step.
 *
 * {@link Tween.getParallelDuration} exposes the parallel measurement in object mode
 * for callers that know their chained calls were meant to run together.
 *
 * ## Legs, repetitions and yoyo
 *
 * A tween is played as a sequence of **legs**:
 *
 * | | legs per repetition | leg length |
 * | --- | --- | --- |
 * | plain | 1 | `delayTime + animationDuration` |
 * | `yoyo(true)` | 2 (out, then back) | `delayTime + animationDuration` |
 *
 * Each leg runs its own clock from `0` to {@link Tween.legDuration}, and the delay is charged
 * to the first leg only, so `delay(0.2)` delays the tween once rather than once per leg.
 * {@link Tween.repetitionDuration} is one repetition, {@link Tween.cycleDuration} is a full
 * out-and-back cycle (twice a repetition when yoyo is on), and {@link Tween.totalDuration} is
 * `repeatCount + 1` cycles.
 *
 * @packageDocumentation
 */

import type { EventListener } from '../core/EventEmitter';
import { clamp, clamp01 } from '../utils/MathUtils';
import { Easing, type EasingFunction } from './Easing';

/** A plain object of numbers the tween can read from and write to. */
export type TweenTarget = Record<string, number>;

/** Callback invoked when the tween writes values without a target object. */
export type TweenSetter = (values: Readonly<Record<string, number>>) => void;

/** Property values accepted by `to`, `from`, `by` and `fromTo`. */
export type TweenValues = Readonly<Record<string, number>>;

/** How a step derives its endpoints. */
export type TweenStepKind = 'to' | 'from' | 'by' | 'fromTo';

/** One property ramp inside a tween. */
export interface TweenStep {
  /** Property name. */
  property: string;
  /** How the endpoints were specified. */
  kind: TweenStepKind;
  /** Explicit start value, or `null` to read from the target when the step starts. */
  from: number | null;
  /** Explicit end value, or `null` to derive it from `from + delta`. */
  to: number | null;
  /** Delta used by `by` steps. */
  delta: number;
  /** Step duration in seconds. */
  duration: number;
  /** Step delay relative to the tween's start, in seconds. */
  delay: number;
  /** Per-step easing; `null` means "use the tween's easing". */
  easing: EasingFunction | null;
  /** Value the step started from, captured the first time it runs. */
  startValue: number;
  /** `true` once the start value has been captured. */
  started: boolean;
}

/** Construction options for {@link Tween}. */
export interface TweenOptions {
  /** Default duration for steps that do not specify one. */
  duration?: number;
  /** Delay before the first step runs, in seconds. */
  delay?: number;
  /** Default easing name or function. */
  easing?: EasingFunction | string;
}

/** Default step duration in seconds. */
export const DEFAULT_TWEEN_DURATION = 0.3;

/** Playback state of a {@link Tween}. */
export type TweenState = 'idle' | 'running' | 'paused' | 'stopped' | 'complete';

/**
 * A chainable property animator.
 */
export class Tween {
  /** Target object the steps read from and write to, or `null` in map mode. */
  public readonly target: TweenTarget | null;

  /** Setter used in map mode, or `null` in object mode. */
  public readonly setter: TweenSetter | null;

  /** Delay before the first step runs, in seconds. */
  public delayTime: number;

  /** Default duration applied to steps that do not specify one. */
  public stepDuration: number;

  /** Default easing applied to steps that do not override it. */
  public easingFn: EasingFunction;

  /** `true` plays every other repetition backwards. */
  public yoyoEnabled = false;

  /** Extra repetitions after the first play; `0` means "play once". */
  public repeatCount = 0;

  /** `true` repeats forever, overriding {@link Tween.repeatCount}. */
  public infinite = false;

  /** Current value of every animated property; also the map read in map mode. */
  public readonly values: Record<string, number> = {};

  /** Playback state. */
  public state: TweenState = 'idle';

  /** Steps registered by `to`/`from`/`by`/`fromTo`, in call order. */
  private readonly steps: TweenStep[] = [];

  /**
   * Seconds elapsed inside the **current leg**, from `0` to the leg's length.
   *
   * The single time variable of the update path: the delay boundary, the phase inside the leg
   * and the completion test are all derived from it, so no two counters can drift apart.
   */
  private elapsed = 0;

  /** Index of the leg being played; odd legs run backwards on a yoyo. */
  private legIndex = 0;

  /** `true` once the delay phase is over. */
  private delayDone = false;

  /** Completed repetitions. */
  private iterations = 0;

  /** `true` when the current repetition plays backwards. */
  private reversedLeg = false;

  /** Registered lifecycle listeners. */
  private readonly listeners = new Map<string, Set<EventListener>>();

  /** Per-frame callback. */
  private updateCallback: ((progress: number, values: Record<string, number>) => void) | null = null;

  /** Completion callback, fired once after the final repetition. */
  private completeCallback: (() => void) | null = null;

  /** Start callback, fired when the delay elapses. */
  private startCallback: (() => void) | null = null;

  /** Stop callback, fired when the tween is stopped early. */
  private stopCallback: (() => void) | null = null;

  /** Repeat callback, fired after every repetition except the last. */
  private repeatCallback: ((iteration: number) => void) | null = null;

  /**
   * Creates a tween.
   *
   * @param target Object to animate, or a setter callback for map mode.
   * @param options Defaults for delay, duration and easing.
   */
  constructor(target: TweenTarget | TweenSetter | null = null, options: TweenOptions = {}) {
    if (typeof target === 'function') {
      this.target = null;
      this.setter = target;
    } else {
      this.target = target;
      this.setter = null;
      if (target !== null) {
        for (const key of Object.keys(target)) this.values[key] = target[key];
      }
    }

    this.stepDuration = options.duration ?? DEFAULT_TWEEN_DURATION;
    this.delayTime = options.delay ?? 0;
    this.easingFn =
      options.easing === undefined
        ? Easing.linear
        : typeof options.easing === 'string'
          ? Easing.getEasing(options.easing)
          : options.easing;
  }

  /* ------------------------------------------------------------------ steps */

  /**
   * Animates properties **to** the given values, reading each start value from the
   * target when the step first runs.
   *
   * @param values Target values, keyed by property name.
   * @param duration Step duration in seconds; defaults to the tween's step duration.
   * @param easing Optional per-step easing.
   * @returns This tween, for chaining.
   */
  public to(
    values: TweenValues,
    duration: number = this.stepDuration,
    easing?: EasingFunction | string,
  ): this {
    for (const [property, value] of Object.entries(values)) {
      this.steps.push(this.makeStep(property, 'to', null, value, 0, duration, easing));
    }
    return this;
  }

  /**
   * Animates properties **from** the given values to their current target values.
   *
   * @param values Start values, keyed by property name.
   * @param duration Step duration in seconds.
   * @param easing Optional per-step easing.
   * @returns This tween, for chaining.
   */
  public from(
    values: TweenValues,
    duration: number = this.stepDuration,
    easing?: EasingFunction | string,
  ): this {
    for (const [property, value] of Object.entries(values)) {
      // The endpoint is the target's value **now**, captured eagerly: reading it later would
      // see the value this step itself has already written.
      const end = this.readProperty(property);
      this.steps.push(this.makeStep(property, 'from', value, end, 0, duration, easing));
    }
    return this;
  }

  /**
   * Animates properties **by** a relative delta.
   *
   * @param values Deltas, keyed by property name.
   * @param duration Step duration in seconds.
   * @param easing Optional per-step easing.
   * @returns This tween, for chaining.
   */
  public by(
    values: TweenValues,
    duration: number = this.stepDuration,
    easing?: EasingFunction | string,
  ): this {
    for (const [property, delta] of Object.entries(values)) {
      this.steps.push(this.makeStep(property, 'by', null, null, delta, duration, easing));
    }
    return this;
  }

  /**
   * Animates properties from an explicit start to an explicit end.
   *
   * @param fromValues Start values.
   * @param toValues End values; properties missing here hold their start value.
   * @param duration Step duration in seconds.
   * @param easing Optional per-step easing.
   * @returns This tween, for chaining.
   */
  public fromTo(
    fromValues: TweenValues,
    toValues: TweenValues,
    duration: number = this.stepDuration,
    easing?: EasingFunction | string,
  ): this {
    for (const [property, from] of Object.entries(fromValues)) {
      const to = toValues[property];
      this.steps.push(this.makeStep(property, 'fromTo', from, to ?? from, 0, duration, easing));
    }
    return this;
  }

  /**
   * Assigns constant values immediately, before any step runs.
   *
   * @param values Values to assign.
   * @returns This tween, for chaining.
   */
  public set(values: TweenValues): this {
    for (const [property, value] of Object.entries(values)) {
      this.values[property] = value;
      if (this.target !== null) this.target[property] = value;
    }
    return this;
  }

  /** Builds a normalised step record. */
  private makeStep(
    property: string,
    kind: TweenStepKind,
    from: number | null,
    to: number | null,
    delta: number,
    duration: number,
    easing: EasingFunction | string | undefined,
  ): TweenStep {
    return {
      property,
      kind,
      from,
      to,
      delta,
      duration: Math.max(0, duration),
      delay: 0,
      easing:
        easing === undefined ? null : typeof easing === 'string' ? Easing.getEasing(easing) : easing,
      startValue: from ?? 0,
      started: false,
    };
  }

  /* -------------------------------------------------------------- modifiers */

  /**
   * Sets the delay before the first step runs.
   *
   * @param seconds Delay in seconds.
   * @returns This tween, for chaining.
   */
  public delay(seconds: number): this {
    this.delayTime = Math.max(0, seconds);
    return this;
  }

  /**
   * Sets the default duration for steps added afterwards.
   *
   * @param seconds Duration in seconds.
   * @returns This tween, for chaining.
   */
  public setDuration(seconds: number): this {
    this.stepDuration = Math.max(0, seconds);
    return this;
  }

  /**
   * Sets the default easing for steps that do not override it.
   *
   * @param easing A curve, or a name accepted by `Easing.getEasing`.
   * @returns This tween, for chaining.
   */
  public setEasing(easing: EasingFunction | string): this {
    this.easingFn = typeof easing === 'string' ? Easing.getEasing(easing) : easing;
    return this;
  }

  /**
   * Alias of {@link Tween.setEasing} so `.easing('cubicOut')` reads naturally.
   *
   * @param easing A curve, or an easing name.
   * @returns This tween, for chaining.
   */
  public easing(easing: EasingFunction | string): this {
    return this.setEasing(easing);
  }

  /**
   * Enables or disables yoyo playback.
   *
   * With yoyo on, every other repetition plays backwards, so `repeat(1)` goes there
   * and back again.
   *
   * @param enabled Whether to yoyo; defaults to `true`.
   * @returns This tween, for chaining.
   */
  public yoyo(enabled = true): this {
    this.yoyoEnabled = enabled;
    return this;
  }

  /**
   * Sets how many extra times the tween repeats.
   *
   * @param count Repetitions after the first play; `Infinity` repeats forever.
   * @returns This tween, for chaining.
   */
  public repeat(count: number): this {
    if (!Number.isFinite(count)) {
      this.infinite = true;
      this.repeatCount = 0;
      return this;
    }
    this.infinite = false;
    this.repeatCount = Math.max(0, Math.floor(count));
    return this;
  }

  /**
   * Registers a per-frame callback.
   *
   * @param callback Receives the normalised progress and the current value map.
   * @returns This tween, for chaining.
   */
  public onUpdate(callback: (progress: number, values: Record<string, number>) => void): this {
    this.updateCallback = callback;
    return this;
  }

  /**
   * Registers the completion callback, fired once after the final repetition.
   *
   * @param callback Callback.
   * @returns This tween, for chaining.
   */
  public onComplete(callback: () => void): this {
    this.completeCallback = callback;
    return this;
  }

  /**
   * Registers the start callback, fired when the delay elapses.
   *
   * @param callback Callback.
   * @returns This tween, for chaining.
   */
  public onStart(callback: () => void): this {
    this.startCallback = callback;
    return this;
  }

  /**
   * Registers the stop callback.
   *
   * @param callback Callback.
   * @returns This tween, for chaining.
   */
  public onStop(callback: () => void): this {
    this.stopCallback = callback;
    return this;
  }

  /**
   * Registers a callback fired after each repetition except the last.
   *
   * @param callback Receives the completed repetition index.
   * @returns This tween, for chaining.
   */
  public onRepeat(callback: (iteration: number) => void): this {
    this.repeatCallback = callback;
    return this;
  }

  /**
   * Registers a listener for a typed event.
   *
   * @param event Event name (`'start'`, `'update'`, `'complete'`, `'stop'`,
   *   `'repeat'`, `'yoyo'`).
   * @param listener Callback.
   * @returns An unsubscribe function.
   */
  public on(event: string, listener: EventListener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    const registered = set;
    return () => {
      registered.delete(listener);
    };
  }

  /* -------------------------------------------------------------- lifecycle */

  /**
   * Starts the tween from the beginning.
   *
   * @returns This tween, for chaining.
   */
  public start(): this {
    this.elapsed = 0;
    this.delayDone = this.delayTime <= 0;
    this.iterations = 0;
    this.reversedLeg = false;
    this.state = 'running';
    for (const step of this.steps) step.started = false;
    if (this.delayDone) {
      this.startCallback?.();
      this.emit('start');
    }
    return this;
  }

  /**
   * Stops the tween.
   *
   * @returns This tween, for chaining.
   */
  public stop(): this {
    if (this.state === 'complete' || this.state === 'stopped') return this;
    this.state = 'stopped';
    this.stopCallback?.();
    this.emit('stop');
    return this;
  }

  /**
   * Pauses the tween, keeping its progress.
   *
   * @returns This tween, for chaining.
   */
  public pause(): this {
    if (this.state === 'running') this.state = 'paused';
    return this;
  }

  /**
   * Resumes a paused tween.
   *
   * @returns This tween, for chaining.
   */
  public resume(): this {
    if (this.state === 'paused') this.state = 'running';
    return this;
  }

  /**
   * Jumps to a normalised position and writes the values.
   *
   * The position is measured across the **whole** tween, including the delay and every
   * repetition, and a yoyo's phase is derived from it: a seek to `0.75` of a two-leg yoyo
   * lands halfway down the return leg rather than re-running the outbound one.
   *
   * @param progress Position in `[0, 1]`.
   * @returns This tween, for chaining.
   */
  public seek(progress: number): this {
    const clamped = clamp01(progress);
    if (this.state === 'idle') this.state = 'paused';
    this.delayDone = true;

    const legDuration = this.legDuration;
    if (legDuration <= 0) {
      this.elapsed = 0;
      this.legIndex = 0;
      this.iterations = 0;
      this.reversedLeg = false;
      this.renderLeg(0, false);
      return this;
    }

    const legs = this.totalIterations;
    // Progress spans the whole tween: `legs` legs of `legDuration` each, or `repeatCount + 1`
    // cycles when a yoyo doubles the leg count.
    const leg = Math.max(0, Math.min((Number.isFinite(legs) ? legs : Infinity) - 1, Math.floor(clamped * legs)));
    const legTime = clamped * legs * legDuration - leg * legDuration;

    this.legIndex = Number.isFinite(leg) ? leg : 0;
    this.iterations = this.legIndex;
    this.reversedLeg = this.yoyoEnabled ? leg % 2 === 1 : false;
    this.elapsed = clamp(legTime, 0, legDuration);

    this.renderLeg(this.elapsed, this.reversedLeg);
    return this;
  }

  /**
   * Rewinds the tween to its initial state without firing callbacks.
   *
   * @returns This tween, for chaining.
   */
  public reset(): this {
    this.state = 'idle';
    this.elapsed = 0;
    this.delayDone = this.delayTime <= 0;
    this.iterations = 0;
    this.reversedLeg = false;
    for (const step of this.steps) step.started = false;
    return this;
  }

  /* ----------------------------------------------------------------- update */

  /**
   * Duration of **one repetition**, in seconds, including {@link Tween.delayTime}.
   *
   * A repetition is one complete out-and-back cycle when {@link Tween.yoyo} is on, and one
   * pass otherwise, so the animated part of a repetition is split into
   * {@link Tween.legDuration}-long legs.
   *
   * @returns The duration in seconds.
   */
  public get repetitionDuration(): number {
    return this.delayTime + this.animationDuration;
  }

  /**
   * Duration of a single leg, in seconds, **including** {@link Tween.delayTime}.
   *
   * A repetition is one leg when the tween is not a yoyo, and two legs (out, then back) when it
   * is. The delay is charged to the first leg only.
   *
   * @returns The duration in seconds.
   */
  public get legDuration(): number {
    return this.repetitionDuration;
  }

  /**
   * Duration of a complete out-and-back cycle (or of one pass, without a yoyo), in seconds.
   *
   * @returns The duration in seconds.
   */
  public get cycleDuration(): number {
    return this.yoyoEnabled ? this.repetitionDuration * 2 : this.repetitionDuration;
  }

  /**
   * Total duration of the whole tween, across every repetition.
   *
   * @returns The duration in seconds, or `Infinity` for an endless tween.
   */
  public get totalDuration(): number {
    const cycles = this.repeatCount + 1;
    return this.infinite ? Infinity : this.cycleDuration * cycles;
  }

  /**
   * Duration of the animated part of one repetition, excluding the delay.
   *
   * @returns The duration in seconds.
   */
  public get animationDuration(): number {
    return this.target !== null ? this.sequentialDuration : this.getParallelDuration();
  }

  /**
   * Longest single step, treating every chained step as parallel.
   *
   * @returns Duration in seconds, excluding {@link Tween.delayTime}.
   */
  public getParallelDuration(): number {
    let longest = 0;
    for (const step of this.steps) {
      const span = step.delay + step.duration;
      if (span > longest) longest = span;
    }
    return longest;
  }

  /** Accumulated chain length, used in object mode. */
  private get sequentialDuration(): number {
    let accumulated = 0;
    for (const step of this.steps) accumulated += step.delay + step.duration;
    return accumulated;
  }

  /**
   * Normalised progress across the whole tween, including delay and repetitions.
   *
   * @returns A value in `[0, 1]`.
   */
  public get progress(): number {
    const total = this.totalDuration;
    if (!Number.isFinite(total) || total <= 0) return this.state === 'complete' ? 1 : 0;
    const elapsed = this.legIndex * this.legDuration + this.elapsed;
    return clamp01(elapsed / total);
  }

  /**
   * Total number of **legs** the tween will run.
   *
   * A yoyo cycle is two legs — out and back — so a yoyo needs twice as many legs as a plain
   * repeat to cover the same `repeatCount`. Treating one pass as one leg would leave a yoyo
   * finishing at the far end of its outbound leg instead of back where it started.
   *
   * @returns The leg count, or `Infinity`.
   */
  /**
   * Total number of **legs** the tween will run.
   *
   * A yoyo's repetition is two legs — out and back — so a yoyo needs twice as many legs as a
   * plain repeat to cover the same `repeatCount`. Using this everywhere (the completion test,
   * `totalDuration` and `seek`) is what keeps those three views of the timeline consistent.
   *
   * @returns The leg count, or `Infinity`.
   */
  private get totalIterations(): number {
    if (this.infinite) return Infinity;
    return (this.repeatCount + 1) * (this.yoyoEnabled ? 2 : 1);
  }

  /**
   * Advances the tween.
   *
   * The first call implicitly starts it, so a caller can simply drive it every frame without
   * an explicit `start()`.
   *
   * ## The invariant
   *
   * `elapsed` is the **only** time variable, and it always means *seconds into the current
   * leg*, running `0 -> legDuration`. The delay is the first `delayTime` seconds of leg 0 and
   * of nothing else. `legIndex` says which leg is playing and therefore whether a yoyo is on
   * its outbound or its return half. Because the clock is never rewound to a different origin,
   * the delay cannot be charged twice and the turn cannot be skipped.
   *
   * @param delta Seconds since the previous call.
   * @returns `true` while the tween still has work to do.
   */
  public update(delta: number): boolean {
    if (this.state === 'idle') this.start();
    if (this.state !== 'running') return this.state === 'paused';
    if (!(delta > 0)) return true;

    const leg = this.legDuration;

    // A tween with no animated span still completes exactly once.
    if (leg <= 0) {
      this.elapsed = 0;
      this.renderLeg(0, false);
      this.finishIteration();
      return this.state === 'running';
    }

    // A whole frame can span more than one leg. Each leg is consumed at most once: the frame
    // that crosses a boundary samples the leg that just ended at its endpoint and stops, so a
    // turn is never skipped and a leg is never rendered twice inside one update.
    let remaining = delta;
    let guard = 0;

    while (remaining > 0 && guard++ < 10_000) {
      // Snapshot the leg being consumed: `finishIteration` advances the index, but the
      // endpoint that must be written belongs to the leg that just ended.
      const index = this.legIndex;
      const reversed = this.reversedLeg;
      const room = leg - this.elapsed;

      if (remaining < room) {
        this.elapsed += remaining;
        // Still inside the delay: nothing has moved and the tween has not started.
        if (index === 0 && this.elapsed < this.delayTime) return true;
        this.announceStart();
        this.renderLeg(this.elapsed, reversed);
        return true;
      }

      remaining -= room;
      this.elapsed = leg;

      // Sample the leg that just ended at its endpoint, then advance to the next leg. The
      // endpoint is rendered with the direction *that leg* was travelling.
      this.announceStart();
      this.renderLeg(leg, reversed);

      if (!this.finishIteration()) return false;
      return this.state === 'running';
    }

    return this.state === 'running';
  }

  /**
   * Fires the `start` callback exactly once, when the delay elapses.
   *
   * Called from the update loop rather than from a timer so a paused or suspended tween does
   * not report a start it never made.
   */
  private announceStart(): void {
    if (this.delayDone) return;
    this.delayDone = true;
    this.startCallback?.();
    this.emit('start');
  }

  /** Completes one leg; returns `false` when the tween is finished. */
  private finishIteration(): boolean {
    this.iterations++;
    this.legIndex++;

    if (!this.infinite && this.iterations >= this.totalIterations) {
      this.state = 'complete';
      this.emit('complete');
      this.completeCallback?.();
      return false;
    }

    this.reversedLeg = this.yoyoEnabled ? !this.reversedLeg : false;
    // Every leg runs its own clock from 0 to `cycle`; `reversedLeg` is what turns the return
    // leg around, so the clock never has to run backwards.
    this.elapsed = 0;
    // `step.started` deliberately stays `true`: the captured `startValue` is the tween's origin
    // and must survive into the next leg. Recapturing it at the top of a yoyo's return leg would
    // read the endpoint and make that leg run from the endpoint back to the endpoint.
    this.repeatCallback?.(this.iterations);
    this.emit('repeat', this.iterations);
    if (this.yoyoEnabled) this.emit('yoyo', this.iterations);
    return true;
  }

  /**
   * Samples every step for a position inside a leg and writes the result.
   *
   * ## The one formula
   *
   * `legTime` runs `0 -> legDuration` inside every leg. Leg 0 spends its first `delayTime`
   * seconds holding the start values, so the animation clock is
   *
   * ```
   * local  = clamp(legTime - delayTime, 0, animationDuration)
   * phase  = local / animationDuration
   * origin = reversed ? 1 : 0
   * travel = |phase - origin|
   * ```
   *
   * Travel is the distance of the phase from the end the leg is moving *away* from, so it always
   * runs `0 -> 1`: forwards as `phase` goes `0 -> 1` on an outbound leg, and forwards again as
   * `phase` goes `1 -> 0` on a return leg. A plain `1 - phase` reflection would run the return
   * leg backwards, which is what made the value stick at the far end.
   *
   * Both legs therefore report `travel = 1` at the shared boundary instant, whichever side of
   * it is being sampled — which is what makes the turn exact.
   *
   * `reversed` is passed in rather than read from `this.reversedLeg` so that rendering a leg's
   * endpoint cannot be confused with the clock already having advanced into the next leg.
   *
   * @param legTime Seconds into the leg being sampled.
   * @param reversed `true` when that leg is a return (yoyo) leg.
   */
  private renderLeg(legTime: number, reversed: boolean): void {
    const span = this.animationDuration;
    const local = clamp(legTime - this.delayTime, 0, span);
    const phase = span > 0 ? local / span : 0;
    const origin = reversed ? 1 : 0;
    const travel = clamp01(Math.abs(phase - origin));

    for (const step of this.steps) {
      // A step that has not been reached yet holds its start value.
      const stepProgress =
        step.duration <= 0 ? (local >= step.delay ? 1 : 0) : clamp01((local - step.delay) / step.duration);
      const directed = clamp01(Math.abs(stepProgress - origin));

      if (!step.started) {
        this.captureStart(step);
        step.started = true;
      }

      const curve = step.easing ?? this.easingFn;
      const eased = clamp01(curve(directed));
      const value = this.evaluateStep(step, eased);
      this.values[step.property] = value;
      if (this.target !== null) this.target[step.property] = value;
    }

    if (this.setter !== null) this.setter(this.values);
    this.updateCallback?.(travel, this.values);
    this.emit('update', travel, this.values);
  }

  /** Captures a step's start value the first time it runs. */
  private captureStart(step: TweenStep): void {
    const current = this.readProperty(step.property);
    switch (step.kind) {
      case 'from':
      case 'fromTo':
        step.startValue = step.from ?? current;
        break;
      case 'by':
      case 'to':
      default:
        step.startValue = current;
        break;
    }
  }

  /**
   * Computes a step's value for a progress along the leg in `[0, 1]`.
   *
   * `progress` is already a single, direction-free coordinate: {@link Tween.renderLeg} maps both
   * an outbound leg (`0 -> 1`) and a yoyo's return leg (`1 -> 0`) onto it, so a step always
   * interpolates from its captured start toward its endpoint. Reversing here as well would
   * cancel the return leg out and leave the value stuck at the far end.
   *
   * @param step Step to evaluate.
   * @param progress Progress along the leg in `[0, 1]`.
   * @returns The value.
   */
  private evaluateStep(step: TweenStep, progress: number): number {
    if (step.kind === 'by') return step.startValue + step.delta * progress;

    const start = step.startValue;
    const end = step.to ?? start;
    return start + (end - start) * progress;
  }

  /** Reads a property from the target, or from the value map in map mode. */
  private readProperty(property: string): number {
    if (this.target !== null) {
      const value = this.target[property];
      if (typeof value === 'number') return value;
    }
    return this.values[property] ?? 0;
  }

  /**
   * @returns `true` when the tween has finished all repetitions.
   */
  public get isComplete(): boolean {
    return this.state === 'complete';
  }

  /**
   * @returns `true` while the tween is advancing.
   */
  public get isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * @returns The registered steps, for inspection and tests.
   */
  public getSteps(): readonly TweenStep[] {
    return this.steps;
  }

  /** Emits one event to every registered listener. */
  private emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of Array.from(set)) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch {
        /* a listener must never break the animation loop */
      }
    }
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return (
      `Tween(state=${this.state}, steps=${this.steps.length}, ` +
      `duration=${this.totalDuration.toFixed(3)}, repeat=${this.infinite ? 'inf' : this.repeatCount})`
    );
  }
}

/**
 * Convenience factory mirroring `new Tween(target, options)`.
 *
 * @param target Object to animate, or a setter callback.
 * @param options Default delay/duration/easing.
 * @returns A new tween.
 */
export function tween(
  target: TweenTarget | TweenSetter | null = null,
  options: TweenOptions = {},
): Tween {
  return new Tween(target, options);
}
