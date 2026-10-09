/**
 * Backend selection and capability probing.
 *
 * The renderer factory is deliberately kept out of this module: this file only
 * answers *which* backend names are usable, in *which* order they should be
 * attempted, so that the factory (and user code) can make the final call.
 *
 * @packageDocumentation
 */

import { BackendNames, type BackendName } from '../../constants';
import type { CanvasLike } from '../utils/createCanvas';
import { getContext, type ContextId } from './getContext';

/* -------------------------------------------------------------------------- */
/* Priority                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Backend preference order used when the caller does not supply one.
 *
 * The 3D-capable backends come first so that a scene with 3D content is not
 * silently flattened onto the 2D backends; `svg` precedes `canvas2d` only when
 * it explicitly appears in a caller-supplied list (see {@link detectBackend}).
 */
export const BACKEND_PRIORITY: readonly BackendName[] = [
  BackendNames.WebGPU,
  BackendNames.WebGL2,
  BackendNames.WebGL,
  BackendNames.Canvas2D,
  BackendNames.SVG,
];

/** The backend used when nothing else can be created. */
export const FALLBACK_BACKEND: BackendName = BackendNames.Canvas2D;

/* -------------------------------------------------------------------------- */
/* Environment probes                                                         */
/* -------------------------------------------------------------------------- */

/** `true` when a DOM `document` with `createElementNS` is reachable. */
function hasSvgDom(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof document.createElementNS === 'function' &&
    typeof document.createElement === 'function'
  );
}

/** `true` when a canvas can be created (DOM or `OffscreenCanvas`). */
function canCreateCanvas(): boolean {
  const globalObject = globalThis as unknown as { OffscreenCanvas?: unknown };
  if (typeof globalObject.OffscreenCanvas === 'function') return true;
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

/** Creates a throwaway canvas for probing, or `null` when impossible. */
function probeCanvas(): CanvasLike | null {
  const globalObject = globalThis as unknown as {
    OffscreenCanvas?: new (w?: number, h?: number) => CanvasLike;
  };
  if (typeof globalObject.OffscreenCanvas === 'function') {
    try {
      return new globalObject.OffscreenCanvas(1, 1);
    } catch {
      /* fall through to the DOM path */
    }
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    try {
      const canvas = document.createElement('canvas') as unknown as CanvasLike;
      canvas.width = 1;
      canvas.height = 1;
      return canvas;
    } catch {
      return null;
    }
  }
  return null;
}

/** Context id required by a backend, or `null` when the backend needs no context. */
function requiredContextId(name: BackendName): ContextId | null {
  switch (name) {
    case BackendNames.Canvas2D:
      return '2d';
    case BackendNames.WebGL:
      return 'webgl';
    case BackendNames.WebGL2:
      return 'webgl2';
    case BackendNames.WebGPU:
      return 'webgpu';
    case BackendNames.SVG:
      return null;
    default:
      return null;
  }
}

/** `true` when `value` is one of the canonical backend names. */
export function isBackendName(value: unknown): value is BackendName {
  return typeof value === 'string' && (BACKEND_PRIORITY as readonly string[]).includes(value);
}

/**
 * Reports whether a backend can be used right now.
 *
 * `'svg'` is supported whenever `document.createElementNS` exists; every other
 * backend is probed by actually creating a canvas and requesting the context it
 * needs, which is the only reliable test in browsers (several of them report a
 * constructor without allowing context creation).
 *
 * @param name Backend to test.
 * @returns `true` when the backend can be instantiated.
 */
export function isBackendSupported(name: BackendName): boolean {
  if (name === BackendNames.SVG) return hasSvgDom();
  if (!canCreateCanvas()) return false;

  const contextId = requiredContextId(name);
  if (contextId === null) return false;

  const canvas = probeCanvas();
  if (canvas === null) return false;

  try {
    return getContext(canvas, contextId, { optional: true }) != null;
  } catch {
    return false;
  }
}

/**
 * Returns the backend preference order.
 *
 * @param preferred When supplied, these backends are placed first (in the given
 *   order) and the remaining {@link BACKEND_PRIORITY} entries follow.
 * @returns A fresh array that the caller may mutate.
 */
export function getBackendPriority(preferred?: readonly BackendName[]): BackendName[] {
  if (preferred == null || preferred.length === 0) return BACKEND_PRIORITY.slice();

  const result: BackendName[] = [];
  for (const name of preferred) {
    if (!isBackendName(name)) continue;
    if (!result.includes(name)) result.push(name);
  }
  for (const name of BACKEND_PRIORITY) {
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

/**
 * Picks the first usable backend.
 *
 * `'canvas2d'` is treated as the universal fallback and is therefore returned
 * even when no canvas implementation exists in the current runtime — the
 * Canvas2D renderer is expected to construct (and defer its failure to
 * `render`) in headless Node. Use {@link isBackendSupported} when a strict
 * answer is required.
 *
 * @param preferred Backend(s) to try first, in order.
 * @param canvas Optional canvas the chosen backend must be able to use.
 * @returns The selected backend name; never `null`.
 *
 * @example
 * ```ts
 * const name = detectBackend();                       // e.g. 'webgl2' in a browser
 * const strict = detectBackendStrict();                // null in Node
 * ```
 */
export function detectBackend(
  preferred?: BackendName | readonly BackendName[],
  canvas?: CanvasLike | null,
): BackendName {
  const preferredList =
    preferred == null ? [] : Array.isArray(preferred) ? (preferred as readonly BackendName[]) : [preferred as BackendName];
  const candidates = getBackendPriority(preferredList);

  for (const name of candidates) {
    if (name === BackendNames.Canvas2D) continue;
    if (name === BackendNames.SVG) {
      if (hasSvgDom()) return name;
      continue;
    }
    if (canvas != null) {
      const contextId = requiredContextId(name);
      if (contextId !== null && getContext(canvas, contextId, { optional: true }) != null) {
        return name;
      }
      continue;
    }
    if (isBackendSupported(name)) return name;
  }

  return FALLBACK_BACKEND;
}

/**
 * Strict variant of {@link detectBackend} that reports "nothing usable".
 *
 * Unlike `detectBackend` this does **not** fall back to `'canvas2d'`, which
 * makes it the right choice for feature detection and diagnostics.
 *
 * @param preferred Backend(s) to try first, in order.
 * @param canvas Optional canvas the chosen backend must be able to use.
 * @returns The selected backend name, or `null` when none is usable.
 */
export function detectBackendStrict(
  preferred?: BackendName | readonly BackendName[],
  canvas?: CanvasLike | null,
): BackendName | null {
  const preferredList =
    preferred == null ? [] : Array.isArray(preferred) ? (preferred as readonly BackendName[]) : [preferred as BackendName];
  const candidates = getBackendPriority(preferredList);

  for (const name of candidates) {
    if (name === BackendNames.SVG) {
      if (hasSvgDom()) return name;
      continue;
    }
    if (canvas != null) {
      const contextId = requiredContextId(name);
      if (contextId !== null && getContext(canvas, contextId, { optional: true }) != null) return name;
      continue;
    }
    if (isBackendSupported(name)) return name;
  }
  return null;
}

/**
 * Lists every usable backend in preference order.
 *
 * @returns The supported subset of {@link BACKEND_PRIORITY}.
 */
export function getSupportedBackendNames(): BackendName[] {
  return BACKEND_PRIORITY.filter((name) => isBackendSupported(name));
}
