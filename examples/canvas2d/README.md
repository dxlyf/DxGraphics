# Canvas2D painter

Immediate-mode drawing with `Canvas2DPainter` — the same surface the Canvas2D backend hands to every renderable, driven here on its own.

## What it shows

- **The painter as a standalone drawing API.** No scene graph, no renderables: a single `drawScene(painter, width, height, time)` function issues every command. That is the right shape for a chart, a HUD or a one-shot export.
- **The state stack.** `save()`/`restore()` are paired around every style change, and `painter.depth` reports the live balance. The example exposes the high-water mark so a leak is immediately visible.
- **Paths and primitives.** `beginPath`, `moveTo`, `lineTo`, `bezierCurveTo`, `arc`, `closePath`, plus the convenience builders `rect`, `roundRect`, `ellipse` and `polygon(points, close)`.
- **Stroking details.** `setLineDash`, `lineWidth`, `lineCap`, `lineJoin`, and `stroke()` on the same path that was filled.
- **Gradients as styles.** `createLinearGradient`, `createRadialGradient` and `createConicGradient` all return `CanvasGradient | null`, and `fillStyle`/`strokeStyle` accept either a string or a gradient — the null case is handled rather than assumed away.
- **Text with measurement.** `measureText` drives the panel width, then `fillText` uses `textAlign`/`textBaseline` to place the label and a matching underline.
- **Shadows.** `shadowBlur`, `shadowColor` and `shadowOffsetY` around a rounded rect.
- **Transform resets.** `resetTransform()` at the top of the frame, so nothing accumulates across frames even if a `restore()` is missed.

## What to look for

- A gradient sky, a dashed orbit ring, a clipped inner disc with a conic sweep inside it, three shadowed orbiting satellites, a rotating hexagon drawn with `polygon`, and a shadowed panel whose width came from `measureText`.
- The overlay reports `painter.commandCount` and the state-stack depth. The depth must read `0` between frames — if it ever climbs, a `restore()` is missing, which is the single most common bug in immediate-mode code.
- Resize the window: the composition re-measures and re-lays out from the live canvas size because the renderer runs with `autoResize: true`.

## Key API

| Call | Purpose |
| --- | --- |
| `renderer.painter` | The `Canvas2DPainter` the backend draws through. |
| `painter.save()` / `restore()` / `depth` | The transform and style stack. |
| `painter.createLinearGradient(...)` | Returns `CanvasGradient \| null`. |
| `painter.measureText(text)` | `{ width, actualBoundingBoxAscent?, actualBoundingBoxDescent? }`. |
| `painter.polygon(points, close)` | Builds a closed path from `{ x, y }` pairs. |
| `painter.commandCount` | Number of drawing operations issued. |

## How to run it

From the repository root:

```bash
pnpm exec vite examples/canvas2d
```

Vite uses `examples/canvas2d/` as the project root, and the `../../src/index` imports in
`main.ts` resolve to the library source, so there is no build step and no `dist/`
requirement. The dev server prints the URL it is listening on.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Complete page: host element, overlay, styles. |
| `main.ts` | The demonstration. |
| `README.md` | This file. |
