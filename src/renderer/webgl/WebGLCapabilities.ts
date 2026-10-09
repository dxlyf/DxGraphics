/**
 * WebGL capability probing.
 *
 * Reads the driver limits a backend has to respect — maximum texture size, texture
 * units, vertex attributes, sample counts — once at initialisation, so the hot
 * path never calls `gl.getParameter`.
 *
 * The probe is defensive on purpose: it is driven by hand-written context doubles
 * in the unit tests and by contexts that report partial information in the wild, so
 * every read falls back to a conservative default instead of throwing.
 *
 * @packageDocumentation
 */

import { DEFAULT_MAX_TEXTURE_UNITS } from '../../constants';
import { readIntParameter, readRangeParameter, type GL } from './WebGLUtils';

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

/** Numeric limits reported by the driver. */
export interface WebGLLimits {
  /** Largest texture dimension, in texels. */
  maxTextureSize: number;
  /** Largest cube-map face dimension, in texels. */
  maxCubeMapSize: number;
  /** Largest 3D texture dimension, in texels. */
  max3DTextureSize: number;
  /** Largest texture array layer count. */
  maxArrayTextureLayers: number;
  /** Simultaneous texture units per fragment shader stage. */
  maxTextureUnits: number;
  /** Simultaneous texture units across all stages. */
  maxCombinedTextureUnits: number;
  /** Simultaneous texture units per vertex shader stage. */
  maxVertexTextureUnits: number;
  /** Vertex attributes the linker can bind. */
  maxAttributes: number;
  /** Uniform vectors available to a vertex shader. */
  maxVertexUniformVectors: number;
  /** Uniform vectors available to a fragment shader. */
  maxFragmentUniformVectors: number;
  /** Varying vectors crossing the vertex→fragment boundary. */
  maxVaryingVectors: number;
  /** Uniform buffer bindings (`WebGL2` only). */
  maxUniformBufferBindings: number;
  /** Uniform block size in bytes (`WebGL2` only). */
  maxUniformBlockSize: number;
  /** Largest renderbuffer dimension, in texels. */
  maxRenderbufferSize: number;
  /** Largest supported MSAA sample count. */
  maxSamples: number;
  /** Inclusive lower/upper bounds of the aliased line width. */
  lineWidthRange: readonly [number, number];
  /** Inclusive lower/upper bounds of the aliased point size. */
  pointSizeRange: readonly [number, number];
  /** Largest vertex index addressable by a `UNSIGNED_INT` index buffer. */
  maxElementIndex: number;
  /** Largest number of draw-buffer colour attachments. */
  maxDrawBuffers: number;
}

/** Conservative fallbacks used when a context reports nothing usable. */
export const DEFAULT_WEBGL_LIMITS: WebGLLimits = {
  maxTextureSize: 2048,
  maxCubeMapSize: 2048,
  max3DTextureSize: 256,
  maxArrayTextureLayers: 256,
  maxTextureUnits: DEFAULT_MAX_TEXTURE_UNITS,
  maxCombinedTextureUnits: DEFAULT_MAX_TEXTURE_UNITS,
  maxVertexTextureUnits: 4,
  maxAttributes: 16,
  maxVertexUniformVectors: 128,
  maxFragmentUniformVectors: 64,
  maxVaryingVectors: 8,
  maxUniformBufferBindings: 0,
  maxUniformBlockSize: 0,
  maxRenderbufferSize: 2048,
  maxSamples: 0,
  lineWidthRange: [1, 1],
  pointSizeRange: [1, 1],
  maxElementIndex: 0xffff,
  maxDrawBuffers: 1,
};

/* -------------------------------------------------------------------------- */
/* Capabilities                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Feature and limit report for one WebGL context.
 *
 * `toList()` feeds {@link RendererInfo.capabilities}; the boolean members answer
 * the "can I use this path?" questions the renderer asks while choosing a code
 * path.
 */
export class WebGLCapabilities {
  /** `true` when the context is WebGL2. */
  public readonly isWebGL2: boolean;

  /** Driver limits, already clamped to conservative minimums. */
  public readonly limits: WebGLLimits;

  /** `true` when vertex array objects are available (native or via extension). */
  public readonly supportsVertexArrayObjects: boolean;

  /** `true` when instanced drawing is available. */
  public readonly supportsInstancing: boolean;

  /** `true` when unsigned-int index buffers are available. */
  public readonly supportsUintIndices: boolean;

  /** `true` when `WEBGL_depth_texture` (or WebGL2) allows depth attachments. */
  public readonly supportsDepthTexture: boolean;

  /** `true` when float colour textures can be sampled. */
  public readonly supportsFloatTextures: boolean;

  /** `true` when half-float colour textures can be sampled. */
  public readonly supportsHalfFloatTextures: boolean;

  /** `true` when float textures may use linear filtering. */
  public readonly supportsFloatLinear: boolean;

  /** `true` when `drawBuffers` (or WebGL2) allows MRT. */
  public readonly supportsMultipleRenderTargets: boolean;

  /** `true` when explicit texture LOD control is available. */
  public readonly supportsTextureLod: boolean;

  /** `true` when framebuffer invalidation hints are available. */
  public readonly supportsInvalidateFramebuffer: boolean;

  /** `true` when `blitFramebuffer` MSAA resolve (or an equivalent) is available. */
  public readonly supportsMultisampleResolve: boolean;

  /** `true` when 3D textures / texture arrays are available. */
  public readonly supports3DTextures: boolean;

  /**
   * `true` when non-power-of-two textures may use `REPEAT`/mipmapping.
   *
   * Always `true` on WebGL2; on WebGL1 it depends on the
   * `OES_texture_npot`-style behaviour, which this probe reports as `false` so the
   * texture path resizes instead of relying on undefined behaviour.
   */
  public readonly supportsNonPowerOfTwoRepeat: boolean;

  /**
   * Probes a context.
   *
   * @param gl Context to query.
   * @param isWebGL2 `true` when the context was created with `'webgl2'`.
   * @param extensionProbe Callback answering "is this extension available?", used
   *   to resolve the WebGL1 feature set without importing the extension cache.
   */
  constructor(
    gl: GL,
    isWebGL2: boolean,
    extensionProbe: (name: string) => boolean = () => false,
  ) {
    this.isWebGL2 = isWebGL2;

    const limits: WebGLLimits = {
      maxTextureSize: readIntParameter(gl, 'MAX_TEXTURE_SIZE', 0x0d33, 0),
      maxCubeMapSize: readIntParameter(gl, 'MAX_CUBE_MAP_TEXTURE_SIZE', 0x851c, 0),
      max3DTextureSize: readIntParameter(gl, 'MAX_3D_TEXTURE_SIZE', 0x8073, 0),
      maxArrayTextureLayers: readIntParameter(gl, 'MAX_ARRAY_TEXTURE_LAYERS', 0x88ff, 0),
      maxTextureUnits: readIntParameter(gl, 'MAX_TEXTURE_IMAGE_UNITS', 0x8872, 0),
      maxCombinedTextureUnits: readIntParameter(gl, 'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 0x8b4d, 0),
      maxVertexTextureUnits: readIntParameter(gl, 'MAX_VERTEX_TEXTURE_IMAGE_UNITS', 0x8b4c, 0),
      maxAttributes: readIntParameter(gl, 'MAX_VERTEX_ATTRIBS', 0x8869, 0),
      maxVertexUniformVectors: readIntParameter(gl, 'MAX_VERTEX_UNIFORM_VECTORS', 0x8dfb, 0),
      maxFragmentUniformVectors: readIntParameter(gl, 'MAX_FRAGMENT_UNIFORM_VECTORS', 0x8dfd, 0),
      maxVaryingVectors: readIntParameter(gl, 'MAX_VARYING_VECTORS', 0x8dfc, 0),
      maxUniformBufferBindings: readIntParameter(gl, 'MAX_UNIFORM_BUFFER_BINDINGS', 0x8a2f, 0),
      maxUniformBlockSize: readIntParameter(gl, 'MAX_UNIFORM_BLOCK_SIZE', 0x8a30, 0),
      maxRenderbufferSize: readIntParameter(gl, 'MAX_RENDERBUFFER_SIZE', 0x84e8, 0),
      maxSamples: readIntParameter(gl, 'MAX_SAMPLES', 0x8d57, 0),
      lineWidthRange: readRangeParameter(gl, 'ALIASED_LINE_WIDTH_RANGE', 0x846e, [1, 1]),
      pointSizeRange: readRangeParameter(gl, 'ALIASED_POINT_SIZE_RANGE', 0x846d, [1, 1]),
      maxElementIndex: readIntParameter(gl, 'MAX_ELEMENT_INDEX', 0x8d6b, 0),
      maxDrawBuffers: readIntParameter(gl, 'MAX_DRAW_BUFFERS', 0x8824, 0),
    };

    this.limits = clampLimits(limits);

    const has = extensionProbe;
    this.supportsVertexArrayObjects = isWebGL2 || has('OES_vertex_array_object');
    this.supportsInstancing = isWebGL2 || has('ANGLE_instanced_arrays');
    this.supportsUintIndices = isWebGL2 || has('OES_element_index_uint');
    this.supportsDepthTexture = isWebGL2 || has('WEBGL_depth_texture');
    this.supportsFloatTextures = isWebGL2 || has('OES_texture_float');
    this.supportsHalfFloatTextures = isWebGL2 || has('OES_texture_half_float');
    this.supportsFloatLinear = isWebGL2 || has('OES_texture_float_linear');
    this.supportsMultipleRenderTargets = isWebGL2 || has('WEBGL_draw_buffers');
    this.supportsTextureLod = isWebGL2 || has('EXT_shader_texture_lod');
    this.supportsInvalidateFramebuffer = isWebGL2 || has('WEBGL_lose_context');
    this.supportsMultisampleResolve = isWebGL2;
    this.supports3DTextures = isWebGL2;
    this.supportsNonPowerOfTwoRepeat = isWebGL2 || has('OES_texture_npot');
  }

  /** Largest texture dimension, in texels. */
  public get maxTextureSize(): number {
    return this.limits.maxTextureSize;
  }

  /** Number of simultaneous texture units. */
  public get maxTextureUnits(): number {
    return this.limits.maxTextureUnits;
  }

  /** Number of vertex attributes. */
  public get maxAttributes(): number {
    return this.limits.maxAttributes;
  }

  /** `true` when non-power-of-two textures are a first-class concept. */
  public get supportsNonPowerOfTwo(): boolean {
    return this.supportsNonPowerOfTwoRepeat;
  }

  /**
   * Reports whether `samples` is a legal MSAA sample count.
   *
   * @param samples Requested sample count.
   */
  public supportsSamples(samples: number): boolean {
    if (!this.isWebGL2) return samples <= 1;
    if (samples <= 1) return true;
    return samples <= this.limits.maxSamples;
  }

  /**
   * Clamps a requested sample count to the largest the driver accepts.
   *
   * @param samples Requested sample count.
   */
  public clampSamples(samples: number): number {
    if (!Number.isFinite(samples) || samples <= 1) return 1;
    if (!this.isWebGL2) return 1;
    return Math.max(1, Math.min(Math.floor(samples), Math.max(1, this.limits.maxSamples)));
  }

  /**
   * Converts the report into the labels {@link RendererInfo.capabilities} carries.
   *
   * @returns Capability names, sorted so snapshots stay stable.
   */
  public toList(): string[] {
    const names: string[] = [this.isWebGL2 ? 'webgl2' : 'webgl1'];
    if (this.supportsVertexArrayObjects) names.push('vertex-array-objects');
    if (this.supportsInstancing) names.push('instancing');
    if (this.supportsUintIndices) names.push('uint-indices');
    if (this.supportsDepthTexture) names.push('depth-texture');
    if (this.supportsFloatTextures) names.push('float-textures');
    if (this.supportsHalfFloatTextures) names.push('half-float-textures');
    if (this.supportsFloatLinear) names.push('float-linear-filter');
    if (this.supportsMultipleRenderTargets) names.push('multiple-render-targets');
    if (this.supportsTextureLod) names.push('texture-lod');
    if (this.supportsMultisampleResolve) names.push('msaa-resolve');
    if (this.supports3DTextures) names.push('3d-textures');
    if (this.supportsNonPowerOfTwoRepeat) names.push('npot-repeat');
    return names.sort();
  }

  /** @returns A human-readable summary. */
  public toString(): string {
    return (
      `WebGLCapabilities(${this.isWebGL2 ? 'webgl2' : 'webgl1'}, ` +
      `maxTextureSize=${this.limits.maxTextureSize}, units=${this.limits.maxTextureUnits}, ` +
      `attributes=${this.limits.maxAttributes}, samples=${this.limits.maxSamples})`
    );
  }
}

/** Replaces zero/negative probe results with the conservative defaults. */
function clampLimits(limits: WebGLLimits): WebGLLimits {
  const pick = (value: number, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

  return {
    maxTextureSize: pick(limits.maxTextureSize, DEFAULT_WEBGL_LIMITS.maxTextureSize),
    maxCubeMapSize: pick(limits.maxCubeMapSize, pick(limits.maxTextureSize, DEFAULT_WEBGL_LIMITS.maxCubeMapSize)),
    max3DTextureSize: pick(limits.max3DTextureSize, DEFAULT_WEBGL_LIMITS.max3DTextureSize),
    maxArrayTextureLayers: pick(limits.maxArrayTextureLayers, DEFAULT_WEBGL_LIMITS.maxArrayTextureLayers),
    maxTextureUnits: pick(limits.maxTextureUnits, DEFAULT_WEBGL_LIMITS.maxTextureUnits),
    maxCombinedTextureUnits: pick(limits.maxCombinedTextureUnits, DEFAULT_WEBGL_LIMITS.maxCombinedTextureUnits),
    maxVertexTextureUnits: Math.max(0, limits.maxVertexTextureUnits || DEFAULT_WEBGL_LIMITS.maxVertexTextureUnits),
    maxAttributes: pick(limits.maxAttributes, DEFAULT_WEBGL_LIMITS.maxAttributes),
    maxVertexUniformVectors: pick(limits.maxVertexUniformVectors, DEFAULT_WEBGL_LIMITS.maxVertexUniformVectors),
    maxFragmentUniformVectors: pick(limits.maxFragmentUniformVectors, DEFAULT_WEBGL_LIMITS.maxFragmentUniformVectors),
    maxVaryingVectors: pick(limits.maxVaryingVectors, DEFAULT_WEBGL_LIMITS.maxVaryingVectors),
    maxUniformBufferBindings: Math.max(0, limits.maxUniformBufferBindings || 0),
    maxUniformBlockSize: Math.max(0, limits.maxUniformBlockSize || 0),
    maxRenderbufferSize: pick(limits.maxRenderbufferSize, DEFAULT_WEBGL_LIMITS.maxRenderbufferSize),
    maxSamples: Math.max(0, limits.maxSamples || 0),
    lineWidthRange: limits.lineWidthRange,
    pointSizeRange: limits.pointSizeRange,
    maxElementIndex: pick(limits.maxElementIndex, DEFAULT_WEBGL_LIMITS.maxElementIndex),
    maxDrawBuffers: pick(limits.maxDrawBuffers, DEFAULT_WEBGL_LIMITS.maxDrawBuffers),
  };
}
