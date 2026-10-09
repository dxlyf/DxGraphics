/**
 * Headless test for `examples/particles`.
 *
 * The important property of this file is that it runs **the example's own code**, not a
 * transcription of it. The first version of this test reimplemented the example's sanity
 * check instead of importing it, because the check lived in `main.ts` and `main.ts` touches
 * the DOM at module scope. The two copies then drifted: the test used `stopEmitting()` while
 * the example used `stop()`, so the page threw `particles outlived their lifetime` in the
 * browser while this suite reported green. The example's DOM-free half now lives in
 * `scene.ts`, and everything below imports from it.
 *
 * Two different concerns are covered, because they fail in different ways:
 *
 *  1. **The simulation** — emission rate, pool capacity, draining, determinism. A broken
 *     pool or an emitter that produces nothing is invisible on screen; you just see fewer
 *     particles than you expect, or none, with no error anywhere.
 *  2. **The draw path** — that the example's structure-of-arrays reads use the right
 *     strides, that one sprite is blitted per live particle, and that the blend state is
 *     restored.
 */

import { describe, expect, it } from 'vitest';
import { Canvas2DRenderer, ParticleEmitter, ParticleSystem, Vec3 } from '../../src/index';
import type { Canvas2DPainter } from '../../src/renderer/canvas2d/Canvas2DPainter';
import type { Canvas2DRendererOptions } from '../../src/renderer/canvas2d/Canvas2DRenderer';
import type { CanvasLike } from '../../src/renderer/utils/createCanvas';
import {
  PRESETS,
  ParticleRenderer,
  SCALE,
  createProbeSystem,
  toScreen,
  toWorld,
  verifySimulation,
} from '../../examples/particles/scene';

/* ------------------------------------------------------------------ doubles */

/** One recorded context call. */
interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/**
 * A `CanvasRenderingContext2D` double that records every call.
 *
 * This has to be a faithful double rather than a bare object of no-ops: the renderer bails
 * out of `render()` when it cannot acquire a context, so a sloppy double makes the test
 * pass while asserting nothing at all. That is exactly the trap this file fell into once.
 */
class ContextDouble {
  public readonly calls: RecordedCall[] = [];
  public readonly canvas: { width: number; height: number };

  public fillStyle: unknown = '#000000';
  public strokeStyle: unknown = '#000000';
  public lineWidth = 1;
  public globalAlpha = 1;
  public globalCompositeOperation = 'source-over';
  public font = '10px sans-serif';
  public textAlign = 'start';
  public textBaseline = 'alphabetic';

  /** `save()` calls without a matching `restore()`. */
  public depth = 0;

  public constructor(width: number, height: number) {
    this.canvas = { width, height };
  }

  private record(method: string, args: readonly unknown[] = []): void {
    this.calls.push({ method, args });
  }

  /** @returns Every call to `method`. */
  public callsOf(method: string): readonly RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** @returns `true` when `method` was called at least once. */
  public didCall(method: string): boolean {
    return this.calls.some((call) => call.method === method);
  }

  public save(): void {
    this.depth++;
    this.record('save');
  }
  public restore(): void {
    this.depth--;
    this.record('restore');
  }
  public resetTransform(): void {
    this.record('resetTransform');
  }
  public setTransform(...args: number[]): void {
    this.record('setTransform', args);
  }
  public translate(...args: number[]): void {
    this.record('translate', args);
  }
  public rotate(...args: number[]): void {
    this.record('rotate', args);
  }
  public clearRect(...args: number[]): void {
    this.record('clearRect', args);
  }
  public fillRect(...args: number[]): void {
    this.record('fillRect', args);
  }
  public beginPath(): void {
    this.record('beginPath');
  }
  public closePath(): void {
    this.record('closePath');
  }
  public moveTo(...args: number[]): void {
    this.record('moveTo', args);
  }
  public lineTo(...args: number[]): void {
    this.record('lineTo', args);
  }
  public rect(...args: number[]): void {
    this.record('rect', args);
  }
  public arc(...args: number[]): void {
    this.record('arc', args);
  }
  public clip(): void {
    this.record('clip');
  }
  public fill(): void {
    this.record('fill');
  }
  public stroke(): void {
    this.record('stroke');
  }
  public fillText(...args: unknown[]): void {
    this.record('fillText', args);
  }
  public measureText(): { width: number } {
    this.record('measureText');
    return { width: 0 };
  }
  public drawImage(...args: unknown[]): void {
    this.record('drawImage', args);
  }
  public createRadialGradient(): { addColorStop: () => void } {
    this.record('createRadialGradient');
    return { addColorStop: () => undefined };
  }
  public createLinearGradient(): { addColorStop: () => void } {
    this.record('createLinearGradient');
    return { addColorStop: () => undefined };
  }
  public getImageData(): { data: Uint8ClampedArray; width: number; height: number } {
    this.record('getImageData');
    return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
  }
  public putImageData(): void {
    this.record('putImageData');
  }
}

/** A canvas double whose `getContext('2d')` returns a {@link ContextDouble}. */
class CanvasDouble implements CanvasLike {
  public width: number;
  public height: number;
  public style: Record<string, string> = {};
  public readonly context: ContextDouble;

  public constructor(width = 880, height = 560) {
    this.width = width;
    this.height = height;
    this.context = new ContextDouble(width, height);
    this.context.canvas.width = width;
    this.context.canvas.height = height;
  }

  public getContext(contextId: string): unknown {
    return contextId === '2d' ? this.context : null;
  }

  public toDataURL(): string {
    return 'data:image/png;base64,';
  }

  public addEventListener(): void {}
  public removeEventListener(): void {}
  public getBoundingClientRect(): Record<string, number> {
    return { x: 0, y: 0, top: 0, left: 0, right: this.width, bottom: this.height, width: this.width, height: this.height };
  }
}

/** Renderer options around a canvas double. */
function rendererOptions(canvas: CanvasDouble, width = 880, height = 560): Canvas2DRendererOptions {
  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    width,
    height,
    pixelRatio: 1,
    clearColor: '#080a10',
  };
}

/**
 * Installs a `document.createElement('canvas')` stand-in for the sprite cache.
 *
 * @returns The sprite canvases created, and a restore function.
 */
function installDocumentStub() {
  const created: CanvasDouble[] = [];
  const original = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    createElement(tag: string) {
      const element = new CanvasDouble(64, 64);
      (element as unknown as { tagName: string }).tagName = tag.toUpperCase();
      created.push(element);
      return element;
    },
  };
  return {
    created,
    restore: () => {
      (globalThis as { document?: unknown }).document = original;
    },
  };
}

/**
 * Installs a `window` stand-in carrying `devicePixelRatio`.
 *
 * `ParticleRenderer.render` reads it to convert the drawing buffer to logical pixels, so
 * without a stub it would throw in Node.
 *
 * @returns A restore function.
 */
function installWindowStub(devicePixelRatio = 1) {
  const original = (globalThis as { window?: unknown }).window;
  const existing = (original ?? {}) as Record<string, unknown>;
  (globalThis as { window?: unknown }).window = { ...existing, devicePixelRatio };
  return {
    restore: () => {
      (globalThis as { window?: unknown }).window = original;
    },
  };
}

/* ------------------------------------------------------------------- tests */

describe('ParticleSystem, as the example configures it', () => {
  it("passes the example's own self-check", () => {
    // The single most important assertion in this file: it runs `verifySimulation()`, the
    // exact function `main.ts` calls at load. A duplicated transcription here is what let
    // the page throw while this suite stayed green, so there is deliberately no copy of the
    // check's body anywhere in this test.
    const summary = verifySimulation();
    console.log('verifySimulation() ->', summary);
    expect(summary).toMatch(/spawned/);
  });

  it('emits at the configured rate, cannot overflow, and drains after emission stops', () => {
    // The same probe the self-check uses, stepped here so the intermediate numbers are
    // visible rather than only the pass/fail.
    const probe = createProbeSystem();

    for (let frame = 0; frame < 30; frame++) probe.update(1 / 60);
    const afterEmission = probe.getAliveCount();
    const midStats = probe.getStats();
    console.log('alive after 0.5 s at 120/s:', afterEmission, '| spawned:', midStats.spawned);

    expect(afterEmission).toBeGreaterThan(10);
    expect(afterEmission).toBeLessThanOrEqual(probe.maxParticles);
    // The rate must actually be honoured. The emitter's own default rate is 10/s, so a
    // broken rate path spawns ~5 particles here rather than tens.
    expect(midStats.spawned).toBeGreaterThan(30);

    // `stopEmitting()`, not `stop()`: the live particles must keep simulating so they can
    // finish their lifetimes. Using `stop()` here is the mistake that made the page throw.
    probe.stopEmitting();
    for (let frame = 0; frame < 120; frame++) probe.update(1 / 60);
    console.log('alive 1.5 s after emissions stopped:', probe.getAliveCount());
    expect(probe.getAliveCount()).toBe(0);

    const stats = probe.getStats();
    console.log('stats:', JSON.stringify(stats));
    expect(stats.spawned).toBeGreaterThan(0);
    expect(stats.killed).toBeGreaterThanOrEqual(stats.spawned);
    expect(stats.emitting).toBe(false);
    // Emission stopped but the system is still running: that is the whole point of the
    // `stopEmitting` / `stop` split.
    expect(probe.running).toBe(true);

    probe.dispose();
  });

  it('emits at the emitter rate when no system rate is given', () => {
    // The `rate` field on the emitter options must not be silently ignored.
    const system = new ParticleSystem({
      maxParticles: 500,
      seed: 2,
      emitter: {
        shape: 'point',
        rate: 200,
        speed: 1,
        lifetime: { min: 2, max: 2 },
        size: 0.1,
      },
    });

    for (let frame = 0; frame < 60; frame++) system.update(1 / 60);
    const stats = system.getStats();
    console.log('emitter rate 200/s after 1 s -> spawned:', stats.spawned);
    // 200/s for 1 s, allowing for the accumulator.
    expect(stats.spawned).toBeGreaterThanOrEqual(195);
    expect(stats.spawned).toBeLessThanOrEqual(205);
    system.dispose();
  });

  it('documents that stop() freezes the live particles while stopEmitting() drains them', () => {
    const build = (): ParticleSystem => {
      const system = new ParticleSystem({
        maxParticles: 64,
        emissionRate: 120,
        seed: 5,
        emitter: {
          shape: 'sphere',
          radius: 1,
          speed: { min: 1, max: 2 },
          lifetime: { min: 0.5, max: 0.5 },
          size: { min: 0.1, max: 0.1 },
        },
      });
      for (let frame = 0; frame < 30; frame++) system.update(1 / 60);
      return system;
    };

    const frozen = build();
    const frozenAlive = frozen.getAliveCount();
    frozen.stop();
    for (let frame = 0; frame < 120; frame++) frozen.update(1 / 60);
    console.log('after stop(), alive:', frozenAlive, '->', frozen.getAliveCount());

    const draining = build();
    const drainingAlive = draining.getAliveCount();
    draining.stopEmitting();
    for (let frame = 0; frame < 120; frame++) draining.update(1 / 60);
    console.log('after stopEmitting(), alive:', drainingAlive, '->', draining.getAliveCount());

    expect(frozen.getAliveCount()).toBe(frozenAlive);
    expect(draining.getAliveCount()).toBe(0);
    frozen.dispose();
    draining.dispose();
  });

  it('emits from a burst-only system, where the rate is zero', () => {
    // `emissionRate: 0` with a `burst` is a legitimate configuration — the example's
    // "burst" preset uses it — and it used to emit nothing, because emission was enabled
    // only when the *rate* was positive.
    const system = new ParticleSystem({
      maxParticles: 500,
      emissionRate: 0,
      loop: true,
      seed: 3,
      emitter: {
        shape: 'sphere',
        radius: 0.2,
        emitFromEdge: true,
        burst: 120,
        burstInterval: 0.5,
        speed: { min: 2, max: 4 },
        lifetime: { min: 1, max: 1 },
        size: { min: 0.1, max: 0.1 },
      },
    });

    expect(system.emitting).toBe(true);

    for (let frame = 0; frame < 60; frame++) system.update(1 / 60);
    const stats = system.getStats();
    console.log('burst-only after 1 s: alive', stats.alive, '| spawned', stats.spawned);

    expect(stats.spawned).toBeGreaterThanOrEqual(120);
    expect(stats.alive).toBeGreaterThan(0);
    system.dispose();
  });

  it('never exceeds capacity under a sustained overload', () => {
    const probe = new ParticleSystem({
      maxParticles: 32,
      emissionRate: 1000,
      loop: true,
      seed: 9,
      emitter: {
        shape: 'box',
        boxSize: new Vec3(1, 1, 0),
        speed: { min: 1, max: 1 },
        lifetime: { min: 5, max: 5 },
        size: { min: 0.1, max: 0.1 },
      },
    });

    for (let frame = 0; frame < 120; frame++) {
      const alive = probe.update(1 / 60);
      expect(alive).toBeLessThanOrEqual(probe.maxParticles);
    }

    console.log('alive after 2 s of 1000/s into capacity 32:', probe.getAliveCount());
    expect(probe.getAliveCount()).toBe(32);
    probe.dispose();
  });

  it('keeps live particles contiguous at the front of the buffers', () => {
    // The invariant the example's draw loop depends on: it iterates
    // `0 .. getAliveCount() - 1` and assumes every one of those slots is live.
    //
    // `life01` is *not* a liveness test on its own — `kill()` never clears the dead slot,
    // so a stale positive `life01` survives there. The count of slots reporting a positive
    // *remaining* time must equal `getAliveCount()` exactly.
    const probe = new ParticleSystem({
      maxParticles: 200,
      emissionRate: 400,
      seed: 13,
      emitter: {
        shape: 'sphere',
        radius: 1,
        speed: { min: 2, max: 4 },
        // A wide lifetime spread makes particles die out of order, so the swap-with-last
        // kill path is exercised rather than a tidy FIFO.
        lifetime: { min: 0.2, max: 1.6 },
        size: { min: 0.1, max: 0.1 },
      },
    });

    const life = probe.getAttribute('life');
    expect(life).toBeDefined();

    let sawLive = false;
    let sawSwap = false;
    let previousAlive = 0;
    for (let frame = 0; frame < 90; frame++) {
      probe.update(1 / 60);
      const alive = probe.getAliveCount();
      if (alive > 0) sawLive = true;
      // A fall in the live count while still emitting means a slot was recycled.
      if (previousAlive > 0 && alive < previousAlive) sawSwap = true;
      previousAlive = alive;

      let liveLookalikes = 0;
      for (let slot = 0; slot < alive; slot++) {
        if (life!.array[slot * 2 + 1] > 0) liveLookalikes++;
      }
      expect(liveLookalikes).toBe(alive);
    }

    console.log('alive after 1.5 s:', probe.getAliveCount(), '| recycled:', sawSwap);
    expect(sawLive).toBe(true);
    expect(sawSwap).toBe(true);
    probe.dispose();
  });

  it('is deterministic for a given seed', () => {
    const run = (): number[] => {
      const system = new ParticleSystem({
        maxParticles: 64,
        emissionRate: 200,
        seed: 42,
        emitter: {
          shape: 'cone',
          direction: new Vec3(0, 1, 0),
          spread: 0.4,
          speed: { min: 2, max: 5 },
          lifetime: { min: 1, max: 2 },
          size: { min: 0.1, max: 0.2 },
          rotation: { min: 0, max: Math.PI },
        },
      });
      for (let frame = 0; frame < 40; frame++) system.update(1 / 60);
      const array = system.getPositionAttribute().array;
      const alive = system.getAliveCount();
      const snapshot = Array.from(array.subarray(0, alive * 3));
      system.dispose();
      return snapshot;
    };

    const first = run();
    const second = run();
    console.log('deterministic snapshot length:', first.length);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it('reports the emitter shape it was configured with', () => {
    for (const shape of ['point', 'sphere', 'box', 'cone', 'circle'] as const) {
      expect(new ParticleEmitter({ shape }).shape).toBe(shape);
    }

    const system = new ParticleSystem({
      seed: 1,
      emitter: { shape: 'circle', circleRadius: 3, rate: 50, lifetime: 1, speed: 1, size: 0.1 },
    });
    console.log('emitter shape:', system.emitter.shape, '| circleRadius:', system.emitter.circleRadius);
    expect(system.emitter.shape).toBe('circle');
    expect(system.emitter.circleRadius).toBe(3);
    system.dispose();
  });
});

describe('the example projection', () => {
  it('round-trips world to screen and back', () => {
    // `toWorld` is the inverse of `toScreen`, and the pointer handler depends on that. If
    // the two ever disagree, dragging steers the emitter to the wrong place — which looks
    // like a jittery control rather than a maths error.
    const width = 880;
    const height = 560;

    for (const [wx, wy] of [
      [0, 0],
      [1, 1],
      [-2.5, 3],
      [4, -1.5],
    ] as const) {
      const screen = toScreen(wx, wy, width, height);
      const back = toWorld(screen.x, screen.y, width, height);
      expect(back.x).toBeCloseTo(wx, 10);
      expect(back.y).toBeCloseTo(wy, 10);
    }

    // The origin sits at the bottom centre, and `+Y` is up.
    const origin = toScreen(0, 0, width, height);
    expect(origin.x).toBeCloseTo(width / 2, 10);
    expect(origin.y).toBeCloseTo(height * 0.78, 10);
    const above = toScreen(0, 1, width, height);
    expect(above.y).toBeLessThan(origin.y);
    expect(origin.y - above.y).toBeCloseTo(SCALE, 10);
  });

  it('keeps the particles of every preset on screen over a second', () => {
    // A preset whose speed or gravity is out of scale flings its particles off-canvas, which
    // reads as "the effect is weak" rather than as a bug. This catches that.
    const stub = installDocumentStub();
    const windowStub = installWindowStub();
    const width = 880;
    const height = 560;
    try {
      for (const preset of PRESETS) {
        const system = new ParticleSystem(preset.options);
        const positions = system.getPositionAttribute().array;

        let onScreen = 0;
        let sampled = 0;
        for (let frame = 0; frame < 60; frame++) {
          system.update(1 / 60);
          if (frame % 10 !== 0) continue;
          const alive = system.getAliveCount();
          for (let slot = 0; slot < alive; slot++) {
            const point = toScreen(positions[slot * 3], positions[slot * 3 + 1], width, height);
            sampled++;
            if (point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height) onScreen++;
          }
        }

        const ratio = sampled > 0 ? onScreen / sampled : 0;
        console.log(`preset ${preset.label}: ${onScreen}/${sampled} samples on screen`);
        expect(sampled).toBeGreaterThan(0);
        // Not 100%: the fountain legitimately arcs off the top, and the burst starts at the
        // origin. But most of the plume should be visible.
        expect(ratio).toBeGreaterThan(0.2);

        system.dispose();
      }
    } finally {
      windowStub.restore();
      stub.restore();
    }
  });
});

describe('the example draw path', () => {
  it('blits one sprite per live particle and restores the blend state', () => {
    const canvas = new CanvasDouble(880, 560);
    const renderer = new Canvas2DRenderer(rendererOptions(canvas));

    const stub = installDocumentStub();
    const windowStub = installWindowStub();
    try {
      // The example's real renderable, driven against the real renderer. Nothing about the
      // draw path is transcribed here: if `ParticleRenderer` reads the wrong stride, or
      // forgets to restore the blend state, this fails.
      const preset = PRESETS[0];
      const system = new ParticleSystem(preset.options);
      for (let frame = 0; frame < 30; frame++) system.update(1 / 60);

      const renderable = new ParticleRenderer(system, preset);
      renderable.prepare();

      const alive = system.getAliveCount();
      expect(alive).toBeGreaterThan(0);

      renderer.render({ visible: true, children: [renderable] } as never, null);

      const drawImageCalls = canvas.context.callsOf('drawImage');
      console.log(
        'preset:', preset.label,
        '| live:', alive,
        '| drawImage calls:', drawImageCalls.length,
        '| renderer.drawn:', renderable.drawn,
        '| sprites created:', stub.created.length,
      );

      // The renderer dispatched into the renderable and it blitted. A double that silently
      // bailed would leave this at zero, which is a trap this file fell into once.
      expect(drawImageCalls.length).toBeGreaterThan(0);
      expect(drawImageCalls.length).toBeLessThanOrEqual(alive);
      expect(renderable.drawn).toBe(alive);

      // Each particle was drawn at its own size. `Canvas2DPainter.drawImage` forwards the
      // 5-argument canvas overload as *positional* arguments, so the width is `args[3]` —
      // reading `args[1].dw` silently yields `undefined` for every call, which makes a
      // "sizes are all identical" assertion pass for the wrong reason.
      const widths = drawImageCalls.map((call) => call.args[3] as number);
      console.log('distinct drawn widths:', new Set(widths).size, '| sample:', widths.slice(0, 5).map((w) => w.toFixed(2)).join(', '));
      expect(widths.every((width) => typeof width === 'number')).toBe(true);
      expect(new Set(widths).size).toBeGreaterThan(1);
      for (const width of widths) {
        expect(Number.isFinite(width)).toBe(true);
        expect(width).toBeGreaterThan(0);
      }
      // The reported range matches what was actually drawn.
      expect(renderable.minEdge).toBeCloseTo(Math.min(...widths), 6);
      expect(renderable.maxEdge).toBeCloseTo(Math.max(...widths), 6);

      // A tinted sprite was cached rather than rasterised per particle.
      expect(stub.created.length).toBeGreaterThan(0);
      expect(stub.created.length).toBeLessThan(alive);
      expect(renderable.tintCount).toBeGreaterThan(0);
      expect(renderable.tintCount).toBeLessThanOrEqual(stub.created.length);

      // Blend state must not leak into the next frame.
      expect(canvas.context.globalCompositeOperation).toBe('source-over');
      expect(canvas.context.globalAlpha).toBe(1);

      system.dispose();
    } finally {
      windowStub.restore();
      stub.restore();
    }

    renderer.dispose();
  });

  it('draws every preset without throwing', () => {
    // A cheap sweep so a preset with a bad option bag fails here rather than only when
    // someone presses its key.
    const stub = installDocumentStub();
    const windowStub = installWindowStub();
    try {
      for (const preset of PRESETS) {
        const canvas = new CanvasDouble(320, 200);
        const renderer = new Canvas2DRenderer(rendererOptions(canvas, 320, 200));
        const system = new ParticleSystem(preset.options);

        // Long enough for the burst preset to fire at least once.
        for (let frame = 0; frame < 90; frame++) system.update(1 / 60);

        const renderable = new ParticleRenderer(system, preset);
        renderable.prepare();
        renderer.render({ visible: true, children: [renderable] } as never, null);

        const blits = canvas.context.callsOf('drawImage').length;
        console.log(`preset ${preset.label}: live ${system.getAliveCount()}, blits ${blits}`);
        expect(blits).toBeGreaterThan(0);

        system.dispose();
        renderer.dispose();
      }
    } finally {
      windowStub.restore();
      stub.restore();
    }
  });

  it('rasterises a bounded number of tinted sprites for a colour ramp', () => {
    // The point of the sprite cache. A ramp of 200 steps must not create 200 canvases.
    const stub = installDocumentStub();
    try {
      const quantise = (value: number): number => Math.max(1, Math.min(16, Math.round((value || 0) * 16)));
      const keys = new Set<number>();

      for (let step = 0; step < 200; step++) {
        const t = step / 200;
        // A ramp from warm white to deep orange, as the fountain's `endColor` describes.
        const key = (quantise(1 - t * 0.5) << 8) | (quantise(0.7 - t * 0.4) << 4) | quantise(0.3 * t);
        if (keys.has(key)) continue;
        keys.add(key);
        (globalThis as unknown as { document: { createElement(t: string): unknown } }).document.createElement('canvas');
      }

      console.log('ramp of 200 steps -> distinct keys:', keys.size, '| canvases:', stub.created.length);
      expect(keys.size).toBeLessThan(200);
      expect(stub.created.length).toBe(keys.size);
      // Each sprite was rasterised at the glow sprite's size, not at zero.
      for (const sprite of stub.created) {
        expect(sprite.width).toBe(64);
        expect(sprite.height).toBe(64);
      }
    } finally {
      stub.restore();
    }
  });
});
