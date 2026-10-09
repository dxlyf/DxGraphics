/**
 * `DepthTexture` — a depth (or depth/stencil) attachment that can be sampled.
 *
 * Depth data is never filtered, so the class pins nearest filtering, disables
 * mipmaps and flipping, and exposes the comparison function the backend should
 * configure on its sampler.
 *
 * ```ts
 * const shadowMap = new DepthTexture(1024, 1024);
 * shadowMap.compareFunction;     // 'less-equal'
 * shadowMap.format;              // TextureFormat.DepthFormat
 * ```
 *
 * @packageDocumentation
 */

import { PixelFormat } from './formats/PixelFormat';
import { TextureFormat } from './formats/TextureFormat';
import { TextureFilter, type TextureSource } from './types';
import { Texture } from './Texture';

/**
 * Comparison functions a depth sampler can apply.
 *
 * Kept as a local string union rather than importing the renderer's
 * `CompareFunction`, so the texture layer stays independent of the renderer.
 */
export type DepthCompareFunction =
  | 'never'
  | 'less'
  | 'equal'
  | 'less-equal'
  | 'greater'
  | 'not-equal'
  | 'greater-equal'
  | 'always';

/**
 * A sampleable depth buffer.
 */
export class DepthTexture extends Texture<'DepthTexture'> {
  /** Human-readable label used in diagnostics. */
  public override readonly label = 'DepthTexture' as const;

  /** Width in texels. */
  public width: number;

  /** Height in texels. */
  public height: number;

  /** Comparison applied when the depth texture is sampled. */
  public compareFunction: DepthCompareFunction = 'less-equal';

  /** `true` when a stencil component is allocated alongside depth. */
  public readonly hasStencil: boolean;

  /**
   * @param width Width in texels.
   * @param height Height in texels.
   * @param type Element type; `UnsignedInt248` requests a stencil component.
   */
  constructor(
    width: number = 1,
    height: number = 1,
    type: PixelFormat = PixelFormat.UnsignedInt,
  ) {
    super(null);
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.type = type;
    this.hasStencil = type === PixelFormat.UnsignedInt248;
    this.format = this.hasStencil ? TextureFormat.DepthStencilFormat : TextureFormat.DepthFormat;
    this.magFilter = TextureFilter.Nearest;
    this.minFilter = TextureFilter.Nearest;
    this.generateMipmaps = false;
    this.flipY = false;
    this.unpackAlignment = 4;
    this.colorSpace = 'none';
    this.image = this.createDescriptor();
    this.source = this.image;
  }

  /**
   * Reallocates the depth buffer.
   *
   * @param width New width in texels.
   * @param height New height in texels.
   * @returns This texture, for chaining.
   */
  public resize(width: number, height: number): this {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.image = this.createDescriptor();
    this.source = this.image;
    return this.markNeedsUpdate();
  }

  /**
   * Sets the sampler comparison function.
   *
   * @param compareFunction Comparison to apply.
   * @returns This texture, for chaining.
   */
  public setCompareFunction(compareFunction: DepthCompareFunction): this {
    if (compareFunction === this.compareFunction) return this;
    this.compareFunction = compareFunction;
    return this.markNeedsUpdate();
  }

  /** `true` when the comparison function makes the sampler a shadow sampler. */
  public get isShadowSampler(): boolean {
    return this.compareFunction !== 'never' && this.compareFunction !== 'always';
  }

  /** A depth texture is ready as soon as it is allocated. */
  public override isReady(): boolean {
    return !this.isDisposed && this.width > 0 && this.height > 0;
  }

  /** Copies the depth configuration of another depth texture. */
  public override copy(source: Texture): this {
    super.copy(source);
    if (source instanceof DepthTexture) {
      this.width = source.width;
      this.height = source.height;
      this.compareFunction = source.compareFunction;
      this.image = this.createDescriptor();
      this.source = this.image;
    }
    return this;
  }

  /** Independent copy with the same dimensions and comparison function. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }

  /**
   * The `{ data, width, height }` descriptor the backends allocate from.
   *
   * The CPU buffer is intentionally empty: a depth attachment lives on the GPU
   * (or, for the CPU backends, in a composited buffer), so allocating
   * `width * height * 4` bytes here would only waste memory. {@link isReady}
   * therefore does not consult the buffer.
   */
  private createDescriptor(): TextureSource {
    return {
      data: new Uint8Array(0),
      width: this.width,
      height: this.height,
    };
  }
}
