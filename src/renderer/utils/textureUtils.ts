/**
 * Texture-sizing helpers shared by every backend.
 *
 * The functions are pure arithmetic on dimensions and byte sizes so they can be
 * unit-tested without a GPU or a canvas.
 *
 * @packageDocumentation
 */

import { isPowerOfTwo, nextPowerOfTwo } from '../../utils/MathUtils';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** Minimal description of a texture resource. */
export interface TextureSizeLike {
  width: number;
  height: number;
}

/** Result of planning a power-of-two conversion for a texture. */
export interface PotResizePlan {
  /** `true` when the texture already satisfied the power-of-two constraint. */
  ok: boolean;
  /** Resolved width (the original one when `ok` is `true`). */
  width: number;
  /** Resolved height (the original one when `ok` is `true`). */
  height: number;
  /** `true` when either dimension had to change. */
  resized: boolean;
  /** Scale factor applied to the width (`width / originalWidth`). */
  scaleX: number;
  /** Scale factor applied to the height (`height / originalHeight`). */
  scaleY: number;
}

/** Caller-provided overrides for {@link getTextureMemoryEstimate}. */
export interface TextureMemoryEstimateOptions {
  /** Mipmap chain length; defaults to the full chain from {@link computeMipmapCount}. */
  mipLevels?: number;
  /** Bytes per texel; defaults to 4. */
  bytesPerTexel?: number;
  /** Include the mipmap chain in the total. Defaults to `true`. */
  includeMipmaps?: boolean;
  /** Face count for cubemaps/arrays; defaults to 1. */
  faceCount?: number;
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

/** `true` when both texture dimensions are powers of two. */
export function isPowerOfTwoTexture(size: TextureSizeLike): boolean {
  return isPowerOfTwo(size.width) && isPowerOfTwo(size.height);
}

/**
 * Computes the number of mipmap levels in a complete chain.
 *
 * The count for a `w x h` texture is `floor(log2(max(w, h))) + 1`, with a floor
 * of `1` for invalid or degenerate sizes.
 *
 * @param width Texture width in texels.
 * @param height Texture height in texels.
 */
export function computeMipmapCount(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 1;
  const largest = Math.floor(Math.max(width, height));
  if (largest < 1) return 1;
  return Math.floor(Math.log2(largest)) + 1;
}

/** Mipmap-count overload accepting a size object. */
export function computeMipmapCountFor(size: TextureSizeLike): number {
  return computeMipmapCount(size.width, size.height);
}

/**
 * Reports whether a resize would be needed to reach power-of-two dimensions.
 *
 * @param size Current dimensions.
 * @param mode `'ceil'` (default) grows to the next power of two, `'floor'`
 *   shrinks to the previous one, `'round'` picks whichever is closer.
 */
export function wouldResizeForPot(size: TextureSizeLike, mode: 'ceil' | 'floor' | 'round' = 'ceil'): boolean {
  if (isPowerOfTwoTexture(size)) return false;
  const plan = planPotResize(size, mode);
  return plan.width !== size.width || plan.height !== size.height;
}

/**
 * Plans the power-of-two conversion for a texture.
 *
 * @param size Current dimensions.
 * @param mode Rounding strategy: `'ceil'` (default), `'floor'` or `'round'`.
 * @returns The target dimensions plus the scale factors that produce them.
 */
export function planPotResize(size: TextureSizeLike, mode: 'ceil' | 'floor' | 'round' = 'ceil'): PotResizePlan {
  const originalWidth = Math.max(1, Math.floor(size.width));
  const originalHeight = Math.max(1, Math.floor(size.height));

  if (isPowerOfTwo(originalWidth) && isPowerOfTwo(originalHeight)) {
    return {
      ok: true,
      width: originalWidth,
      height: originalHeight,
      resized: false,
      scaleX: 1,
      scaleY: 1,
    };
  }

  const width = roundPot(originalWidth, mode);
  const height = roundPot(originalHeight, mode);

  return {
    ok: false,
    width,
    height,
    resized: width !== originalWidth || height !== originalHeight,
    scaleX: width / originalWidth,
    scaleY: height / originalHeight,
  };
}

/** Rounds a single dimension to a power of two using `mode`. */
function roundPot(value: number, mode: 'ceil' | 'floor' | 'round'): number {
  const size = Math.max(1, Math.floor(value));
  if (isPowerOfTwo(size)) return size;

  const up = nextPowerOfTwo(size);
  const down = Math.max(1, up >> 1);

  if (mode === 'ceil') return up;
  if (mode === 'floor') return down;
  return size - down < up - size ? down : up;
}

/* -------------------------------------------------------------------------- */
/* Memory                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Estimates the bytes a texture occupies at one mip level.
 *
 * @param width Width in texels.
 * @param height Height in texels.
 * @param bytesPerTexel Bytes per texel; defaults to 4 (`rgba8`).
 */
export function getTextureByteSize(width: number, height: number, bytesPerTexel: number = 4): number {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  return w * h * Math.max(0, bytesPerTexel);
}

/**
 * Estimates the total bytes a texture occupies, including its mip chain.
 *
 * @param size Texture dimensions.
 * @param options Mip level / texel size / face count overrides.
 * @returns Total bytes.
 */
export function getTextureMemoryEstimate(
  size: TextureSizeLike,
  options: TextureMemoryEstimateOptions = {},
): number {
  const bytesPerTexel = options.bytesPerTexel ?? 4;
  const faceCount = Math.max(1, options.faceCount ?? 1);
  const includeMipmaps = options.includeMipmaps ?? true;

  let width = Math.max(1, Math.floor(size.width));
  let height = Math.max(1, Math.floor(size.height));

  const available = computeMipmapCount(width, height);
  const levels = Math.max(1, Math.min(options.mipLevels ?? available, available));

  let total = 0;
  for (let level = 0; level < levels; level++) {
    total += getTextureByteSize(width, height, bytesPerTexel);
    if (!includeMipmaps) break;
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
  }

  return total * faceCount;
}

/**
 * Rounds a dimension up to the next power of two.
 *
 * Re-exported here so that texture code has a single import for sizing helpers.
 */
export { nextPowerOfTwo };

/**
 * Clamps a dimension to the maximum texture size reported by the device.
 *
 * @param size Requested dimensions.
 * @param maxTextureSize Device limit (e.g. `gl.MAX_TEXTURE_SIZE`).
 * @returns The clamped dimensions plus the scale factors to get there.
 */
export function clampToMaxTextureSize(
  size: TextureSizeLike,
  maxTextureSize: number,
): { width: number; height: number; scale: number; clamped: boolean } {
  const width = Math.max(1, Math.floor(size.width));
  const height = Math.max(1, Math.floor(size.height));
  const limit = Math.max(1, Math.floor(maxTextureSize));
  const largest = Math.max(width, height);

  if (largest <= limit) return { width, height, scale: 1, clamped: false };

  const scale = limit / largest;
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
    clamped: true,
  };
}
