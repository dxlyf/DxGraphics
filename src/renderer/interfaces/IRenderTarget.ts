/**
 * Render-target contract.
 *
 * A render target is an off-screen destination: one colour texture plus an
 * optional depth/stencil texture. `IRenderer.createRenderTarget` returns these
 * and `IRenderer.setRenderTarget` binds them.
 *
 * The interface deliberately avoids exposing backend handles so that a scene can
 * be rendered to a target produced by a different backend instance (for example
 * a WebGL target consumed by a post-processing pass).
 *
 * @packageDocumentation
 */

import type { PixelFormat, RenderTargetOptions } from './types';
import { TextureFilter } from './types';
import type { ITexture } from './ITexture';

/** Dimension-independent description of a render target. */
export interface IRenderTarget {
  /** Stable identifier, useful in logs and cache keys. */
  readonly id: string;

  /** Target width in device pixels. */
  readonly width: number;

  /** Target height in device pixels. */
  readonly height: number;

  /** Primary colour attachment, or `null` for a depth-only target. */
  readonly texture: ITexture | null;

  /** Depth attachment, or `null` when the target has no depth buffer. */
  readonly depthTexture: ITexture | null;

  /** Pixel format of the colour attachment(s). */
  readonly format: PixelFormat;

  /** Samples per pixel; `1` when the target is not multisampled. */
  readonly samples: number;

  /** `true` when the target requests a generated mipmap chain. */
  readonly mipmaps: boolean;

  /** `true` once the backend resources exist. */
  readonly isInitialised: boolean;

  /** `true` when the target has been released. */
  readonly isDisposed: boolean;

  /** @returns The texture bound to `index`, or `null` when out of range. */
  getColorTexture(index?: number): ITexture | null;

  /** @returns The depth(-stencil) attachment, or `null` when absent. */
  getDepthTexture(): ITexture | null;

  /**
   * Resizes the target, reallocating attachments when the size actually changes.
   *
   * @param width New width in device pixels.
   * @param height New height in device pixels.
   */
  setSize(width: number, height: number): void;

  /**
   * Generates the mipmap chain for the colour attachment.
   *
   * A no-op when {@link mipmaps} is `false`.
   */
  generateMipmaps(): void;

  /**
   * Reallocates backend resources after a context loss or a format change.
   *
   * @param options New target options; omitted fields keep their current value.
   */
  reinitialise(options?: Partial<RenderTargetOptions>): void;

  /**
   * Reads pixels back from the colour attachment.
   *
   * Implementations that cannot read back return `null` rather than throwing.
   *
   * @param x Left edge in device pixels.
   * @param y Top edge in device pixels.
   * @param width Region width.
   * @param height Region height.
   * @returns A `Uint8ClampedArray` of RGBA bytes, or `null`.
   */
  readPixels(x?: number, y?: number, width?: number, height?: number): Uint8ClampedArray | null;

  /** Releases every backend resource owned by the target. */
  dispose(): void;
}

/** Options accepted by {@link RenderTargetFactory}. */
export interface RenderTargetFactoryOptions extends Partial<RenderTargetOptions> {
  /** Identifier override; defaults to a generated one. */
  id?: string;
}

/**
 * Structural factory contract implemented by every backend renderer.
 *
 * Declared here (rather than on `IRenderer`) so that helpers such as the
 * post-processing pipeline can depend on target creation alone.
 */
export interface RenderTargetFactory {
  /**
   * Creates an off-screen render target.
   *
   * @param options Target description.
   */
  createRenderTarget(options: RenderTargetOptions): IRenderTarget;

  /**
   * Releases a target previously created by this renderer.
   *
   * @param target Target to release.
   */
  destroyRenderTarget(target: IRenderTarget): void;
}

/** Convenience guard: `true` when `value` looks like an {@link IRenderTarget}. */
export function isRenderTarget(value: unknown): value is IRenderTarget {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<IRenderTarget>;
  return typeof candidate.setSize === 'function' && typeof candidate.dispose === 'function';
}

/** Texture filter helper: `true` when the filter samples the mip chain. */
export function usesMipmaps(filter: TextureFilter): boolean {
  return (
    filter === TextureFilter.NearestMipmapNearest ||
    filter === TextureFilter.LinearMipmapNearest ||
    filter === TextureFilter.NearestMipmapLinear ||
    filter === TextureFilter.LinearMipmapLinear
  );
}
