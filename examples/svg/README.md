# SVG backend

A live, inspectable SVG document instead of a pixel buffer.

## What it shows

- **Real DOM output.** `SVGRenderer` builds a wrapper `<div>`, an `<svg>` root carrying the `viewBox`, a `<defs>` container, a full-viewport background `<rect>`, a world `<g>` that receives the camera transform, and one `<g>` per renderable. Open the element inspector and you can watch `<path>`, `<circle>` and `<text>` nodes update in place.
- **Retained mode, not immediate mode.** Because the output is markup, sizing is expressed through the `viewBox` (which is DPR-independent by design) and the camera is a `transform` attribute rather than a rasterised matrix.
- **The painter has no path API.** `SVGPainter` deliberately exposes `create`, `path`, `rect`, `circle`, `ellipse`, `line`, `polygon`, `polyline`, `text`, `image` and `group` — and **not** `beginPath`/`moveTo`/`lineTo`/`fill`. Renderables therefore branch on which painter they received, so the same object can draw through Canvas2D *or* SVG:

  ```ts
  const isSvg = typeof (painter as { create?: unknown }).create === 'function';
  ```

- **Feature detection before construction.** `SVGRenderer.render()` **throws** when there is no DOM, so this example calls `detectBackendStrict(BackendNames.SVG)` first and then checks `renderer.isLive`, rather than catching an exception after the fact.
- **Serialisation.** `renderer.toSVGString()` returns the current document as standalone SVG, and the overlay reports its size live.

## What to look for

- Four concentric rings of arcs rotating at different speeds and directions, a pulsing dot, and a text label. Because each arc is a separate `<path>` with an `A` command, the ring count and segment count are visible in the DOM.
- Open DevTools → Elements. The `<g data-dxyl-node="…">` groups are per-renderable, so you can hide one and watch the scene change without a re-render.
- In the console, `renderer.toSVGString()` yields a standalone document; the overlay's `markup` figure is that string's length.
- The `<svg>` `viewBox` in the overlay follows the canvas size as you resize the window, because the renderer runs with `autoResize: true` and keeps the `viewBox` in sync.
- If the browser cannot create an SVG root, a readable notice is shown instead of a throw.

## Key API

| Call | Purpose |
| --- | --- |
| `new SVGRenderer({ container, clearColor, autoResize })` | Inserts the root into `container`. |
| `renderer.isLive` | `true` when a DOM-backed `<svg>` root exists. |
| `renderer.svg` / `world` / `defs` / `background` | The managed elements. |
| `renderer.toSVGString()` | Serialises the document. |
| `painter.path('M … A …', attrs)` | Creates a `<path>` from a `d` string. |
| `painter.circle(cx, cy, r, attrs)` / `rect` / `text` | Typed element helpers. |
| `renderer.getOrCreateGroup(object)` | The `<g>` assigned to a renderable. |

## How to run it

From the repository root:

```bash
pnpm exec vite examples/svg
```

Vite uses `examples/svg/` as the project root, and the `../../src/index` imports in
`main.ts` resolve to the library source, so there is no build step and no `dist/`
requirement. The dev server prints the URL it is listening on.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Complete page: `<div>` host, overlay, styles. |
| `main.ts` | The demonstration. |
| `README.md` | This file. |
