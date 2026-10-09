/**
 * Cross-runtime canvas creation.
 *
 * This module is the only place in the library that decides *which* canvas
 * implementation to instantiate. It prefers an `OffscreenCanvas` (available in
 * workers and in modern browsers) and falls back to a DOM `<canvas>`.
 *
 * @packageDocumentation
 */

import { hasOffscreenCanvas } from '../../utils/BrowserUtils';

/* -------------------------------------------------------------------------- */
/* Structural canvas types                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The subset of `HTMLCanvasElement` the renderers actually touch.
 *
 * Both `HTMLCanvasElement` and `OffscreenCanvas` satisfy this shape, and so do
 * the hand-written doubles used by the unit tests. Every renderer accepts this
 * rather than the concrete DOM type so that headless and worker code paths stay
 * type-checkable without a DOM.
 */
export interface CanvasLike {
  /** Backing-store width in device pixels. */
  width: number;
  /** Backing-store height in device pixels. */
  height: number;
  /** Requests a rendering context; returns `null` when unsupported. */
  getContext(contextId: string, options?: unknown): unknown;
}

/** Options accepted by {@link createCanvas}. */
export interface CreateCanvasOptions {
  /** Backing-store width in device pixels. Defaults to `300`. */
  width?: number;
  /** Backing-store height in device pixels. Defaults to `150`. */
  height?: number;
  /**
   * Hints the 2D context that `getImageData` will be called frequently.
   *
   * Stored on the returned canvas as {@link READ_FREQUENTLY_FLAG} because the
   * context does not exist yet at creation time; `getContext` forwards it.
   */
  willReadFrequently?: boolean;
}

/** Property name used to carry the `willReadFrequently` hint on a canvas. */
export const READ_FREQUENTLY_FLAG = '__dxylWillReadFrequently';

/** A canvas created by {@link createCanvas}, tagged with the hint. */
export interface CreatedCanvas extends CanvasLike {
  /** Present (and `true`) only when `willReadFrequently` was requested. */
  readonly [READ_FREQUENTLY_FLAG]?: boolean;
}

/* -------------------------------------------------------------------------- */
/* OffscreenCanvas constructor typing                                         */
/* -------------------------------------------------------------------------- */

/** Constructor signature of `OffscreenCanvas`, typed without the DOM lib. */
type OffscreenCanvasCtor = new (width?: number, height?: number) => CanvasLike;

/* -------------------------------------------------------------------------- */
/* Implementation                                                             */
/* -------------------------------------------------------------------------- */

/** Normalises a dimension to a strictly positive integer. */
function normalizeDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

/**
 * Creates a canvas using whichever implementation the runtime provides.
 *
 * Preference order:
 *  1. `OffscreenCanvas` (workers, and browsers that expose it);
 *  2. a DOM `<canvas>` created through `document.createElement('canvas')`.
 *
 * Unlike the convenience helper in `utils/DomUtils`, this function throws a
 * descriptive error when neither implementation exists instead of silently
 * returning `null`, which makes headless misconfiguration obvious.
 *
 * @param options Backing-store size and context hints.
 * @returns A canvas usable as a renderer surface.
 * @throws Error When the runtime exposes neither `OffscreenCanvas` nor a DOM.
 *
 * @example
 * ```ts
 * const canvas = createCanvas({ width: 640, height: 480 });
 * const ctx = getContext(canvas, '2d');
 * ```
 */
export function createCanvas(options: CreateCanvasOptions = {}): CreatedCanvas {
  const width = normalizeDimension(options.width, 300);
  const height = normalizeDimension(options.height, 150);
  const willReadFrequently = options.willReadFrequently === true;

  const globalObject = globalThis as unknown as { OffscreenCanvas?: OffscreenCanvasCtor };
  if (hasOffscreenCanvas() && typeof globalObject.OffscreenCanvas === 'function') {
    const canvas = new globalObject.OffscreenCanvas(width, height);
    if (willReadFrequently) {
      Object.defineProperty(canvas, READ_FREQUENTLY_FLAG, {
        value: true,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    return canvas as CreatedCanvas;
  }

  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    if (willReadFrequently) {
      Object.defineProperty(canvas, READ_FREQUENTLY_FLAG, {
        value: true,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    return canvas as unknown as CreatedCanvas;
  }

  throw new Error(
    'createCanvas: no canvas implementation is available. Expected either ' +
      '`OffscreenCanvas` (worker / modern browser) or a DOM `document.createElement`. ' +
      'In Node, pass an explicit canvas-like object to the renderer, or run inside a ' +
      'worker thread that provides OffscreenCanvas.',
  );
}

/**
 * Adapts any canvas-like object to {@link CanvasLike}.
 *
 * `HTMLCanvasElement`, `OffscreenCanvas` and test doubles all pass through
 * unchanged; anything lacking the three required members is rejected.
 *
 * @param value Candidate canvas.
 * @returns The same object typed as {@link CanvasLike}, or `null`.
 */
export function asCanvasLike(value: unknown): CanvasLike | null {
  if (value == null || typeof value !== 'object') return null;
  const candidate = value as Partial<CanvasLike>;
  if (typeof candidate.width !== 'number' || typeof candidate.height !== 'number') return null;
  if (typeof candidate.getContext !== 'function') return null;
  return candidate as CanvasLike;
}
