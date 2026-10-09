# Text

Measuring, aligning and laying out glyphs on the Canvas2D backend.

## What it shows

> **Note:** this module is still stabilising — `src/text/` is an **empty directory**: there is no `Font`, `GlyphAtlas`, `TextLayout` or SDF text. What exists is the text surface the painter provides, and that is what this example uses.

- **`measureText` as the only source of layout truth.** `main.ts` contains a greedy word-wrap engine built entirely from `painter.measureText(candidate).width`. No character-count or average-glyph-width estimate appears anywhere.
- **Metrics that are actually reported.** `PainterTextMetrics` carries `width`, plus `actualBoundingBoxAscent` and `actualBoundingBoxDescent` when the context supplies them. The example prints all three per style, so you can see which the browser provides.
- **The three `textAlign` values** (`left`, `center`, `right`) drawn against one shared vertical ruler, so their meanings are unambiguous rather than inferred.
- **The five `textBaseline` values** (`top`, `middle`, `bottom`, `alphabetic`, `hanging`), with the `alphabetic` anchor line drawn explicitly.
- **`fillText` with and without `maxWidth`.** The fourth argument condenses the run instead of clipping it, which is easy to get wrong.
- **`strokeText` under `fillText`** for an outlined heading, and the ordering that makes it work.
- **`Text2D` exists.** `src/scene/2d/Text2D.ts` is real and provides `setText`, `measure(painter)`, `getLines()`, `font`, `fontSize`, `align` and `baseline`. It is a scene node, not a layout engine: it has no `render()` implementation yet, which is exactly why this example drives the painter directly.

## What to look for

- A paragraph wrapped to a fixed 380 px column, with a dashed amber guide marking the wrap limit. Change the browser's default font size and the wrap re-flows — because the wrap came from `measureText`, not from an assumption about glyph widths.
- The `measureText` table listing five font stacks with measured width, ascent and descent for the string `Hamburgefonstiv` (a sample that exercises ascenders, descenders and wide glyphs).
- The overlay reports the number of laid-out lines, the measured width of the longest line, and the first sample's metrics — so the numbers on screen can be cross-checked against the layout.

## Key API

| Call | Purpose |
| --- | --- |
| `painter.font` | CSS font shorthand, same syntax as the canvas context. |
| `painter.textAlign` | `'left' \| 'center' \| 'right'`. |
| `painter.textBaseline` | `'top' \| 'middle' \| 'bottom' \| 'alphabetic' \| 'hanging'`. |
| `painter.measureText(text)` | `{ width, actualBoundingBoxAscent?, actualBoundingBoxDescent? }`. |
| `painter.fillText(text, x, y, maxWidth?)` | Draws; `maxWidth` condenses. |
| `painter.strokeText(text, x, y, maxWidth?)` | Outlines. |

## How to run it

From the repository root:

```bash
pnpm exec vite examples/text
```

Vite uses `examples/text/` as the project root, and the `../../src/index` imports in
`main.ts` resolve to the library source, so there is no build step and no `dist/`
requirement. The dev server prints the URL it is listening on.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Complete page: host element, overlay, styles. |
| `main.ts` | The demonstration. |
| `README.md` | This file. |
