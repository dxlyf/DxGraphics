/**
 * `HemisphereLight` - a two-colour ambient light.
 *
 * The upper hemisphere contributes `color`, the lower one `groundColor`, and the
 * blend between them follows the surface normal's `y` component. It is the
 * cheapest way to make unlit-looking geometry read as lit.
 *
 * @packageDocumentation
 */

import { Object3D } from './Object3D';
import { Light } from './Light';
import { copyColor, parseColor } from './LightColor';
import type { LightColor } from './LightColor';
import type { HemisphereLightOptions } from './types';

/** An ambient light with a separate sky and ground colour. */
export class HemisphereLight extends Light {
  /** Allows consumers to detect the class without an `instanceof` check. */
  public readonly isHemisphereLight: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'HemisphereLight';

  /** Linear colour of the lower hemisphere. */
  public readonly groundColor: LightColor;

  /** Creates a hemisphere light. */
  constructor(options: HemisphereLightOptions = {}) {
    super(options);
    this.groundColor = parseColor(options.groundColor ?? 0x444444);
  }

  /** Sets the ground colour from a hex integer, CSS string or record. */
  public setGroundColor(value: number | string | LightColor): this {
    parseColor(value, this.groundColor);
    return this;
  }

  /** Copies the ground colour alongside the base light state. */
  public override copy(source: Object3D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof HemisphereLight) copyColor(source.groundColor, this.groundColor);
    return this;
  }

  /** Returns a clone of this light. */
  public override clone(recursive = true): HemisphereLight {
    return new HemisphereLight().copy(this, recursive) as HemisphereLight;
  }
}
