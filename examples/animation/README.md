# Animation

Driving motion from a clock, keyframes and easing.

## What it shows

- **`Clock` as the single source of time.** `getDelta()` returns **seconds** and is clamped, so a backgrounded tab does not teleport the animation. `getDeltaMilliseconds()`, `getElapsedTime()`, `smoothedDelta`, `fps` and `fixedStepCount(delta, step)` are also available.
- **`Timer` for a fixed-cadence event**, independent of the render rate. `Timer.onTick(listener)` returns an unsubscribe function, which the example calls in `dispose()` — the common leak in timer code is forgetting that unsubscribe.
- **Keyframe interpolation written out by hand.** A sorted track of `{ time, value }` pairs is sampled with linear interpolation and clamped outside the track's range, then a second object samples the same track through an easing curve so the difference is directly comparable.
- **Two easing curves.** `smoothstep` (`3x² − 2x³`, zero first *and* second derivative at both ends) and a back-ease that overshoots, which makes the eased ghost visibly lag then overshoot the linear one.
- **`ManualClock` for deterministic time.** The file opens with a headless sanity check that asserts the sampler's boundary and midpoint behaviour using `ManualClock.advance()` — no renderer, no wall clock, no flakiness.

  > **Note:** `src/animation` is present in this checkout and exports `AnimationClip`, `AnimationMixer`, `AnimationAction`, `KeyframeTrack`, `Interpolant`, `Easing`, `Tween`/`Timeline` and `SkeletonUtils`. This example keeps its interpolation inline **on purpose**, so the sampling maths is readable; see `docs/guide/animation.md` for the mixer API.

## What to look for

- A blue ball tracing a keyframed path, with a translucent purple ghost alongside it that follows the same track through the eased time remap — so it arrives late and overshoots the corners.
- A pulsing halo driven by the `Timer` at 6 Hz, **not** by the frame loop. Throttle the CPU in DevTools and the halo keeps its cadence even as the frame rate drops.
- The progress bar along the bottom shows the looping cycle position; the overlay reports the cycle time, the last clock delta in milliseconds, the timer's tick count and the draw-call count.

## Key API

| Call | Purpose |
| --- | --- |
| `new Clock()` | `start()`, `stop()`, `reset()`, `getDelta()`, `getElapsedTime()`. |
| `clock.getDeltaMilliseconds()` | The most recent delta in ms. |
| `new Timer(interval, { autoStart })` | `update(delta)` each frame; `onTick` returns an unsubscribe. |
| `timer.count` | Number of ticks fired. |
| `new ManualClock()` | `advance(delta)` / `setTime(seconds)` for deterministic tests. |

## How to run it

From the repository root:

```bash
pnpm exec vite examples/animation
```

Vite uses `examples/animation/` as the project root, and the `../../src/index` imports in
`main.ts` resolve to the library source, so there is no build step and no `dist/`
requirement. The dev server prints the URL it is listening on.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Complete page: canvas, overlay, progress bar, styles. |
| `main.ts` | The demonstration. |
| `README.md` | This file. |
