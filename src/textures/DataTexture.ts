/**
 * `DataTexture` — a texture uploaded from a typed array.
 *
 * Raw texel data has no encoder to invert, so the defaults differ from
 * {@link Texture}: `flipY` is off, `unpackAlignment` is `1` (rows are rarely a
 * multiple of four bytes) and no mipmap chain is generated unless asked for.
 *
 * ```ts
 * const rgba = new Uint8Array([255, 0, 0, 255]);
 * const texture = new DataTexture(rgba, 1, 1);
 * texture.isReady(); // true
 * ```
 *
 * @packageDocumentation
 */

import { Texture } from './Texture';
import { PixelFormat } from './formats/PixelFormat';
import { TextureFormat } from './formats/TextureFormat';
import { TextureFilter, type DataTextureSource } from './types';

/**
 * A texture backed by CPU texel data.
 *
 * The `image` member is kept in the `{ data, width, height }` shape the backends
 * upload from, which is why {@link data} is a convenience view onto it.
 */
export class DataTexture extends Texture<'DataTexture'> {
  /** Human-readable label used in diagnostics. */
  public override readonly label = 'DataTexture' as const;

  /** Width in texels. */
  public width: number;

  /** Height in texels. */
  public height: number;

  /**
   * @param data Texel data, row-major from the top-left corner.
   * @param width Width in texels.
   * @param height Height in texels.
   * @param format Channel layout; defaults to `RGBAFormat`.
   * @param type Element type; defaults to `UnsignedByte`.
   */
  constructor(
    data: ArrayBufferView | null = null,
    width: number = 1,
    height: number = 1,
    format: TextureFormat = TextureFormat.RGBAFormat,
    type: PixelFormat = PixelFormat.UnsignedByte,
  ) {
    super(null);
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.format = format;
    this.type = type;
    // Integer texels must never be interpolated, so the default filter depends
    // on the element type.
    const integerTexels =
      type === PixelFormat.UnsignedByte ||
      type === PixelFormat.Byte ||
      type === PixelFormat.UnsignedShort ||
      type === PixelFormat.Short ||
      type === PixelFormat.UnsignedInt ||
      type === PixelFormat.Int;
    this.magFilter = integerTexels ? TextureFilter.Nearest : TextureFilter.Linear;
    this.minFilter = this.magFilter;
    this.generateMipmaps = false;
    this.flipY = false;
    this.unpackAlignment = 1;
    if (data !== null) this.setData(data);
  }

  /** Current texel data, or `null` when none was assigned. */
  public get data(): ArrayBufferView | null {
    const source = this.image as DataTextureSource | null;
    return source ? source.data : null;
  }

  /**
   * Replaces the texel data.
   *
   * @param data New texel data.
   * @param mipLevel Destination level; only level `0` is supported here.
   * @returns This texture, for chaining.
   * @throws Error when a level other than `0` is requested.
   */
  public setData(data: ArrayBufferView, mipLevel: number = 0): this {
    if (mipLevel !== 0) {
      throw new Error('DataTexture only stores mip level 0; use CompressedTexture for mip chains');
    }
    this.setImage({ data, width: this.width, height: this.height });
    return this;
  }

  /**
   * Reallocates the texture.
   *
   * @param width New width in texels.
   * @param height New height in texels.
   * @param data Optional replacement data.
   * @returns This texture, for chaining.
   */
  public setSize(width: number, height: number, data?: ArrayBufferView): this {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    const next = data ?? this.data;
    if (next) this.setData(next);
    else this.markNeedsUpdate();
    return this;
  }

  /** Copies the geometry and the data of another data texture. */
  public override copy(source: Texture): this {
    super.copy(source);
    if (source instanceof DataTexture) {
      this.width = source.width;
      this.height = source.height;
    }
    const raw = source.image as DataTextureSource | null;
    if (raw && raw.data) {
      this.setImage({ data: raw.data, width: this.width, height: this.height });
    }
    return this;
  }

  /**
   * Independent copy of this texture.
   *
   * The texel buffer is shared by reference, matching `Texture.copy`: clone the
   * buffer explicitly when the copy must be writable in isolation.
   */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }

  /** `true` when the buffer holds at least one byte per texel. */
  public hasExpectedByteLength(): boolean {
    const data = this.data;
    if (!data) return false;
    return data.byteLength >= this.width * this.height;
  }
}
