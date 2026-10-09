# Effects

The compositing toolkit a CPU backend gives you in place of a post-processing chain, and the offscreen canvas that stands in for a render target.

**Backend:** Canvas2D

## What it shows

Eight `globalCompositeOperation` modes applied to the same pair of shapes, so the differences are directly comparable — including `lighter`, the additive mode a glow builds on.
`shadowBlur`/`shadowColor`/`shadowOffsetY` producing a soft drop shadow in one pass.
A linear sheen and a radial glow, the latter clipped to a rounded outline with `clip()`.
An offscreen `<canvas>` allocated once, redrawn at its own cadence, and blitted with `drawImage` — the practical CPU substitute for render-to-texture.
Explicit release of that surface in `dispose()`, rather than waiting for garbage collection.

## What to look for

A swatch row where each cell composites the same translucent disc using a different blend mode, and a card with a clipped spotlight plus a badge blitted from the offscreen buffer.

The badge's hard cut-out holes prove it came from a separate surface — they are `destination-out` on the offscreen canvas, not shapes drawn onto the main one. Hover a swatch and the overlay names the mode.

## Running it

From the repository root:

```bash
pnpm exec vite examples/effects
```

Vite treats `examples/effects/` as the project root, so the `../../src/index` imports resolve to
the library source with no build step. The full source is in
[`../../examples/effects/`](../../../examples/effects/README.md).