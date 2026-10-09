/**
 * `CubeTexture` — six faces sampled by direction.
 *
 * Faces are stored in the conventional order
 * `+X, -X, +Y, -Y, +Z, -Z`, which is what WebGL's `TEXTURE_CUBE_MAP_POSITIVE_X`
 * offset and WebGPU's six-layer array expect.
 *
 * ```ts
 * const skybox = new CubeTexture([px, nx, py, ny, pz, nz]);
 * skybox.mapping;  // Mapping.CubeReflectionMapping
 * ```
 *
 * @packageDocumentation
 */

import { Mapping, type TextureSource } from './types';
import { Texture } from './Texture';

/**
 * Index of a cube face, in `+X, -X, +Y, -Y, +Z, -Z` order.
 *
 * Named `CubeFace` (not `CubeFaceIndex`) because `scene/3d/CubeCamera` already
 * exports a `CubeFaceIndex` for its six camera faces, and `export *` treats a
 * duplicated name as ambiguous.
 */
export type CubeFace = 0 | 1 | 2 | 3 | 4 | 5;

/** Number of faces a cube texture must supply. */
export const CUBE_FACE_COUNT = 6;

/**
 * A six-faced texture sampled by reflection or refraction direction.
 *
 * @typeParam TLabel Literal label used in disposal errors.
 */
export class CubeTexture<TLabel extends string = 'CubeTexture'> extends Texture<TLabel> {  /** Human-readable label used in diagnostics. */
  public override readonly label: TLabel = 'CubeTexture' as TLabel;

  /** Brand flag that lets backends identify a cube map without importing it. */
  public readonly isCubeTexture: true = true;

  /** The six faces, in `+X, -X, +Y, -Y, +Z, -Z` order. */
  public readonly images: TextureSource[] = [];

  /**
   * @param images Optional faces; fewer than six leaves the remaining slots
   *   empty (and `isReady()` false).
   * @param mapping Sampling-space override; defaults to cube reflection.
   */
  constructor(images: readonly TextureSource[] | null = null, mapping?: Mapping) {
    super(null, mapping ?? Mapping.CubeReflectionMapping);
    this.flipY = false;
    this.generateMipmaps = true;
    if (images) {
      for (const image of images) this.images.push(image);
      this.syncFaces();
    }
  }

  /**
   * Replaces one face.
   *
   * @param face Face index in `+X, -X, +Y, -Y, +Z, -Z` order.
   * @param image Face source.
   * @returns This texture, for chaining.
   */
  public setFace(face: CubeFace, image: TextureSource): this {
    this.images[face] = image;
    this.syncFaces();
    return this;
  }

  /** Replaces every face at once. */
  public setFaces(images: readonly TextureSource[]): this {
    this.images.length = 0;
    for (const image of images) this.images.push(image);
    this.syncFaces();
    return this;
  }

  /** Every face that has a source, indexed by face order. */
  public getFaces(): (TextureSource | undefined)[] {
    const faces: (TextureSource | undefined)[] = [];
    for (let i = 0; i < CUBE_FACE_COUNT; i++) faces.push(this.images[i]);
    return faces;
  }

  /** `true` when all six faces are present. */
  public hasAllFaces(): boolean {
    for (let i = 0; i < CUBE_FACE_COUNT; i++) {
      if (this.images[i] === undefined) return false;
    }
    return true;
  }

  /** `true` when the cube map can be sampled. */
  public override isReady(): boolean {
    return this.hasAllFaces() && super.isReady();
  }

  /** Copies the faces and the sampling state of another cube texture. */
  public override copy(source: Texture): this {
    super.copy(source);
    if (source instanceof CubeTexture) {
      this.setFaces(source.images);
    }
    return this;
  }

  /** Independent copy with the same six faces attached. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }

  /** Keeps `image`/`source` pointing at face 0, which `getSize` measures. */
  private syncFaces(): void {
    const first = this.images[0] ?? null;
    this.image = first;
    this.source = first;
    this.markNeedsUpdate();
  }
}
