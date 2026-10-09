/**
 * WebGPU render target.
 *
 * Extends the backend-agnostic {@link RenderTarget}, which owns sizing, mipmap
 * counting, attachment slots and disposal semantics.
 *
 * ## MSAA is per-attachment
 *
 * Unlike WebGL, WebGPU declares the sample count on the *texture*, not on a
 * framebuffer object, and the resolve happens inside the render pass through a
 * `resolveTarget` on the colour attachment. A multisampled target therefore keeps two
 * sets of textures: the multisampled ones that receive the draws, and the
 * single-sampled ones the pass resolves into. {@link WebGPURenderTarget.createRenderPassDescriptor}
 * wires that up.
 *
 * ## Readback
 *
 * WebGPU readback requires a buffer mapping and is therefore asynchronous.
 * {@link WebGPURenderTarget.readPixelsFromTarget} (the inherited synchronous hook)
 * returns `null` and {@link WebGPURenderTarget.readPixelsAsync} does the real work.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import type { IRenderTarget } from '../interfaces/IRenderTarget';
import { PixelFormat, TextureFilter, TextureWrap, type ClearOptions, type RenderTargetOptions } from '../interfaces/types';
import { RenderTarget, type ResolvedRenderTargetOptions } from '../core/RenderTarget';
import { normalizeColor } from '../utils/colorUtils';
import type { WebGPUDevice } from './WebGPUDevice';
import { SamplerCache, WebGPUTexture } from './WebGPUTexture';
import {
  GPUBufferUsageFlags,
  GPUMapMode,
  bytesPerRowAlignment,
  isDepthGPUTextureFormat,
  toGPUTextureFormat,
  type GPUBufferLike,
  type GPUDeviceLike,
  type GPUTextureViewLike,
} from './WebGPUUtils';

/** Logger for render-target diagnostics. */
const log = createLogger('renderer:webgpu:target');

/** Plumbing a render target needs. */
export interface WebGPURenderTargetContext {
  /** Device to allocate on. */
  device: GPUDeviceLike;
  /** Device wrapper, used for deferred destruction and readback. */
  wrapper?: WebGPUDevice | null;
  /** Capability report, used to clamp sample counts and sizes. */
  capabilities?: { clampSamples(samples: number): number; clampTextureSize(size: number): number } | null;
  /** Shared sampler cache. */
  samplers?: SamplerCache | null;
  /** Context generation the target was created in. */
  generation?: number;
}

/** One colour attachment of a render pass. */
export interface ColorAttachmentDescriptor {
  /** View the pass renders into. */
  readonly view: GPUTextureViewLike;
  /** View the multisampled result is resolved into. */
  readonly resolveTarget?: GPUTextureViewLike;
  /** `'clear'` or `'load'`. */
  readonly loadOp: string;
  /** `'store'` or `'discard'`. */
  readonly storeOp: string;
  /** Value used when `loadOp` is `'clear'`. */
  readonly clearValue?: { r: number; g: number; b: number; a: number };
}

/** Depth/stencil attachment of a render pass. */
export interface DepthStencilAttachmentDescriptor {
  /** View the pass renders depth into. */
  readonly view: GPUTextureViewLike;
  /** `'clear'` or `'load'`. */
  readonly depthLoadOp: string;
  /** `'store'` or `'discard'`. */
  readonly depthStoreOp: string;
  /** Depth value used when `depthLoadOp` is `'clear'`. */
  readonly depthClearValue: number;
  /** Stencil load operation, for a depth/stencil format. */
  readonly stencilLoadOp?: string;
  /** Stencil store operation, for a depth/stencil format. */
  readonly stencilStoreOp?: string;
  /** Stencil value used when `stencilLoadOp` is `'clear'`. */
  readonly stencilClearValue?: number;
}

/** A complete `GPURenderPassDescriptor`-shaped object. */
export interface RenderPassDescriptorLike {
  /** Pass label. */
  readonly label?: string;
  /** Colour attachments, in slot order. */
  readonly colorAttachments: ColorAttachmentDescriptor[];
  /** Depth/stencil attachment, when the target has one. */
  depthStencilAttachment?: DepthStencilAttachmentDescriptor;
}

/**
 * An off-screen colour (plus optional depth) destination.
 *
 * ```ts
 * const target = new WebGPURenderTarget({ width: 1024, height: 1024, samples: 4 }, ctx);
 * const pass = encoder.beginRenderPass(target.createRenderPassDescriptor());
 * ```
 */
export class WebGPURenderTarget extends RenderTarget implements IRenderTarget {
  /** Plumbing the target was created with. */
  private readonly context: WebGPURenderTargetContext;

  /** Multisampled colour textures, when {@link WebGPURenderTarget.isMultisampled}. */
  private readonly multisampledColor: WebGPUTexture[] = [];

  /** Multisampled depth texture, when applicable. */
  private multisampledDepth: WebGPUTexture | null = null;

  /** Sampler cache handed to the attachment textures. */
  private readonly samplers: SamplerCache;

  /** Context generation the attachments were created in. */
  private allocationGeneration: number = 0;

  /**
   * Creates and allocates a render target.
   *
   * @param options Requested dimensions, formats and attachments.
   * @param context Device and capability plumbing.
   */
  constructor(options: RenderTargetOptions, context: WebGPURenderTargetContext) {
    super(options, 'webgpu');
    this.context = context;
    this.samplers = context.samplers ?? new SamplerCache(context.device);
    this.allocationGeneration = context.generation ?? 0;
    this.initialise();
  }

  /* ------------------------------------------------------------------ queries */

  /** `true` when the colour attachments are multisampled. */
  public get isMultisampled(): boolean {
    return this.samples > 1;
  }

  /** Depth (or depth/stencil) format the target was allocated with. */
  public get depthFormat(): PixelFormat {
    return this.getOptions().depthFormat;
  }

  /** Context generation the attachments were created in. */
  public get generation(): number {
    return this.allocationGeneration;
  }

  /**
   * `true` when the target's textures predate the given context generation.
   *
   * @param generation Current context generation.
   */
  public isStale(generation: number): boolean {
    return this.allocationGeneration !== generation;
  }

  /**
   * Views a render pass should render into.
   *
   * @returns The colour attachment views.
   */
  public getRenderViews(): readonly GPUTextureViewLike[] {
    if (this.multisampledColor.length > 0) {
      return this.multisampledColor.map((texture) => texture.createView());
    }
    return this.colorViews();
  }

  /**
   * Views a render pass should resolve into.
   *
   * @returns The resolve views; empty for a single-sampled target.
   */
  public getResolveViews(): readonly GPUTextureViewLike[] {
    if (!this.isMultisampled) return [];
    return this.colorViews();
  }

  /** Depth view a render pass should use. */
  public getDepthView(): GPUTextureViewLike | null {
    const depth = this.multisampledDepth ?? this.depthAttachment;
    return depth instanceof WebGPUTexture ? depth.createView() : null;
  }

  /* ------------------------------------------------------------- pass descriptor */

  /**
   * Builds a `GPURenderPassDescriptor` for this target.
   *
   * @param clearOptions Clear description; defaults to "load everything".
   * @returns The descriptor.
   */
  public createRenderPassDescriptor(clearOptions: ClearOptions | null = null): RenderPassDescriptorLike {
    const flags = clearOptions?.flags ?? 0;
    const clearColor = normalizeColor(clearOptions?.color ?? null);
    const clearsColour = (flags & 1) !== 0 && clearOptions?.color != null;
    const clearsDepth = (flags & 2) !== 0;
    const clearsStencil = (flags & 4) !== 0;

    const renderViews = this.getRenderViews();
    const resolveViews = this.getResolveViews();
    const colorAttachments: ColorAttachmentDescriptor[] = renderViews.map((view, index) => {
      const attachment: ColorAttachmentDescriptor = {
        view,
        loadOp: clearsColour ? 'clear' : 'load',
        storeOp: 'store',
        ...(clearsColour
          ? { clearValue: { r: clearColor.r, g: clearColor.g, b: clearColor.b, a: clearColor.a } }
          : {}),
      };
      const resolve = resolveViews[index];
      if (resolve !== undefined) {
        return {
          view: attachment.view,
          resolveTarget: resolve,
          loadOp: attachment.loadOp,
          storeOp: attachment.storeOp,
          ...(attachment.clearValue === undefined ? {} : { clearValue: attachment.clearValue }),
        };
      }
      return attachment;
    });

    const depthView = this.getDepthView();
    const descriptor: RenderPassDescriptorLike = {
      label: `${this.id}-pass`,
      colorAttachments,
    };

    if (depthView !== null) {
      const format = toGPUTextureFormat(this.depthFormat);
      const withStencil = format.includes('stencil');
      descriptor.depthStencilAttachment = {
        view: depthView,
        depthLoadOp: clearsDepth ? 'clear' : 'load',
        depthStoreOp: 'store',
        depthClearValue: Math.max(0, Math.min(1, clearOptions?.depth ?? 1)),
        ...(withStencil
          ? {
              stencilLoadOp: clearsStencil ? 'clear' : 'load',
              stencilStoreOp: 'store',
              stencilClearValue: Math.max(0, Math.floor(clearOptions?.stencil ?? 0)),
            }
          : {}),
      };
    }

    return descriptor;
  }

  /* ----------------------------------------------------------- RenderTarget hooks */

  /** @inheritdoc */
  protected override createAttachments(options: ResolvedRenderTargetOptions): void {
    const capabilities = this.context.capabilities ?? null;
    const samples = capabilities !== null ? capabilities.clampSamples(options.samples) : Math.max(1, options.samples);
    if (options.samples > 1 && samples === 1) {
      log.warn(
        `WebGPURenderTarget(${this.id}): ${options.samples}x MSAA was requested but the adapter ` +
          'reports no multisample support; falling back to a single-sampled target.',
      );
    }

    const width = capabilities !== null ? capabilities.clampTextureSize(options.width) : options.width;
    const height = capabilities !== null ? capabilities.clampTextureSize(options.height) : options.height;
    const count = Math.max(1, options.colorAttachments);
    const mipmaps = options.mipmaps === true;

    for (let index = 0; index < count; index++) {
      const texture = new WebGPUTexture(
        this.context.device,
        {
          width,
          height,
          format: options.format,
          magFilter: options.filter,
          minFilter: options.filter,
          wrapS: options.wrap,
          wrapT: options.wrap,
          mipmaps,
          samples: 1,
          label: `${this.id}-color${index}`,
        },
        { wrapper: this.context.wrapper ?? null, samplers: this.samplers },
      );
      texture.allocate();
      this.colorAttachments[index] = texture;
    }

    if (options.depth) {
      const depthFormat = resolveWebGPUDepthFormat(options.depthFormat, options.stencil);
      const depthTexture = new WebGPUTexture(
        this.context.device,
        {
          width,
          height,
          format: depthFormat,
          magFilter: TextureFilter.Nearest,
          minFilter: TextureFilter.Nearest,
          wrapS: TextureWrap.ClampToEdge,
          wrapT: TextureWrap.ClampToEdge,
          samples: 1,
          label: `${this.id}-depth`,
        },
        { wrapper: this.context.wrapper ?? null, samplers: this.samplers },
      );
      depthTexture.allocate();
      this.depthAttachment = depthTexture;
    }

    if (samples > 1) {
      for (let index = 0; index < count; index++) {
        const texture = new WebGPUTexture(
          this.context.device,
          {
            width,
            height,
            format: options.format,
            samples,
            label: `${this.id}-msaa${index}`,
          },
          { wrapper: this.context.wrapper ?? null, samplers: this.samplers },
        );
        texture.allocate();
        this.multisampledColor[index] = texture;
      }
      if (this.depthAttachment !== null) {
        this.multisampledDepth = new WebGPUTexture(
          this.context.device,
          {
            width,
            height,
            format: this.depthFormat,
            samples,
            label: `${this.id}-msaa-depth`,
          },
          { wrapper: this.context.wrapper ?? null, samplers: this.samplers },
        );
        this.multisampledDepth.allocate();
      }
    }

    log.debug(`created ${this.toString()} (${samples}x MSAA)`);
  }

  /** @inheritdoc */
  protected override releaseAttachments(): void {
    for (let index = 0; index < this.colorAttachments.length; index++) {
      const texture = this.colorAttachments[index];
      texture?.dispose();
      this.colorAttachments[index] = null;
    }
    this.depthAttachment?.dispose();
    this.depthAttachment = null;

    for (const texture of this.multisampledColor) texture.dispose();
    this.multisampledColor.length = 0;
    this.multisampledDepth?.dispose();
    this.multisampledDepth = null;
  }

  /** @inheritdoc */
  protected override readPixelsFromTarget(
    _x: number,
    _y: number,
    _width: number,
    _height: number,
  ): Uint8ClampedArray | null {
    // WebGPU readback is asynchronous; see `readPixelsAsync`.
    return null;
  }

  /* ----------------------------------------------------------------- readback */

  /**
   * Reads pixels back from the colour attachment.
   *
   * @param wrapper Device wrapper used for the copy and the mapping.
   * @param x Left edge in texels.
   * @param y Top edge in texels.
   * @param width Region width; defaults to the whole attachment.
   * @param height Region height.
   * @returns The pixels, or `null` when readback is not possible.
   */
  public async readPixelsAsync(
    wrapper: WebGPUDevice,
    x: number = 0,
    y: number = 0,
    width?: number,
    height?: number,
  ): Promise<Uint8ClampedArray | null> {
    if (this.isDisposed) return null;

    const texture = this.getColorTexture(0);
    if (!(texture instanceof WebGPUTexture)) return null;

    const regionWidth = Math.max(0, Math.floor(width ?? this.width - x));
    const regionHeight = Math.max(0, Math.floor(height ?? this.height - y));
    if (regionWidth === 0 || regionHeight === 0) return null;

    // Textures the texture layer allocated already have a readback path; reuse it.
    const pixels = await texture.readPixelsAsync(wrapper);
    if (pixels === null) return null;

    if (x === 0 && y === 0 && regionWidth === this.width && regionHeight === this.height) return pixels;

    // Crop the requested region out of the full readback.
    const out = new Uint8ClampedArray(regionWidth * regionHeight * 4);
    for (let row = 0; row < regionHeight; row++) {
      const sourceStart = ((y + row) * this.width + x) * 4;
      out.set(pixels.subarray(sourceStart, sourceStart + regionWidth * 4), row * regionWidth * 4);
    }
    return out;
  }

  /**
   * Copies the colour attachment into a mappable buffer.
   *
   * Provided for callers that want to control the copy themselves (for example to
   * read several frames' worth without mapping per frame).
   *
   * @param wrapper Device wrapper to submit through.
   * @returns The buffer and the aligned `bytesPerRow`, or `null`.
   */
  public createReadbackBuffer(
    wrapper: WebGPUDevice,
  ): { buffer: GPUBufferLike; bytesPerRow: number; byteLength: number } | null {
    const texture = this.getColorTexture(0);
    if (!(texture instanceof WebGPUTexture)) return null;

    const bytesPerRow = bytesPerRowAlignment(this.width * 4);
    const byteLength = bytesPerRow * this.height;
    const buffer = this.context.device.createBuffer({
      label: `${this.id}-readback`,
      size: Math.max(4, byteLength),
      usage: GPUBufferUsageFlags.COPY_DST | GPUBufferUsageFlags.MAP_READ,
    });

    try {
      const encoder = this.context.device.createCommandEncoder({ label: `${this.id}-readback` });
      encoder.copyTextureToBuffer(
        { texture: texture.getHandle(), mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        { buffer, bytesPerRow, rowsPerImage: this.height },
        { width: this.width, height: this.height, depthOrArrayLayers: 1 },
      );
      wrapper.submit([encoder.finish()]);
    } catch (error) {
      log.warn(`WebGPURenderTarget(${this.id}): readback copy failed`, error);
      buffer.destroy();
      return null;
    }

    return { buffer, bytesPerRow, byteLength };
  }

  /**
   * Maps a readback buffer and returns its bytes.
   *
   * @param buffer Buffer created by {@link WebGPURenderTarget.createReadbackBuffer}.
   * @param byteLength Bytes to map.
   * @returns The bytes, or `null`.
   */
  public async mapReadbackBuffer(
    buffer: GPUBufferLike,
    byteLength: number,
  ): Promise<Uint8Array | null> {
    try {
      await buffer.mapAsync(GPUMapMode.READ);
      const copy = new Uint8Array(buffer.getMappedRange().slice(0, byteLength));
      buffer.unmap();
      buffer.destroy();
      return copy;
    } catch (error) {
      log.warn(`WebGPURenderTarget(${this.id}): mapping the readback buffer failed`, error);
      buffer.destroy();
      return null;
    }
  }

  /**
   * Records the context generation the attachments now belong to.
   *
   * @param generation Current context generation.
   */
  public setGeneration(generation: number): void {
    this.allocationGeneration = generation;
  }

  /** @returns The colour attachment views. */
  private colorViews(): GPUTextureViewLike[] {
    const views: GPUTextureViewLike[] = [];
    for (let index = 0; index < this.colorAttachmentCount; index++) {
      const texture = this.getColorTexture(index);
      if (texture instanceof WebGPUTexture) views.push(texture.createView());
    }
    return views;
  }

  /** @returns A human-readable description. */
  public override toString(): string {
    return (
      `WebGPURenderTarget(${this.id}, ${this.width}x${this.height}, format=${this.format}, ` +
      `samples=${this.samples}, depth=${this.depthTexture !== null})`
    );
  }
}

/**
 * Chooses a WebGPU depth format.
 *
 * `depth24plus-stencil8` is the general-purpose choice; a target that never needs
 * stencil gets `depth32float`, which has better precision and no stencil hardware
 * cost.
 *
 * @param requested Caller-requested format.
 * @param stencil Whether a stencil buffer was requested.
 */
export function resolveWebGPUDepthFormat(requested: PixelFormat, stencil: boolean): PixelFormat {
  if (stencil) return PixelFormat.Depth24Stencil8;
  if (requested === PixelFormat.Depth24Stencil8 && !stencil) return PixelFormat.Depth32F;
  return requested;
}

/** `true` when the format can be used as a WebGPU depth attachment. */
export function isWebGPUDepthFormat(format: PixelFormat): boolean {
  return isDepthGPUTextureFormat(toGPUTextureFormat(format));
}
