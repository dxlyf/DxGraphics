/**
 * `Light2D` - a light for 2D materials.
 *
 * 2D lighting is a shading trick rather than a simulation: a light contributes a
 * coloured term that a 2D material blends into its own colour. Three
 * approximations are supported, which cover essentially every 2D look:
 *
 *  - `'ambient'` adds a flat term everywhere (the cheapest, and the one a
 *    "night-time tint" uses);
 *  - `'point'` falls off with distance from the light's position;
 *  - `'directional'` uses the light's rotation as a direction and ignores
 *    distance, which is what a sun or a global highlight uses.
 *
 * @packageDocumentation
 */

import { clamp } from '../../utils/MathUtils';
import { Vec2 } from '../../math/Vec2';
import { Node2D } from './Node2D';
import type { Node2DOptions } from './types';

/** The three 2D light models. */
export type LightKind2D = 'ambient' | 'point' | 'directional';

/** A plain linear RGB colour, matching the 3D light representation. */
export interface Light2DColor {
  /** Red channel in `[0, 1]`. */
  r: number;
  /** Green channel in `[0, 1]`. */
  g: number;
  /** Blue channel in `[0, 1]`. */
  b: number;
}

/** Options accepted by the {@link Light2D} constructor. */
export interface Light2DOptions extends Node2DOptions {
  /** Light model; defaults to `'point'`. */
  kind?: LightKind2D;
  /** Light colour as a hex integer (`0xff8800`), CSS string, or record. */
  color?: number | string | Light2DColor;
  /** Colour multiplier. */
  intensity?: number;
  /** Radius of influence for `'point'` lights; `0` means "no limit". */
  radius?: number;
  /** Falloff exponent for `'point'` lights; `2` is the physical value. */
  decay?: number;
}

/** A 2D light source. */
export class Light2D extends Node2D {
  /** Allows consumers to detect a light without an `instanceof` check. */
  public readonly isLight2D: true = true;

  /** Class name used by serialisation and the backend's dispatch. */
  public override readonly type: string = 'Light2D';

  /** Light model applied by the shading pass. */
  public kind: LightKind2D;

  /** Linear RGB colour. */
  public readonly color: Light2DColor;

  /** Colour multiplier. */
  public intensity: number;

  /** Radius of influence for `'point'` lights; `0` means "no limit". */
  public radius: number;

  /** Falloff exponent for `'point'` lights. */
  public decay: number;

  /** `true` includes the light while shading. */
  public enabled = true;

  /** Creates a 2D light. */
  constructor(options: Light2DOptions = {}) {
    super(options);
    this.kind = options.kind ?? 'point';
    this.color = parseLightColor(options.color);
    this.intensity = options.intensity ?? 1;
    this.radius = options.radius ?? 0;
    this.decay = options.decay ?? 2;
  }

  /** Sets the light colour from a hex integer, CSS string or record. */
  public setColor(value: number | string | Light2DColor): this {
    const parsed = parseLightColor(value);
    this.color.r = parsed.r;
    this.color.g = parsed.g;
    this.color.b = parsed.b;
    return this;
  }

  /**
   * Attenuation at `distance` from the light, in local units.
   *
   * Ambient lights ignore distance; point lights follow `(1 - d / radius)^decay`
   * and clamp to zero past the radius. The result is in `[0, 1]`.
   */
  public attenuationAt(distance: number): number {
    if (this.kind !== 'point') return 1;
    if (this.radius <= 0) return 1;
    if (distance >= this.radius) return 0;
    if (distance <= 0) return 1;
    return Math.pow(1 - distance / this.radius, Math.max(this.decay, 0));
  }

  /**
   * Contribution of this light at a world-space point.
   *
   * @param point Point in world space.
   * @param target Receives the RGB contribution; a new record is allocated when
   *   omitted.
   */
  public contributionAt(
    point: Vec2,
    target: Light2DColor = { r: 0, g: 0, b: 0 },
  ): Light2DColor {
    if (!this.enabled) {
      target.r = 0;
      target.g = 0;
      target.b = 0;
      return target;
    }

    let attenuation = 1;
    if (this.kind === 'point') {
      const worldX = this.worldMatrix.elements[12];
      const worldY = this.worldMatrix.elements[13];
      attenuation = this.attenuationAt(Math.hypot(point.x - worldX, point.y - worldY));
    }

    const scale = this.intensity * attenuation;
    target.r = clamp(this.color.r * scale, 0, 1);
    target.g = clamp(this.color.g * scale, 0, 1);
    target.b = clamp(this.color.b * scale, 0, 1);
    return target;
  }

  /** Copies the light state of `source`. */
  public override copy(source: Node2D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof Light2D) {
      this.kind = source.kind;
      this.color.r = source.color.r;
      this.color.g = source.color.g;
      this.color.b = source.color.b;
      this.intensity = source.intensity;
      this.radius = source.radius;
      this.decay = source.decay;
      this.enabled = source.enabled;
    }
    return this;
  }

  /** Serialises the light alongside the node data. */
  public override toJSON(recursive = true): ReturnType<Node2D['toJSON']> {
    const json = super.toJSON(recursive);
    json.kind = this.kind;
    json.color = { ...this.color };
    json.intensity = this.intensity;
    json.radius = this.radius;
    json.decay = this.decay;
    json.enabled = this.enabled;
    return json;
  }

  /** Returns a new light with the same state. */
  public override clone(recursive = true): Light2D {
    return this.createInstance().copy(this, recursive) as Light2D;
  }

  /** Creates an empty `Light2D`, used by `clone()`. */
  protected override createInstance(): Node2D {
    return new Light2D();
  }
}

/**
 * Coerces a hex integer, CSS string or record into a {@link Light2DColor}.
 *
 * Anything unparseable falls back to white rather than throwing, so a typo in a
 * scene description cannot take down a frame.
 */
function parseLightColor(value: number | string | Light2DColor | undefined): Light2DColor {
  const target: Light2DColor = { r: 1, g: 1, b: 1 };
  if (value === undefined) return target;

  if (typeof value === 'object' && value !== null) {
    target.r = clamp(value.r, 0, 1);
    target.g = clamp(value.g, 0, 1);
    target.b = clamp(value.b, 0, 1);
    return target;
  }

  if (typeof value === 'number') {
    const hex = Math.round(value) & 0xffffff;
    target.r = ((hex >> 16) & 0xff) / 255;
    target.g = ((hex >> 8) & 0xff) / 255;
    target.b = (hex & 0xff) / 255;
    return target;
  }

  const text = value.trim();
  if (text.startsWith('#')) {
    const digits = text.slice(1);
    const expand = (index: number): number => Number.parseInt(digits[index] + digits[index], 16);
    const pair = (index: number): number => Number.parseInt(digits.slice(index, index + 2), 16);
    if (digits.length === 3 || digits.length === 4) {
      const r = expand(0);
      const g = expand(1);
      const b = expand(2);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        target.r = r / 255;
        target.g = g / 255;
        target.b = b / 255;
        return target;
      }
    } else if (digits.length === 6 || digits.length === 8) {
      const r = pair(0);
      const g = pair(2);
      const b = pair(4);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        target.r = r / 255;
        target.g = g / 255;
        target.b = b / 255;
        return target;
      }
    }
  }

  return target;
}
