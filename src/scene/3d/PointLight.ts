/**
 * `PointLight` - an omnidirectional punctual light.
 *
 * `distance` bounds the light's reach (with a smooth window function provided by
 * the renderer) and `decay` selects the physical falloff exponent. `power` is
 * the luminous-flux convenience view of `intensity`, expressed in lumens.
 *
 * @packageDocumentation
 */

import { Object3D } from './Object3D';
import { Light } from './Light';
import type { PointLightOptions } from './types';

/** A light emitted from a single point, in every direction. */
export class PointLight extends Light {
  /** Allows consumers to detect the class without an `instanceof` check. */
  public readonly isPointLight: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'PointLight';

  /** Maximum reach of the light; `0` means "no limit". */
  public distance: number;

  /** Physical falloff exponent; `2` is the physically correct value. */
  public decay: number;

  /** Creates a point light. */
  constructor(options: PointLightOptions = {}) {
    super(options);
    this.distance = options.distance ?? 0;
    this.decay = options.decay ?? 2;
  }

  /**
   * Luminous flux, in lumens.
   *
   * Derived from {@link Light.intensity}: a light of intensity `1` emits
   * `4 * PI` lumens, which is the convention three.js uses and what keeps a
   * converted scene visually identical.
   */
  public get power(): number {
    return this.intensity * 4 * Math.PI;
  }

  public set power(lumens: number) {
    this.intensity = lumens / (4 * Math.PI);
  }

  /** Copies the falloff parameters of `source`. */
  public override copy(source: Object3D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof PointLight) {
      this.distance = source.distance;
      this.decay = source.decay;
    }
    return this;
  }

  /** Returns a clone of this light. */
  public override clone(recursive = true): PointLight {
    return new PointLight().copy(this, recursive) as PointLight;
  }
}
