# 2D basics

The smallest useful `@dxyl/graphics` program: pick a backend at runtime, hand the renderer a plain object graph, and draw with the Canvas2D painter.

## What it shows

- **Runtime backend selection.** `detectBackendStrict([BackendNames.Canvas2D, BackendNames.SVG], canvas)`
  returns `null` rather than silently falling back, which is what makes it the right
  call for feature detection. (`detectBackend` always returns *something* and falls
  back to `'canvas2d'`.)
- **The structural scene contract.** `Canvas2DRenderer.render(scene, camera)` does not
  need a `Scene2D`. It asks the scene for `collectRenderables(list, camera)` first, then
  falls back to `scene.children` (submitting every child that has a `render` method),
  then to the scene itself. So `{ children: [...] }` is a scene and any object with
  `visible` + `render(painter)` is a renderable.
- **World-space camera semantics.** The Canvas2D backend maps world units onto the
  canvas with `+Y` pointing **up** and the world origin at the centre of the viewport;
  `camera.zoom` is world-units-to-logical-pixels. Nothing in `main.ts` flips `y`.
- **Frame-rate independence.** The animation-loop callback receives `delta` in
  **seconds**, so motion is expressed in units per second.

## How to run it

From the repository root:

```bash
pnpm exec vite examples/2d-basic
```

Vite treats `examples/2d-basic/` as the project root; the `../../src/index` import in
`main.ts` resolves to the library source, so no build step is required. The dev server
prints the URL it is listening on.

## What to look for

- Three squares drifting and spinning. `depth` puts the lighter one behind the others;
  the renderer sorts opaque draws by `renderOrder`, then material, then depth.
- The overlay in the top-left reports FPS, the active backend (`canvas2d`), the number
  of draw calls this frame, and the current zoom.
- Resize the window: the canvas and the world/viewport mapping follow, because the
  renderer is constructed with `autoResize: true`.
- If the browser cannot create a 2D canvas context, a readable notice is shown instead
  of a blank page or an exception.

## Key API

| Call | Purpose |
| --- | --- |
| `new Canvas2DRenderer({ canvas, clearColor, autoResize })` | Creates the backend and binds the surface. |
| `renderer.setAnimationLoop(cb, { autoStart: true })` | Installs and starts the loop; `cb(timeMs, deltaSeconds)`. |
| `renderer.render(scene, camera)` | Walks the scene and draws it. |
| `renderer.stats.drawCalls` / `.fps` | Per-frame counters for the overlay. |
| `renderer.setAnimationLoop(null)` + `renderer.dispose()` | Releases the loop, listeners and context. |

## Files

| File | Contents |
| --- | --- |
| `index.html` | Complete page: canvas, overlay, notice, styles. |
| `main.ts` | The `Box` renderable and the bootstrap. |
| `README.md` | This file. |
