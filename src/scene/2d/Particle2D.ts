/**
 * `Particle2D` - a batched 2D particle emitter.
 *
 * The emitter owns a fixed-capacity pool of particles, so a steady 10k-particle
 * effect allocates nothing after construction. Simulation runs on the CPU and the
 * backend uploads the pool as instanced/point data; a GPU-driven backend can take
 * over by reading {@link Particle2D.particles} directly.
 *
 * Randomness comes from `seededRandom`, so a given seed always produces the same
 * effect - which is what the visual-regression suite relies on.
 *
 * @packageDocumentation
 */

import { seededRandom } from '../../utils/MathUtils';
import { Rect } from '../../math/Rect';
import { Vec2 } from '../../math/Vec2';
import { Node2D } from './Node2D';
import type { Material2DLike, Node2DOptions, Texture2DLike } from './types';

/** One pooled particle. */
export interface Particle2DState {
  /** X position, in the emitter's local space. */
  x: number;
  /** Y position, in the emitter's local space. */
  y: number;
  /** X velocity, in local units per second. */
  vx: number;
  /** Y velocity, in local units per second. */
  vy: number;
  /** Seconds the particle has been alive. */
  age: number;
  /** Total lifetime in seconds. */
  life: number;
  /** Uniform scale multiplier. */
  scale: number;
  /** Rotation in radians. */
  rotation: number;
  /** Angular velocity, in radians per second. */
  angularVelocity: number;
  /** Red tint in `[0, 1]`. */
  r: number;
  /** Green tint in `[0, 1]`. */
  g: number;
  /** Blue tint in `[0, 1]`. */
  b: number;
  /** Opacity multiplier in `[0, 1]`. */
  alpha: number;
  /** Texture frame index, for atlas-based effects. */
  frame: number;
  /** `true` while the particle contributes to the frame. */
  active: boolean;
}

/** Spawn volume shapes understood by {@link Particle2D.spawn}. */
export type EmitterShape2D = 'point' | 'box' | 'circle' | 'cone' | 'edge';

/** Options accepted by the {@link Particle2D} constructor. */
export interface Particle2DOptions extends Node2DOptions {
  /** Pool capacity; defaults to `100`. */
  capacity?: number;
  /** Particles spawned per second; `0` stops continuous emission. */
  rate?: number;
  /** Emits the whole burst in one frame instead of spacing it over `burstInterval`. */
  burstMode?: boolean;
  /** Spawn volume shape. */
  emitterShape?: EmitterShape2D;
  /** Size of the spawn volume, used by `box`, `circle` and `edge`. */
  emitterSize?: Vec2;
  /** Base direction of the emission cone, in radians. */
  direction?: number;
  /** Angular spread of the emission cone, in radians. */
  spread?: number;
  /** Particle speed range, in local units per second. */
  speed?: { min: number; max: number };
  /** Particle lifetime range, in seconds. */
  lifetime?: { min: number; max: number };
  /** Uniform scale range. */
  particleScale?: { min: number; max: number };
  /** Angular velocity range, in radians per second. */
  angularVelocity?: { min: number; max: number };
  /** Downward acceleration applied to every particle. */
  gravity?: number;
  /** Velocity retained per second (`1` keeps momentum, `0` stops instantly). */
  damping?: number;
  /** Texture drawn per particle. */
  texture?: Texture2DLike | null;
  /** Material override. */
  material?: Material2DLike | null;
  /** Seed for the internal PRNG; identical seeds replay identically. */
  seed?: number;
}

/** A batched particle emitter node. */export class Particle2D extends Node2D {
  /** Allows consumers to detect an emitter without an `instanceof` check. */
  public readonly isParticle2D: true = true;

  /** Class name used by serialisation and the backend's dispatch. */
  public override readonly type: string = 'Particle2D';

  /** Particle pool; inactive entries stay in the array so nothing reallocates. */
  public readonly particles: Particle2DState[] = [];

  /** Particles spawned per second. */
  public rate: number;

  /** Emits the whole burst in one update instead of spacing it out. */
  public burstMode: boolean;

  /** Spawn volume shape. */
  public emitterShape: EmitterShape2D;

  /** Size of the spawn volume. */
  public readonly emitterSize: Vec2;

  /** Base direction of the emission cone, in radians. */
  public direction: number;

  /** Angular spread of the emission cone, in radians. */
  public spread: number;

  /** Speed range, in local units per second. */
  public readonly speedMin: number;

  /** Upper bound of the speed range. */
  public readonly speedMax: number;

  /** Lifetime range, in seconds. */
  public readonly lifetimeMin: number;

  /** Upper bound of the lifetime range. */
  public readonly lifetimeMax: number;

  /** Particle scale range. */
  public readonly scaleMin: number;

  /** Upper bound of the scale range. */
  public readonly scaleMax: number;

  /** Angular velocity range, in radians per second. */
  public readonly angularVelocityMin: number;

  /** Upper bound of the angular velocity range. */
  public readonly angularVelocityMax: number;

  /** Downward acceleration applied to every particle. */
  public gravity: number;

  /** Velocity retained per second. */
  public damping: number;

  /** Texture drawn per particle. */
  public texture: Texture2DLike | null;

  /** Material override. */
  public material: Material2DLike | null;

  /** Seed the internal PRNG was created with. */
  public readonly seed: number;

  /** `true` while the emitter is producing particles. */
  public emitting = true;

  /** Spawn accumulator, so low rates still emit one particle per frame. */
  private spawnAccumulator = 0;

  /** Deterministic random source. */
  private readonly random: () => number;

  /** Creates an emitter. */
  constructor(options: Particle2DOptions = {}) {
    super(options);
    const capacity = Math.max(1, options.capacity ?? 100);
    this.rate = options.rate ?? 10;
    this.burstMode = options.burstMode ?? false;
    this.emitterShape = options.emitterShape ?? 'point';
    this.emitterSize = options.emitterSize ? options.emitterSize.clone() : new Vec2(0, 0);
    this.direction = options.direction ?? -Math.PI / 2;
    this.spread = options.spread ?? Math.PI / 8;
    this.speedMin = options.speed?.min ?? 20;
    this.speedMax = options.speed?.max ?? 60;
    this.lifetimeMin = options.lifetime?.min ?? 0.5;
    this.lifetimeMax = options.lifetime?.max ?? 1.5;
    this.scaleMin = options.particleScale?.min ?? 1;
    this.scaleMax = options.particleScale?.max ?? 1;
    this.angularVelocityMin = options.angularVelocity?.min ?? 0;
    this.angularVelocityMax = options.angularVelocity?.max ?? 0;
    this.gravity = options.gravity ?? 0;
    this.damping = options.damping ?? 1;
    this.texture = options.texture ?? null;
    this.material = options.material ?? null;
    this.seed = options.seed ?? 1;
    this.random = seededRandom(this.seed);
    for (let i = 0; i < capacity; i++) this.particles.push(createParticle());
    if (!this.bounds) this.bounds = new Rect(0, 0, 0, 0);
  }

  /** Pool capacity. */
  public get capacity(): number {
    return this.particles.length;
  }

  /** Number of particles currently alive. */
  public get count(): number {
    let alive = 0;
    for (const particle of this.particles) if (particle.active) alive++;
    return alive;
  }

  /** Resumes emission. */
  public start(): this {
    this.emitting = true;
    return this;
  }

  /** Stops emission; particles already alive keep simulating. */
  public stop(): this {
    this.emitting = false;
    return this;
  }

  /** Deactivates every particle. */
  public clearParticles(): this {
    for (const particle of this.particles) particle.active = false;
    this.spawnAccumulator = 0;
    return this;
  }

  /**
   * Emits `count` particles immediately, reusing the oldest slots first.
   *
   * Named `emitParticles` rather than `emit` so it cannot collide with the
   * inherited `TypedEventEmitter.emit`.
   *
   * @param count Number of particles to emit.
   * @returns The number actually emitted, which is capped by the pool capacity.
   */
  public emitParticles(count = 1): number {
    let emitted = 0;
    for (let i = 0; i < count; i++) {
      const particle = this.acquireParticle();
      if (!particle) break;
      this.resetParticle(particle);
      emitted++;
    }
    return emitted;
  }

  /**
   * Advances the simulation.
   *
   * @param delta Seconds elapsed since the previous frame.
   */
  public override update(delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.updateTransform();

    if (this.emitting && this.rate > 0) {
      if (this.burstMode) {
        this.emitParticles(Math.round(this.rate * delta));
      } else {
        this.spawnAccumulator += this.rate * delta;
        while (this.spawnAccumulator >= 1) {
          this.spawnAccumulator -= 1;
          const particle = this.acquireParticle();
          if (!particle) {
            this.spawnAccumulator = 0;
            break;
          }
          this.resetParticle(particle);
        }
      }
    }

    const dampingFactor = Math.pow(this.damping, delta);
    for (const particle of this.particles) {
      if (!particle.active) continue;
      particle.age += delta;
      if (particle.age >= particle.life) {
        particle.active = false;
        continue;
      }
      particle.vy += this.gravity * delta;
      particle.vx *= dampingFactor;
      particle.vy *= dampingFactor;
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      particle.rotation += particle.angularVelocity * delta;
    }

    for (let i = 0; i < this.children.length; i++) this.children[i].update(delta);
  }

  /** Copies the emitter configuration of `source`; live particles are not copied. */
  public override copy(source: Node2D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof Particle2D) {
      this.rate = source.rate;
      this.burstMode = source.burstMode;
      this.emitterShape = source.emitterShape;
      this.emitterSize.copy(source.emitterSize);
      this.direction = source.direction;
      this.spread = source.spread;
      this.gravity = source.gravity;
      this.damping = source.damping;
      this.texture = source.texture;
      this.material = source.material;
      this.emitting = source.emitting;
    }
    return this;
  }

  /** Serialises the emitter alongside the node data. */
  public override toJSON(recursive = true): ReturnType<Node2D['toJSON']> {
    const json = super.toJSON(recursive);
    json.rate = this.rate;
    json.capacity = this.capacity;
    json.count = this.count;
    json.emitterShape = this.emitterShape;
    json.seed = this.seed;
    return json;
  }

  /** Returns a new emitter with the same configuration and seed. */
  public override clone(recursive = true): Particle2D {
    const clone = new Particle2D({
      capacity: this.capacity,
      seed: this.seed,
    });
    clone.copy(this, recursive);
    return clone;
  }

  /** Creates an emitter with the default configuration, used by `clone()`. */
  protected override createInstance(): Node2D {
    return new Particle2D({ seed: this.seed });
  }

  /** Returns the first free pool slot, recycling the oldest one when full. */
  private acquireParticle(): Particle2DState | null {
    if (this.particles.length === 0) return null;
    let oldest: Particle2DState | null = null;
    for (const particle of this.particles) {
      if (!particle.active) return particle;
      if (oldest === null || particle.age > oldest.age) oldest = particle;
    }
    return oldest;
  }

  /** Reseeds one particle from the emitter configuration. */
  private resetParticle(particle: Particle2DState): void {
    const position = this.spawnPosition();
    const speed = this.speedMin + this.random() * (this.speedMax - this.speedMin);
    const angle = this.direction + (this.random() - 0.5) * this.spread;

    particle.x = position.x;
    particle.y = position.y;
    particle.vx = Math.cos(angle) * speed;
    particle.vy = Math.sin(angle) * speed;
    particle.age = 0;
    particle.life = this.lifetimeMin + this.random() * (this.lifetimeMax - this.lifetimeMin);
    particle.scale = this.scaleMin + this.random() * (this.scaleMax - this.scaleMin);
    particle.rotation = this.random() * Math.PI * 2;
    particle.angularVelocity =
      this.angularVelocityMin +
      this.random() * (this.angularVelocityMax - this.angularVelocityMin);
    particle.r = 1;
    particle.g = 1;
    particle.b = 1;
    particle.alpha = 1;
    particle.frame = 0;
    particle.active = true;
  }
  /** Samples a spawn point from the configured volume. */
  private spawnPosition(): { x: number; y: number } {
    const halfWidth = this.emitterSize.x * 0.5;
    const halfHeight = this.emitterSize.y * 0.5;
    switch (this.emitterShape) {
      case 'box':
        return {
          x: (this.random() * 2 - 1) * halfWidth,
          y: (this.random() * 2 - 1) * halfHeight,
        };
      case 'circle': {
        const angle = this.random() * Math.PI * 2;
        const radius = this.random() * halfWidth;
        return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      }
      case 'edge':
        return { x: (this.random() * 2 - 1) * halfWidth, y: 0 };
      case 'cone':
        return { x: 0, y: 0 };
      default:
        return { x: 0, y: 0 };
    }
  }
}

/** Creates an inactive particle slot. */
function createParticle(): Particle2DState {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    age: 0,
    life: 0,
    scale: 1,
    rotation: 0,
    angularVelocity: 0,
    r: 1,
    g: 1,
    b: 1,
    alpha: 1,
    frame: 0,
    active: false,
  };
}

