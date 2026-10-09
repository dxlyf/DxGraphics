/**
 * `text` — fonts, glyph atlases, layout, SDF generation and text rendering.
 *
 * ```ts
 * import { createFallbackFont, TextLayout, TextStyle, TextRenderer } from '@dxyl/graphics';
 *
 * const font = createFallbackFont({ size: 16 });
 * const layout = new TextLayout(font);
 * const result = layout.layout('Hello world', new TextStyle({ maxWidth: 200 }));
 * const renderer = new TextRenderer(font);
 * const command = renderer.render('Hello world', new TextStyle());
 * ```
 *
 * ## Pipeline
 *
 * ```
 *  FontLoader ──> BitmapFont / Font ──> GlyphAtlas ──> texture
 *                       │                    │
 *                       └── GlyphProvider ───┘
 *                                │
 *                          TextLayout ──> LayoutResult (positioned quads + UVs)
 *                                │
 *                          TextRenderer ──> TextDrawCommand / IRenderPass
 *
 *  SDFText: alpha bitmap ──> exact EDT ──> SDFResult ──> 8-bit texture
 * ```
 *
 * | File | Role |
 * | --- | --- |
 * | {@link Font} | glyph table, kerning, vertical metrics, atlas ownership |
 * | {@link BitmapFont} | BMFont text **and** JSON parsing |
 * | {@link Glyph} | one character's metrics and atlas rectangle |
 * | {@link GlyphAtlas} | shelf packing, power-of-two growth, `GLYPH_PADDING` |
 * | {@link TextLayout} | word wrap, alignment, per-glyph quads and UVs |
 * | {@link TextStyle} | typography as a value, with `clone`/`merge`/`toCss` |
 * | {@link SDFText} | exact Euclidean distance fields, `radius`/`cutoff` |
 * | {@link TextRenderer} | layout → vertex data, commands and `IRenderPass`es |
 *
 * ## Two documented limitations
 *
 * 1. **Left-to-right only.** No bidi algorithm or glyph shaping is applied. See the
 *    `TextLayout` module documentation for exactly what that means.
 * 2. **No rasterisation.** Nothing here turns a font file into pixels: a caller supplies
 *    glyph bitmaps (or uses the synthetic fallback font). That is deliberate — rasterising
 *    needs a host API, and this package has zero dependencies.
 *
 * @packageDocumentation
 */

export * from './Glyph';
export * from './GlyphAtlas';
export * from './TextStyle';
export * from './TextLayout';
export * from './Font';
export * from './BitmapFont';
export * from './SDFText';
export * from './TextRenderer';
export * from './FontLoader';
export type * from './types';
