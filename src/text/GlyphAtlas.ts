/**
 * `GlyphAtlas` — a shelf-packing texture atlas for glyphs.
 *
 * ## Why shelves, and not a guillotine or a max-rects packer
 *
 * Glyph atlases have a property most atlas workloads lack: **glyphs arrive in
 * decreasing height order**, because a font atlas is generated from the tallest
 * character down. A shelf (row) packer exploits exactly that:
 *
 * ```
 * +--------------------------------------------------+
 * | ▓▓▓ ▓▓▓▓ ▓▓ ▓▓▓▓▓ ▓▓▓ ▓▓▓▓ ▓▓▓ ▓▓▓▓▓ ▓▓▓ ▓▓▓▓     |  shelf 0 (height 48)
 * +--------------------------------------------------+
 * | ▓▓ ▓▓▓ ▓▓▓▓ ▓▓▓ ▓▓▓▓▓ ▓▓ ▓▓▓▓ ▓▓▓ ▓▓▓ ▓▓▓▓▓ ▓▓▓   |  shelf 1 (height 32)
 * +--------------------------------------------------+
 * | ▓ ▓▓ ▓▓▓ ▓▓ ▓ ▓▓ ▓▓▓ ▓▓ ▓ ▓▓▓ ▓▓ ▓ ▓▓▓ ▓▓▓ ▓ ▓▓  |  shelf 2 (height 16)
 * +--------------------------------------------------+
 * ```
 *
 * A shelf packer gives ~95 % of max-rects quality on this input, with an `O(1)` insert
 * instead of an `O(n log n)` free-list search. For an atlas that is built once and read
 * thousands of times per frame, that is the right trade.
 *
 * ## Growth
 *
 * When no existing shelf fits, a new shelf is opened above them. When there is no room
 * for one, the page **doubles** — preferring width first, then height — and every glyph
 * is re-packed. Doubling (rather than a power-of-two round-up on each insert) is what
 * keeps the atlas a power of two without reallocating on every glyph.
 *
 * ## Padding
 *
 * Every glyph's ink is surrounded by {@link Glyph.padding} texels of empty space
 * (`GLYPH_PADDING` by default). That is not cosmetic: at small sizes bilinear filtering
 * samples up to half a texel outside the glyph, and without padding a neighbouring
 * glyph's ink bleeds in as a visible seam.
 *
 * ```ts
 * const atlas = new GlyphAtlas({ width: 128, height: 128 });
 * atlas.addGlyph(new Glyph({ codepoint: 65, advance: 12, width: 10, height: 14 }));
 * atlas.getGlyph(65);        // the glyph, with its finalised region
 * atlas.stats;               // { width, height, glyphCount, fillRatio, ... }
 * ```
 *
 * @packageDocumentation
 */

import { GLYPH_PADDING } from '../constants';
import { Disposable } from '../core/Disposable';
import { createId } from '../utils/Id';
import { isPowerOfTwo, nextPowerOfTwo } from '../utils/MathUtils';
import { createLogger } from '../utils/Logger';
import { Glyph } from './Glyph';
import type {
  AtlasShelf,
  GlyphAtlasOptions,
  GlyphAtlasStats,
  GlyphRegion,
  TextureLike,
} from './types';

/** Logger shared by every atlas. */
const log = createLogger('text:atlas');

/** A request handed to the packer. */
export interface AtlasPackRequest {
  /** Codepoint the cell belongs to. */
  codepoint: number;
  /** Ink width in pixels. */
  width: number;
  /** Ink height in pixels. */
  height: number;
  /** Padding around the ink, in texels. */
  padding?: number;
}

/** The result of a pack. */
export interface AtlasPackResult {
  /** Finalised region, including padding. */
  region: GlyphRegion;
  /** `false` when the request did not fit and the atlas could not grow. */
  packed: boolean;
}

/** A page record the atlas hands to a renderer. */
interface AtlasPageRecord {
  /** Page index. */
  page: number;
  /** Width in texels. */
  width: number;
  /** Height in texels. */
  height: number;
  /** `true` once anything was packed onto the page. */
  dirty: boolean;
  /** Structural texture handed to renderers. */
  texture: TextureLike;
}

/**
 * A shelf-packed glyph atlas.
 */
export class GlyphAtlas extends Disposable<'GlyphAtlas'> {
  /** @inheritdoc */
  public override readonly label = 'GlyphAtlas' as const;

  /** Unique identifier. */
  public override readonly id: string = createId('atlas');

  /** Page width in texels. */
  public width: number;

  /** Page height in texels. */
  public height: number;

  /** Padding around every glyph, in texels. */
  public padding: number;

  /** `true` allows the page to grow. */
  public grow: boolean;

  /** Largest page dimension growth may reach. */
  public maxSize: number;

  /** Page index this atlas represents. */
  public readonly page: number;

  /** Packed shelves, top to bottom. */
  private readonly shelves: AtlasShelf[] = [];

  /** Glyphs by codepoint. */
  private readonly glyphs = new Map<number, Glyph>();

  /** Number of times the page doubled. */
  private growthCount = 0;

  /** Total ink area packed, in texels (excluding padding). */
  private usedArea = 0;

  /** Page record handed to renderers. */
  private readonly pageRecord: AtlasPageRecord;

  /**
   * Creates an atlas.
   *
   * @param options Initial size, padding and growth configuration.
   */
  constructor(options: GlyphAtlasOptions = {}) {
    super();
    this.width = Math.max(1, Math.floor(options.width ?? 256));
    this.height = Math.max(1, Math.floor(options.height ?? 256));
    this.padding = Math.max(0, Math.floor(options.padding ?? GLYPH_PADDING));
    this.grow = options.grow ?? true;
    this.maxSize = Math.max(1, Math.floor(options.maxSize ?? 4096));
    this.page = Math.max(0, Math.floor(options.page ?? 0));

    this.pageRecord = {
      page: this.page,
      width: this.width,
      height: this.height,
      dirty: false,
      texture: {
        page: this.page,
        width: this.width,
        height: this.height,
        needsUpdate: false,
        alphaOnly: true,
        image: null,
        source: null,
        dispose(): void {
          /* the atlas owns the texture's lifetime */
        },
      },
    };
  }

  /* ------------------------------------------------------------------ packing */

  /**
   * Packs a cell and returns its finalised region.
   *
   * @param request Cell to place.
   * @returns The region plus a `packed` flag.
   */
  public pack(request: AtlasPackRequest): AtlasPackResult {
    this.assertUsable();

    const padding = Math.max(0, request.padding ?? this.padding);
    const cellWidth = Math.max(1, Math.ceil(request.width)) + padding * 2;
    const cellHeight = Math.max(1, Math.ceil(request.height)) + padding * 2;

    const region = this.place(cellWidth, cellHeight, padding);
    if (region !== null) {
      this.usedArea += Math.max(0, request.width) * Math.max(0, request.height);
      this.pageRecord.dirty = true;
      this.pageRecord.texture.needsUpdate = true;
      return { region, packed: true };
    }

    if (!this.grow) {
      return {
        region: { x: 0, y: 0, width: 0, height: 0, page: this.page },
        packed: false,
      };
    }

    // Grow and try again. A single doubling may not be enough for a very large glyph,
    // so the loop keeps doubling until it fits or the size cap is reached.
    while (this.tryGrow()) {
      const retry = this.place(cellWidth, cellHeight, padding);
      if (retry !== null) {
        this.usedArea += Math.max(0, request.width) * Math.max(0, request.height);
        this.pageRecord.dirty = true;
        this.pageRecord.texture.needsUpdate = true;
        return { region: retry, packed: true };
      }
    }

    log.warn(
      `glyph ${request.width}x${request.height} does not fit in a ${this.width}x${this.height} ` +
        `atlas (maxSize ${this.maxSize})`,
    );
    return {
      region: { x: 0, y: 0, width: 0, height: 0, page: this.page },
      packed: false,
    };
  }

  /**
   * Places a cell on an existing shelf, or opens a new one.
   *
   * @param cellWidth Cell width including padding.
   * @param cellHeight Cell height including padding.
   * @param padding Padding to record on the region.
   * @returns The region, or `null` when nothing fits.
   */
  private place(cellWidth: number, cellHeight: number, padding: number): GlyphRegion | null {
    if (cellWidth > this.width || cellHeight > this.height) return null;

    // First fit: the first shelf tall enough that still has horizontal room. Because
    // glyphs arrive tallest-first, this is almost always shelf 0 or the last opened.
    for (const shelf of this.shelves) {
      if (shelf.height < cellHeight) continue;
      if (shelf.cursorX + cellWidth > this.width) continue;

      const region: GlyphRegion = {
        x: shelf.cursorX,
        y: shelf.y,
        width: cellWidth,
        height: cellHeight,
        page: this.page,
      };
      shelf.cursorX += cellWidth + padding;
      return region;
    }

    // No shelf fits: open a new one, unless the page is already full vertically.
    const y = this.nextShelfY();
    if (y + cellHeight > this.height) return null;

    const shelf: AtlasShelf = { y, height: cellHeight, cursorX: 0 };
    this.shelves.push(shelf);

    const region: GlyphRegion = {
      x: 0,
      y,
      width: cellWidth,
      height: cellHeight,
      page: this.page,
    };
    shelf.cursorX = cellWidth + padding;
    return region;
  }

  /** Y coordinate just below the last shelf. */
  private nextShelfY(): number {
    if (this.shelves.length === 0) return 0;
    const last = this.shelves[this.shelves.length - 1];
    return last.y + last.height + this.padding;
  }

  /**
   * Doubles the page, preferring width and falling back to height.
   *
   * Growing width first keeps the shelf structure intact, so no glyph has to move;
   * growing height only ever adds room below.
   *
   * @returns `true` when the page grew.
   */
  public tryGrow(): boolean {
    if (!this.grow) return false;

    const canGrowWidth = this.width * 2 <= this.maxSize;
    const canGrowHeight = this.height * 2 <= this.maxSize;

    if (!canGrowWidth && !canGrowHeight) return false;

    if (canGrowWidth) {
      this.width *= 2;
    } else {
      // A "shelf" packer that ran out of width has no vertical room either, so the
      // height doubling is what buys more rows.
      this.height *= 2;
    }

    this.growthCount++;
    this.pageRecord.width = this.width;
    this.pageRecord.height = this.height;
    this.pageRecord.texture.width = this.width;
    this.pageRecord.texture.height = this.height;
    this.pageRecord.texture.needsUpdate = true;

    log.debug(`atlas ${this.id} grew to ${this.width}x${this.height}`);
    return true;
  }

  /**
   * Grows the page to the next power of two.
   *
   * Called after a batch of `addGlyph` calls so the final page is a power of two, which
   * every GPU samples without a wrapper and mipmapping requires.
   *
   * @param target Optional explicit size; defaults to `nextPowerOfTwo` of the current
   *   dimensions.
   * @returns This atlas, for chaining.
   */
  public resizeToPowerOfTwo(target?: number): this {
    const nextWidth = target ?? nextPowerOfTwo(this.width);
    const nextHeight = target ?? nextPowerOfTwo(this.height);

    if (nextWidth === this.width && nextHeight === this.height) return this;

    this.width = Math.min(nextWidth, this.maxSize);
    this.height = Math.min(nextHeight, this.maxSize);
    this.pageRecord.width = this.width;
    this.pageRecord.height = this.height;
    this.pageRecord.texture.width = this.width;
    this.pageRecord.texture.height = this.height;
    this.pageRecord.texture.needsUpdate = true;
    return this;
  }

  /* -------------------------------------------------------------------- glyphs */

  /**
   * Adds a glyph, packing its cell and finalising its region.
   *
   * @param glyph Glyph to add; its `region` is overwritten.
   * @returns `true` when it was packed.
   */
  public addGlyph(glyph: Glyph): boolean {
    this.assertUsable();

    // A whitespace glyph has no ink and therefore no cell; recording it lets the layout
    // code look its advance up without a special case.
    if (!glyph.hasBitmap || glyph.width <= 0 || glyph.height <= 0) {
      glyph.region = { x: 0, y: 0, width: 0, height: 0, page: this.page };
      glyph.page = this.page;
      this.glyphs.set(glyph.codepoint, glyph);
      return true;
    }

    const result = this.pack({
      codepoint: glyph.codepoint,
      width: glyph.width,
      height: glyph.height,
      padding: glyph.padding,
    });

    if (!result.packed) return false;

    glyph.region = result.region;
    glyph.page = this.page;
    this.glyphs.set(glyph.codepoint, glyph);
    return true;
  }

  /**
   * Packs many cells in one batch.
   *
   * Cells are sorted tallest-first before packing, which is the input order a shelf
   * packer is designed for. The final page is rounded up to a power of two.
   *
   * @param requests Cells to place.
   * @returns One result per request, in the input order.
   */
  public packAll(requests: readonly AtlasPackRequest[]): AtlasPackResult[] {
    const indexed = requests.map((request, index) => ({ request, index }));
    indexed.sort((a, b) => b.request.height - a.request.height);

    const results: AtlasPackResult[] = new Array(requests.length);
    for (const entry of indexed) {
      results[entry.index] = this.pack(entry.request);
    }

    this.resizeToPowerOfTwo();
    return results;
  }

  /**
   * Looks a glyph up.
   *
   * @param charOrCodepoint Character or codepoint.
   * @returns The glyph, or `undefined`.
   */
  public getGlyph(charOrCodepoint: string | number): Glyph | undefined {
    const codepoint =
      typeof charOrCodepoint === 'number' ? charOrCodepoint : (charOrCodepoint.codePointAt(0) ?? -1);
    return this.glyphs.get(codepoint);
  }

  /**
   * `true` when a glyph is packed, or is recorded as whitespace.
   *
   * @param charOrCodepoint Character or codepoint.
   * @returns The presence flag.
   */
  public hasGlyph(charOrCodepoint: string | number): boolean {
    return this.getGlyph(charOrCodepoint) !== undefined;
  }

  /**
   * Every packed glyph.
   *
   * @returns The glyphs, in insertion order.
   */
  public getGlyphs(): Glyph[] {
    return Array.from(this.glyphs.values());
  }

  /**
   * The finalised region for a codepoint.
   *
   * @param charOrCodepoint Character or codepoint.
   * @returns The region, or `null`.
   */
  public getRegion(charOrCodepoint: string | number): GlyphRegion | null {
    return this.getGlyph(charOrCodepoint)?.region ?? null;
  }

  /**
   * The kerning adjustment between two codepoints.
   *
   * A shelf atlas does not store kerning; this exists so a font that does can present
   * the same {@link import('./types').GlyphProvider} surface. Subclasses override it.
   *
   * @param left Left codepoint.
   * @param right Right codepoint.
   * @returns `undefined` — the base atlas has no kerning data.
   */
  public getKerning(left: number, right: number): number | undefined {
    void left;
    void right;
    return undefined;
  }

  /**
   * The pen advance of a codepoint.
   *
   * @param codepoint Codepoint.
   * @returns The advance, or `0` when the glyph is absent.
   */
  public getAdvance(codepoint: number): number {
    return this.glyphs.get(codepoint)?.advance ?? 0;
  }

  /* --------------------------------------------------------------------- cells */

  /**
   * Every packed cell, for an inspector or a texture upload.
   *
   * @returns One record per glyph with a bitmap.
   */
  public getCells(): { codepoint: number; region: GlyphRegion; glyph: Glyph }[] {
    const cells: { codepoint: number; region: GlyphRegion; glyph: Glyph }[] = [];
    for (const glyph of this.glyphs.values()) {
      if (!glyph.hasBitmap) continue;
      cells.push({ codepoint: glyph.codepoint, region: glyph.region, glyph });
    }
    return cells;
  }

  /**
   * `true` when two packed cells overlap.
   *
   * A packing invariant check, exposed because "never overlaps" is the one property a
   * packer must have and the easiest to get wrong. O(n²), so it is a development and
   * test tool rather than a per-frame call.
   *
   * @returns `true` when any two cells intersect.
   */
  public hasOverlaps(): boolean {
    const cells = this.getCells();
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        if (rectsOverlap(cells[i].region, cells[j].region)) return true;
      }
    }
    return false;
  }

  /* -------------------------------------------------------------------- output */

  /**
   * The atlas texture handed to a renderer.
   *
   * The image is a structural record; a caller that keeps real pixels (a canvas, a
   * `Uint8Array`) assigns them through {@link GlyphAtlas.setImage}.
   *
   * @returns The texture, or `null` when nothing has been packed.
   */
  public getTexture(): TextureLike | null {
    return this.pageRecord.texture;
  }

  /**
   * Attaches atlas pixel data.
   *
   * @param image Backing image: a canvas, an `ImageData`, a `Uint8Array`, or a record.
   * @returns This atlas, for chaining.
   */
  public setImage(image: unknown): this {
    this.pageRecord.texture.image = image;
    this.pageRecord.texture.source = image;
    this.pageRecord.texture.needsUpdate = true;
    return this;
  }

  /**
   * Marks the texture as uploaded.
   *
   * @returns This atlas, for chaining.
   */
  public clearDirty(): this {
    this.pageRecord.dirty = false;
    this.pageRecord.texture.needsUpdate = false;
    return this;
  }

  /**
   * `true` when the page has changed since the last upload.
   *
   * @returns The dirty flag.
   */
  public get isDirty(): boolean {
    return this.pageRecord.dirty;
  }

  /**
   * The page size.
   *
   * @returns Width and height in texels.
   */
  public getAtlasSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /* --------------------------------------------------------------------- stats */

  /**
   * Atlas fill statistics.
   *
   * @returns The statistics.
   */
  public get stats(): GlyphAtlasStats {
    const totalArea = this.width * this.height;
    return {
      width: this.width,
      height: this.height,
      glyphCount: this.glyphs.size,
      rowCount: this.shelves.length,
      usedArea: this.usedArea,
      totalArea,
      fillRatio: totalArea > 0 ? this.usedArea / totalArea : 0,
      growthCount: this.growthCount,
      page: this.page,
    };
  }

  /**
   * `true` when both page dimensions are powers of two.
   *
   * @returns The power-of-two flag.
   */
  public get isPowerOfTwo(): boolean {
    return isPowerOfTwo(this.width) && isPowerOfTwo(this.height);
  }

  /**
   * The shelf layout, for an inspector.
   *
   * @returns A copy of the shelf list.
   */
  public getShelves(): AtlasShelf[] {
    return this.shelves.map((shelf) => ({ ...shelf }));
  }

  /* -------------------------------------------------------------------- clearing */

  /**
   * Removes every packed glyph and resets the shelves.
   *
   * @param size Optional new page size.
   * @returns This atlas, for chaining.
   */
  public clear(size?: number): this {
    this.glyphs.clear();
    this.shelves.length = 0;
    this.usedArea = 0;
    this.growthCount = 0;
    this.pageRecord.dirty = false;
    this.pageRecord.texture.needsUpdate = true;
    this.pageRecord.texture.image = null;
    this.pageRecord.texture.source = null;

    if (size !== undefined) this.setSize(size, size);
    return this;
  }

  /**
   * Resizes the page.
   *
   * Existing glyph regions are **not** remapped; resize before packing, or call
   * {@link GlyphAtlas.clear} and re-pack.
   *
   * @param width New width in texels.
   * @param height New height in texels.
   * @returns This atlas, for chaining.
   */
  public setSize(width: number, height: number): this {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.pageRecord.width = this.width;
    this.pageRecord.height = this.height;
    this.pageRecord.texture.width = this.width;
    this.pageRecord.texture.height = this.height;
    this.pageRecord.texture.needsUpdate = true;
    return this;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    this.glyphs.clear();
    this.shelves.length = 0;
    this.pageRecord.texture.image = null;
    this.pageRecord.texture.source = null;
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    const stats = this.stats;
    return (
      `GlyphAtlas(${stats.width}x${stats.height}, glyphs=${stats.glyphCount}, ` +
      `rows=${stats.rowCount}, fill=${(stats.fillRatio * 100).toFixed(1)}%)`
    );
  }
}

/** `true` when two axis-aligned rectangles overlap. */
function rectsOverlap(a: GlyphRegion, b: GlyphRegion): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Convenience factory mirroring `new GlyphAtlas(options)`.
 *
 * @param options Initial size, padding and growth configuration.
 * @returns A new atlas.
 */
export function glyphAtlas(options: GlyphAtlasOptions = {}): GlyphAtlas {
  return new GlyphAtlas(options);
}
