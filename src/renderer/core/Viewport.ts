/**
 * Viewport value class.
 *
 * A mutable, allocation-free rectangle describing the region of the drawing
 * buffer that a frame is projected into. The class is a *value*: it is cheap to
 * copy, cheap to compare, and carries no backend handle.
 *
 * @packageDocumentation
 */

import type { ScissorRect, ViewportLike } from '../interfaces/types';

/**
 * Rectangular region of a drawing buffer, in device pixels.
 *
 * ```ts
 * const viewport = new Viewport(0, 0, 1280, 720);
 * viewport.aspect;        // 16 / 9
 * viewport.toArray();     // [0, 0, 1280, 720]
 * ```
 */
export class Viewport {
  /** Left edge in device pixels. */
  public x: number;

  /** Top edge in device pixels. */
  public y: number;

  /** Width in device pixels. */
  public width: number;

  /** Height in device pixels. */
  public height: number;

  /**
   * Creates a viewport.
   *
   * @param x Left edge. Defaults to `0`.
   * @param y Top edge. Defaults to `0`.
   * @param width Width. Defaults to `0`.
   * @param height Height. Defaults to `0`.
   */
  constructor(x: number = 0, y: number = 0, width: number = 0, height: number = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }

  /**
   * Builds a viewport covering a whole canvas.
   *
   * @param canvas Anything exposing numeric `width`/`height`.
   * @param reuse Optional instance to write into.
   */
  public static fromCanvas(
    canvas: { width: number; height: number },
    reuse: Viewport = new Viewport(),
  ): Viewport {
    return reuse.setFromCanvas(canvas);
  }

  /**
   * Sets all four components.
   *
   * @returns This viewport, for chaining.
   */
  public set(x: number, y: number, width: number, height: number): this {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    return this;
  }

  /**
   * Sets the viewport to cover a whole canvas, starting at the origin.
   *
   * @param canvas Anything exposing numeric `width`/`height`.
   * @returns This viewport, for chaining.
   */
  public setFromCanvas(canvas: { width: number; height: number }): this {
    this.x = 0;
    this.y = 0;
    this.width = Math.max(0, canvas.width);
    this.height = Math.max(0, canvas.height);
    return this;
  }

  /**
   * Copies another viewport (or viewport-like object).
   *
   * @param source Source rectangle.
   * @returns This viewport, for chaining.
   */
  public copy(source: ViewportLike): this {
    this.x = source.x;
    this.y = source.y;
    this.width = source.width;
    this.height = source.height;
    return this;
  }

  /** @returns A new viewport with the same values. */
  public clone(): Viewport {
    return new Viewport(this.x, this.y, this.width, this.height);
  }

  /** @returns `width / height`, or `0` when the height is zero. */
  public get aspect(): number {
    return this.height === 0 ? 0 : this.width / this.height;
  }

  /** @returns `true` when either dimension is non-positive. */
  public get isEmpty(): boolean {
    return this.width <= 0 || this.height <= 0;
  }

  /** @returns The area in square device pixels. */
  public get area(): number {
    return Math.max(0, this.width) * Math.max(0, this.height);
  }

  /**
   * Compares two viewports exactly.
   *
   * @param other Viewport to compare against.
   */
  public equals(other: ViewportLike | null | undefined): boolean {
    if (other == null) return false;
    return this.x === other.x && this.y === other.y && this.width === other.width && this.height === other.height;
  }

  /**
   * Writes the components into an array.
   *
   * @param target Array to write into; a new one is allocated when omitted.
   * @param offset Index of the first slot to write.
   */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    target[offset] = this.x;
    target[offset + 1] = this.y;
    target[offset + 2] = this.width;
    target[offset + 3] = this.height;
    return target;
  }

  /** @returns A plain `{ x, y, width, height }` copy. */
  public toObject(): ViewportLike {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  /** @returns A human-readable description. */
  public toString(): string {
    return `Viewport(${this.x}, ${this.y}, ${this.width}, ${this.height})`;
  }
}

/** Re-exported structural shape, so consumers of this module need one import. */
export type { ScissorRect, ViewportLike };
