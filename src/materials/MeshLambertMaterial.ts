/**
 * `MeshLambertMaterial` — diffuse-only lighting with an emissive term.
 *
 * ```ts
 * const material = new MeshLambertMaterial({ color: '#88aa88', emissive: '#001100' });
 * ```
 *
 * @packageDocumentation
 */

import { Color } from '../math/Color';
import type { Texture } from '../textures/Texture';
import { Material } from './Material';
import type { MaterialParameters } from './types';
import { MeshBasicMaterial } from './MeshBasicMaterial';

/**
 * Lambert (diffuse) mesh material.
 */
export class MeshLambertMaterial extends MeshBasicMaterial {
  /** Human-readable label used in diagnostics. */
  public override readonly label: string = 'MeshLambertMaterial';

  /** Registered type name. */
  public override readonly type: string = 'MeshLambertMaterial';

  /** Colour added independently of the lighting. */
  public readonly emissive: Color = new Color(0, 0, 0);

  /** Emissive map, multiplied into {@link emissive}. */
  public get emissiveMap(): Texture | null {
    return this.texture('emissiveMap');
  }

  public set emissiveMap(value: Texture | null) {
    this.setTexture('emissiveMap', value);
  }

  /** Scale applied to {@link emissive}. */
  public emissiveIntensity: number = 1;

  /**
   * @param parameters Optional parameter bag.
   */
  constructor(parameters?: MaterialParameters) {
    super();
    this.emissive.set(0, 0, 0);
    if (parameters) this.setValues(parameters);
  }

  /** Copies the emissive parameters of another Lambert material. */
  public override copy(source: Material): this {
    super.copy(source);
    if (source instanceof MeshLambertMaterial) {
      this.emissive.copy(source.emissive);
      this.emissiveIntensity = source.emissiveIntensity;
    }
    return this;
  }

  /** Independent copy of this material. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }
}
