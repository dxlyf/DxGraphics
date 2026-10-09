/**
 * Particles — a pooled particle simulation drawn with Canvas2D.
 *
 * This file is only the page: the DOM, the input handling and the frame loop. Everything
 * DOM-free — the presets, the projection, the renderable and the self-check — lives in
 * `scene.ts`, so a test can import and run it. See that file for why the split is load
 * bearing rather than tidiness.
 *
 * What it shows
 * -------------
 * 1. **`ParticleSystem`** as the simulation. It owns the pool, the emitter and the
 *    per-particle attribute buffers; this example only reads them and draws.
 * 2. **`ParticleEmitter`** for the spawn distribution. Four presets exercise the `'cone'`,
 *    `'circle'`, `'sphere'` and `'box'` shapes with different spread, speed, lifetime,
 *    gravity and drag.
 * 3. **A structure-of-arrays read.** Position, size, rotation, colour and life are separate
 *    typed arrays, so drawing walks them directly. **Live particles occupy slots
 *    `0 .. getAliveCount() - 1`** — killing one swaps the last live particle into the hole
 *    — which is what makes the draw loop a plain `for` rather than a scan for live flags.
 *    That invariant is the single most useful thing to know about the buffers.
 * 4. **Additive compositing** (`globalCompositeOperation = 'lighter'`) so overlapping
 *    particles accumulate into a bright core. That is why the glow is a pre-rendered sprite
 *    rather than a per-particle gradient, and why the sprite is tinted by multiplying into
 *    a cached copy instead of with a composite operation — the composite slot is taken by
 *    the blend mode. See `sprites.ts`.
 *
 * Controls
 * --------
 * Drag to pull the emitter around. `1`–`4` switch preset, `space` toggles emission, `c`
 * clears the live particles. The overlay reports live/capacity, spawn and kill totals,
 * whether emission is on, the drawn edge-width range, the number of distinct sprite tints
 * in use and the frame rate.
 *
 * What this is not
 * ----------------
 * Not a GPU particle system. `ParticleSystem` produces buffer attributes meant for a `Points`
 * draw with a material; Canvas2D has no vertex shader, so the attributes are read on the CPU
 * and each particle costs one `drawImage`. The *simulation* is the library's — integration,
 * pooling, lifetimes, size and colour ramps — and only the rasterisation is here. On WebGL
 * the same buffers upload directly.
 */

import {
  BackendNames,
  Canvas2DRenderer,
  ParticleSystem,
  detectBackendStrict,
} from '../../src/index';

import { PRESETS, ParticleRenderer, toWorld, verifySimulation } from './scene';

/* -------------------------------------------------------------------------- */
/* Self-check                                                                 */
/* -------------------------------------------------------------------------- */

// Runs before any DOM access, so a broken emitter or a leaking pool fails loudly at load
// instead of silently drawing nothing. The check itself lives in `scene.ts` so the test
// suite exercises the same code.
try {
  console.info(`particles: simulation self-check passed (${verifySimulation()})`);
} catch (error) {
  throw new Error(`particles: simulation self-check failed — ${(error as Error).message}`);
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
const overlay = document.querySelector<HTMLElement>('#overlay');
const notice = document.querySelector<HTMLElement>('#notice');

/** Shows a diagnostic instead of leaving a blank canvas unexplained. */
function showNotice(message: string): void {
  if (!notice) return;
  notice.textContent = message;
  notice.hidden = false;
  if (overlay) overlay.textContent = 'backend unavailable';
}

let dispose = (): void => undefined;

if (!canvas || !overlay) {
  showNotice('This example needs the #stage canvas and the #overlay element to exist.');
} else if (detectBackendStrict(BackendNames.Canvas2D, canvas) !== BackendNames.Canvas2D) {
  showNotice('This example needs a 2D canvas context, which this browser could not create.');
} else {
  const renderer = new Canvas2DRenderer({ canvas, clearColor: '#080a10', autoResize: true });

  let presetIndex = 0;
  let system = new ParticleSystem(PRESETS[presetIndex].options);
  const particleRenderer = new ParticleRenderer(system, PRESETS[presetIndex]);
  particleRenderer.prepare();

  /** Emitter origin in world units, moved by the pointer. */
  const origin = { x: 0, y: 0 };

  /** Rebuilds the simulation for a preset. */
  function applyPreset(index: number): void {
    presetIndex = ((index % PRESETS.length) + PRESETS.length) % PRESETS.length;
    system.dispose();
    system = new ParticleSystem(PRESETS[presetIndex].options);
    particleRenderer.setPreset(system, PRESETS[presetIndex]);
  }

  /* --------------------------------------------------------------- input --- */

  let dragging = false;

  const setOriginFromEvent = (event: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const world = toWorld(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
    origin.x = world.x;
    origin.y = world.y;
  };

  const onPointerDown = (event: PointerEvent): void => {
    dragging = true;
    setOriginFromEvent(event);
    canvas.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (dragging) setOriginFromEvent(event);
  };
  const onPointerUp = (event: PointerEvent): void => {
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key >= '1' && event.key <= String(PRESETS.length)) {
      applyPreset(Number(event.key) - 1);
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      // `stopEmitting`/`resumeEmitting`, not `stop`/`start`: these toggle the tap and let
      // the live particles finish their lifetimes, whereas `stop()` freezes them mid-air
      // and `start()` restarts the emission clock from zero.
      if (system.emitting) system.stopEmitting();
      else system.resumeEmitting();
      return;
    }
    if (event.key === 'c' || event.key === 'C') {
      // Clears the live particles without disturbing the emission configuration.
      system.reset();
    }
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onKeyDown);

  /* ---------------------------------------------------------------- loop --- */

  let fps = 0;
  let frames = 0;
  let fpsElapsed = 0;

  renderer.setAnimationLoop((_time, delta) => {
    // The emitter origin follows the pointer. Live particles keep their own positions, so
    // this steers where *new* ones appear rather than dragging the plume.
    system.emitter.position.set(origin.x, origin.y, 0);
    system.update(delta);

    frames++;
    fpsElapsed += delta;
    if (fpsElapsed >= 0.25) {
      fps = frames / fpsElapsed;
      frames = 0;
      fpsElapsed = 0;
    }

    renderer.render(particleRenderer, null);

    const stats = system.getStats();
    overlay.textContent =
      `FPS        ${fps.toFixed(0)}\n` +
      `preset     ${PRESETS[presetIndex].label}  (1-${PRESETS.length})\n` +
      `live       ${stats.alive} / ${stats.capacity}\n` +
      `spawned    ${stats.spawned}\n` +
      `killed     ${stats.killed}\n` +
      `emitting   ${stats.emitting ? 'yes' : 'no'}  (space)\n` +
      `edge px    ${particleRenderer.minEdge.toFixed(0)}-${particleRenderer.maxEdge.toFixed(0)}\n` +
      `tints      ${particleRenderer.tintCount}\n` +
      `draw calls ${renderer.stats.drawCalls}`;
  }, { autoStart: true });

  dispose = (): void => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('keydown', onKeyDown);
    renderer.setAnimationLoop(null);
    system.dispose();
    renderer.dispose();
  };
}

window.addEventListener('beforeunload', dispose);
