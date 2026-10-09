/**
 * Render queue.
 *
 * Turns a {@link RenderList} into a draw order. The queue never reorders the
 * list's buckets: it sorts a *copy* of each bucket into its own output array, so a
 * caller can still inspect the submission order afterwards.
 *
 * ## Documented sort order
 *
 * 1. **`renderOrder` ascending** — an explicit, artist-controlled priority.
 * 2. **`materialId` ascending** — groups draws that share a material (and
 *    therefore a shader/state block), minimising state changes.
 *    - numeric ids compare numerically;
 *    - string ids compare with `<`/`>` (code-unit order);
 *    - when the two ids have different types, the numeric one sorts first.
 * 3. **`depth` ascending** — front-to-back for the opaque buckets. The
 *    transparent bucket inverts this (back-to-front) unless
 *    {@link RenderQueueOptions.sortTransparentBackToFront} is `false`.
 * 4. **submission sequence ascending** — a stable, deterministic tie-break, so two
 *    runs over the same input always produce the same order.
 *
 * Buckets themselves are emitted in this sequence: `ordered`, `opaque`,
 * `transparent` (adjustable through
 * {@link RenderQueueOptions.transparentFirst}).
 *
 * @packageDocumentation
 */

import { RenderList, type RenderListItem, type Renderable2D } from './RenderList';

/** Draw-bucket identifiers. */
export enum RenderBucket {
  /** Geometry with an explicit render order. */
  Ordered = 'ordered',
  /** Opaque geometry. */
  Opaque = 'opaque',
  /** Blended geometry. */
  Transparent = 'transparent',
}

/** A single slot of a produced draw order. */
export interface DrawOrderEntry<T = Renderable2D> {
  /** Index of the call within the produced order. */
  readonly index: number;
  /** Bucket the entry came from. */
  readonly bucket: RenderBucket;
  /** The underlying list entry. */
  readonly item: RenderListItem<T>;
}

/** Options accepted by {@link RenderQueue}. */
export interface RenderQueueOptions {
  /**
   * Compare material ids before depth. Defaults to `true`.
   *
   * Set to `false` to sort purely by render order and depth, which is what a
   * depth pre-pass or a shadow pass usually wants.
   */
  sortByMaterial?: boolean;
  /** Sort the transparent bucket back-to-front. Defaults to `true`. */
  sortTransparentBackToFront?: boolean;
  /** Draw the transparent bucket before the opaque one. Defaults to `false`. */
  transparentFirst?: boolean;
  /** Draw the `ordered` bucket last instead of first. Defaults to `false`. */
  orderedLast?: boolean;
}

/** Result of one {@link RenderQueue.sort} pass. */
export interface RenderQueueResult<T = Renderable2D> {
  /** Flattened draw order, ready for the backend. */
  readonly order: readonly RenderListItem<T>[];
  /** `true` when the number of entries changed since the previous sort. */
  readonly changed: boolean;
  /** Buckets the order is composed of, in draw sequence. */
  readonly buckets: readonly RenderBucket[];
  /** Wall-clock duration of the sort, in milliseconds. */
  readonly duration: number;
}

/* -------------------------------------------------------------------------- */
/* Comparators                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Compares two material identifiers using the documented rule.
 *
 * An absent identifier (`undefined`, from a renderable without an `id`) sorts
 * last, so identified materials stay grouped.
 *
 * @param a Left identifier.
 * @param b Right identifier.
 * @returns A negative, zero or positive number, suitable for `Array#sort`.
 */
export function compareMaterialIds(
  a: string | number | undefined,
  b: string | number | undefined,
): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;

  const aIsNumber = typeof a === 'number';
  const bIsNumber = typeof b === 'number';
  if (aIsNumber && bIsNumber) return (a as number) - (b as number);
  if (aIsNumber) return -1;
  if (bIsNumber) return 1;
  const aString = String(a);
  const bString = String(b);
  if (aString === bString) return 0;
  return aString < bString ? -1 : 1;
}

/**
 * The documented entry comparator (depth ascending).
 *
 * @param a Left entry.
 * @param b Right entry.
 * @param options Sort tuning.
 * @returns A negative, zero or positive number.
 */
export function compareRenderItems<T extends Renderable2D>(
  a: RenderListItem<T>,
  b: RenderListItem<T>,
  options: RenderQueueOptions = {},
): number {
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  if (options.sortByMaterial ?? true) {
    const material = compareMaterialIds(a.materialId, b.materialId);
    if (material !== 0) return material;
  }
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.sequence - b.sequence;
}

/**
 * Comparator for the transparent bucket (depth descending, back-to-front).
 *
 * @param a Left entry.
 * @param b Right entry.
 * @param options Sort tuning.
 * @returns A negative, zero or positive number.
 */
export function compareTransparentItems<T extends Renderable2D>(
  a: RenderListItem<T>,
  b: RenderListItem<T>,
  options: RenderQueueOptions = {},
): number {
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  if (options.sortByMaterial ?? true) {
    const material = compareMaterialIds(a.materialId, b.materialId);
    if (material !== 0) return material;
  }
  if (a.depth !== b.depth) return b.depth - a.depth;
  return a.sequence - b.sequence;
}

/* -------------------------------------------------------------------------- */
/* RenderQueue                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Sorts a {@link RenderList} into a draw order.
 *
 * The queue owns its output array and reuses it between frames; it never mutates
 * the list's buckets.
 */
export class RenderQueue<T extends Renderable2D = Renderable2D> {
  /** The order produced by the most recent {@link RenderQueue.sort}. */
  public readonly order: RenderListItem<T>[] = [];

  /** Sort tuning; may be mutated between frames. */
  public readonly options: RenderQueueOptions;

  /** Bucket sequence the last sort produced. */
  private buckets: RenderBucket[] = [];

  /** Number of entries in each bucket of the last sort, parallel to `buckets`. */
  private bucketSizes: number[] = [];

  /** Number of entries the previous sort produced. */
  private previousLength: number = -1;

  /** `true` after the first successful {@link RenderQueue.sort}. */
  private sortedOnce: boolean = false;

  /** Creates an empty queue. */
  constructor(options: RenderQueueOptions = {}) {
    this.options = { ...options };
  }

  /** Number of entries in the produced order. */
  public get length(): number {
    return this.order.length;
  }

  /** `true` when the produced order is empty. */
  public get isEmpty(): boolean {
    return this.order.length === 0;
  }

  /** Bucket sequence of the last sort. */
  public getBuckets(): readonly RenderBucket[] {
    return this.buckets;
  }

  /**
   * Sorts the supplied list into {@link RenderQueue.order}.
   *
   * @param list List to sort.
   * @returns The produced order plus timing and change information.
   */
  public sort(list: RenderList<T>): RenderQueueResult<T> {
    const startedAt = now();

    const buckets = this.resolveBucketOrder();
    const sources: readonly RenderListItem<T>[][] = buckets.map((bucket) => this.bucketOf(list, bucket));

    this.order.length = 0;
    this.bucketSizes.length = 0;

    for (let b = 0; b < buckets.length; b++) {
      const source = sources[b];
      const bucket = buckets[b];
      const size = source.length;
      this.bucketSizes.push(size);
      if (size === 0) continue;

      const copy = source.slice();
      if (bucket === RenderBucket.Transparent && (this.options.sortTransparentBackToFront ?? true)) {
        copy.sort((a, c) => compareTransparentItems(a, c, this.options));
      } else {
        copy.sort((a, c) => compareRenderItems(a, c, this.options));
      }
      for (let i = 0; i < copy.length; i++) this.order.push(copy[i]);
    }

    const changed = this.previousLength !== this.order.length || !this.sortedOnce;
    this.previousLength = this.order.length;
    this.buckets = buckets;
    this.sortedOnce = true;

    return {
      order: this.order,
      changed,
      buckets,
      duration: now() - startedAt,
    };
  }

  /**
   * Produces an indexed view of the current order.
   *
   * @returns One {@link DrawOrderEntry} per draw call, in draw sequence.
   */
  public getDrawOrder(): DrawOrderEntry<T>[] {
    const result: DrawOrderEntry<T>[] = [];
    let index = 0;

    for (let b = 0; b < this.buckets.length; b++) {
      const bucket = this.buckets[b];
      const size = this.bucketSizes[b] ?? 0;
      for (let i = 0; i < size && index < this.order.length; i++, index++) {
        result.push({ index, bucket, item: this.order[index] });
      }
    }

    // Defensive: any entry not attributed to a bucket is reported as opaque.
    for (; index < this.order.length; index++) {
      result.push({ index, bucket: RenderBucket.Opaque, item: this.order[index] });
    }

    return result;
  }

  /** Clears the produced order and resets the change tracking. */
  public reset(): void {
    this.order.length = 0;
    this.buckets = [];
    this.bucketSizes = [];
    this.previousLength = -1;
    this.sortedOnce = false;
  }

  /** @returns `true` once {@link RenderQueue.sort} has run at least once. */
  public isSorted(): boolean {
    return this.sortedOnce;
  }

  /** Applies {@link RenderQueueOptions} to the bucket sequence. */
  private resolveBucketOrder(): RenderBucket[] {
    const ordered: RenderBucket[] = [
      RenderBucket.Ordered,
      RenderBucket.Opaque,
      RenderBucket.Transparent,
    ];
    if (this.options.orderedLast) {
      ordered.splice(ordered.indexOf(RenderBucket.Ordered), 1);
      ordered.push(RenderBucket.Ordered);
    }
    if (this.options.transparentFirst) {
      ordered.splice(ordered.indexOf(RenderBucket.Transparent), 1);
      ordered.unshift(RenderBucket.Transparent);
    }
    return ordered;
  }

  /** Returns the list bucket backing a bucket identifier. */
  private bucketOf(list: RenderList<T>, bucket: RenderBucket): RenderListItem<T>[] {
    switch (bucket) {
      case RenderBucket.Ordered:
        return list.ordered;
      case RenderBucket.Transparent:
        return list.transparent;
      default:
        return list.opaque;
    }
  }
}

/** Monotonic clock reading in milliseconds. */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
