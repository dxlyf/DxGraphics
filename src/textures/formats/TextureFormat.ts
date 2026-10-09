/**
 * Channel layout of a texture.
 *
 * Formats are semantic (`RGBAFormat` means "four channels"), not
 * driver-specific: each backend maps them onto its own internal format. The
 * `*IntegerFormat` members are the unnormalised counterparts used for
 * data textures read back by a compute pass, and the `*FloatFormat` members the
 * half/float variants.
 *
 * @packageDocumentation
 */

/** The channel layout of texture texels. */
export enum TextureFormat {
  /** Single red channel. */
  RedFormat = 'red',
  /** Two channels: red, green. */
  RGFormat = 'rg',
  /** Three channels: red, green, blue. */
  RGBFormat = 'rgb',
  /** Four channels: red, green, blue, alpha (the default). */
  RGBAFormat = 'rgba',
  /** Single luminance channel; expanded to RGB on sampling. */
  LuminanceFormat = 'luminance',
  /** Luminance plus alpha. */
  LuminanceAlphaFormat = 'luminance-alpha',
  /** Alpha only. */
  AlphaFormat = 'alpha',
  /** sRGB-encoded RGBA; converted to linear light on sampling. */
  Srgb8Alpha8Format = 'srgb8-alpha8',
  /** Packed 10:10:10:2 RGB. */
  Rgb10A2Format = 'rgb10-a2',
  /** Shared-exponent HDR RGB. */
  Rgb9E5Format = 'rgb9-e5',
  /** Unnormalised single-channel integer. */
  RedIntegerFormat = 'red-integer',
  /** Unnormalised two-channel integer. */
  RGIntegerFormat = 'rg-integer',
  /** Unnormalised three-channel integer. */
  RGBIntegerFormat = 'rgb-integer',
  /** Unnormalised four-channel integer. */
  RGBAIntegerFormat = 'rgba-integer',
  /** Sixteen-bit single channel. */
  R16FloatFormat = 'r16f',
  /** Sixteen-bit two channels. */
  RG16FloatFormat = 'rg16f',
  /** Sixteen-bit three channels. */
  RGB16FloatFormat = 'rgb16f',
  /** Sixteen-bit four channels. */
  RGBA16FloatFormat = 'rgba16f',
  /** Thirty-two-bit single channel. */
  R32FloatFormat = 'r32f',
  /** Thirty-two-bit two channels. */
  RG32FloatFormat = 'rg32f',
  /** Thirty-two-bit three channels. */
  RGB32FloatFormat = 'rgb32f',
  /** Thirty-two-bit four channels. */
  RGBA32FloatFormat = 'rgba32f',
  /** Depth only. */
  DepthFormat = 'depth',
  /** Depth and stencil, packed. */
  DepthStencilFormat = 'depth-stencil',
  /** Depth with a 24-bit precision hint. */
  Depth24Stencil8Format = 'depth24-stencil8',
  /** Depth as a 32-bit float. */
  Depth32FloatFormat = 'depth32f',
}

/** Number of channels a format stores (`LuminanceAlpha` counts as two). */
export function getTextureFormatChannels(format: TextureFormat): number {
  switch (format) {
    case TextureFormat.RedFormat:
    case TextureFormat.LuminanceFormat:
    case TextureFormat.AlphaFormat:
    case TextureFormat.RedIntegerFormat:
    case TextureFormat.R16FloatFormat:
    case TextureFormat.R32FloatFormat:
      return 1;
    case TextureFormat.RGFormat:
    case TextureFormat.LuminanceAlphaFormat:
    case TextureFormat.RGIntegerFormat:
    case TextureFormat.RG16FloatFormat:
    case TextureFormat.RG32FloatFormat:
      return 2;
    case TextureFormat.RGBFormat:
    case TextureFormat.Rgb10A2Format:
    case TextureFormat.Rgb9E5Format:
    case TextureFormat.RGBIntegerFormat:
    case TextureFormat.RGB16FloatFormat:
    case TextureFormat.RGB32FloatFormat:
      return 3;
    case TextureFormat.RGBAFormat:
    case TextureFormat.Srgb8Alpha8Format:
    case TextureFormat.RGBAIntegerFormat:
    case TextureFormat.RGBA16FloatFormat:
    case TextureFormat.RGBA32FloatFormat:
      return 4;
    default:
      return 0;
  }
}

/** `true` for the unnormalised integer layouts. */
export function isIntegerFormat(format: TextureFormat): boolean {
  return format.endsWith('-integer');
}

/** `true` for the half/float layouts. */
export function isFloatFormat(format: TextureFormat): boolean {
  return format.endsWith('f') || format === TextureFormat.Rgb9E5Format;
}

/** `true` for the depth/depth-stencil layouts. */
export function isDepthFormat(format: TextureFormat): boolean {
  return format === TextureFormat.DepthFormat || format.startsWith('depth');
}

/** `true` for layouts the GPU converts from sRGB on sampling. */
export function isSrgbFormat(format: TextureFormat): boolean {
  return format === TextureFormat.Srgb8Alpha8Format;
}

/** Human-readable name, e.g. `'RGBA8'`-style labels for diagnostics. */
export function getTextureFormatName(format: TextureFormat): string {
  switch (format) {
    case TextureFormat.RGBAFormat:
      return 'RGBA';
    case TextureFormat.RGBFormat:
      return 'RGB';
    case TextureFormat.RGFormat:
      return 'RG';
    case TextureFormat.RedFormat:
      return 'R';
    default:
      return format;
  }
}

/** `true` when the format carries a depth component. */
export function hasStencilComponent(format: TextureFormat): boolean {
  return format === TextureFormat.DepthStencilFormat || format === TextureFormat.Depth24Stencil8Format;
}
