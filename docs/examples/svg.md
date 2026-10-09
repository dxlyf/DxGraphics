# SVG backend

A retained-mode backend: real `<path>`, `<circle>` and `<text>` nodes updated in place instead of a pixel buffer.

**Backend:** SVG

## What it shows

The `viewBox` as the sizing mechanism, which makes the output device-pixel-ratio independent by construction.
One `<g data-dxyl-node="-">` per renderable, inside a `<g data-dxyl-world>` that carries the camera transform.
The painter branch: `SVGPainter` exposes `create` and has **no** `beginPath`/`moveTo`/`fill`, because SVG is markup.
`renderer.toSVGString()` serialising the live document.

## What to look for

Four concentric rings of arcs rotating at different speeds, a pulsing dot, and a text label.

Open the element inspector: the `<g>` groups update in place, and hiding one changes the scene with no re-render. The overlay's `markup` figure is the length of the serialised document.

## Running it

From the repository root:

```bash
pnpm exec vite examples/svg
```

Vite treats `examples/svg/` as the project root, so the `../../src/index` imports resolve to
the library source with no build step. The full source is in
[`../../examples/svg/`](../../../examples/svg/README.md).