/**
 * `RenderTargetTexture` — the sampleable view of a render target.
 *
 * Render targets are created by the renderer, not by the texture layer, so this
 * class wraps a plain {@link RenderTargetDescriptor} and exposes the colour or
 * depth attachment as an ordinary `Texture`. That is what makes the usual
 * ping-pong post-processing setup a pure description:
 *
 * ```ts
 * const descriptor = { width: 512, height: 512, depth: true, mipmaps: false };
 * const read = new RenderTargetTexture(descriptor, 'color');
 * const write = new RenderTargetTexture(descriptor, 'color');
 * // swap(read, write) after every pass
 * ```
 *
 * @packageDocumentation
 */

import { PixelFormat } from './formats/PixelFormat';
import { TextureFormat } from './formats/TextureFormat';
import { TextureFilter, WrapMode, type RenderTargetAttachment, type RenderTargetDescriptor, type TextureSource } from './types';
import { DepthTexture } from './DepthTexture';
import { Texture } from './Texture';

/**
 * A texture that samples one attachment of a render target.
 */
export class RenderTargetTexture extends Texture<'RenderTargetTexture'> {
  /** Human-readable label used in diagnostics. */
  public override readonly label = 'RenderTargetTexture' as const;

  /** Description of the render target this texture samples. */
  public descriptor: RenderTargetDescriptor;

  /** Which attachment is sampled. */
  public attachment: RenderTargetAttachment;

  /** Depth view of the target, when the descriptor requests a depth buffer. */
  public depthTexture: DepthTexture | null = null;

  /**
   * @param descriptor Target description; defaults to a 1x1 colour target.
   * @param attachment Attachment to sample.
   */
  constructor(
    descriptor: RenderTargetDescriptor = { width: 1, height: 1 },
    attachment: RenderTargetAttachment = 'color',
  ) {
    super(null);
    this.descriptor = { ...descriptor };
    this.attachment = attachment;
    this.wrapS = WrapMode.ClampToEdge;
    this.wrapT = WrapMode.ClampToEdge;
    this.magFilter = TextureFilter.Linear;
    this.minFilter = TextureFilter.Linear;
    this.generateMipmaps = descriptor.mipmaps ?? false;
    this.flipY = false;
    this.colorSpace = attachment === 'color' ? 'srgb' : 'none';

    if (this.isDepthAttachment) {
      this.format = descriptor.stencil ? TextureFormat.DepthStencilFormat : TextureFormat.DepthFormat;
      this.type = descriptor.stencil ? PixelFormat.UnsignedInt248 : PixelFormat.UnsignedInt;
      this.magFilter = TextureFilter.Nearest;
      this.minFilter = TextureFilter.Nearest;
    } else {
      this.format = descriptor.format ?? TextureFormat.RGBAFormat;
      this.type = descriptor.type ?? PixelFormat.UnsignedByte;
    }

    if (descriptor.depth ?? true) {
      this.depthTexture = new DepthTexture(this.width, this.height, PixelFormat.UnsignedInt248);
      this.addDisposable(this.depthTexture);
    }

    this.refreshImage();
  }

  /** Target width in device pixels. */
  public get width(): number {
    return Math.max(1, Math.floor(this.descriptor.width));
  }

  /** Target height in device pixels. */
  public get height(): number {
    return Math.max(1, Math.floor(this.descriptor.height));
  }

  /** `true` when the sampled attachment is the depth (or depth/stencil) one. */
  public get isDepthAttachment(): boolean {
    return this.attachment !== 'color';
  }

  /** `true` when the caller asked for a multisampled target. */
  public get isMultisampled(): boolean {
    return (this.descriptor.samples ?? 1) > 1;
  }

  /**
   * Resizes the target description.
   *
   * @param width New width in device pixels.
   * @param height New height in device pixels.
   * @returns This texture, for chaining.
   */
  public resize(width: number, height: number): this {
    this.descriptor = { ...this.descriptor, width, height };
    this.depthTexture?.resize(width, height);
    this.refreshImage();
    return this.markNeedsUpdate();
  }

  /**
   * Swaps the attachment this texture samples.
   *
   * @param attachment New attachment.
   * @returns This texture, for chaining.
   */
  public setAttachment(attachment: RenderTargetAttachment): this {
    if (attachment === this.attachment) return this;
    this.attachment = attachment;
    this.colorSpace = attachment === 'color' ? 'srgb' : 'none';
    this.format =
      attachment === 'color'
        ? this.descriptor.format ?? TextureFormat.RGBAFormat
        : this.descriptor.stencil
          ? TextureFormat.DepthStencilFormat
          : TextureFormat.DepthFormat;
    this.refreshImage();
    return this.markNeedsUpdate();
  }

  /** A render target is sampleable as soon as it is described. */
  public override isReady(): boolean {
    return !this.isDisposed && this.width > 0 && this.height > 0 && (this.descriptor.samples ?? 1) === 1;
  }

  /** Copies the descriptor and attachment of another target texture. */
  public override copy(source: Texture): this {
    super.copy(source);
    if (source instanceof RenderTargetTexture) {
      this.descriptor = { ...source.descriptor };
      this.attachment = source.attachment;
      this.depthTexture?.resize(this.width, this.height);
      this.refreshImage();
    }
    return this;
  }

  /** Independent copy sharing the same target description. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }

  /** Keeps `image`/`source` describing the sampled attachment's dimensions. */
  private refreshImage(): void {
    const image: TextureSource = {
      data: new Uint8Array(0),
      width: this.width,
      height: this.height,
    };
    this.image = image;
    this.source = image;
  }
}
