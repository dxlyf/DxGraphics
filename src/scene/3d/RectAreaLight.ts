/**
 * `RectAreaLight` - an area light shaped like a rectangle.
 *
 * Area lights have no analytic solution, so the shading code integrates them
 * with the linearly-transformed-cosine approximation; the renderer needs the
 * light's world matrix and the two dimensions below to build the basis.
 *
 * @packageDocumentation
 */

import { Object3D } from './Object3D';
import { Light } from './Light';
import type { RectAreaLightOptions } from './types';

/** A rectangular area light. */
export class RectAreaLight extends Light {
  /** Allows consumers to detect the class without an `instanceof` check. */
  public readonly isRectAreaLight: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'RectAreaLight';

  /** Width of the emissive rectangle, in world units. */
  public width: number;

  /** Height of the emissive rectangle, in world units. */
  public height: number;

  /** Creates a rectangular area light. */
  constructor(options: RectAreaLightOptions = {}) {
    super(options);
    this.width = options.width ?? 10;
    this.height = options.height ?? 10;
  }

  /** Lights look down their `-Z` axis. */
  protected override isCameraLike(): boolean {
    return true;
  }

  /** Copies the rectangle dimensions of `source`. */
  public override copy(source: Object3D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof RectAreaLight) {
      this.width = source.width;
      this.height = source.height;
    }
    return this;
  }

  /** Returns a clone of this light. */
  public override clone(recursive = true): RectAreaLight {
    return new RectAreaLight().copy(this, recursive) as RectAreaLight;
  }
}
