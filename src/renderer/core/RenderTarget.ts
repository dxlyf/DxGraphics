/**
 * Abstract render target.
 *
 * Owns everything about an off-screen destination that is backend-independent:
 * sizing, mipmap bookkeeping, attachment slots and disposal semantics. Concrete
 * backends implement {@link RenderTarget.createAttachments},
 * {@link RenderTarget.releaseAttachments} and {@link RenderTarget.readPixelsFromTarget}.
 *
 * @packageDocumentation
 */

import { createId } from '../../utils/Id';
import { createLogger } from '../../utils/Logger';
import type { IRenderTarget } from '../interfaces/IRenderTarget';
import type { ITexture } from '../interfaces/ITexture';
import {
  PixelFormat,
  TextureFilter,
  TextureWrap,
  type RenderTargetOptions,
} from '../interfaces/types';
import { computeMipmapCount } from '../utils/textureUtils';

/** Logger shared by every render target. */
const log = createLogger('renderer:target');

/** Internal normalised form of {@link RenderTargetOptions}. */
export interface ResolvedRenderTargetOptions {
  width: number;
  height: number;
  colorAttachments: number;
  depth: boolean;
  depthFormat: PixelFormat;
  stencil: boolean;
  mipmaps: boolean;
  samples: number;
  format: PixelFormat;
  filter: TextureFilter;
  wrap: TextureWrap;
}

/**
 * Base class for every render target.
 *
 * Subclasses only allocate and free resources; sizing, mipmap counting, attachment
 * bookkeeping, readback plumbing and disposal all live here.
 */
export abstract class RenderTarget implements IRenderTarget {
  /** Stable identifier for logs and cache keys. */
  public readonly id: string;

  /** Colour attachments, indexed by slot. */
  protected readonly colorAttachments: (ITexture | null)[] = [];

  /** Depth(-stencil) attachment. */
  protected depthAttachment: ITexture | null = null;

  /** Current width in device pixels. */
  protected currentWidth: number;

  /** Current height in device pixels. */
  protected currentHeight: number;

  /** Colour format of the attachments. */
  protected currentFormat: PixelFormat;

  /** Sample count the attachments were allocated with. */
  protected currentSamples: number;

  /** `true` when a mipmap chain was requested. */
  protected currentMipmaps: boolean;

  /** `true` once {@link RenderTarget.initialise} has allocated resources. */
  protected initialised: boolean = false;

  /** `true` once {@link RenderTarget.dispose} has run. */
  protected disposed: boolean = false;

  /** Short backend name used in messages (`'canvas2d'`, `'webgl2'`, ...). */
  protected readonly backendName: string;

  /** Normalised options the target was created with. */
  protected readonly resolved: ResolvedRenderTargetOptions;

  /**
   * Creates a render target.
   *
   * @param options Requested dimensions and attachments.
   * @param backendName Backend label used in diagnostics.
   */
  protected constructor(options: RenderTargetOptions, backendName: string) {
    const resolved = resolveRenderTargetOptions(options);
    this.id = `${backendName}-target-${createId()}`;
    this.backendName = backendName;
    this.currentWidth = resolved.width;
    this.currentHeight = resolved.height;
    this.currentFormat = resolved.format;
    this.currentSamples = resolved.samples;
    this.currentMipmaps = resolved.mipmaps;
    this.resolved = resolved;

    const attachments = Math.max(1, resolved.colorAttachments);
    for (let i = 0; i < attachments; i++) this.colorAttachments.push(null);
  }

  /* ------------------------------------------------------------------ state */

  /** @inheritdoc */
  public get width(): number {
    return this.currentWidth;
  }

  /** @inheritdoc */
  public get height(): number {
    return this.currentHeight;
  }

  /** @inheritdoc */
  public get texture(): ITexture | null {
    return this.colorAttachments[0] ?? null;
  }

  /** @inheritdoc */
  public get depthTexture(): ITexture | null {
    return this.depthAttachment;
  }

  /** @inheritdoc */
  public get format(): PixelFormat {
    return this.currentFormat;
  }

  /** @inheritdoc */
  public get samples(): number {
    return this.currentSamples;
  }

  /** @inheritdoc */
  public get mipmaps(): boolean {
    return this.currentMipmaps;
  }

  /** @inheritdoc */
  public get isInitialised(): boolean {
    return this.initialised;
  }

  /** @inheritdoc */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /** Number of colour attachment slots. */
  public get colorAttachmentCount(): number {
    return this.colorAttachments.length;
  }

  /** Normalised options, copied so callers cannot mutate internals. */
  public getOptions(): ResolvedRenderTargetOptions {
    return { ...this.resolved };
  }

  /* --------------------------------------------------------------- lifecycle */

  /**
   * Allocates backend resources.
   *
   * Idempotent: calling it twice without an intervening {@link RenderTarget.dispose}
   * is a no-op.
   *
   * @throws Error When the target has already been disposed.
   */
  public initialise(): void {
    if (this.disposed) {
      throw new Error(
        `RenderTarget(${this.id}): cannot initialise a disposed target. Create a new ` +
          `${this.backendName} render target instead.`,
      );
    }
    if (this.initialised) return;

    this.createAttachments(this.resolved);
    this.initialised = true;
    log.debug(`created ${this.backendName} render target`, {
      id: this.id,
      width: this.currentWidth,
      height: this.currentHeight,
      format: this.currentFormat,
    });
  }

  /** @inheritdoc */
  public setSize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this.currentWidth && nextHeight === this.currentHeight) return;

    this.currentWidth = nextWidth;
    this.currentHeight = nextHeight;

    if (!this.initialised || this.disposed) return;

    this.releaseAttachments();
    this.resolved.width = nextWidth;
    this.resolved.height = nextHeight;
    this.createAttachments(this.resolved);
  }

  /** @inheritdoc */
  public generateMipmaps(): void {
    if (!this.currentMipmaps || this.disposed) return;
    for (const attachment of this.colorAttachments) attachment?.generateMipmaps();
    this.depthAttachment?.generateMipmaps();
  }

  /** @inheritdoc */
  public reinitialise(options: Partial<RenderTargetOptions> = {}): void {
    if (this.disposed) {
      throw new Error(`RenderTarget(${this.id}): cannot reinitialise a disposed target.`);
    }

    const merged = resolveRenderTargetOptions({
      width: options.width ?? this.currentWidth,
      height: options.height ?? this.currentHeight,
      colorAttachments: options.colorAttachments ?? this.resolved.colorAttachments,
      depth: options.depth ?? this.resolved.depth,
      depthFormat: options.depthFormat ?? this.resolved.depthFormat,
      stencil: options.stencil ?? this.resolved.stencil,
      mipmaps: options.mipmaps ?? this.resolved.mipmaps,
      samples: options.samples ?? this.resolved.samples,
      format: options.format ?? this.currentFormat,
      filter: options.filter ?? this.resolved.filter,
      wrap: options.wrap ?? this.resolved.wrap,
    });

    if (this.initialised) this.releaseAttachments();

    Object.assign(this.resolved, merged);
    this.currentWidth = merged.width;
    this.currentHeight = merged.height;
    this.currentFormat = merged.format;
    this.currentSamples = merged.samples;
    this.currentMipmaps = merged.mipmaps;

    while (this.colorAttachments.length < Math.max(1, merged.colorAttachments)) {
      this.colorAttachments.push(null);
    }
    this.colorAttachments.length = Math.max(1, merged.colorAttachments);

    this.createAttachments(this.resolved);
    this.initialised = true;
  }

  /* -------------------------------------------------------------- accessors */

  /** @inheritdoc */
  public getColorTexture(index: number = 0): ITexture | null {
    if (index < 0 || index >= this.colorAttachments.length) return null;
    return this.colorAttachments[index] ?? null;
  }

  /** @inheritdoc */
  public getDepthTexture(): ITexture | null {
    return this.depthAttachment;
  }

  /** @inheritdoc */
  public readPixels(x: number = 0, y: number = 0, width?: number, height?: number): Uint8ClampedArray | null {
    if (this.disposed) return null;
    const w = Math.max(0, Math.floor(width ?? this.currentWidth - x));
    const h = Math.max(0, Math.floor(height ?? this.currentHeight - y));
    if (w === 0 || h === 0) return null;
    return this.readPixelsFromTarget(Math.max(0, Math.floor(x)), Math.max(0, Math.floor(y)), w, h);
  }

  /* ----------------------------------------------------------------- dispose */

  /** @inheritdoc */
  public dispose(): void {
    if (this.disposed) return;
    this.releaseAttachments();
    for (let i = 0; i < this.colorAttachments.length; i++) this.colorAttachments[i] = null;
    this.depthAttachment = null;
    this.initialised = false;
    this.disposed = true;
  }

  /** @returns A human-readable description of the target. */
  public toString(): string {
    return (
      `RenderTarget(${this.id}, ${this.currentWidth}x${this.currentHeight}, ` +
      `format=${this.currentFormat}, samples=${this.currentSamples}, mipmaps=${this.currentMipmaps}`
    );
  }

  /* -------------------------------------------------------------- subclass API */

  /**
   * Allocates the colour and depth attachments.
   *
   * Implementations must populate {@link RenderTarget.colorAttachments} and
   * {@link RenderTarget.depthAttachment}.
   *
   * @param options Normalised options describing the allocation.
   */
  protected abstract createAttachments(options: ResolvedRenderTargetOptions): void;

  /**
   * Releases every attachment previously created by {@link RenderTarget.createAttachments}.
   *
   * Implementations must dispose the textures themselves.
   */
  protected abstract releaseAttachments(): void;

  /**
   * Backend-specific readback.
   *
   * @param x Left edge in device pixels.
   * @param y Top edge in device pixels.
   * @param width Region width.
   * @param height Region height.
   * @returns RGBA bytes, or `null` when readback is unsupported.
   */
  protected abstract readPixelsFromTarget(
    x: number,
    y: number,
    width: number,
    height: number,
  ): Uint8ClampedArray | null;

  /**
   * Helper for subclasses: the mipmap chain length implied by the current size.
   *
   * @returns `1` when {@link RenderTarget.mipmaps} is `false`.
   */
  protected getMipLevelCount(): number {
    if (!this.currentMipmaps) return 1;
    return computeMipmapCount(this.currentWidth, this.currentHeight);
  }
}

/**
 * Normalises a partial {@link RenderTargetOptions} into a complete description.
 *
 * @param options Caller-supplied options.
 * @returns A fully populated description with sane minimums.
 */
export function resolveRenderTargetOptions(options: Partial<RenderTargetOptions>): ResolvedRenderTargetOptions {
  const width = Math.max(1, Math.floor(options.width ?? 1));
  const height = Math.max(1, Math.floor(options.height ?? 1));
  return {
    width,
    height,
    colorAttachments: Math.max(1, Math.floor(options.colorAttachments ?? 1)),
    depth: options.depth ?? true,
    depthFormat: options.depthFormat ?? PixelFormat.Depth24Stencil8,
    stencil: options.stencil ?? false,
    mipmaps: options.mipmaps ?? false,
    samples: Math.max(1, Math.floor(options.samples ?? 1)),
    format: options.format ?? PixelFormat.RGBA8,
    filter: options.filter ?? TextureFilter.Linear,
    wrap: options.wrap ?? TextureWrap.ClampToEdge,
  };
}

/**
 * A render target that owns nothing.
 *
 * Used by the 2D backends, which can only draw into a canvas: the target proxies a
 * scratch canvas so that a scene written against `IRenderTarget` still runs
 * unchanged, and reports empty attachment lists.
 */
export class NullRenderTarget extends RenderTarget {
  /**
   * Creates a resource-less render target.
   *
   * @param options Requested dimensions.
   * @param backendName Backend label used in diagnostics.
   */
  constructor(options: RenderTargetOptions, backendName: string = 'null') {
    super(options, backendName);
    this.initialise();
  }

  /** @inheritdoc */
  protected override createAttachments(_options: ResolvedRenderTargetOptions): void {
    // Intentionally empty: this target owns no backend resources.
  }

  /** @inheritdoc */
  protected override releaseAttachments(): void {
    // Intentionally empty: this target owns no backend resources.
  }

  /** @inheritdoc */
  protected override readPixelsFromTarget(
    _x: number,
    _y: number,
    _width: number,
    _height: number,
  ): Uint8ClampedArray | null {
    return null;
  }
}
