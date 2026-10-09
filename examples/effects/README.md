# Effects

Compositing on the CPU backend — and the offscreen buffer that stands in for render-to-texture.

## What it shows

> **Note:** this module is still stabilising — `src/effects/` is an **empty directory**. There is no `EffectComposer`, bloom, shadow-map pass or fog implementation. A GPU post-processing layer needs render targets, and `Canvas2DRenderer.createRenderTarget()` deliberately throws because the 2D backend can only draw into its own canvas. This example therefore demonstrates the compositing toolkit that *does* exist.

- **`globalCompositeOperation`.** Eight modes (`source-over`, `multiply`, `screen`, `overlay`, `difference`, `lighter`, `hue`, `color-dodge`) applied to the same two shapes, so the differences are directly comparable. `lighter` is the additive mode a glowing effect would build on.
- **An offscreen `<canvas>` as a render target.** It is allocated once, redrawn only a few times per second, and blitted into the scene with `drawImage`. This is the practical CPU substitute for render-to-texture, and the example shows the full lifecycle: allocate, draw, blit, release.
- **`shadowBlur` for cheap glows.** One pass over a rounded rect gives a soft drop shadow without a blurred copy.
- **Gradients.** A linear sheen across the card and a radial glow, the latter clipped to the card's rounded outline with `clip()`.
- **`globalAlpha` for layering**, restored to `1` after each use so state cannot leak forward.
- **Explicit resource release.** `dispose()` shrinks the offscreen canvas to 1×1 so the browser can reclaim the surface immediately rather than waiting for GC.

## What to look for

- The swatch row: each cell is a gradient square with an identical translucent disc composited over it using a different blend mode. Hover a swatch and the overlay names the mode.
- The card on the right: a shadowed panel, a linear sheen, a clipped radial spotlight, and a rotated badge blitted from the offscreen buffer. The badge's hard cut-out holes prove it is a separate surface rather than a drawn shape.
- The overlay reports the offscreen buffer dimensions, its usability, the canvas size, and `painter.commandCount`.

## Key API

| Call | Purpose |
| --- | --- |
| `painter.globalCompositeOperation` | Any CSS blend mode or Porter–Duff operator. |
| `painter.shadowBlur` / `shadowColor` / `shadowOffsetX` / `shadowOffsetY` | Drop shadows and glows. |
| `painter.clip(path?)` | Masks subsequent drawing to the current path. |
| `painter.drawImage(image, { dx, dy, dw, dh, sx, sy, sw, sh })` | Blits, including from an offscreen canvas. |
| `painter.createRadialGradient(x0, y0, r0, x1, y1, r1)` | Returns `CanvasGradient \| null`. |
| `renderer.createRenderTarget(...)` | **Throws** on this backend — use an offscreen canvas instead. |

## How to run it

From the repository root:

```bash
pnpm exec vite examples/effects
```

Vite uses `examples/effects/` as the project root, and the `../../src/index` imports in
`main.ts` resolve to the library source, so there is no build step and no `dist/`
requirement. The dev server prints the URL it is listening on.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Complete page: host element, overlay, styles. |
| `main.ts` | The demonstration. |
| `README.md` | This file. |
