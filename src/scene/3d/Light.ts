/**
 * `Light` - the abstract base of every light source.
 *
 * A light contributes a colour and an intensity to the shading pass; how that
 * contribution is applied (ambient term, punctual term, cone falloff, area
 * integral) is decided by the subclass and implemented by the renderer.
 *
 * `shadow` is intentionally a loose {@link LightShadowLike} placeholder: the
 * shadow-map module owns the concrete type and replaces it without touching the
 * scene layer.
 *
 * @packageDocumentation
 */

import { Object3D } from './Object3D';
import { copyColor, createShadowState, parseColor } from './LightColor';
import type { LightColor } from './LightColor';
import type { LightOptions, LightShadowLike } from './types';

/** Base class of `AmbientLight`, `DirectionalLight`, `PointLight`, ... */
export abstract class Light extends Object3D {
  /** Allows consumers to detect a light without an `instanceof` check. */
  public readonly isLight: true = true;

  /** Linear RGB colour of the light. */
  public readonly color: LightColor;

  /** Multiplier applied to {@link Light.color}. */
  public intensity: number;

  /** Shadow configuration placeholder, replaced by the shadow module. */
  public shadow: LightShadowLike;

  /** Creates a light. */
  constructor(options: LightOptions = {}) {
    super(options);
    this.color = parseColor(options.color ?? 0xffffff);
    this.intensity = options.intensity ?? 1;
    this.shadow = createShadowState();
  }

  /** Sets the colour from a hex integer, CSS string or colour record. */
  public setColor(value: number | string | LightColor): this {
    parseColor(value, this.color);
    return this;
  }

  /** `true` for lights that point at a target and therefore look down `-Z`. */
  protected override isCameraLike(): boolean {
    return false;
  }

  /** Copies the colour, intensity and shadow settings of `source`. */
  public override copy(source: Object3D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof Light) {
      copyColor(source.color, this.color);
      this.intensity = source.intensity;
      this.shadow = {
        ...source.shadow,
        mapSize: source.shadow.mapSize ? { ...source.shadow.mapSize } : undefined,
      };
    }
    return this;
  }
}
