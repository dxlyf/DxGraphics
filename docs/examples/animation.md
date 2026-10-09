# Animation

Keyframe interpolation, easing, and two time sources that stay independent of each other and of the frame rate.

**Backend:** Canvas2D

## What it shows

`Clock` as the single source of authored time, with `getDelta()` in **seconds** and a clamp so a backgrounded tab cannot teleport the animation.
`Timer` driving a fixed-cadence event at 6 Hz, independent of how fast frames arrive, with `onTick` returning an unsubscribe.
A keyframe track sampled by hand — a sorted `{ time, value }` list with linear interpolation and clamping outside its range — so the mechanism is visible rather than hidden inside a mixer.
Two easings: `smoothstep` (zero first *and* second derivative at both ends) and a back-ease that overshoots.
A headless sanity assertion of the sampler using `ManualClock`, which runs before any DOM is touched.

## What to look for

A blue ball tracing a keyframed path, with a translucent purple ghost alongside it following the same track through the eased time remap — so it arrives late and overshoots the corners.

Throttle the CPU in DevTools: the halo keeps its 6 Hz cadence even as the frame rate collapses, because the `Timer` is not driven by the render loop. The progress bar shows the looping cycle position.

## Running it

From the repository root:

```bash
pnpm exec vite examples/animation
```

Vite treats `examples/animation/` as the project root, so the `../../src/index` imports resolve to
the library source with no build step. The full source is in
[`../../examples/animation/`](../../../examples/animation/README.md).