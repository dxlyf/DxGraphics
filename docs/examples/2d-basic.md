# 2D basics

The smallest useful program: choose a backend, hand the renderer a plain object graph, and draw with the Canvas2D painter.

**Backend:** Canvas2D

## What it shows

Runtime backend selection with `detectBackendStrict`, which returns `null` rather than silently falling back to Canvas2D.
The structural scene contract: the renderer asks for `collectRenderables`, then `children`, then the scene itself — so a plain `{ children: [...] }` object is a scene and any object with `visible` + `render(painter)` is a renderable.
World-space camera semantics: world `+Y` points **up** and the origin is the centre of the viewport, so nothing in `main.ts` flips a Y coordinate.
Frame-rate independence from the `delta` the animation loop supplies, in seconds.

## What to look for

Three squares drifting and spinning, with `depth` ordering them so the lighter one paints behind.
The overlay in the top-left reports FPS, the active backend (`canvas2d`), the draw-call count and the current zoom.
Resizing the window re-reads the CSS size, because the renderer runs with `autoResize: true`.

That `depth` is a *sort key*, not a z-buffer: the Canvas2D backend has no depth buffer, so ordering is entirely the render queue's business.

## Running it

From the repository root:

```bash
pnpm exec vite examples/2d-basic
```

Vite treats `examples/2d-basic/` as the project root, so the `../../src/index` imports resolve to
the library source with no build step. The full source is in
[`../../examples/2d-basic/`](../../../examples/2d-basic/README.md).