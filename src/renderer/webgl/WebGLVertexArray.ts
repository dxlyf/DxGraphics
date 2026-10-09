/**
 * Vertex array objects.
 *
 * A VAO records the whole attribute layout — which buffer each attribute reads
 * from, its component type, stride, offset and instance divisor — so replaying a
 * draw becomes one `bindVertexArray` instead of a dozen `vertexAttribPointer`
 * calls.
 *
 * WebGL2 has VAOs natively; WebGL1 reaches them through
 * `OES_vertex_array_object`. When neither is available the wrapper degrades to a
 * no-op binder and {@link WebGLVertexArray.isSupported} reports `false`, so the
 * renderer can fall back to configuring attributes per draw.
 *
 * @packageDocumentation
 */

import { createId } from '../../utils/Id';
import { createLogger } from '../../utils/Logger';
import type { WebGLState } from './WebGLState';
import { glConst, type GL, type GLVertexArrayObject, type GLVertexArrayObjectExt } from './WebGLUtils';

/** Logger for vertex-array diagnostics. */
const log = createLogger('renderer:webgl:vao');

/** The extension entry points a WebGL1 context exposes for VAOs. */
export interface VertexArrayObjectExtensionLike {
  createVertexArrayOES(): GLVertexArrayObjectExt | null;
  bindVertexArrayOES(array: GLVertexArrayObjectExt | null): void;
  deleteVertexArrayOES(array: GLVertexArrayObjectExt | null): void;
}

/** Options accepted by {@link WebGLVertexArray}. */
export interface WebGLVertexArrayOptions {
  /** `true` when the context is WebGL2. Defaults to `true`. */
  isWebGL2?: boolean;
  /** WebGL1 extension object, when the context is not WebGL2. */
  extension?: VertexArrayObjectExtensionLike | null;
  /** State object used for binding, so bindings stay deduplicated. */
  state?: WebGLState | null;
  /** Human-readable label used in diagnostics. */
  label?: string;
}

/**
 * One vertex array object.
 *
 * The wrapper is deliberately thin: it owns the handle, knows how to bind it
 * through the right entry point for the context version, and records the cache key
 * the renderer uses to look it up for a `(geometry, program)` pair.
 */
export class WebGLVertexArray {
  /** Stable identifier. */
  public readonly id: string;

  /**
   * Cache key describing the `(geometry, program)` pair this layout belongs to.
   *
   * Set by {@link WebGLVertexArrayCache.acquire}; the empty string for a
   * hand-created array.
   */
  public key: string = '';

  /** Context the array belongs to. */
  private readonly gl: GL;

  /** `true` when the context is WebGL2. */
  private readonly isWebGL2: boolean;

  /** WebGL1 extension object, or `null`. */
  private readonly extension: VertexArrayObjectExtensionLike | null;

  /** State object used for deduplicated binding, or `null`. */
  private readonly state: WebGLState | null;

  /** Label used in diagnostics. */
  private readonly label: string;

  /** Native handle, or `null` when unsupported or disposed. */
  private handle: GLVertexArrayObject | GLVertexArrayObjectExt | null = null;

  /** `true` once the handle has been released. */
  private disposed: boolean = false;

  /** `true` when the handle had to be created but the driver refused. */
  private failed: boolean = false;

  /**
   * Creates and allocates the array.
   *
   * @param gl Context to create the array on.
   * @param options Context version, extension and state plumbing.
   */
  constructor(gl: GL, options: WebGLVertexArrayOptions = {}) {
    this.gl = gl;
    this.isWebGL2 = options.isWebGL2 ?? true;
    this.extension = options.extension ?? null;
    this.state = options.state ?? null;
    this.label = options.label ?? 'vao';
    this.id = `webgl-vao-${createId()}`;

    if (this.isWebGL2) {
      const handle = (gl as WebGL2RenderingContext).createVertexArray();
      if (handle === null) {
        this.failed = true;
        log.warn(
          `WebGLVertexArray(${this.label}): gl.createVertexArray returned null. ` +
            'Attributes will be configured per draw instead.',
        );
      }
      this.handle = handle;
      return;
    }

    if (this.extension !== null) {
      const handle = this.extension.createVertexArrayOES();
      if (handle === null) {
        this.failed = true;
        log.warn(
          `WebGLVertexArray(${this.label}): createVertexArrayOES returned null. ` +
            'Attributes will be configured per draw instead.',
        );
      }
      this.handle = handle;
      return;
    }

    log.debug(
      `WebGLVertexArray(${this.label}): vertex array objects are unavailable on this WebGL1 ` +
        'context (OES_vertex_array_object is missing).',
    );
  }

  /** `true` when the context can bind real vertex array objects. */
  public get isSupported(): boolean {
    return this.handle !== null && !this.failed;
  }

  /** `true` once {@link WebGLVertexArray.dispose} has run. */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /** Native handle, or `null`. */
  public get handleOrNull(): GLVertexArrayObject | GLVertexArrayObjectExt | null {
    return this.handle;
  }

  /**
   * Binds the array.
   *
   * A `null` state means the caller manages binding itself; the array then binds
   * unconditionally.
   *
   * @returns `true` when a real array was bound.
   */
  public bind(): boolean {
    if (this.handle === null) return false;
    if (this.state !== null) {
      this.state.bindVertexArray(this.handle, this.bindFunction());
      return true;
    }
    this.bindDirect();
    return true;
  }

  /** Binds the default (null) array, unbinding any VAO. */
  public unbind(): void {
    if (this.state !== null) {
      this.state.bindVertexArray(null, this.bindFunction());
      return;
    }
    if (this.isWebGL2) {
      (this.gl as WebGL2RenderingContext).bindVertexArray(null);
    } else {
      this.extension?.bindVertexArrayOES(null);
    }
  }

  /**
   * Enables or disables an attribute slot inside the array.
   *
   * @param location Attribute location.
   * @param enabled Whether the slot reads from a buffer.
   */
  public setAttributeEnabled(location: number, enabled: boolean): void {
    if (!this.isSupported || location < 0) return;
    if (enabled) {
      this.gl.enableVertexAttribArray(location);
    } else {
      this.gl.disableVertexAttribArray(location);
    }
  }

  /**
   * Points an attribute slot at a buffer.
   *
   * @param location Attribute location.
   * @param size Components per vertex (1..4).
   * @param type GL component type.
   * @param normalized Normalise integer components.
   * @param stride Byte stride between vertices.
   * @param offset Byte offset of the first component.
   * @param integer `true` to use `vertexAttribIPointer` (WebGL2 integer attributes).
   */
  public setAttributePointer(
    location: number,
    size: number,
    type: number,
    normalized: boolean,
    stride: number,
    offset: number,
    integer: boolean = false,
  ): void {
    if (!this.isSupported || location < 0) return;
    if (integer && this.isWebGL2) {
      (this.gl as WebGL2RenderingContext).vertexAttribIPointer(location, size, type, stride, offset);
      return;
    }
    this.gl.vertexAttribPointer(location, size, type, normalized, stride, offset);
  }

  /**
   * Sets the instancing divisor for an attribute slot.
   *
   * @param location Attribute location.
   * @param divisor Number of instances between advances (`0` = per-vertex).
   */
  public setAttributeDivisor(location: number, divisor: number): void {
    if (!this.isSupported || location < 0) return;
    const value = Math.max(0, Math.floor(divisor));
    if (this.isWebGL2) {
      (this.gl as WebGL2RenderingContext).vertexAttribDivisor(location, value);
    }
  }

  /** Releases the native handle. */
  public dispose(): void {
    if (this.disposed) return;
    if (this.handle !== null) {
      if (this.isWebGL2) {
        (this.gl as WebGL2RenderingContext).deleteVertexArray(this.handle as GLVertexArrayObject);
      } else {
        this.extension?.deleteVertexArrayOES(this.handle as GLVertexArrayObjectExt);
      }
      this.handle = null;
    }
    this.disposed = true;
  }

  /** Binds without consulting the state cache. */
  private bindDirect(): void {
    if (this.isWebGL2) {
      (this.gl as WebGL2RenderingContext).bindVertexArray(this.handle as GLVertexArrayObject);
    } else {
      this.extension?.bindVertexArrayOES(this.handle as GLVertexArrayObjectExt);
    }
  }

  /** Builds the WebGL1 binding thunk the state cache can use. */
  private bindFunction(): ((array: GLVertexArrayObjectExt | null) => void) | undefined {
    if (this.isWebGL2) return undefined;
    const extension = this.extension;
    if (extension === null) return undefined;
    return (array) => extension.bindVertexArrayOES(array);
  }

  /** @returns A human-readable description. */
  public toString(): string {
    return `WebGLVertexArray(${this.label}${this.key.length > 0 ? `, ${this.key}` : ''}, ${
      this.isSupported ? 'supported' : 'unsupported'
    })`;
  }
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                      */
/* -------------------------------------------------------------------------- */

/** Options accepted by {@link WebGLVertexArrayCache}. */
export interface WebGLVertexArrayCacheOptions {
  /** `true` when the context is WebGL2. */
  isWebGL2?: boolean;
  /** WebGL1 extension object. */
  extension?: VertexArrayObjectLike | null;
  /** Shared state object used for binding. */
  state?: WebGLState | null;
}

/** Structural form of the WebGL1 VAO extension. */
export type VertexArrayObjectLike = VertexArrayObjectExtensionLike;

/**
 * Cache of vertex array objects, keyed by `(geometry, program)`.
 *
 * Unlike the program cache this one is unbounded in practice: the number of live
 * `(geometry, program)` pairs is bounded by the scene's content, and evicting a VAO
 * would only mean reconfiguring attributes for the same draw on the next frame.
 * {@link WebGLVertexArrayCache.clear} exists for context loss and disposal.
 */
export class WebGLVertexArrayCache {
  /** Context the arrays belong to. */
  private readonly gl: GL;

  /** Arrays by cache key. */
  private readonly arrays: Map<string, WebGLVertexArray> = new Map();

  /** Options used to create new arrays. */
  private readonly options: WebGLVertexArrayCacheOptions;

  /** Number of arrays created through {@link WebGLVertexArrayCache.acquire}. */
  private created: number = 0;

  /**
   * Creates a cache.
   *
   * @param gl Context to create arrays on.
   * @param options Context version, extension and state plumbing.
   */
  constructor(gl: GL, options: WebGLVertexArrayCacheOptions = {}) {
    this.gl = gl;
    this.options = options;
  }

  /** Number of live vertex array objects (reported through `memory.geometries`). */
  public get size(): number {
    return this.arrays.size;
  }

  /** Number of arrays allocated since construction. */
  public get createdCount(): number {
    return this.created;
  }

  /** `true` when the context can create real vertex array objects. */
  public get isSupported(): boolean {
    if (this.options.isWebGL2 ?? true) return true;
    return (this.options.extension ?? null) !== null;
  }

  /**
   * Looks an array up.
   *
   * @param key Cache key, conventionally `geometryKey:programKey`.
   */
  public get(key: string): WebGLVertexArray | undefined {
    return this.arrays.get(key);
  }

  /**
   * Returns the array for a key, creating it when absent.
   *
   * @param key Cache key.
   * @returns The array.
   */
  public acquire(key: string): WebGLVertexArray {
    const existing = this.arrays.get(key);
    if (existing !== undefined && !existing.isDisposed) return existing;

    const array = new WebGLVertexArray(this.gl, {
      isWebGL2: this.options.isWebGL2,
      extension: this.options.extension ?? null,
      state: this.options.state ?? null,
      label: key,
    });
    array.key = key;
    this.arrays.set(key, array);
    this.created++;
    return array;
  }

  /**
   * Releases one cached array.
   *
   * @param key Cache key.
   * @returns `true` when an array was released.
   */
  public release(key: string): boolean {
    const array = this.arrays.get(key);
    if (array === undefined) return false;
    array.dispose();
    this.arrays.delete(key);
    return true;
  }

  /** Releases every cached array. */
  public clear(): void {
    for (const array of this.arrays.values()) array.dispose();
    this.arrays.clear();
  }

  /** Cache keys of the live arrays. */
  public keys(): string[] {
    return [...this.arrays.keys()];
  }

  /** Releases every array; equivalent to {@link WebGLVertexArrayCache.clear}. */
  public dispose(): void {
    this.clear();
    this.created = 0;
  }
}

/** Reads the `OES_vertex_array_object` entry points from a context, when possible. */
export function getVertexArrayExtension(gl: GL, isWebGL2: boolean): VertexArrayObjectExtensionLike | null {
  if (isWebGL2) return null;
  try {
    const extension = gl.getExtension('OES_vertex_array_object');
    if (extension == null) return null;
    const candidate = extension as Partial<VertexArrayObjectExtensionLike>;
    if (
      typeof candidate.createVertexArrayOES === 'function' &&
      typeof candidate.bindVertexArrayOES === 'function' &&
      typeof candidate.deleteVertexArrayOES === 'function'
    ) {
      return candidate as VertexArrayObjectExtensionLike;
    }
    return null;
  } catch {
    return null;
  }
}
