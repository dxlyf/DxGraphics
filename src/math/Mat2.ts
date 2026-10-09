/**
 * `Mat2` — a 2x2 matrix stored in **column-major** order.
 *
 * ```text
 *   elements = [ m11, m21,   m12, m22 ]
 * ```
 *
 * Used for 2D gradients, texture-coordinate transforms and the small linear
 * systems solved by the triangulation code.
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import { Vec2 } from './Vec2';

/** A 2x2 matrix in column-major order. */
export class Mat2 {
  /** The four elements in column-major order. */
  public readonly elements: Float32Array;

  /** Creates an identity matrix, or one initialised from a column-major array. */
  constructor(elements?: ArrayLike<number>) {
    this.elements = new Float32Array(4);
    if (elements) this.fromArray(elements);
    else this.identity();
  }

  /* ---------------------------------------------------------------- static */

  /** A new identity matrix. */
  public static identity(): Mat2 {
    return new Mat2();
  }

  /** A new zero matrix. */
  public static zero(): Mat2 {
    return new Mat2([0, 0, 0, 0]);
  }

  /** Builds a matrix from four column-major values. */
  public static of(m11: number, m21: number, m12: number, m22: number): Mat2 {
    return new Mat2([m11, m21, m12, m22]);
  }

  /** Builds a rotation matrix. */
  public static fromRotation(radians: number): Mat2 {
    return new Mat2().makeRotation(radians);
  }

  /** Builds a scale matrix. */
  public static fromScale(x: number, y: number = x): Mat2 {
    return new Mat2().makeScale(x, y);
  }

  /** Builds a shear matrix. */
  public static fromShear(xy: number, yx: number): Mat2 {
    return new Mat2().makeShear(xy, yx);
  }

  /* ------------------------------------------------------------ assignment */

  /** Sets all four elements (column-major). */
  public set(m11: number, m21: number, m12: number, m22: number): this {
    const e = this.elements;
    e[0] = m11;
    e[1] = m21;
    e[2] = m12;
    e[3] = m22;
    return this;
  }

  /** Sets every element from a column-major array. */
  public fromArray(array: ArrayLike<number>, offset: number = 0): this {
    const e = this.elements;
    for (let i = 0; i < 4; i++) e[i] = array[offset + i] ?? 0;
    return this;
  }

  /** Resets to the identity matrix. */
  public identity(): this {
    return this.set(1, 0, 0, 1);
  }

  /** Sets every element to `scalar`. */
  public setScalar(scalar: number): this {
    const e = this.elements;
    for (let i = 0; i < 4; i++) e[i] = scalar;
    return this;
  }

  /** Copies another matrix. */
  public copy(m: Mat2): this {
    return this.fromArray(m.elements);
  }

  /** Returns a new matrix with the same elements. */
  public clone(): Mat2 {
    return new Mat2().copy(this);
  }

  /* -------------------------------------------------------------- products */

  /** `this = this * m`. */
  public multiply(m: Mat2): this {
    return this.multiplyMatrices(this, m);
  }

  /** `this = m * this`. */
  public premultiply(m: Mat2): this {
    return this.multiplyMatrices(m, this);
  }

  /** `this = a * b`. */
  public multiplyMatrices(a: Mat2, b: Mat2): this {
    const ae = a.elements;
    const be = b.elements;
    const te = this.elements;
    const a11 = ae[0];
    const a12 = ae[2];
    const a21 = ae[1];
    const a22 = ae[3];
    const b11 = be[0];
    const b12 = be[2];
    const b21 = be[1];
    const b22 = be[3];
    te[0] = a11 * b11 + a12 * b21;
    te[2] = a11 * b12 + a12 * b22;
    te[1] = a21 * b11 + a22 * b21;
    te[3] = a21 * b12 + a22 * b22;
    return this;
  }

  /** Multiplies every element by `scalar`. */
  public multiplyScalar(scalar: number): this {
    const e = this.elements;
    for (let i = 0; i < 4; i++) e[i] *= scalar;
    return this;
  }

  /** Adds another matrix element-wise. */
  public add(m: Mat2): this {
    const e = this.elements;
    const o = m.elements;
    for (let i = 0; i < 4; i++) e[i] += o[i];
    return this;
  }

  /** Subtracts another matrix element-wise. */
  public sub(m: Mat2): this {
    const e = this.elements;
    const o = m.elements;
    for (let i = 0; i < 4; i++) e[i] -= o[i];
    return this;
  }

  /** Post-multiplies the columns by a 2D scale. */
  public scale(v: Vec2): this {
    const e = this.elements;
    e[0] *= v.x;
    e[1] *= v.x;
    e[2] *= v.y;
    e[3] *= v.y;
    return this;
  }

  /** Rotates the matrix by `radians` (post-multiplies a rotation). */
  public rotate(radians: number): this {
    return this.multiply(new Mat2().makeRotation(radians));
  }

  /* ---------------------------------------------------------- construction */

  /** Builds a rotation matrix (`+theta` is counter-clockwise in a Y-up system). */
  public makeRotation(radians: number): this {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return this.set(c, s, -s, c);
  }

  /** Builds a scale matrix. */
  public makeScale(x: number, y: number): this {
    return this.set(x, 0, 0, y);
  }

  /** Builds a shear matrix. */
  public makeShear(xy: number, yx: number): this {
    return this.set(1, yx, xy, 1);
  }

  /* ------------------------------------------------------------ transforms */

  /** Transposes the matrix in place. */
  public transpose(): this {
    const e = this.elements;
    const tmp = e[1];
    e[1] = e[2];
    e[2] = tmp;
    return this;
  }

  /** Inverts the matrix in place. A singular matrix is reset to zero. */
  public invert(): this {
    const e = this.elements;
    const a = e[0];
    const b = e[1];
    const c = e[2];
    const d = e[3];
    const det = a * d - b * c;
    if (det === 0) return this.setScalar(0);
    const detInv = 1 / det;
    e[0] = d * detInv;
    e[1] = -b * detInv;
    e[2] = -c * detInv;
    e[3] = a * detInv;
    return this;
  }

  /** Returns a new inverted matrix. */
  public inverse(): Mat2 {
    return this.clone().invert();
  }

  /** Determinant of the matrix. */
  public determinant(): number {
    const e = this.elements;
    return e[0] * e[3] - e[1] * e[2];
  }

  /** Trace (sum of the diagonal). */
  public trace(): number {
    const e = this.elements;
    return e[0] + e[3];
  }

  /** Applies the matrix to a 2D vector: `this * v`. */
  public applyToVector(v: Vec2, target: Vec2 = new Vec2()): Vec2 {
    const e = this.elements;
    return target.set(e[0] * v.x + e[2] * v.y, e[1] * v.x + e[3] * v.y);
  }

  /** Applies the matrix to a point (identical to {@link applyToVector} for 2x2). */
  public applyToPoint(point: Vec2, target: Vec2 = new Vec2()): Vec2 {
    return this.applyToVector(point, target);
  }

  /**
   * Solves `this * x = b` for `x`.
   *
   * @returns `null` when the matrix is singular.
   */
  public solve(b: Vec2, target: Vec2 = new Vec2()): Vec2 | null {
    const det = this.determinant();
    if (Math.abs(det) <= EPSILON) return null;
    const e = this.elements;
    const invDet = 1 / det;
    return target.set(
      (e[3] * b.x - e[2] * b.y) * invDet,
      (-e[1] * b.x + e[0] * b.y) * invDet,
    );
  }

  /* -------------------------------------------------------------- queries */

  /** `true` when every element is finite. */
  public isFinite(): boolean {
    const e = this.elements;
    for (let i = 0; i < 4; i++) if (!Number.isFinite(e[i])) return false;
    return true;
  }

  /** `true` when the matrix is (close to) the identity. */
  public isIdentity(tolerance: number = EPSILON): boolean {
    const e = this.elements;
    return (
      Math.abs(e[0] - 1) <= tolerance &&
      Math.abs(e[1]) <= tolerance &&
      Math.abs(e[2]) <= tolerance &&
      Math.abs(e[3] - 1) <= tolerance
    );
  }

  /** `true` when the determinant is non-zero. */
  public isInvertible(tolerance: number = EPSILON): boolean {
    return Math.abs(this.determinant()) > tolerance;
  }

  /** `true` when every element matches `m` within `tolerance`. */
  public equals(m: Mat2, tolerance: number = EPSILON): boolean {
    const a = this.elements;
    const b = m.elements;
    for (let i = 0; i < 4; i++) if (Math.abs(a[i] - b[i]) > tolerance) return false;
    return true;
  }

  /* --------------------------------------------------------------- output */

  /** Column-major array of four numbers. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    const e = this.elements;
    for (let i = 0; i < 4; i++) target[offset + i] = e[i];
    return target;
  }

  /** JSON-friendly column-major array. */
  public toJSON(): number[] {
    return this.toArray();
  }

  /** Human-readable representation. */
  public toString(precision: number = 4): string {
    const e = this.elements;
    const f = (v: number) => v.toFixed(precision);
    return `Mat2 [${f(e[0])}, ${f(e[2])}]\n     [${f(e[1])}, ${f(e[3])}]`;
  }

  /** Iterates over the elements in column-major order. */
  public *[Symbol.iterator](): IterableIterator<number> {
    yield* this.elements;
  }
}

/** Creates a `Mat2` from four column-major values or a column-major array. */
export function mat2(...values: number[]): Mat2 {
  return values.length === 0 ? new Mat2() : new Mat2(values);
}
