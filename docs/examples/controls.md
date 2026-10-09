# Controls

Pan, zoom and rotate gesture handling, and the camera transform the 2D backends actually apply.

**Backend:** Canvas2D

## What it shows

Pointer capture on `pointerdown`, so a drag that leaves the canvas keeps tracking — with both `pointerup` and `pointercancel` handled.
A non-passive `wheel` listener, which is what allows `preventDefault()` to stop the page scrolling while the scene zooms.
Zoom about the **cursor**: the world point under the pointer is computed before and after the scale change and the camera is moved by the difference, expressed in the rotated world frame.
Rotation-aware panning, so dragging right moves the world right even after the view is rotated.
The documented 2D camera transform — `translate(centre ? position ' zoom)`, `rotate(?rotation)`, `scale(zoom, ?zoom)` — which is why world `+Y` points up.

## What to look for

A 7—7 grid of tinted cells with red `+X` and green `+Y` axis markers.

Rotating the view rotates the axes too, which proves the rotation is a camera transform rather than a per-object spin. Left-drag pans, shift-drag or right-drag rotates, wheel zooms, double-click resets.

## Running it

From the repository root:

```bash
pnpm exec vite examples/controls
```

Vite treats `examples/controls/` as the project root, so the `../../src/index` imports resolve to
the library source with no build step. The full source is in
[`../../examples/controls/`](../../../examples/controls/README.md).