/**
 * `AmbientLight` - a uniform, directionless light.
 *
 * The ambient term is added once per shaded fragment; it has no position and no
 * shadows.
 *
 * @packageDocumentation
 */

import { Light } from './Light';
import type { LightOptions } from './types';

/** A light that illuminates every surface equally, from every direction. */
export class AmbientLight extends Light {
  /** Allows consumers to detect the class without an `instanceof` check. */
  public readonly isAmbientLight: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'AmbientLight';

  /** Creates an ambient light. */
  constructor(options: LightOptions = {}) {
    super(options);
  }

  /** Returns a clone of this light. */
  public override clone(recursive = true): AmbientLight {
    return new AmbientLight().copy(this, recursive) as AmbientLight;
  }
}
