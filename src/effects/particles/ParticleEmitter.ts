/**
 * `ParticleEmitter` — where particles are born and what they are born with.
 *
 * An emitter is a *distribution*: it answers "give me a position inside this shape" and
 * "give me an initial velocity, size, colour, rotation and lifetime". Keeping that separate
 * from the system that owns the buffer is what lets one emitter drive many systems, and what
 * makes the shapes and ranges unit-testable in isolation.
 *
 * ## Shapes
 *
 * | Shape | Region | `emitFromEdge` |
 * | --- | --- | --- |
 * | `point` | the origin exactly | n/a |
 * | `sphere` | `|p - origin| <= radius` | on the surface |
 * | `circle` | the `xy` disc, `z === 0` | on the rim |
 * | `box` | inside the half-extent box | on the surface |
 * | `cone` | inside a cone of `coneRadius`/`coneHeight` around `direction` | on the lateral surface |
 *
 * Every sampler is guaranteed to return a point **inside** the documented region, which is
 * the property the test suite asserts: a `circle` sampler never returns a non-zero `z`, a
 * `sphere` sampler never exceeds its radius, and a `box` sampler never leaves its extents.
 *
 * ## Ranges and the seeded random
 *
 * Every initial property is a `RangeValue` — a number, or a `{ min, max }` pair — resolved
 * through {@link ParticleEmitter.resolveRange}. When `seed` is set, all sampling uses
 * `seededRandom`, so the same seed and the same call order produce the same particles. That
 * is what makes a particle test deterministic instead of flaky.
 *
 * ```ts
 * const emitter = new ParticleEmitter({ shape: 'sphere', radius: 2, speed: { min: 1, max: 3 } });
 * emitter.setSeed(42);
 * emitter.samplePosition();     // inside the sphere
 * emitter.sampleVelocity();     // along direction +/- spread, scaled into [1, 3]
 * ```
 *
 * @packageDocumentation
 */

import { Color } from '../../math/Color';
import { Quat } from '../../math/Quat';
import { Vec2 } from '../../math/Vec2';
import { Vec3 } from '../../math/Vec3';
import { clamp, clamp01, seededRandom } from '../../utils/MathUtils';
import type {
  ColorRangeValue,
  ParticleEmitterOptions,
  ParticleShape,
  RangeValue,
} from '../types';

/**
 * A particle emission distribution.
 */
export class ParticleEmitter {
  /** Emission shape. */
  public shape: ParticleShape;

  /** Emitter origin in its own space. */
  public readonly position: Vec3;

  /** Initial direction; the cone's axis and the velocity's mean. */
  public readonly direction: Vec3;

  /** Cone half-angle in radians. */
  public spread: number;

  /** Sphere/circle radius. */
  public radius: number;

  /** Circle radius. */
  public circleRadius: number;

  /** Box half-extents. */
  public readonly boxSize: Vec3;

  /** Cone height. */
  public coneHeight: number;

  /** Cone base radius. */
  public coneRadius: number;

  /** `true` spawns on the shape's surface rather than inside its volume. */
  public emitFromEdge: boolean;

  /** Particles per second. */
  public rate: number;

  /** Particles released in one burst. */
  public burst: number;

  /** Seconds between bursts; `0` disables bursting. */
  public burstInterval: number;

  /** Initial speed range. */
  public speed: RangeValue;

  /** Particle lifetime range in seconds. */
  public lifetime: RangeValue;

  /** Initial size range. */
  public size: RangeValue;

  /** Final size range. */
  public endSize: RangeValue;

  /** Initial colour range. */
  public color: [Color, Color];

  /** Final colour range. */
  public endColor: [Color, Color];

  /** Initial rotation range in radians. */
  public rotation: RangeValue;

  /** Angular velocity range in radians per second. */
  public angularVelocity: RangeValue;

  /** Gravity in world units per second squared. */
  public readonly gravity: Vec3;

  /** Linear drag coefficient. */
  public drag: number;

  /** `true` treats velocities as world-space. */
  public worldSpace: boolean;

  /** Seed for the deterministic random source. */
  public seed: number;

  /** Deterministic random source. */
  private random: () => number;

  /**
   * Creates an emitter.
   *
   * @param options Shape, rates and initial-property ranges.
   */
  constructor(options: ParticleEmitterOptions = {}) {
    this.shape = options.shape ?? 'point';
    this.position = options.position !== undefined ? Vec3.from(options.position) : new Vec3();
    this.direction = options.direction !== undefined ? Vec3.from(options.direction) : new Vec3(0, 1, 0);
    this.direction.normalize();

    this.spread = clamp(options.spread ?? 0.25, 0, Math.PI);
    this.radius = Math.max(0, options.radius ?? options.sphereRadius ?? 1);
    this.circleRadius = Math.max(0, options.circleRadius ?? this.radius);
    this.boxSize = options.boxSize !== undefined ? Vec3.from(options.boxSize) : new Vec3(1, 1, 1);
    this.coneHeight = Math.max(0, options.coneHeight ?? 1);
    this.coneRadius = Math.max(0, options.coneRadius ?? this.radius);
    this.emitFromEdge = options.emitFromEdge ?? false;

    this.rate = Math.max(0, options.rate ?? 10);
    this.burst = Math.max(0, Math.floor(options.burst ?? 0));
    this.burstInterval = Math.max(0, options.burstInterval ?? 0);

    this.speed = options.speed ?? 0;
    this.lifetime = options.lifetime ?? { min: 1, max: 1 };
    this.size = options.size ?? { min: 1, max: 1 };
    this.endSize = options.endSize ?? this.size;
    this.color = toColorRange(options.color, 0xffffff);
    this.endColor = toColorRange(options.endColor ?? options.color, 0xffffff);
    this.rotation = options.rotation ?? 0;
    this.angularVelocity = options.angularVelocity ?? 0;
    this.gravity = options.gravity !== undefined ? Vec3.from(options.gravity) : new Vec3();
    this.drag = Math.max(0, options.drag ?? 0);
    this.worldSpace = options.worldSpace ?? false;

    this.seed = options.seed ?? 1;
    this.random = seededRandom(this.seed);
  }

  /* ------------------------------------------------------------------- random */

  /**
   * Re-seeds the random source.
   *
   * @param seed New seed.
   * @returns This emitter, for chaining.
   */
  public setSeed(seed: number): this {
    this.seed = seed;
    this.random = seededRandom(seed);
    return this;
  }

  /**
   * Restarts the random stream from the current seed.
   *
   * @returns This emitter, for chaining.
   */
  public resetRandom(): this {
    this.random = seededRandom(this.seed);
    return this;
  }

  /**
   * A random number in `[0, 1)`.
   *
   * @returns The sample.
   */
  public nextRandom(): number {
    return this.random();
  }

  /* ------------------------------------------------------------------ ranges */

  /**
   * Resolves a range to a concrete value.
   *
   * A bare number is returned unchanged (so a fixed property costs no random draw, which
   * keeps a seeded stream reproducible when unrelated properties change); an object is
   * sampled uniformly.
   *
   * @param value Range or number.
   * @param random Random source; defaults to the emitter's.
   * @returns The sampled value.
   */
  public static resolveRange(value: RangeValue, random: () => number = Math.random): number {
    if (typeof value === 'number') return value;
    return value.min + random() * (value.max - value.min);
  }

  /**
   * Instance form of {@link ParticleEmitter.resolveRange}.
   *
   * @param value Range or number.
   * @returns The sampled value.
   */
  public resolve(value: RangeValue): number {
    return ParticleEmitter.resolveRange(value, this.random);
  }

  /**
   * Samples a colour range.
   *
   * @param range Colour pair.
   * @param target Colour to write; a new one is allocated when omitted.
   * @returns `target`.
   */
  public sampleColorRange(range: readonly [Color, Color], target: Color = new Color()): Color {
    const t = this.random();
    return target.copy(range[0]).lerp(range[1], t);
  }

  /* ----------------------------------------------------------------- samples */

  /**
   * Samples a spawn position.
   *
   * @param target Vector to write; a new one is allocated when omitted.
   * @param random Random source; defaults to the emitter's.
   * @returns `target`, strictly inside the shape's documented region.
   */
  public samplePosition(target: Vec3 = new Vec3(), random: () => number = this.random): Vec3 {
    const r = random;
    const origin = this.position;

    switch (this.shape) {
      case 'sphere': {
        const radius = this.radius;
        if (radius <= 0) return target.copy(origin);

        // A uniform direction from a normalised Gaussian triple, then a radius that is
        // uniform over the *volume* (`cbrt`), not over the radius — sampling `radius * r`
        // would cluster points at the centre.
        const dir = randomUnitVector(r);
        const scale = this.emitFromEdge ? radius : radius * Math.cbrt(clamp01(r()));
        return target.copy(origin).addScaledVector(dir, scale);
      }

      case 'circle': {
        const radius = this.circleRadius;
        if (radius <= 0) return target.set(origin.x, origin.y, 0);

        // Uniform over the disc: `sqrt` on the radius, and `z` is exactly zero.
        const theta = r() * Math.PI * 2;
        const scale = this.emitFromEdge ? radius : radius * Math.sqrt(clamp01(r()));
        return target.set(origin.x + Math.cos(theta) * scale, origin.y + Math.sin(theta) * scale, 0);
      }

      case 'box': {
        const halfX = Math.abs(this.boxSize.x);
        const halfY = Math.abs(this.boxSize.y);
        const halfZ = Math.abs(this.boxSize.z);

        const pick = (extent: number): number => {
          if (extent <= 0) return 0;
          if (!this.emitFromEdge) return (r() * 2 - 1) * extent;
          // On the surface: choose an axis, then a sign, then place within the face.
          const sign = r() < 0.5 ? -1 : 1;
          return sign * extent;
        };

        let x = pick(halfX);
        let y = pick(halfY);
        let z = pick(halfZ);

        if (this.emitFromEdge) {
          // Exactly one coordinate must sit on a face; force the others inside.
          const axis = Math.min(2, Math.floor(r() * 3));
          if (axis === 0) x = (r() < 0.5 ? -1 : 1) * halfX;
          else if (axis === 1) y = (r() < 0.5 ? -1 : 1) * halfY;
          else z = (r() < 0.5 ? -1 : 1) * halfZ;
          if (axis !== 0) x = (r() * 2 - 1) * halfX;
          if (axis !== 1) y = (r() * 2 - 1) * halfY;
          if (axis !== 2) z = (r() * 2 - 1) * halfZ;
        }

        return target.set(origin.x + x, origin.y + y, origin.z + z);
      }

      case 'cone': {
        const height = this.coneHeight;
        const baseRadius = this.coneRadius;
        if (height <= 0 || baseRadius <= 0) return target.copy(origin);

        // Build in a local frame where `+Y` is the cone axis, then orient to `direction`.
        const frame = coneFrame(this.direction);

        const t = this.emitFromEdge ? 1 : Math.sqrt(clamp01(r()));
        const theta = r() * Math.PI * 2;
        const localRadius = baseRadius * t;
        const localHeight = height * t;

        const local = new Vec3(
          Math.cos(theta) * localRadius,
          localHeight,
          Math.sin(theta) * localRadius,
        );

        // Rotate the local frame's `+Y` onto `direction`.
        const rotated = applyFrame(frame, local);
        return target.copy(origin).add(rotated);
      }

      case 'point':
      default:
        return target.copy(origin);
    }
  }

  /**
   * Samples an initial velocity.
   *
   * The direction is `direction` perturbed within `spread`, scaled by a speed from
   * {@link ParticleEmitter.speed}.
   *
   * @param target Vector to write.
   * @param random Random source; defaults to the emitter's.
   * @returns `target`.
   */
  public sampleVelocity(target: Vec3 = new Vec3(), random: () => number = this.random): Vec3 {
    const speed = ParticleEmitter.resolveRange(this.speed, random);

    // Sample a direction inside a cone of half-angle `spread` about `direction`. Using a
    // cosine distribution over the cap would be more physical; a uniform angle is more
    // predictable for art direction, which is what a particle system wants.
    const cosSpread = Math.cos(this.spread);
    const cosTheta = cosSpread + random() * (1 - cosSpread);
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = random() * Math.PI * 2;

    const frame = coneFrame(this.direction);
    const local = new Vec3(Math.cos(phi) * sinTheta, cosTheta, Math.sin(phi) * sinTheta);
    const direction = applyFrame(frame, local).normalize();

    return target.copy(direction).multiplyScalar(speed);
  }

  /**
   * Samples a particle size.
   *
   * @param random Random source; defaults to the emitter's.
   * @returns The size.
   */
  public sampleSize(random: () => number = this.random): number {
    return ParticleEmitter.resolveRange(this.size, random);
  }

  /**
   * Samples a final size.
   *
   * @param random Random source; defaults to the emitter's.
   * @returns The end size.
   */
  public sampleEndSize(random: () => number = this.random): number {
    return ParticleEmitter.resolveRange(this.endSize, random);
  }

  /**
   * Samples a lifetime.
   *
   * @param random Random source; defaults to the emitter's.
   * @returns The lifetime in seconds, at least `0.01`.
   */
  public sampleLifetime(random: () => number = this.random): number {
    return Math.max(0.01, ParticleEmitter.resolveRange(this.lifetime, random));
  }

  /**
   * Samples an initial rotation.
   *
   * @param random Random source; defaults to the emitter's.
   * @returns The rotation in radians.
   */
  public sampleRotation(random: () => number = this.random): number {
    return ParticleEmitter.resolveRange(this.rotation, random);
  }

  /**
   * Samples an angular velocity.
   *
   * @param random Random source; defaults to the emitter's.
   * @returns The angular velocity in radians per second.
   */
  public sampleAngularVelocity(random: () => number = this.random): number {
    return ParticleEmitter.resolveRange(this.angularVelocity, random);
  }

  /**
   * Samples an initial colour.
   *
   * @param target Colour to write.
   * @param random Random source; defaults to the emitter's.
   * @returns `target`.
   */
  public sampleColor(target: Color = new Color(), random: () => number = this.random): Color {
    const t = random();
    return target.copy(this.color[0]).lerp(this.color[1], t);
  }

  /**
   * Samples a final colour.
   *
   * @param target Colour to write.
   * @param random Random source; defaults to the emitter's.
   * @returns `target`.
   */
  public sampleEndColor(target: Color = new Color(), random: () => number = this.random): Color {
    const t = random();
    return target.copy(this.endColor[0]).lerp(this.endColor[1], t);
  }

  /* ------------------------------------------------------------------ helpers */

  /**
   * The number of particles to emit for a time step.
   *
   * @param delta Seconds since the previous step.
   * @param accumulator Carry-over from the previous step; the caller keeps the returned
   *   remainder.
   * @param rate Particles per second to use. Defaults to this emitter's own {@link rate};
   *   a `ParticleSystem` passes its `emissionRate` here, because otherwise that setting is
   *   silently ignored.
   * @returns The whole-particle count and the new accumulator.
   */
  public computeEmission(
    delta: number,
    accumulator: number,
    rate: number = this.rate,
  ): { count: number; accumulator: number } {
    const wanted = accumulator + Math.max(0, rate) * Math.max(0, delta);
    const count = Math.floor(wanted);
    return { count, accumulator: wanted - count };
  }

  /**
   * A copy of this emitter.
   *
   * @returns A new emitter with the same configuration and a fresh random stream.
   */
  public clone(): ParticleEmitter {
    return new ParticleEmitter({
      shape: this.shape,
      position: this.position.clone(),
      direction: this.direction.clone(),
      spread: this.spread,
      radius: this.radius,
      circleRadius: this.circleRadius,
      boxSize: this.boxSize.clone(),
      coneHeight: this.coneHeight,
      coneRadius: this.coneRadius,
      emitFromEdge: this.emitFromEdge,
      rate: this.rate,
      burst: this.burst,
      burstInterval: this.burstInterval,
      speed: this.speed,
      lifetime: this.lifetime,
      size: this.size,
      endSize: this.endSize,
      color: [this.color[0].clone(), this.color[1].clone()],
      endColor: [this.endColor[0].clone(), this.endColor[1].clone()],
      rotation: this.rotation,
      angularVelocity: this.angularVelocity,
      gravity: this.gravity.clone(),
      drag: this.drag,
      worldSpace: this.worldSpace,
      seed: this.seed,
    });
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return (
      `ParticleEmitter(${this.shape}, rate=${this.rate}, burst=${this.burst}, ` +
      `speed=${typeof this.speed === 'number' ? this.speed : `${this.speed.min}..${this.speed.max}`})`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** A uniform random unit vector, from a normalised Gaussian triple (Marsaglia). */
function randomUnitVector(random: () => number): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  let lengthSquared = 0;

  do {
    // Box-Muller on two uniforms gives a normal pair; the third component comes from a
    // second pair. Rejection is not needed because a normal triple is isotropic.
    const u1 = Math.max(1e-12, random());
    const u2 = random();
    const u3 = Math.max(1e-12, random());
    const u4 = random();

    const r1 = Math.sqrt(-2 * Math.log(u1));
    const r2 = Math.sqrt(-2 * Math.log(u3));

    x = r1 * Math.cos(2 * Math.PI * u2);
    y = r1 * Math.sin(2 * Math.PI * u2);
    z = r2 * Math.cos(2 * Math.PI * u4);

    const w = r2 * Math.sin(2 * Math.PI * u4);
    lengthSquared = x * x + y * y + z * z + w * w;
  } while (!(lengthSquared > 1e-12));

  const inverse = 1 / Math.sqrt(lengthSquared);
  return new Vec3(x * inverse, y * inverse, z * inverse);
}

/** An orthonormal frame whose `+Y` is aligned with `axis`. */
function coneFrame(axis: Vec3): { right: Vec3; up: Vec3; forward: Vec3 } {
  const up = axis.clone().normalize();
  const reference = Math.abs(up.y) > 0.999 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);

  const right = new Vec3().crossVectors(reference, up).normalize();
  const forward = new Vec3().crossVectors(up, right).normalize();

  return { right, up, forward };
}

/** Expresses a point given in a `+Y`-up frame in world space. */
function applyFrame(frame: { right: Vec3; up: Vec3; forward: Vec3 }, local: Vec3): Vec3 {
  return new Vec3()
    .addScaledVector(frame.right, local.x)
    .addScaledVector(frame.up, local.y)
    .addScaledVector(frame.forward, local.z);
}

/** Normalises a colour range into a `[Color, Color]` pair. */
function toColorRange(value: ColorRangeValue | undefined, fallback: number): [Color, Color] {
  if (value === undefined) {
    const color = Color.from(fallback);
    return [color, color.clone()];
  }

  if (Array.isArray(value)) {
    const first = Color.from(value[0]);
    const second = Color.from(value[1]);
    return [first, second];
  }

  const single = Color.from(value as number | string | Color);
  return [single, single.clone()];
}

/**
 * Convenience factory mirroring `new ParticleEmitter(options)`.
 *
 * @param options Shape, rates and initial-property ranges.
 * @returns A new emitter.
 */
export function particleEmitter(options: ParticleEmitterOptions = {}): ParticleEmitter {
  return new ParticleEmitter(options);
}

/** Re-exported so a caller can build a `Quat`-aligned cone without a second import. */
export type { Quat, Vec2 };
