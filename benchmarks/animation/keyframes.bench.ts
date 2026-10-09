/**
 * Animation hot-path benchmarks.
 *
 * Covers keyframe interpolation, easing, quaternion slerp and the clock arithmetic that
 * drives them. Run with `pnpm bench`; all tracks, samplers and clocks are built
 * **outside** the `bench` callbacks.
 *
 * ## How to read the numbers
 *
 * `hz` is operations per second, `mean` is milliseconds per operation. The useful unit
 * here is **one sampler evaluation**, because a real rig evaluates thousands of them per
 * frame: a 500-keyframe interpolation at ~100 ns each is 50 µs for a single track, which
 * is where the frame budget starts to matter.
 *
 * ## What would regress these
 *
 * - **`sampleLinear`** — losing the binary search and falling back to a linear scan of
 *   every keyframe, which turns an O(log n) lookup into O(n). The two sizes below
 *   (16 vs 512 keys) are chosen so that regression is obvious: with a binary search
 *   their ratio stays near 1, with a scan it grows with the key count.
 * - **Easing functions** — introducing a `Math.pow` where a multiplication suffices, or
 *   adding a clamp that allocates.
 * - **`Quat.slerp`** — see `benchmarks/math/core.bench.ts`; this file benches it in an
 *   animation-shaped loop (many sequential slerps) rather than in isolation.
 * - **`Clock.getDelta`** — allocating a Date, or calling `performance.now()` more than
 *   once per call.
 */

import { bench, describe } from 'vitest';

import { Clock } from '../../src/core/Clock';
import { Mat4 } from '../../src/math/Mat4';
import { Quat } from '../../src/math/Quat';
import { Vec3 } from '../../src/math/Vec3';

/* -------------------------------------------------------------------------- */
/* Keyframe tracks                                                            */
/* -------------------------------------------------------------------------- */

/** A pair of time/value arrays, the layout a keyframe track stores. */
interface Track {
  readonly times: Float64Array;
  readonly values: Float32Array;
  readonly lastTime: number;
}

/** Builds `count` keyframes over `duration` seconds with a smooth value curve. */
function makeTrack(count: number, duration: number): Track {
  const times = new Float64Array(count);
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * duration;
    times[i] = t;
    values[i] = Math.sin(t * 1.7) * 10;
  }
  return { times, values, lastTime: duration };
}

/**
 * Samples a track with linear interpolation, using a binary search for the span.
 *
 * This is the algorithm a `KeyframeTrack` implements; keeping it here makes the measured
 * cost attributable to a specific search strategy.
 */
function sampleLinear(track: Track, time: number): number {
  const { times, values } = track;
  const count = times.length;
  if (count === 0) return 0;
  if (count === 1 || time <= times[0]) return values[0];
  if (time >= track.lastTime) return values[count - 1];

  // Binary search for the last index whose time is <= `time`.
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (times[mid] <= time) low = mid;
    else high = mid - 1;
  }
  if (low >= count - 1) return values[count - 1];

  const span = times[low + 1] - times[low];
  const t = span <= 0 ? 0 : (time - times[low]) / span;
  return values[low] + (values[low + 1] - values[low]) * t;
}

const shortTrack = makeTrack(16, 4);
const longTrack = makeTrack(512, 4);
const hugeTrack = makeTrack(4096, 60);

/** Fixed sample times, so the search path (not the input) is what varies. */
const sampleTimes = new Float64Array(1024);
for (let i = 0; i < sampleTimes.length; i++) {
  sampleTimes[i] = (i / sampleTimes.length) * 3.9;
}

/* -------------------------------------------------------------------------- */
/* Easing curves                                                              */
/* -------------------------------------------------------------------------- */

const t = 0.37;

const ease =
  {
    linear: (x: number): number => x,
    quadIn: (x: number): number => x * x,
    quadOut: (x: number): number => x * (2 - x),
    cubicInOut: (x: number): number =>
      x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2,
    smoothstep: (x: number): number => x * x * (3 - 2 * x),
    backOut: (x: number): number =>
      1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2),
  } as const;

/* -------------------------------------------------------------------------- */
/* Quaternion animation                                                       */
/* -------------------------------------------------------------------------- */

/** 64 sequential keyframe rotations, as a skeletal track would store them. */
const rotationKeys: Quat[] = [];
for (let i = 0; i < 64; i++) {
  rotationKeys.push(Quat.fromAxisAngle(new Vec3(0, 1, 0), (i / 64) * Math.PI * 2));
}

const sampleQuat = new Quat();
const sampleVec = new Vec3();

/** 32 nodes' matrices, for the skinning-shaped transform bench. */
const nodeMatrices: Mat4[] = [];
for (let i = 0; i < 32; i++) {
  const m = new Mat4();
  m.compose(
    new Vec3(i * 0.5, Math.sin(i) * 2, 0),
    rotationKeys[i % rotationKeys.length],
    Vec3.one(),
  );
  nodeMatrices.push(m);
}

/* -------------------------------------------------------------------------- */
/* Clock                                                                      */
/* -------------------------------------------------------------------------- */

const clock = new Clock();
clock.start();

/* -------------------------------------------------------------------------- */
/* Benches                                                                    */
/* -------------------------------------------------------------------------- */

describe('keyframe sampling', () => {
  bench('sample 16-key track × 1 024 times', () => {
    // A short track: the binary search should terminate almost immediately, so this is
    // close to the floor for a whole animation track per frame.
    let total = 0;
    for (let i = 0; i < sampleTimes.length; i++) total += sampleLinear(shortTrack, sampleTimes[i]);
    if (total === Number.POSITIVE_INFINITY) throw new Error('unreachable');
  });

  bench('sample 512-key track × 1 024 times', () => {
    // 32× the keys, 5 more binary-search steps. **If this bench is far worse than the
    // 16-key one, the search has regressed to a linear scan.**
    let total = 0;
    for (let i = 0; i < sampleTimes.length; i++) total += sampleLinear(longTrack, sampleTimes[i]);
    if (total === Number.POSITIVE_INFINITY) throw new Error('unreachable');
  });

  bench('sample 4 096-key track × 1 024 times', () => {
    // The worst realistic track. Still only ~12 binary-search steps, so it should track
    // the 512-key figure closely.
    let total = 0;
    for (let i = 0; i < sampleTimes.length; i++) total += sampleLinear(hugeTrack, sampleTimes[i]);
    if (total === Number.POSITIVE_INFINITY) throw new Error('unreachable');
  });
});

describe('easing curves', () => {
  bench('linear', () => {
    void ease.linear(t);
  });

  bench('cubicInOut (two branches, one pow)', () => {
    // The heaviest common curve, included as the upper bound for an easing evaluation.
    void ease.cubicInOut(t);
  });

  bench('smoothstep (polynomial only)', () => {
    // Should sit far below `cubicInOut`: no `Math.pow`, no branch.
    void ease.smoothstep(t);
  });

  bench('evaluate all six curves', () => {
    // A UI frame evaluating a curve per animated property, which is the realistic shape.
    void ease.linear(t);
    void ease.quadIn(t);
    void ease.quadOut(t);
    void ease.cubicInOut(t);
    void ease.smoothstep(t);
    void ease.backOut(t);
  });
});

describe('quaternion animation', () => {
  bench('slerp 64 sequential keyframes', () => {
    // An animation mixer blending one track for one frame. `slerp` does a `sin`/`cos`
    // per call, so this bench is dominated by transcendental cost.
    for (let i = 0; i < rotationKeys.length - 1; i++) {
      sampleQuat.slerpQuaternions(rotationKeys[i], rotationKeys[i + 1], 0.5);
    }
  });

  bench('apply 32 node matrices to a vector', () => {
    // The skinning-shaped inner loop: one matrix-vector transform per bone.
    for (let i = 0; i < nodeMatrices.length; i++) {
      sampleVec.set(i, -i, 0.5).applyMat4(nodeMatrices[i]);
    }
  });

  bench('interpolate a 32-bone pose (slerp + transform)', () => {
    // The composite: what a mixer does per frame for a modest rig.
    for (let i = 0; i < nodeMatrices.length; i++) {
      const a = rotationKeys[i % rotationKeys.length];
      const b = rotationKeys[(i + 1) % rotationKeys.length];
      sampleQuat.slerpQuaternions(a, b, 0.4);
      sampleVec.set(i * 0.1, 0, 0).applyQuat(sampleQuat);
    }
  });
});

describe('clock', () => {
  bench('Clock.getDelta', () => {
    // Called once per frame by the application, plus once per renderer loop. Regresses
    // if it drops the monotonic-clock fast path.
    clock.getDelta();
  });

  bench('Clock.getDeltaMilliseconds', () => {
    // The same read, scaled; should track the bench above.
    clock.getDeltaMilliseconds();
  });

  bench('Clock.fixedStepCount', () => {
    // Accumulator arithmetic for a fixed-timestep update loop.
    clock.fixedStepCount(0.016, 1 / 60);
  });
});
