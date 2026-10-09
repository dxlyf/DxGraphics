/**
 * `LineDashedMaterial` — lines drawn with a dash/gap pattern.
 *
 * The pattern is evaluated from the arc-length attribute of the geometry, so the
 * dash length is independent of how the polyline was segmented. The renderer is
 * expected to compute those distances (`Line.computeLineDistances()`); the
 * material only describes the pattern.
 *
 * ```ts
 * const material = new LineDashedMaterial({ dashSize: 3, gapSize: 1, scale: 1 });
 * ```
 *
 * @packageDocumentation
 */

import { Material } from './Material';
import type { MaterialParameters } from './types';
import { LineBasicMaterial } from './LineBasicMaterial';

/**
 * A line material with a dash pattern.
 */
export class LineDashedMaterial extends LineBasicMaterial {
  /** Human-readable label used in diagnostics. */
  public override readonly label: string = 'LineDashedMaterial';

  /** Registered type name. */
  public override readonly type: string = 'LineDashedMaterial';

  /** Length of one dash, in world units (scaled by {@link scale}). */
  public dashSize: number = 3;

  /** Length of the gap between dashes. */
  public gapSize: number = 1;

  /** Multiplier applied to the arc-length attribute. */
  public scale: number = 1;

  /** Length of one dash-plus-gap cycle. */
  public get period(): number {
    return this.dashSize + this.gapSize;
  }

  /**
   * @param parameters Optional parameter bag.
   */
  constructor(parameters?: MaterialParameters) {
    super(parameters);
  }

  /** Copies the dash parameters of another dashed material. */
  public override copy(source: Material): this {
    super.copy(source);
    if (source instanceof LineDashedMaterial) {
      this.dashSize = source.dashSize;
      this.gapSize = source.gapSize;
      this.scale = source.scale;
    }
    return this;
  }

  /** Independent copy of this material. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }
}
