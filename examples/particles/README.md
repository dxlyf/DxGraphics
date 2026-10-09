# Particles

A pooled particle simulation, drawn with Canvas2D.

## What it shows

- **`ParticleSystem` as the simulation.** It owns the pool, the emitter and the per-particle buffers; this example only reads those buffers and paints them. Integration is semi-implicit Euler (velocity with gravity and drag first, then position), which stays stable at any step size a frame loop produces.
- **`ParticleEmitter` for the spawn distribution.** Four presets exercise the `'cone'`, `'circle'`, `'sphere'` and `'box'` shapes, with different `speed`, `lifetime`, `gravity`, `drag`, `spread` and `emitFromEdge` settings.
- **The layout invariant that matters.** Live particles always occupy slots `0 .. getAliveCount() - 1`: killing a particle swaps the last live one into the hole. So the draw loop is a plain `for`, not a scan for live flags. If you remember one thing about the buffers, remember this.
- **Structure-of-arrays reading.** Positions (`xyz`), colours (`rgba`), sizes, rotations, UVs and life (`life01`, `remaining`) live in separate typed arrays. `getPositionAttribute()` and friends return `BufferAttribute` views over them, so the same data can be uploaded to a GPU without a copy.
- **Additive compositing.** `globalCompositeOperation = 'lighter'` makes overlapping particles accumulate into a bright core, which is what makes the fountain read as fire rather than confetti. The smoke preset deliberately uses `'source-over'` so it occludes instead of glows.
- **A sprite cache, because the obvious approach is too slow.** Building a radial gradient per particle per frame puts essentially all the cost in `createRadialGradient` and re-rasterisation. Instead each preset's glow is rasterised **once** and blitted per particle with `drawImage`; the per-particle colour comes from a tinted copy cached by a quantised colour key. The overlay reports how many distinct tints a frame actually used.
- **A headless sanity check** at the top of `main.ts`, before any DOM access. It asserts that emission produces particles, that the pool cannot overflow, that everything dies after its lifetime when emission stops, and that spawn/kill accounting balances — so a leaking pool or a broken emitter throws at load rather than drawing a blank canvas.

## What to look for

| Preset | Key | Why it looks the way it does |
| --- | --- | --- |
| `fountain` | `1` | A narrow upward cone with gravity and light drag: particles arc over and fall back. They **shrink** toward `endSize`, so the plume tapers. |
| `smoke` | `2` | A ring source emitting upward from its edge, with heavy drag and *rising* gravity. Smoke **grows** toward `endSize`, the opposite of the fountain. |
| `burst` | `3` | Emission driven by `burst`/`burstInterval` rather than a rate, from a sphere's surface. Fast, short-lived, additive. |
| `sparks` | `4` | A flat box source with high speed, strong gravity and large angular velocity, drawn as elongated streaks instead of soft glows. |

The canvas is **faded** rather than cleared between frames (a `rgba(8, 10, 16, 0.28)` fill), so fast particles leave a short trail. A full clear makes them strobe.

Drag the pointer to move the emitter; new particles appear from there while the live ones keep their own trajectories.

## Key API

| Call | Purpose |
| --- | --- |
| `new ParticleSystem({ maxParticles, emissionRate, loop, seed, emitter, material })` | `emitter` and `material` accept either an instance or an options record. |
| `system.update(delta)` | Advances emission and simulation; returns the live count. |
| `system.getAliveCount()` | Live particles; also the exclusive bound of the live slot range. |
| `system.getPositionAttribute()` / `getColorAttribute()` / `getSizeAttribute()` / `getRotationAttribute()` / `getUvAttribute()` | `BufferAttribute` views. `life` has no dedicated accessor — use `getAttribute('life')`. |
| `system.getStats()` | `{ alive, spawned, killed, capacity, utilization, emissionAccumulator, emissionRemaining, emitting }`. |
| `system.start()` / `stop()` / `reset()` | Resume emission, pause it, clear live particles. |
| `system.emitter.position` | Emitter origin, in emitter-local space. |
| `new ParticleEmitter({ shape, direction, spread, radius, coneHeight, boxSize, emitFromEdge, speed, lifetime, size, endSize, color, endColor, rotation, angularVelocity, gravity, drag, burst, burstInterval, seed })` | The spawn distribution. |
| `system.dispose()` | Releases the pool; `ParticleSystem` extends `Disposable`. |

`shape` is one of `'point' | 'sphere' | 'box' | 'cone' | 'circle'`, and each shape ignores the fields that do not apply to it.

## How to run it

From the repository root:

```bash
pnpm exec vite examples/particles
```

Vite uses `examples/particles/` as the project root, and the `../../src/index` imports in
`main.ts` resolve to the library source, so there is no build step and no `dist/`
requirement. The dev server prints the URL it is listening on.

## Why the drawing is here and not in the library

`ParticleSystem` produces buffer attributes intended for a `Points` draw with a material — on WebGL those buffers upload directly. Canvas2D has no vertex shader, so this example reads the attributes on the CPU and spends one `drawImage` per particle. The simulation is the library's; only the rasterisation is the example's, and keeping that split visible is the point of the demo.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Complete page: canvas, overlay, key hints, styles. |
| `main.ts` | The four presets, the heatless sanity check, the `Renderable2D` that draws the system, and the input handling. |
| `sprites.ts` | The pre-rendered glow and streak sprites, and why they are pre-rendered. |
| `README.md` | This file. |
