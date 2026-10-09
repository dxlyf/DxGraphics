/**
 * `SpriteMaterial` — a camera-facing quad.
 *
 * ```ts
 * const material = new SpriteMaterial({ map: logo, rotation: Math.PI / 4, size: 64 });
 * ```
 *
 * Sprites are always blended (a sprite without an alpha map would simply look
 * like a quad), so `transparent` defaults to `true`.
 *
 * @packageDocumentation
 */

import { Material } from './Material';
import type { MaterialParameters } from './types';
import { BasicMaterial } from './BasicMaterial';

/**
 * A material for `Sprite` nodes.
 */
export class SpriteMaterial extends BasicMaterial {
  /** Human-readable label used in diagnostics. */
  public override readonly label: string = 'SpriteMaterial';

  /** Registered type name. */
  public override readonly type: string = 'SpriteMaterial';

  /** Rotation of the quad around the view axis, in radians. */
  public rotation: number = 0;

  /**
   * @param parameters Optional parameter bag.
   */
  constructor(parameters?: MaterialParameters) {
    super();
    // Defaults first, parameters second: user-supplied values must win.
    this.transparent = true;
    this.size = 1;
    this.sizeAttenuation = true;
    if (parameters) this.setValues(parameters);
  }

  /** Copies the sprite parameters of another sprite material. */
  public override copy(source: Material): this {
    super.copy(source);
    if (source instanceof SpriteMaterial) {
      this.rotation = source.rotation;
    }
    return this;
  }

  /** Independent copy of this material. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }
}
