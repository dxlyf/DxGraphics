/**
 * WebGPU structural types, enumeration mapping, alignment maths and layout builders.
 *
 * ## Why the GPU types are declared here
 *
 * The project ships **zero runtime npm dependencies**, and the WebGPU typings live in
 * the `@webgpu/types` package rather than in TypeScript's `lib.dom`. This module
 * therefore declares the smallest structural description of each WebGPU handle the
 * backend actually touches. Real `GPUDevice`/`GPUBuffer`/... objects satisfy these
 * shapes structurally, so no cast is needed anywhere in the backend, and a
 * hand-written double in the unit tests satisfies them too.
 *
 * ## Alignment
 *
 * Two 256-byte alignment rules govern WebGPU uploads and are both implemented here:
 * a dynamic uniform offset must be a multiple of `minUniformBufferOffsetAlignment`
 * (256), and `bytesPerRow` in a `copyBufferToTexture` must be a multiple of 256. The
 * second is the one that silently produces garbled textures when it is wrong, so
 * {@link bytesPerRowAlignment} and {@link computeTextureCopyLayout} exist to keep it
 * in one place.
 *
 * @packageDocumentation
 */

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
import { BufferType, BufferUsage } from '../interfaces/IBuffer';
import type { ColorWriteState } from '../core/RenderState';
import { computeMipmapCount } from '../utils/textureUtils';
import { createLogger } from '../../utils/Logger';

/** Logger for WebGPU layout diagnostics. */
const log = createLogger('renderer:webgpu:utils');

/* -------------------------------------------------------------------------- */
/* Structural GPU handles                                                     */
/* -------------------------------------------------------------------------- */

/** Opaque texture view. */
export interface GPUTextureViewLike {
  readonly label?: string;
}

/** Opaque sampler. */
export interface GPUSamplerLike {
  readonly label?: string;
}

/** Opaque bind group. */
export interface GPUBindGroupLike {
  readonly label?: string;
}

/** Opaque bind group layout. */
export interface GPUBindGroupLayoutLike {
  readonly label?: string;
}

/** Opaque pipeline layout. */
export interface GPUPipelineLayoutLike {
  readonly label?: string;
}

/** Opaque command buffer. */
export interface GPUCommandBufferLike {
  readonly label?: string;
}

/** Opaque query set. */
export interface GPUQuerySetLike {
  readonly label?: string;
  destroy(): void;
}

/** `GPUTexture`. */
export interface GPUTextureLike {
  readonly label?: string;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly mipLevelCount: number;
  readonly sampleCount: number;
  readonly format: string;
  readonly usage: number;
  createView(descriptor?: unknown): GPUTextureViewLike;
  destroy(): void;
}

/** `GPUBuffer`. */
export interface GPUBufferLike {
  readonly label?: string;
  readonly size: number;
  readonly usage: number;
  readonly mapState: string;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
  mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
}

/** One compilation message from a shader module. */
export interface GPUCompilationMessageLike {
  readonly message: string;
  readonly type: 'error' | 'warning' | 'info';
  readonly lineNum: number;
  readonly linePos: number;
  readonly offset: number;
  readonly length: number;
}

/** Compilation diagnostics for a shader module. */
export interface GPUCompilationInfoLike {
  readonly messages: readonly GPUCompilationMessageLike[];
}

/** `GPUShaderModule`. */
export interface GPUShaderModuleLike {
  readonly label?: string;
  getCompilationInfo?(): Promise<GPUCompilationInfoLike>;
}

/** `GPURenderPipeline`. */
export interface GPURenderPipelineLike {
  readonly label?: string;
  getBindGroupLayout?(index: number): GPUBindGroupLayoutLike;
}

/** `GPUComputePipeline`. */
export interface GPUComputePipelineLike {
  readonly label?: string;
  getBindGroupLayout?(index: number): GPUBindGroupLayoutLike;
}

/** `GPURenderPassEncoder`. */
export interface GPURenderPassEncoderLike {
  setPipeline(pipeline: GPURenderPipelineLike): void;
  setBindGroup(index: number, bindGroup: GPUBindGroupLike, dynamicOffsets?: readonly number[]): void;
  setVertexBuffer(slot: number, buffer: GPUBufferLike | null, offset?: number, size?: number): void;
  setIndexBuffer(buffer: GPUBufferLike, format: string, offset?: number, size?: number): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
  drawIndexed(
    indexCount: number,
    instanceCount?: number,
    firstIndex?: number,
    baseVertex?: number,
    firstInstance?: number,
  ): void;
  setViewport(x: number, y: number, width: number, height: number, minDepth?: number, maxDepth?: number): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;
  setBlendConstant?(color: unknown): void;
  setStencilReference?(reference: number): void;
  end(): void;
}

/** `GPUComputePassEncoder`. */
export interface GPUComputePassEncoderLike {
  setPipeline(pipeline: GPUComputePipelineLike): void;
  setBindGroup(index: number, bindGroup: GPUBindGroupLike, dynamicOffsets?: readonly number[]): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  dispatchWorkgroupsIndirect?(indirectBuffer: GPUBufferLike, indirectOffset: number): void;
  end(): void;
}

/** `GPUCommandEncoder`. */
export interface GPUCommandEncoderLike {
  beginRenderPass(descriptor: unknown): GPURenderPassEncoderLike;
  beginComputePass(descriptor?: unknown): GPUComputePassEncoderLike;
  copyBufferToBuffer(
    source: GPUBufferLike,
    sourceOffset: number,
    destination: GPUBufferLike,
    destinationOffset: number,
    size: number,
  ): void;
  copyBufferToTexture(source: unknown, destination: unknown, copySize: unknown): void;
  copyTextureToBuffer(source: unknown, destination: unknown, copySize: unknown): void;
  copyTextureToTexture(source: unknown, destination: unknown, copySize: unknown): void;
  resolveQuerySet?(
    querySet: GPUQuerySetLike,
    firstQuery: number,
    queryCount: number,
    destination: GPUBufferLike,
    destinationOffset: number,
  ): void;
  finish(): GPUCommandBufferLike;
}

/** `GPUQueue`. */
export interface GPUQueueLike {
  writeBuffer(buffer: GPUBufferLike, bufferOffset: number, data: ArrayBufferView | ArrayBuffer, dataOffset?: number, size?: number): void;
  writeTexture(destination: unknown, data: ArrayBufferView | ArrayBuffer, dataLayout: unknown, size: unknown): void;
  submit(commandBuffers: readonly GPUCommandBufferLike[]): void;
  onSubmittedWorkDone(): Promise<void>;
}

/** `GPUAdapterInfo`. */
export interface GPUAdapterInfoLike {
  readonly vendor?: string;
  readonly architecture?: string;
  readonly device?: string;
  readonly description?: string;
}

/** A feature set, accepting both the real `GPUSupportedFeatures` and a plain array. */
export interface GPUFeatureSetLike {
  has(name: string): boolean;
}

/** `GPUAdapter`. */
export interface GPUAdapterLike {
  readonly features: GPUFeatureSetLike | readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly info?: GPUAdapterInfoLike;
  requestDevice(descriptor?: unknown): Promise<GPUDeviceLike>;
}

/** Reasons a device can be lost. */
export interface GPUDeviceLostInfoLike {
  readonly reason?: string;
  readonly message?: string;
}

/** `GPUDevice`. */
export interface GPUDeviceLike {
  readonly label?: string;
  readonly features: GPUFeatureSetLike | readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly queue: GPUQueueLike;
  readonly lost: Promise<GPUDeviceLostInfoLike>;
  createBuffer(descriptor: unknown): GPUBufferLike;
  createTexture(descriptor: unknown): GPUTextureLike;
  createSampler(descriptor?: unknown): GPUSamplerLike;
  createShaderModule(descriptor: unknown): GPUShaderModuleLike;
  createBindGroupLayout(descriptor: unknown): GPUBindGroupLayoutLike;
  createPipelineLayout(descriptor: unknown): GPUPipelineLayoutLike;
  createBindGroup(descriptor: unknown): GPUBindGroupLike;
  createRenderPipeline(descriptor: unknown): GPURenderPipelineLike;
  createComputePipeline(descriptor: unknown): GPUComputePipelineLike;
  createCommandEncoder(descriptor?: unknown): GPUCommandEncoderLike;
  createQuerySet?(descriptor: unknown): GPUQuerySetLike;
  destroy(): void;
  pushErrorScope?(filter: string): void;
  popErrorScope?(): Promise<{ readonly message?: string } | null>;
}

/** Configured canvas context. */
export interface GPUCanvasContextLike {
  configure(configuration: unknown): void;
  unconfigure(): void;
  getCurrentTexture(): GPUTextureLike;
}

/** The entry point `navigator.gpu` provides. */
export interface GPUProviderLike {
  requestAdapter(options?: unknown): Promise<GPUAdapterLike | null>;
  getPreferredCanvasFormat?(): string;
  wgslLanguageFeatures?: GPUFeatureSetLike | readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Enumeration tables                                                         */
/* -------------------------------------------------------------------------- */

/** `GPUBufferUsage` bits. */
export const GPUBufferUsageFlags = {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
} as const;

/** `GPUTextureUsage` bits. */
export const GPUTextureUsageFlags = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
} as const;

/** `GPUMapMode` bits. */
export const GPUMapMode = {
  READ: 0x0001,
  WRITE: 0x0002,
} as const;

/** `GPUColorWrite` bits. */
export const GPUColorWrite = {
  RED: 0x1,
  GREEN: 0x2,
  BLUE: 0x4,
  ALPHA: 0x8,
  ALL: 0xf,
} as const;

/** `GPUShaderStage` bits. */
export const GPUShaderStage = {
  VERTEX: 0x1,
  FRAGMENT: 0x2,
  COMPUTE: 0x4,
} as const;

/** `GPUTextureSampleType` names. */
export const GPUTextureSampleType = {
  Float: 'float',
  UnfilterableFloat: 'unfilterable-float',
  Depth: 'depth',
  Sint: 'sint',
  Uint: 'uint',
} as const;

/** `GPUBufferBindingType` names. */
export const GPUBufferBindingType = {
  Uniform: 'uniform',
  Storage: 'storage',
  ReadOnlyStorage: 'read-only-storage',
} as const;

/** Bytes of alignment WebGPU requires for a dynamic uniform buffer offset. */
export const UNIFORM_BUFFER_ALIGNMENT = 256;

/** Bytes of alignment WebGPU requires for a texture copy row. */
export const TEXTURE_ROW_ALIGNMENT = 256;

/* -------------------------------------------------------------------------- */
/* Provider access                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Reads the WebGPU entry point from the global scope.
 *
 * `navigator.gpu` is the standard location; worker globals expose it the same way.
 *
 * @returns The provider, or `null` when WebGPU is unavailable.
 */
export function getGPUProvider(): GPUProviderLike | null {
  const navigatorLike = (globalThis as unknown as { navigator?: { gpu?: GPUProviderLike } }).navigator;
  const gpu = navigatorLike?.gpu;
  if (gpu != null && typeof gpu.requestAdapter === 'function') return gpu;
  return null;
}

/**
 * Reports whether WebGPU is available in this runtime.
 *
 * @returns `true` when `navigator.gpu.requestAdapter` exists.
 */
export function isWebGPUAvailable(): boolean {
  return getGPUProvider() !== null;
}

/**
 * `true` when a feature set contains `name`, accepting either the real
 * `GPUSupportedFeatures` object or a plain array of names.
 *
 * @param features Feature set to test.
 * @param name Feature name.
 */
export function hasFeature(features: GPUFeatureSetLike | readonly string[] | null | undefined, name: string): boolean {
  if (features == null) return false;
  if (Array.isArray(features)) return features.includes(name);
  const candidate = features as GPUFeatureSetLike;
  if (typeof candidate.has === 'function') return candidate.has(name);
  return false;
}

/**
 * Lists the names in a feature set.
 *
 * @param features Feature set to enumerate.
 */
export function featureList(features: GPUFeatureSetLike | readonly string[] | null | undefined): string[] {
  if (features == null) return [];
  if (Array.isArray(features)) return [...features];
  const candidate = features as unknown as Iterable<string>;
  if (typeof (candidate as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
    const names: string[] = [];
    for (const name of candidate) names.push(name);
    return names;
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Alignment                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Rounds a value up to the next multiple of `alignment`.
 *
 * @param value Value to round.
 * @param alignment Alignment; `0`/negative is treated as `1`.
 */
export function alignTo(value: number, alignment: number): number {
  const step = Number.isFinite(alignment) && alignment > 0 ? Math.floor(alignment) : 1;
  const scaled = Math.floor(value);
  if (scaled <= 0) return 0;
  return Math.ceil(scaled / step) * step;
}

/**
 * Rounds a uniform buffer offset up to the required 256-byte boundary.
 *
 * @param offset Byte offset.
 */
export function alignUniformOffset(offset: number): number {
  return alignTo(offset, UNIFORM_BUFFER_ALIGNMENT);
}

/**
 * Rounds a texture row length in bytes up to the 256-byte copy alignment.
 *
 * `100` becomes `256`; `512` stays `512`. This is the single most common source of
 * garbled texture uploads in WebGPU, so the function is exported for tests.
 *
 * @param rowBytes Unaligned row length in bytes.
 */
export function bytesPerRowAlignment(rowBytes: number): number {
  return alignTo(rowBytes, TEXTURE_ROW_ALIGNMENT);
}

/**
 * Computes the layout of a `copyBufferToTexture` for a 2D region.
 *
 * @param width Region width in texels.
 * @param height Region height in texels.
 * @param bytesPerPixel Bytes per texel of the source format.
 * @param depthOrArrayLayers Layers/array slices copied; defaults to `1`.
 * @returns The aligned `bytesPerRow`, `rowsPerImage` and total `byteLength`.
 */
export function computeTextureCopyLayout(
  width: number,
  height: number,
  bytesPerPixel: number,
  depthOrArrayLayers: number = 1,
): { bytesPerRow: number; rowsPerImage: number; byteLength: number } {
  const texelsPerRow = Math.max(1, Math.floor(width));
  const rows = Math.max(1, Math.floor(height));
  const layers = Math.max(1, Math.floor(depthOrArrayLayers));
  const unalignedRow = texelsPerRow * Math.max(1, bytesPerPixel);
  const bytesPerRow = bytesPerRowAlignment(unalignedRow);
  return {
    bytesPerRow,
    rowsPerImage: rows,
    byteLength: bytesPerRow * rows * layers,
  };
}

/**
 * Computes the copy extent (in texels and layers) for a texture region.
 *
 * @param width Region width in texels.
 * @param height Region height in texels.
 * @param depthOrArrayLayers Layers to copy; defaults to `1`.
 */
export function computeTextureCopyExtent(
  width: number,
  height: number,
  depthOrArrayLayers: number = 1,
): { width: number; height: number; depthOrArrayLayers: number } {
  return {
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
    depthOrArrayLayers: Math.max(1, Math.floor(depthOrArrayLayers)),
  };
}

/** Mip levels of a complete chain for a 2D texture. */
export function computeMipLevelCount(width: number, height: number): number {
  return computeMipmapCount(width, height);
}

/** Size of one dimension at a mip level, clamped to at least one texel. */
export function mipSizeAtLevel(size: number, level: number): number {
  return Math.max(1, Math.floor(size) >> Math.max(0, Math.floor(level)));
}

/* -------------------------------------------------------------------------- */
/* Format mapping                                                             */
/* -------------------------------------------------------------------------- */

/** Renderer-agnostic formats {@link toGPUTextureFormat} supports. */
export const SUPPORTED_GPU_TEXTURE_FORMATS: readonly PixelFormat[] = [
  PixelFormat.R8,
  PixelFormat.RG8,
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

/** Formats usable as a render attachment. */
const RENDERABLE_FORMATS: ReadonlySet<string> = new Set([
  'r8unorm',
  'rg8unorm',
  'rgba8unorm',
  'rgba8unorm-srgb',
  'bgra8unorm',
  'bgra8unorm-srgb',
  'r16float',
  'rg16float',
  'rgba16float',
  'r32float',
  'rgba32float',
  'depth16unorm',
  'depth24plus',
  'depth24plus-stencil8',
  'depth32float',
]);

/** Formats that store depth (or depth/stencil) samples. */
const DEPTH_GPU_FORMATS: ReadonlySet<string> = new Set([
  'depth16unorm',
  'depth24plus',
  'depth24plus-stencil8',
  'depth32float',
  'stencil8',
]);

/**
 * Maps a renderer-agnostic pixel format onto a WebGPU `GPUTextureFormat`.
 *
 * `RGB8` has no WebGPU equivalent (there is no 24-bit packed colour format), so it
 * maps onto `rgba8unorm` and {@link fromGPUTextureFormat} therefore reports it back
 * as `RGBA8`. That asymmetry is documented rather than hidden.
 *
 * @param format Format to convert.
 */
export function toGPUTextureFormat(format: PixelFormat): string {
  switch (format) {
    case PixelFormat.R8:
      return 'r8unorm';
    case PixelFormat.RG8:
      return 'rg8unorm';
    case PixelFormat.RGB8:
    case PixelFormat.RGBA8:
      return 'rgba8unorm';
    case PixelFormat.SRGB8Alpha8:
      return 'rgba8unorm-srgb';
    case PixelFormat.BGRA8:
      return 'bgra8unorm';
    case PixelFormat.R16F:
      return 'r16float';
    case PixelFormat.RG16F:
      return 'rg16float';
    case PixelFormat.RGBA16F:
      return 'rgba16float';
    case PixelFormat.R32F:
      return 'r32float';
    case PixelFormat.RGBA32F:
      return 'rgba32float';
    case PixelFormat.Depth16:
      return 'depth16unorm';
    case PixelFormat.Depth24Stencil8:
      return 'depth24plus-stencil8';
    case PixelFormat.Depth32F:
      return 'depth32float';
    default:
      return 'rgba8unorm';
  }
}

/**
 * Reverses {@link toGPUTextureFormat} for the formats that round-trip exactly.
 *
 * @param format WebGPU format name.
 * @returns The matching format, or `null`.
 */
export function fromGPUTextureFormat(format: string): PixelFormat | null {
  switch (format) {
    case 'r8unorm':
      return PixelFormat.R8;
    case 'rg8unorm':
      return PixelFormat.RG8;
    case 'rgba8unorm':
      return PixelFormat.RGBA8;
    case 'rgba8unorm-srgb':
      return PixelFormat.SRGB8Alpha8;
    case 'bgra8unorm':
      return PixelFormat.BGRA8;
    case 'r16float':
      return PixelFormat.R16F;
    case 'rg16float':
      return PixelFormat.RG16F;
    case 'rgba16float':
      return PixelFormat.RGBA16F;
    case 'r32float':
      return PixelFormat.R32F;
    case 'rgba32float':
      return PixelFormat.RGBA32F;
    case 'depth16unorm':
      return PixelFormat.Depth16;
    case 'depth24plus-stencil8':
      return PixelFormat.Depth24Stencil8;
    case 'depth32float':
      return PixelFormat.Depth32F;
    default:
      return null;
  }
}

/** `true` when a WebGPU format can be used as a render attachment. */
export function isRenderableGPUTextureFormat(format: string): boolean {
  return RENDERABLE_FORMATS.has(format);
}

/** `true` when a WebGPU format stores depth (or depth/stencil) samples. */
export function isDepthGPUTextureFormat(format: string): boolean {
  return DEPTH_GPU_FORMATS.has(format);
}

/** Bytes per texel of a WebGPU format, or `0` when it is compressed/unknown. */
export function bytesPerTexelForGPUFormat(format: string): number {
  switch (format) {
    case 'r8unorm':
    case 'r8snorm':
    case 'r8uint':
    case 'r8sint':
    case 'stencil8':
      return 1;
    case 'rg8unorm':
    case 'rg8snorm':
    case 'rg8uint':
    case 'rg8sint':
    case 'r16float':
    case 'r16uint':
    case 'r16sint':
    case 'depth16unorm':
      return 2;
    case 'rgba8unorm':
    case 'rgba8unorm-srgb':
    case 'bgra8unorm':
    case 'bgra8unorm-srgb':
    case 'rgb10a2unorm':
    case 'rg11b10ufloat':
    case 'depth24plus':
    case 'depth24plus-stencil8':
    case 'r32float':
    case 'r32uint':
    case 'r32sint':
    case 'rg16float':
      return 4;
    case 'rgba16float':
    case 'rg32float':
    case 'depth32float':
      return 8;
    case 'rgba32float':
      return 16;
    default:
      return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Usage mapping                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Maps a buffer type and usage hint onto `GPUBufferUsage` bits.
 *
 * @param type Kind of buffer.
 * @param usage Update-frequency hint; currently informational (WebGPU has no
 *   usage hint that corresponds, so every buffer is created `COPY_DST`).
 * @returns Combined usage bits.
 */
export function toGPUBufferUsage(type: BufferType, usage: BufferUsage = BufferUsage.Static): number {
  void usage;
  switch (type) {
    case BufferType.Vertex:
      return GPUBufferUsageFlags.VERTEX | GPUBufferUsageFlags.COPY_DST;
    case BufferType.Index:
      return GPUBufferUsageFlags.INDEX | GPUBufferUsageFlags.COPY_DST;
    case BufferType.Uniform:
      return GPUBufferUsageFlags.UNIFORM | GPUBufferUsageFlags.COPY_DST;
    case BufferType.Storage:
      return GPUBufferUsageFlags.STORAGE | GPUBufferUsageFlags.COPY_DST | GPUBufferUsageFlags.COPY_SRC;
    case BufferType.Indirect:
      return GPUBufferUsageFlags.INDIRECT | GPUBufferUsageFlags.COPY_DST;
    default:
      return GPUBufferUsageFlags.COPY_DST;
  }
}

/** Roles a texture may be created for. */
export interface GPUTextureUsageOptions {
  /** Copy out of the texture. */
  copySrc?: boolean;
  /** Copy into the texture. */
  copyDst?: boolean;
  /** Sample the texture in a shader. */
  textureBinding?: boolean;
  /** Read/write the texture from a compute shader. */
  storageBinding?: boolean;
  /** Use the texture as a render-pass attachment. */
  renderAttachment?: boolean;
}

/**
 * Maps roles onto `GPUTextureUsage` bits.
 *
 * @param options Roles to enable.
 * @returns Combined usage bits; never zero (`COPY_DST` is always added, because a
 *   texture with no usage at all is rejected by the validation layer).
 */
export function toGPUTextureUsage(options: GPUTextureUsageOptions = {}): number {
  let usage = 0;
  if (options.copySrc ?? false) usage |= GPUTextureUsageFlags.COPY_SRC;
  if (options.copyDst ?? true) usage |= GPUTextureUsageFlags.COPY_DST;
  if (options.textureBinding ?? true) usage |= GPUTextureUsageFlags.TEXTURE_BINDING;
  if (options.storageBinding ?? false) usage |= GPUTextureUsageFlags.STORAGE_BINDING;
  if (options.renderAttachment ?? false) usage |= GPUTextureUsageFlags.RENDER_ATTACHMENT;
  return usage === 0 ? GPUTextureUsageFlags.COPY_DST : usage;
}

/* -------------------------------------------------------------------------- */
/* Render-state mapping                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Maps a blend factor.
 *
 * @param factor Renderer-agnostic factor.
 */
export function toGPUBlendFactor(factor: BlendFactor): string {
  switch (factor) {
    case BlendFactor.Zero:
      return 'zero';
    case BlendFactor.One:
      return 'one';
    case BlendFactor.SrcColor:
      return 'src';
    case BlendFactor.OneMinusSrcColor:
      return 'one-minus-src';
    case BlendFactor.DstColor:
      return 'dst';
    case BlendFactor.OneMinusDstColor:
      return 'one-minus-dst';
    case BlendFactor.SrcAlpha:
      return 'src-alpha';
    case BlendFactor.OneMinusSrcAlpha:
      return 'one-minus-src-alpha';
    case BlendFactor.DstAlpha:
      return 'dst-alpha';
    case BlendFactor.OneMinusDstAlpha:
      return 'one-minus-dst-alpha';
    case BlendFactor.ConstantColor:
      return 'constant';
    case BlendFactor.OneMinusConstantColor:
      return 'one-minus-constant';
    case BlendFactor.ConstantAlpha:
      // WebGPU has a single `constant` factor; the alpha variant maps onto it and
      // the distinction is documented rather than silently dropped.
      return 'constant';
    case BlendFactor.OneMinusConstantAlpha:
      return 'one-minus-constant';
    case BlendFactor.SrcAlphaSaturate:
      return 'src-alpha-saturated';
    default:
      return 'one';
  }
}

/**
 * Maps a blend equation.
 *
 * @param equation Renderer-agnostic equation.
 */
export function toGPUBlendOperation(equation: BlendEquation): string {
  switch (equation) {
    case BlendEquation.Add:
      return 'add';
    case BlendEquation.Subtract:
      return 'subtract';
    case BlendEquation.ReverseSubtract:
      return 'reverse-subtract';
    case BlendEquation.Min:
      return 'min';
    case BlendEquation.Max:
      return 'max';
    default:
      return 'add';
  }
}

/**
 * Maps a comparison function.
 *
 * @param compare Renderer-agnostic comparison.
 */
export function toGPUCompareFunction(compare: CompareFunction): string {
  switch (compare) {
    case CompareFunction.Never:
      return 'never';
    case CompareFunction.Less:
      return 'less';
    case CompareFunction.Equal:
      return 'equal';
    case CompareFunction.LessEqual:
      return 'less-equal';
    case CompareFunction.Greater:
      return 'greater';
    case CompareFunction.NotEqual:
      return 'not-equal';
    case CompareFunction.GreaterEqual:
      return 'greater-equal';
    case CompareFunction.Always:
      return 'always';
    default:
      return 'less';
  }
}

/**
 * Maps a primitive topology.
 *
 * `LineLoop` and `TriangleFan` have no WebGPU equivalent; they degrade to
 * `line-strip`/`triangle-list` and a debug record names the substitution so the
 * difference is discoverable.
 *
 * @param topology Renderer-agnostic topology.
 * @param label Optional label used in the debug record.
 */
export function toGPUPrimitiveTopology(topology: PrimitiveTopology, label: string = ''): string {
  switch (topology) {
    case PrimitiveTopology.Points:
      return 'point-list';
    case PrimitiveTopology.Lines:
      return 'line-list';
    case PrimitiveTopology.LineStrip:
      return 'line-strip';
    case PrimitiveTopology.LineLoop:
      log.debug(
        `WebGPU has no line-loop topology${label.length > 0 ? ` (${label})` : ''}; using line-strip. ` +
          'Append the first vertex to the geometry to close the loop.',
      );
      return 'line-strip';
    case PrimitiveTopology.Triangles:
      return 'triangle-list';
    case PrimitiveTopology.TriangleStrip:
      return 'triangle-strip';
    case PrimitiveTopology.TriangleFan:
      log.debug(
        `WebGPU has no triangle-fan topology${label.length > 0 ? ` (${label})` : ''}; using ` +
          'triangle-list. Convert the fan to a triangle list, or use a strip with degenerate vertices.',
      );
      return 'triangle-list';
    default:
      return 'triangle-list';
  }
}

/**
 * Maps a cull mode.
 *
 * @param mode Renderer-agnostic cull mode.
 */
export function toGPUCullMode(mode: CullMode): string {
  switch (mode) {
    case CullMode.None:
      return 'none';
    case CullMode.Front:
      return 'front';
    case CullMode.Back:
      return 'back';
    case CullMode.FrontAndBack:
      // WebGPU cannot cull both faces; the conventional equivalent is to cull the
      // front face and reverse the winding of the geometry, which callers do.
      return 'front';
    default:
      return 'back';
  }
}

/**
 * Maps a draw order onto `GPUFrontFace`.
 *
 * @param counterClockwise `true` when front faces wind counter-clockwise.
 */
export function toGPUFrontFace(counterClockwise: boolean): string {
  return counterClockwise ? 'ccw' : 'cw';
}

/**
 * Builds a `GPUColorWriteFlags` mask from a {@link ColorWriteState}.
 *
 * @param state Colour-write configuration.
 */
export function toGPUColorWriteMask(state: Readonly<ColorWriteState>): number {
  return colorWriteMask(state.r, state.g, state.b, state.a);
}

/**
 * Builds a `GPUColorWriteFlags` mask from four booleans.
 *
 * @param r Write red.
 * @param g Write green.
 * @param b Write blue.
 * @param a Write alpha.
 */
export function colorWriteMask(r: boolean, g: boolean, b: boolean, a: boolean): number {
  let mask = 0;
  if (r) mask |= GPUColorWrite.RED;
  if (g) mask |= GPUColorWrite.GREEN;
  if (b) mask |= GPUColorWrite.BLUE;
  if (a) mask |= GPUColorWrite.ALPHA;
  return mask;
}

/**
 * Maps a texture wrap mode onto `GPUAddressMode`.
 *
 * @param wrap Renderer-agnostic wrap mode.
 */
export function toGPUAddressMode(wrap: TextureWrap): string {
  switch (wrap) {
    case TextureWrap.ClampToEdge:
      return 'clamp-to-edge';
    case TextureWrap.Repeat:
      return 'repeat';
    case TextureWrap.MirroredRepeat:
      return 'mirror-repeat';
    default:
      return 'clamp-to-edge';
  }
}

/**
 * Maps a texture filter onto `GPUFilterMode`.
 *
 * @param filter Renderer-agnostic filter.
 */
export function toGPUFilterMode(filter: TextureFilter): string {
  return filter === TextureFilter.Nearest || filter === TextureFilter.NearestMipmapNearest ||
    filter === TextureFilter.NearestMipmapLinear
    ? 'nearest'
    : 'linear';
}

/**
 * Maps a mip-sampling filter onto `GPUMipmapFilterMode`.
 *
 * @param filter Renderer-agnostic filter.
 */
export function toGPUMipmapFilterMode(filter: TextureFilter): string {
  return filter === TextureFilter.NearestMipmapLinear || filter === TextureFilter.LinearMipmapLinear
    ? 'linear'
    : 'nearest';
}

/**
 * Maps a clear-bit mask onto the load operation of a colour/depth attachment.
 *
 * @param flags Frame clear mask.
 * @param bit Bit to test.
 * @returns `'clear'` when the bit is set, `'load'` otherwise.
 */
export function toGPULoadOp(flags: ClearFlags, bit: ClearFlags): string {
  return (flags & bit) !== 0 ? 'clear' : 'load';
}

/**
 * Chooses the store operation of an attachment.
 *
 * @param readBack `true` when the attachment's contents are needed after the pass
 *   (a later pass samples it, or the caller reads it back).
 * @returns `'store'` or `'discard'`.
 */
export function toGPUStoreOp(readBack: boolean): string {
  return readBack ? 'store' : 'discard';
}

/**
 * Maps a typed array onto a `GPUIndexFormat`.
 *
 * @param array Index array, or an explicit bytes-per-index number.
 */
export function toGPUIndexFormat(array: ArrayLike<number> | number): string {
  if (typeof array === 'number') return array >= 4 ? 'uint32' : 'uint16';
  const name = (array as { constructor?: { name?: string } }).constructor?.name ?? '';
  return name === 'Uint32Array' || name === 'Int32Array' ? 'uint32' : 'uint16';
}

/**
 * Maps shader stage names onto a `GPUShaderStage` visibility mask.
 *
 * @param stages Stage names to include.
 */
export function toShaderStageVisibility(stages: readonly ('vertex' | 'fragment' | 'compute')[]): number {
  let visibility = 0;
  for (const stage of stages) {
    if (stage === 'vertex') visibility |= GPUShaderStage.VERTEX;
    else if (stage === 'fragment') visibility |= GPUShaderStage.FRAGMENT;
    else if (stage === 'compute') visibility |= GPUShaderStage.COMPUTE;
  }
  return visibility;
}

/* -------------------------------------------------------------------------- */
/* Vertex layout builders                                                     */
/* -------------------------------------------------------------------------- */

/** `GPUVertexFormat` names indexed by component count and component kind. */
export type GPUVertexComponentKind = 'float' | 'sint' | 'uint' | 'unorm' | 'snorm';

/**
 * Builds a `GPUVertexFormat` name.
 *
 * WebGPU only defines a specific list of formats, so the size is snapped to the
 * nearest legal one: 8- and 16-bit components exist as 2- or 4-wide vectors only
 * (there is no `unorm8` or `float16x3`), and 32-bit components exist as 1- to
 * 4-wide vectors. `unorm`/`snorm` have no 32-bit form at all, so such a request
 * degrades to `float` and is recorded at debug level.
 *
 * @param components Components per vertex (1..4).
 * @param kind Component kind.
 * @param bits Component width in bits; defaults to `32`.
 */
export function toGPUVertexFormat(
  components: number,
  kind: GPUVertexComponentKind = 'float',
  bits: 8 | 16 | 32 = 32,
): string {
  const size = Math.max(1, Math.min(4, Math.floor(components)));

  if (kind === 'float') {
    if (bits === 16) return size <= 2 ? 'float16x2' : 'float16x4';
    return `float32x${size}`;
  }

  if (bits === 32) {
    if (kind === 'sint') return `sint32x${size}`;
    if (kind === 'uint') return `uint32x${size}`;
    log.debug(
      `WebGPU has no 32-bit ${kind} vertex format; using float32x${size} instead. ` +
        'Store the values as 8/16-bit integers, or normalise them on the CPU.',
    );
    return `float32x${size}`;
  }

  const width = bits === 8 ? '8' : '16';
  const suffix = size <= 2 ? '2' : '4';
  return `${kind}${width}x${suffix}`;
}

/** Structural description of one vertex attribute, for layout building. */
export interface AttributeLayoutDescriptor {
  /** Attribute name as written in the shader. */
  readonly name: string;
  /** `@location(n)` the shader declared. */
  readonly shaderLocation: number;
  /** Components per vertex (1..4). */
  readonly itemSize: number;
  /** Bytes between consecutive elements of the same attribute. */
  readonly arrayStride: number;
  /** Byte offset of the attribute inside the buffer. */
  readonly offset?: number;
  /** `> 0` marks the attribute as per-instance. */
  readonly instanceDivisor?: number;
  /** `true` for integer components (`uint`/`sint` formats). */
  readonly integer?: boolean;
  /** `true` when integer components are normalised. */
  readonly normalized?: boolean;
  /** Component width in bits; defaults to `32`. */
  readonly bits?: 8 | 16 | 32;
}

/** `GPUVertexBufferLayout` shape produced by {@link buildVertexBufferLayout}. */
export interface GPUVertexBufferLayoutLike {
  /** Bytes between consecutive elements. */
  readonly arrayStride: number;
  /** `'vertex'` or `'instance'`. */
  readonly stepMode: 'vertex' | 'instance';
  /** Attribute descriptors. */
  readonly attributes: readonly {
    readonly shaderLocation: number;
    readonly offset: number;
    readonly format: string;
  }[];
}

/**
 * Builds a `GPUVertexBufferLayout` from structural attribute descriptors.
 *
 * @param attributes Attributes that share one buffer.
 * @param stepMode `'vertex'` (default) or `'instance'`.
 * @returns The layout.
 * @throws Error When the descriptor list is empty or contains a negative location.
 */
export function buildVertexBufferLayout(
  attributes: readonly AttributeLayoutDescriptor[],
  stepMode: 'vertex' | 'instance' = 'vertex',
): GPUVertexBufferLayoutLike {
  if (attributes.length === 0) {
    throw new Error(
      'buildVertexBufferLayout: at least one attribute descriptor is required. Pass the ' +
        'attributes that share the buffer, with their shader locations and strides.',
    );
  }

  let arrayStride = 0;
  const built = attributes.map((attribute) => {
    if (!Number.isInteger(attribute.shaderLocation) || attribute.shaderLocation < 0) {
      throw new Error(
        `buildVertexBufferLayout: attribute '${attribute.name}' has shaderLocation ` +
          `${attribute.shaderLocation}; it must be a non-negative integer.`,
      );
    }
    arrayStride = Math.max(arrayStride, Math.floor(attribute.arrayStride));
    const kind: GPUVertexComponentKind = attribute.integer
      ? 'uint'
      : attribute.normalized === true
        ? 'unorm'
        : 'float';
    return {
      shaderLocation: attribute.shaderLocation,
      offset: Math.max(0, Math.floor(attribute.offset ?? 0)),
      format: toGPUVertexFormat(attribute.itemSize, kind, attribute.bits ?? 32),
    };
  });

  const divisor = attributes.find((attribute) => (attribute.instanceDivisor ?? 0) > 0)?.instanceDivisor ?? 0;
  return {
    arrayStride: Math.max(1, arrayStride),
    stepMode: stepMode === 'instance' || divisor > 0 ? 'instance' : 'vertex',
    attributes: built,
  };
}

/**
 * Builds one `GPUVertexBufferLayout` per buffer.
 *
 * Attributes are grouped by `bufferSlot`, and the group order follows the slot
 * number so the resulting array can be handed to `setVertexBuffer(slot, ...)`
 * without reordering.
 *
 * @param attributes Attribute descriptors, each naming the buffer it belongs to.
 * @returns Layouts ordered by buffer slot.
 */
export function buildVertexBufferLayouts(
  attributes: readonly (AttributeLayoutDescriptor & { readonly bufferSlot?: number })[],
): GPUVertexBufferLayoutLike[] {
  const bySlot = new Map<number, (AttributeLayoutDescriptor & { readonly bufferSlot?: number })[]>();
  for (const attribute of attributes) {
    const slot = Math.max(0, Math.floor(attribute.bufferSlot ?? 0));
    const existing = bySlot.get(slot);
    if (existing === undefined) bySlot.set(slot, [attribute]);
    else existing.push(attribute);
  }

  const slots = [...bySlot.keys()].sort((a, b) => a - b);
  return slots.map((slot) => {
    const group = bySlot.get(slot) ?? [];
    const instanced = group.some((attribute) => (attribute.instanceDivisor ?? 0) > 0);
    return buildVertexBufferLayout(group, instanced ? 'instance' : 'vertex');
  });
}

/**
 * Bytes per vertex implied by a set of attribute descriptors that share one buffer.
 *
 * @param attributes Attributes in the buffer.
 */
export function vertexStrideFor(attributes: readonly AttributeLayoutDescriptor[]): number {
  let stride = 0;
  for (const attribute of attributes) {
    const bits = attribute.bits ?? 32;
    const bytes = attribute.integer || attribute.normalized === true
      ? (bits === 8 ? 4 : bits === 16 ? (attribute.itemSize <= 2 ? 4 : 8) : attribute.itemSize * 4)
      : attribute.itemSize * (bits / 8);
    stride = Math.max(stride, Math.floor(attribute.offset ?? 0) + bytes);
  }
  return Math.max(1, stride);
}
