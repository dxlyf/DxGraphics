/**
 * `TextRenderer` — turns a layout into something a renderer can draw.
 *
 * The text system produces *numbers*; a renderer needs *draw commands*. This is the
 * adapter between them, and it offers three output shapes so it can serve three different
 * consumers without any of them having to know about the others:
 *
 * | Output | Consumer |
 * | --- | --- |
 * | {@link TextRenderer.batch} | any renderer: interleaved vertex data |
 * | {@link TextRenderer.render} | an immediate-mode caller: one command per page |
 * | {@link TextRenderer.createRenderPass} | a `RenderPipeline`: a real `IRenderPass` |
 *
 * ## Vertex format
 *
 * `batch()` produces `x, y, u, v` per vertex and **six vertices per glyph** (two
 * triangles), so the stride is 4 floats and a glyph occupies 24 floats. That is the
 * smallest format every backend in this library accepts: Canvas2D and SVG consume the
 * quad list directly, WebGL feeds it to a `TRIANGLES` draw with a 4-float attribute, and
 * WebGPU maps it to one `float32x2` pair for position and one for UV.
 *
 * ## Coordinate space
 *
 * Layout space is **y-down, origin at the block's top-left**, matching how text is
 * authored and how CSS measures it. {@link TextRendererOptions.axis} flips the Y axis in
 * the produced vertices for a backend that uses y-up, rather than making every consumer
 * remember which convention the layout used.
 *
 * ```ts
 * const renderer = new TextRenderer(font);
 * const command = renderer.render('Hello', style);
 * command.vertices;      // Float32Array, x/y/u/v
 * renderer.stats;        // { commands, glyphs, vertices, bytes }
 * ```
 *
 * @packageDocumentation
 */

import { Color } from '../math/Color';
import { createRenderPass, type IRenderPass } from '../renderer/interfaces/IRenderPass';
import type { RenderContext } from '../renderer/core/RenderContext';
import { Disposable } from '../core/Disposable';
import { Font } from './Font';
import { TextLayout, type LayoutResult } from './TextLayout';
import { TextStyle } from './TextStyle';
import type { GlyphProvider, TextDrawCommand, TextRendererOptions, TextRendererStats } from './types';

/** Floats per vertex: `x, y, u, v`. */
export const VERTEX_STRIDE = 4;

/** Vertices per glyph quad. */
export const VERTICES_PER_QUAD = 6;

/** Floats one glyph occupies in the batch. */
export const FLOATS_PER_QUAD = VERTEX_STRIDE * VERTICES_PER_QUAD;

/** One glyph's draw quad, resolved against an atlas. */
export interface RenderQuad {
  /** Left edge in layout space. */
  x: number;
  /** Top edge in layout space. */
  y: number;
  /** Quad width. */
  width: number;
  /** Quad height. */
  height: number;
  /** Left U. */
  u0: number;
  /** Top V. */
  v0: number;
  /** Right U. */
  u1: number;
  /** Bottom V. */
  v1: number;
  /** Atlas page. */
  page: number;
  /** Codepoint, for diagnostics. */
  codepoint: number;
}

/**
 * Converts layouts into draw commands.
 */
export class TextRenderer extends Disposable<'TextRenderer'> {
  /** @inheritdoc */
  public override readonly label = 'TextRenderer' as const;

  /** Font supplying the atlas and the fallback metrics. */
  public font: Font | null;

  /** Layout engine used when the caller does not supply a layout. */
  public readonly layout: TextLayout;

  /** Device-pixel ratio applied to the produced vertex data. */
  public pixelRatio: number;

  /** Y axis direction of the produced vertices. */
  public axis: 'up' | 'down';

  /** Colour applied when a style omits one. */
  public readonly defaultColor: Color;

  /** Blend mode name written into every command. */
  public blendMode: string;

  /** `true` writes SDF-ready commands. */
  public sdf: boolean;

  /** Log canvas size, used by the `IRenderPass` factory. */
  public width = 1;

  /** Log canvas size, used by the `IRenderPass` factory. */
  public height = 1;

  /** Cumulative statistics. */
  public readonly stats: TextRendererStats = { commands: 0, glyphs: 0, vertices: 0, bytes: 0 };

  /** Monotonic draw-order counter. */
  private nextOrder = 0;

  /**
   * Creates a text renderer.
   *
   * @param font Font supplying the atlas, or `null` to require a provider per call.
   * @param options Pixel ratio, axis, colour and blend mode.
   */
  constructor(font: Font | null = null, options: TextRendererOptions = {}) {
    super();

    this.font = font;
    this.layout = new TextLayout(font);
    this.pixelRatio = options.pixelRatio ?? 1;
    this.axis = options.axis ?? 'down';
    this.defaultColor = options.color === undefined ? Color.white() : Color.from(options.color);
    this.blendMode = options.blendMode ?? 'normal';
    this.sdf = options.sdf ?? false;

    if (font !== null) this.layout.setAtlasSize(font.atlas.width, font.atlas.height);
  }

  /* ---------------------------------------------------------------- configuration */

  /**
   * Replaces the font.
   *
   * @param font New font, or `null`.
   * @returns This renderer, for chaining.
   */
  public setFont(font: Font | null): this {
    this.font = font;
    this.layout.setGlyphProvider(font);
    if (font !== null) this.layout.setAtlasSize(font.atlas.width, font.atlas.height);
    return this;
  }

  /**
   * Sets the log canvas size.
   *
   * @param width Width in CSS pixels.
   * @param height Height in CSS pixels.
   * @returns This renderer, for chaining.
   */
  public setSize(width: number, height: number): this {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    return this;
  }

  /**
   * Sets the device-pixel ratio applied to the vertex data.
   *
   * @param pixelRatio New ratio; clamped to at least `0.01`.
   * @returns This renderer, for chaining.
   */
  public setPixelRatio(pixelRatio: number): this {
    this.pixelRatio = Math.max(0.01, pixelRatio);
    return this;
  }

  /* ------------------------------------------------------------------ layout */

  /**
   * Lays out text and produces draw commands, one per atlas page.
   *
   * @param text String to draw.
   * @param style Style, or a size in pixels.
   * @param options Layout overrides.
   * @returns One command per atlas page the text touches.
   */
  public render(
    text: string,
    style: TextStyle | number = TextStyle.default(),
    options: { maxWidth?: number; order?: number } = {},
  ): TextDrawCommand[] {
    const resolved = typeof style === 'number' ? new TextStyle({ fontSize: style }) : style;
    const result = this.layout.layout(text, resolved, {
      maxWidth: options.maxWidth ?? resolved.maxWidth,
    });
    return this.renderLayout(result, resolved, options.order ?? 0);
  }

  /**
   * Produces draw commands from an existing layout.
   *
   * @param result Layout result.
   * @param style Style the layout was produced with.
   * @param order Base render order.
   * @returns One command per atlas page.
   */
  public renderLayout(result: LayoutResult, style: TextStyle, order = 0): TextDrawCommand[] {
    // Group the glyphs by atlas page: one command per page, which is one draw call.
    const byPage = new Map<number, typeof result.glyphs>();
    for (const glyph of result.glyphs) {
      const bucket = byPage.get(glyph.page);
      if (bucket === undefined) byPage.set(glyph.page, [glyph]);
      else bucket.push(glyph);
    }

    const commands: TextDrawCommand[] = [];
    const color = style.color ?? this.defaultColor;

    for (const [page, glyphs] of byPage) {
      const vertices = this.quadsToVertices(glyphs);

      const command: TextDrawCommand = {
        kind: 'text',
        text: result.text,
        layout: result as unknown as TextDrawCommand['layout'],
        ...(this.font === null ? {} : { font: this.font }),
        style,
        page,
        color: [color.r, color.g, color.b, color.a * style.opacity],
        opacity: style.opacity,
        blendMode: this.blendMode,
        vertices,
        vertexCount: glyphs.length * VERTICES_PER_QUAD,
        sdf: this.sdf,
        order: order + this.nextOrder++,
      };

      this.stats.commands++;
      this.stats.glyphs += glyphs.length;
      this.stats.vertices += command.vertexCount;
      this.stats.bytes += vertices.byteLength;

      commands.push(command);
    }

    return commands;
  }

  /**
   * Converts layout glyphs into an interleaved vertex array.
   *
   * The two triangles are wound `(bl, br, tl)` and `(br, tr, tl)`, which is
   * counter-clockwise in a y-down space — the winding every backend in this library
   * expects for an un-culled quad.
   *
   * @param glyphs Layout glyphs to convert.
   * @returns `x, y, u, v` per vertex, six vertices per glyph.
   */
  public quadsToVertices(
    glyphs: readonly {
      x: number;
      y: number;
      width: number;
      height: number;
      u0: number;
      v0: number;
      u1: number;
      v1: number;
    }[],
  ): Float32Array {
    const vertices = new Float32Array(glyphs.length * FLOATS_PER_QUAD);
    const ratio = this.pixelRatio;
    const flipY = this.axis === 'up';

    let offset = 0;

    for (const glyph of glyphs) {
      const left = glyph.x * ratio;
      const top = glyph.y * ratio;
      const right = (glyph.x + glyph.width) * ratio;
      const bottom = (glyph.y + glyph.height) * ratio;

      // In a y-up space the top and bottom swap, and so do the V coordinates.
      const yTop = flipY ? -top : top;
      const yBottom = flipY ? -bottom : bottom;
      const vTop = flipY ? glyph.v1 : glyph.v0;
      const vBottom = flipY ? glyph.v0 : glyph.v1;

      // bottom-left
      vertices[offset++] = left;
      vertices[offset++] = yBottom;
      vertices[offset++] = glyph.u0;
      vertices[offset++] = vBottom;

      // bottom-right
      vertices[offset++] = right;
      vertices[offset++] = yBottom;
      vertices[offset++] = glyph.u1;
      vertices[offset++] = vBottom;

      // top-left
      vertices[offset++] = left;
      vertices[offset++] = yTop;
      vertices[offset++] = glyph.u0;
      vertices[offset++] = vTop;

      // bottom-right
      vertices[offset++] = right;
      vertices[offset++] = yBottom;
      vertices[offset++] = glyph.u1;
      vertices[offset++] = vBottom;

      // top-right
      vertices[offset++] = right;
      vertices[offset++] = yTop;
      vertices[offset++] = glyph.u1;
      vertices[offset++] = vTop;

      // top-left
      vertices[offset++] = left;
      vertices[offset++] = yTop;
      vertices[offset++] = glyph.u0;
      vertices[offset++] = vTop;
    }

    return vertices;
  }

  /**
   * Produces a single interleaved vertex array for a whole layout.
   *
   * The bulk path: one array, no per-page split, for a caller that draws the whole string
   * with one texture (which is every single-page atlas).
   *
   * @param layout Layout to batch.
   * @returns `x, y, u, v` per vertex.
   */
  public batch(layout: LayoutResult | readonly RenderQuad[]): Float32Array {
    const glyphs = Array.isArray(layout) ? layout : (layout as LayoutResult).glyphs;
    return this.quadsToVertices(glyphs as readonly RenderQuad[]);
  }

  /**
   * Groups a layout's glyphs by atlas page.
   *
   * @param layout Layout to group.
   * @returns One entry per page.
   */
  public groupByPage(layout: LayoutResult): Map<number, RenderQuad[]> {
    const byPage = new Map<number, RenderQuad[]>();
    for (const glyph of layout.glyphs) {
      const quad: RenderQuad = {
        x: glyph.x,
        y: glyph.y,
        width: glyph.width,
        height: glyph.height,
        u0: glyph.u0,
        v0: glyph.v0,
        u1: glyph.u1,
        v1: glyph.v1,
        page: glyph.page,
        codepoint: glyph.codepoint,
      };
      const bucket = byPage.get(glyph.page);
      if (bucket === undefined) byPage.set(glyph.page, [quad]);
      else bucket.push(quad);
    }
    return byPage;
  }

  /* ------------------------------------------------------------- render passes */

  /**
   * Wraps a command in a real {@link IRenderPass}.
   *
   * The pass writes the command into `context.values` under `'textCommand'` and leaves the
   * actual draw to the backend: this module must not know which renderer is in use, and a
   * backend that wants to draw text reads the key.
   *
   * @param command Command to draw.
   * @param order Pass order within the pipeline.
   * @returns An `IRenderPass`.
   */
  public createRenderPass(command: TextDrawCommand, order = 0): IRenderPass {
    const name = `text:${command.text.slice(0, 16)}`;
    return createRenderPass({
      id: `${name}:${command.page}`,
      name,
      order,
      clearOptions: null,
      execute: (context: RenderContext): void => {
        context.values.set('textCommand', command);
      },
      onResize: (width: number, height: number): void => {
        this.setSize(width, height);
      },
    });
  }

  /**
   * Wraps a command in a shader-driven pass.
   *
   * Identical in behaviour to {@link TextRenderer.createRenderPass}, with a separate name
   * because a caller that pairs it with a text shader wants the pass labelled as one.
   *
   * @param command Command to draw.
   * @param order Pass order within the pipeline.
   * @returns An `IRenderPass`.
   */
  public createShaderPass(command: TextDrawCommand, order = 0): IRenderPass {
    const pass = this.createRenderPass(command, order);
    pass.execute = (context: RenderContext): void => {
      context.values.set('textShaderCommand', command);
      context.values.set('textCommand', command);
    };
    return pass;
  }

  /**
   * Builds a pass that draws every command for one string.
   *
   * @param text String to draw.
   * @param style Style, or a size in pixels.
   * @param order Base pass order.
   * @returns One pass per atlas page.
   */
  public createTextPasses(
    text: string,
    style: TextStyle | number = TextStyle.default(),
    order = 0,
  ): IRenderPass[] {
    return this.render(text, style).map((command, index) => this.createRenderPass(command, order + index));
  }

  /**
   * Releases the font reference.
   */
  protected override onDispose(): void {
    this.font = null;
    this.layout.setGlyphProvider(null);
  }

  /**
   * Resets the statistics counters.
   *
   * @returns This renderer, for chaining.
   */
  public resetStats(): this {
    this.stats.commands = 0;
    this.stats.glyphs = 0;
    this.stats.vertices = 0;
    this.stats.bytes = 0;
    return this;
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `TextRenderer(font=${this.font === null ? 'none' : `"${this.font.family}"`}, ` +
      `axis=${this.axis}, commands=${this.stats.commands})`
    );
  }
}

/**
 * Convenience factory mirroring `new TextRenderer(font, options)`.
 *
 * @param font Font supplying the atlas.
 * @param options Pixel ratio, axis, colour and blend mode.
 * @returns A new text renderer.
 */
export function textRenderer(font: Font | null = null, options: TextRendererOptions = {}): TextRenderer {
  return new TextRenderer(font, options);
}

/**
 * A {@link GlyphProvider} backed by a measuring callback.
 *
 * Useful when a host has a text-measurement API (a canvas `measureText`) but no atlas:
 * the callback supplies advances and the returned glyphs carry zero-size quads, so a
 * layout's *width* is correct even before any bitmap exists.
 */
export class MeasureGlyphProvider implements GlyphProvider {
  /** Measures one character's advance, in pixels. */
  public readonly measure: (char: string) => number;

  /** Font size the metrics describe. */
  public readonly fontSize: number;

  /** Line height recommendation. */
  public readonly lineHeight: number;

  /** Advance used when the callback returns nothing useful. */
  public readonly fallbackAdvance: number;

  /**
   * Creates a measuring provider.
   *
   * @param measure Advance callback.
   * @param fontSize Font size in pixels.
   * @param fallbackAdvance Advance used when the callback fails.
   */
  constructor(measure: (char: string) => number, fontSize = 16, fallbackAdvance = 8) {
    this.measure = measure;
    this.fontSize = fontSize;
    this.lineHeight = fontSize * 1.2;
    this.fallbackAdvance = fallbackAdvance;
  }

  /**
   * Returns a zero-ink glyph carrying the measured advance.
   *
   * @param codepoint Codepoint.
   * @returns The glyph record.
   */
  public getGlyph(codepoint: number): {
    codepoint: number;
    advance: number;
    width: number;
    height: number;
    bearingX: number;
    bearingY: number;
    page: number;
    region: { x: number; y: number; width: number; height: number; page: number };
  } {
    return {
      codepoint,
      advance: this.getAdvance(codepoint) ?? this.fallbackAdvance,
      width: 0,
      height: 0,
      bearingX: 0,
      bearingY: 0,
      page: 0,
      region: { x: 0, y: 0, width: 0, height: 0, page: 0 },
    };
  }

  /**
   * Measures one codepoint.
   *
   * @param codepoint Codepoint.
   * @returns The advance in pixels.
   */
  public getAdvance(codepoint: number): number {
    try {
      const value = this.measure(String.fromCodePoint(codepoint));
      return Number.isFinite(value) && value > 0 ? value : this.fallbackAdvance;
    } catch {
      return this.fallbackAdvance;
    }
  }
}
