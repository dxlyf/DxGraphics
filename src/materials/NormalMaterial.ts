/**
 * `NormalMaterial` — debug output of the surface normal.
 *
 * Writes the view-space normal into the colour buffer (remapped to `0..1`), which
 * is the fastest way to see whether a normal map, a tangent frame or a mirrored
 * transform is wrong.
 *
 * ```ts
 * const debug = new NormalMaterial({ normalMap, normalScale: [1, -1] });
 * ```
 *
 * @packageDocumentation
 */

import { Vec2 } from '../math/Vec2';
import type { Texture } from '../textures/Texture';
import { Material } from './Material';
import type { MaterialParameters } from './types';

/**
 * A material that visualises normals.
 */
export class NormalMaterial extends Material {
  /** Human-readable label used in diagnostics. */
  public override readonly label: string = 'NormalMaterial';

  /** Registered type name. */
  public override readonly type: string = 'NormalMaterial';

  /** `true` to derive the normal from screen-space derivatives. */
  public flatShading: boolean = false;

  /** Height map perturbing the normal. */
  public get bumpMap(): Texture | null {
    return this.texture('bumpMap');
  }

  public set bumpMap(value: Texture | null) {
    this.setTexture('bumpMap', value);
  }

  /** Strength of {@link bumpMap}. */
  public bumpScale: number = 1;

  /** Tangent-space normal map. */
  public get normalMap(): Texture | null {
    return this.texture('normalMap');
  }

  public set normalMap(value: Texture | null) {
    this.setTexture('normalMap', value);
  }

  /** Per-axis scale applied to the sampled normal. */
  public readonly normalScale: Vec2 = new Vec2(1, 1);

  /** Vertex-displacement map. */
  public get displacementMap(): Texture | null {
    return this.texture('displacementMap');
  }

  public set displacementMap(value: Texture | null) {
    this.setTexture('displacementMap', value);
  }

  /** Scale of {@link displacementMap}. */
  public displacementScale: number = 1;

  /** Constant offset added to {@link displacementMap}. */
  public displacementBias: number = 0;

  /**
   * @param parameters Optional parameter bag.
   */
  constructor(parameters?: MaterialParameters) {
    super();
    this.fog = false;
    this.toneMapped = false;
    if (parameters) this.setValues(parameters);
  }

  /** Copies the debug parameters of another normal material. */
  public override copy(source: Material): this {
    super.copy(source);
    if (source instanceof NormalMaterial) {
      this.flatShading = source.flatShading;
      this.bumpScale = source.bumpScale;
      this.normalScale.copy(source.normalScale);
      this.displacementScale = source.displacementScale;
      this.displacementBias = source.displacementBias;
    }
    return this;
  }

  /** Independent copy of this material. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }
}
