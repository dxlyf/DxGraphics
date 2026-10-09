/**
 * `MeshPhongMaterial` — Blinn-Phong specular highlights on top of Lambert
 * diffuse.
 *
 * ```ts
 * const material = new MeshPhongMaterial({ color: '#cccccc', shininess: 60, normalMap });
 * ```
 *
 * @packageDocumentation
 */

import { Color } from '../math/Color';
import { Vec2 } from '../math/Vec2';
import type { Texture } from '../textures/Texture';
import { Material } from './Material';
import type { MaterialParameters } from './types';
import { MeshLambertMaterial } from './MeshLambertMaterial';

/**
 * Blinn-Phong mesh material.
 */
export class MeshPhongMaterial extends MeshLambertMaterial {
  /** Human-readable label used in diagnostics. */
  public override readonly label: string = 'MeshPhongMaterial';

  /** Registered type name. */
  public override readonly type: string = 'MeshPhongMaterial';

  /** Specular colour of the highlight. */
  public readonly specular: Color = new Color(0.11, 0.11, 0.11);

  /** Blinn-Phong exponent; higher values tighten the highlight. */
  public shininess: number = 30;

  /** Tangent-space normal map. */
  public get normalMap(): Texture | null {
    return this.texture('normalMap');
  }

  public set normalMap(value: Texture | null) {
    this.setTexture('normalMap', value);
  }

  /** Per-axis scale applied to the sampled normal. */
  public readonly normalScale: Vec2 = new Vec2(1, 1);

  /** Height map perturbing the normal along screen-space derivatives. */
  public get bumpMap(): Texture | null {
    return this.texture('bumpMap');
  }

  public set bumpMap(value: Texture | null) {
    this.setTexture('bumpMap', value);
  }

  /** Strength of {@link bumpMap}. */
  public bumpScale: number = 1;

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
    // Defaults first, parameters second: user-supplied values must win. The
    // field initialisers above already set the specular colour and shininess.
    if (parameters) this.setValues(parameters);
  }

  /** Copies the specular parameters of another Phong material. */
  public override copy(source: Material): this {
    super.copy(source);
    if (source instanceof MeshPhongMaterial) {
      this.specular.copy(source.specular);
      this.shininess = source.shininess;
      this.normalScale.copy(source.normalScale);
      this.bumpScale = source.bumpScale;
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
