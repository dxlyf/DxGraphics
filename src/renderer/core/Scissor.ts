/**
 * Scissor rectangle value class.
 *
 * Same shape as {@link Viewport} plus {@link Scissor.isEmpty} and the clamping
 * helper backends need before handing the rectangle to a driver, which rejects
 * negative extents.
 *
 * @packageDocumentation
 */

import type { ScissorRect } from '../interfaces/types';
import { Viewport } from './Viewport';

/**
 * Clipping rectangle in device pixels.
 *
 * ```ts
 * const scissor = new Scissor(0, 0, 640, 480);
 * scissor.isEmpty;                     // false
 * scissor.clampTo(320, 240).toArray(); // [0, 0, 320, 240]
 * ```
 */
export class Scissor extends Viewport {
  /** Builds a scissor covering a whole canvas. */
  public static override fromCanvas(
    canvas: { width: number; height: number },
    reuse: Scissor = new Scissor(),
  ): Scissor {
    return reuse.setFromCanvas(canvas);
  }

  /** @returns `true` when the rectangle encloses no pixels. */
  public override get isEmpty(): boolean {
    return this.width <= 0 || this.height <= 0;
  }

  /** @returns A new scissor with the same values. */
  public override clone(): Scissor {
    return new Scissor(this.x, this.y, this.width, this.height);
  }

  /** @returns A plain `{ x, y, width, height }` copy. */
  public override toObject(): ScissorRect {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  /**
   * Intersects this rectangle with a bounds rectangle, in place.
   *
   * Used by backends to keep a scissor inside the drawing buffer; a scissor that
   * falls entirely outside collapses to a zero-area rectangle.
   *
   * @param boundsWidth Width of the enclosing surface.
   * @param boundsHeight Height of the enclosing surface.
   * @returns This scissor, for chaining.
   */
  public clampTo(boundsWidth: number, boundsHeight: number): this {
    const right = Math.min(this.x + this.width, Math.max(0, boundsWidth));
    const bottom = Math.min(this.y + this.height, Math.max(0, boundsHeight));
    const left = Math.max(0, Math.min(this.x, right));
    const top = Math.max(0, Math.min(this.y, bottom));

    this.x = left;
    this.y = top;
    this.width = Math.max(0, right - left);
    this.height = Math.max(0, bottom - top);
    return this;
  }

  /**
   * Rounds the rectangle outwards to whole pixels.
   *
   * @returns This scissor, for chaining.
   */
  public round(): this {
    const right = Math.ceil(this.x + this.width);
    const bottom = Math.ceil(this.y + this.height);
    this.x = Math.floor(this.x);
    this.y = Math.floor(this.y);
    this.width = Math.max(0, right - this.x);
    this.height = Math.max(0, bottom - this.y);
    return this;
  }

  /** @returns A human-readable description. */
  public override toString(): string {
    return `Scissor(${this.x}, ${this.y}, ${this.width}, ${this.height})`;
  }
}

/**
 * Clamps an arbitrary scissor-like rectangle to a surface.
 *
 * @param scissor Rectangle to clamp.
 * @param boundsWidth Width of the enclosing surface.
 * @param boundsHeight Height of the enclosing surface.
 * @returns A fresh, clamped rectangle.
 */
export function clampScissor(
  scissor: ScissorRect,
  boundsWidth: number,
  boundsHeight: number,
): ScissorRect {
  const result = new Scissor(scissor.x, scissor.y, scissor.width, scissor.height);
  result.clampTo(boundsWidth, boundsHeight);
  return result.toObject();
}
