/**
 * `AnimationAction` — one clip playing on one mixer, with its own weight, speed
 * and loop state.
 *
 * The same clip can back several actions at once: an action owns *playback state*
 * (`time`, `paused`, `enabled`, `weight`, `timeScale`, loop counters) and a list of
 * {@link PropertyBinding}s that point the clip's tracks at a concrete object. Two
 * actions can therefore play `Walk` on two characters, or play `Idle` and `Walk` on
 * one character and blend them.
 *
 * ```
 * mixer.clipAction(idle).play();
 * walk.reset().play();
 * walk.crossFadeTo(idle, 0.4, true);   // walk fades out, idle fades in
 * ```
 *
 * ## Weight model
 *
 * `weight` is the authored weight; `getEffectiveWeight()` is what the mixer uses.
 * `setEffectiveWeight(w)` writes both the weight and its multiplier; `fadeIn`,
 * `fadeOut`, `crossFadeTo` and `crossFadeFrom` install a linear weight ramp that
 * overwrites `weight` on every {@link AnimationAction.update} until the ramp
 * finishes and is discarded. `enabled === false` forces the effective weight to
 * zero without disturbing the authored value, which is what makes muting and
 * un-muting an action lossless.
 *
 * ## Blending
 *
 * Normal blending is a **weighted running average** across the actions that touch a
 * given track, so a single full-weight action reproduces its authored value
 * exactly. Additive blending accumulates `value * weight`; `override` replaces
 * whatever came before.
 *
 * @packageDocumentation
 */

import { DEFAULT_FADE_DURATION } from '../constants';
import type { EventListener } from '../core/EventEmitter';
import { clamp01 } from '../utils/MathUtils';
import type { AnimationClip } from './AnimationClip';
import type { AnimationMixer } from './AnimationMixer';
import { Easing, type EasingFunction } from './Easing';
import type { KeyframeTrack, TrackValueArray } from './KeyframeTrack';
import { PropertyBinding } from './PropertyBinding';
import type { ActionSnapshot, BlendMode, LoopMode, Object3DLike } from './types';

/* -------------------------------------------------------------------------- */
/* Weight ramp                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A linear weight ramp between two normalised times.
 *
 * Kept as a tiny concrete class instead of a generic interpolant because a fade has
 * exactly two control points and no `values` array to search.
 */
class WeightInterpolant {
  /** Weight at normalised time `0`. */
  public readonly leftWeight: number;

  /** Weight at normalised time `1`. */
  public readonly rightWeight: number;

  /**
   * Creates a weight ramp.
   *
   * @param leftWeight Weight at normalised time `0`.
   * @param rightWeight Weight at normalised time `1`.
   */
  constructor(leftWeight = 0, rightWeight = 1) {
    this.leftWeight = leftWeight;
    this.rightWeight = rightWeight;
  }
}

/* -------------------------------------------------------------------------- */
/* Action                                                                     */
/* -------------------------------------------------------------------------- */

/** Options accepted by the {@link AnimationAction} constructor. */
export interface AnimationActionOptions {
  /** Initial blend mode; defaults to the clip's. */
  blendMode?: BlendMode;
  /** Initial loop mode; defaults to `'repeat'`. */
  loop?: LoopMode;
  /** Clip repetitions before stopping; `Infinity` by default. */
  repetitions?: number;
  /** Easing applied to every fade; defaults to `Easing.linear`. */
  fadeEasing?: EasingFunction | string;
}

/** One binding slot per track of the clip. */
interface BindingSlot {
  /** The track this slot drives. */
  track: KeyframeTrack<TrackValueArray>;
  /** Lazy binding; created the first time the action is used. */
  binding: PropertyBinding | null;
  /** Reusable source buffer holding the track's interpolated value. */
  source: Float32Array;
}

/** One track's contribution, handed to the mixer without copying. */
export interface SlotContribution {
  /** Track name. */
  name: string;
  /** Components per keyframe. */
  valueSize: number;
  /** The action's own value at the current time. */
  source: Float32Array;
}

/**
 * Playback state for one clip on one mixer.
 */
export class AnimationAction {
  /** Mixer that owns this action. */
  public readonly mixer: AnimationMixer;

  /** The clip being played. */
  public readonly clip: AnimationClip;

  /** Root object the tracks are bound against. */
  public readonly root: Object3DLike;

  /** Current time inside the clip, in seconds. */
  public time = 0;

  /** Playback rate; negative plays backwards. */
  public timeScale = 1;

  /** Authored weight in `[0, 1]`. */
  public weight = 1;

  /** `false` mutes the action without stopping it. */
  public enabled = true;

  /** `true` freezes {@link AnimationAction.time}. */
  public paused = false;

  /** `true` while the action is advancing its clock. */
  public running = false;

  /** How the track values combine with the accumulator. */
  public blendMode: BlendMode;

  /** Loop behaviour once the clip's end is reached. */
  public loop: LoopMode;

  /** Repetitions allowed before the action deactivates; `Infinity` by default. */
  public repetitions: number;

  /** `true` pins {@link AnimationAction.time} to the clip end for `LoopOnce`. */
  public clampWhenFinished = false;

  /** `true` when a `LoopPingPong` action is currently playing backwards. */
  public reversed = false;

  /** Number of times the action has completed its clip. */
  public loopCount = 0;

  /** @internal Active weight ramp, or `null` when not fading. */
  public _weightInterpolant: WeightInterpolant | null = null;

  /** Weight the active ramp started from. */
  private fadeFrom = 0;

  /** Weight the active ramp targets. */
  private fadeTo = 1;

  /** Active ramp duration in seconds. */
  private fadeDuration = 0;

  /** Seconds elapsed inside the active ramp. */
  private fadeElapsed = 0;

  /** Easing applied to fades. */
  private fadeEasing: EasingFunction;

  /** Callbacks registered through {@link AnimationAction.on}. */
  private readonly listeners = new Map<string, Set<EventListener>>();

  /** One slot per clip track. */
  private readonly slots: BindingSlot[] = [];

  /** Pre-supplied bindings, when the caller resolved them already. */
  private readonly suppliedBindings: readonly PropertyBinding[] | null;

  /**
   * Creates an action. Prefer {@link AnimationMixer.clipAction}, which caches
   * actions per clip/root pair.
   *
   * @param mixer Owning mixer.
   * @param clip Clip to play.
   * @param root Root object the tracks bind against.
   * @param bindings Pre-resolved bindings matching the clip's tracks, or `null`.
   * @param options Initial loop/blend configuration.
   */
  constructor(
    mixer: AnimationMixer,
    clip: AnimationClip,
    root: Object3DLike,
    bindings: readonly PropertyBinding[] | null = null,
    options: AnimationActionOptions = {},
  ) {
    this.mixer = mixer;
    this.clip = clip;
    this.root = root;
    this.suppliedBindings = bindings;
    this.blendMode = options.blendMode ?? clip.blendMode;
    this.loop = options.loop ?? 'repeat';
    this.repetitions = options.repetitions ?? Infinity;
    this.fadeEasing =
      options.fadeEasing === undefined
        ? Easing.linear
        : typeof options.fadeEasing === 'string'
          ? Easing.getEasing(options.fadeEasing)
          : options.fadeEasing;

    for (const track of clip.tracks) {
      this.slots.push({
        track,
        binding: null,
        source: new Float32Array(track.valueSize),
      });
    }
  }

  /* -------------------------------------------------------------- playback */

  /**
   * Starts (or resumes) playback.
   *
   * @returns This action, for chaining.
   */
  public play(): this {
    this.running = true;
    this.paused = false;
    this.mixer._activateAction(this);
    this.emit('start');
    return this;
  }

  /**
   * Stops advancing the clock without resetting it.
   *
   * The action keeps contributing its current value at `delta = 0`, so a paused
   * action still participates in a blend.
   *
   * @returns This action, for chaining.
   */
  public pause(): this {
    this.paused = true;
    return this;
  }

  /**
   * Stops playback, rewinds and clears every fade.
   *
   * @returns This action, for chaining.
   */
  public stop(): this {
    this.running = false;
    this.paused = false;
    this.reset();
    this.mixer._deactivateAction(this);
    this.emit('stop');
    return this;
  }

  /**
   * Rewinds the clock and resets the loop/fade state.
   *
   * The bound objects are **not** restored to a bind pose; that is
   * {@link AnimationAction.stop}'s job.
   *
   * @returns This action, for chaining.
   */
  public reset(): this {
    this.paused = false;
    this.enabled = true;
    this.time = 0;
    this.loopCount = 0;
    this.reversed = false;
    this._weightInterpolant = null;
    this.fadeDuration = 0;
    this.fadeElapsed = 0;
    this.fadeFrom = this.weight;
    this.fadeTo = this.weight;
    return this;
  }

  /**
   * @returns `true` when the action advances its clock this frame.
   */
  public get isRunning(): boolean {
    return this.enabled && this.running && !this.paused;
  }

  /**
   * @returns `true` when a `LoopOnce` action has reached its end and clamped.
   */
  public get isFinished(): boolean {
    return this.loop === 'once' && this.loopCount > 0;
  }

  /**
   * @returns `true` when a weight fade is in progress.
   */
  public get isFading(): boolean {
    return this._weightInterpolant !== null;
  }

  /**
   * @returns The total remaining repetitions, or `Infinity`.
   */
  public get remainingRepetitions(): number {
    return Number.isFinite(this.repetitions) ? Math.max(0, this.repetitions - this.loopCount) : Infinity;
  }

  /* ---------------------------------------------------------------- weight */

  /**
   * Sets the authored weight and clears any active fade.
   *
   * @param weight New weight; clamped to `[0, 1]`.
   * @returns This action, for chaining.
   */
  public setWeight(weight: number): this {
    this.weight = clamp01(weight);
    this._weightInterpolant = null;
    this.fadeDuration = 0;
    this.fadeElapsed = 0;
    return this;
  }

  /**
   * Alias of {@link AnimationAction.setWeight} kept for API symmetry.
   *
   * @param weight New effective weight.
   * @returns This action, for chaining.
   */
  public setEffectiveWeight(weight: number): this {
    return this.setWeight(weight);
  }

  /**
   * Weight the mixer will use, after enablement and the active fade.
   *
   * @returns A value in `[0, 1]`.
   */
  public getEffectiveWeight(): number {
    if (!this.enabled) return 0;
    if (this._weightInterpolant === null) return clamp01(this.weight);
    if (this.fadeDuration <= 0) return clamp01(this.fadeTo);

    const alpha = clamp01(this.fadeElapsed / this.fadeDuration);
    const eased = this.fadeEasing(alpha);
    return clamp01(this.fadeFrom + (this.fadeTo - this.fadeFrom) * eased);
  }

  /**
   * Fades the action in from weight `0`.
   *
   * @param duration Fade length in seconds; defaults to `DEFAULT_FADE_DURATION`.
   * @returns This action, for chaining.
   */
  public fadeIn(duration: number = DEFAULT_FADE_DURATION): this {
    return this.scheduleFading(duration, 0, 1);
  }

  /**
   * Fades the action out to weight `0`.
   *
   * The action keeps running at zero weight so a `LoopOnce` clip can still reach its
   * end under the fade.
   *
   * @param duration Fade length in seconds.
   * @returns This action, for chaining.
   */
  public fadeOut(duration: number = DEFAULT_FADE_DURATION): this {
    return this.scheduleFading(duration, this.getEffectiveWeight(), 0);
  }

  /**
   * Cross-fades **from** this action **to** `fadeInAction`.
   *
   * @param fadeInAction Action to fade in.
   * @param duration Fade length in seconds.
   * @param warp When `true` the two actions' `timeScale` values are aligned so
   *   clips of different lengths stay in step.
   * @returns This action, for chaining.
   */
  public crossFadeTo(
    fadeInAction: AnimationAction,
    duration: number = DEFAULT_FADE_DURATION,
    warp = false,
  ): this {
    fadeInAction.fadeIn(duration);
    this.fadeOut(duration);

    if (warp) {
      const thisSpan = this.clip.duration * Math.abs(this.timeScale);
      const otherSpan = fadeInAction.clip.duration * Math.abs(fadeInAction.timeScale);
      if (thisSpan > 0 && otherSpan > 0) {
        fadeInAction.timeScale = (otherSpan / thisSpan) * this.timeScale;
      }
    }

    fadeInAction.play();
    return this;
  }

  /**
   * Cross-fades **from** `fadeOutAction` **to** this action.
   *
   * @param fadeOutAction Action to fade out.
   * @param duration Fade length in seconds.
   * @param warp Align the two actions' `timeScale` values.
   * @returns This action, for chaining.
   */
  public crossFadeFrom(
    fadeOutAction: AnimationAction,
    duration: number = DEFAULT_FADE_DURATION,
    warp = false,
  ): this {
    this.fadeIn(duration);
    fadeOutAction.fadeOut(duration);

    if (warp) {
      const thisSpan = this.clip.duration * Math.abs(this.timeScale);
      const otherSpan = fadeOutAction.clip.duration * Math.abs(fadeOutAction.timeScale);
      if (thisSpan > 0 && otherSpan > 0) {
        fadeOutAction.timeScale = (otherSpan / thisSpan) * this.timeScale;
      }
    }

    this.play();
    return this;
  }

  /**
   * Sets the easing applied to every subsequent fade on this action.
   *
   * @param easing A curve, or a name accepted by `Easing.getEasing`.
   * @returns This action, for chaining.
   */
  public setFadeEasing(easing: EasingFunction | string): this {
    this.fadeEasing = typeof easing === 'string' ? Easing.getEasing(easing) : easing;
    return this;
  }

  /** Schedules a weight fade from `from` to `to` over `duration` seconds. */
  private scheduleFading(duration: number, from: number, to: number): this {
    const seconds = Math.max(0, duration);
    this.fadeFrom = clamp01(from);
    this.fadeTo = clamp01(to);
    this.fadeDuration = seconds;
    this.fadeElapsed = 0;
    this.weight = this.fadeFrom;

    if (seconds <= 0) {
      this._weightInterpolant = null;
      this.weight = this.fadeTo;
    } else {
      this._weightInterpolant = new WeightInterpolant(this.fadeFrom, this.fadeTo);
      this.emit('fade', seconds);
    }
    return this;
  }

  /* --------------------------------------------------------------- syncing */

  /**
   * Aligns this action's phase and rate with another action.
   *
   * The classic use is syncing a walk and a run clip so their footfalls line up:
   * `run.syncWith(walk)` copies the normalised phase and rescales `timeScale` by the
   * duration ratio, so both stay in step at any speed.
   *
   * @param other Action to sync with.
   * @returns This action, for chaining.
   */
  public syncWith(other: AnimationAction): this {
    const thisDuration = this.clip.duration;
    const otherDuration = other.clip.duration;
    if (thisDuration <= 0 || otherDuration <= 0) return this;

    this.time = (other.time / otherDuration) * thisDuration;
    this.timeScale = (thisDuration / otherDuration) * other.timeScale;
    return this;
  }

  /**
   * @returns The mixer that owns this action.
   */
  public getMixer(): AnimationMixer {
    return this.mixer;
  }

  /**
   * @returns The clip this action plays.
   */
  public getClip(): AnimationClip {
    return this.clip;
  }

  /**
   * @returns The root object this action's tracks bind against.
   */
  public getRoot(): Object3DLike {
    return this.root;
  }

  /* -------------------------------------------------------------- updating */

  /**
   * Advances the action and blends its tracks into `accumulator`.
   *
   * Called by {@link AnimationMixer.update}; safe to call directly when driving an
   * action by hand.
   *
   * @param delta Seconds since the previous call.
   * @param accumulator Sparse map from track name to the blended value so far.
   * @param weight Total weight contributed by actions processed before this one.
   * @returns `true` when the action wrote anything.
   */
  public update(delta: number, accumulator: Map<string, Float32Array>, weight: number): boolean {
    if (!this.enabled) return false;

    this.advanceFade(delta);
    const actionWeight = this.getEffectiveWeight();

    if (this.running && !this.paused) this.advanceTime(delta);

    let wrote = false;
    for (const slot of this.slots) {
      if (this.writeSlot(slot, accumulator, weight, actionWeight)) wrote = true;
    }
    return wrote;
  }

  /** Advances the active weight ramp by `delta`. */
  private advanceFade(delta: number): void {
    if (this._weightInterpolant === null) return;

    this.fadeElapsed += delta;
    const alpha = this.fadeDuration > 0 ? clamp01(this.fadeElapsed / this.fadeDuration) : 1;
    const eased = this.fadeEasing(alpha);
    this.weight = clamp01(this.fadeFrom + (this.fadeTo - this.fadeFrom) * eased);

    if (alpha >= 1) {
      this.weight = clamp01(this.fadeTo);
      this._weightInterpolant = null;
      this.fadeDuration = 0;
      this.fadeElapsed = 0;
    }
  }

  /** Advances {@link AnimationAction.time} by `delta`, honouring the loop mode. */
  private advanceTime(delta: number): void {
    const duration = this.clip.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      this.time = 0;
      return;
    }

    const directed = delta * this.timeScale * (this.reversed ? -1 : 1);
    this.time += directed;

    switch (this.loop) {
      case 'once':
        this.clampOnce(duration);
        return;
      case 'pingpong':
        this.wrapPingPong(duration);
        return;
      case 'repeat':
      default:
        this.wrapRepeat(duration);
        return;
    }
  }

  /** Clamps a `LoopOnce` action at either end and fires `finished`. */
  private clampOnce(duration: number): void {
    if (this.time < duration) return;

    this.time = duration;
    this.loopCount++;

    const wasRunning = this.running;
    if (this.clampWhenFinished) {
      this.paused = true;
      this.running = false;
    } else {
      this.enabled = false;
      this.running = false;
    }

    if (wasRunning) {
      this.emit('finished');
      this.mixer._actionFinished(this);
    }
  }

  /** Wraps a repeating action, counting repetitions and deactivating at the end. */
  private wrapRepeat(duration: number): void {
    if (this.time >= 0 && this.time < duration) return;

    const previous = this.loopCount;
    let loops: number;
    if (this.time >= 0) {
      loops = Math.floor(this.time / duration);
      this.time -= loops * duration;
    } else {
      loops = Math.floor(this.time / duration);
      this.time -= loops * duration;
    }
    if (this.time < 0) this.time += duration;
    if (this.time >= duration) this.time -= duration;

    this.loopCount = previous + Math.abs(loops);

    if (!Number.isFinite(this.repetitions)) return;

    if (this.loopCount >= this.repetitions) {
      this.time = 0;
      this.enabled = false;
      this.running = false;
      this.emit('finished');
      this.mixer._actionFinished(this);
    }
  }

  /** Reflects a ping-pong action off both ends of the clip. */
  private wrapPingPong(duration: number): void {
    const cycle = duration * 2;
    let phase = this.time % cycle;
    if (phase < 0) phase += cycle;

    let completed = 0;

    if (phase >= duration) {
      // Reflected leg: the action is now running backwards.
      if (!this.reversed) {
        // Finishing the forward leg counts as one repetition.
        completed = 1;
      }
      phase = cycle - phase;
      this.reversed = true;
    } else {
      if (this.reversed) {
        // Finishing the backward leg counts as one repetition.
        completed = 1;
      }
      this.reversed = false;
    }

    this.time = phase;
    this.loopCount += completed;

    if (!Number.isFinite(this.repetitions)) return;

    if (this.loopCount >= this.repetitions) {
      this.enabled = false;
      this.running = false;
      this.emit('finished');
      this.mixer._actionFinished(this);
    }
  }

  /* ------------------------------------------------------------ track write */

  /** Resolves and blends one track. */
  private writeSlot(
    slot: BindingSlot,
    accumulator: Map<string, Float32Array>,
    weight: number,
    actionWeight: number,
  ): boolean {
    const binding = this.ensureBinding(slot);
    if (binding === null) return false;

    const interpolant = slot.track.createInterpolant();
    const evaluated = interpolant.evaluate(this.time);
    for (let i = 0; i < slot.source.length; i++) slot.source[i] = evaluated[i] ?? 0;

    let target = accumulator.get(slot.track.name);
    if (target === undefined) {
      target = new Float32Array(slot.track.valueSize);
      accumulator.set(slot.track.name, target);
    }

    this.accumulate(slot, target, actionWeight, weight);
    return binding.setValue(target);
  }

  /** Blends one track's value into the accumulator. */
  private accumulate(
    slot: BindingSlot,
    target: Float32Array,
    actionWeight: number,
    weight: number,
  ): void {
    const count = target.length;

    switch (this.blendMode) {
      case 'override': {
        for (let i = 0; i < count; i++) target[i] = slot.source[i];
        return;
      }
      case 'additive': {
        for (let i = 0; i < count; i++) target[i] += slot.source[i] * actionWeight;
        return;
      }
      case 'normal':
      default: {
        // Weighted running average. `weight` is the total already folded in, so a
        // single full-weight action reproduces its authored value exactly.
        const total = weight + actionWeight;
        if (total <= 0) {
          for (let i = 0; i < count; i++) target[i] = 0;
          return;
        }
        for (let i = 0; i < count; i++) {
          target[i] = (target[i] * weight + slot.source[i] * actionWeight) / total;
        }
        return;
      }
    }
  }

  /** Lazily builds (or returns the supplied) binding for a slot. */
  private ensureBinding(slot: BindingSlot): PropertyBinding | null {
    if (slot.binding !== null) return slot.binding;

    const index = this.slots.indexOf(slot);
    const supplied = index >= 0 ? this.suppliedBindings?.[index] : undefined;
    if (supplied !== undefined) {
      slot.binding = supplied;
      return supplied;
    }

    const created = PropertyBinding.tryCreate(this.root, slot.track.name);
    if (created === null) return null;
    slot.binding = created;
    return created;
  }

  /* -------------------------------------------------------------- helpers */

  /**
   * Exposes the action's per-track values without copying.
   *
   * The mixer owns the `out` array and reuses it between actions, so the returned
   * entries — and their `source` buffers — are only valid until the next call.
   *
   * @internal
   * @param out Reusable array to fill; it is truncated first.
   * @returns `out`, filled with one entry per track.
   */
  public getSlotValues(out: SlotContribution[]): SlotContribution[] {
    out.length = 0;
    for (const slot of this.slots) {
      const evaluated = slot.track.createInterpolant().evaluate(this.time);
      for (let i = 0; i < slot.source.length; i++) slot.source[i] = evaluated[i] ?? 0;
      out.push({ name: slot.track.name, valueSize: slot.track.valueSize, source: slot.source });
    }
    return out;
  }

  /**
   * Collects the action's own (unblended) value for every track.
   *
   * @returns A map from track name to the value at the current time.
   */
  public getValues(): Map<string, Float32Array> {
    const values = new Map<string, Float32Array>();
    for (const slot of this.slots) {
      const evaluated = slot.track.createInterpolant().evaluate(this.time);
      values.set(slot.track.name, Float32Array.from(evaluated));
    }
    return values;
  }

  /**
   * Writes the current value of every track straight into the bound objects.
   *
   * `AnimationMixer.update` does this as part of blending; this entry point exists
   * for a caller that paused the mixer but still wants to flush a pose.
   *
   * @returns The number of tracks that were written.
   */
  public applyBindings(): number {
    let written = 0;
    for (const slot of this.slots) {
      const binding = this.ensureBinding(slot);
      if (binding === null) continue;
      if (binding.setValue(slot.track.createInterpolant().evaluate(this.time))) written++;
    }
    return written;
  }

  /**
   * @returns A snapshot suitable for a debug overlay.
   */
  public toSnapshot(): ActionSnapshot {
    return {
      clipName: this.clip.name,
      running: this.running,
      weight: this.getEffectiveWeight(),
      time: this.time,
      timeScale: this.timeScale,
      repetitions: this.loopCount,
      fading: this.isFading,
    };
  }

  /* --------------------------------------------------------------- events */

  /**
   * Registers a listener.
   *
   * @param event Event name (`'start'`, `'finished'`, `'stop'`, `'fade'`).
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

  /**
   * Removes a listener.
   *
   * @param event Event name.
   * @param listener Callback previously passed to {@link AnimationAction.on}.
   * @returns `true` when a listener was removed.
   */
  public off(event: string, listener: EventListener): boolean {
    return this.listeners.get(event)?.delete(listener) ?? false;
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

  /** Removes every listener; called when the mixer is disposed. */
  public clearListeners(): void {
    this.listeners.clear();
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return (
      `AnimationAction(clip="${this.clip.name}", time=${this.time.toFixed(3)}, ` +
      `weight=${this.getEffectiveWeight().toFixed(3)}, running=${this.running}, loop=${this.loop})`
    );
  }
}
