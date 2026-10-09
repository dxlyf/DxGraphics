/**
 * Typed rendering-context acquisition.
 *
 * Wraps `canvas.getContext` with per-context attribute presets and turns the
 * silent `null` return of the DOM API into a descriptive error.
 *
 * @packageDocumentation
 */

import { asCanvasLike, READ_FREQUENTLY_FLAG, type CanvasLike } from './createCanvas';

/* -------------------------------------------------------------------------- */
/* Context identifiers and attribute bags                                     */
/* -------------------------------------------------------------------------- */

/** Context identifiers understood by {@link getContext}. */
export type ContextId = '2d' | 'webgl2' | 'webgl' | 'bitmaprenderer' | 'webgpu';

/** Attribute preset keyed by {@link ContextId}. */
export type ContextAttributes = {
  '2d': CanvasRenderingContext2DSettings;
  webgl2: WebGLContextAttributes;
  webgl: WebGLContextAttributes;
  bitmaprenderer: ImageBitmapRenderingContextSettings;
  webgpu: Record<string, unknown>;
};

/** Options accepted by {@link getContext}. */
export interface GetContextOptions {
  /** Reuse a context that was requested earlier; forwarded to the DOM API. */
  forceFallbackAdapter?: boolean;
  /** Overrides/extends the preset attributes for the requested context id. */
  attributes?: Record<string, unknown>;
  /** Silences the thrown error and returns `null` instead. */
  optional?: boolean;
}

/**
 * Default attributes applied per context id.
 *
 * The 2D preset disables the deprecated alpha/desynchronisation behaviour and
 * enables `willReadFrequently`, because the pixel-program emulation in
 * {@link file://./../canvas2d/Canvas2DShader.ts} reads pixels back every frame.
 */
export const CONTEXT_ATTRIBUTE_PRESETS: ContextAttributes = {
  '2d': {
    alpha: true,
    desynchronized: false,
    willReadFrequently: true,
    colorSpace: 'srgb',
  },
  webgl2: {
    alpha: true,
    antialias: true,
    depth: true,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'default',
    failIfMajorPerformanceCaveat: false,
  },
  webgl: {
    alpha: true,
    antialias: true,
    depth: true,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'default',
    failIfMajorPerformanceCaveat: false,
  },
  bitmaprenderer: {
    alpha: true,
  },
  webgpu: {},
};

/* -------------------------------------------------------------------------- */
/* Typed overloads                                                            */
/* -------------------------------------------------------------------------- */

/** Acquires a 2D context. */
export function getContext(canvas: CanvasLike, contextId: '2d', options?: GetContextOptions): CanvasRenderingContext2D | null;
/** Acquires a WebGL2 context. */
export function getContext(canvas: CanvasLike, contextId: 'webgl2', options?: GetContextOptions): WebGL2RenderingContext | null;
/** Acquires a WebGL1 context. */
export function getContext(canvas: CanvasLike, contextId: 'webgl', options?: GetContextOptions): WebGLRenderingContext | null;
/** Acquires an `ImageBitmapRenderingContext`. */
export function getContext(canvas: CanvasLike, contextId: 'bitmaprenderer', options?: GetContextOptions): ImageBitmapRenderingContext | null;
/** Acquires a WebGPU canvas context. */
export function getContext(canvas: CanvasLike, contextId: 'webgpu', options?: GetContextOptions): GPUCanvasContext | null;
/** Acquires any context by id. */
export function getContext(canvas: CanvasLike, contextId: ContextId, options?: GetContextOptions): unknown;

/**
 * Requests a rendering context from `canvas`.
 *
 * The returned value is narrowed by the `contextId` literal, so
 * `getContext(canvas, '2d')` is typed as `CanvasRenderingContext2D | null`
 * without a cast at the call site.
 *
 * @param canvas Canvas to acquire the context from.
 * @param contextId One of `'2d'`, `'webgl2'`, `'webgl'`, `'bitmaprenderer'`, `'webgpu'`.
 * @param options Preset overrides and optional-failure behaviour.
 * @returns The context, or `null` when `options.optional` is set and creation failed.
 * @throws Error When the canvas is invalid, or the context could not be created.
 */
export function getContext(
  canvas: CanvasLike,
  contextId: ContextId,
  options: GetContextOptions = {},
): unknown {
  const surface = asCanvasLike(canvas);
  if (surface === null) {
    throw new Error(
      `getContext: expected a canvas-like object with numeric 'width'/'height' and a ` +
        `'getContext' function, received ${describe(canvas)}.`,
    );
  }

  const preset = CONTEXT_ATTRIBUTE_PRESETS[contextId] ?? {};
  const attributes: Record<string, unknown> = { ...preset, ...(options.attributes ?? {}) };

  // A concrete canvas passes the hint under its own property name. The string comes
  // from `createCanvas` rather than being repeated here: two copies of a magic
  // property name is how the marker and its reader drift apart.
  const hinted = (surface as unknown as Record<string, unknown>)[READ_FREQUENTLY_FLAG];
  if (contextId === '2d' && hinted === true) attributes['willReadFrequently'] = true;

  let context: unknown = null;
  try {
    context = surface.getContext(contextId, attributes);
  } catch (error) {
    if (options.optional) return null;
    throw new Error(
      `getContext: requesting a '${contextId}' context threw: ${(error as Error)?.message ?? String(error)}.`,
    );
  }

  if (context == null && !options.optional) {
    throw new Error(
      `getContext: could not create a '${contextId}' context on this canvas. ` +
        `The backend may be unavailable in this runtime, the context type may already ` +
        `have been requested with different attributes, or the canvas may be in a state ` +
        `that disallows context creation.`,
    );
  }

  return context ?? null;
}

/**
 * Probes whether a context id can be created, without throwing.
 *
 * @param canvas Canvas to probe.
 * @param contextId Context identifier to test.
 * @returns `true` when a context could be created.
 */
export function isContextSupported(canvas: CanvasLike, contextId: ContextId): boolean {
  return getContext(canvas, contextId, { optional: true }) != null;
}

/** Builds a short description of an arbitrary value for error messages. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  if (type !== 'object' && type !== 'function') return `${type} (${String(value)})`;
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name ? `an instance of ${name}` : `a ${type}`;
}
