/**
 * `Texture` — a sampling resource description.
 *
 * A `Texture` is *data*, not a GPU object: it records the source image, the
 * channel layout, the wrap/filter modes and the UV transform, and a backend turns
 * that into a driver texture. Keeping it backend-neutral is what lets the same
 * `Texture` drive WebGL, WebGPU and the CPU image caches.
 *
 * ```ts
 * const texture = new Texture(image);
 * texture.wrapS = WrapMode.Repeat;
 * texture.repeat.set(2, 2);
 * texture.rotation = Math.PI / 4;
 * texture.updateMatrix();
 * ```
 *
 * ## Change tracking
 *
 * `version` is a monotonic revision. Like `Material`, the concrete fields are
 * plain data properties (no `Proxy`, no per-field setter) so property access
 * stays monomorphic; the renderer compares `version` against the value it last
 * uploaded and re-uploads when it moved. Call {@link Texture.markNeedsUpdate}
 * — or assign `needsUpdate = true` — after mutating a field in place.
 *
 * The UV transform is the one exception: `offset`/`repeat`/`center` notify the
 * texture through `Vec2.onChange` and `rotation`/`matrixAutoUpdate` are
 * accessors, because a stale UV matrix is a silent visual bug rather than a
 * performance issue.
 *
 * ## Events
 *
 * `Disposable.events` is typed to the lifecycle map only (TypeScript generics are
 * invariant, so a subclass cannot widen it). Texture events therefore live on
 * {@link Texture.textureEvents}: `loaded`, `error`, `update` and `dispose`.
 *
 * @packageDocumentation
 */

import { Disposable } from '../core/Disposable';
import { EventEmitter, type EventArgs, type EventName, type EventListener } from '../core/EventEmitter';
import { Mat3 } from '../math/Mat3';
import { Vec2 } from '../math/Vec2';
import { createId } from '../utils/Id';
import { log } from '../utils/Logger';
import { PixelFormat } from './formats/PixelFormat';
import { TextureFormat } from './formats/TextureFormat';
import {
  Mapping,
  MipmapFilter,
  TextureFilter,
  WrapMode,
  type ColorSpaceName,
  type TextureJSON,
  type TextureSource,
} from './types';

/**
 * Events emitted by {@link Texture}.
 *
 * Generic in the texture type so a subclass can declare its own payload type
 * (`Texture<'DataTexture'>`) without the listener arguments losing their
 * specificity.
 */
export interface TextureEvents<TTexture = Texture> {
  /** The texture has been released. */
  dispose: [];
  /** The texture became ready to sample. */
  loaded: [texture: TTexture];
  /** The source could not be uploaded. */
  error: [texture: TTexture, error: Error];
  /** The texture's contents changed and it must be re-uploaded. */
  update: [texture: TTexture, version: number];
}

/** Structural view of an image-like source, used by `getSize`/`isReady`. */
interface ImageLike {
  width?: number;
  height?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  videoWidth?: number;
  videoHeight?: number;
  codedWidth?: number;
  codedHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
  data?: ArrayBufferView;
  complete?: boolean;
  readyState?: number;
  close?: () => void;
}

/**
 * The base sampling resource.
 *
 * @typeParam TLabel Literal label used in disposal errors. Defaults to `string`
 *   so the bare `Texture` type accepts any subclass (`Texture<'DataTexture'>`),
 *   which is what `copy()`, the helpers in `TextureUtils` and the backends need.
 */
export class Texture<TLabel extends string = string> extends Disposable<TLabel> {
  /** Human-readable label used in diagnostics. */
  public override readonly label: TLabel = 'Texture' as TLabel;

  /** Stable identifier, prefixed `tex-`. */
  public override readonly id: string = createId('tex');

  /** Brand flag that lets backends identify a texture without importing it. */
  public readonly isTexture: true = true;

  /** Typed event bus (see the module documentation for why it is not `events`). */
  public readonly textureEvents: EventEmitter<TextureEvents<Texture<TLabel>>> =
    new EventEmitter<TextureEvents<Texture<TLabel>>>();

  /** Optional user name, surfaced in diagnostics and serialisation. */
  public name: string = '';

  /** Level-0 source: an image, canvas, bitmap, video frame or raw texel block. */
  public image: TextureSource | null = null;

  /**
   * Authoritative origin of the texel data.
   *
   * Usually the same object as {@link image}; loaders keep it so a texture can be
   * reloaded, cloned or re-uploaded without the sampling state being touched.
   */
  public source: TextureSource | null = null;

  /** Extra CPU-supplied mip levels (level 1 and up). */
  public readonly mipmaps: TextureSource[] = [];

  /** How the sampler coordinates are interpreted. */
  public mapping: Mapping = Mapping.UVMapping;

  /** Horizontal wrap mode. */
  public wrapS: WrapMode = WrapMode.ClampToEdge;

  /** Vertical wrap mode. */
  public wrapT: WrapMode = WrapMode.ClampToEdge;

  /** Depth wrap mode, used by 3D/array textures. */
  public wrapR: WrapMode = WrapMode.ClampToEdge;

  /** Magnification filter. */
  public magFilter: TextureFilter = TextureFilter.Linear;

  /** Minification filter. */
  public minFilter: TextureFilter = TextureFilter.LinearMipmapLinear;

  /** Requested anisotropic filtering level; `1` disables it. */
  public anisotropy: number = 1;

  /** Channel layout of the texels. */
  public format: TextureFormat = TextureFormat.RGBAFormat;

  /** Driver-specific internal format override, or `null` for the default. */
  public internalFormat: string | null = null;

  /** Element type of the texels. */
  public type: PixelFormat = PixelFormat.UnsignedByte;

  /** UV translation. */
  public readonly offset: Vec2 = new Vec2(0, 0);

  /** UV scale. */
  public readonly repeat: Vec2 = new Vec2(1, 1);

  /** UV rotation origin, in `[0, 1]` UV space. */
  public readonly center: Vec2 = new Vec2(0, 0);

  /** `true` when a mipmap chain should be generated after upload. */
  public generateMipmaps: boolean = true;

  /** `true` when texels are premultiplied by their alpha before upload. */
  public premultiplyAlpha: boolean = false;

  /** Row alignment used while uploading, in bytes (`1`, `2`, `4` or `8`). */
  public unpackAlignment: number = 4;

  /** `true` when rows are flipped during upload. */
  public flipY: boolean = true;

  /** Colour space of the texels. */
  public colorSpace: ColorSpaceName = 'srgb';

  /** UV transform matrix, column-major. */
  public readonly matrix: Mat3 = new Mat3();

  /** Monotonic revision, bumped by every change. */
  private revision: number = 0;

  /** `true` while the matrix must be recomputed. */
  private matrixDirty: boolean = true;

  /** `true` when {@link matrix} is derived from the transform fields. */
  private autoUpdateMatrix: boolean = true;

  /** UV rotation, in radians. */
  private rotationRadians: number = 0;

  /** Set once the source has been uploaded at least once. */
  private loaded: boolean = false;

  /**
   * @param image Optional initial source; equivalent to calling {@link setImage}.
   * @param mapping Optional sampling-space override.
   */
  constructor(image: TextureSource | null = null, mapping?: Mapping) {
    super();
    if (mapping !== undefined) this.mapping = mapping;

    // In-place mutation of the transform vectors must invalidate the matrix.
    this.offset.onChange = () => this.markMatrixDirty();
    this.repeat.onChange = () => this.markMatrixDirty();
    this.center.onChange = () => this.markMatrixDirty();

    if (image !== null) this.setImage(image);
  }

  /* ---------------------------------------------------------------- events */

  /**
   * Registers a listener on the texture bus.
   *
   * @param event Event name.
   * @param listener Listener invoked with the event's argument tuple.
   * @returns An unsubscribe function.
   */
  public onTexture<K extends EventName<TextureEvents<Texture<TLabel>>>>(
    event: K,
    listener: EventListener<EventArgs<TextureEvents<Texture<TLabel>>[K]>>,
  ): () => void {
    return this.textureEvents.on(event, listener);
  }

  /* -------------------------------------------------------------- version */

  /** Current revision; bumped by every change that affects sampling. */
  public get version(): number {
    return this.revision;
  }

  /**
   * Setting this to `true` marks the texture as changed.
   *
   * Reading it always returns `false`, matching the `needsUpdate` flag
   * convention: the value is a one-shot signal, not state.
   */
  public get needsUpdate(): boolean {
    return false;
  }

  public set needsUpdate(value: boolean) {
    if (value) this.markNeedsUpdate();
  }

  /**
   * Marks the texture as changed: bumps {@link version} and emits `update`.
   *
   * @returns This texture, for chaining.
   */
  public markNeedsUpdate(): this {
    this.revision++;
    this.textureEvents.emit('update', this, this.revision);
    return this;
  }

  /* ---------------------------------------------------------------- source */

  /**
   * Replaces the level-0 source.
   *
   * A `DataTextureSource` (an object with a `data` view) also refreshes the
   * sampling metadata the backend needs, so raw texel uploads stay consistent.
   *
   * @param image New source.
   * @returns This texture, for chaining.
   */
  public setImage(image: TextureSource | null): this {
    this.image = image;
    this.source = image;
    if (image !== null && this.isRawSource(image)) {
      const raw = image as { data: ArrayBufferView };
      if (raw.data && raw.data.byteLength === 0) {
        this.setError(new Error(`Texture "${this.name || this.id}" was given an empty data buffer`));
      }
    }
    this.revision++;
    this.textureEvents.emit('update', this, this.revision);
    return this;
  }

  /**
   * Replaces the authoritative source and the level-0 image together.
   *
   * @param source New source.
   * @returns This texture, for chaining.
   */
  public setSource(source: TextureSource | null): this {
    return this.setImage(source);
  }

  /** Marks the source as ready and emits `loaded` (once per version). */
  public markLoaded(): this {
    this.loaded = true;
    this.textureEvents.emit('loaded', this);
    return this;
  }

  /**
   * Reports that the source could not be uploaded.
   *
   * @param error Failure to report.
   * @returns This texture, for chaining.
   */
  public setError(error: Error | string): this {
    const failure = typeof error === 'string' ? new Error(error) : error;
    log.error(`Texture "${this.name || this.id}" failed`, failure);
    this.textureEvents.emit('error', this, failure);
    return this;
  }

  /* ------------------------------------------------------------ readiness */

  /**
   * Dimensions of the source, in texels.
   *
   * @param target Vector to write into; a new one is allocated when omitted.
   * @returns `target` with the width/height, defaulting to `1x1` when the source
   *   cannot be measured.
   */
  public getSize(target: Vec2 = new Vec2()): Vec2 {
    const size = this.resolveSize();
    return target.set(size.width, size.height);
  }

  /** `true` when the texture has usable texel data and can be sampled. */
  public isReady(): boolean {
    if (this.isDisposed) return false;
    const image = this.image as ImageLike | null;
    if (image === null || typeof image !== 'object') return false;

    if (image.data !== undefined) {
      return image.data.byteLength > 0 && this.resolveSize().width > 0;
    }

    // `complete` is on HTMLImageElement: an image that has not decoded yet is not
    // ready even though its width property exists.
    if (typeof image.complete === 'boolean') {
      return image.complete && (image.naturalWidth ?? 0) > 0;
    }
    // `readyState >= 2` (HAVE_CURRENT_DATA) is the smallest state with a frame.
    if (typeof image.readyState === 'number') {
      return image.readyState >= 2 && (image.videoWidth ?? image.displayWidth ?? image.width ?? 0) > 0;
    }

    const size = this.resolveSize();
    return size.width > 0 && size.height > 0;
  }

  /** `true` once the source is ready and was not replaced since. */
  public get isLoaded(): boolean {
    return this.loaded && this.isReady();
  }

  /** `true` when the source is raw texel data rather than a DOM image. */
  public get isRawData(): boolean {
    return this.image !== null && this.isRawSource(this.image);
  }

  /** `true` for a source object carrying a typed-array `data` member. */
  private isRawSource(source: TextureSource): boolean {
    return typeof source === 'object' && source !== null && 'data' in source;
  }

  /** Measures the source, falling back through the DOM's several width fields. */
  private resolveSize(): { width: number; height: number } {
    const image = this.image as ImageLike | null;
    if (image === null || typeof image !== 'object') return { width: 1, height: 1 };

    const width =
      image.naturalWidth ??
      image.videoWidth ??
      image.codedWidth ??
      image.displayWidth ??
      image.width ??
      0;
    const height =
      image.naturalHeight ??
      image.videoHeight ??
      image.codedHeight ??
      image.displayHeight ??
      image.height ??
      0;

    if (width <= 0 || height <= 0) return { width: 1, height: 1 };
    return { width: Math.floor(width), height: Math.floor(height) };
  }

  /* --------------------------------------------------------------- matrix */

  /** UV rotation, in radians. Setting it invalidates {@link matrix}. */
  public get rotation(): number {
    return this.rotationRadians;
  }

  public set rotation(value: number) {
    if (value === this.rotationRadians) return;
    this.rotationRadians = value;
    this.markMatrixDirty();
  }

  /**
   * `true` when {@link matrix} is derived from the transform fields.
   *
   * Setting it back to `true` marks the matrix dirty, so the next
   * {@link getMatrix} catches up with changes made while it was disabled.
   */
  public get matrixAutoUpdate(): boolean {
    return this.autoUpdateMatrix;
  }

  public set matrixAutoUpdate(value: boolean) {
    if (value === this.autoUpdateMatrix) return;
    this.autoUpdateMatrix = value;
    if (value) this.markMatrixDirty();
  }

  /** Flags the UV matrix as stale. */
  public markMatrixDirty(): this {
    this.matrixDirty = true;
    if (this.autoUpdateMatrix) this.updateMatrix();
    return this;
  }

  /**
   * Recomputes {@link matrix} from `offset`, `repeat`, `rotation` and `center`.
   *
   * The composition is `T(center) * T(offset) * R * S * T(-center)`, applied to
   * the UV as `uv' = matrix * vec3(uv, 1)`:
   *
   * ```text
   *   [ sx*cos,  sx*sin,  -sx*( cos*cx + sin*cy) + cx + tx ]
   *   [ -sy*sin, sy*cos,  -sy*(-sin*cx + cos*cy) + cy + ty ]
   *   [ 0,       0,        1                                ]
   * ```
   *
   * @param force When `true`, recompute even if `matrixAutoUpdate` is disabled.
   * @returns {@link matrix}, for chaining.
   */
  public updateMatrix(force: boolean = false): Mat3 {
    if (!force && !this.autoUpdateMatrix) return this.matrix;

    const cos = Math.cos(this.rotationRadians);
    const sin = Math.sin(this.rotationRadians);
    const sx = this.repeat.x;
    const sy = this.repeat.y;
    const cx = this.center.x;
    const cy = this.center.y;

    const tx = -sx * (cos * cx + sin * cy) + cx + this.offset.x;
    const ty = -sy * (-sin * cx + cos * cy) + cy + this.offset.y;

    this.matrix.set(
      cleanZero(sx * cos),
      cleanZero(-sy * sin),
      0,
      cleanZero(sx * sin),
      cleanZero(sy * cos),
      0,
      cleanZero(tx),
      cleanZero(ty),
      1,
    );
    this.matrixDirty = false;
    return this.matrix;
  }

  /**
   * The current UV transform, recomputed first when it is stale.
   *
   * @returns {@link matrix}; the returned instance is never reallocated.
   */
  public getMatrix(): Mat3 {
    if (this.autoUpdateMatrix && this.matrixDirty) this.updateMatrix(true);
    return this.matrix;
  }

  /* --------------------------------------------------------------- copying */

  /**
   * Copies every sampling setting from another texture.
   *
   * The source (`image`/`source`) is shared by reference; call {@link setImage}
   * afterwards to diverge.
   *
   * @param source Texture to read.
   * @returns This texture, for chaining.
   */
  public copy(source: Texture): this {
    this.name = source.name;
    this.image = source.image;
    this.source = source.source;
    this.mipmaps.length = 0;
    for (const level of source.mipmaps) this.mipmaps.push(level);

    this.mapping = source.mapping;
    this.wrapS = source.wrapS;
    this.wrapT = source.wrapT;
    this.wrapR = source.wrapR;
    this.magFilter = source.magFilter;
    this.minFilter = source.minFilter;
    this.anisotropy = source.anisotropy;
    this.format = source.format;
    this.internalFormat = source.internalFormat;
    this.type = source.type;
    this.offset.copy(source.offset);
    this.repeat.copy(source.repeat);
    this.center.copy(source.center);
    this.rotationRadians = source.rotationRadians;
    this.autoUpdateMatrix = source.autoUpdateMatrix;
    this.generateMipmaps = source.generateMipmaps;
    this.premultiplyAlpha = source.premultiplyAlpha;
    this.unpackAlignment = source.unpackAlignment;
    this.flipY = source.flipY;
    this.colorSpace = source.colorSpace;
    this.matrix.copy(source.matrix);

    this.revision++;
    this.textureEvents.emit('update', this, this.revision);
    return this;
  }

  /** Independent copy of this texture (same source, same sampling state). */
  public clone(): this {
    const ctor = this.constructor as new () => this;
    return new ctor().copy(this);
  }

  /* -------------------------------------------------------- serialisation */

  /**
   * Serialises the sampling state.
   *
   * The source itself is never serialised: images and typed arrays are not
   * JSON-representable, so a loader is expected to re-attach data via
   * {@link setImage}.
   */
  public toJSON(): TextureJSON {
    const size = this.resolveSize();
    return {
      type: this.constructor.name,
      id: this.id,
      name: this.name,
      mapping: this.mapping,
      wrapS: this.wrapS,
      wrapT: this.wrapT,
      wrapR: this.wrapR,
      magFilter: this.magFilter,
      minFilter: this.minFilter,
      anisotropy: this.anisotropy,
      format: this.format,
      internalFormat: this.internalFormat,
      dataType: this.type,
      offset: [this.offset.x, this.offset.y],
      repeat: [this.repeat.x, this.repeat.y],
      center: [this.center.x, this.center.y],
      rotation: this.rotationRadians,
      matrixAutoUpdate: this.autoUpdateMatrix,
      matrix: Array.from(this.matrix.elements),
      generateMipmaps: this.generateMipmaps,
      premultiplyAlpha: this.premultiplyAlpha,
      unpackAlignment: this.unpackAlignment,
      flipY: this.flipY,
      colorSpace: this.colorSpace,
      version: this.revision,
      size: [size.width, size.height],
      ready: this.isReady(),
    };
  }

  /** Mipmap filtering implied by {@link minFilter}. */
  public get mipmapFilter(): MipmapFilter {
    switch (this.minFilter) {
      case TextureFilter.NearestMipmapNearest:
      case TextureFilter.NearestMipmapLinear:
        return MipmapFilter.Nearest;
      case TextureFilter.LinearMipmapNearest:
      case TextureFilter.LinearMipmapLinear:
        return MipmapFilter.Linear;
      default:
        return MipmapFilter.None;
    }
  }

  /* -------------------------------------------------------------- disposal */

  /** @inheritdoc */
  protected override onDispose(): void {
    this.textureEvents.emit('dispose');
    this.image = null;
    this.source = null;
    this.mipmaps.length = 0;
    this.textureEvents.dispose();
  }
}

/**
 * Normalises `-0` to `0`.
 *
 * `Math.sin(0)` is `0` but `-sy * Math.sin(0)` is `-0`, which serialises to `0` and
 * therefore makes a matrix compare unequal to itself after a JSON round-trip.
 */
function cleanZero(value: number): number {
  return value === 0 ? 0 : value;
}
