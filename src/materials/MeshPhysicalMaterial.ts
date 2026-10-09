/**
 * `MeshPhysicalMaterial` — the extended physically based model.
 *
 * Adds the clearcoat, transmission, volume attenuation, iridescence, sheen and
 * index-of-refraction parameters on top of `MeshStandardMaterial`.
 *
 * ```ts
 * const glass = new MeshPhysicalMaterial({
 *   transmission: 1,
 *   thickness: 0.5,
 *   attenuationColor: '#88ccff',
 *   ior: 1.5,
 * });
 * ```
 *
 * @packageDocumentation
 */

import { Color } from '../math/Color';
import type { Texture } from '../textures/Texture';
import { Material } from './Material';
import type { MaterialParameters } from './types';
import { MeshStandardMaterial } from './MeshStandardMaterial';

/**
 * Extended PBR mesh material.
 */
export class MeshPhysicalMaterial extends MeshStandardMaterial {
  /** Human-readable label used in diagnostics. */
  public override readonly label: string = 'MeshPhysicalMaterial';

  /** Registered type name. */
  public override readonly type: string = 'MeshPhysicalMaterial';

  /** Strength of the clearcoat layer in `0..1`. */
  public clearcoat: number = 0;

  /** Roughness of the clearcoat layer in `0..1`. */
  public clearcoatRoughness: number = 0;

  /** Clearcoat intensity map; its red channel multiplies {@link clearcoat}. */
  public get clearcoatMap(): Texture | null {
    return this.texture('clearcoatMap');
  }

  public set clearcoatMap(value: Texture | null) {
    this.setTexture('clearcoatMap', value);
  }

  /** Normal map applied to the clearcoat layer only. */
  public get clearcoatNormalMap(): Texture | null {
    return this.texture('clearcoatNormalMap');
  }

  public set clearcoatNormalMap(value: Texture | null) {
    this.setTexture('clearcoatNormalMap', value);
  }

  /** Fraction of light transmitted through the surface, in `0..1`. */
  public transmission: number = 0;

  /** Transmission mask; its red channel multiplies {@link transmission}. */
  public get transmissionMap(): Texture | null {
    return this.texture('transmissionMap');
  }

  public set transmissionMap(value: Texture | null) {
    this.setTexture('transmissionMap', value);
  }

  /** Volume thickness used for attenuation, or `0` for a thin surface. */
  public thickness: number = 0;

  /** Thickness map; its green channel multiplies {@link thickness}. */
  public get thicknessMap(): Texture | null {
    return this.texture('thicknessMap');
  }

  public set thicknessMap(value: Texture | null) {
    this.setTexture('thicknessMap', value);
  }

  /**
   * Distance at which the transmitted light is fully attenuated.
   *
   * `Infinity` (the default) disables distance-based attenuation; the value is
   * serialised as `null` by `JSON.stringify`, which the factory decodes back to
   * `Infinity`.
   */
  public attenuationDistance: number = Infinity;

  /** Colour the transmitted light tends towards as it travels through the volume. */
  public readonly attenuationColor: Color = new Color(1, 1, 1);

  /** Strength of the iridescent thin-film layer in `0..1`. */
  public iridescence: number = 0;

  /** Strength of the sheen layer in `0..1`. */
  public sheen: number = 0;

  /** Tint of the sheen layer. */
  public readonly sheenColor: Color = new Color(0, 0, 0);

  /** Roughness of the sheen layer in `0..1`. */
  public sheenRoughness: number = 1;

  /** Scale applied to the dielectric specular response. */
  public specularIntensity: number = 1;

  /** Tint applied to the dielectric specular response. */
  public readonly specularColor: Color = new Color(1, 1, 1);

  /** Index of refraction; `1.5` is window glass. */
  public ior: number = 1.5;

  /** Reflectivity derived from {@link ior}; kept for API parity with Phong. */
  public override reflectivity: number = 0.5;

  /**
   * @param parameters Optional parameter bag.
   */
  constructor(parameters?: MaterialParameters) {
    super();
    this.clearcoat = 0;
    this.clearcoatRoughness = 0;
    this.transmission = 0;
    this.thickness = 0;
    this.attenuationDistance = Infinity;
    this.attenuationColor.set(1, 1, 1);
    this.iridescence = 0;
    this.sheen = 0;
    this.sheenColor.set(0, 0, 0);
    this.sheenRoughness = 1;
    this.specularIntensity = 1;
    this.specularColor.set(1, 1, 1);
    this.ior = 1.5;
    this.reflectivity = 0.5;
    if (parameters) this.setValues(parameters);
  }

  /** Fresnel reflectance at normal incidence, derived from {@link ior}. */
  public get reflectance(): number {
    const f0 = ((this.ior - 1) / (this.ior + 1)) ** 2;
    return f0 * this.specularIntensity;
  }

  /** Copies the extended parameters of another physical material. */
  public override copy(source: Material): this {
    super.copy(source);
    if (source instanceof MeshPhysicalMaterial) {
      this.clearcoat = source.clearcoat;
      this.clearcoatRoughness = source.clearcoatRoughness;
      this.transmission = source.transmission;
      this.thickness = source.thickness;
      this.attenuationDistance = source.attenuationDistance;
      this.attenuationColor.copy(source.attenuationColor);
      this.iridescence = source.iridescence;
      this.sheen = source.sheen;
      this.sheenColor.copy(source.sheenColor);
      this.sheenRoughness = source.sheenRoughness;
      this.specularIntensity = source.specularIntensity;
      this.specularColor.copy(source.specularColor);
      this.ior = source.ior;
      this.reflectivity = source.reflectivity;
    }
    return this;
  }

  /** Independent copy of this material. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }
}
