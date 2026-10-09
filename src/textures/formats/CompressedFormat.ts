/**
 * Block-compressed texture formats.
 *
 * Every block-compressed format stores texels as fixed-size blocks, so the byte
 * size of a level is
 * `ceil(width / blockWidth) * ceil(height / blockHeight) * blockBytes`.
 * {@link getBlockSize} supplies those three numbers and
 * {@link isBlockCompressed} answers whether a format is compressed at all.
 *
 * @packageDocumentation
 */

/** Block-compressed texel layouts. */
export enum CompressedFormat {
  /** S3TC DXT1 / BC1: 4x4 blocks, 8 bytes, no alpha (or 1-bit alpha). */
  S3tcDxt1 = 's3tc-dxt1',
  /** S3TC DXT3 / BC2: 4x4 blocks, 16 bytes, explicit 4-bit alpha. */
  S3tcDxt3 = 's3tc-dxt3',
  /** S3TC DXT5 / BC3: 4x4 blocks, 16 bytes, interpolated alpha. */
  S3tcDxt5 = 's3tc-dxt5',
  /** ETC1: 4x4 blocks, 8 bytes, RGB only (no alpha). */
  Etc1 = 'etc1',
  /** ETC2 RGB: 4x4 blocks, 8 bytes. */
  Etc2Rgb = 'etc2-rgb',
  /** ETC2 RGBA: 4x4 blocks, 16 bytes. */
  Etc2Rgba = 'etc2-rgba',
  /** EAC single channel (R11): 4x4 blocks, 8 bytes. */
  EacR11 = 'eac-r11',
  /** EAC two channel (RG11): 4x4 blocks, 16 bytes. */
  EacRg11 = 'eac-rg11',
  /** ASTC 4x4: 128-bit blocks. */
  Astc4x4 = 'astc-4x4',
  /** ASTC 5x5. */
  Astc5x5 = 'astc-5x5',
  /** ASTC 6x6. */
  Astc6x6 = 'astc-6x6',
  /** ASTC 8x5. */
  Astc8x5 = 'astc-8x5',
  /** ASTC 8x6. */
  Astc8x6 = 'astc-8x6',
  /** ASTC 8x8. */
  Astc8x8 = 'astc-8x8',
  /** ASTC 10x5. */
  Astc10x5 = 'astc-10x5',
  /** ASTC 10x6. */
  Astc10x6 = 'astc-10x6',
  /** ASTC 10x8. */
  Astc10x8 = 'astc-10x8',
  /** ASTC 10x10. */
  Astc10x10 = 'astc-10x10',
  /** ASTC 12x10. */
  Astc12x10 = 'astc-12x10',
  /** ASTC 12x12. */
  Astc12x12 = 'astc-12x12',
  /** BPTC / BC7: 4x4 blocks, 16 bytes, high-quality RGBA. */
  Bptc = 'bptc',
  /** BPTC signed float / BC6H: 4x4 blocks, 16 bytes. */
  BptcSignedFloat = 'bptc-signed-float',
  /** PVRTC 2bpp RGB: 4x4 blocks, 8 bytes. */
  PvrtcRgb2 = 'pvrtc-rgb-2bpp',
  /** PVRTC 4bpp RGB: 4x4 blocks, 16 bytes. */
  PvrtcRgb4 = 'pvrtc-rgb-4bpp',
  /** PVRTC 2bpp RGBA: 4x4 blocks, 8 bytes. */
  PvrtcRgba2 = 'pvrtc-rgba-2bpp',
  /** PVRTC 4bpp RGBA: 4x4 blocks, 16 bytes. */
  PvrtcRgba4 = 'pvrtc-rgba-4bpp',
  /** RGTC single channel (BC4): 4x4 blocks, 8 bytes. */
  RgtcR = 'rgtc-r',
  /** RGTC two channel (BC5): 4x4 blocks, 16 bytes. */
  RgtcRg = 'rgtc-rg',
}

/** Geometry of one compressed block. */
export interface BlockSize {
  /** Block width in texels. */
  width: number;
  /** Block height in texels. */
  height: number;
  /** Bytes per block. */
  bytes: number;
}

/** ASTC block dimensions keyed by format. */
const ASTC_BLOCKS: Readonly<Partial<Record<CompressedFormat, [number, number]>>> = {
  [CompressedFormat.Astc4x4]: [4, 4],
  [CompressedFormat.Astc5x5]: [5, 5],
  [CompressedFormat.Astc6x6]: [6, 6],
  [CompressedFormat.Astc8x5]: [8, 5],
  [CompressedFormat.Astc8x6]: [8, 6],
  [CompressedFormat.Astc8x8]: [8, 8],
  [CompressedFormat.Astc10x5]: [10, 5],
  [CompressedFormat.Astc10x6]: [10, 6],
  [CompressedFormat.Astc10x8]: [10, 8],
  [CompressedFormat.Astc10x10]: [10, 10],
  [CompressedFormat.Astc12x10]: [12, 10],
  [CompressedFormat.Astc12x12]: [12, 12],
};

/**
 * Block geometry of a compressed format.
 *
 * @param format Compressed layout.
 * @returns Block width/height in texels and bytes per block; all zeros for a
 *   format that is not block compressed.
 */
export function getBlockSize(format: CompressedFormat): BlockSize {
  const astc = ASTC_BLOCKS[format];
  if (astc) return { width: astc[0], height: astc[1], bytes: 16 };

  switch (format) {
    case CompressedFormat.S3tcDxt1:
    case CompressedFormat.Etc1:
    case CompressedFormat.Etc2Rgb:
    case CompressedFormat.EacR11:
    case CompressedFormat.PvrtcRgb2:
    case CompressedFormat.PvrtcRgba2:
    case CompressedFormat.RgtcR:
      return { width: 4, height: 4, bytes: 8 };
    case CompressedFormat.S3tcDxt3:
    case CompressedFormat.S3tcDxt5:
    case CompressedFormat.Etc2Rgba:
    case CompressedFormat.EacRg11:
    case CompressedFormat.Bptc:
    case CompressedFormat.BptcSignedFloat:
    case CompressedFormat.PvrtcRgb4:
    case CompressedFormat.PvrtcRgba4:
    case CompressedFormat.RgtcRg:
      return { width: 4, height: 4, bytes: 16 };
    default:
      return { width: 0, height: 0, bytes: 0 };
  }
}

/**
 * `true` when the format stores fixed-size blocks.
 *
 * @param format Format to test.
 */
export function isBlockCompressed(format: CompressedFormat): boolean {
  return getBlockSize(format).bytes > 0;
}

/**
 * `true` when the format carries an alpha channel.
 *
 * @param format Format to test.
 */
export function hasAlphaChannel(format: CompressedFormat): boolean {
  switch (format) {
    case CompressedFormat.S3tcDxt3:
    case CompressedFormat.S3tcDxt5:
    case CompressedFormat.Etc2Rgba:
    case CompressedFormat.Bptc:
    case CompressedFormat.PvrtcRgba2:
    case CompressedFormat.PvrtcRgba4:
      return true;
    default:
      return false;
  }
}

/**
 * Bytes needed by one mip level of a compressed texture.
 *
 * @param format Compressed layout.
 * @param width Level width in texels.
 * @param height Level height in texels.
 * @returns Byte size, or `0` for a format that is not block compressed.
 */
export function getCompressedLevelByteSize(
  format: CompressedFormat,
  width: number,
  height: number,
): number {
  const block = getBlockSize(format);
  if (block.bytes === 0) return 0;
  const blocksX = Math.max(1, Math.ceil(width / block.width));
  const blocksY = Math.max(1, Math.ceil(height / block.height));
  return blocksX * blocksY * block.bytes;
}
