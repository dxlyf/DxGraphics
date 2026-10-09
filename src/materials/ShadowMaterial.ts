/**
 * `ShadowMaterial` — a translucent shadow catcher.
 *
 * Renders the shadow term of the shading model over an otherwise transparent
 * surface, which is how a ground plane receives baked shadows without being
 * shaded itself.
 *
 * ```ts
 * const catcher = new ShadowMaterial({ color: '#000000', opacity: 0.35 });
 * ```
 *
 * @packageDocumentation
 */

import { Color } from '../math/Color';
import { Material } from './Material';
import type { MaterialParameters } from './types';
import { BlendMode } from './BlendMode';

/**
 * A material that draws only the shadow term.
 */
export class ShadowMaterial extends Material {
  /** Human-readable label used in diagnostics. */
  public override readonly label: string = 'ShadowMaterial';

  /** Registered type name. */
  public override readonly type: string = 'ShadowMaterial';

  /** Colour of the shadow itself, usually black. */
  public readonly color: Color = new Color(0, 0, 0);

  /**
   * @param parameters Optional parameter bag.
   */
  constructor(parameters?: MaterialParameters) {
    super();
    // Defaults first, parameters second: user-supplied values must win.
    this.transparent = true;
    this.color.set(0, 0, 0);
    this.blending = BlendMode.NormalBlending;
    this.fog = false;
    if (parameters) this.setValues(parameters);
  }

  /** Copies the shadow parameters of another shadow material. */
  public override copy(source: Material): this {
    super.copy(source);
    if (source instanceof ShadowMaterial) {
      this.color.copy(source.color);
    }
    return this;
  }

  /** Independent copy of this material. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }
}
