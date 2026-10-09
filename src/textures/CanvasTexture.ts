/**
 * `CanvasTexture` — a texture uploaded from a canvas, bitmap or video frame.
 *
 * CPU canvases are the usual way to build dynamic textures (painted gradients,
 * generated glyph atlases, `OffscreenCanvas` worklets), so this class keeps the
 * upload defaults the DOM expects: `flipY` on, 4-byte row alignment and a
 * generated mipmap chain.
 *
 * ```ts
 * const canvas = document.createElement('canvas');
 * canvas.width = canvas.height = 256;
 * const texture = new CanvasTexture(canvas);
 * // after repainting:
 * texture.needsUpdate = true;
 * ```
 *
 * @packageDocumentation
 */

import { Texture } from './Texture';
import { Mapping, type TextureSource } from './types';

/**
 * A texture sourced from a drawable surface.
 *
 * `HTMLCanvasElement`, `OffscreenCanvas`, `ImageBitmap`, `ImageData` and
 * `VideoFrame` are all accepted; the backend decides how to upload each of them.
 */
export class CanvasTexture extends Texture<'CanvasTexture'> {
  /** Human-readable label used in diagnostics. */
  public override readonly label = 'CanvasTexture' as const;

  /**
   * @param canvas Source surface.
   * @param mapping Optional sampling-space override.
   */
  constructor(canvas: TextureSource | null = null, mapping?: Mapping) {
    super(canvas, mapping ?? Mapping.UVMapping);
    this.generateMipmaps = true;
    this.flipY = true;
    this.unpackAlignment = 4;
  }

  /**
   * Reports that the surface was repainted.
   *
   * @returns This texture, for chaining.
   */
  public markPainted(): this {
    return this.markNeedsUpdate();
  }

  /** Independent copy with the same surface attached. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }
}
