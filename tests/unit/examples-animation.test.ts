import { describe, expect, it } from 'vitest';
import { Canvas2DRenderer, Clock, ManualClock, Timer } from '../../src/index';

/**
 * Drives the `examples/animation` motion logic over many simulated frames to confirm
 * the balls actually move and stay inside the canvas — a single-frame check cannot
 * tell "renders nothing" from "renders off-screen".
 */

interface Keyframe {
  readonly time: number;
  readonly value: number;
}

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

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = Math.min(1, Math.max(0, t));
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function makeRecorder() {
  const arcs: { x: number; y: number; r: number }[] = [];
  const calls: string[] = [];
  let translateX = 0;
  let translateY = 0;
  const noop = () => undefined;
  const context = {
    canvas: { width: 880, height: 560 },
    save: noop,
    restore: noop,
    resetTransform: noop,
    setTransform: noop,
    transform: noop,
    translate: (x: number, y: number) => {
      translateX = x;
      translateY = y;
      calls.push(`translate(${x.toFixed(2)},${y.toFixed(2)})`);
    },
    scale: noop,
    rotate: noop,
    clearRect: noop,
    fillRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    closePath: noop,
    arc: (x: number, y: number, r: number) => {
      arcs.push({ x: translateX + x, y: translateY + y, r });
    },
    fill: noop,
    stroke: noop,
    clip: noop,
    rect: noop,
    setLineDash: noop,
    getLineDash: () => [],
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    getImageData: () => ({ data: new Uint8ClampedArray(880 * 560 * 4), width: 880, height: 560 }),
    putImageData: noop,
    drawImage: noop,
    fillText: noop,
    strokeText: noop,
    _fillStyle: '#000',
    get fillStyle() {
      return this._fillStyle;
    },
    set fillStyle(v: string) {
      this._fillStyle = v;
    },
    _strokeStyle: '#000',
    get strokeStyle() {
      return this._strokeStyle;
    },
    set strokeStyle(v: string) {
      this._strokeStyle = v;
    },
    _lineWidth: 1,
    get lineWidth() {
      return this._lineWidth;
    },
    set lineWidth(v: number) {
      this._lineWidth = v;
    },
    _globalAlpha: 1,
    get globalAlpha() {
      return this._globalAlpha;
    },
    set globalAlpha(v: number) {
      this._globalAlpha = v;
    },
    _globalCompositeOperation: 'source-over',
    get globalCompositeOperation() {
      return this._globalCompositeOperation;
    },
    set globalCompositeOperation(v: string) {
      this._globalCompositeOperation = v;
    },
    _imageSmoothingEnabled: true,
    get imageSmoothingEnabled() {
      return this._imageSmoothingEnabled;
    },
    set imageSmoothingEnabled(v: boolean) {
      this._imageSmoothingEnabled = v;
    },
  };
  return { context, arcs, calls };
}

describe('examples/animation motion', () => {
  it('moves the balls and keeps them on screen for a whole cycle', () => {
    const { context, arcs } = makeRecorder();

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

    const eased = { visible: true, renderOrder: 0, depth: 1, x: 0, y: 0, halo: 0 };
    const linear = { visible: true, renderOrder: 0, depth: 2, x: 0, y: 0, halo: 0 };
    const ball = (which: { x: number; y: number; halo: number }, radius: number) => ({
      render: (painter: { save(): void; translate(a: number, b: number): void; beginPath(): void; arc(a: number, b: number, r: number, s: number, e: number): void; fill(): void; restore(): void; fillStyle: string }) => {
        painter.save();
        painter.translate(which.x, which.y);
        if (which.halo > 0) {
          painter.beginPath();
          painter.arc(0, 0, radius + which.halo, 0, Math.PI * 2);
          painter.fill();
        }
        painter.beginPath();
        painter.arc(0, 0, radius, 0, Math.PI * 2);
        painter.fill();
        painter.restore();
      },
    });

    const scene = { children: [ball(eased, 0.5), ball(linear, 0.62)] };
    const camera = { position: { x: 0, y: 0, z: 0 }, zoom: 26 };

    const stubCanvas = {
      width: 880,
      height: 560,
      style: {},
      getContext: (kind: string) => (kind === '2d' ? context : null),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 880, height: 560, top: 0, left: 0, right: 880, bottom: 560 }),
    };

    const renderer = new Canvas2DRenderer({
      canvas: stubCanvas as never,
      clearColor: '#11151d',
      autoResize: true,
    });
    console.log('renderer headless?', renderer.isHeadless, '| surface', renderer.width, 'x', renderer.height);

    const clock = new Clock();
    clock.start();
    const pulseTimer = new Timer(1 / 6, { autoStart: true, repeat: true });

    const seen: { x: number; y: number }[] = [];
    let cycleTime = 0;
    const frameDelta = 1 / 60;
    for (let frame = 0; frame < 300; frame++) {
      // Deterministic stepping: the example uses Clock.getDelta(), but the wall clock
      // would make this test non-reproducible, so advance cycleTime directly.
      cycleTime = (cycleTime + frameDelta) % CYCLE;
      pulseTimer.update(frameDelta);

      linear.x = sampleTrack(pathX, cycleTime);
      linear.y = sampleTrack(pathY, cycleTime);
      const u = cycleTime / CYCLE;
      const easedTime = easeOutBack(u) * CYCLE * (0.5 + smoothstep(u) * 0.5);
      eased.x = sampleTrack(pathX, Math.min(CYCLE, Math.max(0, easedTime)));
      eased.y = sampleTrack(pathY, Math.min(CYCLE, Math.max(0, easedTime)));
      eased.halo = 0.2 + (pulseTimer.count % 6) * 0.14;

      arcs.length = 0;
      renderer.render(scene as never, camera as never);
      // The last arc of each ball is the main disc (halo first, then disc).
      for (const arc of arcs) {
        // World -> screen with the renderer's transform: x' = x*26 + 440, y' = -y*26 + 280
        const screenX = arc.x * 26 + 440;
        const screenY = -arc.y * 26 + 280;
        seen.push({ x: screenX, y: screenY });
        expect(screenX).toBeGreaterThan(0);
        expect(screenX).toBeLessThan(880);
        expect(screenY).toBeGreaterThan(0);
        expect(screenY).toBeLessThan(560);
      }
    }

    console.log('frames rendered:', 300, '| arc samples:', seen.length);
    console.log('x range:', Math.min(...seen.map((p) => p.x)).toFixed(1), '..', Math.max(...seen.map((p) => p.x)).toFixed(1));
    console.log('y range:', Math.min(...seen.map((p) => p.y)).toFixed(1), '..', Math.max(...seen.map((p) => p.y)).toFixed(1));
    console.log('timer ticks after 300 frames:', pulseTimer.count);

    // Two balls plus a halo on the eased one, every frame, all on screen.
    expect(seen.length).toBeGreaterThan(600);
    // 300 frames at 1/60 s = 5 s, and the interval is 1/6 s, so exactly 30 ticks.
    expect(pulseTimer.count).toBe(30);
  });

  it('documents that a Timer is one-shot unless repeat is set', () => {
    // This is the trap that stopped the example's halo from pulsing. `repeat`
    // defaults to `false`, so a plain `new Timer(interval)` fires once and then
    // `update()` is a no-op forever — which looks exactly like "the timer is not
    // running" and produces no error.
    const oneShot = new Timer(0.5);
    let oneShotTicks = 0;
    oneShot.onTick(() => oneShotTicks++);

    for (let step = 0; step < 20; step++) oneShot.update(0.1);
    expect(oneShotTicks).toBe(1);
    expect(oneShot.completed).toBe(true);
    expect(oneShot.running).toBe(false);
    // Every later update is a no-op.
    expect(oneShot.update(5)).toBe(false);

    const repeating = new Timer(0.5, { repeat: true });
    let repeatingTicks = 0;
    repeating.onTick(() => repeatingTicks++);

    for (let step = 0; step < 20; step++) repeating.update(0.1);
    expect(repeatingTicks).toBe(4);
    expect(repeating.completed).toBe(false);
    expect(repeating.running).toBe(true);
  });
});

describe('Clock reads do not advance time', () => {
  it("reproduces the example's headless sanity check", () => {
    // The example runs this block at module scope before touching the DOM, and it threw
    // `keyframe sampling is wrong: expected 5 at t=0.5, got 7.818999999999999` in the
    // browser. Reproducing it verbatim here means the same regression fails in CI rather
    // than only in a page load.
    const track = [
      { time: 0, value: 0 },
      { time: 1, value: 10 },
      { time: 2, value: 4 },
    ];

    /** The example's own sampler. */
    const sampleTrack = (frames: typeof track, time: number): number => {
      if (time <= frames[0].time) return frames[0].value;
      const last = frames[frames.length - 1];
      if (time >= last.time) return last.value;
      for (let i = 0; i < frames.length - 1; i++) {
        const a = frames[i];
        const b = frames[i + 1];
        if (time >= a.time && time <= b.time) {
          const span = b.time - a.time;
          const t = span <= 0 ? 0 : (time - a.time) / span;
          return a.value + (b.value - a.value) * t;
        }
      }
      return last.value;
    };

    const clock = new ManualClock();
    clock.setTime(0);
    clock.advance(0.5);

    const sampled = sampleTrack(track, clock.getElapsedTime());
    console.log('example sanity check: t =', clock.getElapsedTime(), '-> value', sampled);
    expect(Math.abs(sampled - 5)).toBeLessThan(1e-9);
    expect(Math.abs(sampleTrack(track, -1) - 0)).toBeLessThan(1e-9);
    expect(Math.abs(sampleTrack(track, 99) - 4)).toBeLessThan(1e-9);
  });

  it('ManualClock setTime + advance lands on the requested time, and getElapsedTime is a read', () => {
    // This is the bug that threw in the example's headless sanity check:
    // `getElapsedTime()` used to call `getDelta()` with no argument, which on a
    // ManualClock measured from timestamp 0 to the host's wall clock. The reported
    // elapsed time was therefore roughly the age of the browser process rather than the
    // 0.5 s that had been asked for, and sampling the track at that time yielded
    // 7.819 instead of 5.
    const clock = new ManualClock();
    clock.setTime(0);
    clock.advance(0.5);

    const elapsed = clock.getElapsedTime();
    console.log('ManualClock after setTime(0) + advance(0.5): elapsed =', elapsed);
    expect(elapsed).toBeCloseTo(0.5, 10);

    // Reading it again must not move it.
    expect(clock.getElapsedTime()).toBeCloseTo(0.5, 10);
    expect(clock.getElapsedTime()).toBeCloseTo(0.5, 10);

    // ... and advancing again lands exactly 0.25 s later.
    clock.advance(0.25);
    expect(clock.getElapsedTime()).toBeCloseTo(0.75, 10);
  });

  it('ManualClock getDelta without an argument does not consult the wall clock', () => {
    const clock = new ManualClock();
    clock.setTime(0);

    // No argument: there is nothing to advance to, so nothing moves.
    expect(clock.getDelta()).toBe(0);
    expect(clock.getElapsedTime()).toBeCloseTo(0, 10);

    clock.advance(0.1);
    expect(clock.getDelta()).toBe(0);
    expect(clock.getElapsedTime()).toBeCloseTo(0.1, 10);
  });

  it('ManualClock start without an argument restarts at the manual time base', () => {
    const clock = new ManualClock();
    clock.advance(1);
    expect(clock.getElapsedTime()).toBeCloseTo(1, 10);

    // A wall-clock default here would make the next advance report the age of the
    // process. It must reset to 0 on the manual base instead.
    clock.start();
    expect(clock.getElapsedTime()).toBeCloseTo(0, 10);
    clock.advance(0.5);
    expect(clock.getElapsedTime()).toBeCloseTo(0.5, 10);
  });

  it('getDeltaMilliseconds reports the last delta instead of advancing again', () => {
    const manual = new ManualClock();
    manual.advance(0.25);

    expect(manual.getDeltaMilliseconds()).toBeCloseTo(250, 6);

    // Reading it must be idempotent and must not add a second delta to `elapsed`.
    expect(manual.getDeltaMilliseconds()).toBeCloseTo(250, 6);
    expect(manual.getElapsedTime()).toBeCloseTo(0.25, 10);

    // A real `Clock` behaves the same way, with its clamp applied to the *reported*
    // delta and to `elapsed` alike: a 500 ms step is capped at `MAX_DELTA` (0.1 s), so
    // the clock reports 100 ms and its elapsed time advances by exactly that.
    const real = new Clock({ autoStart: false });
    real.start(0);
    expect(real.getDelta(500)).toBeCloseTo(0.1, 10);
    expect(real.getDeltaMilliseconds()).toBeCloseTo(100, 6);
    expect(real.getElapsedTime()).toBeCloseTo(0.1, 10);
    expect(real.getDeltaMilliseconds()).toBeCloseTo(100, 6);
    expect(real.getElapsedTime()).toBeCloseTo(0.1, 10);

    // Within the clamp, the step is passed through unchanged.
    const small = new Clock({ autoStart: false });
    small.start(0);
    expect(small.getDelta(40)).toBeCloseTo(0.04, 10);
    expect(small.getDeltaMilliseconds()).toBeCloseTo(40, 6);
    expect(small.getElapsedTime()).toBeCloseTo(0.04, 10);
  });

  it('a real Clock accumulates exactly the deltas it was given', () => {
    // The pattern the example uses: advance with `getDelta(timestamp)`, then read.
    const clock = new Clock({ autoStart: false });
    clock.start(0);

    for (let step = 1; step <= 10; step++) clock.getDelta(step * 100);
    console.log('elapsed after 10 x 100 ms:', clock.getElapsedTime());
    expect(clock.getElapsedTime()).toBeCloseTo(1, 10);
  });
});
