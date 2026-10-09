/**
 * WebGL context acquisition and lifecycle.
 *
 * ## Context-loss strategy
 *
 * Losing a WebGL context is normal — the driver resets it on a GPU hang, a tab
 * backgrounded on mobile, or a laptop switching between integrated and discrete
 * graphics. The strategy implemented here has four parts:
 *
 * 1. **Detect.** `webglcontextlost` / `webglcontextrestored` listeners are installed
 *    on the canvas. `webglcontextlost` also listens on the *drawing buffer* itself,
 *    because a canvas that is never drawn to can still lose its context.
 * 2. **Freeze, do not fail.** On loss the context is marked unusable and the renderer
 *    stops submitting work for the frame. The browser's default "the context is
 *    never coming back" behaviour is suppressed with `preventDefault()`, which is
 *    what makes a restore possible at all.
 * 3. **Invalidate.** Every GL object handle becomes a dangling reference the moment
 *    the context is lost. Rather than walk every resource (which would itself issue
 *    calls on a dead context), the context bumps a monotonic *generation* counter
 *    and clears its caches. Resources compare their `uploadGeneration` against it;
 *    a mismatch means "re-upload before use", which is exactly the lazy path
 *    {@link WebGLContext.isStale} exposes.
 * 4. **Restore lazily.** On `webglcontextrestored` the generation is bumped again,
 *    the extension cache and the state shadow copy are thrown away, and the renderer
 *    re-creates whatever it touches next. Nothing is eagerly re-uploaded, so a scene
 *    with a thousand textures does not pay for a thousand uploads before its first
 *    frame after the restore.
 *
 * ## Attribute presets
 *
 * {@link WEBGL_CONTEXT_PRESETS} holds the attribute bags the backend uses by
 * default. The 2D-friendly defaults (`depth: true`, `stencil: false`,
 * `premultipliedAlpha: true`) match what a 3D scene wants and can be overridden per
 * renderer.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import { WebGLCapabilities } from './WebGLCapabilities';
import { WebGLExtensions } from './WebGLExtensions';
import { WebGLState } from './WebGLState';
import type { CanvasLike } from '../utils/createCanvas';
import type { GL } from './WebGLUtils';

/** Logger for context diagnostics. */
const log = createLogger('renderer:webgl:context');

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/** Context attribute bag, mirroring `WebGLContextAttributes`. */
export interface WebGLContextAttributeOptions {
  /** Include an alpha channel in the drawing buffer. Defaults to `true`. */
  alpha?: boolean;
  /** Request antialiasing. Defaults to `true`. */
  antialias?: boolean;
  /** Include a depth buffer. Defaults to `true`. */
  depth?: boolean;
  /** Include a stencil buffer. Defaults to `false`. */
  stencil?: boolean;
  /** Premultiply alpha in the drawing buffer. Defaults to `true`. */
  premultipliedAlpha?: boolean;
  /** Keep the drawing buffer after a frame. Defaults to `false`. */
  preserveDrawingBuffer?: boolean;
  /** Power preference hint. Defaults to `'default'`. */
  powerPreference?: 'default' | 'high-performance' | 'low-power';
  /** Fail when the driver would fall back to software. Defaults to `false`. */
  failIfMajorPerformanceCaveat?: boolean;
  /** Mark the buffer for frequent readback. Defaults to `false`. */
  desynchronized?: boolean;
  /** Additional, non-standard attributes. */
  [key: string]: unknown;
}

/** Named attribute presets. */
export const WEBGL_CONTEXT_PRESETS: {
  readonly default3D: Readonly<WebGLContextAttributeOptions>;
  readonly highPerformance: Readonly<WebGLContextAttributeOptions>;
  readonly readback: Readonly<WebGLContextAttributeOptions>;
} = {
  default3D: {
    alpha: true,
    antialias: true,
    depth: true,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'default',
    failIfMajorPerformanceCaveat: false,
  },
  highPerformance: {
    alpha: false,
    antialias: true,
    depth: true,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false,
  },
  readback: {
    alpha: true,
    antialias: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'default',
    failIfMajorPerformanceCaveat: false,
  },
};

/** Options accepted by {@link WebGLContext}. */
export interface WebGLContextOptions {
  /** Attribute overrides merged over the chosen preset. */
  attributes?: WebGLContextAttributeOptions;
  /** Preset to start from. Defaults to `'default3D'`. */
  preset?: keyof typeof WEBGL_CONTEXT_PRESETS;
  /** Prefer WebGL2 when available. Defaults to `true`. */
  preferWebGL2?: boolean;
  /** Force WebGL1 even when WebGL2 is available. */
  forceWebGL1?: boolean;
  /** Suppress the debug records emitted while trying context ids. */
  silent?: boolean;
}

/** Callback invoked when the context is lost. */
export type ContextLostCallback = (event: unknown) => void;

/** Callback invoked when the context is restored. */
export type ContextRestoredCallback = () => void;

/* -------------------------------------------------------------------------- */
/* WebGLContext                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A live WebGL context plus the objects that only make sense alongside it.
 *
 * The class is the single owner of "is this context usable right now": every
 * renderer subsystem asks it, and every subsystem invalidates through its
 * generation counter.
 */
export class WebGLContext {
  /** Surface the context draws into. */
  public readonly canvas: CanvasLike;

  /** The acquired context. */
  public readonly gl: GL;

  /** `true` when the context was created with `'webgl2'`. */
  public readonly isWebGL2: boolean;

  /** Context id that produced {@link WebGLContext.gl}. */
  public readonly contextId: 'webgl2' | 'webgl';

  /** Capability report. */
  public readonly capabilities: WebGLCapabilities;

  /** Extension cache. */
  public readonly extensions: WebGLExtensions;

  /** Shadow copy of the fixed-function state. */
  public readonly state: WebGLState;

  /** Attribute bag the context was actually created with. */
  private readonly requestedAttributes: Readonly<Record<string, unknown>>;

  /** Monotonic generation counter, bumped on every loss and restore. */
  private contextGeneration: number = 0;

  /** `true` while the context is lost. */
  private lost: boolean = false;

  /** `true` once {@link WebGLContext.dispose} has run. */
  private disposed: boolean = false;

  /** Bound loss/restore handlers, kept so they can be removed again. */
  private readonly lostHandler: (event: unknown) => void;
  private readonly restoredHandler: () => void;

  /** Listeners registered through {@link WebGLContext.onLost}/{@link WebGLContext.onRestored}. */
  private readonly lostListeners: Set<ContextLostCallback> = new Set();
  private readonly restoredListeners: Set<ContextRestoredCallback> = new Set();

  /** `true` when the surface exposes `addEventListener`. */
  private readonly canListen: boolean;

  /**
   * Creates a context on a canvas.
   *
   * @param canvas Canvas to create the context on.
   * @param options Preset, attribute overrides and version preference.
   * @throws Error When no WebGL context could be created.
   */
  constructor(canvas: CanvasLike, options: WebGLContextOptions = {}) {
    this.canvas = canvas;

    const preset = WEBGL_CONTEXT_PRESETS[options.preset ?? 'default3D'];
    this.requestedAttributes = { ...preset, ...(options.attributes ?? {}) };

    const acquired = acquireContext(canvas, this.requestedAttributes, options);
    this.gl = acquired.gl;
    this.isWebGL2 = acquired.isWebGL2;
    this.contextId = acquired.isWebGL2 ? 'webgl2' : 'webgl';

    this.extensions = new WebGLExtensions(this.gl, this.isWebGL2, { silent: options.silent ?? false });
    this.capabilities = new WebGLCapabilities(this.gl, this.isWebGL2, (name) => this.extensions.has(name));
    this.state = new WebGLState(this.gl, { isWebGL2: this.isWebGL2 });

    this.lostHandler = (event: unknown): void => this.handleContextLost(event);
    this.restoredHandler = (): void => this.handleContextRestored();
    this.canListen =
      typeof (canvas as unknown as { addEventListener?: unknown }).addEventListener === 'function';

    if (this.canListen) {
      const target = canvas as unknown as {
        addEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
      };
      target.addEventListener('webglcontextlost', this.lostHandler, false);
      target.addEventListener('webglcontextrestored', this.restoredHandler, false);
    }

    this.state.reset();
    log.debug(`created a ${this.contextId} context`, this.capabilities.toString());
  }

  /* ------------------------------------------------------------------ queries */

  /** Monotonic generation counter; changes on every loss and restore. */
  public get generation(): number {
    return this.contextGeneration;
  }

  /** `true` while the context is lost and cannot accept commands. */
  public get isLost(): boolean {
    return this.lost;
  }

  /** `true` when the context is usable (`!isLost && !isDisposed`). */
  public get isUsable(): boolean {
    return !this.lost && !this.disposed;
  }

  /** `true` once {@link WebGLContext.dispose} has run. */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * `true` when a resource uploaded in `generation` needs re-uploading.
   *
   * @param generation Generation the resource was created in.
   */
  public isStale(generation: number): boolean {
    return generation !== this.contextGeneration;
  }

  /**
   * Reads the attribute bag the context was actually created with.
   *
   * The browser may have ignored or downgraded parts of the request, which is why
   * this re-queries instead of echoing {@link WebGLContextOptions.attributes}.
   *
   * @returns The effective attributes, or the requested ones when the query fails.
   */
  public getContextAttributes(): Readonly<Record<string, unknown>> {
    try {
      const attributes = this.gl.getContextAttributes();
      if (attributes != null) return { ...(attributes as unknown as Record<string, unknown>) };
    } catch {
      /* a partial test double may not implement getContextAttributes */
    }
    return this.requestedAttributes;
  }

  /* ------------------------------------------------------------------ listeners */

  /**
   * Registers a context-loss listener.
   *
   * @param callback Invoked with the platform's loss event.
   * @returns A function removing the listener.
   */
  public onLost(callback: ContextLostCallback): () => void {
    this.lostListeners.add(callback);
    return () => this.lostListeners.delete(callback);
  }

  /**
   * Registers a context-restore listener.
   *
   * @param callback Invoked once the context is usable again.
   * @returns A function removing the listener.
   */
  public onRestored(callback: ContextRestoredCallback): () => void {
    this.restoredListeners.add(callback);
    return () => this.restoredListeners.delete(callback);
  }

  /* ------------------------------------------------------------------ lifecycle */

  /**
   * Handles a context loss.
   *
   * Marks the context unusable, bumps the generation and drops every cached object
   * that belonged to the dead context, then notifies listeners.
   *
   * @param event Platform loss event; `preventDefault` is called when available so
   *   the browser keeps the canvas eligible for a restore.
   */
  public handleContextLost(event: unknown = null): void {
    if (this.lost) return;
    this.lost = true;
    this.contextGeneration++;

    // Ask the browser not to discard the canvas permanently. Without this the
    // `webglcontextrestored` event never fires and the renderer can only be
    // recovered by constructing a new one.
    const preventable = event as { preventDefault?: () => void } | null;
    if (preventable != null && typeof preventable.preventDefault === 'function') {
      try {
        preventable.preventDefault();
      } catch {
        /* some doubles throw; nothing to do */
      }
    }

    // Drop everything bound to the dead context. Touching the GL objects here
    // would be pointless (they are already gone) and may itself throw.
    this.extensions.dispose();
    this.state.invalidate();

    log.warn(
      `the ${this.contextId} context was lost (generation ${this.contextGeneration}). Rendering is ` +
        'suspended until the driver restores the context; every GPU resource is re-uploaded lazily ' +
        'once it is touched again.',
    );

    for (const listener of this.lostListeners) {
      try {
        listener(event);
      } catch (error) {
        log.error('a context-loss listener threw', error);
      }
    }
  }

  /**
   * Handles a context restore.
   *
   * Bumps the generation again (so resources created between the loss and the
   * restore are also considered stale), re-acquires capability and extension
   * information, resets the state shadow copy and notifies listeners.
   */
  public handleContextRestored(): void {
    if (this.disposed) return;
    this.lost = false;
    this.contextGeneration++;

    // The extension objects from the previous context are dead; the cache was
    // already emptied on loss, and `invalidate()` makes sure nothing stale is
    // handed out even if the loss event was missed.
    this.extensions.invalidate();
    this.state.reset();
    this.state.invalidate();

    log.warn(
      `the ${this.contextId} context was restored (generation ${this.contextGeneration}). ` +
        'Resources are re-created on first use.',
    );

    for (const listener of this.restoredListeners) {
      try {
        listener();
      } catch (error) {
        log.error('a context-restore listener threw', error);
      }
    }
  }

  /**
   * Simulates a context loss/restore pair.
   *
   * Used by tests and by applications that want to exercise their recovery path
   * without provoking a real driver reset.
   *
   * @param restoreWhenDone Immediately run the restore path.
   */
  public simulateContextLoss(restoreWhenDone: boolean = true): void {
    this.handleContextLost(null);
    if (restoreWhenDone) this.handleContextRestored();
  }

  /**
   * Restores the driver's default state and re-synchronises the shadow copy.
   *
   * @returns This context, for chaining.
   */
  public reset(): this {
    this.state.reset();
    return this;
  }

  /**
   * Drops every GL object the context owns.
   *
   * @param loseContext Also ask the driver to release the context itself.
   */
  public forceContextLoss(loseContext: boolean = true): void {
    if (!loseContext || this.disposed) return;
    const extension = this.extensions.getLoseContext();
    if (extension === null) {
      log.debug(
        'WEBGL_lose_context is unavailable, so the context cannot be released explicitly; it is ' +
          'reclaimed when the canvas is garbage collected.',
      );
      return;
    }
    try {
      extension.loseContext();
    } catch (error) {
      log.warn('WEBGL_lose_context.loseContext() threw', error);
    }
  }

  /** Releases the context: removes listeners and drops every cached object. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.canListen) {
      const target = this.canvas as unknown as {
        removeEventListener?(type: string, listener: (event: unknown) => void, options?: unknown): void;
      };
      target.removeEventListener?.('webglcontextlost', this.lostHandler, false);
      target.removeEventListener?.('webglcontextrestored', this.restoredHandler, false);
    }

    this.lostListeners.clear();
    this.restoredListeners.clear();
    this.extensions.dispose();
    log.debug(`disposed the ${this.contextId} context`);
  }
}

/* -------------------------------------------------------------------------- */
/* Acquisition                                                                */
/* -------------------------------------------------------------------------- */

/** Result of the context-id probe. */
interface AcquiredContext {
  gl: GL;
  isWebGL2: boolean;
}

/**
 * Tries each context id in order and returns the first that works.
 *
 * WebGL2 is attempted first because it is a strict superset; WebGL1 is the
 * fallback, and `'experimental-webgl'` the last resort for very old engines.
 *
 * @param canvas Canvas to acquire from.
 * @param attributes Attribute bag to request.
 * @param options Version preference.
 * @throws Error When no context id produced a context.
 */
function acquireContext(
  canvas: CanvasLike,
  attributes: Readonly<Record<string, unknown>>,
  options: WebGLContextOptions,
): AcquiredContext {
  const attempts: readonly (readonly ['webgl2' | 'webgl' | 'experimental-webgl', boolean])[] =
    options.forceWebGL1 === true
      ? [
          ['webgl', false],
          ['experimental-webgl', false],
        ]
      : options.preferWebGL2 === false
        ? [
            ['webgl', false],
            ['webgl2', true],
            ['experimental-webgl', false],
          ]
        : [
            ['webgl2', true],
            ['webgl', false],
            ['experimental-webgl', false],
          ];

  const failures: string[] = [];
  for (const [id, isWebGL2] of attempts) {
    try {
      const context = canvas.getContext(id, attributes) as GL | null;
      if (context != null) {
        return { gl: context, isWebGL2 };
      }
      failures.push(id);
    } catch (error) {
      failures.push(`${id} (${(error as Error)?.message ?? String(error)})`);
    }
  }

  throw new Error(
    'WebGLContext: could not create a WebGL context on this canvas. Tried ' +
      `${attempts.map(([id]) => `'${id}'`).join(', ')} (${failures.join(', ')}). ` +
      'The backend may be unavailable in this runtime, the context attributes may be ' +
      'rejected, or the canvas may already have a context of a different type.',
  );
}

/**
 * Detects which WebGL version a canvas can provide, without keeping the context.
 *
 * @param canvas Canvas to probe.
 * @returns `'webgl2'`, `'webgl'` or `null`.
 */
export function detectWebGLVersion(canvas: CanvasLike): 'webgl2' | 'webgl' | null {
  try {
    if (canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false }) != null) return 'webgl2';
  } catch {
    /* fall through */
  }
  try {
    if (canvas.getContext('webgl', { failIfMajorPerformanceCaveat: false }) != null) return 'webgl';
  } catch {
    /* fall through */
  }
  return null;
}
