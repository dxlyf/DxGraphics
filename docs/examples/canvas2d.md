# Canvas2D painter

`Canvas2DPainter` driven directly, outside a render loop: the surface a chart, a HUD or a one-shot export would use.

**Backend:** Canvas2D

## What it shows

The `save`/`restore` state stack, with `painter.depth` reporting the live balance and the overlay showing the high-water mark.
Paths and primitives: `beginPath`, `moveTo`, `lineTo`, `bezierCurveTo`, `arc`, `closePath`, plus `rect`, `roundRect`, `ellipse` and `polygon`.
Stroking detail: `setLineDash`, `lineWidth`, and `stroke()` on the same path that was filled.
All three gradient constructors, each of which returns `CanvasGradient | null` — handled rather than assumed away.
`measureText` driving a panel's width, then `fillText` placing the label with `textAlign`/`textBaseline`.
`shadowBlur`/`shadowColor`/`shadowOffsetY` around a rounded rect, and a `resetTransform()` at the top of every frame.

## What to look for

A gradient sky, a dashed orbit ring, a clipped inner disc with a conic sweep, three shadowed satellites, a rotating hexagon, and a panel sized from measured text.

`state depth` reads `0` between frames. If it ever climbs, a `restore()` is missing — the single most common bug in immediate-mode code. `painter.commandCount` is the number of drawing operations issued.

## Running it

From the repository root:

```bash
pnpm exec vite examples/canvas2d
```

Vite treats `examples/canvas2d/` as the project root, so the `../../src/index` imports resolve to
the library source with no build step. The full source is in
[`../../examples/canvas2d/`](../../../examples/canvas2d/README.md).