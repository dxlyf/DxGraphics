/**
 * WebGPU texture wrapper.
 *
 * Implements {@link ITexture} and owns the three things WebGPU keeps separate that
 * OpenGL keeps together: the `GPUTexture`, the `GPUTextureView` a bind group needs,
 * and the `GPUSampler` whose state lives outside the texture.
 *
 * ## Sampler caching
 *
 * Sampling state is not part of a WebGPU texture, so every distinct
 * `(magFilter, minFilter, mipmapFilter, wrapS, wrapT)` combination needs its own
 * sampler object. Those combinations are few and highly repetitive across a scene,
 * so they are cached in a process-wide map keyed by the serialised descriptor.
 *
 * ## `bytesPerRow`
 *
 * `copyBufferToTexture` requires the source row length to be a multiple of 256 bytes,
 * which is why a texel upload goes through {@link computeTextureCopyLayout} rather
 * than using `width * bytesPerPixel` directly.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import { createId } from '../../utils/Id';
import type { ITexture } from '../interfaces/ITexture';
import { PixelFormat, TextureFilter, TextureWrap } from '../interfaces/types';
import type { DeferredDestroyQueue, WebGPUDevice } from './WebGPUDevice';
import {
  GPUBufferUsageFlags,
  GPUMapMode,
  GPUTextureUsageFlags,
  bytesPerRowAlignment,
  bytesPerTexelForGPUFormat,
  computeMipLevelCount,
  computeTextureCopyLayout,
  isDepthGPUTextureFormat,
  mipSizeAtLevel,
  toGPUAddressMode,
  toGPUFilterMode,
  toGPUMipmapFilterMode,
  toGPUTextureFormat,
  toGPUTextureUsage,
  type GPUDeviceLike,
  type GPUSamplerLike,
  type GPUTextureLike,
  type GPUTextureViewLike,
} from './WebGPUUtils';

/** Logger for texture diagnostics. */
const log = createLogger('renderer:webgpu:texture');

/* -------------------------------------------------------------------------- */
/* Structural texture resources                                               */
/* -------------------------------------------------------------------------- */

/**
 * Structural view of a texture resource produced by `src/textures/**`.
 *
 * Declared here because that module is written by another layer; the concrete classes
 * satisfy the shape structurally.
 */
export interface TextureResourceLike {
  /** Monotonic version; a change triggers a re-upload. */
  readonly version?: number;
  /** Texel data: a typed array, `ImageData`, or any object exposing `data`. */
  readonly image?: unknown;
  /** Width in texels. */
  readonly width?: number;
  /** Height in texels. */
  readonly height?: number;
  /** Storage format. */
  readonly format?: PixelFormat;
  /** Magnification filter. */
  readonly magFilter?: TextureFilter;
  /** Minification filter. */
  readonly minFilter?: TextureFilter;
  /** Horizontal wrap mode. */
  readonly wrapS?: TextureWrap;
  /** Vertical wrap mode. */
  readonly wrapT?: TextureWrap;
  /** Allocate and generate a mip chain. */
  readonly mipmaps?: boolean;
  /** Releases the resource. */
  dispose(): void;
}

/* -------------------------------------------------------------------------- */
/* Sampler cache                                                              */
/* -------------------------------------------------------------------------- */

/** Serialised sampler state. */
export interface SamplerDescriptorLike {
  /** Magnification filter. */
  readonly magFilter: string;
  /** Minification filter. */
  readonly minFilter: string;
  /** Mip-chain filter. */
  readonly mipmapFilter: string;
  /** Horizontal address mode. */
  readonly addressModeU: string;
  /** Vertical address mode. */
  readonly addressModeV: string;
  /** Maximum anisotropy, when the implementation supports it. */
  readonly maxAnisotropy?: number;
  /** Comparison function for a depth-sampling sampler. */
  readonly compare?: string;
}

/**
 * Per-device sampler cache.
 *
 * Process-wide rather than per-texture because the same handful of sampler
 * descriptors recur across every material in a scene.
 */
export class SamplerCache {
  /** Cached samplers, by serialised descriptor. */
  private readonly samplers: Map<string, GPUSamplerLike> = new Map();

  /** Device samplers are created on. */
  private readonly device: GPUDeviceLike;

  /**
   * Creates a cache.
   *
   * @param device Device to create samplers on.
   */
  constructor(device: GPUDeviceLike) {
    this.device = device;
  }

  /** Number of cached samplers. */
  public get size(): number {
    return this.samplers.size;
  }

  /**
   * Returns the sampler for a descriptor, creating it when absent.
   *
   * @param descriptor Sampler state.
   * @param label Optional label.
   * @returns The sampler.
   */
  public acquire(descriptor: SamplerDescriptorLike, label?: string): GPUSamplerLike {
    const key = samplerKey(descriptor);
    const cached = this.samplers.get(key);
    if (cached !== undefined) return cached;

    const sampler = this.device.createSampler({
      ...(label === undefined ? {} : { label }),
      magFilter: descriptor.magFilter,
      minFilter: descriptor.minFilter,
      mipmapFilter: descriptor.mipmapFilter,
      addressModeU: descriptor.addressModeU,
      addressModeV: descriptor.addressModeV,
      ...(descriptor.maxAnisotropy === undefined ? {} : { maxAnisotropy: descriptor.maxAnisotropy }),
      ...(descriptor.compare === undefined ? {} : { compare: descriptor.compare }),
    });
    this.samplers.set(key, sampler);
    return sampler;
  }

  /** Drops every cached sampler (they are released by the implementation). */
  public clear(): void {
    this.samplers.clear();
  }
}

/** Stable key for a sampler descriptor. */
export function samplerKey(descriptor: SamplerDescriptorLike): string {
  return [
    descriptor.magFilter,
    descriptor.minFilter,
    descriptor.mipmapFilter,
    descriptor.addressModeU,
    descriptor.addressModeV,
    descriptor.maxAnisotropy ?? '',
    descriptor.compare ?? '',
  ].join('|');
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/** Options accepted by {@link WebGPUTexture}. */
export interface WebGPUTextureOptions {
  /** Width in texels. */
  width?: number;
  /** Height in texels. */
  height?: number;
  /** Storage format. Defaults to {@link PixelFormat.RGBA8}. */
  format?: PixelFormat;
  /** Magnification filter. */
  magFilter?: TextureFilter;
  /** Minification filter. */
  minFilter?: TextureFilter;
  /** Horizontal wrap mode. */
  wrapS?: TextureWrap;
  /** Vertical wrap mode. */
  wrapT?: TextureWrap;
  /** Allocate a full mip chain. */
  mipmaps?: boolean;
  /** Sample count for a multisampled attachment; `1` for a sampleable texture. */
  samples?: number;
  /** Extra `GPUTextureUsage` bits. */
  extraUsage?: number;
  /** Human-readable label. */
  label?: string;
}

/** Plumbing a texture needs beyond the device itself. */
export interface WebGPUTextureContext {
  /** Device wrapper, used for the deferred-destroy queue. */
  wrapper?: WebGPUDevice | null;
  /** Deferred-destroy queue override. */
  destroyQueue?: DeferredDestroyQueue | null;
  /** Shared sampler cache; a private one is created when omitted. */
  samplers?: SamplerCache | null;
}

/* -------------------------------------------------------------------------- */
/* WebGPUTexture                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A GPU texture.
 *
 * ```ts
 * const texture = new WebGPUTexture(device, { width: 256, height: 256, label: 'albedo' });
 * texture.setData(pixels);
 * const view = texture.createView();
 * const sampler = texture.getSampler();
 * ```
 */
export class WebGPUTexture implements ITexture {
  /** @inheritdoc */
  public readonly id: string;

  /** @inheritdoc */
  public get width(): number {
    return this.currentWidth;
  }

  /** @inheritdoc */
  public get height(): number {
    return this.currentHeight;
  }

  /** @inheritdoc */
  public get format(): PixelFormat {
    return this.currentFormat;
  }

  /** @inheritdoc */
  public get magFilter(): TextureFilter {
    return this.currentMagFilter;
  }

  /** @inheritdoc */
  public get minFilter(): TextureFilter {
    return this.currentMinFilter;
  }

  /** @inheritdoc */
  public get wrapS(): TextureWrap {
    return this.currentWrapS;
  }

  /** @inheritdoc */
  public get wrapT(): TextureWrap {
    return this.currentWrapT;
  }

  /** @inheritdoc */
  public get mipLevels(): number {
    return this.currentMipLevels;
  }

  /** @inheritdoc */
  public get isReady(): boolean {
    return this.ready;
  }

  /** @inheritdoc */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /** WebGPU format name the texture was allocated with. */
  public get gpuFormat(): string {
    return this.currentGPUFormat;
  }

  /** Sample count the texture was allocated with. */
  public get sampleCount(): number {
    return this.currentSamples;
  }

  /** Device the texture belongs to. */
  private readonly device: GPUDeviceLike;

  /** Deferred-destroy queue, or `null`. */
  private readonly destroyQueue: DeferredDestroyQueue | null;

  /** Sampler cache used by {@link WebGPUTexture.getSampler}. */
  private readonly samplers: SamplerCache;

  /** Label used in diagnostics. */
  private readonly label: string;

  /** Native handle, or `null`. */
  private nativeHandle: GPUTextureLike | null = null;

  /** Default view, created lazily. */
  private defaultView: GPUTextureViewLike | null = null;

  /** Current state. */
  private currentWidth: number;
  private currentHeight: number;
  private currentFormat: PixelFormat;
  private currentGPUFormat: string;
  private currentMagFilter: TextureFilter;
  private currentMinFilter: TextureFilter;
  private currentWrapS: TextureWrap;
  private currentWrapT: TextureWrap;
  private currentMipLevels: number;
  private currentSamples: number;

  /** Combined `GPUTextureUsage` bits. */
  private readonly usageBits: number;

  /** `true` once texels have been uploaded or the texture was allocated empty. */
  private ready: boolean = false;

  /** `true` once the texture has been released. */
  private disposed: boolean = false;

  /** Version of the resource the texels came from. */
  private sourceVersion: number = -1;

  /**
   * Creates a texture.
   *
   * @param device Device to create the texture on.
   * @param options Size, format, filters and usage.
   * @param context Deferred destroy and sampler plumbing.
   */
  constructor(device: GPUDeviceLike, options: WebGPUTextureOptions = {}, context: WebGPUTextureContext = {}) {
    this.device = device;
    this.label = options.label ?? 'texture';
    this.id = `webgpu-texture-${createId()}`;
    this.destroyQueue = context.destroyQueue ?? context.wrapper?.deferredDestroy ?? null;
    this.samplers = context.samplers ?? new SamplerCache(device);

    this.currentWidth = Math.max(1, Math.floor(options.width ?? 1));
    this.currentHeight = Math.max(1, Math.floor(options.height ?? 1));
    this.currentFormat = options.format ?? PixelFormat.RGBA8;
    this.currentGPUFormat = toGPUTextureFormat(this.currentFormat);
    this.currentMagFilter = options.magFilter ?? TextureFilter.Linear;
    this.currentMinFilter = options.minFilter ?? TextureFilter.Linear;
    this.currentWrapS = options.wrapS ?? TextureWrap.ClampToEdge;
    this.currentWrapT = options.wrapT ?? TextureWrap.ClampToEdge;
    this.currentSamples = Math.max(1, Math.floor(options.samples ?? 1));
    this.currentMipLevels = options.mipmaps === true
      ? computeMipLevelCount(this.currentWidth, this.currentHeight)
      : 1;

    this.usageBits =
      toGPUTextureUsage({
        copySrc: true,
        copyDst: true,
        textureBinding: this.currentSamples === 1,
        renderAttachment: true,
      }) | (options.extraUsage ?? 0);
  }

  /* ------------------------------------------------------------------ queries */

  /** Native handle, or `null` once released. */
  public get handle(): GPUTextureLike | null {
    return this.nativeHandle;
  }

  /** `true` when this texture can be sampled (not multisampled). */
  public get isSampleable(): boolean {
    return this.currentSamples === 1 && !isDepthGPUTextureFormat(this.currentGPUFormat);
  }

  /**
   * Returns the native handle, or throws when it has been released.
   *
   * @throws Error When the texture was destroyed.
   */
  public getHandle(): GPUTextureLike {
    if (this.nativeHandle === null) {
      this.nativeHandle = this.createTexture();
    }
    return this.nativeHandle;
  }

  /**
   * Returns the default texture view.
   *
   * @param descriptor Optional view descriptor.
   * @returns The view.
   */
  public createView(descriptor?: unknown): GPUTextureViewLike {
    if (descriptor === undefined && this.defaultView !== null) return this.defaultView;
    const view = this.getHandle().createView(descriptor);
    if (descriptor === undefined) this.defaultView = view;
    return view;
  }

  /**
   * Returns the cached sampler matching this texture's filter/wrap state.
   *
   * @param overrides Sampler state overrides.
   * @returns The sampler.
   */
  public getSampler(overrides: Partial<SamplerDescriptorLike> = {}): GPUSamplerLike {
    return this.samplers.acquire(
      {
        magFilter: overrides.magFilter ?? toGPUFilterMode(this.currentMagFilter),
        minFilter: overrides.minFilter ?? toGPUFilterMode(this.currentMinFilter),
        mipmapFilter: overrides.mipmapFilter ?? toGPUMipmapFilterMode(this.currentMinFilter),
        addressModeU: overrides.addressModeU ?? toGPUAddressMode(this.currentWrapS),
        addressModeV: overrides.addressModeV ?? toGPUAddressMode(this.currentWrapT),
        ...(overrides.maxAnisotropy === undefined ? {} : { maxAnisotropy: overrides.maxAnisotropy }),
        ...(overrides.compare === undefined ? {} : { compare: overrides.compare }),
      },
      `${this.label}-sampler`,
    );
  }

  /* ------------------------------------------------------------------ uploads */

  /**
   * Uploads texel data.
   *
   * @param source Typed array, `ImageData`, resource, or anything exposing `data`.
   * @param mipLevel Destination mip level; defaults to `0`.
   * @returns This texture, for chaining.
   */
  public setData(source: unknown, mipLevel: number = 0): this {
    if (source == null) return this;

    if (isTextureResource(source)) {
      this.applyResource(source);
      return this;
    }

    this.uploadRaw(source, mipLevel);
    return this;
  }

  /**
   * Uploads raw bytes into a mip level.
   *
   * @param source Byte source.
   * @param mipLevel Destination level.
   * @param size Explicit size override, for sources that do not report one.
   */
  public uploadRaw(
    source: unknown,
    mipLevel: number = 0,
    size?: { width: number; height: number },
  ): void {
    const level = Math.max(0, Math.min(this.currentMipLevels - 1, Math.floor(mipLevel)));
    const width = Math.max(1, Math.floor(size?.width ?? this.currentWidth));
    const height = Math.max(1, Math.floor(size?.height ?? this.currentHeight));
    const texels = extractBytes(source);
    if (texels === null) {
      // Nothing uploadable: allocate instead so the texture is at least well-formed.
      this.allocate();
      return;
    }

    const bytesPerTexel = bytesPerTexelForGPUFormat(this.currentGPUFormat) || 4;
    const layout = computeTextureCopyLayout(width, height, bytesPerTexel);
    const texture = this.getHandle();

    // `writeTexture` has no way to express the 256-byte row padding, so the source
    // is repacked into a row-aligned buffer first when the rows are misaligned.
    const repacked =
      layout.bytesPerRow === width * bytesPerTexel ? texels : repackRows(texels, width * bytesPerTexel, layout.bytesPerRow, height);

    try {
      this.device.queue.writeTexture(
        { texture, mipLevel: level, origin: { x: 0, y: 0, z: 0 } },
        repacked,
        { bytesPerRow: layout.bytesPerRow, rowsPerImage: layout.rowsPerImage },
        { width, height, depthOrArrayLayers: 1 },
      );
    } catch (error) {
      log.error(`WebGPUTexture(${this.label}): writeTexture failed`, error);
      return;
    }

    this.ready = true;
  }

  /**
   * Reallocates the texture at a new size, discarding its contents.
   *
   * @param width New width in texels.
   * @param height New height in texels.
   * @returns This texture, for chaining.
   */
  public setSize(width: number, height: number): this {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this.currentWidth && nextHeight === this.currentHeight && this.nativeHandle !== null) {
      return this;
    }

    this.releaseHandle();
    this.currentWidth = nextWidth;
    this.currentHeight = nextHeight;
    if (this.currentMipLevels > 1) {
      this.currentMipLevels = computeMipLevelCount(nextWidth, nextHeight);
    }
    this.ready = false;
    return this;
  }

  /**
   * Allocates an empty texture at the current size.
   *
   * @returns This texture, for chaining.
   */
  public allocate(): this {
    this.getHandle();
    this.ready = true;
    return this;
  }

  /* ------------------------------------------------------------------ sampler */

  /** @inheritdoc */
  public setFilters(min?: TextureFilter, mag?: TextureFilter): void {
    if (min !== undefined) this.currentMinFilter = min;
    if (mag !== undefined) this.currentMagFilter = mag;
  }

  /** @inheritdoc */
  public setWrap(wrapS?: TextureWrap, wrapT?: TextureWrap): void {
    if (wrapS !== undefined) this.currentWrapS = wrapS;
    if (wrapT !== undefined) this.currentWrapT = wrapT;
  }

  /**
   * Generates the mip chain by repeatedly downsampling on the GPU.
   *
   * WebGPU has no `generateMipmap`, so the chain is produced with a series of
   * `copyTextureToTexture`? No —a blit needs a pipeline. This implementation
   * therefore documents the limitation and reports it: mip levels must be uploaded
   * by the texture layer (which owns the downsampling code), and a caller that
   * cannot do that should use a non-mipmapped filter.
   *
   * @returns Always `false`: WebGPU cannot generate mips without a blit pipeline.
   */
  public generateMipmaps(): boolean {
    if (this.currentMipLevels <= 1) return false;
    log.debug(
      `WebGPUTexture(${this.label}): WebGPU has no generateMipmap equivalent. Upload the mip ` +
        'chain yourself (one `setData` per level), or use a non-mipmapped filter.',
    );
    return false;
  }

  /* ----------------------------------------------------------------- readback */

  /**
   * Reads the texture back as RGBA bytes.
   *
   * WebGPU readback is inherently asynchronous (a buffer has to be mapped), so this
   * synchronous method always returns `null`. Use
   * {@link WebGPUTexture.readPixelsAsync} instead.
   *
   * @returns Always `null`.
   */
  public readPixels(): Uint8ClampedArray | null {
    log.debug(
      `WebGPUTexture(${this.label}): synchronous readback is not possible on WebGPU; use ` +
        'readPixelsAsync().',
    );
    return null;
  }

  /**
   * Reads the texture back as RGBA bytes.
   *
   * @param wrapper Device wrapper used for the copy and the mapping.
   * @returns The pixels, or `null` when readback is not possible.
   */
  public async readPixelsAsync(wrapper: WebGPUDevice): Promise<Uint8ClampedArray | null> {
    if (this.disposed || this.nativeHandle === null) return null;
    if (isDepthGPUTextureFormat(this.currentGPUFormat) || this.currentSamples > 1) return null;

    const width = this.currentWidth;
    const height = this.currentHeight;
    const bytesPerRow = bytesPerRowAlignment(width * 4);
    const byteLength = bytesPerRow * height;

    const destination = this.device.createBuffer({
      label: `${this.label}-readback`,
      size: Math.max(4, byteLength),
      usage: GPUBufferUsageFlags.COPY_DST | GPUBufferUsageFlags.MAP_READ,
    });

    try {
      const encoder = this.device.createCommandEncoder({ label: `${this.label}-readback` });
      encoder.copyTextureToBuffer(
        { texture: this.nativeHandle, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        { buffer: destination, bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
      wrapper.submit([encoder.finish()]);

      await destination.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(destination.getMappedRange());
      // Row padding has to be stripped: the caller expects tightly packed RGBA.
      const out = new Uint8ClampedArray(width * height * 4);
      for (let row = 0; row < height; row++) {
        out.set(mapped.subarray(row * bytesPerRow, row * bytesPerRow + width * 4), row * width * 4);
      }
      destination.unmap();
      destination.destroy();
      return out;
    } catch (error) {
      log.warn(`WebGPUTexture(${this.label}): readback failed`, error);
      destination.destroy();
      return null;
    }
  }

  /* ------------------------------------------------------------------ dispose */

  /** @inheritdoc */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseHandle();
    this.defaultView = null;
    this.ready = false;
  }

  /** @returns A human-readable description. */
  public toString(): string {
    return (
      `WebGPUTexture(${this.label}, ${this.currentWidth}x${this.currentHeight}, ` +
      `${this.currentGPUFormat}, mips=${this.currentMipLevels}, samples=${this.currentSamples})`
    );
  }

  /* ---------------------------------------------------------------- internals */

  /** Creates the native texture. */
  private createTexture(): GPUTextureLike {
    if (this.disposed) {
      throw new Error(
        `WebGPUTexture(${this.label}): the texture has been disposed. Create a new one instead of ` +
          'reusing a released handle.',
      );
    }
    const texture = this.device.createTexture({
      label: this.label,
      size: { width: this.currentWidth, height: this.currentHeight, depthOrArrayLayers: 1 },
      format: this.currentGPUFormat,
      mipLevelCount: Math.max(1, this.currentMipLevels),
      sampleCount: Math.max(1, this.currentSamples),
      usage: this.usageBits,
    });
    this.nativeHandle = texture;
    this.defaultView = null;
    return texture;
  }

  /** Releases the native handle through the deferred queue when there is one. */
  private releaseHandle(): void {
    const handle = this.nativeHandle;
    if (handle === null) return;
    this.nativeHandle = null;
    this.defaultView = null;
    if (this.destroyQueue !== null) this.destroyQueue.destroy(handle);
    else handle.destroy();
  }

  /** Applies a texture-layer resource. */
  private applyResource(resource: TextureResourceLike): void {
    const sameVersion = resource.version !== undefined && resource.version === this.sourceVersion && this.ready;

    if (resource.format !== undefined) {
      const nextGPUFormat = toGPUTextureFormat(resource.format);
      if (nextGPUFormat !== this.currentGPUFormat) {
        this.currentFormat = resource.format;
        this.currentGPUFormat = nextGPUFormat;
        this.releaseHandle();
        this.ready = false;
      }
    }

    if (resource.width !== undefined && resource.height !== undefined) {
      const nextWidth = Math.max(1, Math.floor(resource.width));
      const nextHeight = Math.max(1, Math.floor(resource.height));
      if (nextWidth !== this.currentWidth || nextHeight !== this.currentHeight) this.setSize(nextWidth, nextHeight);
    }

    if (resource.magFilter !== undefined) this.currentMagFilter = resource.magFilter;
    if (resource.minFilter !== undefined) this.currentMinFilter = resource.minFilter;
    if (resource.wrapS !== undefined) this.currentWrapS = resource.wrapS;
    if (resource.wrapT !== undefined) this.currentWrapT = resource.wrapT;

    if (sameVersion && this.nativeHandle !== null) return;

    if (resource.mipmaps === true) {
      this.currentMipLevels = computeMipLevelCount(this.currentWidth, this.currentHeight);
    }

    if (resource.image !== undefined && resource.image !== null) {
      this.uploadRaw(resource.image, 0, { width: this.currentWidth, height: this.currentHeight });
    } else {
      this.allocate();
    }

    this.sourceVersion = resource.version ?? -1;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** `true` when the value looks like a texture-layer resource. */
export function isTextureResource(value: unknown): value is TextureResourceLike {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<TextureResourceLike>;
  if (typeof candidate.dispose === 'function') return true;
  return candidate.image !== undefined && (candidate.width !== undefined || candidate.version !== undefined);
}

/**
 * Extracts bytes from any accepted texel source.
 *
 * @param source Typed array, `ImageData`-like object, or plain number array.
 * @returns A byte view, or `null` when the source carries no data.
 */
export function extractBytes(source: unknown): Uint8Array | null {
  if (source == null) return null;
  if (ArrayBuffer.isView(source)) {
    const view = source as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (Array.isArray(source)) {
    const out = new Uint8Array(source.length);
    for (let i = 0; i < source.length; i++) out[i] = Number(source[i]) & 0xff;
    return out;
  }
  if (typeof source === 'object') {
    const data = (source as { data?: unknown }).data;
    if (data !== undefined && data !== null) return extractBytes(data);
  }
  return null;
}

/**
 * Copies rows into a row-aligned buffer.
 *
 * @param source Tightly packed rows.
 * @param sourceRowBytes Bytes per row in the source.
 * @param targetRowBytes Aligned bytes per row.
 * @param rows Number of rows.
 */
export function repackRows(
  source: Uint8Array,
  sourceRowBytes: number,
  targetRowBytes: number,
  rows: number,
): Uint8Array {
  if (sourceRowBytes === targetRowBytes) return source;
  const out = new Uint8Array(targetRowBytes * rows);
  for (let row = 0; row < rows; row++) {
    const start = row * sourceRowBytes;
    out.set(source.subarray(start, start + sourceRowBytes), row * targetRowBytes);
  }
  return out;
}

/**
 * Computes the mip-chain byte length of a texture.
 *
 * @param width Base width in texels.
 * @param height Base height in texels.
 * @param bytesPerTexel Bytes per texel.
 * @param levels Mip levels to include; defaults to the full chain.
 */
export function mipChainByteLength(
  width: number,
  height: number,
  bytesPerTexel: number,
  levels?: number,
): number {
  const available = computeMipLevelCount(width, height);
  const count = Math.max(1, Math.min(levels ?? available, available));
  let total = 0;
  for (let level = 0; level < count; level++) {
    total += mipSizeAtLevel(width, level) * mipSizeAtLevel(height, level) * bytesPerTexel;
  }
  return total;
}

/** `true` when a texture size is a valid WebGPU dimension. */
export function isValidTextureSize(width: number, height: number, maxDimension: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width < 1 || height < 1) return false;
  return width <= maxDimension && height <= maxDimension;
}
