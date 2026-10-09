/**
 * `Updateable` — the per-frame update contract.
 *
 * Nodes declare an {@link UpdatePriority} instead of relying on tree order, so a
 * camera can update before the objects that depend on it regardless of where it
 * sits in the scene graph. `UpdateScheduler` collects updateables and runs them
 * in a stable, priority-ordered sequence.
 *
 * ```ts
 * const scheduler = new UpdateScheduler();
 * scheduler.add(cameraController).add(animationMixer);
 * scheduler.update(frameInfo);
 * ```
 *
 * @packageDocumentation
 */

import type { FrameInfo } from './types';

/** Update order buckets. Lower values run earlier. */
export enum UpdatePriority {
  /** Physics/simulation, before anything else. */
  Physics = -1000,
  /** Input handling and controllers. */
  Input = -800,
  /** Cameras and view-dependent state. */
  Camera = -600,
  /** Animation mixers and tweens. */
  Animation = -400,
  /** Skeletal animation and skinning. */
  Skin = -300,
  /** Gameplay/AI logic. */
  Logic = 0,
  /** Particle simulation. */
  Particles = 200,
  /** Per-object transforms. */
  Transform = 400,
  /** Late transforms that must follow everything else. */
  LateTransform = 600,
  /** Text layout and other expensive derived data. */
  Layout = 800,
  /** Post-render bookkeeping (stats, profiling). */
  Post = 1000,
}

/** The update contract. */
export interface IUpdateable {
  /** `true` while the object should receive updates. */
  enabled: boolean;
  /** Bucket used to order updates. */
  updatePriority: UpdatePriority;
  /** Called once per frame. */
  update(delta: number, frame?: FrameInfo): void;
}

/** Optional second hook for code that must run after every {@link IUpdateable.update}. */
export interface ILateUpdateable extends IUpdateable {
  lateUpdate(delta: number, frame?: FrameInfo): void;
}

/** A `fixedUpdate` hook for deterministic simulation. */
export interface IFixedUpdateable {
  /** Called once per fixed step; see `FrameAccumulator`. */
  fixedUpdate(step: number, frame?: FrameInfo): void;
}

/** Decorator: runs `callback` before and after the update. */
export interface UpdateTiming {
  /** Timestamp when the update started. */
  start: number;
  /** Duration of the last update, in milliseconds. */
  duration: number;
}

/**
 * Mixin installing the update members on a class.
 *
 * ```ts
 * class Spinner extends withUpdateable(Object3D) {
 *   public update(delta: number): void { this.rotation.y += delta; }
 * }
 * ```
 */
export function withUpdateable<TBase extends abstract new (...args: any[]) => object>(
  Base: TBase,
): TBase & (abstract new (...args: any[]) => IUpdateable) {
  abstract class WithUpdateable extends (Base as abstract new (...args: any[]) => object) {
    /** `true` while the object should receive updates. */
    public enabled = true;

    /** Bucket used to order updates. */
    public updatePriority: UpdatePriority = UpdatePriority.Logic;

    /** Overridden by subclasses; the default does nothing. */
    public update(_delta: number, _frame?: FrameInfo): void {
      /* no-op */
    }
  }
  return WithUpdateable as unknown as TBase & (abstract new (...args: any[]) => IUpdateable);
}

/** A registered updateable plus its bookkeeping. */
interface SchedulerEntry {
  target: IUpdateable;
  /** Insertion index, used to keep the sort stable. */
  order: number;
  /** Last measured duration, in milliseconds. */
  lastDuration: number;
  /** Set while the target is paused by the scheduler. */
  paused: boolean;
}

/**
 * Runs updateables in priority order.
 *
 * The scheduler re-sorts only when its membership or an entry's priority changes,
 * so a steady-state frame costs one array walk.
 */
export class UpdateScheduler {
  /** Registered entries, kept sorted by `(priority, order)`. */
  private readonly entries: SchedulerEntry[] = [];

  /** `true` when the entry list needs re-sorting. */
  private dirty = false;

  /** Total frames processed. */
  public frameCount = 0;

  /** Total milliseconds spent inside `update` since the last {@link resetStats}. */
  public updateTime = 0;

  /** `true` to measure per-entry durations (adds `performance.now()` calls). */
  public profiling = false;

  /**
   * Registers an updateable.
   *
   * @param target Object implementing {@link IUpdateable}.
   * @param priority Optional explicit bucket; defaults to `target.updatePriority`.
   * @returns `this`, so registrations chain.
   */
  public add(target: IUpdateable, priority?: UpdatePriority): this {
    if (priority !== undefined) target.updatePriority = priority;
    if (this.entries.some((entry) => entry.target === target)) return this;
    this.entries.push({
      target,
      order: this.entries.length,
      lastDuration: 0,
      paused: !target.enabled,
    });
    this.dirty = true;
    return this;
  }

  /** Registers several updateables at once. */
  public addAll(...targets: IUpdateable[]): this {
    for (const target of targets) this.add(target);
    return this;
  }

  /** Removes an updateable. */
  public remove(target: IUpdateable): boolean {
    const index = this.entries.findIndex((entry) => entry.target === target);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    this.dirty = true;
    return true;
  }

  /** Removes every updateable. */
  public clear(): this {
    this.entries.length = 0;
    this.dirty = false;
    return this;
  }

  /** Pauses updates for `target` without unregistering it. */
  public pause(target: IUpdateable): boolean {
    const entry = this.entries.find((item) => item.target === target);
    if (!entry) return false;
    entry.paused = true;
    return true;
  }

  /** Resumes updates for `target`. */
  public resume(target: IUpdateable): boolean {
    const entry = this.entries.find((item) => item.target === target);
    if (!entry) return false;
    entry.paused = false;
    return true;
  }

  /** Number of registered updateables. */
  public get size(): number {
    return this.entries.length;
  }

  /** Forces a re-sort on the next {@link update} (after external priority changes). */
  public invalidateOrder(): this {
    this.dirty = true;
    return this;
  }

  /**
   * Runs every enabled updateable once.
   *
   * @param frame Optional frame info; when omitted only the delta is passed.
   * @returns The number of updateables that ran.
   */
  public update(frame: FrameInfo | number): number {
    const info: FrameInfo | undefined = typeof frame === 'number' ? undefined : frame;
    const delta = typeof frame === 'number' ? frame : frame.delta;

    if (this.dirty) {
      this.entries.sort((a, b) =>
        a.target.updatePriority === b.target.updatePriority
          ? a.order - b.order
          : a.target.updatePriority - b.target.updatePriority,
      );
      this.dirty = false;
    }

    let ran = 0;
    const totalStart = this.profiling ? nowMilliseconds() : 0;

    for (const entry of this.entries) {
      if (entry.paused || !entry.target.enabled) continue;
      const start = this.profiling ? nowMilliseconds() : 0;
      try {
        entry.target.update(delta, info);
      } catch (error) {
        // One broken updateable must not stop the frame.
        // eslint-disable-next-line no-console
        console.error(`UpdateScheduler: update() failed for priority ${entry.target.updatePriority}`, error);
      }
      if (this.profiling) {
        entry.lastDuration = nowMilliseconds() - start;
      }
      ran++;
    }

    if (this.profiling) this.updateTime = nowMilliseconds() - totalStart;
    this.frameCount++;
    return ran;
  }

  /**
   * Runs every updateable that also implements {@link ILateUpdateable.lateUpdate}.
   *
   * @returns The number of late updates that ran.
   */
  public lateUpdate(frame: FrameInfo | number): number {
    const info: FrameInfo | undefined = typeof frame === 'number' ? undefined : frame;
    const delta = typeof frame === 'number' ? frame : frame.delta;

    let ran = 0;
    for (const entry of this.entries) {
      if (entry.paused || !entry.target.enabled) continue;
      const late = (entry.target as Partial<ILateUpdateable>).lateUpdate;
      if (typeof late !== 'function') continue;
      try {
        late.call(entry.target, delta, info);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('UpdateScheduler: lateUpdate() failed', error);
      }
      ran++;
    }
    return ran;
  }

  /**
   * Runs every updateable that implements {@link IFixedUpdateable.fixedUpdate}.
   *
   * @param step Fixed timestep in seconds.
   * @returns The number of fixed updates that ran.
   */
  public fixedUpdate(step: number, frame?: FrameInfo): number {
    let ran = 0;
    for (const entry of this.entries) {
      if (entry.paused || !entry.target.enabled) continue;
      const fixed = (entry.target as Partial<IFixedUpdateable>).fixedUpdate;
      if (typeof fixed !== 'function') continue;
      try {
        fixed.call(entry.target, step, frame);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('UpdateScheduler: fixedUpdate() failed', error);
      }
      ran++;
    }
    return ran;
  }

  /** Resets the accumulated timing statistics. */
  public resetStats(): this {
    this.updateTime = 0;
    this.frameCount = 0;
    for (const entry of this.entries) entry.lastDuration = 0;
    return this;
  }

  /** Per-entry timing report, sorted by descending cost. */
  public getProfile(): { priority: UpdatePriority; duration: number }[] {
    return this.entries
      .map((entry) => ({ priority: entry.target.updatePriority, duration: entry.lastDuration }))
      .sort((a, b) => b.duration - a.duration);
  }

  /** Every registered updateable, in execution order. */
  public targets(): IUpdateable[] {
    return this.entries.map((entry) => entry.target);
  }
}

/** Monotonic timestamp helper that works without `performance`. */
function nowMilliseconds(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** `true` when `value` implements {@link IUpdateable}. */
export function isUpdateable(value: unknown): value is IUpdateable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as IUpdateable).update === 'function'
  );
}

/**
 * Wraps a callback as an {@link IUpdateable}.
 *
 * ```ts
 * scheduler.add(createUpdateable(UpdatePriority.Animation, (delta) => mixer.update(delta)));
 * ```
 */
export function createUpdateable(
  priority: UpdatePriority,
  update: (delta: number, frame?: FrameInfo) => void,
): IUpdateable {
  return {
    enabled: true,
    updatePriority: priority,
    update,
  };
}
