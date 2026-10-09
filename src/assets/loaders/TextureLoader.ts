/**
 * `TextureLoader` — an image plus the sampler state a renderer needs.
 *
 * The result is a **structurally typed** texture rather than an instance from
 * `src/textures`. That is deliberate: this module must not import the material or
 * texture subsystems (another agent owns them, and a cyclic dependency would make the
 * asset layer impossible to test in isolation). The real `Texture` class satisfies
 * {@link TextureLike}, so `AssetManager` results drop straight into a material.
 *
 * ```ts
 * const texture = await new TextureLoader().loadAsync('brick.png');
 * texture.image;        // the decoded bitmap
 * texture.flipY;        // sampler state the caller asked for
 * texture.dispose();    // the caller releases it
 * ```
 *
 * ## Colour space
 *
 * `colorSpace` is carried as a plain string (`'srgb'` by default) because the
 * concrete enum lives in the texture module. A renderer that wants linear data
 * should flip it, and a data texture (normal map, roughness map) should be loaded
 * with `colorSpace: 'linear-srgb'`.
 *
 * @packageDocumentation
 */

import { ImageLoader, type ImageLoadOptions } from './ImageLoader';
import type { ImageLike, TextureLike } from '../types';

/** Wrap modes accepted by {@link TextureLoader}. */
export type TextureWrapMode = 'repeat' | 'clamp' | 'mirror';

/** Filter modes accepted by {@link TextureLoader}. */
export type TextureFilterMode = 'nearest' | 'linear' | 'nearest-mipmap-nearest' | 'linear-mipmap-linear';

/** Options accepted by {@link TextureLoader.loadAsync}. */
export interface TextureLoadOptions extends ImageLoadOptions {
  /** Flips the V axis on upload; defaults to `true` (the WebGL convention). */
  flipY?: boolean;
  /** Wrap behaviour on both axes; defaults to `'repeat'`. */
  wrap?: TextureWrapMode;
  /** Minification filter; defaults to `'linear'`. */
  minFilter?: TextureFilterMode;
  /** Magnification filter; defaults to `'linear'`. */
  magFilter?: TextureFilterMode;
  /** Mip chain generation. */
  generateMipmaps?: boolean;
  /** Anisotropy hint. */
  anisotropy?: number;
  /** Colour space tag; defaults to `'srgb'`. */
  colorSpace?: string;
  /** Texture name; defaults to the URL's base name. */
  name?: string;
}

/**
 * A texture-shaped result produced by {@link TextureLoader}.
 *
 * Every field is optional-tolerant so it can be handed to a renderer that only reads
 * some of them. `dispose` is a plain method, matching `Disposable`'s public contract
 * without inheriting from it (the texture subsystem owns the real class).
 */
export interface LoadedTexture extends TextureLike {
  /** Decoded bitmap. */
  image: ImageLike;
  /** Alias of `image`, matching the DOM convention. */
  source: ImageLike;
  /** Width in texels, when the bitmap reports one. */
  width: number;
  /** Height in texels, when the bitmap reports one. */
  height: number;
  /** `true` until the renderer uploads the bytes. */
  needsUpdate: boolean;
  /** V-axis flip flag. */
  flipY: boolean;
  /** Wrap behaviour on both axes. */
  wrap: TextureWrapMode;
  /** Minification filter. */
  minFilter: TextureFilterMode;
  /** Magnification filter. */
  magFilter: TextureFilterMode;
  /** Mip chain generation. */
  generateMipmaps: boolean;
  /** Anisotropy hint. */
  anisotropy: number;
  /** Colour space tag. */
  colorSpace: string;
  /** Texture name. */
  name: string;
  /** `true` once {@link LoadedTexture.dispose} has run. */
  readonly isDisposed: boolean;
  /** Releases the decoded bitmap and marks the texture unusable. */
  dispose(): void;
}

/**
 * Loads images and wraps them in texture-shaped objects.
 */
export class TextureLoader extends ImageLoader {
  /** Default V-axis flip for subsequent loads. */
  public flipY = true;

  /** Default wrap mode for subsequent loads. */
  public wrap: TextureWrapMode = 'repeat';

  /** Default minification filter. */
  public minFilter: TextureFilterMode = 'linear';

  /** Default magnification filter. */
  public magFilter: TextureFilterMode = 'linear';

  /** Default mip behaviour. */
  public generateMipmaps = false;

  /** Default anisotropy hint. */
  public anisotropy = 1;

  /** Default colour space. */
  public colorSpace = 'srgb';

  /** Number of textures this loader has produced. */
  public textureCount = 0;

  /**
   * Creates a texture loader.
   *
   * @param options Sampler state and transport overrides.
   */
  constructor(options: TextureLoadOptions = {}) {
    super(options);
    this.flipY = options.flipY ?? true;
    this.wrap = options.wrap ?? 'repeat';
    this.minFilter = options.minFilter ?? 'linear';
    this.magFilter = options.magFilter ?? 'linear';
    this.generateMipmaps = options.generateMipmaps ?? false;
    this.anisotropy = options.anisotropy ?? 1;
    this.colorSpace = options.colorSpace ?? 'srgb';
  }

  /**
   * @inheritdoc
   *
   * Decodes the bitmap, then wraps it in a {@link LoadedTexture}.
   */
  public override async parse(
    source: ArrayBuffer,
    url?: string,
    options?: TextureLoadOptions,
  ): Promise<LoadedTexture> {
    const image = await super.parse(source, url, options);
    const texture = this.createTexture(image, url ?? '<bytes>', options ?? {});
    this.textureCount++;
    return texture;
  }

  /**
   * Wraps an already-decoded bitmap.
   *
   * The entry point for `AssetManager(value => ...)` short-circuits and for callers
   * that decode their own bitmaps (a sprite atlas, a canvas snapshot).
   *
   * @param image Decoded bitmap.
   * @param name Texture name; defaults to `'<image>'`.
   * @param options Sampler overrides.
   * @returns A texture-shaped object.
   */
  public createTexture(
    image: ImageLike,
    name = '<image>',
    options: TextureLoadOptions = {},
  ): LoadedTexture {
    const width = image.width ?? image.naturalWidth ?? 0;
    const height = image.height ?? image.naturalHeight ?? 0;

    let disposed = false;
    const self = this;

    const texture: LoadedTexture = {
      image,
      source: image,
      width,
      height,
      needsUpdate: true,
      flipY: options.flipY ?? this.flipY,
      wrap: options.wrap ?? this.wrap,
      minFilter: options.minFilter ?? this.minFilter,
      magFilter: options.magFilter ?? this.magFilter,
      generateMipmaps: options.generateMipmaps ?? this.generateMipmaps,
      anisotropy: options.anisotropy ?? this.anisotropy,
      colorSpace: options.colorSpace ?? this.colorSpace,
      name: options.name ?? name,
      get isDisposed(): boolean {
        return disposed;
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        self.release(image);
        self.textureCount = Math.max(0, self.textureCount - 1);
      },
    };

    return texture;
  }

  /**
   * `true` when a value satisfies the minimum {@link LoadedTexture} shape.
   *
   * @param value Candidate value.
   * @returns `true` when the value is usable as a texture.
   */
  public static isTexture(value: unknown): value is LoadedTexture {
    if (value == null || typeof value !== 'object') return false;
    const candidate = value as Partial<LoadedTexture>;
    return candidate.image !== undefined && typeof candidate.dispose === 'function';
  }
}

/**
 * Convenience factory mirroring `new TextureLoader(options)`.
 *
 * @param options Sampler state and transport overrides.
 * @returns A new texture loader.
 */
export function textureLoader(options: TextureLoadOptions = {}): TextureLoader {
  return new TextureLoader(options);
}
