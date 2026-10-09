/**
 * Animation — driving motion from a clock, keyframes and easing.
 *
 * What it shows
 * -------------
 * 1. **`Clock`** as the single source of time. `getDelta()` returns seconds and is
 *    clamped, so a backgrounded tab does not teleport the animation.
 * 2. **`Timer`** for a fixed-cadence event, independent of the render rate, with
 *    `Timer.onTick` returning an unsubscribe function.
 * 3. **Keyframe interpolation written out by hand**: a sorted track of
 *    `{ time, value }` pairs sampled with linear interpolation, then smoothed with
 *    an easing curve. `src/animation` does contain `AnimationClip`/`AnimationMixer`/
 *    `KeyframeTrack`, but this example deliberately shows the mechanism they build on
 *    so the maths is visible — see the note below.
 * 4. **`ManualClock`** for deterministic stepping, used by the headless sanity check
 *    at the bottom of this file.
 *
 * What to look for
 * ----------------
 * A ball tracing a keyframed path with a second, eased ghost alongside it, so the
 * difference between linear and eased sampling is directly comparable. A pulsing
 * halo is driven by the `Timer`, not the frame loop, so it keeps its cadence if the
 * frame rate drops. The bottom bar shows a looping cycle's progress.
 *
 * > **Note:** `src/animation` is present in this checkout and exports
 * > `AnimationClip`, `AnimationMixer`, `AnimationAction`, `KeyframeTrack`,
 * > `Interpolant`, `Easing`, `Tween`/`Timeline` and `SkeletonUtils`. This example
 * > keeps its interpolation inline on purpose, so that the sampling maths is
 * > readable; read `docs/guide/animation.md` for the `AnimationMixer` API.
 */

import {
  BackendNames,
  Canvas2DRenderer,
  Clock,
  Color,
  ManualClock,
  Timer,
  detectBackendStrict,
  type BackendName,
  type Canvas2DPainter,
  type Renderable2D,
} from '../../src/index';

/* -------------------------------------------------------------------------- */
/* Keyframes and easing                                                       */
/* -------------------------------------------------------------------------- */

/** One keyframe: a value reached at `time` seconds. */
interface Keyframe {
  readonly time: number;
  readonly value: number;
}

/**
 * Samples a sorted keyframe track at `time`, looping over `duration`.
 *
 * Before the first and after the last keyframe the value is held, which is the
 * conventional "clamp" behaviour. Between two keyframes the value is linearly
 * interpolated.
 */
function sampleTrack(track: readonly Keyframe[], time: number): number {
  if (track.length === 0) return 0;
  if (track.length === 1) return track[0].value;

  const first = track[0];
  const last = track[track.length - 1];
  if (time <= first.time) return first.value;
  if (time >= last.time) return last.value;

  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time;
      const t = span <= 0 ? 0 : (time - a.time) / span;
      return a.value + (b.value - a.value) * t;
    }
  }
  return last.value;
}

/** Smoothstep easing on `0..1`: zero first and second derivative at both ends. */
function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Ease-in-out back, so the eased ghost visibly overshoots. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = Math.min(1, Math.max(0, t));
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

/* -------------------------------------------------------------------------- */
/* Renderables                                                                */
/* -------------------------------------------------------------------------- */

/** A filled disc with an optional halo, drawn through a Canvas2D painter. */
class Ball implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  public constructor(
    private readonly tint: string,
    private readonly radius: number,
    private halo = 0,
  ) {}

  public x = 0;
  public y = 0;

  /** Radius of the timer-driven halo, in logical pixels. */
  public setHalo(value: number): void {
    this.halo = value;
  }

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    p.save();
    p.translate(this.x, this.y);

    if (this.halo > 0) {
      p.beginPath();
      p.arc(0, 0, this.radius + this.halo, 0, Math.PI * 2);
      p.fillStyle = 'rgba(63, 191, 143, 0.16)';
      p.fill();
    }

    p.beginPath();
    p.arc(0, 0, this.radius, 0, Math.PI * 2);
    p.fillStyle = this.tint;
    p.fill();
    p.restore();
  }
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
const overlay = document.querySelector<HTMLElement>('#overlay');
const notice = document.querySelector<HTMLElement>('#notice');
const progress = document.querySelector<HTMLElement>('#progress');

function showNotice(message: string): void {
  if (!notice) return;
  notice.textContent = message;
  notice.hidden = false;
  if (overlay) overlay.textContent = 'backend unavailable';
}

/* -------------------------------------------------------------------------- */
/* Headless sanity check of the sampling maths                                */
/* -------------------------------------------------------------------------- */

// `ManualClock` makes time explicit, so the interpolation can be asserted without
// a renderer. This runs before any DOM is touched.
{
  const track: Keyframe[] = [
    { time: 0, value: 0 },
    { time: 1, value: 10 },
    { time: 2, value: 4 },
  ];
  const clock = new ManualClock();
  clock.setTime(0);
  clock.advance(0.5);

  // `getElapsedTime()` is a read; `advance()` is what moves the clock. Reading it does
  // not step time, so the order here is load-bearing.
  const sampled = sampleTrack(track, clock.getElapsedTime());
  if (Math.abs(sampled - 5) > 1e-9) {
    throw new Error(`keyframe sampling is wrong: expected 5 at t=0.5, got ${sampled}`);
  }
  if (Math.abs(sampleTrack(track, -1) - 0) > 1e-9) {
    throw new Error('keyframe sampling must hold the first value before the track starts');
  }
  if (Math.abs(sampleTrack(track, 99) - 4) > 1e-9) {
    throw new Error('keyframe sampling must hold the last value after the track ends');
  }
}

let dispose = (): void => undefined;

if (!canvas || !overlay) {
  showNotice('This example needs the #stage canvas and the #overlay element to exist.');
} else {
  const preferred: BackendName[] = [BackendNames.Canvas2D];
  const backend = detectBackendStrict(preferred, canvas);

  if (backend !== BackendNames.Canvas2D) {
    showNotice('This example needs a 2D canvas context, which this browser could not create.');
  } else {
    const renderer = new Canvas2DRenderer({ canvas, clearColor: '#11151d', autoResize: true });

    // The authored tracks, in seconds, looping over `CYCLE` seconds.
    const CYCLE = 4;
    const pathX: Keyframe[] = [
      { time: 0, value: -9 },
      { time: 1, value: -3 },
      { time: 2, value: 3 },
      { time: 3, value: 8.5 },
      { time: 4, value: -9 },
    ];
    const pathY: Keyframe[] = [
      { time: 0, value: -3.5 },
      { time: 1, value: 3.2 },
      { time: 2, value: -2.4 },
      { time: 3, value: 2.6 },
      { time: 4, value: -3.5 },
    ];

    const linear = new Ball('#2f6fdf', 0.62);
    const eased = new Ball('rgba(138, 108, 240, 0.75)', 0.5);
    linear.depth = 2;
    eased.depth = 1;
    eased.setHalo(0.35);

    const scene = { children: [eased, linear] as Renderable2D[] };
    const camera = { position: { x: 0, y: 0, z: 0 }, zoom: 26 };

    const clock = new Clock();
    clock.start();

    // A timer drives the halo pulse, so its cadence is independent of frame rate.
    // `repeat: true` is required: `Timer` defaults to a single shot that completes
    // after one tick (see `TimerOptions.repeat`), so without it the pulse would fire
    // once and then stop for the lifetime of the page.
    const pulseTimer = new Timer(1 / 6, { autoStart: true, repeat: true });
    let haloPhase = 0;
    const offTick = pulseTimer.onTick(() => {
      haloPhase = (haloPhase + 1) % 6;
      eased.setHalo(0.2 + haloPhase * 0.14);
    });

    let cycleTime = 0;
    let fps = 0;
    let frames = 0;
    let fpsElapsed = 0;

    renderer.setAnimationLoop((_time, delta) => {
      // The renderer's loop delta is clamped by the renderer; the Clock is used for
      // the authored timeline so the two stay independent.
      const clockDelta = clock.getDelta();
      cycleTime = (cycleTime + clockDelta) % CYCLE;
      pulseTimer.update(delta);

      linear.x = sampleTrack(pathX, cycleTime);
      linear.y = sampleTrack(pathY, cycleTime);

      // The eased ghost samples the same tracks but re-maps the normalised cycle
      // time through an easing curve, so it lags and overshoots.
      const u = cycleTime / CYCLE;
      const easedTime = easeOutBack(u) * CYCLE * (0.5 + smoothstep(u) * 0.5);
      eased.x = sampleTrack(pathX, Math.min(CYCLE, Math.max(0, easedTime)));
      eased.y = sampleTrack(pathY, Math.min(CYCLE, Math.max(0, easedTime)));

      frames++;
      fpsElapsed += delta;
      if (fpsElapsed >= 0.25) {
        fps = frames / fpsElapsed;
        frames = 0;
        fpsElapsed = 0;
      }

      renderer.render(scene, camera);

      overlay.textContent =
        `FPS          ${fps.toFixed(0)}\n` +
        `backend      ${renderer.backend}\n` +
        `cycle        ${cycleTime.toFixed(2)} / ${CYCLE.toFixed(2)} s\n` +
        `clock delta  ${(clock.getDeltaMilliseconds()).toFixed(1)} ms (last)\n` +
        `timer ticks  ${pulseTimer.count}\n` +
        `draw calls   ${renderer.stats.drawCalls}`;

      if (progress) progress.style.width = `${(cycleTime / CYCLE) * 100}%`;
    }, { autoStart: true });

    dispose = (): void => {
      offTick();
      pulseTimer.stop();
      renderer.setAnimationLoop(null);
      renderer.dispose();
    };
  }
}

window.addEventListener('beforeunload', dispose);

/** Keeps `Color` referenced so the import list documents the palette source. */
export const palette = new Color('#2f6fdf').toCssString();
