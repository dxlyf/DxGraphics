/**
 * Element type of texture texels.
 *
 * `PixelFormat` answers "how is one channel stored", which the GPU backends need
 * both for `texImage2D` and for WebGPU's `GPUTextureFormat` selection. The
 * packed members (`UnsignedShort4444`, `UnsignedInt248`, ...) describe a whole
 * texel rather than a channel, which is why
 * {@link getPixelFormatByteSize} ignores the channel count for them.
 *
 * @packageDocumentation
 */

/** Storage type of a texture's texels. */
export enum PixelFormat {
  /** 8-bit unsigned normalised. */
  UnsignedByte = 'unsigned-byte',
  /** 8-bit signed normalised. */
  Byte = 'byte',
  /** 16-bit unsigned normalised. */
  UnsignedShort = 'unsigned-short',
  /** 16-bit signed normalised. */
  Short = 'short',
  /** 32-bit unsigned normalised. */
  UnsignedInt = 'unsigned-int',
  /** 32-bit signed normalised. */
  Int = 'int',
  /** 16-bit half float. */
  HalfFloat = 'half-float',
  /** 32-bit float. */
  Float = 'float',
  /** Four 4-bit channels packed into two bytes. */
  UnsignedShort4444 = 'unsigned-short-4444',
  /** 5:5:5:1 channels packed into two bytes. */
  UnsignedShort5551 = 'unsigned-short-5551',
  /** 24-bit depth plus 8-bit stencil packed into four bytes. */
  UnsignedInt248 = 'unsigned-int-248',
  /** 5:9:9:9 shared-exponent HDR packed into four bytes. */
  UnsignedInt5999Rev = 'unsigned-int-5999-rev',
  /** 10:11:11:1 packed into four bytes (unsigned). */
  UnsignedInt101111Rev = 'unsigned-int-101111-rev',
}

/** Formats that describe a whole texel, whose channel count is irrelevant. */
const PACKED_FORMATS: ReadonlySet<PixelFormat> = new Set([
  PixelFormat.UnsignedShort4444,
  PixelFormat.UnsignedShort5551,
  PixelFormat.UnsignedInt248,
  PixelFormat.UnsignedInt5999Rev,
  PixelFormat.UnsignedInt101111Rev,
]);

/** Bytes needed by one channel of each non-packed format. */
function channelByteSize(format: PixelFormat): number {
  switch (format) {
    case PixelFormat.UnsignedByte:
    case PixelFormat.Byte:
      return 1;
    case PixelFormat.UnsignedShort:
    case PixelFormat.Short:
    case PixelFormat.HalfFloat:
      return 2;
    case PixelFormat.UnsignedInt:
    case PixelFormat.Int:
    case PixelFormat.Float:
      return 4;
    default:
      return 0;
  }
}

/**
 * Bytes occupied by a texel of `format` with `channels` channels.
 *
 * For the packed members the result is the size of the whole texel regardless of
 * `channels`; for everything else it is `channels * bytesPerChannel`.
 *
 * @param format Element type.
 * @param channels Number of channels stored per texel.
 * @returns Size in bytes; `0` for an unknown format.
 */
export function getPixelFormatByteSize(format: PixelFormat, channels: number): number {
  if (PACKED_FORMATS.has(format)) return 4;
  return channelByteSize(format) * Math.max(1, Math.floor(channels));
}

/** `true` for the packed, whole-texel members. */
export function isPackedFormat(format: PixelFormat): boolean {
  return PACKED_FORMATS.has(format);
}

/** `true` for the floating-point members. */
export function isFloatPixelFormat(format: PixelFormat): boolean {
  return format === PixelFormat.Float || format === PixelFormat.HalfFloat;
}

/** `true` when the format stores signed values. */
export function isSignedPixelFormat(format: PixelFormat): boolean {
  return format === PixelFormat.Byte || format === PixelFormat.Short || format === PixelFormat.Int;
}

/** `true` for the depth/stencil packing used by depth textures. */
export function isDepthPixelFormat(format: PixelFormat): boolean {
  return (
    format === PixelFormat.UnsignedInt248 ||
    format === PixelFormat.UnsignedInt5999Rev ||
    format === PixelFormat.UnsignedInt101111Rev
  );
}

/**
 * A 1x1 texel of this format, useful for placeholders.
 *
 * @param format Element type.
 * @param channels Channels to fill.
 * @returns The bytes of a single opaque-ish white texel.
 */
export function createWhitePixel(format: PixelFormat, channels: number = 4): Uint8Array {
  const size = getPixelFormatByteSize(format, channels);
  const bytes = new Uint8Array(size);
  if (isFloatPixelFormat(format)) {
    bytes.fill(0);
    return bytes;
  }
  bytes.fill(255);
  return bytes;
}
