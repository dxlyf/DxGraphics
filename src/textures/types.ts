/**
 * Texture-layer types.
 *
 * The vocabulary is intentionally WebGL/WebGPU-neutral: a `Texture` describes
 * *what* a backend should upload, and `Sampler` describes *how* it should be
 * sampled, so the same description drives a GL texture object, a WebGPU
 * `GPUTexture` plus `GPUSampler`, or the Canvas2D/SVG image caches.
 *
 * @packageDocumentation
 */

import type { TextureFormat } from './formats/TextureFormat';
import type { PixelFormat } from './formats/PixelFormat';

/* -------------------------------------------------------------------------- */
/* Sources                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A raw texel block, as used by `DataTexture` and `CompressedTexture`.
 *
 * The shape mirrors the object `DataTexture` assigns to `Texture.image`, so a
 * backend can treat CPU texels and DOM images through the same code path.
 */
export interface DataTextureSource {
  /** Texel data, row-major from the top-left corner unless `flipY` is set. */
  data: ArrayBufferView;
  /** Width in texels. */
  width: number;
  /** Height in texels. */
  height: number;
  /** Depth for 3D/array textures; defaults to `1`. */
  depth?: number;
  /** `true` when `data` holds compressed blocks rather than raw texels. */
  compressed?: boolean;
}

/** Mip level of a compressed texture. */
export interface CompressedMipmap {
  /** Compressed block data. */
  data: ArrayBufferView;
  /** Width of this level, in texels. */
  width: number;
  /** Height of this level, in texels. */
  height: number;
  /** Block width of the compression format, in texels. */
  blockWidth?: number;
  /** Block height of the compression format, in texels. */
  blockHeight?: number;
}

/**
 * Every source a texture can be uploaded from.
 *
 * `DataTextureSource` covers CPU texels; the DOM members cover images, canvases,
 * bitmaps and video frames. `HTMLVideoElement`/`VideoFrame` are accepted by the
 * static upload path, `VideoTexture` additionally re-uploads them over time.
 */
export type TextureSource =
  | HTMLImageElement
  | HTMLCanvasElement
  | HTMLVideoElement
  | ImageBitmap
  | OffscreenCanvas
  | ImageData
  | VideoFrame
  | DataTextureSource;

/** Element kind of a CPU texel buffer. */
export type TextureDataType =
  | 'uint8'
  | 'uint8-clamped'
  | 'int8'
  | 'uint16'
  | 'int16'
  | 'uint32'
  | 'int32'
  | 'float16'
  | 'float32'
  | 'float64';

/* -------------------------------------------------------------------------- */
/* Sampling                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Texture-coordinate wrapping.
 *
 * Deliberately a distinct name from the renderer's `TextureWrap` so the two
 * layers can evolve independently; they describe the same three modes.
 */
export enum WrapMode {
  /** Clamp to the edge texel (default). */
  ClampToEdge = 'clamp-to-edge',
  /** Tile the texture. */
  Repeat = 'repeat',
  /** Tile the texture, mirroring every other copy. */
  MirroredRepeat = 'mirrored-repeat',
}

/**
 * Minification/magnification filtering.
 *
 * Mipmap modes are expressed here for GL parity; the WebGPU backend maps them
 * onto the separate `Sampler.mipmapFilter`.
 */
export enum TextureFilter {
  Nearest = 'nearest',
  Linear = 'linear',
  NearestMipmapNearest = 'nearest-mipmap-nearest',
  LinearMipmapNearest = 'linear-mipmap-nearest',
  NearestMipmapLinear = 'nearest-mipmap-linear',
  LinearMipmapLinear = 'linear-mipmap-linear',
}

/** Mipmap filtering, as a WebGPU-style separate axis. */
export enum MipmapFilter {
  /** Mipmaps are not sampled. */
  None = 'none',
  /** Pick the nearest mip level. */
  Nearest = 'nearest',
  /** Blend between mip levels. */
  Linear = 'linear',
}

/**
 * How a texture is interpreted during sampling.
 *
 * `UVMapping` is the ordinary 2D case; the other modes describe environment
 * lookups, where the sampler coordinate is a direction rather than a UV.
 */
export enum Mapping {
  UVMapping = 'uv',
  UVWMapping = 'uvw',
  CubeReflectionMapping = 'cube-reflection',
  CubeRefractionMapping = 'cube-refraction',
  EquirectangularReflectionMapping = 'equirectangular-reflection',
  EquirectangularRefractionMapping = 'equirectangular-refraction',
  CubeUVReflectionMapping = 'cube-uv-reflection',
}

/** The colour spaces a texture's texels may be stored in. */
export type ColorSpaceName = 'srgb' | 'linear-srgb' | 'display-p3' | 'none';

/* -------------------------------------------------------------------------- */
/* Resizing                                                                   */
/* -------------------------------------------------------------------------- */

/** What to do with a non-power-of-two source. */
export enum NpotPolicy {
  /** Leave the dimensions alone whenever possible. */
  Allow = 'allow',
  /** Scale the source up to the next power of two (aspect ratio changes). */
  Resize = 'resize',
  /** Grow the canvas to the next power of two and centre the source. */
  Pad = 'pad',
}

/** Options accepted by `getResizePlan`. */
export interface ResizeOptions {
  /** Scale to a power of two in both axes. Defaults to `false`. */
  requirePowerOfTwo?: boolean;
  /** Hard cap applied to both axes. `0`/omitted means no cap. */
  maxSize?: number;
  /** Lower bound applied to both axes. Defaults to `1`. */
  minSize?: number;
  /** How to handle a non-power-of-two source. Defaults to {@link NpotPolicy.Resize}. */
  npotPolicy?: NpotPolicy;
}

/** The outcome of {@link ResizeOptions}-driven resizing. */
export interface ResizePlan {
  /** Target width in texels. */
  width: number;
  /** Target height in texels. */
  height: number;
  /** `width / sourceWidth`; scale the source by this factor. */
  scaleX: number;
  /** `height / sourceHeight`; scale the source by this factor. */
  scaleY: number;
  /** Horizontal padding, in texels (only for {@link NpotPolicy.Pad}). */
  padX: number;
  /** Vertical padding, in texels (only for {@link NpotPolicy.Pad}). */
  padY: number;
  /** `true` when `width`/`height` differ from the source dimensions. */
  resized: boolean;
  /** Why the plan differs from the source, or `'ok'` when it does not. */
  reason: 'ok' | 'power-of-two' | 'max-size' | 'power-of-two+max-size';
}

/* -------------------------------------------------------------------------- */
/* Render targets                                                             */
/* -------------------------------------------------------------------------- */

/** Which attachment of a render target a texture samples. */
export type RenderTargetAttachment = 'color' | 'depth' | 'stencil';

/** Structural description of the render target a `RenderTargetTexture` samples. */
export interface RenderTargetDescriptor {
  /** Width in device pixels. */
  width: number;
  /** Height in device pixels. */
  height: number;
  /** Colour attachment format. Defaults to `TextureFormat.RGBAFormat`. */
  format?: TextureFormat;
  /** Element type of the colour attachment. */
  type?: PixelFormat;
  /** Allocate a depth attachment. Defaults to `true`. */
  depth?: boolean;
  /** Allocate a stencil attachment. Defaults to `false`. */
  stencil?: boolean;
  /** Generate a mipmap chain for the colour attachment. Defaults to `false`. */
  mipmaps?: boolean;
  /** MSAA sample count; `1` disables multisampling. */
  samples?: number;
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                              */
/* -------------------------------------------------------------------------- */

/** Serialisable form of a texture produced by `Texture.toJSON()`. */
export interface TextureJSON {
  /** Texture class name, e.g. `'DataTexture'`. */
  type: string;
  /** Stable identifier of the source texture. */
  id: string;
  /** Optional user name. */
  name: string;
  /** Sampling-space interpretation. */
  mapping: Mapping;
  /** Horizontal wrap mode. */
  wrapS: WrapMode;
  /** Vertical wrap mode. */
  wrapT: WrapMode;
  /** Depth wrap mode. */
  wrapR: WrapMode;
  /** Magnification filter. */
  magFilter: TextureFilter;
  /** Minification filter. */
  minFilter: TextureFilter;
  /** Requested anisotropic filtering level. */
  anisotropy: number;
  /** Channel layout. */
  format: TextureFormat;
  /** Driver-specific internal format, or `null` for the format's default. */
  internalFormat: string | null;
  /** Element type of the texels. */
  dataType: PixelFormat;
  /** UV translation. */
  offset: [number, number];
  /** UV scale. */
  repeat: [number, number];
  /** UV rotation origin. */
  center: [number, number];
  /** UV rotation, in radians. */
  rotation: number;
  /** `true` when the UV transform is derived from the fields above. */
  matrixAutoUpdate: boolean;
  /** The current UV transform, column-major. */
  matrix: number[];
  /** `true` when a mipmap chain should be generated after upload. */
  generateMipmaps: boolean;
  /** `true` when texels are premultiplied by their alpha. */
  premultiplyAlpha: boolean;
  /** Row alignment used when uploading, in bytes. */
  unpackAlignment: number;
  /** `true` when rows are flipped during upload. */
  flipY: boolean;
  /** Colour space of the texels. */
  colorSpace: ColorSpaceName;
  /** Monotonic revision counter. */
  version: number;
  /** Dimensions of the source, as reported by `getSize`. */
  size: [number, number];
  /** `true` when the texture has usable texel data. */
  ready: boolean;
}
