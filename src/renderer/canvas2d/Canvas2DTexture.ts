/**
 * Canvas2D texture.
 *
 * The 2D backend samples no textures: a "texture" is simply an image source that
 * `drawImage` blits. This class adapts every source the 2D backend accepts —
 * `HTMLImageElement`, `ImageBitmap`, `HTMLCanvasElement`, `OffscreenCanvas`,
 * `ImageData`, `VideoFrame` — to the shared {@link ITexture} contract so that the
 * same scene description works against the GPU backends too.
 *
 * @packageDocumentation
 */

import { createId } from '../../utils/Id';
import { createLogger } from '../../utils/Logger';
import type { ITexture } from '../interfaces/ITexture';
import { PixelFormat, TextureFilter, TextureWrap } from '../interfaces/types';
import { computeMipmapCount } from '../utils/textureUtils';

/** Logger for texture diagnostics. */
const log = createLogger('renderer:canvas2d');

/** Everything the 2D backend can draw through `drawImage`. */
export type Canvas2DImageSource =
  | HTMLImageElement
  | HTMLCanvasElement
  | HTMLVideoElement
  | ImageBitmap
  | OffscreenCanvas
  | ImageData
  | VideoFrame;

/** Options accepted by the {@link Canvas2DTexture} constructor. */
export interface Canvas2DTextureOptions {
  /** Identifier override; a generated one is used when omitted. */
  id?: string;
  /** Magnification filter used by the GPU backends. */
  magFilter?: TextureFilter;
  /** Minification filter used by the GPU backends. */
  minFilter?: TextureFilter;
  /** Horizontal wrap mode used by the GPU backends. */
  wrapS?: TextureWrap;
  /** Vertical wrap mode used by the GPU backends. */
  wrapT?: TextureWrap;
  /** Ask the GPU backends to generate a mipmap chain. */
  mipmaps?: boolean;
  /**  Logical width, when the source cannot report one yet. */
  width?: number;
  /** Logical height, when the source cannot report one yet. */
  height?: number;
  /**
   * Close the source on {@link Canvas2DTexture.dispose}.
   *
   * Defaults to `false`: a wrapped image or canvas usually belongs to the caller.
   */
  disposeSource?: boolean;
}

/**
 * Structural view of an image-ish source.
 *
 * Real DOM sources and test doubles both satisfy this.
 */
interface ImageLike {
  width?: number;
  height?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  videoWidth?: number;
  videoHeight?: number;
  complete?: boolean;
  readyState?: number;
  close?(): void;
  data?: ArrayLike<number>;
}

/**
 * Wraps a Canvas2D image source as an {@link ITexture}.
 *
 * `isReady` reports `true` as soon as the source can be blitted: images must have
 * finished loading, video frames must have data, `ImageData` and canvases are
 * always ready.
 */
export class Canvas2DTexture implements ITexture {
  /** @inheritdoc */
  public readonly id: string;

  /** @inheritdoc */
  public readonly format: PixelFormat = PixelFormat.RGBA8;

  /** @inheritdoc */
  public magFilter: TextureFilter;

  /** @inheritdoc */
  public minFilter: TextureFilter;

  /** @inheritdoc */
  public wrapS: TextureWrap;

  /** @inheritdoc */
  public wrapT: TextureWrap;

  /** The wrapped source. */
  private source: unknown;

  /** Whether this instance created the source and may therefore close it. */
  private ownsSource: boolean;

  /** `true` once {@link Canvas2DTexture.dispose} has run. */
  private disposed: boolean = false;

  /** Fallback width used when the source reports nothing. */
  private fallbackWidth: number;

  /** Fallback height used when the source reports nothing. */
  private fallbackHeight: number;

  /** Number of mip levels the GPU backends should allocate. */
  private requestedMipmaps: boolean;

  /**
   * Creates a texture.
   *
   * @param source Image, canvas, bitmap, video or `ImageData` to wrap.
   * @param options Sampling and identity overrides.
   */
  constructor(source: unknown, options: Canvas2DTextureOptions = {}) {
    this.source = source;
    this.ownsSource = options.disposeSource ?? false;
    this.id = options.id ?? `canvas2d-texture-${createId()}`;
    this.magFilter = options.magFilter ?? TextureFilter.Linear;
    this.minFilter = options.minFilter ?? TextureFilter.Linear;
    this.wrapS = options.wrapS ?? TextureWrap.ClampToEdge;
    this.wrapT = options.wrapT ?? TextureWrap.ClampToEdge;
    this.requestedMipmaps = options.mipmaps ?? false;
    this.fallbackWidth = Math.max(1, Math.floor(options.width ?? 1));
    this.fallbackHeight = Math.max(1, Math.floor(options.height ?? 1));
  }

  /**
   * Creates a texture from an already-decoded image element.
   *
   * @param image Source image.
   * @param options Sampling and identity overrides.
   */
  public static fromImage(image: Canvas2DImageSource, options: Canvas2DTextureOptions = {}): Canvas2DTexture {
    return new Canvas2DTexture(image, options);
  }

  /* ------------------------------------------------------------------- queries */

  /** Texture width in texels; falls back to the configured size while loading. */
  public get width(): number {
    return this.readSize().width;
  }

  /** Texture height in texels; falls back to the configured size while loading. */
  public get height(): number {
    return this.readSize().height;
  }

  /** Length of the mipmap chain the GPU backends should allocate. */
  public get mipLevels(): number {
    if (!this.requestedMipmaps) return 1;
    return computeMipmapCount(this.width, this.height);
  }

  /** `true` when the wrapped source can be blitted right now. */
  public get isReady(): boolean {
    if (this.disposed) return false;
    const source = this.source as ImageLike | null;
    if (source == null) return false;

    // `ImageData`, canvases and bitmaps are ready immediately.
    if (source.data != null) return true;
    if (typeof ImageData !== 'undefined' && source instanceof ImageData) return true;
    if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return true;
    if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) return true;
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return true;

    // Images report `complete`; videos report `readyState >= 2` (HAVE_CURRENT_DATA).
    if (typeof source.complete === 'boolean') return source.complete;
    if (typeof source.readyState === 'number') return source.readyState >= 2;
    return true;
  }

  /** `true` once {@link Canvas2DTexture.dispose} has run. */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Returns the wrapped source.
   *
   * @returns The image, canvas, bitmap, video or `ImageData`.
   */
  public getSource(): unknown {
    return this.source;
  }

  /**
   * Returns the wrapped source typed for `drawImage`.
   *
   * @returns The source, or `null` when nothing is bound.
   */
  public getImageSource(): Canvas2DImageSource | null {
    return this.source == null ? null : (this.source as Canvas2DImageSource);
  }

  /* ------------------------------------------------------------------ mutation */

  /**
   * Replaces the wrapped source.
   *
   * @param source New image, canvas, bitmap, video or `ImageData`.
   */
  public setData(source: unknown): void {
    if (this.disposed) {
      log.warnOnce(`setData() called on the disposed texture '${this.id}'`);
      return;
    }
    this.source = source;
  }

  /**
   * Records the logical size used while the source is still loading.
   *
   * @param width Width in texels.
   * @param height Height in texels.
   */
  public setSize(width: number, height: number): void {
    this.fallbackWidth = Math.max(1, Math.floor(width));
    this.fallbackHeight = Math.max(1, Math.floor(height));
  }

  /**
   * Updates the sampling filters used by the GPU backends.
   *
   * The 2D backend only honours the CSS `image-rendering` behaviour of the
   * destination canvas and therefore ignores these.
   *
   * @param min Minification filter.
   * @param mag Magnification filter.
   */
  public setFilters(min?: TextureFilter, mag?: TextureFilter): void {
    if (min !== undefined) this.minFilter = min;
    if (mag !== undefined) this.magFilter = mag;
  }

  /**
   * Updates the wrap modes used by the GPU backends.
   *
   * @param wrapS Horizontal wrap mode.
   * @param wrapT Vertical wrap mode.
   */
  public setWrap(wrapS?: TextureWrap, wrapT?: TextureWrap): void {
    if (wrapS !== undefined) this.wrapS = wrapS;
    if (wrapT !== undefined) this.wrapT = wrapT;
  }

  /** Flags the texture as mipmapped for the GPU backends; a no-op otherwise. */
  public generateMipmaps(): void {
    // The 2D backend has no mip chain; the flag only informs the GPU backends.
    this.requestedMipmaps = true;
  }

  /**
   * Reads the wrapped source back as RGBA bytes.
   *
   * @returns A copy of the source's pixel data for `ImageData`, otherwise `null`.
   */
  public readPixels(): Uint8ClampedArray | null {
    const source = this.source as ImageLike | null;
    if (source == null || source.data == null) return null;
    return new Uint8ClampedArray(source.data);
  }

  /* -------------------------------------------------------------------- disposal */

  /** Releases the reference to the source, closing it when it is owned. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.ownsSource) {
      const source = this.source as ImageLike | null;
      try {
        source?.close?.();
      } catch (error) {
        log.warn(`failed to close the source of texture '${this.id}'`, error);
      }
    }
    this.source = null;
  }

  /** @returns A human-readable description of the texture. */
  public toString(): string {
    return `Canvas2DTexture(${this.id}, ${this.width}x${this.height}, ready=${this.isReady})`;
  }

  /* -------------------------------------------------------------------- internals */

  /** Resolves the source's pixel dimensions, falling back to the configured size. */
  private readSize(): { width: number; height: number } {
    const source = this.source as ImageLike | null;
    if (source == null) return { width: this.fallbackWidth, height: this.fallbackHeight };

    const width =
      firstPositive(source.naturalWidth, source.videoWidth, source.width) ?? this.fallbackWidth;
    const height =
      firstPositive(source.naturalHeight, source.videoHeight, source.height) ?? this.fallbackHeight;

    return { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) };
  }
}

/** Returns the first strictly positive number, or `undefined`. */
function firstPositive(...values: (number | undefined)[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}
