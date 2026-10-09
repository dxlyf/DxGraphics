/**
 * `BasicMaterial` — the abstract base for per-point, per-line and per-sprite
 * materials.
 *
 * These primitives share three things the mesh materials do not: a single flat
 * colour instead of a lighting model, an optional point/sprite map with its own
 * alpha channel, and a screen-space size. The base collects exactly that, so
 * `LineBasicMaterial`, `LineDashedMaterial`, `PointsMaterial` and
 * `SpriteMaterial` only add what is genuinely theirs.
 *
 * The class is abstract on purpose: it has no primitive of its own, so it is not
 * registered with `MaterialFactory`.
 *
 * @packageDocumentation
 */

import { Color } from '../math/Color';
import type { Texture } from '../textures/Texture';
import { Material } from './Material';

/**
 * Shared parameters of the non-mesh materials.
 *
 * @typeParam TLabel Literal label used in disposal errors.
 */
export abstract class BasicMaterial<TLabel extends string = string> extends Material<TLabel> {
  /** Flat colour applied to every primitive. */
  public readonly color: Color = new Color(1, 1, 1);

  /** `true` when per-vertex colours modulate {@link color}. */
  public vertexColors: boolean = false;

  /** Screen-space size: pixels for points and sprites, unused by lines. */
  public size: number = 1;

  /** `true` when {@link size} shrinks with distance (perspective only). */
  public sizeAttenuation: boolean = true;

  /** Diffuse/point map. */
  public get map(): Texture | null {
    return this.texture('map');
  }

  public set map(value: Texture | null) {
    this.setTexture('map', value);
  }

  /** Per-primitive alpha map; its red channel multiplies the alpha. */
  public get alphaMap(): Texture | null {
    return this.texture('alphaMap');
  }

  public set alphaMap(value: Texture | null) {
    this.setTexture('alphaMap', value);
  }

  /** Copies the shared primitive parameters of another basic material. */
  public override copy(source: Material): this {
    super.copy(source);
    if (source instanceof BasicMaterial) {
      this.color.copy(source.color);
      this.vertexColors = source.vertexColors;
      this.size = source.size;
      this.sizeAttenuation = source.sizeAttenuation;
    }
    return this;
  }

  /** Independent copy of this material. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }
}
