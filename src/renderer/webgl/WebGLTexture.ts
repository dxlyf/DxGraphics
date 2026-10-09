/**
 * Texture wrapper: upload, sampler state, mipmaps and readback.
 *
 * ## What this class owns
 *
 * A `WebGLTexture` handle, the sampler state that belongs to it (filters and wrap
 * modes are per-texture in OpenGL ES, not per-unit), its size, and the number of
 * mip levels actually allocated.
 *
 * ## What it deliberately does not own
 *
 * The *image*. Sources are accepted structurally: an `HTMLImageElement`,
 * `ImageBitmap`, canvas, `ImageData`, typed array, or a resource from the texture
 * layer that exposes `{ image, width, height, format, ... }`. This module never
 * imports `src/textures/**`, which is owned by another layer — any object with the
 * members of {@link TextureLike} works.
 *
 * ## Power-of-two handling
 *
 * WebGL1 cannot `REPEAT` or mipmap a non-power-of-two texture. Resizing an image
 * requires a 2D canvas, which the texture layer owns, so this class does the two
 * things it *can* do: it reports the resize that would be needed through
 * {@link WebGLTexture.suggestResize}, and it downgrades the request (clamp-to-edge,
 * no mip chain) instead of letting the driver generate an incomplete texture that
 * samples as black. WebGL2 needs none of this.
 *
 * @packageDocumentation
 */

import { createId } from '../../utils/Id';
import { createLogger } from '../../utils/Logger';
import { PixelFormat, TextureFilter, TextureWrap } from '../interfaces/types';
import type { ITexture } from '../interfaces/ITexture';
import { computeMipmapCount, planPotResize, type PotResizePlan } from '../utils/textureUtils';
import type { WebGLCapabilities } from './WebGLCapabilities';
import type { WebGLExtensions } from './WebGLExtensions';
import type { WebGLState } from './WebGLState';
import {
  bytesPerPixel,
  glConst,
  isNearestFilter,
  toGLFormat,
  toGLTextureFilter,
  toGLTextureWrap,
  type GL,
  type GLTextureObject,
} from './WebGLUtils';

/** Logger for texture diagnostics. */
const log = createLogger('renderer:webgl:texture');

/* -------------------------------------------------------------------------- */
/* Structural source/sampler shapes                                           */
/* -------------------------------------------------------------------------- */

/**
 * Structural view of anything that can be uploaded as texels.
 *
 * `HTMLImageElement`, `ImageBitmap`, `HTMLCanvasElement`, `OffscreenCanvas`,
 * `ImageData`, `HTMLVideoElement` and the library's own image resources all satisfy
 * it; the members are optional because different sources expose different ones.
 */
export interface TextureSourceLike {
  /** Width in texels, when the source reports one directly. */
  readonly width?: number;
  /** Height in texels. */
  readonly height?: number;
  /** Intrinsic width of an image/video element. */
  readonly naturalWidth?: number;
  /** Intrinsic height of an image/video element. */
  readonly naturalHeight?: number;
  /** Width of a video frame. */
  readonly videoWidth?: number;
  /** Height of a video frame. */
  readonly videoHeight?: number;
  /** Raw texel data, for typed-array sources. */
  readonly data?: ArrayBufferView | null;
}

/** One level of a compressed mip chain. */
export interface CompressedMipmapLike {
  /** Block-compressed bytes. */
  readonly data: ArrayBufferView;
  /** Level width in texels. */
  readonly width: number;
  /** Level height in texels. */
  readonly height: number;
}

/**
 * Structural view of a compressed texture resource.
 *
 * The `format` is a raw GL internal format because block-compressed formats are
 * extension-specific and cannot be named by {@link PixelFormat}.
 */
export interface CompressedTextureSourceLike {
  /** `true` marks the source as compressed. */
  readonly compressed: true;
  /** Raw block-compressed internal format. */
  readonly format: number;
  /** Mip levels, largest first. */
  readonly mipmaps: readonly CompressedMipmapLike[];
}

/**
 * Structural view of a texture resource produced by `src/textures/**`.
 *
 * Declared here because that module is written by another layer and may not exist
 * yet; the concrete classes satisfy this shape structurally.
 */
export interface TextureLike {
  /** Monotonic version; a change triggers a re-upload. */
  readonly version?: number;
  /** Image or texel data. */
  readonly image?: unknown;
  /** Width in texels. */
  readonly width?: number;
  /** Height in texels. */
  readonly height?: number;
  /** Storage format. */
  readonly format?: PixelFormat;
  /** Magnification filter. */
  readonly magFilter?: TextureFilter;
  /** Minification filter. */
  readonly minFilter?: TextureFilter;
  /** Horizontal wrap mode. */
  readonly wrapS?: TextureWrap;
  /** Vertical wrap mode. */
  readonly wrapT?: TextureWrap;
  /** `true` when a mip chain should be generated after upload. */
  readonly generateMipmaps?: boolean;
  /** `true` when the source is block-compressed. */
  readonly compressed?: boolean;
  /** Compressed mip chain, when {@link TextureLike.compressed} is set. */
  readonly mipmaps?: readonly CompressedMipmapLike[];
  /** Raw block-compressed internal format. */
  readonly glFormat?: number;
  /** `true` to flip the image vertically on upload. */
  readonly flipY?: boolean;
  /** `true` to multiply RGB by alpha on upload. */
  readonly premultiplyAlpha?: boolean;
  /** Releases the resource. */
  dispose(): void;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/** Context plumbing a texture needs. */
export interface WebGLTextureContext {
  /** Context to create the texture on. */
  gl: GL;
  /** `true` when the context is WebGL2. */
  isWebGL2?: boolean;
  /** Capability report, used for the non-power-of-two rules. */
  capabilities?: WebGLCapabilities | null;
  /** Extension cache, used for compressed uploads. */
  extensions?: WebGLExtensions | null;
  /** State object used for deduplicated binding. */
  state?: WebGLState | null;
}

/** Options accepted by {@link WebGLTexture}. */
export interface WebGLTextureOptions {
  /** Initial width in texels. */
  width?: number;
  /** Initial height in texels. */
  height?: number;
  /** Storage format; defaults to {@link PixelFormat.RGBA8}. */
  format?: PixelFormat;
  /** Magnification filter. */
  magFilter?: TextureFilter;
  /** Minification filter. */
  minFilter?: TextureFilter;
  /** Horizontal wrap mode. */
  wrapS?: TextureWrap;
  /** Vertical wrap mode. */
  wrapT?: TextureWrap;
  /** Allocate a mip chain and generate it after upload. */
  mipmaps?: boolean;
  /** `true` for a cube map. */
  cube?: boolean;
  /** `true` to flip the source vertically on upload. */
  flipY?: boolean;
  /** `true` to premultiply alpha on upload. */
  premultiplyAlpha?: boolean;
  /** Human-readable label used in diagnostics. */
  label?: string;
}

/* -------------------------------------------------------------------------- */
/* WebGLTexture                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A GPU texture.
 *
 * ```ts
 * const texture = new WebGLTexture({ gl, state }, { width: 256, height: 256 });
 * texture.setData(image);
 * texture.setFilters(TextureFilter.LinearMipmapLinear, TextureFilter.Linear);
 * texture.bind(0);
 * ```
 */
export class WebGLTexture implements ITexture {
  /** @inheritdoc */
  public readonly id: string;

  /** @inheritdoc */
  public get width(): number {
    return this.currentWidth;
  }

  /** @inheritdoc */
  public get height(): number {
    return this.currentHeight;
  }

  /** @inheritdoc */
  public get format(): PixelFormat {
    return this.currentFormat;
  }

  /** @inheritdoc */
  public get magFilter(): TextureFilter {
    return this.currentMagFilter;
  }

  /** @inheritdoc */
  public get minFilter(): TextureFilter {
    return this.currentMinFilter;
  }

  /** @inheritdoc */
  public get wrapS(): TextureWrap {
    return this.currentWrapS;
  }

  /** @inheritdoc */
  public get wrapT(): TextureWrap {
    return this.currentWrapT;
  }

  /** @inheritdoc */
  public get mipLevels(): number {
    return this.currentMipLevels;
  }

  /** @inheritdoc */
  public get isReady(): boolean {
    return this.ready;
  }

  /** @inheritdoc */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /** `true` when the texture is a cube map. */
  public get isCube(): boolean {
    return this.cube;
  }

  /** GL texture target this texture binds to. */
  public get target(): number {
    return this.cube
      ? glConst(this.context.gl, 'TEXTURE_CUBE_MAP', 0x8513)
      : glConst(this.context.gl, 'TEXTURE_2D', 0x0de1);
  }

  /** Context plumbing. */
  private readonly context: WebGLTextureContext;

  /** Context, cached for brevity. */
  private readonly gl: GL;

  /** `true` when the context is WebGL2. */
  private readonly isWebGL2: boolean;

  /** Label used in diagnostics. */
  private readonly label: string;

  /** Native handle, or `null` before the first allocation. */
  private handle: GLTextureObject | null = null;

  /** `true` for a cube map. */
  private readonly cube: boolean;

  /** Current size and sampler state. */
  private currentWidth: number;
  private currentHeight: number;
  private currentFormat: PixelFormat;
  private currentMagFilter: TextureFilter;
  private currentMinFilter: TextureFilter;
  private currentWrapS: TextureWrap;
  private currentWrapT: TextureWrap;
  private currentMipLevels: number;

  /** `true` once texels have been uploaded. */
  private ready: boolean = false;

  /** `true` once {@link WebGLTexture.dispose} has run. */
  private disposed: boolean = false;

  /** Version of the resource the texels came from, for change detection. */
  private sourceVersion: number = -1;

  /** `true` when the driver has been told to flip Y for this texture. */
  private readonly flipY: boolean;

  /** `true` when the driver has been told to premultiply alpha. */
  private readonly premultiplyAlpha: boolean;

  /** `true` when the uploaded source was a typed array rather than an image. */
  private pixelSource: boolean = false;

  /**
   * Creates a texture.
   *
   * @param context Context plumbing.
   * @param options Size, format and sampler defaults.
   */
  constructor(context: WebGLTextureContext, options: WebGLTextureOptions = {}) {
    this.context = context;
    this.gl = context.gl;
    this.isWebGL2 = context.isWebGL2 ?? true;
    this.label = options.label ?? 'texture';
    this.id = `webgl-texture-${createId()}`;

    this.cube = options.cube ?? false;
    this.currentWidth = Math.max(1, Math.floor(options.width ?? 1));
    this.currentHeight = Math.max(1, Math.floor(options.height ?? 1));
    this.currentFormat = options.format ?? PixelFormat.RGBA8;
    this.currentMagFilter = options.magFilter ?? TextureFilter.Linear;
    this.currentMinFilter = options.minFilter ?? TextureFilter.Linear;
    this.currentWrapS = options.wrapS ?? TextureWrap.ClampToEdge;
    this.currentWrapT = options.wrapT ?? TextureWrap.ClampToEdge;
    this.currentMipLevels = options.mipmaps === true ? computeMipmapCount(this.currentWidth, this.currentHeight) : 1;
    this.flipY = options.flipY ?? false;
    this.premultiplyAlpha = options.premultiplyAlpha ?? false;
  }

  /* --------------------------------------------------------------- lifecycle */

  /** Native handle, or `null`. */
  public get handleOrNull(): GLTextureObject | null {
    return this.handle;
  }

  /**
   * Returns the native handle, creating it on first use.
   *
   * @returns The handle.
   * @throws Error When the context refuses to create a texture.
   */
  public getHandle(): GLTextureObject {
    if (this.disposed) {
      throw new Error(`WebGLTexture(${this.label}): the texture has been disposed.`);
    }
    if (this.handle === null) {
      const handle = this.gl.createTexture();
      if (handle === null) {
        throw new Error(
          `WebGLTexture(${this.label}): gl.createTexture returned null. The context is most ` +
            'likely lost; the renderer re-uploads textures after a restore.',
        );
      }
      this.handle = handle;
    }
    return this.handle;
  }

  /**
   * Binds the texture to a unit.
   *
   * @param unit Texture unit; defaults to `0`.
   * @returns This texture, for chaining.
   */
  public bind(unit: number = 0): this {
    const handle = this.getHandle();
    const state = this.context.state ?? null;
    if (state !== null) {
      state.bindTexture(unit, this.target, handle);
    } else {
      const gl = this.gl;
      gl.activeTexture(glConst(gl, 'TEXTURE0', 0x84c0) + Math.max(0, Math.floor(unit)));
      gl.bindTexture(this.target, handle);
    }
    return this;
  }

  /** Unbinds the texture from its target. */
  public unbind(): void {
    const state = this.context.state ?? null;
    if (state !== null) {
      state.bindTexture(state.getActiveTexture(), this.target, null);
      return;
    }
    this.gl.bindTexture(this.target, null);
  }

  /* ------------------------------------------------------------------ upload */

  /**
   * Uploads texel data.
   *
   * Accepts a {@link TextureLike} resource, a {@link TextureSourceLike} image, a
   * {@link CompressedTextureSourceLike} block-compressed resource, a typed array or
   * a plain number array (the last two need the texture to have a size already).
   *
   * @param source Data to upload.
   * @param mipLevel Destination level; defaults to `0`.
   * @returns This texture, for chaining.
   */
  public setData(source: unknown, mipLevel: number = 0): this {
    if (source == null) return this;

    if (isCompressedSource(source)) {
      this.uploadCompressed(source);
      return this;
    }

    if (isTextureLike(source)) {
      this.applyResource(source);
      return this;
    }

    this.uploadRaw(source, mipLevel);
    return this;
  }

  /**
   * Uploads a raw source (image or texel buffer), bypassing resource detection.
   *
   * Split out of {@link WebGLTexture.setData} so that
   * {@link WebGLTexture.applyResource} can upload a resource's `image` without
   * re-entering the `isTextureLike` branch and recursing.
   *
   * @param source Image or texel data.
   * @param mipLevel Destination level.
   */
  private uploadRaw(source: unknown, mipLevel: number): void {
    const level = Math.max(0, Math.floor(mipLevel));
    const gl = this.gl;
    this.bind(0);

    const dimensions = getSourceDimensions(source, this.currentWidth, this.currentHeight);

    if (isPixelSource(source)) {
      this.uploadPixels(source, level, dimensions.width, dimensions.height);
    } else {
      this.uploadImage(source, level, dimensions.width, dimensions.height);
    }

    this.currentWidth = dimensions.width;
    this.currentHeight = dimensions.height;
    this.pixelSource = isPixelSource(source);
    this.ready = true;

    if (level === 0) this.finishUpload();
  }

  /**
   * Reallocates the texture at a new size, discarding its contents.
   *
   * @param width New width in texels.
   * @param height New height in texels.
   * @returns This texture, for chaining.
   */
  public setSize(width: number, height: number): this {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this.currentWidth && nextHeight === this.currentHeight && this.ready) return this;

    this.currentWidth = nextWidth;
    this.currentHeight = nextHeight;
    this.currentMipLevels = Math.max(1, this.currentMipLevels);
    this.allocate();
    return this;
  }

  /**
   * Reallocates an empty texture at the current size.
   *
   * @returns This texture, for chaining.
   */
  public allocate(): this {
    const gl = this.gl;
    const descriptor = toGLFormat(gl, this.currentFormat, { webgl2: this.isWebGL2 });
    this.bind(0);

    for (let level = 0; level < this.currentMipLevels; level++) {
      const width = Math.max(1, this.currentWidth >> level);
      const height = Math.max(1, this.currentHeight >> level);
      if (this.cube) {
        for (let face = 0; face < 6; face++) {
          gl.texImage2D(
            glConst(gl, 'TEXTURE_CUBE_MAP_POSITIVE_X', 0x8515) + face,
            level,
            descriptor.internalFormat,
            width,
            height,
            0,
            descriptor.format,
            descriptor.type,
            null,
          );
        }
      } else {
        gl.texImage2D(
          this.target,
          level,
          descriptor.internalFormat,
          width,
          height,
          0,
          descriptor.format,
          descriptor.type,
          null,
        );
      }
    }

    this.ready = true;
    this.applySamplerState();
    return this;
  }

  /* ------------------------------------------------------------------ sampler */

  /** @inheritdoc */
  public setFilters(min?: TextureFilter, mag?: TextureFilter): void {
    const nextMin = min ?? this.currentMinFilter;
    const nextMag = mag ?? this.currentMagFilter;
    if (nextMin === this.currentMinFilter && nextMag === this.currentMagFilter) return;

    this.currentMinFilter = resolveMinFilter(nextMin, this.currentMipLevels);
    this.currentMagFilter = isNearestFilter(nextMag) ? TextureFilter.Nearest : TextureFilter.Linear;
    this.applySamplerState();
  }

  /** @inheritdoc */
  public setWrap(wrapS?: TextureWrap, wrapT?: TextureWrap): void {
    this.currentWrapS = wrapS ?? this.currentWrapS;
    this.currentWrapT = wrapT ?? this.currentWrapT;
    this.applySamplerState();
  }

  /**
   * Writes the current sampler state to the driver.
   *
   * @returns This texture, for chaining.
   */
  public applySamplerState(): this {
    if (this.handle === null) return this;
    const gl = this.gl;
    const target = this.target;
    const filters = toGLTextureFilter(gl, this.currentMinFilter, this.currentMipLevels > 1);
    const wrapS = toGLTextureWrap(gl, this.currentWrapS);
    const wrapT = toGLTextureWrap(gl, this.currentWrapT);

    this.bind(0);
    gl.texParameteri(target, glConst(gl, 'TEXTURE_MIN_FILTER', 0x2801), filters.min);
    gl.texParameteri(target, glConst(gl, 'TEXTURE_MAG_FILTER', 0x2800), filters.mag);
    gl.texParameteri(target, glConst(gl, 'TEXTURE_WRAP_S', 0x2802), wrapS);
    gl.texParameteri(target, glConst(gl, 'TEXTURE_WRAP_T', 0x2803), wrapT);
    return this;
  }

  /** @inheritdoc */
  public generateMipmaps(): void {
    if (this.disposed) return;
    if (!this.capabilities().supportsNonPowerOfTwoRepeat && !isPowerOfTwoSize(this.currentWidth, this.currentHeight)) {
      log.warn(
        `WebGLTexture(${this.label}): ${this.currentWidth}x${this.currentHeight} is not a power of two ` +
          'and this WebGL1 context cannot mipmap it. Resize the source before upload ' +
          '(see `suggestResize()`), or use clamp-to-edge filtering.',
      );
      return;
    }

    this.bind(0);
    this.gl.generateMipmap(this.target);
    if (this.currentMipLevels <= 1) this.currentMipLevels = computeMipmapCount(this.currentWidth, this.currentHeight);
  }

  /**
   * Plans the power-of-two resize a WebGL1 context would need.
   *
   * @param mode Rounding strategy; defaults to `'ceil'`.
   * @returns The plan; `resized` is `false` when no resize is needed.
   */
  public suggestResize(mode: 'ceil' | 'floor' | 'round' = 'ceil'): PotResizePlan {
    return planPotResize({ width: this.currentWidth, height: this.currentHeight }, mode);
  }

  /* ----------------------------------------------------------------- readback */

  /** @inheritdoc */
  public readPixels(): Uint8ClampedArray | null {
    if (this.disposed || this.handle === null || this.cube) return null;
    if (isDepthFormatLocal(this.currentFormat)) return null;

    const pixels = bytesPerPixel(this.currentFormat);
    if (pixels === 0) return null;

    const gl = this.gl;
    const width = this.currentWidth;
    const height = this.currentHeight;

    // A texture is not readable directly; it has to be attached to a framebuffer.
    const framebuffer = gl.createFramebuffer();
    if (framebuffer === null) return null;

    const previous = gl.getParameter(glConst(gl, 'FRAMEBUFFER_BINDING', 0x8ca6)) as WebGLFramebuffer | null;
    try {
      gl.bindFramebuffer(glConst(gl, 'FRAMEBUFFER', 0x8d40), framebuffer);
      gl.framebufferTexture2D(
        glConst(gl, 'FRAMEBUFFER', 0x8d40),
        glConst(gl, 'COLOR_ATTACHMENT0', 0x8ce0),
        this.target,
        this.handle,
        0,
      );

      const status = gl.checkFramebufferStatus(glConst(gl, 'FRAMEBUFFER', 0x8d40));
      if (status !== glConst(gl, 'FRAMEBUFFER_COMPLETE', 0x8cd5)) return null;

      const buffer = new Uint8Array(width * height * 4);
      gl.readPixels(
        0,
        0,
        width,
        height,
        glConst(gl, 'RGBA', 0x1908),
        glConst(gl, 'UNSIGNED_BYTE', 0x1401),
        buffer,
      );
      return new Uint8ClampedArray(buffer.buffer.slice(0));
    } catch {
      return null;
    } finally {
      gl.bindFramebuffer(glConst(gl, 'FRAMEBUFFER', 0x8d40), previous);
      gl.deleteFramebuffer(framebuffer);
    }
  }

  /* ------------------------------------------------------------------ staleness */

  /**
   * `true` when the texture's GPU handle predates the given context generation.
   *
   * After a context loss every handle is invalid; the renderer compares generations
   * to decide whether a texture has to be re-uploaded before it can be sampled.
   *
   * @param generation Context generation counter.
   */
  public isStale(generation: number): boolean {
    return this.uploadGeneration !== generation;
  }

  /**
   * Marks the texture as needing a re-upload (a lost context invalidated it).
   *
   * @returns This texture, for chaining.
   */
  public markStale(): this {
    this.handle = null;
    this.ready = false;
    this.uploadGeneration = -1;
    return this;
  }

  /** Context generation the handle was created in. */
  private uploadGeneration: number = 0;

  /**
   * Records the context generation this texture now belongs to.
   *
   * @param generation Current generation of the owning context.
   */
  public setGeneration(generation: number): void {
    this.uploadGeneration = generation;
  }

  /* ------------------------------------------------------------------ dispose */

  /** @inheritdoc */
  public dispose(): void {
    if (this.disposed) return;
    if (this.handle !== null) {
      this.gl.deleteTexture(this.handle);
      this.handle = null;
    }
    this.ready = false;
    this.disposed = true;
  }

  /** @returns A human-readable description. */
  public toString(): string {
    return `WebGLTexture(${this.label}, ${this.currentWidth}x${this.currentHeight}, ${this.currentFormat})`;
  }

  /* ------------------------------------------------------------------ internals */

  /** Capability report, or a permissive default when none was supplied. */
  private capabilities(): { supportsNonPowerOfTwoRepeat: boolean } {
    return this.context.capabilities ?? { supportsNonPowerOfTwoRepeat: this.isWebGL2 };
  }

  /** Uploads a DOM-style image through the 6-argument `texImage2D` overload. */
  private uploadImage(source: unknown, level: number, width: number, height: number): void {
    const gl = this.gl;
    const descriptor = toGLFormat(gl, this.currentFormat, { webgl2: this.isWebGL2 });
    this.applyPixelStore();

    if (this.cube) {
      const face = this.cubeFaceTarget(level);
      gl.texImage2D(face, level, descriptor.internalFormat, descriptor.format, descriptor.type, source as TexImageSource);
      return;
    }
    void width;
    void height;
    gl.texImage2D(
      this.target,
      level,
      descriptor.internalFormat,
      descriptor.format,
      descriptor.type,
      source as TexImageSource,
    );
  }

  /** Uploads a typed array through the 9-argument `texImage2D` overload. */
  private uploadPixels(source: unknown, level: number, width: number, height: number): void {
    const gl = this.gl;
    const descriptor = toGLFormat(gl, this.currentFormat, { webgl2: this.isWebGL2 });
    this.applyPixelStore();

    const pixels = isArrayLikeValue(source) ? (source as ArrayBufferView) : null;
    if (pixels === null) return;

    if (this.cube) {
      const face = this.cubeFaceTarget(level);
      gl.texImage2D(face, level, descriptor.internalFormat, width, height, 0, descriptor.format, descriptor.type, pixels);
      return;
    }
    gl.texImage2D(
      this.target,
      level,
      descriptor.internalFormat,
      width,
      height,
      0,
      descriptor.format,
      descriptor.type,
      pixels,
    );
  }

  /** Uploads every level of a block-compressed resource. */
  private uploadCompressed(source: CompressedTextureSourceLike): void {
    const gl = this.gl;
    const levels = source.mipmaps;
    if (levels.length === 0) return;

    this.bind(0);
    this.currentMipLevels = levels.length;
    this.currentWidth = levels[0].width;
    this.currentHeight = levels[0].height;

    // Prefer WebGL2's own entry point; WebGL1 reaches the same call through the
    // compressed-texture extension object.
    const target = this.target;
    const webgl2 = this.isWebGL2 ? (gl as WebGL2RenderingContext) : null;

    for (let level = 0; level < levels.length; level++) {
      const mip = levels[level];
      if (webgl2 !== null) {
        webgl2.compressedTexImage2D(target, level, source.format, mip.width, mip.height, 0, mip.data);
        continue;
      }
      const extension = this.context.extensions?.getCompressedTextureExtension() as
        | { compressedTexImage2D?: (...args: unknown[]) => void }
        | null
        | undefined;
      const fn = extension?.compressedTexImage2D;
      if (typeof fn === 'function') {
        fn.call(extension, target, level, source.format, mip.width, mip.height, 0, mip.data);
      } else {
        log.warn(
          `WebGLTexture(${this.label}): no compressed-texture extension is available, so the ` +
            'compressed upload was skipped.',
        );
        return;
      }
    }

    this.ready = true;
    this.applySamplerState();
  }

  /** Applies a texture-layer resource onto this texture. */
  private applyResource(resource: TextureLike): void {
    if (resource.version !== undefined && resource.version === this.sourceVersion && this.ready) {
      this.applyResourceSamplerState(resource);
      return;
    }

    if (resource.format !== undefined) this.currentFormat = resource.format;
    if (resource.width !== undefined && resource.height !== undefined) {
      this.currentWidth = Math.max(1, Math.floor(resource.width));
      this.currentHeight = Math.max(1, Math.floor(resource.height));
    }

    this.applyResourceSamplerState(resource);

    const levels = resource.mipmaps ?? [];
    if (resource.compressed === true && levels.length > 0) {
      this.uploadCompressed({
        compressed: true,
        format: resource.glFormat ?? 0,
        mipmaps: levels,
      });
    } else {
      const image = resource.image;
      if (image !== undefined && image !== null) {
        this.uploadRaw(image, 0);
      } else {
        this.allocate();
      }
    }

    if (resource.generateMipmaps === true) this.generateMipmaps();

    this.sourceVersion = resource.version ?? -1;
    this.applySamplerState();
  }

  /** Copies sampler state out of a resource. */
  private applyResourceSamplerState(resource: TextureLike): void {
    if (resource.magFilter !== undefined) this.currentMagFilter = resource.magFilter;
    if (resource.minFilter !== undefined) this.currentMinFilter = resource.minFilter;
    if (resource.wrapS !== undefined) this.currentWrapS = resource.wrapS;
    if (resource.wrapT !== undefined) this.currentWrapT = resource.wrapT;
  }

  /** Handles the non-power-of-two rules and mip generation after a level-0 upload. */
  private finishUpload(): void {
    const capabilities = this.capabilities();
    const pot = isPowerOfTwoSize(this.currentWidth, this.currentHeight);

    if (!capabilities.supportsNonPowerOfTwoRepeat && !pot) {
      if (this.currentWrapS !== TextureWrap.ClampToEdge || this.currentWrapT !== TextureWrap.ClampToEdge) {
        log.warn(
          `WebGLTexture(${this.label}): a non-power-of-two texture cannot REPEAT on this WebGL1 ` +
            'context; clamping instead. Resize to a power of two to keep the requested wrap mode.',
        );
        this.currentWrapS = TextureWrap.ClampToEdge;
        this.currentWrapT = TextureWrap.ClampToEdge;
      }
      if (this.currentMipLevels > 1) {
        log.warn(
          `WebGLTexture(${this.label}): a non-power-of-two texture cannot be mipmapped on this ` +
            'WebGL1 context; the mip chain was dropped.',
        );
        this.currentMipLevels = 1;
        this.currentMinFilter = TextureFilter.Linear;
      }
    }

    this.applySamplerState();
    if (this.currentMipLevels > 1 && this.pixelSource) {
      // A mip chain requested at construction time is generated once the base
      // level exists, which is the only moment `generateMipmap` is defined.
      this.generateMipmaps();
    }
  }

  /** Writes the unpack hints the texture was created with. */
  private applyPixelStore(): void {
    const gl = this.gl;
    gl.pixelStorei(glConst(gl, 'UNPACK_FLIP_Y_WEBGL', 0x9240), this.flipY ? 1 : 0);
    gl.pixelStorei(glConst(gl, 'UNPACK_PREMULTIPLY_ALPHA_WEBGL', 0x9241), this.premultiplyAlpha ? 1 : 0);
    gl.pixelStorei(glConst(gl, 'UNPACK_ALIGNMENT', 0x0cf5), 4);
  }

  /** Cube face target for the first face (the wrapper only uploads face 0 directly). */
  private cubeFaceTarget(_level: number): number {
    return glConst(this.gl, 'TEXTURE_CUBE_MAP_POSITIVE_X', 0x8515);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** `true` when both dimensions are powers of two. */
export function isPowerOfTwoSize(width: number, height: number): boolean {
  return isPot(width) && isPot(height);
}

/** `true` when a value is a power of two. */
function isPot(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

/** `true` when a format is a depth(-stencil) format. */
function isDepthFormatLocal(format: PixelFormat): boolean {
  return format === PixelFormat.Depth16 || format === PixelFormat.Depth24Stencil8 || format === PixelFormat.Depth32F;
}

/** `true` when the source is a block-compressed resource. */
export function isCompressedSource(value: unknown): value is CompressedTextureSourceLike {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<CompressedTextureSourceLike>;
  return candidate.compressed === true && Array.isArray(candidate.mipmaps) && candidate.mipmaps.length > 0;
}

/**
 * `true` when the value looks like a texture-layer resource.
 *
 * The discriminator is `dispose`, which every `ITexture` has and no image source
 * does; a bare `{ image }` object is also accepted because that is the shape the
 * texture layer's simplest resources expose.
 */
export function isTextureLike(value: unknown): value is TextureLike {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<TextureLike>;
  if (typeof candidate.dispose === 'function') return true;
  return candidate.image !== undefined && (candidate.width !== undefined || candidate.version !== undefined);
}

/** `true` when the source carries raw texels rather than an image. */
export function isPixelSource(value: unknown): boolean {
  if (ArrayBuffer.isView(value)) return true;
  if (value != null && typeof value === 'object') {
    const candidate = value as TextureSourceLike;
    return candidate.data != null && ArrayBuffer.isView(candidate.data);
  }
  return false;
}

/** `true` when a value can be handed to `texImage2D` as a pixel buffer. */
function isArrayLikeValue(value: unknown): boolean {
  if (ArrayBuffer.isView(value)) return true;
  if (value != null && typeof value === 'object') {
    const data = (value as TextureSourceLike).data;
    return data != null && ArrayBuffer.isView(data);
  }
  return false;
}

/**
 * Determines the texel size of a source.
 *
 * Typed arrays carry no dimensions, so the texture's current size is used; every
 * image-like source exposes one of the four width/height pairs this checks.
 *
 * @param source Source to measure.
 * @param fallbackWidth Width used when the source reports nothing.
 * @param fallbackHeight Height used when the source reports nothing.
 */
export function getSourceDimensions(
  source: unknown,
  fallbackWidth: number,
  fallbackHeight: number,
): { width: number; height: number } {
  if (source == null || typeof source !== 'object') {
    return { width: fallbackWidth, height: fallbackHeight };
  }

  if (ArrayBuffer.isView(source)) {
    const array = source as unknown as ArrayLike<number>;
    // Square textures are the only safe assumption for a bare array; callers that
    // know better set the size explicitly before uploading.
    const square = Math.max(1, Math.floor(Math.sqrt(array.length / 4)));
    return { width: square, height: square };
  }

  const candidate = source as TextureSourceLike;
  const width =
    pickNumber(candidate.width) ??
    pickNumber(candidate.naturalWidth) ??
    pickNumber(candidate.videoWidth) ??
    (candidate.data != null ? fallbackWidth : undefined);
  const height =
    pickNumber(candidate.height) ??
    pickNumber(candidate.naturalHeight) ??
    pickNumber(candidate.videoHeight) ??
    (candidate.data != null ? fallbackHeight : undefined);

  return {
    width: Math.max(1, Math.floor(width ?? fallbackWidth)),
    height: Math.max(1, Math.floor(height ?? fallbackHeight)),
  };
}

/** Returns a positive finite number, or `undefined`. */
function pickNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/**
 * Downgrades a mip-sampling filter when the texture has no mip chain.
 *
 * @param filter Requested filter.
 * @param mipLevels Allocated mip levels.
 * @returns A filter the driver will accept.
 */
export function resolveMinFilter(filter: TextureFilter, mipLevels: number): TextureFilter {
  if (mipLevels > 1) return filter;
  switch (filter) {
    case TextureFilter.NearestMipmapNearest:
    case TextureFilter.NearestMipmapLinear:
      return TextureFilter.Nearest;
    case TextureFilter.LinearMipmapNearest:
    case TextureFilter.LinearMipmapLinear:
      return TextureFilter.Linear;
    default:
      return filter;
  }
}

/**
 * `true` when a texture needs a real mip chain for its filter to be meaningful.
 *
 * @param filter Minification filter.
 */
export function filterUsesMipmaps(filter: TextureFilter): boolean {
  return (
    filter === TextureFilter.NearestMipmapNearest ||
    filter === TextureFilter.LinearMipmapNearest ||
    filter === TextureFilter.NearestMipmapLinear ||
    filter === TextureFilter.LinearMipmapLinear
  );
}
