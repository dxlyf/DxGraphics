# Text

Text measurement, alignment and layout, all built from `measureText` — the only source of layout truth the platform gives you.

**Backend:** Canvas2D

## What it shows

A greedy word-wrap engine driven entirely by measured widths, with no character-count or average-glyph estimate anywhere.
The three `textAlign` values drawn against one shared vertical ruler, so their meanings are unambiguous.
The five `textBaseline` values, with the `alphabetic` anchor line drawn explicitly.
`fillText` with and without `maxWidth` — the fourth argument condenses the run rather than clipping it.
`strokeText` under `fillText` for an outlined heading, and the ordering that makes it work.
Per-style metrics: width, and `actualBoundingBoxAscent`/`Descent` where the context reports them.

## What to look for

A paragraph wrapped to a fixed 380 px column with a dashed amber guide marking the wrap limit, plus a metrics table for five font stacks.

Change the browser's default font size and the wrap re-flows — because the widths came from the font, not from an assumption about glyph widths. The overlay's `longest line` should always be within the wrap limit.

## Running it

From the repository root:

```bash
pnpm exec vite examples/text
```

Vite treats `examples/text/` as the project root, so the `../../src/index` imports resolve to
the library source with no build step. The full source is in
[`../../examples/text/`](../../../examples/text/README.md).