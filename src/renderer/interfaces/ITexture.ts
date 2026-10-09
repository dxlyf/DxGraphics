/**
 * Texture contract.
 *
 * `ITexture` describes a resizable, filterable image resource. The Canvas2D
 * backend implements it by wrapping an `HTMLImageElement`/`ImageBitmap`/
 * `OffscreenCanvas`/`ImageData`; the GPU backends implement it with real
 * texture objects.
 *
 * @packageDocumentation
 */

import type { PixelFormat, TextureFilter, TextureWrap } from './types';

/** Colour channels accepted when writing into a texture. */
export interface TextureColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

/** Common description of any texture implementation. */
export interface ITexture {
  /** Stable identifier used in cache keys and diagnostics. */
  readonly id: string;

  /** Texture width in texels. */
  readonly width: number;

  /** Texture height in texels. */
  readonly height: number;

  /** Storage format of the texel data. */
  readonly format: PixelFormat;

  /** Magnification filter. */
  readonly magFilter: TextureFilter;

  /** Minification filter. */
  readonly minFilter: TextureFilter;

  /** Horizontal wrap mode. */
  readonly wrapS: TextureWrap;

  /** Vertical wrap mode. */
  readonly wrapT: TextureWrap;

  /** Length of the generated mipmap chain (`1` when there is none). */
  readonly mipLevels: number;

  /** `true` when the texture has usable texel data and can be sampled. */
  readonly isReady: boolean;

  /** `true` when the texture has been released. */
  readonly isDisposed: boolean;

  /**
   * Uploads new texel data.
   *
   * @param source Image, canvas, bitmap, `ImageData` or typed array to upload.
   * @param mipLevel Destination mip level; defaults to `0`.
   */
  setData(source: unknown, mipLevel?: number): void;

  /**
   * Reallocates the texture at a new size, discarding previous contents.
   *
   * @param width New width in texels.
   * @param height New height in texels.
   */
  setSize(width: number, height: number): void;

  /** Updates the sampling filters. */
  setFilters(min?: TextureFilter, mag?: TextureFilter): void;

  /** Updates the wrap modes. */
  setWrap(wrapS?: TextureWrap, wrapT?: TextureWrap): void;

  /** Regenerates the mipmap chain; a no-op when `mipLevels <= 1`. */
  generateMipmaps(): void;

  /**
   * Reads the texture back as RGBA bytes.
   *
   * @returns A `Uint8ClampedArray`, or `null` when readback is unsupported.
   */
  readPixels(): Uint8ClampedArray | null;

  /** Releases every resource owned by the texture. */
  dispose(): void;
}

/** Subset of {@link ITexture} that a render target actually needs. */
export interface ISampledTexture {
  readonly width: number;
  readonly height: number;
  readonly isReady: boolean;
}

/** `true` when `value` satisfies the minimum {@link ITexture} shape. */
export function isTexture(value: unknown): value is ITexture {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<ITexture>;
  return (
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    typeof candidate.dispose === 'function'
  );
}
