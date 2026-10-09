/**
 * `Sampler` — a GPU-agnostic sampler description.
 *
 * WebGPU separates the sampler from the texture; WebGL folds it into the texture
 * object. `Sampler` is the common denominator, so a backend can deduplicate
 * sampler state (`equals`/`hash`) and a texture can be detached from the filtering
 * it is sampled with.
 *
 * ```ts
 * const sampler = Sampler.fromTexture(texture);
 * sampler.mipmapFilter;  // MipmapFilter.Linear for a mipmapped texture
 * ```
 *
 * @packageDocumentation
 */

import { hashString } from '../utils/MathUtils';
import { TextureFilter, MipmapFilter, WrapMode } from './types';
import type { Texture } from './Texture';

/** Comparison functions a depth sampler can apply. */
export type SamplerCompare =
  | 'none'
  | 'never'
  | 'less'
  | 'equal'
  | 'less-equal'
  | 'greater'
  | 'not-equal'
  | 'greater-equal'
  | 'always';

/** Serialisable form of a {@link Sampler}. */
export interface SamplerJSON {
  /** Horizontal wrap mode. */
  wrapS: WrapMode;
  /** Vertical wrap mode. */
  wrapT: WrapMode;
  /** Depth wrap mode. */
  wrapR: WrapMode;
  /** Magnification filter. */
  magFilter: TextureFilter;
  /** Minification filter. */
  minFilter: TextureFilter;
  /** Mipmap filter. */
  mipmapFilter: MipmapFilter;
  /** Requested anisotropic filtering level. */
  anisotropy: number;
  /** Depth comparison function. */
  compare: SamplerCompare;
  /** Lowest level-of-detail the sampler may read. */
  lodMinClamp: number;
  /** Highest level-of-detail the sampler may read. */
  lodMaxClamp: number;
  /** Device capability the sampler was clamped against. */
  maxAnisotropy: number;
}

/**
 * Sampling state, independent of any texture.
 */
export class Sampler {
  /** Brand flag that lets other layers identify a sampler without importing it. */
  public readonly isSampler: true = true;

  /** Horizontal wrap mode. */
  public wrapS: WrapMode = WrapMode.ClampToEdge;

  /** Vertical wrap mode. */
  public wrapT: WrapMode = WrapMode.ClampToEdge;

  /** Depth wrap mode, used by 3D/array textures. */
  public wrapR: WrapMode = WrapMode.ClampToEdge;

  /** Magnification filter. */
  public magFilter: TextureFilter = TextureFilter.Linear;

  /** Minification filter. */
  public minFilter: TextureFilter = TextureFilter.Linear;

  /** Mipmap filter; `'none'` disables mip sampling. */
  public mipmapFilter: MipmapFilter = MipmapFilter.None;

  /** Requested anisotropic filtering level; `1` disables it. */
  public anisotropy: number = 1;

  /** Depth comparison function; `'none'` means "not a comparison sampler". */
  public compare: SamplerCompare = 'none';

  /** Lowest level-of-detail the sampler may read. */
  public lodMinClamp: number = 0;

  /** Highest level-of-detail the sampler may read. */
  public lodMaxClamp: number = 32;

  /**
   * Device capability the requested anisotropy is clamped against.
   *
   * Deliberately excluded from {@link equals} and {@link hash}: it describes the
   * device, not the sampling intent, so two samplers with the same intent must
   * compare equal on devices with different limits.
   */
  public maxAnisotropy: number = 16;

  /**
   * @param options Partial sampler state to apply.
   */
  constructor(options: Partial<SamplerJSON> = {}) {
    if (options.wrapS !== undefined) this.wrapS = options.wrapS;
    if (options.wrapT !== undefined) this.wrapT = options.wrapT;
    if (options.wrapR !== undefined) this.wrapR = options.wrapR;
    if (options.magFilter !== undefined) this.magFilter = options.magFilter;
    if (options.minFilter !== undefined) this.minFilter = options.minFilter;
    if (options.mipmapFilter !== undefined) this.mipmapFilter = options.mipmapFilter;
    if (options.anisotropy !== undefined) this.anisotropy = options.anisotropy;
    if (options.compare !== undefined) this.compare = options.compare;
    if (options.lodMinClamp !== undefined) this.lodMinClamp = options.lodMinClamp;
    if (options.lodMaxClamp !== undefined) this.lodMaxClamp = options.lodMaxClamp;
    if (options.maxAnisotropy !== undefined) this.maxAnisotropy = options.maxAnisotropy;
  }

  /**
   * Derives a sampler from a texture's sampling fields.
   *
   * @param texture Texture to read.
   * @param target Optional sampler to write into.
   * @returns The sampler, for chaining.
   */
  public static fromTexture(texture: Texture, target: Sampler = new Sampler()): Sampler {
    target.wrapS = texture.wrapS;
    target.wrapT = texture.wrapT;
    target.wrapR = texture.wrapR;
    target.magFilter = texture.magFilter;
    target.minFilter = baseMinFilter(texture.minFilter);
    target.mipmapFilter = texture.mipmapFilter;
    target.anisotropy = texture.anisotropy;
    return target;
  }

  /** The effective anisotropy: the request clamped by the device limit. */
  public get effectiveAnisotropy(): number {
    return Math.max(1, Math.min(this.anisotropy, this.maxAnisotropy));
  }

  /** `true` when the sampler compares depth values while sampling. */
  public get isComparison(): boolean {
    return this.compare !== 'none' && this.compare !== 'never' && this.compare !== 'always';
  }

  /**
   * Copies another sampler.
   *
   * @param source Sampler to read.
   * @returns This sampler, for chaining.
   */
  public copy(source: Sampler): this {
    this.wrapS = source.wrapS;
    this.wrapT = source.wrapT;
    this.wrapR = source.wrapR;
    this.magFilter = source.magFilter;
    this.minFilter = source.minFilter;
    this.mipmapFilter = source.mipmapFilter;
    this.anisotropy = source.anisotropy;
    this.compare = source.compare;
    this.lodMinClamp = source.lodMinClamp;
    this.lodMaxClamp = source.lodMaxClamp;
    this.maxAnisotropy = source.maxAnisotropy;
    return this;
  }

  /** Independent copy. */
  public clone(): Sampler {
    return new Sampler().copy(this);
  }

  /**
   * Sampling-state equality.
   *
   * Compares every member except `maxAnisotropy` (see that field for why) and
   * uses the *requested* anisotropy rather than the clamped effective value, so a
   * sampler compares equal to itself across devices.
   *
   * @param other Sampler to compare against.
   */
  public equals(other: Sampler | null | undefined): boolean {
    if (other == null) return false;
    if (other === this) return true;
    return (
      this.wrapS === other.wrapS &&
      this.wrapT === other.wrapT &&
      this.wrapR === other.wrapR &&
      this.magFilter === other.magFilter &&
      this.minFilter === other.minFilter &&
      this.mipmapFilter === other.mipmapFilter &&
      this.anisotropy === other.anisotropy &&
      this.compare === other.compare &&
      this.lodMinClamp === other.lodMinClamp &&
      this.lodMaxClamp === other.lodMaxClamp
    );
  }

  /**
   * Stable numeric key for the sampling state.
   *
   * The members are written in a fixed order as their canonical string values and
   * hashed with the library-wide FNV-1a `hashString`, so the same sampler always
   * produces the same key — in any process, on any platform, and independently of
   * object identity or property enumeration order. Floats participate only through
   * their shortest round-trip representation (`String(value)`), which is
   * deterministic for the LOD clamps.
   */
  public hash(): number {
    return hashString(this.toKey());
  }

  /**
   * The canonical string {@link hash} is derived from.
   *
   * Exposed so a backend can use it as a cache key without hashing twice.
   */
  public toKey(): string {
    return [
      this.wrapS,
      this.wrapT,
      this.wrapR,
      this.magFilter,
      this.minFilter,
      this.mipmapFilter,
      String(this.anisotropy),
      this.compare,
      String(this.lodMinClamp),
      String(this.lodMaxClamp),
    ].join('|');
  }

  /** Serialises the sampler, including the device capability. */
  public toJSON(): SamplerJSON {
    return {
      wrapS: this.wrapS,
      wrapT: this.wrapT,
      wrapR: this.wrapR,
      magFilter: this.magFilter,
      minFilter: this.minFilter,
      mipmapFilter: this.mipmapFilter,
      anisotropy: this.anisotropy,
      compare: this.compare,
      lodMinClamp: this.lodMinClamp,
      lodMaxClamp: this.lodMaxClamp,
      maxAnisotropy: this.maxAnisotropy,
    };
  }
}

/** The minification filter without its mipmap component. */
function baseMinFilter(filter: TextureFilter): TextureFilter {
  switch (filter) {
    case TextureFilter.NearestMipmapNearest:
    case TextureFilter.NearestMipmapLinear:
      return TextureFilter.Nearest;
    case TextureFilter.LinearMipmapNearest:
    case TextureFilter.LinearMipmapLinear:
      return TextureFilter.Linear;
    default:
      return filter;
  }
}
