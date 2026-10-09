/**
 * `Mat3` — a 3x3 matrix stored in **column-major** order.
 *
 * ```text
 *   elements = [ n11, n21, n31,   n12, n22, n32,   n13, n23, n33 ]
 *                └── column 0 ──┘ └── column 1 ──┘ └── column 2 ──┘
 * ```
 *
 * This matches the memory layout expected by WebGL `uniformMatrix3fv` and the
 * `mat3x3<f32>` alignment rules of WGSL, so a `Mat3` can be uploaded verbatim.
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import type { Euler } from './Euler';
import type { Mat4 } from './Mat4';
import type { Quat } from './Quat';
import { Vec3 } from './Vec3';

/** A 3x3 matrix in column-major order. */
export class Mat3 {
  /** The nine elements in column-major order. */
  public readonly elements: Float32Array;

  /** Creates an identity matrix, or one initialised from a column-major array. */
  constructor(elements?: ArrayLike<number>) {
    this.elements = new Float32Array(9);
    if (elements) this.fromArray(elements);
    else this.identity();
  }

  /* ---------------------------------------------------------------- static */

  /** A new identity matrix. */
  public static identity(): Mat3 {
    return new Mat3();
  }

  /** A new zero matrix. */
  public static zero(): Mat3 {
    const m = new Mat3();
    m.elements.fill(0);
    return m;
  }

  /** Builds a matrix from nine column-major values. */
  public static of(
    n11: number,
    n21: number,
    n31: number,
    n12: number,
    n22: number,
    n32: number,
    n13: number,
    n23: number,
    n33: number,
  ): Mat3 {
    return new Mat3().set(n11, n21, n31, n12, n22, n32, n13, n23, n33);
  }

  /** Builds a matrix from a column-major array. */
  public static fromArray(array: ArrayLike<number>): Mat3 {
    return new Mat3().fromArray(array);
  }

  /** Builds a scale matrix. */
  public static fromScale(x: number, y: number = x, z: number = x): Mat3 {
    return new Mat3().makeScale(x, y, z);
  }

  /** Builds a rotation matrix around `axis` by `angle` radians. */
  public static fromAxisAngle(axis: Vec3, angle: number): Mat3 {
    return new Mat3().makeRotationAxis(axis, angle);
  }

  /** Builds a rotation matrix from an Euler triple. */
  public static fromEuler(euler: Euler): Mat3 {
    return new Mat3().makeRotationFromEuler(euler);
  }

  /** Builds a rotation matrix from a quaternion. */
  public static fromQuat(q: Quat): Mat3 {
    return new Mat3().makeRotationFromQuat(q);
  }

  /** Builds a rotation matrix from a 4x4 matrix's upper-left 3x3 block. */
  public static fromMat4(m: Mat4): Mat3 {
    return new Mat3().setFromMat4(m);
  }

  /** Builds the outer product `a * bᵀ`. */
  public static fromOuterProduct(a: Vec3, b: Vec3): Mat3 {
    return new Mat3().makeOuterProduct(a, b);
  }

  /** Builds the skew-symmetric cross-product matrix of `v`. */
  public static fromCrossProduct(v: Vec3): Mat3 {
    return new Mat3().makeCrossProduct(v);
  }

  /** Builds the normal matrix (inverse transpose) of a 4x4 model matrix. */
  public static normalMatrix(m: Mat4, target: Mat3 = new Mat3()): Mat3 {
    return target.getNormalMatrix(m);
  }

  /* ------------------------------------------------------------ assignment */

  /** Sets all nine elements (column-major). */
  public set(
    n11: number,
    n21: number,
    n31: number,
    n12: number,
    n22: number,
    n32: number,
    n13: number,
    n23: number,
    n33: number,
  ): this {
    const e = this.elements;
    e[0] = n11;
    e[1] = n21;
    e[2] = n31;
    e[3] = n12;
    e[4] = n22;
    e[5] = n32;
    e[6] = n13;
    e[7] = n23;
    e[8] = n33;
    return this;
  }

  /** Sets every element from a column-major array. */
  public fromArray(array: ArrayLike<number>, offset: number = 0): this {
    const e = this.elements;
    for (let i = 0; i < 9; i++) e[i] = array[offset + i] ?? 0;
    return this;
  }

  /** Resets to the identity matrix. */
  public identity(): this {
    return this.set(1, 0, 0, 0, 1, 0, 0, 0, 1);
  }

  /** Sets every element to `scalar`. */
  public setScalar(scalar: number): this {
    const e = this.elements;
    for (let i = 0; i < 9; i++) e[i] = scalar;
    return this;
  }

  /** Copies another matrix. */
  public copy(m: Mat3): this {
    return this.fromArray(m.elements);
  }

  /** Returns a new matrix with the same elements. */
  public clone(): Mat3 {
    return new Mat3().copy(this);
  }

  /** Copies the upper-left 3x3 block of a 4x4 matrix. */
  public setFromMat4(m: Mat4): this {
    const me = m.elements;
    return this.set(me[0], me[1], me[2], me[4], me[5], me[6], me[8], me[9], me[10]);
  }

  /* -------------------------------------------------------------- products */

  /** `this = this * m`. */
  public multiply(m: Mat3): this {
    return this.multiplyMatrices(this, m);
  }

  /** `this = m * this`. */
  public premultiply(m: Mat3): this {
    return this.multiplyMatrices(m, this);
  }

  /** `this = a * b`. */
  public multiplyMatrices(a: Mat3, b: Mat3): this {
    const ae = a.elements;
    const be = b.elements;
    const te = this.elements;

    const a11 = ae[0];
    const a12 = ae[3];
    const a13 = ae[6];
    const a21 = ae[1];
    const a22 = ae[4];
    const a23 = ae[7];
    const a31 = ae[2];
    const a32 = ae[5];
    const a33 = ae[8];

    const b11 = be[0];
    const b12 = be[3];
    const b13 = be[6];
    const b21 = be[1];
    const b22 = be[4];
    const b23 = be[7];
    const b31 = be[2];
    const b32 = be[5];
    const b33 = be[8];

    te[0] = a11 * b11 + a12 * b21 + a13 * b31;
    te[3] = a11 * b12 + a12 * b22 + a13 * b32;
    te[6] = a11 * b13 + a12 * b23 + a13 * b33;

    te[1] = a21 * b11 + a22 * b21 + a23 * b31;
    te[4] = a21 * b12 + a22 * b22 + a23 * b32;
    te[7] = a21 * b13 + a22 * b23 + a23 * b33;

    te[2] = a31 * b11 + a32 * b21 + a33 * b31;
    te[5] = a31 * b12 + a32 * b22 + a33 * b32;
    te[8] = a31 * b13 + a32 * b23 + a33 * b33;

    return this;
  }

  /** Multiplies every element by `scalar`. */
  public multiplyScalar(scalar: number): this {
    const e = this.elements;
    for (let i = 0; i < 9; i++) e[i] *= scalar;
    return this;
  }

  /** `this = a + b`, element-wise. */
  public addMatrices(a: Mat3, b: Mat3): this {
    const ae = a.elements;
    const be = b.elements;
    const e = this.elements;
    for (let i = 0; i < 9; i++) e[i] = ae[i] + be[i];
    return this;
  }

  /** `this = a - b`, element-wise. */
  public subMatrices(a: Mat3, b: Mat3): this {
    const ae = a.elements;
    const be = b.elements;
    const e = this.elements;
    for (let i = 0; i < 9; i++) e[i] = ae[i] - be[i];
    return this;
  }

  /** Scales the columns by a `Vec3` (equivalent to `this * scaleMatrix`). */
  public scale(v: Vec3): this {
    const e = this.elements;
    e[0] *= v.x;
    e[1] *= v.x;
    e[2] *= v.x;
    e[3] *= v.y;
    e[4] *= v.y;
    e[5] *= v.y;
    e[6] *= v.z;
    e[7] *= v.z;
    e[8] *= v.z;
    return this;
  }

  /** Post-multiplies by a scale matrix. */
  public scaleBy(sx: number, sy: number, sz: number): this {
    return this.multiply(new Mat3().makeScale(sx, sy, sz));
  }

  /* ---------------------------------------------------------- construction */

  /** Builds a rotation matrix around `axis` by `angle` radians. */
  public makeRotationAxis(axis: Vec3, angle: number): this {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    const x = axis.x;
    const y = axis.y;
    const z = axis.z;
    const length = Math.hypot(x, y, z);
    if (length === 0) return this.identity();
    const nx = x / length;
    const ny = y / length;
    const nz = z / length;

    return this.set(
      t * nx * nx + c,
      t * nx * ny + s * nz,
      t * nx * nz - s * ny,
      t * nx * ny - s * nz,
      t * ny * ny + c,
      t * ny * nz + s * nx,
      t * nx * nz + s * ny,
      t * ny * nz - s * nx,
      t * nz * nz + c,
    );
  }

  /** Builds a rotation matrix from `Euler` angles. */
  public makeRotationFromEuler(euler: Euler): this {
    const x = euler.x;
    const y = euler.y;
    const z = euler.z;
    const a = Math.cos(x);
    const b = Math.sin(x);
    const c = Math.cos(y);
    const d = Math.sin(y);
    const e = Math.cos(z);
    const f = Math.sin(z);

    switch (euler.order) {
      case 'XYZ': {
        const ae = a * e;
        const af = a * f;
        const be = b * e;
        const bf = b * f;
        return this.set(
          c * e,
          -c * f,
          d,
          af + be * d,
          ae - bf * d,
          -b * c,
          bf - ae * d,
          be + af * d,
          a * c,
        );
      }
      case 'YXZ': {
        const ce = c * e;
        const cf = c * f;
        const de = d * e;
        const df = d * f;
        return this.set(
          ce + df * b,
          de * b - cf,
          a * d,
          a * f,
          a * e,
          -b,
          cf * b - de,
          df + ce * b,
          a * c,
        );
      }
      case 'ZXY': {
        const ce = c * e;
        const cf = c * f;
        const de = d * e;
        const df = d * f;
        return this.set(
          ce - df * b,
          -a * f,
          de + cf * b,
          cf + de * b,
          a * e,
          df - ce * b,
          -a * d,
          b,
          a * c,
        );
      }
      case 'ZYX': {
        const ae = a * e;
        const af = a * f;
        const be = b * e;
        const bf = b * f;
        return this.set(
          c * e,
          be * d - af,
          ae * d + bf,
          c * f,
          ae + bf * d,
          af - be * d,
          -d,
          b * c,
          a * c,
        );
      }
      case 'YZX': {
        const ac = a * c;
        const ad = a * d;
        const bc = b * c;
        const bd = b * d;
        return this.set(
          c * e,
          bd - ac * f,
          bc * f + ad,
          f,
          a * e,
          -b * e,
          -d * e,
          ad * f + bc,
          ac - bd * f,
        );
      }
      case 'XZY': {
        const ac = a * c;
        const ad = a * d;
        const bc = b * c;
        const bd = b * d;
        const ae = a * e;
        return this.set(
          c * e,
          -f,
          d * e,
          ac * f + bd,
          ae - bc * f,
          -b,
          bc - ad * f,
          bd * f + ae,
          a * c,
        );
      }
      default:
        return this.identity();
    }
  }

  /** Builds a rotation matrix from a unit quaternion. */
  public makeRotationFromQuat(q: Quat): this {
    const x = q.x;
    const y = q.y;
    const z = q.z;
    const w = q.w;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;

    return this.set(
      1 - (yy + zz),
      xy + wz,
      xz - wy,
      xy - wz,
      1 - (xx + zz),
      yz + wx,
      xz + wy,
      yz - wx,
      1 - (xx + yy),
    );
  }

  /** Builds a scale matrix. */
  public makeScale(x: number, y: number, z: number): this {
    return this.set(x, 0, 0, 0, y, 0, 0, 0, z);
  }

  /** Builds a matrix that rotates around `+X` by `angle` radians (`+Y` -> `+Z`). */
  public makeRotationX(angle: number): this {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return this.set(1, 0, 0, 0, c, s, 0, -s, c);
  }

  /** Builds a matrix that rotates around `+Y` by `angle` radians (`+Z` -> `+X`). */
  public makeRotationY(angle: number): this {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return this.set(c, 0, -s, 0, 1, 0, s, 0, c);
  }

  /** Builds a matrix that rotates around `+Z` by `angle` radians (`+X` -> `+Y`). */
  public makeRotationZ(angle: number): this {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return this.set(c, s, 0, -s, c, 0, 0, 0, 1);
  }

  /** Builds the outer product `a * bᵀ`. */
  public makeOuterProduct(a: Vec3, b: Vec3): this {
    return this.set(
      a.x * b.x,
      a.y * b.x,
      a.z * b.x,
      a.x * b.y,
      a.y * b.y,
      a.z * b.y,
      a.x * b.z,
      a.y * b.z,
      a.z * b.z,
    );
  }

  /** Builds the skew-symmetric matrix `[v]×` such that `[v]× w = v × w`. */
  public makeCrossProduct(v: Vec3): this {
    return this.set(0, v.z, -v.y, -v.z, 0, v.x, v.y, -v.x, 0);
  }

  /** Builds a matrix that scales along `+X` by `angle` (mirror/shear helper). */
  public makeShear(xy: number, xz: number, yx: number, yz: number, zx: number, zy: number): this {
    return this.set(1, yx, zx, xy, 1, zy, xz, yz, 1);
  }

  /**
   * Builds the normal matrix: the inverse transpose of the upper-left 3x3 block.
   *
   * Required to transform normals correctly under non-uniform scaling. A
   * singular input (zero scale) falls back to the plain upper-left block, which
   * is the best approximation available and keeps normals finite.
   */
  public getNormalMatrix(m: Mat4): this {
    this.setFromMat4(m);
    if (!this.isInvertible()) return this;
    return this.invert().transpose();
  }

  /* ------------------------------------------------------------ transforms */

  /** Transposes the matrix in place. */
  public transpose(): this {
    const e = this.elements;
    let tmp = e[1];
    e[1] = e[3];
    e[3] = tmp;
    tmp = e[2];
    e[2] = e[6];
    e[6] = tmp;
    tmp = e[5];
    e[5] = e[7];
    e[7] = tmp;
    return this;
  }

  /** Inverts the matrix in place. A singular matrix is reset to zero. */
  public invert(): this {
    const e = this.elements;
    const n11 = e[0];
    const n21 = e[1];
    const n31 = e[2];
    const n12 = e[3];
    const n22 = e[4];
    const n32 = e[5];
    const n13 = e[6];
    const n23 = e[7];
    const n33 = e[8];

    const t11 = n33 * n22 - n32 * n23;
    const t12 = n32 * n13 - n33 * n12;
    const t13 = n23 * n12 - n22 * n13;

    const det = n11 * t11 + n21 * t12 + n31 * t13;
    if (det === 0) return this.setScalar(0);

    const detInv = 1 / det;
    e[0] = t11 * detInv;
    e[1] = (n31 * n23 - n33 * n21) * detInv;
    e[2] = (n32 * n21 - n31 * n22) * detInv;
    e[3] = t12 * detInv;
    e[4] = (n33 * n11 - n31 * n13) * detInv;
    e[5] = (n31 * n12 - n32 * n11) * detInv;
    e[6] = t13 * detInv;
    e[7] = (n21 * n13 - n23 * n11) * detInv;
    e[8] = (n22 * n11 - n21 * n12) * detInv;
    return this;
  }

  /** Returns a new inverted matrix. */
  public inverse(): Mat3 {
    return this.clone().invert();
  }

  /** Determinant of the matrix. */
  public determinant(): number {
    const e = this.elements;
    const n11 = e[0];
    const n21 = e[1];
    const n31 = e[2];
    const n12 = e[3];
    const n22 = e[4];
    const n32 = e[5];
    const n13 = e[6];
    const n23 = e[7];
    const n33 = e[8];
    return (
      n11 * (n33 * n22 - n32 * n23) +
      n21 * (n32 * n13 - n33 * n12) +
      n31 * (n23 * n12 - n22 * n13)
    );
  }

  /** Trace (sum of the diagonal). */
  public trace(): number {
    const e = this.elements;
    return e[0] + e[4] + e[8];
  }

  /** Frobenius norm of the matrix. */
  public norm(): number {
    const e = this.elements;
    let total = 0;
    for (let i = 0; i < 9; i++) total += e[i] * e[i];
    return Math.sqrt(total);
  }

  /** Copies `m` and transposes the copy. */
  public copyTranspose(m: Mat3): this {
    return this.copy(m).transpose();
  }

  /** Sets the matrix to its adjugate (classical adjoint). */
  public adjugate(): this {
    const e = this.elements;
    const n11 = e[0];
    const n21 = e[1];
    const n31 = e[2];
    const n12 = e[3];
    const n22 = e[4];
    const n32 = e[5];
    const n13 = e[6];
    const n23 = e[7];
    const n33 = e[8];

    return this.set(
      n33 * n22 - n32 * n23,
      n31 * n23 - n33 * n21,
      n32 * n21 - n31 * n22,
      n32 * n13 - n33 * n12,
      n33 * n11 - n31 * n13,
      n31 * n12 - n32 * n11,
      n23 * n12 - n22 * n13,
      n21 * n13 - n23 * n11,
      n22 * n11 - n21 * n12,
    );
  }

  /* -------------------------------------------------------------- columns */

  /** Writes column `index` into `target`. */
  public getColumn(index: number, target: Vec3 = new Vec3()): Vec3 {
    const e = this.elements;
    const offset = index * 3;
    return target.set(e[offset], e[offset + 1], e[offset + 2]);
  }

  /** Replaces column `index`. */
  public setColumn(index: number, v: Vec3): this {
    const e = this.elements;
    const offset = index * 3;
    e[offset] = v.x;
    e[offset + 1] = v.y;
    e[offset + 2] = v.z;
    return this;
  }

  /** Writes row `index` into `target`. */
  public getRow(index: number, target: Vec3 = new Vec3()): Vec3 {
    const e = this.elements;
    return target.set(e[index], e[index + 3], e[index + 6]);
  }

  /** Replaces row `index`. */
  public setRow(index: number, v: Vec3): this {
    const e = this.elements;
    e[index] = v.x;
    e[index + 3] = v.y;
    e[index + 6] = v.z;
    return this;
  }

  /** Returns the three diagonal elements. */
  public getDiagonal(target: Vec3 = new Vec3()): Vec3 {
    const e = this.elements;
    return target.set(e[0], e[4], e[8]);
  }

  /**
   * Returns `this * v` written into `target`.
   *
   * `target` is allowed to alias `v`: the source is captured first, so the
   * in-place case needs no temporary vector and no allocation.
   */
  public applyToVector(v: Vec3, target: Vec3 = new Vec3()): Vec3 {
    const e = this.elements;
    const x = v.x;
    const y = v.y;
    const z = v.z;
    return target.set(
      e[0] * x + e[3] * y + e[6] * z,
      e[1] * x + e[4] * y + e[7] * z,
      e[2] * x + e[5] * y + e[8] * z,
    );
  }

  /* -------------------------------------------------------------- queries */

  /** `true` when every element is finite. */
  public isFinite(): boolean {
    const e = this.elements;
    for (let i = 0; i < 9; i++) if (!Number.isFinite(e[i])) return false;
    return true;
  }

  /** `true` when the matrix is (close to) the identity. */
  public isIdentity(tolerance: number = EPSILON): boolean {
    const e = this.elements;
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let i = 0; i < 9; i++) if (Math.abs(e[i] - identity[i]) > tolerance) return false;
    return true;
  }

  /** `true` when the determinant is non-zero. */
  public isInvertible(tolerance: number = EPSILON): boolean {
    return Math.abs(this.determinant()) > tolerance;
  }

  /** `true` when every element matches `m` within `tolerance`. */
  public equals(m: Mat3, tolerance: number = EPSILON): boolean {
    const a = this.elements;
    const b = m.elements;
    for (let i = 0; i < 9; i++) if (Math.abs(a[i] - b[i]) > tolerance) return false;
    return true;
  }

  /**
   * Tests whether the matrix is a pure rotation (orthonormal basis, det `+1`).
   */
  public isRotation(tolerance: number = EPSILON): boolean {
    const e = this.elements;
    const c0 = new Vec3(e[0], e[1], e[2]);
    const c1 = new Vec3(e[3], e[4], e[5]);
    const c2 = new Vec3(e[6], e[7], e[8]);
    return (
      Math.abs(c0.lengthSquared() - 1) <= tolerance &&
      Math.abs(c1.lengthSquared() - 1) <= tolerance &&
      Math.abs(c2.lengthSquared() - 1) <= tolerance &&
      Math.abs(c0.dot(c1)) <= tolerance &&
      Math.abs(c0.dot(c2)) <= tolerance &&
      Math.abs(c1.dot(c2)) <= tolerance &&
      Math.abs(this.determinant() - 1) <= tolerance
    );
  }

  /** Extracts the rotation from the matrix as a quaternion (allocating). */
  public toQuat(target: Quat): Quat {
    return target.setFromRotationMatrix(this);
  }

  /* --------------------------------------------------------------- output */

  /** Column-major array of nine numbers. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    const e = this.elements;
    for (let i = 0; i < 9; i++) target[offset + i] = e[i];
    return target;
  }

  /** Row-major array of nine numbers (for serialisation/debug output). */
  public toRowMajorArray(target: number[] = []): number[] {
    const e = this.elements;
    target[0] = e[0];
    target[1] = e[3];
    target[2] = e[6];
    target[3] = e[1];
    target[4] = e[4];
    target[5] = e[7];
    target[6] = e[2];
    target[7] = e[5];
    target[8] = e[8];
    return target;
  }

  /** JSON-friendly column-major array. */
  public toJSON(): number[] {
    return this.toArray();
  }

  /** Human-readable multi-line representation. */
  public toString(precision: number = 4): string {
    const e = this.elements;
    const f = (v: number) => v.toFixed(precision).padStart(precision + 4, ' ');
    return [
      `Mat3 [${f(e[0])}, ${f(e[3])}, ${f(e[6])}]`,
      `     [${f(e[1])}, ${f(e[4])}, ${f(e[7])}]`,
      `     [${f(e[2])}, ${f(e[5])}, ${f(e[8])}]`,
    ].join('\n');
  }

  /** Iterates over the elements in column-major order. */
  public *[Symbol.iterator](): IterableIterator<number> {
    yield* this.elements;
  }
}

/** Creates a `Mat3` from nine column-major values, an array, or nothing (identity). */
export function mat3(...elements: number[]): Mat3 {
  return elements.length === 0 ? new Mat3() : new Mat3().fromArray(elements);
}
