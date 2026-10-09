/**
 * `PickingRenderTarget` — the id↔object registry and RGBA8 codec for GPU picking.
 *
 * A GPU pick pass renders the scene to an off-screen RGBA8 target using a shader
 * that outputs each object's id as a colour, then reads one pixel back. This class
 * owns the two things that make that work:
 *
 * 1. **The registry.** A bidirectional `id → object` / `object → id` map with
 *    move-to-front recency, so long-lived editors can retire stale ids.
 * 2. **The codec.** `encodeId` / `decodeId`, which pack a 31-bit id into four bytes
 *    and unpack it again.
 *
 * ## Bit budget
 *
 * ```
 * byte 0 = (id >>>  0) & 0xff
 * byte 1 = (id >>>  8) & 0xff
 * byte 2 = (id >>> 16) & 0xff
 * byte 3 = (id >>> 24) & 0x7f     // top bit reserved
 * ```
 *
 * That is **31 usable bits**, giving a maximum id of `2 147 483 647`. The reserved
 * bit keeps the alpha channel from being `0x80`-and-above, which some drivers treat
 * as a premultiplication hint. `register` **rejects** an id above the budget with a
 * descriptive `RangeError` instead of silently truncating it — a truncated id maps
 * to the wrong object, which is far worse than a loud failure.
 *
 * Id `0` is reserved for "nothing was drawn", so it is never assigned.
 *
 * @packageDocumentation
 */

import { createLogger } from '../utils/Logger';
import type { GPUPickResultLike, PickingIdBitBudget, PickingRendererLike } from './types';
import { PICKING_ID_BUDGET } from './types';

/** Logger shared by the GPU picking path. */
const log = createLogger('picking:gpu');

/**
 * Encodes an id into four bytes.
 *
 * @param id Id to encode; must satisfy `0 <= id <= PICKING_ID_BUDGET.maxId`.
 * @returns `[r, g, b, a]` bytes in `[0, 255]`.
 * @throws RangeError When the id is negative, non-finite or above the budget.
 */
export function encodeId(id: number): [number, number, number, number] {
  assertIdWithinBudget(id, 'encodeId');
  const value = Math.floor(id);
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0x7f,
  ];
}

/**
 * Decodes four bytes back into an id.
 *
 * @param color `[r, g, b, a]` bytes.
 * @returns The id, or `0` when the pixel was empty (all bytes zero).
 */
export function decodeId(color: ArrayLike<number>): number {
  const r = (color[0] ?? 0) & 0xff;
  const g = (color[1] ?? 0) & 0xff;
  const b = (color[2] ?? 0) & 0xff;
  const a = (color[3] ?? 0) & 0x7f;
  if (r === 0 && g === 0 && b === 0 && a === 0) return 0;
  // `>>> 0` keeps the result unsigned; the shift can produce a negative int32.
  return ((r | (g << 8) | (b << 16) | (a << 24)) >>> 0) & PICKING_ID_BUDGET.maxId;
}

/**
 * Converts an id into a normalised RGBA tuple for a clear colour or a uniform.
 *
 * @param id Id to convert.
 * @returns Four floats in `[0, 1]`.
 */
export function idToRgba(id: number): [number, number, number, number] {
  const bytes = encodeId(id);
  return [bytes[0] / 255, bytes[1] / 255, bytes[2] / 255, bytes[3] / 255];
}

/**
 * Throws when an id cannot be encoded.
 *
 * @param id Candidate id.
 * @param context Function name used in the message.
 * @throws RangeError When the id is out of budget.
 */
export function assertIdWithinBudget(id: number, context: string): void {
  if (!Number.isFinite(id) || id < 0) {
    throw new RangeError(
      `${context}: picking ids must be finite and non-negative, received ${id}.`,
    );
  }
  if (id > PICKING_ID_BUDGET.maxId) {
    throw new RangeError(
      `${context}: picking id ${id} exceeds the ${PICKING_ID_BUDGET.bits}-bit budget ` +
        `(maximum ${PICKING_ID_BUDGET.maxId}). The id is packed into four 8-bit channels ` +
        `with the high bit of alpha reserved, so ids above that would collide with a ` +
        `different object after readback. Use a second picking target, or assign ids from ` +
        `a smaller pool.`,
    );
  }
}

/**
 * The id registry plus the off-screen target description.
 *
 * @typeParam TTarget Object type stored in the registry.
 */
export class PickingRenderTarget<TTarget = unknown> {
  /** Bit budget applied by {@link PickingRenderTarget.register}. */
  public readonly budget: PickingIdBitBudget = PICKING_ID_BUDGET;

  /** Target width in device pixels. */
  public width: number;

  /** Target height in device pixels. */
  public height: number;

  /** Device-pixel ratio used to convert logical coordinates. */
  public pixelRatio: number;

  /** Renderer that owns the target, when one was supplied. */
  public renderer: PickingRendererLike | null;

  /** The backend target handle, once created. */
  public handle: unknown = null;

  /** Colour the target is cleared to; id `0` means "nothing". */
  public clearColor: [number, number, number, number] = [0, 0, 0, 0];

  /** Next id handed out by {@link PickingRenderTarget.register} without an explicit id. */
  private nextId = 1;

  /** id → object. */
  private readonly byId = new Map<number, TTarget>();

  /** object → id. */
  private readonly byObject = new Map<TTarget, number>();

  /** Ids in most-recently-registered-first order. */
  private readonly recency: number[] = [];

  /**
   * Creates a picking target.
   *
   * @param width Target width in device pixels.
   * @param height Target height in device pixels.
   * @param renderer Renderer used for the pick pass.
   * @param pixelRatio Device-pixel ratio; defaults to `1`.
   */
  constructor(
    width = 1,
    height = 1,
    renderer: PickingRendererLike | null = null,
    pixelRatio = 1,
  ) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.renderer = renderer;
    this.pixelRatio = pixelRatio > 0 ? pixelRatio : 1;
  }

  /* ---------------------------------------------------------------- registry */

  /**
   * Registers an object and returns its id.
   *
   * Registering the same object twice returns the id it already had. Registering an
   * explicit id that is already taken by a **different** object replaces it and
   * unwinds the previous binding, which is what a scene reload needs.
   *
   * @param object Object to register.
   * @param id Explicit id, or `undefined` to allocate the next free one.
   * @returns The id assigned to `object`.
   * @throws RangeError When `id` is out of budget, or when the id space is exhausted.
   */
  public register(object: TTarget, id?: number): number {
    const existing = this.byObject.get(object);
    if (existing !== undefined && id === undefined) {
      this.touch(existing);
      return existing;
    }

    if (id !== undefined) {
      assertIdWithinBudget(id, 'PickingRenderTarget.register');
      if (id === 0) {
        throw new RangeError(
          'PickingRenderTarget.register: id 0 is reserved for "nothing was drawn"; ' +
            'start ids at 1.',
        );
      }
      const previous = this.byId.get(id);
      if (previous !== undefined && previous !== object) {
        this.byObject.delete(previous);
      }
      // Drop any stale id the object previously held.
      if (existing !== undefined && existing !== id) {
        this.byId.delete(existing);
        const index = this.recency.indexOf(existing);
        if (index >= 0) this.recency.splice(index, 1);
      }
      this.byId.set(id, object);
      this.byObject.set(object, id);
      this.touch(id);
      return id;
    }

    const allocated = this.allocateId();
    this.byId.set(allocated, object);
    this.byObject.set(object, allocated);
    this.recency.unshift(allocated);
    return allocated;
  }

  /**
   * Removes an object, or a bare id.
   *
   * @param target Object or id to remove.
   * @returns `true` when something was removed.
   */
  public unregister(target: TTarget | number): boolean {
    const id = typeof target === 'number' ? target : this.byObject.get(target);
    if (id === undefined) return false;

    const object = this.byId.get(id);
    this.byId.delete(id);
    if (object !== undefined) this.byObject.delete(object);
    const index = this.recency.indexOf(id);
    if (index >= 0) this.recency.splice(index, 1);
    return true;
  }

  /**
   * Looks an object up by id.
   *
   * @param id Id to resolve.
   * @returns The object, or `undefined` for id `0` and unknown ids.
   */
  public getObject(id: number): TTarget | undefined {
    if (id === 0) return undefined;
    return this.byId.get(id);
  }

  /**
   * Looks an id up by object.
   *
   * @param object Object to resolve.
   * @returns The id, or `undefined`.
   */
  public getId(object: TTarget): number | undefined {
    return this.byObject.get(object);
  }

  /**
   * `true` when an id is registered.
   *
   * @param id Id to test.
   * @returns `true` when the id maps to an object.
   */
  public has(id: number): boolean {
    return this.byId.has(id);
  }

  /** Number of registered ids. */
  public get size(): number {
    return this.byId.size;
  }

  /**
   * Removes every registration and resets the id allocator.
   *
   * @returns This target, for chaining.
   */
  public clearRegistry(): this {
    this.byId.clear();
    this.byObject.clear();
    this.recency.length = 0;
    this.nextId = 1;
    return this;
  }

  /** Moves an id to the front of the recency list. */
  private touch(id: number): void {
    const index = this.recency.indexOf(id);
    if (index >= 0) this.recency.splice(index, 1);
    this.recency.unshift(id);
  }

  /** Finds the next free id, skipping `0`. */
  private allocateId(): number {
    let candidate = this.nextId;
    while (candidate === 0 || this.byId.has(candidate)) {
      candidate++;
      if (candidate > PICKING_ID_BUDGET.maxId) {
        throw new RangeError(
          `PickingRenderTarget: the ${PICKING_ID_BUDGET.bits}-bit id space is exhausted ` +
            `(${this.byId.size} objects registered). Unregister objects you no longer need, ` +
            'or use a second picking target.',
        );
      }
    }
    this.nextId = candidate + 1;
    return candidate;
  }

  /* ------------------------------------------------------------ render target */

  /**
   * Creates (or re-creates) the backend target.
   *
   * A no-op when no renderer was supplied — the registry still works, which is what
   * lets the codec and the registry be unit-tested headlessly.
   *
   * @param options Target description forwarded to the renderer.
   * @returns The backend handle, or `null`.
   */
  public create(options: Record<string, unknown> = {}): unknown {
    if (this.renderer === null || typeof this.renderer.createRenderTarget !== 'function') {
      log.debug('no renderer attached; the picking target stays registry-only');
      return null;
    }
    if (this.handle !== null) return this.handle;

    this.handle = this.renderer.createRenderTarget({
      width: this.width,
      height: this.height,
      colorAttachments: 1,
      depth: true,
      format: 'rgba8',
      filter: 'nearest',
      ...options,
    });
    return this.handle;
  }

  /**
   * Releases the backend target, keeping the registry intact.
   *
   * @returns This target, for chaining.
   */
  public destroy(): this {
    if (this.handle !== null && typeof this.renderer?.destroyRenderTarget === 'function') {
      this.renderer.destroyRenderTarget(this.handle);
    }
    this.handle = null;
    return this;
  }

  /**
   * Resizes the target.
   *
   * @param width New width in device pixels.
   * @param height New height in device pixels.
   * @returns This target, for chaining.
   */
  public setSize(width: number, height: number): this {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));

    const target = this.handle as { setSize?(w: number, h: number): void } | null;
    target?.setSize?.(this.width, this.height);
    return this;
  }

  /* ------------------------------------------------------------------ read */

  /**
   * Reads one pixel back.
   *
   * Accepts either device-pixel coordinates or a pre-read colour, so a caller that
   * already has the bytes (from a batched readback) does not pay for a second read.
   *
   * @param x Pixel X in device pixels.
   * @param y Pixel Y in device pixels.
   * @param color Optional colour to decode instead of reading the target.
   * @returns The byte tuple, or `null` when no renderer/readback is available.
   */
  public readPixel(x: number, y: number, color?: ArrayLike<number>): [number, number, number, number] | null {
    if (color !== undefined) {
      return [(color[0] ?? 0) & 0xff, (color[1] ?? 0) & 0xff, (color[2] ?? 0) & 0xff, (color[3] ?? 0) & 0xff];
    }

    const renderer = this.renderer;
    if (renderer === null) return null;

    if (typeof renderer.readPixel === 'function') {
      const result = renderer.readPixel(x, y);
      if (result === null) return null;
      return [(result[0] ?? 0) & 0xff, (result[1] ?? 0) & 0xff, (result[2] ?? 0) & 0xff, (result[3] ?? 0) & 0xff];
    }

    if (typeof renderer.readPixels === 'function') {
      const result = renderer.readPixels(x, y, 1, 1);
      if (result === null) return null;
      return [(result[0] ?? 0) & 0xff, (result[1] ?? 0) & 0xff, (result[2] ?? 0) & 0xff, (result[3] ?? 0) & 0xff];
    }

    return null;
  }

  /**
   * Resolves a pixel to an object.
   *
   * @param x Pixel X in device pixels.
   * @param y Pixel Y in device pixels.
   * @param color Optional pre-read colour.
   * @returns The pick result, or `null` when nothing could be read.
   */
  public pick(x: number, y: number, color?: ArrayLike<number>): GPUPickResultLike<TTarget> | null {
    const bytes = this.readPixel(x, y, color);
    if (bytes === null) return null;

    const id = decodeId(bytes);
    const object = this.getObject(id);
    return {
      id,
      x,
      y,
      color: bytes,
      ...(object === undefined ? {} : { object }),
    };
  }

  /**
   * Converts a logical (CSS-pixel) coordinate into device pixels.
   *
   * @param x Logical X.
   * @param y Logical Y.
   * @returns The device-pixel pair.
   */
  public toDevicePixels(x: number, y: number): { x: number; y: number } {
    return { x: Math.round(x * this.pixelRatio), y: Math.round(y * this.pixelRatio) };
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return `PickingRenderTarget(${this.width}x${this.height}, ids=${this.byId.size})`;
  }
}

/**
 * Convenience factory mirroring `new PickingRenderTarget(...)`.
 *
 * @typeParam TTarget Object type stored in the registry.
 * @param width Target width in device pixels.
 * @param height Target height in device pixels.
 * @param renderer Renderer used for the pick pass.
 * @param pixelRatio Device-pixel ratio.
 * @returns A new picking render target.
 */
export function pickingRenderTarget<TTarget = unknown>(
  width = 1,
  height = 1,
  renderer: PickingRendererLike | null = null,
  pixelRatio = 1,
): PickingRenderTarget<TTarget> {
  return new PickingRenderTarget<TTarget>(width, height, renderer, pixelRatio);
}
