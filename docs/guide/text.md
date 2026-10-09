# Text

Fonts, glyph atlases, layout and SDF text.

> **Note:** `src/text/` has landed and exports the classes below. Treat the API as accurate (it is
> read from the source) and the behaviour as unproven against the examples.

## Two paths, for two situations

| Situation | Use |
| --- | --- |
| The Canvas2D backend, a debug overlay, a one-off label | `Canvas2DPainter.fillText` + `measureText`. The platform's own font stack, no atlas. |
| The SVG backend | `SVGPainter.text`, styled with CSS. Real text, selectable and searchable. |
| The GPU backends, or a shared glyph cache | `Font` + `GlyphAtlas` + `TextLayout`. |

The first two are the platform doing the work and need no text layer at all. The third is what
`src/text/` is for.

## The platform path

```ts
import { Canvas2DPainter, Canvas2DRenderer } from '@dxyl/graphics';

const painter = renderer.painter;

painter.font = '600 15px ui-sans-serif, system-ui, sans-serif';
painter.textAlign = 'left';
painter.textBaseline = 'alphabetic';

const metrics = painter.measureText('Canvas2DPainter');
metrics.width;                              // advance width, in user-space units
metrics.actualBoundingBoxAscent;            // present when the context reports it
metrics.actualBoundingBoxDescent;

painter.fillText('Canvas2DPainter', x, y);
painter.strokeText('outlined', x, y);
painter.fillText('condensed', x, y, 120);   // the 4th argument condenses; it does not clip
```

The three facts that make layout work:

1. **`measureText` is the only source of layout truth.** A character-count or average-glyph-width
   estimate is wrong for every font, and `actualBoundingBox*` are optional because not every
   context reports them — so a wrap engine must degrade to `width` alone.
2. **`fillText`'s fourth argument condenses** the run to fit rather than clipping it. That is the
   spec, and it is easy to assume otherwise.
3. **`textBaseline` moves the anchor, not the glyph.** `'alphabetic'` is the baseline you draw
   against; `'top'`, `'middle'` and `'bottom'` are the em box; `'hanging'` is a Devanagari
   convention. Drawing the baseline rule makes the difference visible, which is what
   `examples/text` does.

A `measureText`-driven word wrap, in full:

```ts
function wrap(painter: Canvas2DPainter, text: string, maxWidth: number): { text: string; width: number }[] {
  const lines: { text: string; width: number }[] = [];
  let current = '';

  for (const word of text.split(/\s+/)) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (painter.measureText(candidate).width <= maxWidth || current.length === 0) {
      current = candidate;
      continue;
    }
    lines.push({ text: current, width: painter.measureText(current).width });
    current = word;
  }
  if (current.length > 0) lines.push({ text: current, width: painter.measureText(current).width });
  return lines;
}
```

## The font and atlas path

```ts
import { Font, Glyph, GlyphAtlas, createFallbackFont } from '@dxyl/graphics';

const font = new Font({
  name: 'Fixture Mono',
  size: 16,
  lineHeight: 19,
  atlasWidth: 64,
  atlasHeight: 32,
  // plus whatever FontOptions requires — read the interface for the full set
});

font.addGlyph(new Glyph({ id: 65, x: 0, y: 0, width: 9, height: 11, xOffset: 0, yOffset: 4, xAdvance: 9 }));
font.addWhitespace(32, 8);
font.addKerning(65, 66, -1);

font.getGlyph('A');            // Glyph | undefined
font.hasGlyph('A');
font.getAdvance(65);           // advance width, with the font's fallback
font.getKerning(65, 66);       // the pair adjustment
font.getGlyphUV('A');          // GlyphUV | null — the atlas rectangle, padding included
font.getLineHeight();
font.getScaleForSize(24);      // to render at a size other than the atlas' own
font.getBaselineOffset();
font.getTexture();             // TextureLike | null — the atlas texture
font.getAtlasSize();           // { width, height }
```

`GlyphAtlas` owns the packing, which is the part with real algorithms in it:

```ts
const atlas = new GlyphAtlas({ /* GlyphAtlasOptions */ });

atlas.pack({ id: 65, width: 9, height: 11 });
atlas.packAll(requests);          // a batch, packed together
atlas.tryGrow();                  // enlarge when full; returns whether it succeeded
atlas.resizeToPowerOfTwo();       // for a backend that needs POT dimensions
atlas.getRegion('A');             // GlyphRegion | null
```

`tryGrow()` returning a boolean is the contract that matters: a caller must handle "the atlas is
full and cannot grow", usually by falling back to a second atlas or a smaller size, rather than
silently dropping glyphs.

## Layout

```ts
const result = font.layout('Hello, world', style, maxWidth);
```

`Font.layout(text, style, maxWidth)` returns a `LayoutResult`. `TextLayout.ts` is the standalone
implementation of the same thing, and `TextStyle.ts` holds the style description — font, size,
line height, alignment, wrapping and letter spacing. Passing a plain number as `style` is
shorthand for that font size.

Two behaviours to decide deliberately:

- **A word longer than `maxWidth`.** Either emit it on its own overlong line (what the example
  does) or break it mid-word. Both are defensible; neither is obviously right, so pick and
  document.
- **An unsupported codepoint.** `Font.getGlyph` returns `undefined` rather than a substitute glyph,
  so the caller decides whether to skip it, draw a fallback box, or switch to another font —
  which is what `createFallbackFont(options)` and `Font.asProvider()` are for.

## SDF text

`SDFText.ts` generates signed-distance-field glyphs from a source, so one atlas resolution stays
sharp at any rendered size. `DEFAULT_SDF_RADIUS` (8) is the distance-range spread.

```ts
import { SDFText } from '@dxyl/graphics';

const sdf = new SDFText({ /* options */ });
```

The trade is the usual one: a per-glyph generation cost and a wider texture format (a distance
needs more than one bit of precision) in exchange for one atlas serving every size, which is what
makes scalable text affordable on a GPU backend.

## The 2D scene node

`Text2D` is the scene-graph node for text, and it is real:

```ts
import { Text2D } from '@dxyl/graphics';

const label = new Text2D({
  text: 'Hello',
  font: '14px ui-sans-serif, system-ui, sans-serif',
  align: 'left',
  baseline: 'alphabetic',
});

label.setText('Hello, world', true);   // `true` re-measures and resizes the node
label.measure(painter);                // { width, height }
label.getLines();
label.updateFont();
```

> **Note:** `Text2D.render(painter)` is a no-op in this checkout — the 2D nodes describe
> themselves but do not paint. Call `measure(painter)` and draw with `painter.fillText` yourself,
> or use `TextRenderer`.

## Bitmap fonts

`FontLoader` reads the BMFont text format that `tests/fixtures/data/glyphs.fnt` demonstrates:

```
info face="Fixture Mono" size=16 bold=0 italic=0 charset="" unicode=1 ...
common lineHeight=19 base=15 scaleW=64 scaleH=32 pages=1 packed=0
page id=0 file="fixture-mono.png"
chars count=5
char id=65 x=0 y=0 width=9 height=11 xoffset=0 yoffset=4 xadvance=9 page=0 chnl=15
kernings count=1
kerning first=65 second=66 amount=-1
```

The `xoffset`/`yoffset`/`xadvance` triple is the part a naive parser gets wrong: `x`/`y`/`width`/
`height` are the **atlas** rectangle, while `xoffset`/`yoffset` are where the glyph sits relative
to the pen and `xadvance` is how far the pen moves afterwards. Using `x`/`y` as the draw position
produces text that is systematically offset.

## Choosing a path

| Need | Path |
| --- | --- |
| A label on a Canvas2D or SVG canvas | The platform painter. Nothing else needed. |
| Selectable or searchable text | `SVGPainter.text`, so it stays real DOM. |
| Text on a GPU backend | `Font` + `GlyphAtlas` + `TextLayout`, or `SDFText`. |
| Text that scales without re-rasterising | `SDFText`. |
| A bitmap font shipped with a game | `FontLoader` → `Font`. |
| Wrapping and measuring in a test | `Font.layout`, which needs no painter. |

## See also

- [effects.md](effects.md) — shadows and gradients behind text.
- [examples/text](../../examples/text/README.md) — measured wrap, alignment and baseline samples.
- [`tests/fixtures/README.md`](../../tests/fixtures/README.md) — the BMFont fixture.
