/**
 * WebGL enumeration conversion, pixel-format tables and small numeric helpers.
 *
 * This module is the only place in the WebGL backend that knows about raw `gl.*`
 * constants. Everything else speaks the renderer-agnostic enumerations declared in
 * `renderer/interfaces/types.ts` and lets the helpers here translate.
 *
 * ## Why the enum lookups are defensive
 *
 * `WebGLRenderingContext` and `WebGL2RenderingContext` are *unrelated* interfaces
 * in the DOM typings (the WebGL2 one does not extend the WebGL1 one), so a
 * `WebGLRenderingContext | WebGL2RenderingContext` union cannot legally read a
 * WebGL2-only name such as `gl.RGBA8`. {@link glConst} therefore reads the name
 * from the context object with a real WebGL numeric fallback. That has a second
 * benefit: a hand-written test double only needs the handful of constants it is
 * actually asserted against.
 *
 * @packageDocumentation
 */

import { BufferType, BufferUsage } from '../interfaces/IBuffer';
import {
  BlendEquation,
  BlendFactor,
  ClearFlags,
  CompareFunction,
  CullMode,
  PixelFormat,
  PrimitiveTopology,
  TextureFilter,
  TextureWrap,
} from '../interfaces/types';
import { clamp } from '../../utils/MathUtils';
import { normalizeColor, type RGBA } from '../utils/colorUtils';

/* -------------------------------------------------------------------------- */
/* Context shape                                                              */
/* -------------------------------------------------------------------------- */

/** Either WebGL context version. */
export type GL = WebGLRenderingContext | WebGL2RenderingContext;

/* -------------------------------------------------------------------------- */
/* Native handle aliases                                                      */
/* -------------------------------------------------------------------------- */

/*
 * This backend declares classes named `WebGLProgram`, `WebGLShader`,
 * `WebGLTexture`, `WebGLBuffer` and `WebGLFramebuffer`, which shadow the DOM's
 * interfaces of the same name inside those modules. The aliases below are declared
 * here — where nothing shadows anything — and imported by the wrapper classes so
 * "the native handle" and "the wrapper" stay distinguishable in the type system.
 */

/** Native GL program handle. */
export type GLProgramObject = WebGLProgram;

/** Native GL shader handle. */
export type GLShaderObject = WebGLShader;

/** Native GL texture handle. */
export type GLTextureObject = WebGLTexture;

/** Native GL buffer handle. */
export type GLBufferObject = WebGLBuffer;

/** Native GL vertex-array-object handle (WebGL2). */
export type GLVertexArrayObject = WebGLVertexArrayObject;

/** Native GL vertex-array-object handle (WebGL1 extension). */
export type GLVertexArrayObjectExt = WebGLVertexArrayObjectOES;

/** Native GL framebuffer handle. */
export type GLFramebufferObject = WebGLFramebuffer;

/** Native GL renderbuffer handle. */
export type GLRenderbufferObject = WebGLRenderbuffer;

/** Native GL uniform location handle. */
export type GLUniformLocationObject = WebGLUniformLocation;

/**
 * Reads a GL enumeration from a context, falling back to a real numeric value.
 *
 * @param gl Context (or a compatible double) to read from.
 * @param name Property name, e.g. `'RGBA8'`.
 * @param fallback Numeric value used when the context does not expose the name.
 * @returns The enumeration value.
 */
export function glConst(gl: GL, name: string, fallback: number = 0): number {
  const table = gl as unknown as Record<string, number | undefined>;
  const value = table[name];
  return typeof value === 'number' ? value : fallback;
}

/* -------------------------------------------------------------------------- */
/* Format descriptors                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Everything `texImage2D`/`texStorage2D` need for one pixel format.
 *
 * `pixelFormat` is carried along so a descriptor can be converted back into the
 * renderer-agnostic enumeration without a second lookup table.
 */
export interface GLFormatDescriptor {
  /** Sized (WebGL2) or unsized (WebGL1) internal format. */
  readonly internalFormat: number;
  /** Channel layout passed to `texImage2D`'s `format` argument. */
  readonly format: number;
  /** Component type passed to `texImage2D`'s `type` argument. */
  readonly type: number;
  /** `true` when the texels are block-compressed. */
  readonly compressed: boolean;
  /** The renderer-agnostic format this descriptor was built for. */
  readonly pixelFormat: PixelFormat;
}

/** Options accepted by {@link toGLFormat}. */
export interface GLFormatOptions {
  /**
   * `true` when the descriptor targets a WebGL2 context, which understands sized
   * internal formats. Defaults to `true`.
   */
  webgl2?: boolean;
}

/**
 * Pixel formats {@link toGLFormat} and {@link fromGLFormat} round-trip exactly.
 *
 * Compressed formats are deliberately absent: their internal format depends on the
 * extension a context exposes, so there is no stable mapping to reverse.
 */
export const SUPPORTED_PIXEL_FORMATS: readonly PixelFormat[] = [
  PixelFormat.R8,
  PixelFormat.RG8,
  PixelFormat.RGB8,
  PixelFormat.RGBA8,
  PixelFormat.SRGB8Alpha8,
  PixelFormat.BGRA8,
  PixelFormat.R16F,
  PixelFormat.RG16F,
  PixelFormat.RGBA16F,
  PixelFormat.R32F,
  PixelFormat.RGBA32F,
  PixelFormat.Depth16,
  PixelFormat.Depth24Stencil8,
  PixelFormat.Depth32F,
];

/** Formats stored as floating-point texels. */
const FLOAT_FORMATS: ReadonlySet<PixelFormat> = new Set([
  PixelFormat.R16F,
  PixelFormat.RG16F,
  PixelFormat.RGBA16F,
  PixelFormat.R32F,
  PixelFormat.RGBA32F,
]);

/** Formats whose texels are depth (or depth/stencil) samples. */
const DEPTH_FORMATS: ReadonlySet<PixelFormat> = new Set([
  PixelFormat.Depth16,
  PixelFormat.Depth24Stencil8,
  PixelFormat.Depth32F,
]);

/** Formats holding signed/unsigned integer texels rather than normalised ones. */
const INTEGER_FORMATS: ReadonlySet<PixelFormat> = new Set([
  PixelFormat.R8,
  PixelFormat.RG8,
  PixelFormat.RGB8,
  PixelFormat.RGBA8,
  PixelFormat.SRGB8Alpha8,
  PixelFormat.BGRA8,
  PixelFormat.Depth16,
  PixelFormat.Depth24Stencil8,
]);

/**
 * Converts a renderer-agnostic pixel format into the GL triple used to allocate a
 * texture or renderbuffer.
 *
 * The WebGL1 branch collapses sized internal formats onto their unsized
 * equivalents, because `gl.RGBA8` and friends do not exist before WebGL2.
 *
 * @param gl Context supplying the enumeration values.
 * @param format Format to convert.
 * @param options WebGL version selection.
 * @returns The descriptor for `format`.
 */
export function toGLFormat(gl: GL, format: PixelFormat, options: GLFormatOptions = {}): GLFormatDescriptor {
  const webgl2 = options.webgl2 ?? true;

  const rgba = glConst(gl, 'RGBA', 0x1908);
  const unsignedByte = glConst(gl, 'UNSIGNED_BYTE', 0x1401);
  const halfFloat = glConst(gl, 'HALF_FLOAT', 0x140b);
  const float = glConst(gl, 'FLOAT', 0x1406);
  const unsignedShort = glConst(gl, 'UNSIGNED_SHORT', 0x1403);
  const unsignedInt248 = glConst(gl, 'UNSIGNED_INT_24_8', 0x84fa);

  switch (format) {
    case PixelFormat.R8:
      return {
        internalFormat: webgl2 ? glConst(gl, 'R8', 0x8229) : rgba,
        format: glConst(gl, 'RED', 0x1903),
        type: unsignedByte,
        compressed: false,
        pixelFormat: format,
      };
    case PixelFormat.RG8:
      return {
        internalFormat: webgl2 ? glConst(gl, 'RG8', 0x822b) : rgba,
        format: glConst(gl, 'RG', 0x8227),
        type: unsignedByte,
        compressed: false,
        pixelFormat: format,
      };
    case PixelFormat.RGB8:
      return {
        internalFormat: webgl2 ? glConst(gl, 'RGB8', 0x8051) : glConst(gl, 'RGB', 0x1907),
        format: glConst(gl, 'RGB', 0x1907),
        type: unsignedByte,
        compressed: false,
        pixelFormat: format,
      };
    case PixelFormat.SRGB8Alpha8:
      return {
        internalFormat: webgl2 ? glConst(gl, 'SRGB8_ALPHA8', 0x8c43) : rgba,
        format: rgba,
        type: unsignedByte,
        compressed: false,
        pixelFormat: format,
      };
    case PixelFormat.BGRA8:
      return {
        internalFormat: webgl2 ? glConst(gl, 'RGBA8', 0x8058) : rgba,
        format: glConst(gl, 'BGRA', 0x80e1),
        type: unsignedByte,
        compressed: false,
        pixelFormat: format,
      };
    case PixelFormat.R16F:
      return {
        internalFormat: webgl2 ? glConst(gl, 'R16F', 0x822d) : rgba,
        format: glConst(gl, 'RED', 0x1903),
        type: halfFloat,
        compressed: false,
        pixelFormat: format,
      };
    case PixelFormat.RG16F:
      return {
        internalFormat: webgl2 ? glConst(gl, 'RG16F', 0x822f) : rgba,
        format: glConst(gl, 'RG', 0x8227),
        type: halfFloat,
        compressed: false,
        pixelFormat: format,
      };
    case PixelFormat.RGBA16F:
      return {
        internalFormat: webgl2 ? glConst(gl, 'RGBA16F', 0x881a) : rgba,
        format: rgba,
        type: halfFloat,
        compressed: false,
        pixelFormat: format,
      };
    case PixelFormat.R32F:
      return {
        internalFormat: webgl2 ? glConst(gl, 'R32F', 0x822e) : rgba,
        format: glConst(gl, 'RED', 0x1903),
        type: float,
        compressed: false,
        pixelFormat: format,
      };
    case PixelFormat.RGBA32F:
      return {
        internalFormat: webgl2 ? glConst(gl, 'RGBA32F', 0x8814) : rgba,
        format: rgba,
        type: float,
        compressed: false,
        pixelFormat: format,
      };
    case PixelFormat.Depth16:
      return {
        internalFormat: glConst(gl, 'DEPTH_COMPONENT16', 0x81a5),
        format: glConst(gl, 'DEPTH_COMPONENT', 0x1902),
        type: unsignedShort,
        compressed: false,
        pixelFormat: format,
      };
    case PixelFormat.Depth24Stencil8:
      return {
        internalFormat: glConst(gl, 'DEPTH24_STENCIL8', 0x88f0),
        format: glConst(gl, 'DEPTH_STENCIL', 0x84f9),
        type: unsignedInt248,
        compressed: false,
        pixelFormat: format,
      };
    case PixelFormat.Depth32F:
      return {
        internalFormat: webgl2 ? glConst(gl, 'DEPTH_COMPONENT32F', 0x8cac) : glConst(gl, 'DEPTH_COMPONENT16', 0x81a5),
        format: glConst(gl, 'DEPTH_COMPONENT', 0x1902),
        type: float,
        compressed: false,
        pixelFormat: format,
      };
    default:
      return {
        internalFormat: webgl2 ? glConst(gl, 'RGBA8', 0x8058) : rgba,
        format: rgba,
        type: unsignedByte,
        compressed: false,
        pixelFormat: PixelFormat.RGBA8,
      };
  }
}

/** Key under which a descriptor is registered for {@link fromGLFormat}. */
function formatKey(internalFormat: number, format: number, type: number): string {
  return `${internalFormat}|${format}|${type}`;
}

/**
 * Reverses {@link toGLFormat}.
 *
 * The lookup key is the `(internalFormat, format, type)` triple rather than the
 * internal format alone, which is what makes `RGBA8` and `BGRA8` distinguishable:
 * both are an `RGBA` sized internal format, but only one is fed from `gl.BGRA`.
 *
 * @param gl Context supplying the enumeration values.
 * @param internalFormat Internal format a texture was allocated with.
 * @param format Channel layout passed alongside it.
 * @param type Component type passed alongside it.
 * @param options WebGL version selection; must match the forward conversion.
 * @returns The matching format, or `null` when the triple is not in the table.
 */
export function fromGLFormat(
  gl: GL,
  internalFormat: number,
  format: number,
  type: number,
  options: GLFormatOptions = {},
): PixelFormat | null {
  const key = formatKey(internalFormat, format, type);
  for (const candidate of SUPPORTED_PIXEL_FORMATS) {
    const descriptor = toGLFormat(gl, candidate, options);
    if (formatKey(descriptor.internalFormat, descriptor.format, descriptor.type) === key) {
      return descriptor.pixelFormat;
    }
  }
  return null;
}

/** `true` when the format's texels are floating point. */
export function isFloatFormat(format: PixelFormat): boolean {
  return FLOAT_FORMATS.has(format);
}

/** `true` when the format's texels are depth (or depth/stencil) samples. */
export function isDepthFormat(format: PixelFormat): boolean {
  return DEPTH_FORMATS.has(format);
}

/** `true` when the format's texels are integers rather than normalised values. */
export function isIntegerFormat(format: PixelFormat): boolean {
  return INTEGER_FORMATS.has(format);
}

/**
 * `true` when a renderer-agnostic format is block-compressed.
 *
 * Every {@link PixelFormat} member is uncompressed by construction, so this always
 * returns `false`; it exists so callers do not have to special-case the
 * enumeration. Use {@link isCompressedGLInternalFormat} for raw GL values.
 *
 * @param format Format to test.
 */
export function isCompressedFormat(format: PixelFormat | null | undefined): boolean {
  if (format == null) return false;
  void format;
  return false;
}

/**
 * `true` when a raw GL internal format is one of the block-compressed families the
 * desktop and mobile extensions introduce (S3TC/DXT, ETC, ASTC, PVRTC).
 *
 * @param gl Context supplying the extension enumerations.
 * @param internalFormat Internal format to test.
 */
export function isCompressedGLInternalFormat(gl: GL, internalFormat: number): boolean {
  const names = [
    'COMPRESSED_RGB_S3TC_DXT1_EXT',
    'COMPRESSED_RGBA_S3TC_DXT5_EXT',
    'COMPRESSED_RGBA_S3TC_DXT3_EXT',
    'COMPRESSED_RGB_PVRTC_4BPPV1_IMG',
    'COMPRESSED_RGBA_PVRTC_4BPPV1_IMG',
    'COMPRESSED_RGB8_ETC2',
    'COMPRESSED_RGBA8_ETC2_EAC',
    'COMPRESSED_RGBA_ASTC_4x4_KHR',
    'COMPRESSED_RGBA_ASTC_8x8_KHR',
  ];
  for (const name of names) {
    const value = (gl as unknown as Record<string, number | undefined>)[name];
    if (typeof value === 'number' && value === internalFormat) return true;
  }
  return false;
}

/**
 * Number of bytes one texel of a format occupies on the CPU side.
 *
 * Depth/stencil packing is reported in the *storage* size the driver allocates for
 * a full pixel (`3` for 24-bit depth + 8-bit stencil), which is what callers
 * comparing buffer sizes expect.
 *
 * @param format Format to size.
 * @returns Bytes per texel, or `0` for compressed formats.
 */
export function bytesPerPixel(format: PixelFormat): number {
  switch (format) {
    case PixelFormat.R8:
      return 1;
    case PixelFormat.RG8:
      return 2;
    case PixelFormat.RGB8:
      return 3;
    case PixelFormat.RGBA8:
    case PixelFormat.SRGB8Alpha8:
    case PixelFormat.BGRA8:
      return 4;
    case PixelFormat.R16F:
      return 2;
    case PixelFormat.RG16F:
      return 4;
    case PixelFormat.RGBA16F:
      return 8;
    case PixelFormat.R32F:
      return 4;
    case PixelFormat.RGBA32F:
      return 16;
    case PixelFormat.Depth16:
      return 2;
    case PixelFormat.Depth24Stencil8:
      return 4;
    case PixelFormat.Depth32F:
      return 4;
    default:
      return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Generic enumeration conversion                                             */
/* -------------------------------------------------------------------------- */

/**
 * Converts a blend factor.
 *
 * @param gl Context supplying the enumerations.
 * @param factor Renderer-agnostic factor.
 * @returns The `gl.*` blend factor.
 */
export function toGLBlendFactor(gl: GL, factor: BlendFactor): number {
  switch (factor) {
    case BlendFactor.Zero:
      return glConst(gl, 'ZERO', 0);
    case BlendFactor.One:
      return glConst(gl, 'ONE', 1);
    case BlendFactor.SrcColor:
      return glConst(gl, 'SRC_COLOR', 0x0300);
    case BlendFactor.OneMinusSrcColor:
      return glConst(gl, 'ONE_MINUS_SRC_COLOR', 0x0301);
    case BlendFactor.DstColor:
      return glConst(gl, 'DST_COLOR', 0x0306);
    case BlendFactor.OneMinusDstColor:
      return glConst(gl, 'ONE_MINUS_DST_COLOR', 0x0307);
    case BlendFactor.SrcAlpha:
      return glConst(gl, 'SRC_ALPHA', 0x0302);
    case BlendFactor.OneMinusSrcAlpha:
      return glConst(gl, 'ONE_MINUS_SRC_ALPHA', 0x0303);
    case BlendFactor.DstAlpha:
      return glConst(gl, 'DST_ALPHA', 0x0304);
    case BlendFactor.OneMinusDstAlpha:
      return glConst(gl, 'ONE_MINUS_DST_ALPHA', 0x0305);
    case BlendFactor.ConstantColor:
      return glConst(gl, 'CONSTANT_COLOR', 0x8001);
    case BlendFactor.OneMinusConstantColor:
      return glConst(gl, 'ONE_MINUS_CONSTANT_COLOR', 0x8002);
    case BlendFactor.ConstantAlpha:
      return glConst(gl, 'CONSTANT_ALPHA', 0x8003);
    case BlendFactor.OneMinusConstantAlpha:
      return glConst(gl, 'ONE_MINUS_CONSTANT_ALPHA', 0x8004);
    case BlendFactor.SrcAlphaSaturate:
      return glConst(gl, 'SRC_ALPHA_SATURATE', 0x0308);
    default:
      return glConst(gl, 'ONE', 1);
  }
}

/**
 * Converts a blend equation.
 *
 * @param gl Context supplying the enumerations.
 * @param equation Renderer-agnostic equation.
 * @returns The `gl.*` blend equation.
 */
export function toGLBlendEquation(gl: GL, equation: BlendEquation): number {
  switch (equation) {
    case BlendEquation.Add:
      return glConst(gl, 'FUNC_ADD', 0x8006);
    case BlendEquation.Subtract:
      return glConst(gl, 'FUNC_SUBTRACT', 0x800a);
    case BlendEquation.ReverseSubtract:
      return glConst(gl, 'FUNC_REVERSE_SUBTRACT', 0x800b);
    case BlendEquation.Min:
      return glConst(gl, 'MIN', 0x8007);
    case BlendEquation.Max:
      return glConst(gl, 'MAX', 0x8008);
    default:
      return glConst(gl, 'FUNC_ADD', 0x8006);
  }
}

/**
 * Converts a comparison function.
 *
 * @param gl Context supplying the enumerations.
 * @param compare Renderer-agnostic comparison.
 * @returns The `gl.*` comparison function.
 */
export function toGLCompareFunction(gl: GL, compare: CompareFunction): number {
  switch (compare) {
    case CompareFunction.Never:
      return glConst(gl, 'NEVER', 0x0200);
    case CompareFunction.Less:
      return glConst(gl, 'LESS', 0x0201);
    case CompareFunction.Equal:
      return glConst(gl, 'EQUAL', 0x0202);
    case CompareFunction.LessEqual:
      return glConst(gl, 'LEQUAL', 0x0203);
    case CompareFunction.Greater:
      return glConst(gl, 'GREATER', 0x0204);
    case CompareFunction.NotEqual:
      return glConst(gl, 'NOTEQUAL', 0x0205);
    case CompareFunction.GreaterEqual:
      return glConst(gl, 'GEQUAL', 0x0206);
    case CompareFunction.Always:
      return glConst(gl, 'ALWAYS', 0x0207);
    default:
      return glConst(gl, 'LEQUAL', 0x0203);
  }
}

/**
 * Converts a cull mode.
 *
 * @param gl Context supplying the enumerations.
 * @param mode Renderer-agnostic cull mode.
 * @returns The `gl.*` face to cull, or `null` when culling must be disabled.
 */
export function toGLCullFace(gl: GL, mode: CullMode): number | null {
  switch (mode) {
    case CullMode.None:
      return null;
    case CullMode.Front:
      return glConst(gl, 'FRONT', 0x0404);
    case CullMode.Back:
      return glConst(gl, 'BACK', 0x0405);
    case CullMode.FrontAndBack:
      return glConst(gl, 'FRONT_AND_BACK', 0x0408);
    default:
      return glConst(gl, 'BACK', 0x0405);
  }
}

/**
 * Converts a winding order.
 *
 * @param gl Context supplying the enumerations.
 * @param counterClockwise `true` when front faces wind counter-clockwise.
 * @returns The `gl.*` winding constant.
 */
export function toGLFrontFace(gl: GL, counterClockwise: boolean): number {
  return counterClockwise ? glConst(gl, 'CCW', 0x0901) : glConst(gl, 'CW', 0x0900);
}

/**
 * Converts a primitive topology.
 *
 * @param gl Context supplying the enumerations.
 * @param topology Renderer-agnostic topology.
 * @returns The `gl.*` draw mode.
 */
export function toGLTopology(gl: GL, topology: PrimitiveTopology): number {
  switch (topology) {
    case PrimitiveTopology.Points:
      return glConst(gl, 'POINTS', 0);
    case PrimitiveTopology.Lines:
      return glConst(gl, 'LINES', 1);
    case PrimitiveTopology.LineLoop:
      return glConst(gl, 'LINE_LOOP', 2);
    case PrimitiveTopology.LineStrip:
      return glConst(gl, 'LINE_STRIP', 3);
    case PrimitiveTopology.Triangles:
      return glConst(gl, 'TRIANGLES', 4);
    case PrimitiveTopology.TriangleStrip:
      return glConst(gl, 'TRIANGLE_STRIP', 5);
    case PrimitiveTopology.TriangleFan:
      return glConst(gl, 'TRIANGLE_FAN', 6);
    default:
      return glConst(gl, 'TRIANGLES', 4);
  }
}

/**
 * Converts a buffer type into the GL bind target.
 *
 * `BufferType.Indirect` has no WebGL binding point of its own; it is reported as
 * `null` so callers can reject it with a descriptive error rather than binding the
 * wrong target.
 *
 * @param gl Context supplying the enumerations.
 * @param type Renderer-agnostic buffer type.
 * @returns The `gl.*` target, or `null` when the type has none.
 */
export function toGLBufferTarget(gl: GL, type: BufferType): number | null {
  switch (type) {
    case BufferType.Vertex:
      return glConst(gl, 'ARRAY_BUFFER', 0x8892);
    case BufferType.Index:
      return glConst(gl, 'ELEMENT_ARRAY_BUFFER', 0x8893);
    case BufferType.Uniform:
      return glConst(gl, 'UNIFORM_BUFFER', 0x8a11);
    case BufferType.Storage:
      return glConst(gl, 'SHADER_STORAGE_BUFFER', 0x90d2);
    default:
      return null;
  }
}

/**
 * Converts an update-frequency hint.
 *
 * @param gl Context supplying the enumerations.
 * @param usage Renderer-agnostic usage hint.
 * @returns The `gl.*` usage constant.
 */
export function toGLBufferUsage(gl: GL, usage: BufferUsage): number {
  switch (usage) {
    case BufferUsage.Static:
      return glConst(gl, 'STATIC_DRAW', 0x88e4);
    case BufferUsage.Dynamic:
      return glConst(gl, 'DYNAMIC_DRAW', 0x88e8);
    case BufferUsage.Stream:
      return glConst(gl, 'STREAM_DRAW', 0x88e0);
    default:
      return glConst(gl, 'STATIC_DRAW', 0x88e4);
  }
}

/**
 * Converts a texture filter into the minification/magnification pair.
 *
 * A mipmapping filter on a texture without a mip chain is silently downgraded to
 * its non-mipmapped equivalent, which is what the driver would do anyway but with
 * an `INVALID_OPERATION` warning.
 *
 * @param gl Context supplying the enumerations.
 * @param filter Renderer-agnostic filter.
 * @param hasMipmaps `true` when the texture owns a mip chain.
 * @returns The `{ min, mag }` filter pair.
 */
export function toGLTextureFilter(
  gl: GL,
  filter: TextureFilter,
  hasMipmaps: boolean = true,
): { min: number; mag: number } {
  const nearest = glConst(gl, 'NEAREST', 0x2600);
  const linear = glConst(gl, 'LINEAR', 0x2601);
  const mipNearest = glConst(gl, 'NEAREST_MIPMAP_NEAREST', 0x2700);
  const mipLinear = glConst(gl, 'LINEAR_MIPMAP_NEAREST', 0x2702);
  const mipNearestLinear = glConst(gl, 'NEAREST_MIPMAP_LINEAR', 0x2701);
  const mipLinearLinear = glConst(gl, 'LINEAR_MIPMAP_LINEAR', 0x2703);

  const mag = isNearestFilter(filter) ? nearest : linear;
  let min: number;
  switch (filter) {
    case TextureFilter.Nearest:
      min = nearest;
      break;
    case TextureFilter.Linear:
      min = linear;
      break;
    case TextureFilter.NearestMipmapNearest:
      min = mipNearest;
      break;
    case TextureFilter.LinearMipmapNearest:
      min = mipLinear;
      break;
    case TextureFilter.NearestMipmapLinear:
      min = mipNearestLinear;
      break;
    case TextureFilter.LinearMipmapLinear:
      min = mipLinearLinear;
      break;
    default:
      min = linear;
      break;
  }

  if (!hasMipmaps && min !== nearest && min !== linear) {
    min = isNearestFilter(filter) ? nearest : linear;
  }

  // A magnification filter may never reference the mip chain.
  return { min, mag };
}

/** `true` when a filter requests nearest-neighbour magnification. */
export function isNearestFilter(filter: TextureFilter): boolean {
  return (
    filter === TextureFilter.Nearest ||
    filter === TextureFilter.NearestMipmapNearest ||
    filter === TextureFilter.NearestMipmapLinear
  );
}

/**
 * Converts a wrap mode.
 *
 * @param gl Context supplying the enumerations.
 * @param wrap Renderer-agnostic wrap mode.
 * @returns The `gl.*` wrap constant.
 */
export function toGLTextureWrap(gl: GL, wrap: TextureWrap): number {
  switch (wrap) {
    case TextureWrap.ClampToEdge:
      return glConst(gl, 'CLAMP_TO_EDGE', 0x812f);
    case TextureWrap.Repeat:
      return glConst(gl, 'REPEAT', 0x2901);
    case TextureWrap.MirroredRepeat:
      return glConst(gl, 'MIRRORED_REPEAT', 0x8370);
    default:
      return glConst(gl, 'CLAMP_TO_EDGE', 0x812f);
  }
}

/**
 * Converts {@link ClearFlags} into the mask `gl.clear` expects.
 *
 * @param gl Context supplying the enumerations.
 * @param flags Bit mask of buffers to clear.
 * @returns The combined `gl.*_BUFFER_BIT` mask.
 */
export function toGLClearMask(gl: GL, flags: ClearFlags): number {
  let mask = 0;
  if ((flags & ClearFlags.Color) !== 0) mask |= glConst(gl, 'COLOR_BUFFER_BIT', 0x4000);
  if ((flags & ClearFlags.Depth) !== 0) mask |= glConst(gl, 'DEPTH_BUFFER_BIT', 0x0100);
  if ((flags & ClearFlags.Stencil) !== 0) mask |= glConst(gl, 'STENCIL_BUFFER_BIT', 0x0400);
  return mask;
}

/**
 * Converts a typed array into the `gl.*` component type.
 *
 * @param gl Context supplying the enumerations.
 * @param array Typed array, or a constructor name (`'Float32Array'`).
 * @returns The matching `gl.*` type constant.
 */
export function toGLDataType(gl: GL, array: ArrayLike<number> | string): number {
  const name = typeof array === 'string' ? array : ((array as { constructor?: { name?: string } }).constructor?.name ?? '');
  switch (name) {
    case 'Int8Array':
      return glConst(gl, 'BYTE', 0x1400);
    case 'Uint8Array':
    case 'Uint8ClampedArray':
      return glConst(gl, 'UNSIGNED_BYTE', 0x1401);
    case 'Int16Array':
      return glConst(gl, 'SHORT', 0x1402);
    case 'Uint16Array':
      return glConst(gl, 'UNSIGNED_SHORT', 0x1403);
    case 'Int32Array':
      return glConst(gl, 'INT', 0x1404);
    case 'Uint32Array':
      return glConst(gl, 'UNSIGNED_INT', 0x1405);
    case 'Float64Array':
    case 'Float32Array':
    default:
      return glConst(gl, 'FLOAT', 0x1406);
  }
}

/**
 * Size in bytes of one component of a `gl.*` component type.
 *
 * @param gl Context supplying the enumerations.
 * @param type `gl.*` component type.
 * @returns Bytes per component, or `0` for unknown types.
 */
export function getGLTypeSize(gl: GL, type: number): number {
  const table: readonly (readonly [string, number, number])[] = [
    ['BYTE', 0x1400, 1],
    ['UNSIGNED_BYTE', 0x1401, 1],
    ['SHORT', 0x1402, 2],
    ['UNSIGNED_SHORT', 0x1403, 2],
    ['INT', 0x1404, 4],
    ['UNSIGNED_INT', 0x1405, 4],
    ['FLOAT', 0x1406, 4],
    ['HALF_FLOAT', 0x140b, 2],
  ];
  for (const [name, fallback, size] of table) {
    if (glConst(gl, name, fallback) === type) return size;
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Colour / depth conversion                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Converts any accepted colour input into the four-element array `gl.clearColor`
 * and `uniform4fv` want.
 *
 * @param color Colour input (`'#rrggbb'`, `rgb()`, keyword, integer, `Color`-like).
 * @param alpha Optional alpha override in 0..1.
 * @param target Optional array to write into.
 * @returns Four 0..1 channels.
 */
export function convertColor(
  color: unknown,
  alpha?: number,
  target: [number, number, number, number] = [0, 0, 0, 1],
): [number, number, number, number] {
  const rgba: RGBA = normalizeColor(color, alpha);
  target[0] = rgba.r;
  target[1] = rgba.g;
  target[2] = rgba.b;
  target[3] = rgba.a;
  return target;
}

/**
 * Clamps a clear depth into the `[0, 1]` window-depth range WebGL uses.
 *
 * @param depth Requested depth value.
 * @param format Depth format the buffer was allocated with; only used to document
 *   that 16-bit buffers quantise the value on write.
 * @returns The clamped depth value.
 */
export function convertDepth(depth: number, format: PixelFormat = PixelFormat.Depth24Stencil8): number {
  const clamped = Number.isFinite(depth) ? clamp(depth, 0, 1) : 1;
  if (format === PixelFormat.Depth16) {
    // 16-bit depth buffers store the value quantised; report what is stored.
    return Math.round(clamped * 0xffff) / 0xffff;
  }
  return clamped;
}

/**
 * Reads the maximum texture dimension a context accepts.
 *
 * @param gl Context to query.
 * @param fallback Value used when the query fails (a partial test double).
 * @returns The maximum texture size in texels.
 */
export function getMaxTextureSizeFor(gl: GL, fallback: number = 0): number {
  try {
    const value = gl.getParameter(glConst(gl, 'MAX_TEXTURE_SIZE', 0x0d33));
    return typeof value === 'number' && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Reads an integer parameter, tolerating contexts that do not implement it.
 *
 * @param gl Context to query.
 * @param name Enumeration name to read.
 * @param fallback Numeric enumeration fallback.
 * @param defaultValue Value returned when the query fails.
 */
export function readIntParameter(gl: GL, name: string, fallback: number, defaultValue: number = 0): number {
  try {
    const value = gl.getParameter(glConst(gl, name, fallback));
    return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Reads a two-element parameter (for example `ALIASED_LINE_WIDTH_RANGE`).
 *
 * @param gl Context to query.
 * @param name Enumeration name to read.
 * @param fallback Numeric enumeration fallback.
 * @param defaultValue Pair returned when the query fails.
 */
export function readRangeParameter(
  gl: GL,
  name: string,
  fallback: number,
  defaultValue: readonly [number, number] = [1, 1],
): [number, number] {
  try {
    const value = gl.getParameter(glConst(gl, name, fallback)) as ArrayLike<number> | null;
    if (value != null && typeof value.length === 'number' && value.length >= 2) {
      return [Number(value[0]) || 0, Number(value[1]) || 0];
    }
    return [defaultValue[0], defaultValue[1]];
  } catch {
    return [defaultValue[0], defaultValue[1]];
  }
}

/**
 * Builds a human-readable description of a GL format descriptor.
 *
 * @param descriptor Descriptor to describe.
 * @param gl Optional context resolved in the description.
 */
export function describeGLFormat(descriptor: GLFormatDescriptor, gl?: GL): string {
  const nameOf = (value: number): string => {
    if (gl == null) return String(value);
    const table = gl as unknown as Record<string, unknown>;
    for (const key of Object.keys(table)) {
      if (table[key] === value && /^[A-Z0-9_]+$/.test(key)) return key;
    }
    return String(value);
  };
  return (
    `${descriptor.pixelFormat} (internalFormat=${nameOf(descriptor.internalFormat)}, ` +
    `format=${nameOf(descriptor.format)}, type=${nameOf(descriptor.type)}` +
    `${descriptor.compressed ? ', compressed' : ''})`
  );
}
