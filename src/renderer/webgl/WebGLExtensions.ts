/**
 * Extension cache.
 *
 * `getExtension` is not free — it goes through the driver's string table — and the
 * renderer asks for the same handful of extensions on every capability probe, so
 * results (including failures) are memoised here.
 *
 * Failed lookups are cached as `null` and reported once at debug level; a missing
 * extension is a normal condition, not an error, and warning on every frame would
 * drown the log.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import { glConst, type GL } from './WebGLUtils';

/** Logger for extension diagnostics. */
const log = createLogger('renderer:webgl:extensions');

/** Extension names the backend knows about, grouped by purpose. */
export const WEBGL_EXTENSION_NAMES = {
  /** Vertex array objects on WebGL1. */
  vertexArrayObject: 'OES_vertex_array_object',
  /** Instanced drawing on WebGL1. */
  instancedArrays: 'ANGLE_instanced_arrays',
  /** 32-bit index buffers on WebGL1. */
  elementIndexUint: 'OES_element_index_uint',
  /** Depth/stencil renderbuffer and texture attachments on WebGL1. */
  depthTexture: 'WEBGL_depth_texture',
  /** Float colour textures on WebGL1. */
  textureFloat: 'OES_texture_float',
  /** Half-float colour textures on WebGL1. */
  textureHalfFloat: 'OES_texture_half_float',
  /** Linear filtering of float textures. */
  textureFloatLinear: 'OES_texture_float_linear',
  /** Linear filtering of half-float textures. */
  textureHalfFloatLinear: 'OES_texture_half_float_linear',
  /** Multiple render targets on WebGL1. */
  drawBuffers: 'WEBGL_draw_buffers',
  /** Colour-buffer float renderability. */
  colorBufferFloat: 'EXT_color_buffer_float',
  /** Half-float renderability on WebGL2. */
  colorBufferHalfFloat: 'EXT_color_buffer_half_float',
  /** Floating-point blending. */
  floatBlend: 'EXT_float_blend',
  /** Anisotropic texture filtering. */
  anisotropicFiltering: 'EXT_texture_filter_anisotropic',
  /** S3TC/DXT compressed textures. */
  compressedS3TC: 'WEBGL_compressed_texture_s3tc',
  /** SRGB variants of the S3TC formats. */
  compressedS3TCSrgb: 'WEBGL_compressed_texture_s3tc_srgb',
  /** ETC1 compressed textures. */
  compressedETC1: 'WEBGL_compressed_texture_etc1',
  /** ETC2/EAC compressed textures. */
  compressedETC: 'WEBGL_compressed_texture_etc',
  /** ASTC compressed textures. */
  compressedASTC: 'WEBGL_compressed_texture_astc',
  /** PVRTC compressed textures. */
  compressedPVRTC: 'WEBGL_compressed_texture_pvrtc',
  /** BGRA texel upload order. */
  textureFormatBGRA: 'EXT_texture_format_BGRA8888',
  /** Explicit texture LOD bias. */
  shaderTextureLod: 'EXT_shader_texture_lod',
  /** Deliberate context loss for testing. */
  loseContext: 'WEBGL_lose_context',
  /** GPU timer queries. */
  disjointTimerQuery: 'EXT_disjoint_timer_query',
  /** GPU timer queries on WebGL2. */
  disjointTimerQueryWebGL2: 'EXT_disjoint_timer_query_webgl2',
  /** Unmasked renderer/vendor strings. */
  debugRendererInfo: 'WEBGL_debug_renderer_info',
  /** Fenced synchronisation for readback. */
  fenceSync: 'WEBGL_fence_sync',
  /** Multi-draw entry points. */
  multiDraw: 'WEBGL_multi_draw',
} as const;

/** Canonical extension name a caller can request. */
export type WebGLExtensionName = (typeof WEBGL_EXTENSION_NAMES)[keyof typeof WEBGL_EXTENSION_NAMES];

/** Options accepted by {@link WebGLExtensions}. */
export interface WebGLExtensionsOptions {
  /** Quietens the "extension unavailable" debug records. */
  silent?: boolean;
}

/**
 * Memoising wrapper around `gl.getExtension`.
 *
 * Every accessor returns `null` (never throws) when the extension is unavailable,
 * so callers can write `if (ext) { ... }` without a try/catch.
 */
export class WebGLExtensions {
  /** Context the extensions are resolved against. */
  private readonly gl: GL;

  /** `true` when the context is WebGL2. */
  private readonly isWebGL2: boolean;

  /** Memoised lookups; `null` records a failure so it is not retried. */
  private readonly cache: Map<string, unknown> = new Map();

  /** `true` when the object has been disposed. */
  private disposed: boolean = false;

  /** `true` to suppress the debug records for missing extensions. */
  private readonly silent: boolean;

  /**
   * Creates the cache.
   *
   * @param gl Context to resolve extensions against.
   * @param isWebGL2 `true` when the context is WebGL2.
   * @param options Cache tuning.
   */
  constructor(gl: GL, isWebGL2: boolean, options: WebGLExtensionsOptions = {}) {
    this.gl = gl;
    this.isWebGL2 = isWebGL2;
    this.silent = options.silent ?? false;
  }

  /** `true` when the context is WebGL2. */
  public get webgl2(): boolean {
    return this.isWebGL2;
  }

  /**
   * Looks an extension up (memoised).
   *
   * @param name Extension name, e.g. `'OES_vertex_array_object'`.
   * @returns The extension object, or `null` when unavailable.
   */
  public get<T = unknown>(name: string): T | null {
    if (this.disposed) return null;
    if (this.cache.has(name)) return (this.cache.get(name) ?? null) as T | null;

    let extension: unknown = null;
    try {
      extension = this.gl.getExtension(name);
    } catch (error) {
      if (!this.silent) log.debug(`getExtension('${name}') threw`, error);
      extension = null;
    }

    if (extension == null && !this.silent) {
      log.debug(`extension '${name}' is not available on this context`);
    }

    this.cache.set(name, extension ?? null);
    return (extension ?? null) as T | null;
  }

  /**
   * Reports whether an extension is available, without materialising it in the
   * caller's type space.
   *
   * @param name Extension name.
   */
  public has(name: string): boolean {
    return this.get(name) != null;
  }

  /**
   * Resolves the vertex-array-object entry points.
   *
   * On WebGL2 the context itself provides them, so `null` is returned and the
   * caller uses `gl.*` directly.
   */
  public getVertexArrayObject(): WebGLVertexArrayObjectOES | null {
    if (this.isWebGL2) return null;
    return this.get<WebGLVertexArrayObjectOES>(WEBGL_EXTENSION_NAMES.vertexArrayObject);
  }

  /** Resolves the WebGL1 instanced-drawing extension. */
  public getInstancedArrays(): ANGLE_instanced_arrays | null {
    if (this.isWebGL2) return null;
    return this.get<ANGLE_instanced_arrays>(WEBGL_EXTENSION_NAMES.instancedArrays);
  }

  /** Resolves the WebGL1 multiple-render-target extension. */
  public getDrawBuffers(): WEBGL_draw_buffers | null {
    if (this.isWebGL2) return null;
    return this.get<WEBGL_draw_buffers>(WEBGL_EXTENSION_NAMES.drawBuffers);
  }

  /** Resolves the anisotropic filtering extension. */
  public getAnisotropicFiltering(): EXT_texture_filter_anisotropic | null {
    return this.get<EXT_texture_filter_anisotropic>(WEBGL_EXTENSION_NAMES.anisotropicFiltering);
  }

  /** Resolves the compressed-texture extension matching the platform. */
  public getCompressedTextureExtension(): Record<string, number> | null {
    const candidates: readonly string[] = this.isWebGL2
      ? [
          WEBGL_EXTENSION_NAMES.compressedASTC,
          WEBGL_EXTENSION_NAMES.compressedETC,
          WEBGL_EXTENSION_NAMES.compressedS3TC,
          WEBGL_EXTENSION_NAMES.compressedPVRTC,
        ]
      : [
          WEBGL_EXTENSION_NAMES.compressedS3TC,
          WEBGL_EXTENSION_NAMES.compressedPVRTC,
          WEBGL_EXTENSION_NAMES.compressedETC1,
          WEBGL_EXTENSION_NAMES.compressedASTC,
        ];
    for (const name of candidates) {
      const extension = this.get<Record<string, number>>(name);
      if (extension != null) return extension;
    }
    return null;
  }

  /**
   * Lists the compressed internal formats the context accepts.
   *
   * WebGL2 exposes them through `getParameter(COMPRESSED_TEXTURE_FORMATS)`; on
   * WebGL1 the extension objects are the only source.
   *
   * @returns Internal format values, or an empty array when none are supported.
   */
  public getCompressedTextureFormats(): number[] {
    const formats: number[] = [];

    if (this.isWebGL2) {
      try {
        const queried = this.gl.getParameter(glConst(this.gl, 'COMPRESSED_TEXTURE_FORMATS', 0x86a3));
        if (queried != null && typeof (queried as ArrayLike<number>).length === 'number') {
          const values = queried as unknown as ArrayLike<number>;
          for (let i = 0; i < values.length; i++) formats.push(Number(values[i]));
        }
      } catch {
        /* a partial double may not implement getParameter */
      }
    }

    if (formats.length === 0) {
      const extension = this.getCompressedTextureExtension();
      if (extension != null) {
        for (const [key, value] of Object.entries(extension)) {
          if (key.startsWith('COMPRESSED_') && typeof value === 'number') formats.push(value);
        }
      }
    }

    return formats;
  }

  /**
   * Reads the unmasked renderer description, when the driver exposes one.
   *
   * @returns `{ vendor, renderer }`, or `null` when unavailable.
   */
  public getRendererInfo(): { vendor: string; renderer: string } | null {
    const debug = this.get<WEBGL_debug_renderer_info>(WEBGL_EXTENSION_NAMES.debugRendererInfo);
    try {
      if (debug != null) {
        const vendor = this.gl.getParameter(debug.UNMASKED_VENDOR_WEBGL);
        const renderer = this.gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
        if (typeof vendor === 'string' && typeof renderer === 'string') return { vendor, renderer };
      }
      const vendor = this.gl.getParameter(glConst(this.gl, 'VENDOR', 0x1f00));
      const renderer = this.gl.getParameter(glConst(this.gl, 'RENDERER', 0x1f01));
      if (typeof vendor === 'string' && typeof renderer === 'string') return { vendor, renderer };
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Returns the `WEBGL_lose_context` extension for deliberate context loss.
   *
   * @returns The extension, or `null` when unavailable.
   */
  public getLoseContext(): WEBGL_lose_context | null {
    return this.get<WEBGL_lose_context>(WEBGL_EXTENSION_NAMES.loseContext);
  }

  /** Number of memoised lookups (successful and failed). */
  public get size(): number {
    return this.cache.size;
  }

  /** Empties the cache; the next lookup re-queries the driver. */
  public invalidate(): void {
    this.cache.clear();
  }

  /**
   * Marks the cache disposed.
   *
   * Called when the context is lost: extension objects are invalidated with it, so
   * keeping them would hand out dead handles.
   */
  public dispose(): void {
    this.cache.clear();
    this.disposed = true;
  }
}
