/**
 * Texture utilities: sizing, mipmaps, NPOT handling, byte accounting and
 * placeholder textures.
 *
 * Everything here is pure: it inspects a texture description or a source and
 * returns numbers, so the helpers run in a Node test without a GPU or a DOM.
 *
 * ```ts
 * computeMipmapCount(64, 64);                        // 7
 * getResizePlan(300, 200, { requirePowerOfTwo: true });
 * // { width: 512, height: 256, scaleX: 1.7066..., resized: true, ... }
 * ```
 *
 * @packageDocumentation
 */

import { DEFAULT_MIPMAP_LEVELS } from '../constants';
import { DataTexture } from './DataTexture';
import { PixelFormat, getPixelFormatByteSize } from './formats/PixelFormat';
import { CompressedFormat, getCompressedLevelByteSize } from './formats/CompressedFormat';
import {
  getTextureFormatChannels,
  isDepthFormat,
  isFloatFormat,
  TextureFormat,
} from './formats/TextureFormat';
import { NpotPolicy, type ResizeOptions, type ResizePlan, type TextureDataType, type TextureSource } from './types';
import { CompressedTexture } from './CompressedTexture';
import { Texture } from './Texture';

/** Options accepted by {@link getTextureByteSize}. */
export interface TextureByteSizeOptions {
  /** Include the whole mip chain. Defaults to `false`. */
  includeMipmaps?: boolean;
  /** Explicit level count, overriding the mip-derived one. */
  levels?: number;
}

/* -------------------------------------------------------------------------- */
/* Power of two                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `true` when `value` is a power of two (including `1`).
 *
 * Deliberately duplicated from `utils/MathUtils.isPowerOfTwo`: the texture layer
 * is consumed by bundlers that must be able to tree-shake it away when textures
 * are unused, and a three-line bit test is a poor reason to pull in the whole
 * math-utility module. Both implementations are covered by unit tests.
 *
 * @param value Value to test.
 */
export function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

/**
 * Smallest power of two greater than or equal to `value`.
 *
 * Not exported from this module's public surface: `utils/MathUtils` already owns
 * the name, and re-exporting it here would make the library's umbrella entry point
 * ambiguous. It stays available inside the texture layer.
 *
 * @param value Lower bound.
 * @returns `1` for inputs `<= 1`.
 */
function nextPowerOfTwo(value: number): number {
  if (value <= 1) return 1;
  return Math.pow(2, Math.ceil(Math.log2(value)));
}

/* -------------------------------------------------------------------------- */
/* Mipmaps                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Number of mip levels a `width x height x depth` texture can have.
 *
 * The chain halves the largest dimension each step and stops when every
 * dimension has reached one texel, so `1 -> 1`, `2 -> 2`, `64 -> 7`, `300 -> 9`.
 *
 * @param width Level-0 width.
 * @param height Level-0 height.
 * @param depth Level-0 depth, for 3D textures.
 */
export function computeMipmapCount(width: number, height: number, depth: number = 1): number {
  const largest = Math.max(1, Math.floor(width), Math.floor(height), Math.floor(depth));
  return Math.floor(Math.log2(largest)) + 1;
}

/**
 * Number of mip levels implied by a texture's configuration.
 *
 * @param texture Texture to inspect.
 * @returns The supplied level count for a `CompressedTexture`, `1` when mipmap
 *   generation is disabled, and otherwise the full chain length.
 */
export function getTextureMipmapCount(texture: Texture): number {
  if (texture instanceof CompressedTexture) return Math.max(1, texture.mipmapCount);
  if (!texture.generateMipmaps) return Math.max(DEFAULT_MIPMAP_LEVELS, 1);
  const size = texture.getSize();
  return computeMipmapCount(size.x, size.y);
}

/* -------------------------------------------------------------------------- */
/* Byte accounting                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Bytes per texel of a format/type pair.
 *
 * @param format Channel layout.
 * @param type Element type.
 */
export function getTexelByteSize(format: TextureFormat, type: PixelFormat): number {
  if (isDepthFormat(format)) return 4;
  return getPixelFormatByteSize(type, getTextureFormatChannels(format));
}

/**
 * Bytes a texture occupies (or will occupy) on the GPU.
 *
 * @param texture Texture to measure.
 * @param options Mipmap inclusion.
 * @returns Size in bytes; compressed textures report the size of their supplied
 *   levels.
 */
export function getTextureByteSize(texture: Texture, options: TextureByteSizeOptions = {}): number {
  if (texture instanceof CompressedTexture) {
    if (options.levels !== undefined) {
      let total = 0;
      for (let level = 0; level < Math.min(options.levels, texture.mipmapCount); level++) {
        total += texture.expectedLevelByteSize(level);
      }
      return total;
    }
    return texture.byteLength;
  }

  const size = texture.getSize();
  const width = Math.max(1, Math.floor(size.x));
  const height = Math.max(1, Math.floor(size.y));
  const bytesPerTexel = getTexelByteSize(texture.format, texture.type);
  // `includeMipmaps` counts the chain the dimensions *allow*, which is what a
  // size budget needs; use `getTextureMipmapCount()` for the levels the texture
  // is actually configured to produce.
  const levels = Math.max(
    1,
    options.levels ?? (options.includeMipmaps ? computeMipmapCount(width, height) : 1),
  );

  let total = 0;
  for (let level = 0; level < levels; level++) {
    const levelWidth = Math.max(1, width >> level);
    const levelHeight = Math.max(1, height >> level);
    total += levelWidth * levelHeight * bytesPerTexel;
  }
  return total;
}

/* -------------------------------------------------------------------------- */
/* NPOT handling                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Plans how a source of a given size must be resized for the driver.
 *
 * @param width Source width.
 * @param height Source height.
 * @param options Constraints to satisfy.
 * @returns The plan; `resized` is `false` when the source is already usable.
 */
export function getResizePlan(
  width: number,
  height: number,
  options: ResizeOptions = {},
): ResizePlan {
  const sourceWidth = Math.max(1, Math.floor(width));
  const sourceHeight = Math.max(1, Math.floor(height));
  const minSize = Math.max(1, Math.floor(options.minSize ?? 1));
  const maxSize = options.maxSize !== undefined && options.maxSize > 0 ? Math.floor(options.maxSize) : 0;
  const policy = options.npotPolicy ?? NpotPolicy.Resize;
  const requirePot = (options.requirePowerOfTwo ?? false) && policy !== NpotPolicy.Allow;

  let targetWidth = Math.max(minSize, sourceWidth);
  let targetHeight = Math.max(minSize, sourceHeight);
  let reason: ResizePlan['reason'] = 'ok';
  let padX = 0;
  let padY = 0;

  const npot = !isPowerOfTwo(targetWidth) || !isPowerOfTwo(targetHeight);
  if (requirePot && npot) {
    if (policy === NpotPolicy.Pad) {
      const paddedWidth = nextPowerOfTwo(targetWidth);
      const paddedHeight = nextPowerOfTwo(targetHeight);
      padX = paddedWidth - targetWidth;
      padY = paddedHeight - targetHeight;
      targetWidth = paddedWidth;
      targetHeight = paddedHeight;
    } else {
      targetWidth = nextPowerOfTwo(targetWidth);
      targetHeight = nextPowerOfTwo(targetHeight);
    }
    reason = 'power-of-two';
  }

  if (maxSize > 0 && (targetWidth > maxSize || targetHeight > maxSize)) {
    const scale = maxSize / Math.max(targetWidth, targetHeight);
    targetWidth = Math.max(1, Math.floor(targetWidth * scale));
    targetHeight = Math.max(1, Math.floor(targetHeight * scale));
    if (requirePot) {
      // Round *down* so the clamp is never violated.
      targetWidth = Math.max(1, previousPowerOfTwo(targetWidth));
      targetHeight = Math.max(1, previousPowerOfTwo(targetHeight));
    }
    reason = reason === 'power-of-two' ? 'power-of-two+max-size' : 'max-size';
  }

  return {
    width: targetWidth,
    height: targetHeight,
    scaleX: targetWidth / sourceWidth,
    scaleY: targetHeight / sourceHeight,
    padX,
    padY,
    resized: targetWidth !== sourceWidth || targetHeight !== sourceHeight,
    reason,
  };
}

/**
 * `true` when a source of this size needs resizing for the driver.
 *
 * @param width Source width.
 * @param height Source height.
 * @param options Constraints to satisfy.
 */
export function needsResize(width: number, height: number, options: ResizeOptions = {}): boolean {
  return getResizePlan(width, height, options).resized;
}

/** Largest power of two less than or equal to `value`. */
function previousPowerOfTwo(value: number): number {
  let result = 1;
  while (result * 2 <= value) result *= 2;
  return result;
}

/* -------------------------------------------------------------------------- */
/* Sources                                                                    */
/* -------------------------------------------------------------------------- */

/** `true` when the source object carries a typed-array `data` member. */
function isRawSource(source: unknown): source is { data: ArrayBufferView; width?: number; height?: number } {
  return (
    typeof source === 'object' &&
    source !== null &&
    'data' in (source as Record<string, unknown>) &&
    ArrayBuffer.isView((source as { data?: unknown }).data)
  );
}

/**
 * `true` when a texture has usable texel data.
 *
 * @param texture Texture to test.
 */
export function isTextureReady(texture: Texture | null | undefined): boolean {
  return texture != null && texture.isReady();
}

/** Bytes per element of a typed array, or `1` for a `DataView`. */
function getBytesPerElement(data: ArrayBufferView): number {
  const bytes = (data as unknown as { BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT;
  return typeof bytes === 'number' && bytes > 0 ? bytes : 1;
}

/**
 * Guesses the channel layout of a source.
 *
 * DOM sources are always RGBA; typed arrays are inferred from their channel
 * count (a `Float32Array` of `4 * width * height` floats is RGBA, and so on).
 *
 * @param source Source to inspect.
 * @param width Optional width, used to disambiguate typed arrays.
 * @param height Optional height, used to disambiguate typed arrays.
 * @returns The guessed layout.
 */
export function guessFormatFromSource(
  source: TextureSource | null | undefined,
  width?: number,
  height?: number,
): TextureFormat {
  if (source == null) return TextureFormat.RGBAFormat;
  if (!isRawSource(source)) return TextureFormat.RGBAFormat;

  const texels = Math.max(1, (width ?? source.width ?? 1) * (height ?? source.height ?? 1));
  const bytesPerElement = getBytesPerElement(source.data);
  const components = source.data.byteLength / bytesPerElement / texels;
  switch (Math.round(components)) {
    case 1:
      return TextureFormat.RedFormat;
    case 2:
      return TextureFormat.RGFormat;
    case 3:
      return TextureFormat.RGBFormat;
    default:
      return TextureFormat.RGBAFormat;
  }
}

/**
 * Maps a typed array to the element kind used by `DataTexture`.
 *
 * @param data Typed array, or `null` for the default (`uint8`).
 * @returns The element kind.
 */
export function getTextureDataType(data: ArrayBufferView | null | undefined): TextureDataType {
  if (!data) return 'uint8';
  if (data instanceof Uint8ClampedArray) return 'uint8-clamped';
  if (data instanceof Int8Array) return 'int8';
  if (data instanceof Uint16Array) return 'uint16';
  if (data instanceof Int16Array) return 'int16';
  if (data instanceof Uint32Array) return 'uint32';
  if (data instanceof Int32Array) return 'int32';
  if (data instanceof Float64Array) return 'float64';
  if (data instanceof Float32Array) return 'float32';
  return 'uint8';
}

/** Maps a {@link TextureDataType} onto the `PixelFormat` used for uploads. */
export function dataTypeToPixelFormat(type: TextureDataType): PixelFormat {
  switch (type) {
    case 'uint8':
    case 'uint8-clamped':
      return PixelFormat.UnsignedByte;
    case 'int8':
      return PixelFormat.Byte;
    case 'uint16':
      return PixelFormat.UnsignedShort;
    case 'int16':
      return PixelFormat.Short;
    case 'uint32':
      return PixelFormat.UnsignedInt;
    case 'int32':
      return PixelFormat.Int;
    case 'float16':
      return PixelFormat.HalfFloat;
    default:
      return PixelFormat.Float;
  }
}

/* -------------------------------------------------------------------------- */
/* flipY helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Flips an image buffer vertically, in place.
 *
 * @param data Texel buffer, row-major from the top-left corner.
 * @param width Width in texels.
 * @param height Height in texels.
 * @param bytesPerPixel Bytes per texel; defaults to `data.length / (width * height)`.
 * @returns `data`, for chaining.
 */
export function flipYPixels<T extends ArrayBufferView>(
  data: T,
  width: number,
  height: number,
  bytesPerPixel?: number,
): T {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const stride = Math.max(1, Math.floor(bytesPerPixel ?? bytes.length / Math.max(1, width * height)));
  const rowBytes = Math.max(1, Math.floor(width)) * stride;

  if (rowBytes * height > bytes.length) {
    throw new RangeError(
      `flipYPixels: buffer of ${bytes.length} bytes is too small for ${width}x${height} at ${stride} bytes/texel`,
    );
  }

  const scratch = new Uint8Array(rowBytes);
  for (let row = 0; row < Math.floor(height / 2); row++) {
    const top = row * rowBytes;
    const bottom = (Math.floor(height) - 1 - row) * rowBytes;
    scratch.set(bytes.subarray(top, top + rowBytes));
    bytes.copyWithin(top, bottom, bottom + rowBytes);
    bytes.set(scratch, bottom);
  }
  return data;
}

/**
 * Returns a vertically flipped copy of an image buffer.
 *
 * @param data Texel buffer, row-major from the top-left corner.
 * @param width Width in texels.
 * @param height Height in texels.
 * @param bytesPerPixel Bytes per texel.
 * @returns A new buffer with the rows reversed.
 */
export function flipYCopy(
  data: ArrayBufferView,
  width: number,
  height: number,
  bytesPerPixel: number,
): Uint8Array {
  const copy = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return new Uint8Array(flipYPixels(copy, width, height, bytesPerPixel).buffer);
}

/**
 * `true` when a source needs its rows flipped for the requested `flipY` flag.
 *
 * Raw texel data is uploaded verbatim, so a data texture whose `flipY` is set
 * needs an explicit CPU flip.
 *
 * @param source Source to inspect.
 * @param flipY Whether the backend is configured to flip rows.
 */
export function isFlipYRequired(source: TextureSource | null | undefined, flipY: boolean): boolean {
  return flipY && isRawSource(source);
}

/* -------------------------------------------------------------------------- */
/* Placeholder textures                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A 1x1 white texture.
 *
 * Bound wherever a required sampler would otherwise be missing, so a
 * `#define`-less shader cannot sample an unbound texture unit. Built as a
 * `DataTexture` rather than a data URI so nothing touches the network or the DOM.
 */
export function createWhiteTexture(): DataTexture {
  const texture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  texture.name = 'white';
  texture.colorSpace = 'linear-srgb';
  return texture;
}

/** A 1x1 opaque black texture. */
export function createBlackTexture(): DataTexture {
  const texture = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  texture.name = 'black';
  texture.colorSpace = 'linear-srgb';
  return texture;
}

/** A 1x1 fully transparent texture. */
export function createTransparentTexture(): DataTexture {
  const texture = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  texture.name = 'transparent';
  texture.colorSpace = 'linear-srgb';
  return texture;
}

/**
 * A 1x1 tangent-space flat normal, encoded as `(128, 128, 255)`.
 *
 * Multiplying a sampled normal map by a unit vector is a common fallback, and
 * this is the neutral value for that.
 */
export function createNormalTexture(): DataTexture {
  const texture = new DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  texture.name = 'flat-normal';
  texture.colorSpace = 'linear-srgb';
  return texture;
}

/** A 1x1 mid-grey texture, used as the default roughness/metalness input. */
export function createGrayTexture(): DataTexture {
  const texture = new DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  texture.name = 'gray';
  texture.colorSpace = 'linear-srgb';
  return texture;
}

/**
 * A `size x size` RGBA texture filled with one colour.
 *
 * @param size Edge length in texels.
 * @param rgba Channel values in `0..255`.
 * @param name Optional texture name.
 */
export function createSolidTexture(
  size: number,
  rgba: readonly [number, number, number, number],
  name: string = 'solid',
): DataTexture {
  const edge = Math.max(1, Math.floor(size));
  const data = new Uint8Array(edge * edge * 4);
  for (let i = 0; i < edge * edge; i++) {
    data[i * 4 + 0] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  const texture = new DataTexture(data, edge, edge);
  texture.name = name;
  return texture;
}

/**
 * A default texture for a slot that has none.
 *
 * @returns A shared 1x1 white texture.
 */
export function createDefaultTexture(): DataTexture {
  return createWhiteTexture();
}

/**
 * Byte size a single compressed level would occupy.
 *
 * @param format Block layout.
 * @param width Level width in texels.
 * @param height Level height in texels.
 */
export function getCompressedByteSize(format: CompressedFormat, width: number, height: number): number {
  return getCompressedLevelByteSize(format, width, height);
}

/**
 * `true` when a float texture of the given element type can be filtered.
 *
 * Half-float is filterable on every backend the library targets; full float
 * filtering needs `OES_texture_float_linear` in WebGL 1.
 */
export function isFilterableFormat(format: TextureFormat): boolean {
  return !isFloatFormat(format) || format === TextureFormat.RGBA16FloatFormat;
}
