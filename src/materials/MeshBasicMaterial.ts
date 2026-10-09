/**
 * `MeshBasicMaterial` — unlit surface shading.
 *
 * The base of the mesh-material tier: it owns every texture slot and the
 * wireframe/environment parameters the lit materials inherit, so
 * `MeshLambertMaterial`, `MeshPhongMaterial`, `MeshStandardMaterial` and
 * `MeshPhysicalMaterial` only add the parameters of their lighting model.
 *
 * ```ts
 * const material = new MeshBasicMaterial({ color: '#ff8800', map: albedo, wireframe: true });
 * ```
 *
 * @packageDocumentation
 */

import { Color } from '../math/Color';
import type { Texture } from '../textures/Texture';
import { Material } from './Material';
import { CombineOperation } from './types';
import type { MaterialParameters } from './types';

/**
 * Unlit mesh material.
 */
export class MeshBasicMaterial extends Material {
  /** Human-readable label used in diagnostics. */
  public override readonly label: string = 'MeshBasicMaterial';

  /** Registered type name. */
  public override readonly type: string = 'MeshBasicMaterial';

  /** Flat colour multiplied with the diffuse map. */
  public readonly color: Color = new Color(1, 1, 1);

  /** `true` when per-vertex colours modulate {@link color}. */
  public vertexColors: boolean = false;

  /** `true` when mesh normals are used (skinning, env maps). */
  public flatShading: boolean = false;

  /** Diffuse map. */
  public get map(): Texture | null {
    return this.texture('map');
  }

  public set map(value: Texture | null) {
    this.setTexture('map', value);
  }

  /** Baked light map, added to the diffuse colour. */
  public get lightMap(): Texture | null {
    return this.texture('lightMap');
  }

  public set lightMap(value: Texture | null) {
    this.setTexture('lightMap', value);
  }

  /** Ambient-occlusion map; its red channel multiplies the result. */
  public get aoMap(): Texture | null {
    return this.texture('aoMap');
  }

  public set aoMap(value: Texture | null) {
    this.setTexture('aoMap', value);
  }

  /** Specular-intensity map (used by the lit tiers). */
  public get specularMap(): Texture | null {
    return this.texture('specularMap');
  }

  public set specularMap(value: Texture | null) {
    this.setTexture('specularMap', value);
  }

  /** Alpha map; its red channel multiplies the alpha. */
  public get alphaMap(): Texture | null {
    return this.texture('alphaMap');
  }

  public set alphaMap(value: Texture | null) {
    this.setTexture('alphaMap', value);
  }

  /** Environment map. */
  public get envMap(): Texture | null {
    return this.texture('envMap');
  }

  public set envMap(value: Texture | null) {
    this.setTexture('envMap', value);
  }

  /** How {@link envMap} combines with the shaded colour. */
  public combine: CombineOperation = CombineOperation.Multiply;

  /** Blend factor between the shaded colour and the environment sample. */
  public reflectivity: number = 1;

  /** Index of refraction used by refraction-mapped environments. */
  public refractionRatio: number = 0.98;

  /** Line width used when {@link Material.wireframe} is enabled. */
  public wireframeLinewidth: number = 1;

  /** End caps used by backends that honour {@link wireframeLinewidth}. */
  public wireframeLinecap: 'butt' | 'round' | 'square' = 'round';

  /** Joins used by backends that honour {@link wireframeLinewidth}. */
  public wireframeLinejoin: 'round' | 'bevel' | 'miter' = 'round';

  /** `true` when the mesh is skinned; the renderer sets it automatically. */
  public skinning: boolean = false;

  /** `true` when the mesh has morph targets. */
  public morphTargets: boolean = false;

  /**
   * @param parameters Optional parameter bag.
   */
  constructor(parameters?: MaterialParameters) {
    super();
    // Defaults first, parameters second: user-supplied values must win.
    this.color.copy(Color.white());
    if (parameters) this.setValues(parameters);
  }

  /** Copies the unlit parameters of another mesh material. */
  public override copy(source: Material): this {
    super.copy(source);
    if (source instanceof MeshBasicMaterial) {
      this.color.copy(source.color);
      this.vertexColors = source.vertexColors;
      this.flatShading = source.flatShading;
      this.combine = source.combine;
      this.reflectivity = source.reflectivity;
      this.refractionRatio = source.refractionRatio;
      this.wireframeLinewidth = source.wireframeLinewidth;
      this.wireframeLinecap = source.wireframeLinecap;
      this.wireframeLinejoin = source.wireframeLinejoin;
      this.skinning = source.skinning;
      this.morphTargets = source.morphTargets;
    }
    return this;
  }

  /** Independent copy of this material. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }
}
