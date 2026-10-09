/**
 * `ParticleSystem` — a pooled, deterministic particle simulation.
 *
 * ## Pooling, and why the attributes are interleaved
 *
 * A particle system allocates and frees thousands of particles per second. Allocating a
 * `Particle` object per spawn would put the GC in the render loop; instead, the simulation
 * state lives in **parallel `Float32Array`s indexed by slot**, and a free list keeps the
 * live particles packed at the front.
 *
 * The buffers handed to the GPU are **interleaved** — one array per attribute, `itemSize`
 * wide, one slot per particle — which is the layout `BufferAttribute` already expects. That
 * means a spawn writes to both representations in one pass, with no second copy.
 *
 * ```
 *   slot:        0      1      2      3      4    ...   capacity-1
 *   alive:       ▓      ▓      ▓      ─      ─
 *   position:   xyz    xyz    xyz    ·      ·
 *   velocity:   xyz    xyz    xyz    ·      ·
 *   ...
 *   freeList:   [4, 5, 6, ...]        <- reused before any new slot is touched
 * ```
 *
 * ## Determinism
 *
 * Every random draw goes through the {@link ParticleEmitter}'s seeded source, and the update
 * loop processes particles in slot order. Same seed + same delta sequence ⇒ identical
 * particle count and identical positions. That is not an accident: it is what makes a
 * particle regression test possible at all.
 *
 * ## Lifecycle
 *
 * ```
 *   start ──> emitting ──duration elapsed──> draining ──all dead──> complete
 *     ^                                        │
 *     └──────────── loop: true ────────────────┘
 * ```
 *
 * With `duration > 0` and `loop: false`, emission stops after `duration` and the `complete`
 * event fires once the **last** particle dies — not when emission stops, because a system
 * that vanished mid-flight would pop.
 *
 * ```ts
 * const system = new ParticleSystem({ maxParticles: 500, emissionRate: 100, seed: 7 });
 * system.emitter.shape = 'sphere';
 * system.emitter.radius = 2;
 * system.update(1 / 60);
 * system.getAliveCount();
 * ```
 *
 * @packageDocumentation
 */

import { Color } from '../../math/Color';
import { Vec3 } from '../../math/Vec3';
import { Disposable } from '../../core/Disposable';
import { EventEmitter } from '../../core/EventEmitter';
import { createId } from '../../utils/Id';
import { clamp, seededRandom } from '../../utils/MathUtils';
import { Float32BufferAttribute } from '../../geometry/core/BufferAttribute';
import { ParticleEmitter } from './ParticleEmitter';
import { ParticleMaterial } from './ParticleMaterial';
import type { ParticleEmitterOptions, ParticleMaterialOptions } from '../types';
import type {
  ParticleStats,
  ParticleSystemOptions,
  RendererLike,
} from '../types';

/** Events emitted by a particle system. */
export interface ParticleSystemEvents {
  /** Particles were spawned. */
  spawn: [count: number];
  /** A particle died. */
  kill: [index: number];
  /** Emission finished and every particle has died. */
  complete: [];
  /** Emission started. */
  start: [];
  /** Emission stopped. */
  stop: [];
  /** The system was paused. */
  pause: [];
  /** The system resumed. */
  resume: [];
  /** A resource was disposed. */
  dispose: [];
  /** A resource finished disposing. */
  disposed: [];
}

/** Attribute names exposed by a particle system. */
export type ParticleAttributeName = 'position' | 'velocity' | 'color' | 'size' | 'rotation' | 'uv' | 'life';

/**
 * A pooled particle simulation.
 */
export class ParticleSystem extends Disposable<'ParticleSystem'> {
  /** @inheritdoc */
  public override readonly label = 'ParticleSystem' as const;

  /** Identifier. */
  public override readonly id: string = createId('particles');

  /** Maximum live particles. */
  public maxParticles: number;

  /** Particles emitted per second. */
  public emissionRate: number;

  /** Emission duration in seconds; `0` means "unlimited". */
  public duration: number;

  /** `true` restarts emission when the duration elapses. */
  public loop: boolean;

  /** Emitter driving the spawn distribution. */
  public emitter: ParticleEmitter;

  /** Material the system draws with. */
  public material: ParticleMaterial;

  /** `true` while particles are simulated. */
  public running = false;

  /** `true` while new particles are being created. */
  public emitting = false;

  /** Seconds of emission elapsed in the current cycle. */
  public emissionTime = 0;

  /** Seconds since `start`. */
  public elapsed = 0;

  /** `true` once the system has finished and stopped. */
  public completed = false;

  /** Lifecycle events. */
  public override readonly events = new EventEmitter<ParticleSystemEvents>() as unknown as EventEmitter<
    ParticleSystemEvents
  > &
    EventEmitter<{ dispose: []; disposed: [] }>;

  /** Live particle count. */
  private alive = 0;

  /** Free slot list; slots are reused before the array grows. */
  private readonly freeList: number[] = [];

  /** Fractional emission carry-over. */
  private emissionAccumulator = 0;

  /** Seconds until the next burst. */
  private burstTimer = 0;

  /** Particles spawned since construction. */
  private spawnedCount = 0;

  /** Particles killed since construction. */
  private killedCount = 0;

  /** Per-slot remaining lifetime. */
  private readonly lifes: Float32Array;

  /** Per-slot total lifetime, for the life ratio. */
  private readonly lifetimes: Float32Array;

  /** Per-slot initial size. */
  private readonly startSizes: Float32Array;

  /** Per-slot end size. */
  private readonly endSizes: Float32Array;

  /** Per-slot angular velocity. */
  private readonly angularVelocities: Float32Array;

  /** Per-slot random value used to break ties in the seeded stream. */
  private readonly seeds: Float32Array;

  /** Interleaved position buffer: `xyz` per slot. */
  private readonly positionArray: Float32Array;

  /** Interleaved velocity buffer: `xyz` per slot. */
  private readonly velocityArray: Float32Array;

  /** Interleaved colour buffer: `rgba` per slot. */
  private readonly colorArray: Float32Array;

  /** Interleaved size buffer: one float per slot. */
  private readonly sizeArray: Float32Array;

  /** Interleaved rotation buffer: one float per slot. */
  private readonly rotationArray: Float32Array;

  /** Interleaved UV buffer: `xy` per slot. */
  private readonly uvArray: Float32Array;

  /** Interleaved life buffer: `life01, remaining` per slot. */
  private readonly lifeArray: Float32Array;

  /** `BufferAttribute`-shaped views over the interleaved arrays. */
  private readonly attributes = new Map<ParticleAttributeName, Float32BufferAttribute>();

  /** Reused scratch vectors, so a spawn allocates nothing. */
  private readonly scratchPosition = new Vec3();

  /** Reused scratch velocity. */
  private readonly scratchVelocity = new Vec3();

  /** Reused scratch colour. */
  private readonly scratchStartColor = new Color();

  /** Reused scratch colour. */
  private readonly scratchEndColor = new Color();

  /** Accumulated frame time, for the update loop. */
  private frameTime = 0;

  /**
   * Creates a particle system.
   *
   * @param options Capacity, emission, emitter and material configuration.
   */
  constructor(options: ParticleSystemOptions = {}) {
    super();

    this.maxParticles = Math.max(1, Math.floor(options.maxParticles ?? 1000));
    this.emissionRate = Math.max(0, options.emissionRate ?? 10);
    this.duration = Math.max(0, options.duration ?? 0);
    this.loop = options.loop ?? true;

    const emitterOption = options.emitter as ParticleEmitter | ParticleEmitterOptions | undefined;
    this.emitter =
      emitterOption instanceof ParticleEmitter
        ? emitterOption
        : new ParticleEmitter({ ...(emitterOption ?? {}), seed: options.seed ?? 1 });

    if (options.seed !== undefined) this.emitter.setSeed(options.seed);

    const materialOption = options.material as ParticleMaterial | ParticleMaterialOptions | undefined;
    this.material =
      materialOption instanceof ParticleMaterial
        ? materialOption
        : new ParticleMaterial(materialOption ?? {});

    const capacity = this.maxParticles;
    this.lifes = new Float32Array(capacity);
    this.lifetimes = new Float32Array(capacity);
    this.startSizes = new Float32Array(capacity);
    this.endSizes = new Float32Array(capacity);
    this.angularVelocities = new Float32Array(capacity);
    this.seeds = new Float32Array(capacity);

    this.positionArray = new Float32Array(capacity * 3);
    this.velocityArray = new Float32Array(capacity * 3);
    this.colorArray = new Float32Array(capacity * 4);
    this.sizeArray = new Float32Array(capacity);
    this.rotationArray = new Float32Array(capacity);
    this.uvArray = new Float32Array(capacity * 2);
    this.lifeArray = new Float32Array(capacity * 2);

    this.buildAttributes();

    if (options.autoStart !== false) this.start();
  }

  /* -------------------------------------------------------------- attributes */

  /** Builds the `BufferAttribute` views over the interleaved arrays. */
  private buildAttributes(): void {
    this.attributes.set('position', new Float32BufferAttribute(this.positionArray, 3));
    this.attributes.set('velocity', new Float32BufferAttribute(this.velocityArray, 3));
    this.attributes.set('color', new Float32BufferAttribute(this.colorArray, 4));
    this.attributes.set('size', new Float32BufferAttribute(this.sizeArray, 1));
    this.attributes.set('rotation', new Float32BufferAttribute(this.rotationArray, 1));
    this.attributes.set('uv', new Float32BufferAttribute(this.uvArray, 2));
    this.attributes.set('life', new Float32BufferAttribute(this.lifeArray, 2));
  }

  /**
   * A `BufferAttribute` view over an interleaved array.
   *
   * @param name Attribute name.
   * @returns The attribute, or `undefined` for an unknown name.
   */
  public getAttribute(name: ParticleAttributeName): Float32BufferAttribute | undefined {
    return this.attributes.get(name);
  }

  /**
   * The position attribute.
   *
   * @returns `xyz` per slot.
   */
  public getPositionAttribute(): Float32BufferAttribute {
    return this.attributes.get('position') as Float32BufferAttribute;
  }

  /**
   * The colour attribute.
   *
   * @returns `rgba` per slot.
   */
  public getColorAttribute(): Float32BufferAttribute {
    return this.attributes.get('color') as Float32BufferAttribute;
  }

  /**
   * The size attribute.
   *
   * @returns One float per slot.
   */
  public getSizeAttribute(): Float32BufferAttribute {
    return this.attributes.get('size') as Float32BufferAttribute;
  }

  /**
   * The rotation attribute.
   *
   * @returns One float per slot, in radians.
   */
  public getRotationAttribute(): Float32BufferAttribute {
    return this.attributes.get('rotation') as Float32BufferAttribute;
  }

  /**
   * The UV attribute.
   *
   * @returns `xy` per slot.
   */
  public getUvAttribute(): Float32BufferAttribute {
    return this.attributes.get('uv') as Float32BufferAttribute;
  }

  /**
   * Every attribute, keyed by name.
   *
   * @returns The attribute map.
   */
  public getAttributes(): Map<ParticleAttributeName, Float32BufferAttribute> {
    return this.attributes;
  }

  /**
   * The number of vertices a draw should submit.
   *
   * Live particles are packed at the front of the buffers, so this is the count a backend
   * passes to `drawArrays`.
   *
   * @returns The live particle count.
   */
  public getVertexCount(): number {
    return this.alive;
  }

  /* ---------------------------------------------------------------- lifecycle */

  /**
   * Starts (or restarts) the simulation.
   *
   * @returns This system, for chaining.
   */
  public start(): this {
    this.assertUsable();
    this.running = true;
    this.emitting = this.emissionRate > 0;
    this.completed = false;
    this.emissionTime = 0;
    this.elapsed = 0;
    this.burstTimer = 0;
    this.events.emit('start');
    return this;
  }

  /**
   * Stops simulating, keeping the live particles.
   *
   * @returns This system, for chaining.
   */
  public stop(): this {
    this.running = false;
    this.emitting = false;
    this.events.emit('stop');
    return this;
  }

  /**
   * Pauses the simulation.
   *
   * @returns This system, for chaining.
   */
  public pause(): this {
    this.running = false;
    this.events.emit('pause');
    return this;
  }

  /**
   * Resumes a paused simulation.
   *
   * @returns This system, for chaining.
   */
  public resume(): this {
    this.running = true;
    this.events.emit('resume');
    return this;
  }

  /**
   * Kills every particle and rewinds the emission clock.
   *
   * @returns This system, for chaining.
   */
  public reset(): this {
    this.killAll();
    this.emissionTime = 0;
    this.elapsed = 0;
    this.emissionAccumulator = 0;
    this.burstTimer = 0;
    this.completed = false;
    return this;
  }

  /**
   * Sets the emitter's seed and restarts the random stream.
   *
   * @param seed New seed.
   * @returns This system, for chaining.
   */
  public setSeed(seed: number): this {
    this.emitter.setSeed(seed);
    return this;
  }

  /* ----------------------------------------------------------------- spawning */

  /**
   * Spawns `count` particles.
   *
   * @param count Number to spawn; defaults to `1`.
   * @returns The number actually spawned, which is smaller when the pool is full.
   */
  public spawn(count = 1): number {
    let spawned = 0;
    const wanted = Math.max(0, Math.floor(count));

    for (let i = 0; i < wanted; i++) {
      const slot = this.allocateSlot();
      if (slot < 0) break;

      const emitter = this.emitter;
      emitter.samplePosition(this.scratchPosition);
      emitter.sampleVelocity(this.scratchVelocity);
      emitter.sampleColor(this.scratchStartColor);
      emitter.sampleEndColor(this.scratchEndColor);

      const lifetime = emitter.sampleLifetime();
      const startSize = emitter.sampleSize();
      const endSize = emitter.sampleEndSize();

      this.lifes[slot] = lifetime;
      this.lifetimes[slot] = lifetime;
      this.startSizes[slot] = startSize;
      this.endSizes[slot] = endSize;
      this.angularVelocities[slot] = emitter.sampleAngularVelocity();
      this.seeds[slot] = emitter.nextRandom();

      this.positionArray[slot * 3] = this.scratchPosition.x;
      this.positionArray[slot * 3 + 1] = this.scratchPosition.y;
      this.positionArray[slot * 3 + 2] = this.scratchPosition.z;

      this.velocityArray[slot * 3] = this.scratchVelocity.x;
      this.velocityArray[slot * 3 + 1] = this.scratchVelocity.y;
      this.velocityArray[slot * 3 + 2] = this.scratchVelocity.z;

      this.colorArray[slot * 4] = this.scratchStartColor.r;
      this.colorArray[slot * 4 + 1] = this.scratchStartColor.g;
      this.colorArray[slot * 4 + 2] = this.scratchStartColor.b;
      this.colorArray[slot * 4 + 3] = this.scratchStartColor.a;

      this.sizeArray[slot] = startSize;
      this.rotationArray[slot] = emitter.sampleRotation();
      this.uvArray[slot * 2] = 0;
      this.uvArray[slot * 2 + 1] = 0;
      this.lifeArray[slot * 2] = 0;
      this.lifeArray[slot * 2 + 1] = lifetime;

      this.alive++;
      spawned++;
      this.spawnedCount++;
    }

    if (spawned > 0) {
      this.markAttributesDirty();
      this.events.emit('spawn', spawned);
    }
    return spawned;
  }

  /**
   * Kills one particle.
   *
   * @param index Slot to kill.
   * @returns `true` when a live particle was killed.
   */
  public kill(index: number): boolean {
    if (index < 0 || index >= this.alive) return false;

    const lastLive = this.alive - 1;
    if (index !== lastLive) {
      // Swap the last live particle into the hole so the live range stays contiguous,
      // which is what lets a draw submit `alive` vertices with no index buffer.
      this.copySlot(lastLive, index);
    }

    this.freeList.push(lastLive);
    this.alive--;
    this.killedCount++;
    this.markAttributesDirty();
    this.events.emit('kill', index);
    return true;
  }

  /**
   * Kills every particle.
   *
   * @returns The number killed.
   */
  public killAll(): number {
    const killed = this.alive;
    this.alive = 0;
    this.freeList.length = 0;
    // Rebuild the free list in reverse so slot 0 is reused first.
    for (let slot = this.maxParticles - 1; slot >= 0; slot--) this.freeList.push(slot);
    this.killedCount += killed;
    this.markAttributesDirty();
    return killed;
  }

  /** Allocates a slot, or `-1` when the pool is full. */
  private allocateSlot(): number {
    const slot = this.freeList.pop();
    if (slot === undefined) return -1;
    return slot;
  }

  /** Copies every per-slot array from one index to another. */
  private copySlot(from: number, to: number): void {
    this.lifes[to] = this.lifes[from];
    this.lifetimes[to] = this.lifetimes[from];
    this.startSizes[to] = this.startSizes[from];
    this.endSizes[to] = this.endSizes[from];
    this.angularVelocities[to] = this.angularVelocities[from];
    this.seeds[to] = this.seeds[from];

    for (let i = 0; i < 3; i++) {
      this.positionArray[to * 3 + i] = this.positionArray[from * 3 + i];
      this.velocityArray[to * 3 + i] = this.velocityArray[from * 3 + i];
    }
    for (let i = 0; i < 4; i++) this.colorArray[to * 4 + i] = this.colorArray[from * 4 + i];
    for (let i = 0; i < 2; i++) {
      this.uvArray[to * 2 + i] = this.uvArray[from * 2 + i];
      this.lifeArray[to * 2 + i] = this.lifeArray[from * 2 + i];
    }
    this.sizeArray[to] = this.sizeArray[from];
    this.rotationArray[to] = this.rotationArray[from];
  }

  /* ------------------------------------------------------------------ update */

  /**
   * Advances the simulation.
   *
   * @param delta Seconds since the previous call.
   * @returns The number of particles alive after the step.
   */
  public update(delta: number): number {
    if (this.disposedGuard()) return 0;

    const step = clamp(delta, 0, 0.1);
    if (!this.running) return this.alive;

    this.elapsed += step;
    this.frameTime += step;

    // ---- emission -----------------------------------------------------------
    if (this.emitting) {
      this.emissionTime += step;

      const wantBurst = this.emitter.burst > 0 && this.emitter.burstInterval > 0;
      if (wantBurst) {
        this.burstTimer += step;
        while (this.burstTimer >= this.emitter.burstInterval) {
          this.burstTimer -= this.emitter.burstInterval;
          this.spawn(this.emitter.burst);
        }
      }

      const rate = this.emissionRate > 0 ? this.emissionRate : this.emitter.rate;
      const emission = this.emitter.computeEmission(step, this.emissionAccumulator);
      this.emissionAccumulator = emission.accumulator;
      if (rate > 0 && emission.count > 0) this.spawn(emission.count);

      if (this.duration > 0 && this.emissionTime >= this.duration) {
        this.emitting = false;
        if (this.loop) {
          // Restart the cycle immediately, keeping the live particles so the effect does
          // not visibly gap.
          this.emissionTime = 0;
          this.emissionAccumulator = 0;
          this.emitting = true;
        }
      }
    }

    // ---- simulate -----------------------------------------------------------
    // Iterating backwards means a swap-with-last kill cannot skip a particle.
    for (let slot = this.alive - 1; slot >= 0; slot--) {
      const remaining = this.lifes[slot] - step;
      if (remaining <= 0) {
        this.kill(slot);
        continue;
      }
      this.lifes[slot] = remaining;

      const lifetime = this.lifetimes[slot] || 1;
      const life01 = clamp(remaining / lifetime, 0, 1);
      const age01 = 1 - life01;

      const gravity = this.emitter.gravity;
      const drag = this.emitter.drag;

      const vx = this.velocityArray[slot * 3];
      const vy = this.velocityArray[slot * 3 + 1];
      const vz = this.velocityArray[slot * 3 + 2];

      // Semi-implicit Euler: velocity first (with gravity and drag), then position. It is
      // stable at any step size a frame loop produces, unlike explicit Euler.
      const damping = drag > 0 ? Math.max(0, 1 - drag * step) : 1;
      const nvx = (vx + gravity.x * step) * damping;
      const nvy = (vy + gravity.y * step) * damping;
      const nvz = (vz + gravity.z * step) * damping;

      this.velocityArray[slot * 3] = nvx;
      this.velocityArray[slot * 3 + 1] = nvy;
      this.velocityArray[slot * 3 + 2] = nvz;

      this.positionArray[slot * 3] += nvx * step;
      this.positionArray[slot * 3 + 1] += nvy * step;
      this.positionArray[slot * 3 + 2] += nvz * step;

      // Size and colour ramp from the spawn values toward the end values.
      this.sizeArray[slot] = this.startSizes[slot] + (this.endSizes[slot] - this.startSizes[slot]) * age01;

      const angular = this.angularVelocities[slot];
      if (angular !== 0) this.rotationArray[slot] += angular * step;

      this.lifeArray[slot * 2] = life01;
      this.lifeArray[slot * 2 + 1] = remaining;
    }

    if (this.alive > 0) this.markAttributesDirty();

    // ---- completion ---------------------------------------------------------
    if (!this.emitting && !this.completed && this.duration > 0 && !this.loop && this.alive === 0) {
      this.completed = true;
      this.running = false;
      this.events.emit('complete');
    }

    return this.alive;
  }

  /* ------------------------------------------------------------------ queries */

  /**
   * Live particle count.
   *
   * @returns The count.
   */
  public getAliveCount(): number {
    return this.alive;
  }

  /**
   * `true` when the pool is full.
   *
   * @returns The saturation flag.
   */
  public get isFull(): boolean {
    return this.alive >= this.maxParticles;
  }

  /**
   * The remaining lifetime of one particle.
   *
   * @param index Slot index.
   * @returns Seconds remaining, or `0` for a dead slot.
   */
  public getRemainingLife(index: number): number {
    return index >= 0 && index < this.alive ? this.lifes[index] : 0;
  }

  /**
   * A particle's position.
   *
   * @param index Slot index.
   * @param target Vector to write.
   * @returns `target`.
   */
  public getPosition(index: number, target: Vec3 = new Vec3()): Vec3 {
    const offset = Math.max(0, Math.min(index, this.maxParticles - 1)) * 3;
    return target.set(
      this.positionArray[offset],
      this.positionArray[offset + 1],
      this.positionArray[offset + 2],
    );
  }

  /**
   * A particle's current colour.
   *
   * @param index Slot index.
   * @param target Colour to write.
   * @returns `target`.
   */
  public getColor(index: number, target: Color = new Color()): Color {
    const offset = Math.max(0, Math.min(index, this.maxParticles - 1)) * 4;
    return target.setRgb(
      this.colorArray[offset],
      this.colorArray[offset + 1],
      this.colorArray[offset + 2],
      this.colorArray[offset + 3],
    );
  }

  /**
   * A particle's current size.
   *
   * @param index Slot index.
   * @returns The size.
   */
  public getSize(index: number): number {
    return this.sizeArray[Math.max(0, Math.min(index, this.maxParticles - 1))];
  }

  /**
   * The interleaved position buffer.
   *
   * @returns `xyz` per slot.
   */
  public getPositionArray(): Float32Array {
    return this.positionArray;
  }

  /**
   * The interleaved colour buffer.
   *
   * @returns `rgba` per slot.
   */
  public getColorArray(): Float32Array {
    return this.colorArray;
  }

  /**
   * A snapshot of the system's statistics.
   *
   * @returns The statistics.
   */
  public getStats(): ParticleStats {
    return {
      alive: this.alive,
      spawned: this.spawnedCount,
      killed: this.killedCount,
      capacity: this.maxParticles,
      utilization: this.maxParticles > 0 ? this.alive / this.maxParticles : 0,
      emissionAccumulator: this.emissionAccumulator,
      emissionRemaining:
        this.duration > 0 ? Math.max(0, this.duration - this.emissionTime) : Infinity,
      emitting: this.emitting,
    };
  }

  /**
   * Renders the system through a structural renderer.
   *
   * @param renderer Renderer to draw with, or `null` for a no-op.
   * @returns `true` when a draw was issued.
   */
  public render(renderer: RendererLike | null): boolean {
    if (renderer === null) return false;
    if (this.alive === 0) return false;

    const structural = renderer as unknown as {
      drawParticles?(system: ParticleSystem): void;
      render?(scene: unknown, camera: unknown, overrideMaterial?: unknown): void;
    };

    if (typeof structural.drawParticles === 'function') {
      structural.drawParticles(this);
      return true;
    }

    return false;
  }

  /* ------------------------------------------------------------------ events */

  /**
   * Registers a listener.
   *
   * @param event Event name.
   * @param listener Callback.
   * @returns An unsubscribe function.
   */
  public onEvent<K extends keyof ParticleSystemEvents & string>(
    event: K,
    listener: (...args: ParticleSystemEvents[K]) => void,
  ): () => void {
    const emitter = this.events as unknown as EventEmitter<ParticleSystemEvents>;
    return emitter.on(event, listener as never);
  }

  /* ------------------------------------------------------------------ internals */

  /** Marks every attribute as needing an upload. */
  private markAttributesDirty(): void {
    for (const attribute of this.attributes.values()) attribute.needsUpdate = true;
  }

  /** `true` when the system has been disposed. */
  private disposedGuard(): boolean {
    return this.isDisposed;
  }

  /**
   * Re-seeds the emitter from a fresh deterministic stream.
   *
   * @param seed New seed.
   * @returns This system, for chaining.
   */
  public reseed(seed: number): this {
    this.emitter.setSeed(seed);
    return this;
  }

  /**
   * Deterministically randomises a value, for callers that want the same stream.
   *
   * @param seed Stream seed.
   * @returns A random function in `[0, 1)`.
   */
  public static createRandom(seed: number): () => number {
    return seededRandom(seed);
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    const stats = this.getStats();
    return (
      `ParticleSystem(${stats.alive}/${this.maxParticles} alive, ` +
      `rate=${this.emissionRate}, emitting=${this.emitting}, shape=${this.emitter.shape})`
    );
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    this.running = false;
    this.emitting = false;
    this.alive = 0;
    this.freeList.length = 0;
    for (const attribute of this.attributes.values()) attribute.dispose();
    this.attributes.clear();
    this.events.emit('dispose');
    this.events.dispose();
  }
}

/**
 * Convenience factory mirroring `new ParticleSystem(options)`.
 *
 * @param options Capacity, emission, emitter and material configuration.
 * @returns A new particle system.
 */
export function particleSystem(options: ParticleSystemOptions = {}): ParticleSystem {
  return new ParticleSystem(options);
}
