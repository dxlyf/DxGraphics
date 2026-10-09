/**
 * The DOM-free half of the particles example: presets, projection and the renderable.
 *
 * Everything here is importable from a test with no `document`, no `window` and no canvas.
 * That split is deliberate and was forced by a bug: the example's own sanity check lived
 * in `main.ts`, which touches the DOM at module scope, so the test could not import it and
 * instead *reimplemented* it. The two copies then disagreed — the test used
 * `stopEmitting()` while the example used `stop()`, so the example threw
 * `particles outlived their lifetime` in the browser while a green test suite insisted the
 * check passed. Shared code cannot drift; duplicated code always eventually does.
 *
 * `main.ts` keeps only the DOM, the input handling and the frame loop.
 *
 * @packageDocumentation
 */

import { ParticleSystem, Vec3, type Canvas2DPainter, type ParticleSystemOptions, type Renderable2D } from '../../src/index';

import { createGlowSprite, createStreakSprite } from './sprites';

/* -------------------------------------------------------------------------- */
/* Presets                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One emitter configuration, expressed in **world units**.
 *
 * The renderer maps world units to pixels with {@link SCALE}, so a preset is written in the
 * same units the emitter reasons in rather than in pixels.
 */
export interface Preset {
  /** Name shown in the overlay. */
  readonly label: string;
  /** Capacity, emission rate, emitter and material configuration. */
  readonly options: ParticleSystemOptions;
  /** Sprite to draw with. */
  readonly sprite: 'glow' | 'streak';
  /** Blend mode; `'lighter'` accumulates overlaps into a bright core. */
  readonly composite: 'lighter' | 'source-over';
}

/** A narrow upward cone with ballistic gravity: particles arc over and fall back. */
export const fountain: Preset = {
  label: 'fountain',
  sprite: 'glow',
  composite: 'lighter',
  options: {
    maxParticles: 1400,
    emissionRate: 320,
    loop: true,
    seed: 7,
    emitter: {
      shape: 'cone',
      direction: new Vec3(0, 1, 0),
      spread: 0.32,
      coneRadius: 0.12,
      coneHeight: 5,
      speed: { min: 3.4, max: 5.2 },
      lifetime: { min: 1.5, max: 2.8 },
      size: { min: 0.1, max: 0.24 },
      // Particles shrink as they die, so the plume tapers.
      endSize: { min: 0.02, max: 0.06 },
      color: ['#fff3c4', '#ffb347'],
      endColor: ['#ff5f2e', '#3a0d0d'],
      rotation: { min: 0, max: Math.PI * 2 },
      angularVelocity: { min: -1.2, max: 1.2 },
      gravity: new Vec3(0, -5.4, 0),
      drag: 0.35,
    },
  },
};

/** Slow rising smoke above a ring source, spreading outward. */
export const smoke: Preset = {
  label: 'smoke',
  sprite: 'glow',
  // Not additive: smoke should occlude, not glow.
  composite: 'source-over',
  options: {
    maxParticles: 900,
    emissionRate: 90,
    loop: true,
    seed: 21,
    emitter: {
      shape: 'circle',
      direction: new Vec3(0, 1, 0),
      spread: 0.9,
      circleRadius: 0.7,
      emitFromEdge: true,
      speed: { min: 0.35, max: 1.1 },
      lifetime: { min: 3.2, max: 6 },
      size: { min: 0.35, max: 0.8 },
      // Smoke *grows* as it rises, the opposite of the fountain's taper.
      endSize: { min: 1.4, max: 2.6 },
      color: ['#4a5568', '#2d3748'],
      endColor: ['#1a202c', '#0b0f14'],
      rotation: { min: 0, max: Math.PI * 2 },
      angularVelocity: { min: -0.6, max: 0.6 },
      gravity: new Vec3(0, 0.35, 0),
      // Heavy drag, so particles decelerate into a drift.
      drag: 1.4,
    },
  },
};

/** A radial burst from a shell: fast, short-lived, additive. */
export const burst: Preset = {
  label: 'burst',
  sprite: 'glow',
  composite: 'lighter',
  options: {
    maxParticles: 1600,
    // Driven by bursts rather than a rate, so the rate is zero.
    emissionRate: 0,
    loop: true,
    seed: 3,
    emitter: {
      shape: 'sphere',
      direction: new Vec3(0, 0, 1),
      spread: Math.PI,
      radius: 0.2,
      emitFromEdge: true,
      burst: 260,
      burstInterval: 1.15,
      speed: { min: 2.6, max: 6.4 },
      lifetime: { min: 0.7, max: 1.6 },
      size: { min: 0.06, max: 0.16 },
      endSize: { min: 0, max: 0.02 },
      color: ['#ffffff', '#8ad4ff'],
      endColor: ['#2b6cff', '#0a1030'],
      gravity: new Vec3(0, -1.2, 0),
      drag: 2.1,
    },
  },
};

/** Crisp fast sparks, drawn as hard-edged streaks rather than soft glows. */
export const sparks: Preset = {
  label: 'sparks',
  sprite: 'streak',
  composite: 'lighter',
  options: {
    maxParticles: 1200,
    emissionRate: 420,
    loop: true,
    seed: 11,
    emitter: {
      shape: 'box',
      direction: new Vec3(0, 1, 0),
      spread: 1.15,
      boxSize: new Vec3(1.6, 0.1, 0),
      emitFromEdge: true,
      speed: { min: 4.5, max: 9.5 },
      lifetime: { min: 0.25, max: 0.7 },
      size: { min: 0.05, max: 0.13 },
      endSize: { min: 0.01, max: 0.03 },
      color: ['#fffbe6', '#ffd166'],
      endColor: ['#ff7b00', '#7a2b00'],
      angularVelocity: { min: -8, max: 8 },
      gravity: new Vec3(0, -12, 0),
      drag: 0.6,
    },
  },
};

/** Every preset, in key order. */
export const PRESETS: readonly Preset[] = [fountain, smoke, burst, sparks];

/* -------------------------------------------------------------------------- */
/* Projection                                                                 */
/* -------------------------------------------------------------------------- */

/** World units to logical pixels. */
export const SCALE = 46;

/** Fraction of the canvas height the world origin sits at. */
export const ORIGIN_Y_FRACTION = 0.78;

/**
 * Projects a world-space particle position to canvas coordinates.
 *
 * A plain orthographic mapping with the origin at the bottom centre, so `+Y` is up — the
 * convention the emitters' gravity vectors assume. The example deliberately does not go
 * through a 3D camera: a particle system is often drawn in screen space, and keeping the
 * transform trivial keeps the focus on the simulation.
 *
 * @param x World x.
 * @param y World y.
 * @param width Canvas width in logical pixels.
 * @param height Canvas height in logical pixels.
 * @returns Screen coordinates.
 */
export function toScreen(x: number, y: number, width: number, height: number): { x: number; y: number } {
  return { x: width / 2 + x * SCALE, y: height * ORIGIN_Y_FRACTION - y * SCALE };
}

/**
 * The inverse of {@link toScreen}, for turning a pointer position into an emitter origin.
 *
 * @param screenX Pointer x in logical pixels, relative to the canvas.
 * @param screenY Pointer y in logical pixels, relative to the canvas.
 * @param width Canvas width in logical pixels.
 * @param height Canvas height in logical pixels.
 * @returns World coordinates.
 */
export function toWorld(screenX: number, screenY: number, width: number, height: number): { x: number; y: number } {
  return { x: (screenX - width / 2) / SCALE, y: (height * ORIGIN_Y_FRACTION - screenY) / SCALE };
}

/* -------------------------------------------------------------------------- */
/* The renderable                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Draws one `ParticleSystem` through a Canvas2D painter.
 *
 * It satisfies the renderer's `Renderable2D` contract, so the renderer submits it like any
 * other object and calls `render(painter)` once per frame.
 */
export class ParticleRenderer implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  /** Particles drawn in the most recent frame. */
  public drawn = 0;

  /** Shortest and longest drawn edge in pixels, for the overlay. */
  public minEdge = 0;
  public maxEdge = 0;

  /**
   * Tinted sprite cache, keyed by the quantised colour.
   *
   * The base sprite is white, so a particle's colour has to come from a tinted copy.
   * Rasterising one per particle per frame would create a canvas per particle; quantising
   * each channel to 16 levels bounds the key space, and in practice a colour ramp only
   * visits a few dozen of them.
   */
  private readonly spriteCache = new Map<number, HTMLCanvasElement | null>();

  /** Tints used during the last frame. */
  private readonly tintsUsed = new Set<number>();

  /** Base sprite for the current preset. */
  private sprite: HTMLCanvasElement | null = null;

  /**
   * @param system The simulation to draw.
   * @param preset Preset supplying the sprite kind and blend mode.
   */
  public constructor(
    public system: ParticleSystem,
    private preset: Preset,
  ) {}

  /** Number of distinct sprite tints the last frame used. */
  public get tintCount(): number {
    return this.tintsUsed.size;
  }

  /** Rasterises the current preset's base sprite. Call once the DOM exists. */
  public prepare(): void {
    this.spriteCache.clear();
    this.tintsUsed.clear();
    // White, so a tint can be multiplied over it; a pre-tinted base would make the
    // per-particle colour ramp impossible.
    this.sprite =
      this.preset.sprite === 'streak'
        ? createStreakSprite({ r: 255, g: 255, b: 255 })
        : createGlowSprite({ r: 255, g: 255, b: 255 }, 0.9);
  }

  /**
   * Swaps the simulation and sprite when the preset changes.
   *
   * @param system New simulation to draw.
   * @param preset New preset.
   */
  public setPreset(system: ParticleSystem, preset: Preset): void {
    this.system = system;
    this.preset = preset;
    this.prepare();
  }

  /**
   * Returns a sprite tinted to `(r, g, b)`, rasterising it on first use.
   *
   * The tint is multiplied into the sprite rather than applied with a composite operation,
   * because `globalCompositeOperation` is reserved for the preset's blend mode: `'lighter'`
   * is what makes overlapping particles accumulate.
   *
   * @param r Red in `0..1`.
   * @param g Green in `0..1`.
   * @param b Blue in `0..1`.
   * @returns The sprite, or `null` when no 2D context is available.
   */
  private tintedSprite(r: number, g: number, b: number): HTMLCanvasElement | null {
    const source = this.sprite;
    if (source === null) return null;

    const quantise = (value: number): number => Math.max(1, Math.min(16, Math.round((value || 0) * 16)));
    const key = (quantise(r) << 8) | (quantise(g) << 4) | quantise(b);
    this.tintsUsed.add(key);

    const cached = this.spriteCache.get(key);
    if (cached !== undefined) return cached;

    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d');
    if (context === null) {
      this.spriteCache.set(key, null);
      return null;
    }

    // Draw the white glow, then multiply the colour over it. `multiply` leaves alpha
    // untouched, so the radial falloff survives the tint.
    context.drawImage(source, 0, 0);
    context.globalCompositeOperation = 'multiply';
    context.fillStyle = `rgb(${quantise(r) * 16}, ${quantise(g) * 16}, ${quantise(b) * 16})`;
    context.fillRect(0, 0, canvas.width, canvas.height);

    this.spriteCache.set(key, canvas);
    return canvas;
  }

  /**
   * Draws every live particle.
   *
   * @param painter The renderer's `Canvas2DPainter`.
   */
  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    const context = p.getContext();
    if (!context) return;

    const ratio = window.devicePixelRatio || 1;
    const width = context.canvas.width / ratio;
    const height = context.canvas.height / ratio;
    if (width <= 0 || height <= 0) return;

    // The renderer applied the 2D camera transform. This scene owns its own projection, so
    // paint in raw logical pixels instead.
    p.resetTransform();
    p.setTransform(ratio, 0, 0, ratio, 0, 0);

    // Fade the previous frame instead of clearing it, so particles leave a short trail. A
    // full clear makes fast particles strobe; a partial fade is what gives the fountain its
    // heat haze.
    p.globalCompositeOperation = 'source-over';
    p.globalAlpha = 1;
    p.fillStyle = 'rgba(8, 10, 16, 0.28)';
    p.fillRect(0, 0, width, height);

    const system = this.system;
    if (this.sprite === null) return;

    const alive = system.getAliveCount();
    const positions = system.getPositionAttribute().array;
    const sizes = system.getSizeAttribute().array;
    const rotations = system.getRotationAttribute().array;
    const colors = system.getColorAttribute().array;
    // `life` carries two components: `life01` (remaining fraction) and `remaining`
    // (seconds). The fade uses the fraction.
    const lifeAttribute = system.getAttribute('life');
    if (lifeAttribute === undefined) return;
    const lifes = lifeAttribute.array;

    p.globalCompositeOperation = this.preset.composite;
    this.tintsUsed.clear();

    let minEdge = Infinity;
    let maxEdge = 0;

    // Live particles are contiguous at the front of the buffers.
    for (let slot = 0; slot < alive; slot++) {
      const size = sizes[slot];
      const edge = Math.max(1, size * SCALE);
      if (edge < minEdge) minEdge = edge;
      if (edge > maxEdge) maxEdge = edge;

      // Fade by the remaining life fraction, squared. A linear fade leaves a visible pop at
      // the instant the particle is killed.
      const life01 = lifes[slot * 2];
      const alpha = life01 * life01;
      if (alpha <= 0.004) continue;

      const sprite = this.tintedSprite(colors[slot * 4], colors[slot * 4 + 1], colors[slot * 4 + 2]);
      if (sprite === null) continue;

      const point = toScreen(positions[slot * 3], positions[slot * 3 + 1], width, height);

      p.save();
      p.globalAlpha = Math.min(1, alpha);
      p.translate(point.x, point.y);
      // A soft glow is rotationally symmetric, so rotating it only costs a transform.
      const angle = rotations[slot];
      if (angle !== 0 && this.preset.sprite === 'streak') p.rotate(angle);

      if (this.preset.sprite === 'streak') {
        // Elongated across the particle's radius, so it reads as motion along its axis.
        p.drawImage(sprite, { dx: -edge * 0.5, dy: -edge * 2, dw: edge, dh: edge * 4 });
      } else {
        p.drawImage(sprite, { dx: -edge * 0.5, dy: -edge * 0.5, dw: edge, dh: edge });
      }
      p.restore();
    }

    p.globalAlpha = 1;
    p.globalCompositeOperation = 'source-over';

    this.drawn = alive;
    this.minEdge = Number.isFinite(minEdge) ? minEdge : 0;
    this.maxEdge = maxEdge;
  }
}

/* -------------------------------------------------------------------------- */
/* Headless sanity check of the simulation                                    */
/* -------------------------------------------------------------------------- */

/**
 * A small, fast emitter used by {@link verifySimulation}.
 *
 * 0.5 s lifetime at 120/s into a 64-slot pool: long enough to fill, short enough that the
 * whole check runs in a couple of milliseconds.
 *
 * @returns A fresh auto-started system.
 */
export function createProbeSystem(): ParticleSystem {
  return new ParticleSystem({
    maxParticles: 64,
    emissionRate: 120,
    seed: 5,
    emitter: {
      shape: 'sphere',
      radius: 1,
      speed: { min: 1, max: 2 },
      lifetime: { min: 0.5, max: 0.5 },
      size: { min: 0.1, max: 0.1 },
      gravity: new Vec3(0, -10, 0),
    },
  });
}

/**
 * Runs the simulation through emission, overload and drain, and throws on the first
 * inconsistency.
 *
 * This lives here rather than inline in `main.ts` so a test can run **the same function**
 * the page runs. It is deliberately not a test-only helper: a broken emitter or a leaking
 * pool is invisible on screen — you just see fewer particles than you expect — so the
 * example checks itself at load, and `tests/unit/examples-particles.test.ts` checks that
 * this check passes.
 *
 * @returns A short human-readable summary, for the console.
 * @throws When emission produces nothing, the pool overflows, a particle outlives its
 *   lifetime, or the spawn/kill accounting does not balance.
 */
export function verifySimulation(): string {
  const probe = createProbeSystem();
  try {
    // 30 frames at 1/60 s is 0.5 s, and at 120/s that is about 60 particles.
    for (let frame = 0; frame < 30; frame++) probe.update(1 / 60);
    const afterEmission = probe.getAliveCount();
    if (afterEmission <= 0) {
      throw new Error(`particle emission produced nothing: ${afterEmission} alive after 0.5 s at 120/s`);
    }
    if (afterEmission > probe.maxParticles) {
      throw new Error(`the pool overflowed: ${afterEmission} alive with capacity ${probe.maxParticles}`);
    }

    // Stop emitting and let the lifetimes expire. A pool that leaks shows up here.
    //
    // `stopEmitting()`, not `stop()`: `stop()` freezes the whole simulation, so the live
    // particles would sit at their current age forever and this check would fail on a
    // perfectly healthy pool. Turning the tap off while the clock keeps running is exactly
    // the distinction between the two methods.
    probe.stopEmitting();
    for (let frame = 0; frame < 120; frame++) probe.update(1 / 60);
    const afterDrain = probe.getAliveCount();
    if (afterDrain !== 0) {
      throw new Error(
        `particles outlived their lifetime: ${afterDrain} still alive 1.5 s after a 0.5 s lifetime`,
      );
    }

    const stats = probe.getStats();
    if (stats.spawned <= 0 || stats.killed < stats.spawned) {
      throw new Error(`unbalanced pool accounting: spawned ${stats.spawned}, killed ${stats.killed}`);
    }

    return `${stats.spawned} spawned, all ${stats.killed} drained, capacity ${stats.capacity}`;
  } finally {
    probe.dispose();
  }
}
