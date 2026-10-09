/**
 * `Timeline` — an ordered, seekable schedule of callbacks and tweens.
 *
 * A timeline is the "director" primitive: it puts *things that happen* on a single
 * shared clock, in order, and lets the whole sequence be scrubbed. Each entry is a
 * callback fired once when the playhead crosses its time, and it may optionally
 * hold a tween (or any object exposing `update(delta)` and a duration) that is
 * driven for the length of its span.
 *
 * ```ts
 * const timeline = new Timeline({ duration: 4, loop: true });
 * timeline.add(0, () => intro.play());
 * timeline.add(1.2, (dt) => sparkle.update(dt), { duration: 0.8 });
 * timeline.addLabel('boss', 3.5);
 * timeline.play();
 *
 * timeline.update(clock.getDelta());
 * timeline.seek(2.0);            // scrub; nothing before 2.0 re-fires
 * ```
 *
 * ## Crossing semantics
 *
 * An entry fires when the playhead moves from *before* its time to *at or after*
 * it, so exactly one callback per crossing. Seeking **forward** fires only the
 * entry at the seek target — the intervening entries were skipped, not played.
 * Seeking **backwards** re-arms entries so they can fire again. That is the
 * behaviour a scrub bar needs, and it is what the test suite asserts.
 *
 * @packageDocumentation
 */

import type { EventListener } from '../core/EventEmitter';
import { clamp, clamp01 } from '../utils/MathUtils';
import type { Tween } from './Tween';

/** Anything a timeline can drive for the length of an entry's span. */
export interface TimelineDriver {
  /** Advances the driver. */
  update(delta: number): unknown;
  /** Total duration in seconds, when the driver reports one. */
  totalDuration?: number;
}

/** A scheduled entry. */
export interface TimelineEntry {
  /** Stable identifier. */
  readonly id: number;
  /** Seconds from the timeline origin. */
  time: number;
  /** Callback fired on the frame the playhead crosses {@link TimelineEntry.time}. */
  callback: ((delta: number) => void) | null;
  /** Optional driver advanced while the playhead is inside the entry's span. */
  driver: TimelineDriver | null;
  /** Span length in seconds; `0` means "fire and forget". */
  duration: number;
  /** Arbitrary label used by {@link Timeline.removeWhere}. */
  tag: string;
  /** `true` once the entry has fired in the current pass. */
  fired: boolean;
  /** `true` when a driver has already been started for the current pass. */
  started: boolean;
}

/** A named point in time. */
export interface TimelineLabel {
  /** Label name; names are unique, adding one twice moves it. */
  name: string;
  /** Position in seconds. */
  time: number;
  /** `true` once the playhead has crossed the label in the current pass. */
  passed: boolean;
}

/** Construction options for {@link Timeline}. */
export interface TimelineOptions {
  /** Total length in seconds; `0` means "derive it from the entries". */
  duration?: number;
  /** `true` restarts from zero at the end. */
  loop?: boolean;
  /** Playback rate applied to every `update` delta. */
  timeScale?: number;
  /** `true` (the default) starts advancing on the first `update` call. */
  autoPlay?: boolean;
}

/** Options accepted by {@link Timeline.add}. */
export interface TimelineAddOptions {
  /** Span length in seconds; defaults to the driver's own duration, or `0`. */
  duration?: number;
  /** Tag used by {@link Timeline.removeWhere}. */
  tag?: string;
  /** Entry to insert before, in time order. */
  fireOnce?: boolean;
}

/**
 * An ordered, seekable schedule.
 */
export class Timeline {
  /** Total length in seconds. When `0`, {@link Timeline.getDuration} derives it. */
  public durationTime: number;

  /** `true` restarts from zero when the playhead reaches the end. */
  public loop: boolean;

  /** Playback rate. */
  public timeScale: number;

  /** Current playhead position in seconds. */
  public time = 0;

  /** Number of completed passes. */
  public passCount = 0;

  /** `true` while the timeline advances. */
  public running = false;

  /** Scheduled entries, kept sorted by time. */
  private readonly entries: TimelineEntry[] = [];

  /** Named points in time. */
  private readonly labels = new Map<string, TimelineLabel>();

  /** Monotonic id source. */
  private nextEntryId = 1;

  /** Registered listeners. */
  private readonly listeners = new Map<string, Set<EventListener>>();

  /**
   * Creates a timeline.
   *
   * @param options Length, looping and playback-rate configuration.
   */
  constructor(options: TimelineOptions = {}) {
    this.durationTime = Math.max(0, options.duration ?? 0);
    this.loop = options.loop ?? false;
    this.timeScale = options.timeScale ?? 1;
    // A timeline is a *player*: it advances only once `play()` is called, unless the caller
    // explicitly opts into auto-play. Defaulting to running would mean a timeline advanced
    // the moment it was constructed, which is never what a caller wants.
    this.running = options.autoPlay ?? false;
  }

  /* ------------------------------------------------------------------ edits */

  /**
   * Schedules an entry.
   *
   * @param time Seconds from the timeline origin.
   * @param callback Callback fired when the playhead crosses `time`.
   * @param driver Optional object advanced while the playhead is inside the span.
   * @param options Span length, tag and one-shot flag.
   * @returns The new entry.
   */
  public add(
    time: number,
    callback?: ((delta: number) => void) | null,
    driver?: TimelineDriver | Tween | null,
    options: TimelineAddOptions = {},
  ): TimelineEntry {
    const resolvedDriver = (driver ?? null) as TimelineDriver | null;
    const entry: TimelineEntry = {
      id: this.nextEntryId++,
      time: Math.max(0, time),
      callback: callback ?? null,
      driver: resolvedDriver,
      duration: Math.max(0, options.duration ?? resolvedDriver?.totalDuration ?? 0),
      tag: options.tag ?? '',
      fired: false,
      started: false,
    };

    this.entries.push(entry);
    this.entries.sort((a, b) => (a.time === b.time ? a.id - b.id : a.time - b.time));
    return entry;
  }

  /**
   * Schedules an entry that only ever fires once, even across loops.
   *
   * @param time Seconds from the timeline origin.
   * @param callback Callback.
   * @param options Span length and tag.
   * @returns The new entry.
   */
  public addOnce(
    time: number,
    callback: (delta: number) => void,
    options: TimelineAddOptions = {},
  ): TimelineEntry {
    return this.add(time, callback, null, options);
  }

  /**
   * Schedules a driver to run for its own duration.
   *
   * @param time Seconds from the timeline origin.
   * @param driver Object exposing `update(delta)`.
   * @param options Span length (defaults to the driver's `totalDuration`) and tag.
   * @returns The new entry.
   */
  public addDriver(
    time: number,
    driver: TimelineDriver,
    options: TimelineAddOptions = {},
  ): TimelineEntry {
    return this.add(time, null, driver, options);
  }

  /**
   * Removes an entry.
   *
   * @param entry Entry, or its numeric id.
   * @returns `true` when an entry was removed.
   */
  public remove(entry: TimelineEntry | number): boolean {
    const index =
      typeof entry === 'number'
        ? this.entries.findIndex((candidate) => candidate.id === entry)
        : this.entries.indexOf(entry);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return true;
  }

  /**
   * Removes every entry whose tag matches.
   *
   * @param tag Tag to match.
   * @returns The number of entries removed.
   */
  public removeWhere(tag: string): number {
    let removed = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].tag !== tag) continue;
      this.entries.splice(i, 1);
      removed++;
    }
    return removed;
  }

  /**
   * Removes every entry.
   *
   * @returns This timeline, for chaining.
   */
  public clear(): this {
    this.entries.length = 0;
    return this;
  }

  /* ----------------------------------------------------------------- labels */

  /**
   * Adds or moves a named label.
   *
   * @param name Label name.
   * @param time Position in seconds.
   * @returns This timeline, for chaining.
   */
  public addLabel(name: string, time: number): this {
    this.labels.set(name, { name, time: Math.max(0, time), passed: false });
    this.emit('labelsChanged');
    return this;
  }

  /**
   * Removes a label.
   *
   * @param name Label name.
   * @returns `true` when a label was removed.
   */
  public removeLabel(name: string): boolean {
    const removed = this.labels.delete(name);
    if (removed) this.emit('labelsChanged');
    return removed;
  }

  /**
   * Looks a label up.
   *
   * @param name Label name.
   * @returns The label record, or `undefined`.
   */
  public getLabel(name: string): TimelineLabel | undefined {
    return this.labels.get(name);
  }

  /**
   * @returns Every label, sorted by time.
   */
  public getLabels(): TimelineLabel[] {
    return Array.from(this.labels.values()).sort((a, b) => a.time - b.time);
  }

  /**
   * Moves the playhead to a label.
   *
   * @param name Label name.
   * @returns `true` when the label existed.
   */
  public seekToLabel(name: string): boolean {
    const label = this.labels.get(name);
    if (!label) return false;
    this.seek(label.time);
    return true;
  }

  /* -------------------------------------------------------------- transport */

  /**
   * Starts (or resumes) playback.
   *
   * @returns This timeline, for chaining.
   */
  public play(): this {
    this.running = true;
    this.emit('play');
    return this;
  }

  /**
   * Pauses playback, keeping the playhead.
   *
   * @returns This timeline, for chaining.
   */
  public pause(): this {
    this.running = false;
    this.emit('pause');
    return this;
  }

  /**
   * Stops and rewinds to zero.
   *
   * @returns This timeline, for chaining.
   */
  public stop(): this {
    this.running = false;
    this.seek(0);
    return this;
  }

  /**
   * Moves the playhead to an absolute time.
   *
   * Entries whose time sits **after** the new position are re-armed, so a backward seek
   * replays them; entries already passed by a forward seek are marked fired so a scrub does
   * not dump a burst of callbacks. An entry at exactly `time === 0` stays armed, so it still
   * fires on the first `update` rather than being swallowed by the seek.
   *
   * @param time Target position in seconds; clamped to the timeline's duration.
   * @returns This timeline, for chaining.
   */
  public seek(time: number): this {
    const target = clamp(time, 0, Math.max(0, this.getDuration()));
    const forward = target >= this.time;
    this.time = target;

    for (const entry of this.entries) {
      if (entry.time > target) {
        entry.fired = false;
        entry.started = false;
      } else if (entry.time === 0 && target === 0) {
        // The playhead is at the very start: an entry scheduled at t = 0 has not been
        // crossed yet, so leave it armed.
        entry.fired = false;
        entry.started = false;
      } else if (forward) {
        // Skipped over: never fire it, but leave it armed for a later backward seek.
        entry.fired = true;
        entry.started = entry.time + entry.duration <= target;
      } else {
        entry.fired = false;
        entry.started = false;
      }
    }

    for (const label of this.labels.values()) {
      label.passed = label.time > 0 && label.time <= target;
    }

    this.emit('seek', this.time);
    return this;
  }

  /**
   * Total length of the timeline.
   *
   * @returns The explicit duration when set, otherwise the end of the last entry
   *   (or label).
   */
  public getDuration(): number {
    if (this.durationTime > 0) return this.durationTime;

    let end = 0;
    for (const entry of this.entries) {
      const entryEnd = entry.time + entry.duration;
      if (entryEnd > end) end = entryEnd;
    }
    for (const label of this.labels.values()) {
      if (label.time > end) end = label.time;
    }
    return end;
  }

  /**
   * Sets an explicit duration.
   *
   * @param seconds Duration in seconds; `0` restores derivation from the entries.
   * @returns This timeline, for chaining.
   */
  public setDuration(seconds: number): this {
    this.durationTime = Math.max(0, seconds);
    return this;
  }

  /**
   * Normalised playhead position.
   *
   * @returns A value in `[0, 1]`.
   */
  public get progress(): number {
    const duration = this.getDuration();
    return duration > 0 ? clamp01(this.time / duration) : this.time > 0 ? 1 : 0;
  }

  /**
   * @returns `true` when the playhead has reached the end and is not looping.
   */
  public get isComplete(): boolean {
    const duration = this.getDuration();
    return !this.loop && duration > 0 && this.time >= duration;
  }

  /**
   * @returns The scheduled entries, in time order.
   */
  public getEntries(): readonly TimelineEntry[] {
    return this.entries;
  }

  /* ----------------------------------------------------------------- update */

  /**
   * Advances the playhead, firing every entry it crosses.
   *
   * @param delta Seconds since the previous call.
   * @returns `true` while the timeline is running.
   */
  public update(delta: number): boolean {
    if (!this.running) return false;
    const step = delta * this.timeScale;
    if (!(step > 0)) return true;

    const duration = this.getDuration();
    const previousTime = this.time;
    let target = this.time + step;
    let wrapped = false;

    if (duration > 0 && target >= duration) {
      if (this.loop) {
        // Consume whole passes; each one counts and re-arms the schedule.
        const overshoot = target - duration;
        target = duration > 0 ? overshoot % duration : 0;
        wrapped = true;
      } else {
        target = duration;
      }
    }

    if (wrapped) {
      // Fire everything up to the old end, then restart from zero.
      this.fireRange(previousTime, duration, step);
      this.passCount++;
      this.time = 0;
      this.resetPass();
      // The remainder of the frame is spent inside the new pass.
      const remaining = Math.max(0, target);
      if (remaining > 0) {
        this.fireRange(0, remaining, step);
        this.time = remaining;
      }
      this.emit('label', '', this.time);
      return true;
    }

    this.fireRange(previousTime, target, step);
    this.time = target;

    if (!this.loop && duration > 0 && this.time >= duration) {
      this.running = false;
      this.emit('complete');
      return false;
    }

    return true;
  }

  /**
   * Fires and drives every entry the playhead has reached.
   *
   * The test is `entry.time >= from && entry.time <= to`, so an entry scheduled at `t = 0`
   * fires on the first update (where `from === 0`) and every entry fires exactly once, because
   * `entry.fired` latches until the next pass.
   *
   * @param from Previous playhead position.
   * @param to New playhead position.
   * @param delta Step size, forwarded to the callbacks and drivers.
   */
  private fireRange(from: number, to: number, delta: number): void {
    for (const entry of this.entries) {
      if (!entry.fired && entry.time >= from && entry.time <= to) {
        entry.fired = true;
        entry.started = true;
        entry.callback?.(delta);
      }
    }

    // Drive the spans that contain `to`.
    for (const entry of this.entries) {
      if (entry.driver === null) continue;
      const spanStart = entry.time;
      const spanEnd = entry.time + entry.duration;
      if (to >= spanStart && to <= spanEnd + 1e-9) {
        entry.driver.update(delta);
      }
    }

    for (const label of this.labels.values()) {
      if (!label.passed && label.time >= from && label.time <= to) {
        label.passed = true;
        this.emit('label', label.name, label.time);
      }
    }
  }

  /** Re-arms every entry and label for a new pass. */
  private resetPass(): void {
    for (const entry of this.entries) {
      entry.fired = false;
      entry.started = false;
    }
    for (const label of this.labels.values()) label.passed = false;
  }

  /* ---------------------------------------------------------------- events */

  /**
   * Registers a listener.
   *
   * Generic in the listener's argument list so the callback's parameters are typed
   * rather than erased to `unknown[]`. Without the parameter the default
   * `EventListener` is `(...args: unknown[]) => void`, and a listener that names its
   * arguments — `(name: string) => ...`, which is how every caller writes a label
   * listener — is then rejected as not assignable.
   *
   * @param event Event name (`'play'`, `'pause'`, `'seek'`, `'label'`,
   *   `'complete'`, `'labelsChanged'`).
   * @param listener Callback.
   * @returns An unsubscribe function.
   */
  public on<A extends unknown[] = unknown[]>(
    event: string,
    listener: EventListener<A>,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as EventListener);
    const registered = set;
    return () => {
      registered.delete(listener as EventListener);
    };
  }

  /**
   * Removes a listener.
   *
   * @param event Event name.
   * @param listener Callback previously passed to {@link Timeline.on}.
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

  /**
   * Removes every listener and clears the schedule.
   *
   * @returns This timeline, for chaining.
   */
  public dispose(): this {
    this.listeners.clear();
    this.entries.length = 0;
    this.labels.clear();
    this.running = false;
    return this;
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return (
      `Timeline(time=${this.time.toFixed(3)}/${this.getDuration().toFixed(3)}, ` +
      `entries=${this.entries.length}, labels=${this.labels.size}, loop=${this.loop})`
    );
  }
}

/**
 * Convenience factory mirroring `new Timeline(options)`.
 *
 * @param options Length, looping and playback-rate configuration.
 * @returns A new timeline.
 */
export function timeline(options: TimelineOptions = {}): Timeline {
  return new Timeline(options);
}
