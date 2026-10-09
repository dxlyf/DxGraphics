/**
 * `PointsMaterial` — screen-space point sprites.
 *
 * ```ts
 * const material = new PointsMaterial({ color: '#ffffff', size: 8, map: sprite });
 * ```
 *
 * `size`, `sizeAttenuation`, `map` and `alphaMap` come from
 * {@link BasicMaterial}; this class only documents the point-specific defaults and
 * makes the type concrete so the factory can register it.
 *
 * @packageDocumentation
 */

import type { MaterialParameters } from './types';
import { BasicMaterial } from './BasicMaterial';

/**
 * A material for `Points` geometries.
 */
export class PointsMaterial extends BasicMaterial {
  /** Human-readable label used in diagnostics. */
  public override readonly label: string = 'PointsMaterial';

  /** Registered type name. */
  public override readonly type: string = 'PointsMaterial';

  /**
   * @param parameters Optional parameter bag.
   */
  constructor(parameters?: MaterialParameters) {
    super();
    // Defaults first, parameters second: user-supplied values must win.
    this.size = 1;
    this.sizeAttenuation = true;
    if (parameters) this.setValues(parameters);
  }

  /** Independent copy of this material. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }
}
