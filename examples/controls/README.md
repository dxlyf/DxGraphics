# Controls

Pan, zoom and rotate. The controls layer ships `OrbitControls`, `MapControls`, `TrackballControls`, `FlyControls`, `FirstPersonControls`, pointer/touch and gesture controls, and this example drives the camera itself so you can see the raw pointer maths the controls are built on.

## What it shows

> **Note:** this module is still stabilising — `src/controls/` is an **empty directory**. There is no `OrbitControls`, `MapControls` or pointer abstraction to import, so `main.ts` writes the gesture handling itself. Everything below is verified library behaviour, not a stand-in for a missing API.

- **Pointer capture.** `setPointerCapture` on `pointerdown` means a drag that leaves the canvas keeps tracking, and both `pointerup` and `pointercancel` are handled so a cancelled gesture cannot leave the controls stuck in a drag.
- **Non-passive wheel.** `wheel` is registered with `{ passive: false }` so `preventDefault()` can suppress page scroll — without that the page scrolls while the scene zooms.
- **Zoom about the cursor.** The world point under the pointer is computed before and after the scale change with the same transform the backend applies, then the camera is moved by the difference expressed in the rotated world frame. That is what makes zoom feel anchored rather than centre-locked.
- **Rotation-aware panning.** Pan deltas are rotated into the camera's frame, so dragging right moves the world right even after the view has been rotated.
- **The camera is a plain object.** `RenderContext.getCamera2DTransform` reads `camera.position.{x,y}`, `camera.zoom` and `camera.rotation` structurally. No library camera class is required, which is also why this works with the SVG backend unchanged.
- **The documented transform.** `translate(centre − position · zoom)`, then `rotate(−rotation)`, then `scale(zoom, −zoom)`. The `−zoom` on the Y axis is why world `+Y` points up while canvas `+Y` points down.

## What to look for

- A 7×7 grid of tinted cells plus a red `+X` and green `+Y` axis marker. Rotating the view rotates the axes too, which proves the rotation is a camera transform rather than a per-object spin.
- **Left-drag or one-finger drag** pans. **Shift-drag or right-drag** rotates. **Wheel** zooms about the cursor. **Double-click** resets.
- The overlay reports the camera position, zoom, rotation in degrees, which gesture is active, and how many input events have been handled.

## Key API

| Call | Purpose |
| --- | --- |
| `{ position: {x,y}, zoom, rotation }` | The structural camera the 2D backends read. |
| `canvas.setPointerCapture(id)` | Keeps a drag alive outside the canvas. |
| `addEventListener('wheel', h, { passive: false })` | Required for `preventDefault()`. |
| `renderer.width` / `renderer.height` | Logical size, for screen↔world maths. |

## How to run it

From the repository root:

```bash
pnpm exec vite examples/controls
```

Vite uses `examples/controls/` as the project root, and the `../../src/index` imports in
`main.ts` resolve to the library source, so there is no build step and no `dist/`
requirement. The dev server prints the URL it is listening on.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Complete page: host element, overlay, gesture hint, styles. |
| `main.ts` | The demonstration. |
| `README.md` | This file. |
