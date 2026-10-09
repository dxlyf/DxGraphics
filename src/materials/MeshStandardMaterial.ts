/**
 * `MeshStandardMaterial` — metallic-roughness physically based shading.
 *
 * ```ts
 * const material = new MeshStandardMaterial({ color: '#c0c0c0', roughness: 0.35, metalness: 0.9 });
 * ```
 *
 * @packageDocumentation
 */

import type { Texture } from '../textures/Texture';
import { Material } from './Material';
import type { MaterialParameters } from './types';
import { MeshPhongMaterial } from './MeshPhongMaterial';

/**
 * Metallic-roughness mesh material.
 */
export class MeshStandardMaterial extends MeshPhongMaterial {
  /** Human-readable label used in diagnostics. */
  public override readonly label: string = 'MeshStandardMaterial';

  /** Registered type name. */
  public override readonly type: string = 'MeshStandardMaterial';

  /** Surface roughness in `0..1`; `0` is a mirror, `1` is fully diffuse. */
  public roughness: number = 1;

  /** Metalness in `0..1`; `0` is a dielectric, `1` a conductor. */
  public metalness: number = 0;

  /** Roughness map; its green channel multiplies {@link roughness}. */
  public get roughnessMap(): Texture | null {
    return this.texture('roughnessMap');
  }

  public set roughnessMap(value: Texture | null) {
    this.setTexture('roughnessMap', value);
  }

  /** Metalness map; its blue channel multiplies {@link metalness}. */
  public get metalnessMap(): Texture | null {
    return this.texture('metalnessMap');
  }

  public set metalnessMap(value: Texture | null) {
    this.setTexture('metalnessMap', value);
  }

  /** Multiplier applied to the environment sample. */
  public envMapIntensity: number = 1;

  /**
   * @param parameters Optional parameter bag.
   */
  constructor(parameters?: MaterialParameters) {
    super();
    this.roughness = 1;
    this.metalness = 0;
    if (parameters) this.setValues(parameters);
  }

  /** Copies the PBR parameters of another standard material. */
  public override copy(source: Material): this {
    super.copy(source);
    if (source instanceof MeshStandardMaterial) {
      this.roughness = source.roughness;
      this.metalness = source.metalness;
      this.envMapIntensity = source.envMapIntensity;
    }
    return this;
  }

  /** Independent copy of this material. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }
}
