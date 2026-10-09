/**
 * Render list.
 *
 * Collects the renderables a frame has to draw and separates them into the three
 * buckets every backend cares about:
 *
 * - **opaque** — drawn front-to-back, depth write on;
 * - **transparent** — drawn back-to-front, blended;
 * - **ordered** — renderables with an explicit `renderOrder` that must keep their
 *   submission order relative to each other regardless of depth.
 *
 * The scene layer owns traversal; the renderer only consumes objects that satisfy
 * {@link RenderableLike}. Nothing here imports `src/scene`.
 *
 * @packageDocumentation
 */

import type { MaterialLike } from '../interfaces/types';

/* -------------------------------------------------------------------------- */
/* Structural renderable                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Anything the renderer is able to draw.
 *
 * `render(painter)` is called with the backend's painter: a `Canvas2DPainter`
 * for the Canvas2D backend, an `SVGNodeFactory` handle for the SVG backend. The
 * parameter is typed `unknown` so this module never depends on a backend.
 */
export interface Renderable2D {
  /** `true` when the object contributes to the frame. */
  readonly visible: boolean;
  /** Draws the object through the supplied backend painter. */
  render(painter: unknown): void;
  /** Material/skip metadata, when the object has any. */
  readonly material?: MaterialLike | null;
  /** Sort override; lower values are drawn earlier. */
  readonly renderOrder?: number;
  /** Distance from the camera, used as the tertiary sort key. */
  readonly depth?: number;
  /** Stable identifier used by diagnostics. */
  readonly id?: string | number;
  /** `true` when the object is opaque regardless of its material. */
  readonly opaque?: boolean;
  /** Explicit transparency flag, overriding the material's. */
  readonly transparent?: boolean;
  /** Camera-relative depth that the renderer may refresh before sorting. */
  updateDepth?(camera: unknown): void;
  /** Releases the object's GPU resources, when it owns any. */
  dispose?(): void;
}

/**
 * An entry in a {@link RenderList}.
 *
 * One entry is allocated per submission per frame; the list recycles entries
 * between frames to keep the hot path allocation-free.
 */
export interface RenderListItem<T = Renderable2D> {
  /** The renderable this entry refers to. */
  readonly object: T;
  /** Effective render order (`object.renderOrder ?? material.renderOrder ?? 0`). */
  renderOrder: number;
  /** Material identifier used by the render queue's secondary sort. */
  materialId: string | number | undefined;
  /** Camera-relative depth used by the render queue's tertiary sort. */
  depth: number;
  /** `true` when the entry belongs in the transparent bucket. */
  transparent: boolean;
  /** Monotonic submission index; the final, tie-breaking sort key. */
  sequence: number;
}

/** Statistics describing one frame's submissions. */
export interface RenderListStats {
  /** Total number of collected renderables. */
  total: number;
  /** Number of opaque renderables. */
  opaque: number;
  /** Number of transparent renderables. */
  transparent: number;
  /** Number of renderables carrying an explicit render order. */
  ordered: number;
}

/** Constructor option bag for {@link RenderList}. */
export interface RenderListOptions {
  /** Pre-size the entry pool. Defaults to `0` (grow on demand). */
  capacity?: number;
  /**
   * Depth threshold below which an entry is treated as transparent regardless of
   * its material. `null` (the default) disables the heuristic.
   */
  transparentDepthThreshold?: number | null;
}

/* -------------------------------------------------------------------------- */
/* RenderList                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Per-frame bucket collection of renderables.
 *
 * The list is reusable: call {@link RenderList.reset} at the start of a frame,
 * then {@link RenderList.push} every visible renderable, then hand the list to a
 * {@link RenderQueue} for sorting.
 */
export class RenderList<T extends Renderable2D = Renderable2D> {
  /** Opaque entries, in submission order. */
  public readonly opaque: RenderListItem<T>[] = [];

  /** Transparent entries, in submission order. */
  public readonly transparent: RenderListItem<T>[] = [];

  /** Entries with an explicit `renderOrder`, in submission order. */
  public readonly ordered: RenderListItem<T>[] = [];

  /** Submissions rejected because the object was not visible. */
  public culledCount: number = 0;

  /** Pool of recycled entries. */
  private readonly pool: RenderListItem<T>[] = [];

  /** Monotonic submission counter, shared across the three buckets. */
  private sequence: number = 0;

  /** Depth threshold below which entries are treated as transparent. */
  private transparentDepthThreshold: number | null;

  /** Creates an empty list. */
  constructor(options: RenderListOptions = {}) {
    this.transparentDepthThreshold = options.transparentDepthThreshold ?? null;
    const capacity = Math.max(0, Math.floor(options.capacity ?? 0));
    for (let i = 0; i < capacity; i++) this.pool.push(this.createEntry());
  }

  /** Total number of collected entries (all three buckets). */
  public get length(): number {
    return this.opaque.length + this.transparent.length + this.ordered.length;
  }

  /** `true` when nothing was collected for the frame. */
  public get isEmpty(): boolean {
    return this.length === 0;
  }

  /**
   * Empties every bucket, returning the entries to the pool.
   *
   * @returns This list, for chaining.
   */
  public reset(): this {
    this.recycle(this.opaque);
    this.recycle(this.transparent);
    this.recycle(this.ordered);
    this.sequence = 0;
    this.culledCount = 0;
    return this;
  }

  /**
   * Submits a renderable.
   *
   * Objects that are not `visible` are counted as culled and skipped, which is
   * the only visibility test the renderer performs; frustum culling belongs to
   * the scene/camera layer.
   *
   * @param object Renderable to submit.
   * @param options Per-submission overrides for depth/transparency.
   * @returns The list entry, or `null` when the object was skipped.
   */
  public push(object: T, options: { depth?: number; transparent?: boolean } = {}): RenderListItem<T> | null {
    if (object == null || object.visible === false) {
      this.culledCount++;
      return null;
    }

    const material = object.material ?? null;
    const renderOrder =
      typeof object.renderOrder === 'number'
        ? object.renderOrder
        : typeof material?.renderOrder === 'number'
          ? material.renderOrder
          : 0;

    const depth = options.depth ?? (typeof object.depth === 'number' ? object.depth : 0);
    const explicitTransparent = options.transparent ?? object.transparent;
    const transparent =
      explicitTransparent ?? (object.opaque === true ? false : this.resolveTransparent(object, material, depth));

    const entry = this.pool.pop() ?? this.createEntry();
    (entry as { object: T }).object = object;
    entry.renderOrder = renderOrder;
    entry.materialId = material?.id ?? object.id;
    entry.depth = depth;
    entry.transparent = transparent;
    entry.sequence = this.sequence++;

    if (renderOrder !== 0) this.ordered.push(entry);
    else if (transparent) this.transparent.push(entry);
    else this.opaque.push(entry);

    return entry;
  }

  /**
   * Submits every visible entry of an iterable.
   *
   * @param objects Renderables to submit.
   * @returns The number of entries actually added.
   */
  public pushAll(objects: Iterable<T>): number {
    let added = 0;
    for (const object of objects) {
      if (this.push(object) !== null) added++;
    }
    return added;
  }

  /** @returns Every entry, ordered as `ordered`, then `opaque`, then `transparent`. */
  public getAll(): RenderListItem<T>[] {
    return [...this.ordered, ...this.opaque, ...this.transparent];
  }

  /** @returns The number of collected entries per bucket. */
  public getStats(): RenderListStats {
    return {
      total: this.length,
      opaque: this.opaque.length,
      transparent: this.transparent.length,
      ordered: this.ordered.length,
    };
  }

  /** Resolves whether an object should be treated as transparent. */
  private resolveTransparent(object: T, material: MaterialLike | null, depth: number): boolean {
    if (material?.transparent === true) return true;
    if (this.transparentDepthThreshold !== null && depth < this.transparentDepthThreshold) return true;
    return false;
  }

  /** Returns entries to the pool and clears the bucket. */
  private recycle(bucket: RenderListItem<T>[]): void {
    for (let i = 0; i < bucket.length; i++) this.pool.push(bucket[i]);
    bucket.length = 0;
  }

  /** Creates an empty entry (used by the pool). */
  private createEntry(): RenderListItem<T> {
    return {
      object: undefined as unknown as T,
      renderOrder: 0,
      materialId: undefined,
      depth: 0,
      transparent: false,
      sequence: 0,
    };
  }
}
