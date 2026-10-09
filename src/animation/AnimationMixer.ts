/**
 * `AnimationMixer` — the clock and blender that drives actions.
 *
 * A mixer owns a **root object** (usually a `Scene3D`, `Object3D` or skeleton root)
 * and the set of {@link AnimationAction}s playing on it. Every frame it advances
 * each action, blends their results per track and writes the result into the bound
 * properties **exactly once per track** — which is what makes two actions on one
 * property blend smoothly instead of fighting.
 *
 * ```ts
 * const mixer = new AnimationMixer(character);
 * const walk = mixer.clipAction(walkClip);
 * const idle = mixer.clipAction(idleClip).play();
 * walk.play();
 * walk.crossFadeTo(idle, 0.4);
 *
 * // in the update loop
 * mixer.update(clock.getDelta());
 * ```
 *
 * ## Blending order
 *
 * Within one {@link AnimationMixer.update}:
 *
 * 1. `normal` actions are blended into a weighted running average, so a single
 *    full-weight action yields its authored value exactly.
 * 2. `additive` actions add `value * weight` on top of that average, contributing
 *    nothing when their weight is zero.
 * 3. `override` actions replace whatever came before, in `blendMode` order.
 *
 * Actions are processed in a stable sort by `blendMode`, then by play order, so a
 * clip's look does not depend on the order `clipAction` happened to be called in.
 *
 * @packageDocumentation
 */

import { createId } from '../utils/Id';
import { createLogger } from '../utils/Logger';
import { AnimationAction, type SlotContribution } from './AnimationAction';
import { AnimationClip } from './AnimationClip';
import { PropertyBinding } from './PropertyBinding';
import type { BlendMode, Object3DLike } from './types';

/** Logger shared by every mixer. */
const log = createLogger('animation:mixer');

/** Sort weight of each blend mode; lower runs first. */
const BLEND_ORDER: Readonly<Record<BlendMode, number>> = {
  normal: 0,
  additive: 1,
  override: 2,
};

/**
 * Drives a set of actions over one root object.
 */
export class AnimationMixer {
  /** Unique identifier. */
  public readonly id: string = createId('mixer');

  /** Root object the tracks resolve against. */
  public readonly root: Object3DLike;

  /** Accumulated mixer time in seconds. */
  public time = 0;

  /** Global playback rate applied on top of every action's own rate. */
  public timeScale = 1;

  /** `false` suspends {@link AnimationMixer.update} without losing state. */
  public enabled = true;

  /** Number of `update` calls made; useful in diagnostics. */
  public updateCount = 0;

  /** Actions created by this mixer, in creation order. */
  private readonly actions: AnimationAction[] = [];

  /** Actions with a non-zero effective weight, re-sorted every update. */
  private activeActions: AnimationAction[] = [];

  /** Track name → resolved binding, rebuilt when the active set changes. */
  private readonly bindings = new Map<string, PropertyBinding | null>();

  /** Track name → mixer-owned blend buffer. */
  private readonly targets = new Map<string, Float32Array>();

  /** Track name → accumulated normal-blend weight. */
  private readonly weights = new Map<string, number>();

  /** Reused scratch array; never handed out. */
  private readonly contributions: SlotContribution[] = [];

  /** Reused accumulator passed to `AnimationAction.update`; always empty. */
  private readonly scratchAccumulator = new Map<string, Float32Array>();

  /** Fires when an action finishes, for `LoopOnce` bookkeeping. */
  private readonly finishedActions = new Set<AnimationAction>();

  /** Callbacks registered through {@link AnimationMixer.on}. */
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  /** `true` once {@link AnimationMixer.dispose} has run. */
  private disposed = false;

  /**
   * Creates a mixer.
   *
   * @param root Root object the tracks resolve against.
   */
  constructor(root: Object3DLike) {
    this.root = root;
  }

  /* --------------------------------------------------------------- actions */

  /**
   * Returns the action for `clip` on this mixer, creating it on first use.
   *
   * Actions are cached per clip instance, so calling `clipAction(clip)` twice
   * returns the same object and does not restart playback.
   *
   * @param clip Clip to play.
   * @param root Optional root override; the action is cached on `this` regardless.
   * @param bindings Optional pre-resolved bindings, one per clip track.
   * @returns The cached or newly created action.
   */
  public clipAction(
    clip: AnimationClip,
    root: Object3DLike = this.root,
    bindings: readonly PropertyBinding[] | null = null,
  ): AnimationAction {
    const existing = this.existingAction(clip, root);
    if (existing !== null) return existing;

    const action = new AnimationAction(this, clip, root, bindings);
    this.actions.push(action);
    this.invalidateBindings();
    log.debug(`created action for clip "${clip.name}"`, { id: this.id, tracks: clip.tracks.length });
    this.emit('clipActionCreated', action);
    return action;
  }

  /**
   * Finds an already-created action for a clip/root pair.
   *
   * @param clip Clip to look up.
   * @param root Root the action was created with; defaults to this mixer's root.
   * @returns The action, or `null`.
   */
  public existingAction(clip: AnimationClip, root: Object3DLike = this.root): AnimationAction | null {
    for (const action of this.actions) {
      if (action.clip === clip && action.root === root) return action;
    }
    return null;
  }

  /**
   * @returns The mixer's root object.
   */
  public getRoot(): Object3DLike {
    return this.root;
  }

  /**
   * Removes every action created from `clip`.
   *
   * The actions are stopped first, so their faded state does not linger.
   *
   * @param clip Clip to uncache.
   * @returns The number of actions removed.
   */
  public uncacheClip(clip: AnimationClip): number {
    let removed = 0;
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const action = this.actions[i];
      if (action.clip !== clip) continue;
      action.stop();
      action.clearListeners();
      this.actions.splice(i, 1);
      removed++;
    }
    if (removed > 0) this.invalidateBindings();
    return removed;
  }

  /**
   * Removes every action bound to `root`.
   *
   * @param root Root object to uncache.
   * @returns The number of actions removed.
   */
  public uncacheRoot(root: Object3DLike): number {
    let removed = 0;
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const action = this.actions[i];
      if (action.root !== root) continue;
      action.stop();
      action.clearListeners();
      this.actions.splice(i, 1);
      removed++;
    }
    if (removed > 0) this.invalidateBindings();
    return removed;
  }

  /**
   * Removes one action.
   *
   * @param action Action to remove.
   * @returns `true` when the action belonged to this mixer.
   */
  public uncacheAction(action: AnimationAction): boolean {
    const index = this.actions.indexOf(action);
    if (index < 0) return false;
    action.stop();
    action.clearListeners();
    this.actions.splice(index, 1);
    this.invalidateBindings();
    return true;
  }

  /**
   * Stops every action without removing it.
   *
   * @returns This mixer, for chaining.
   */
  public stopAllAction(): this {
    for (const action of this.actions) action.stop();
    this.activeActions.length = 0;
    this.invalidateBindings();
    return this;
  }

  /**
   * @returns A copy of the action list, in creation order.
   */
  public getActions(): AnimationAction[] {
    return this.actions.slice();
  }

  /**
   * @returns The actions that contributed to the most recent update.
   */
  public getActiveActions(): AnimationAction[] {
    return this.activeActions.slice();
  }

  /**
   * @returns The number of cached actions.
   */
  public get actionCount(): number {
    return this.actions.length;
  }

  /* ------------------------------------------------------------- activation */

  /** @internal Marks an action active; called by `AnimationAction.play`. */
  public _activateAction(action: AnimationAction): void {
    if (!this.activeActions.includes(action)) this.activeActions.push(action);
    this.invalidateBindings();
  }

  /** @internal Drops an action from the active set; called by `stop`. */
  public _deactivateAction(action: AnimationAction): void {
    const index = this.activeActions.indexOf(action);
    if (index >= 0) this.activeActions.splice(index, 1);
  }

  /** @internal Records a finished action and emits the `finished` event. */
  public _actionFinished(action: AnimationAction): void {
    this.finishedActions.add(action);
    this.emit('finished', action);
  }

  /** @returns The actions that finished during the most recent update. */
  public getFinishedActions(): AnimationAction[] {
    return Array.from(this.finishedActions);
  }

  /**
   * Clears the finished-action log.
   *
   * @returns This mixer, for chaining.
   */
  public clearFinishedActions(): this {
    this.finishedActions.clear();
    return this;
  }

  /* ---------------------------------------------------------------- update */

  /**
   * Advances every action and writes the blended result.
   *
   * @param delta Seconds since the previous call. Values are multiplied by
   *   {@link AnimationMixer.timeScale} before being handed to the actions.
   * @returns The number of actions that contributed.
   */
  public update(delta: number): number {
    if (this.disposed || !this.enabled) return 0;

    const scaledDelta = delta * this.timeScale;
    this.updateCount++;

    // Refresh the active set: an action becomes active when `play` is called, but a
    // fade-out that reached zero weight should stop contributing.
    this.refreshActiveActions();

    if (this.activeActions.length === 0) {
      this.time += scaledDelta;
      this.emit('update', scaledDelta, this.time);
      return 0;
    }

    // Stable sort by blend mode; `Array#sort` is stable in every ES2019+ engine.
    this.activeActions.sort((a, b) => BLEND_ORDER[a.blendMode] - BLEND_ORDER[b.blendMode]);

    this.prepareTrackBuffers();

    let contributing = 0;
    for (const action of this.activeActions) {
      this.scratchAccumulator.clear();
      if (action.update(scaledDelta, this.scratchAccumulator, 0)) contributing++;
      this.collectContributions(action);
    }

    // A `LoopOnce` action deactivates itself mid-update, so the finished log is
    // refreshed here rather than only inside `_actionFinished`.
    for (const action of this.actions) {
      if (action.isFinished) this.finishedActions.add(action);
    }

    this.writeMixedValues();

    this.time += scaledDelta;
    this.emit('update', scaledDelta, this.time);
    return contributing;
  }

  /** Rebuilds {@link AnimationMixer.activeActions} from the action list. */
  private refreshActiveActions(): void {
    const next: AnimationAction[] = [];
    for (const action of this.actions) {
      if (!action.running && !action.isFading) continue;
      if (action.getEffectiveWeight() <= 0 && !action.isFading) continue;
      next.push(action);
    }
    // Keep the previously recorded order stable where possible: actions already
    // present keep their relative position, new ones append.
    const ordered: AnimationAction[] = [];
    for (const action of this.activeActions) {
      if (next.includes(action)) ordered.push(action);
    }
    for (const action of next) {
      if (!ordered.includes(action)) ordered.push(action);
    }
    this.activeActions = ordered;
  }

  /** Makes sure every active action's tracks have a binding and a buffer. */
  private prepareTrackBuffers(): void {
    for (const action of this.activeActions) {
      for (const track of action.clip.tracks) {
        if (!this.bindings.has(track.name)) {
          const binding = PropertyBinding.tryCreate(action.root, track.name);
          this.bindings.set(track.name, binding);
        }
        if (!this.targets.has(track.name)) {
          this.targets.set(track.name, new Float32Array(track.valueSize));
        }
      }
    }
  }

  /** Blends one action's current values into {@link AnimationMixer.targets}. */
  private collectContributions(action: AnimationAction): void {
    if (!action.enabled) return;

    const weight = action.getEffectiveWeight();
    if (weight <= 0 && action.blendMode !== 'override') return;

    this.contributions.length = 0;
    const values = action.getSlotValues(this.contributions);

    for (const contribution of values) {
      const target = this.targets.get(contribution.name);
      if (target === undefined) continue;

      const count = Math.min(target.length, contribution.valueSize);

      switch (action.blendMode) {
        case 'override': {
          for (let i = 0; i < count; i++) target[i] = contribution.source[i];
          break;
        }
        case 'additive': {
          for (let i = 0; i < count; i++) target[i] += contribution.source[i] * weight;
          break;
        }
        case 'normal':
        default: {
          const previous = this.weights.get(contribution.name) ?? 0;
          const total = previous + weight;
          if (total <= 0) break;
          for (let i = 0; i < count; i++) {
            target[i] = (target[i] * previous + contribution.source[i] * weight) / total;
          }
          this.weights.set(contribution.name, total);
          break;
        }
      }
    }
  }

  /** Writes every mixed track into its bound property and resets the accumulators. */
  private writeMixedValues(): void {
    for (const [name, target] of this.targets) {
      const binding = this.bindings.get(name);
      if (binding != null) binding.setValue(target);
      target.fill(0);
    }
    this.weights.clear();
  }

  /** Drops cached bindings so they are re-resolved on the next update. */
  private invalidateBindings(): void {
    this.bindings.clear();
  }

  /**
   * Clears every cached binding and blend buffer.
   *
   * Call this after swapping the geometry or material a clip targets.
   *
   * @returns This mixer, for chaining.
   */
  public resetBindings(): this {
    this.bindings.clear();
    this.targets.clear();
    this.weights.clear();
    return this;
  }

  /* ------------------------------------------------------------------ time */

  /**
   * Moves every action to an absolute time.
   *
   * @param time Mixer time in seconds.
   * @param timeScale Optional new global time scale.
   * @returns This mixer, for chaining.
   */
  public setTime(time: number, timeScale: number = this.timeScale): this {
    const delta = time - this.time;
    this.timeScale = timeScale;
    this.time = time;
    for (const action of this.actions) {
      // Absolute positioning: pin the action's clock rather than integrating, so
      // `setTime` is exact even after a long pause.
      const previous = action.time;
      action.time = previous + delta * action.timeScale * (action.reversed ? -1 : 1);
      this.clampActionTime(action);
    }
    return this;
  }

  /** Keeps an action's time inside its clip after an external change. */
  private clampActionTime(action: AnimationAction): void {
    const duration = action.clip.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      action.time = 0;
      return;
    }
    if (action.time < 0) action.time = 0;
    if (action.time > duration) action.time = duration;
  }

  /**
   * @returns The mixer's accumulated time in seconds.
   */
  public getTime(): number {
    return this.time;
  }

  /**
   * Samples every active action at an absolute time without advancing the mixer.
   *
   * @param time Absolute time in seconds.
   * @returns The blended value of every track.
   */
  public sample(time: number): Map<string, Float32Array> {
    const saved = this.time;
    this.setTime(time);
    this.prepareTrackBuffers();
    for (const action of this.activeActions) {
      this.scratchAccumulator.clear();
      action.update(0, this.scratchAccumulator, 0);
      this.collectContributions(action);
    }
    const snapshot = new Map<string, Float32Array>();
    for (const [name, target] of this.targets) snapshot.set(name, target.slice());
    for (const target of this.targets.values()) target.fill(0);
    this.weights.clear();
    this.time = saved;
    return snapshot;
  }

  /* ---------------------------------------------------------------- events */

  /**
   * Registers a listener.
   *
   * @param event Event name (`'update'`, `'finished'`, `'clipActionCreated'`).
   * @param listener Callback.
   * @returns An unsubscribe function.
   */
  public on(event: string, listener: (...args: unknown[]) => void): () => void {
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
   * @param listener Callback previously passed to {@link AnimationMixer.on}.
   * @returns `true` when a listener was removed.
   */
  public off(event: string, listener: (...args: unknown[]) => void): boolean {
    return this.listeners.get(event)?.delete(listener) ?? false;
  }

  /** Emits one event to every registered listener. */
  private emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of Array.from(set)) {
      try {
        listener(...args);
      } catch (error) {
        log.warn(`listener for "${event}" threw`, error);
      }
    }
  }

  /* --------------------------------------------------------------- dispose */

  /**
   * @returns `true` once {@link AnimationMixer.dispose} has run.
   */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Stops every action, drops every cached binding and removes every listener.
   *
   * @returns This mixer, for chaining.
   */
  public dispose(): this {
    if (this.disposed) return this;
    this.stopAllAction();
    for (const action of this.actions) action.clearListeners();
    this.actions.length = 0;
    this.activeActions.length = 0;
    this.bindings.clear();
    this.targets.clear();
    this.weights.clear();
    this.finishedActions.clear();
    this.listeners.clear();
    this.disposed = true;
    return this;
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return (
      `AnimationMixer(id=${this.id}, time=${this.time.toFixed(3)}, ` +
      `actions=${this.actions.length}, active=${this.activeActions.length})`
    );
  }
}

/**
 * Convenience factory mirroring `new AnimationMixer(root)`.
 *
 * @param root Root object the tracks resolve against.
 * @returns A new mixer.
 */
export function animationMixer(root: Object3DLike): AnimationMixer {
  return new AnimationMixer(root);
}
