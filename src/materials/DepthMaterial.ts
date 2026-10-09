/**
 * `DepthMaterial` — a depth-only pass.
 *
 * Used for shadow maps and depth pre-passes. The colour channels carry the depth
 * (raw or packed), which is why the material exposes `depthPacking` instead of a
 * colour: the renderer reads the attachment, not the shade.
 *
 * ```ts
 * const shadowDepth = new DepthMaterial({ depthPacking: DepthPacking.RGBA });
 * ```
 *
 * @packageDocumentation
 */

import type { Texture } from '../textures/Texture';
import { Material } from './Material';
import { DepthPacking } from './types';
import type { MaterialParameters } from './types';

/**
 * A material that renders depth only.
 */
export class DepthMaterial extends Material {
  /** Human-readable label used in diagnostics. */
  public override readonly label: string = 'DepthMaterial';

  /** Registered type name. */
  public override readonly type: string = 'DepthMaterial';

  /** How the depth value is written into the colour attachment. */
  public depthPacking: DepthPacking = DepthPacking.Basic;

  /** Alpha map; fragments below the material's alpha test are discarded. */
  public get alphaMap(): Texture | null {
    return this.texture('alphaMap');
  }

  public set alphaMap(value: Texture | null) {
    this.setTexture('alphaMap', value);
  }

  /** Vertex-displacement map, so the depth pass matches the shaded geometry. */
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
    this.depthPacking = DepthPacking.Basic;
    this.fog = false;
    if (parameters) this.setValues(parameters);
  }

  /** Copies the depth parameters of another depth material. */
  public override copy(source: Material): this {
    super.copy(source);
    if (source instanceof DepthMaterial) {
      this.depthPacking = source.depthPacking;
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
