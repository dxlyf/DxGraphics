/**
 * `LineBasicMaterial` — solid line rendering.
 *
 * ```ts
 * const material = new LineBasicMaterial({ color: '#4a9eff', linewidth: 2 });
 * ```
 *
 * `linewidth` is honoured by the Canvas2D/SVG backends and by the WebGPU
 * backend's wide-line pipeline; the WebGL core profile clamps it to `1`, which is
 * documented on the field.
 *
 * @packageDocumentation
 */

import { Color, type ColorRepresentation } from '../math/Color';
import { DEFAULT_LINE_WIDTH } from '../constants';
import { Material } from './Material';
import type { MaterialParameters } from './types';
import { BasicMaterial } from './BasicMaterial';

/** End caps used by backends that can draw them. */
export type LineCap = 'butt' | 'round' | 'square';

/** Corner joins used by backends that can draw them. */
export type LineJoin = 'round' | 'bevel' | 'miter';

/**
 * A line material without a dash pattern.
 */
export class LineBasicMaterial extends BasicMaterial {
  /** Human-readable label used in diagnostics. */
  public override readonly label: string = 'LineBasicMaterial';

  /** Registered type name. */
  public override readonly type: string = 'LineBasicMaterial';

  /** Line width in pixels. */
  public linewidth: number = DEFAULT_LINE_WIDTH;

  /** End cap drawn at each line's extremities. */
  public linecap: LineCap = 'round';

  /** Join drawn where two segments meet. */
  public linejoin: LineJoin = 'round';

  /**
   * @param parameters Optional parameter bag.
   */
  constructor(parameters?: MaterialParameters) {
    super();
    // Defaults first, parameters second: a user-supplied `color` must win.
    this.color.copy(Color.white());
    this.sizeAttenuation = false;
    this.linewidth = DEFAULT_LINE_WIDTH;
    if (parameters) this.setValues(parameters);
  }

  /**
   * Sets the line colour, accepting any CSS/hex/numeric representation.
   *
   * @param value Colour to apply.
   * @returns This material, for chaining.
   */
  public setColor(value: ColorRepresentation): this {
    this.color.set(value);
    return this.markNeedsUpdate();
  }

  /** Copies the line parameters of another line material. */
  public override copy(source: Material): this {
    super.copy(source);
    if (source instanceof LineBasicMaterial) {
      this.linewidth = source.linewidth;
      this.linecap = source.linecap;
      this.linejoin = source.linejoin;
    }
    return this;
  }

  /** Independent copy of this material. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }
}
