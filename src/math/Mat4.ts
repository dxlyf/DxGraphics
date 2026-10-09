/**
 * `Mat4` — a 4x4 matrix stored in **column-major** order.
 *
 * ```text
 *   elements = [ m11 m21 m31 m41   m12 m22 m32 m42   m13 m23 m33 m43   m14 m24 m34 m44 ]
 * ```
 *
 * Column-major is the layout WebGL's `uniformMatrix4fv` and WGSL's `mat4x4<f32>`
 * expect, and every matrix produced by this library is directly uploadable.
 *
 * Transform conventions: matrices act on **column vectors** (`v' = M * v`), so
 * composing a child's world matrix is `world = parentWorld * local`.
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import { Vec3 } from './Vec3';
import { Vec4 } from './Vec4';
import type { Euler } from './Euler';
import type { Mat3 } from './Mat3';
import type { Quat } from './Quat';

/** Euler rotation order, re-declared structurally to avoid a runtime import. */
type EulerOrderName = 'XYZ' | 'YXZ' | 'ZXY' | 'ZYX' | 'YZX' | 'XZY';

/** A 4x4 matrix in column-major order. */
export class Mat4 {
  /** The sixteen elements in column-major order. */
  public readonly elements: Float32Array;

  /** Creates an identity matrix, or one initialised from a column-major array. */
  constructor(elements?: ArrayLike<number>) {
    this.elements = new Float32Array(16);
    if (elements) this.fromArray(elements);
    else this.identity();
  }

  /* ---------------------------------------------------------------- static */

  /** A new identity matrix. */
  public static identity(): Mat4 {
    return new Mat4();
  }

  /** A new zero matrix. */
  public static zero(): Mat4 {
    return new Mat4().setScalar(0);
  }

  /** Builds a matrix from sixteen column-major values. */
  public static of(
    m11: number,
    m21: number,
    m31: number,
    m41: number,
    m12: number,
    m22: number,
    m32: number,
    m42: number,
    m13: number,
    m23: number,
    m33: number,
    m43: number,
    m14: number,
    m24: number,
    m34: number,
    m44: number,
  ): Mat4 {
    return new Mat4().set(
      m11, m21, m31, m41,
      m12, m22, m32, m42,
      m13, m23, m33, m43,
      m14, m24, m34, m44,
    );
  }

  /** Builds a matrix from a column-major array. */
  public static fromArray(array: ArrayLike<number>): Mat4 {
    return new Mat4().fromArray(array);
  }

  /** Builds a translation matrix. */
  public static fromTranslation(v: Vec3): Mat4 {
    return new Mat4().makeTranslation(v.x, v.y, v.z);
  }

  /** Builds a scale matrix. */
  public static fromScale(v: Vec3): Mat4 {
    return new Mat4().makeScale(v.x, v.y, v.z);
  }

  /** Builds a rotation matrix around `axis` (unit) by `angle` radians. */
  public static fromAxisAngle(axis: Vec3, angle: number): Mat4 {
    return new Mat4().makeRotationAxis(axis, angle);
  }

  /** Builds a rotation matrix from an Euler triple. */
  public static fromEuler(euler: Euler): Mat4 {
    return new Mat4().makeRotationFromEuler(euler);
  }

  /** Builds a rotation matrix from a quaternion. */
  public static fromQuat(q: Quat): Mat4 {
    return new Mat4().makeRotationFromQuat(q);
  }

  /** Builds a matrix from a position, rotation and scale. */
  public static fromCompose(position: Vec3, quaternion: Quat, scale: Vec3): Mat4 {
    return new Mat4().compose(position, quaternion, scale);
  }

  /** Builds a right-handed perspective projection matrix (OpenGL depth range). */
  public static fromPerspective(
    fovYRadians: number,
    aspect: number,
    near: number,
    far: number,
  ): Mat4 {
    return new Mat4().makePerspective(fovYRadians, aspect, near, far);
  }

  /** Builds a right-handed orthographic projection matrix. */
  public static fromOrthographic(
    left: number,
    right: number,
    top: number,
    bottom: number,
    near: number,
    far: number,
  ): Mat4 {
    return new Mat4().makeOrthographic(left, right, top, bottom, near, far);
  }

  /** Builds a view matrix (look-at). */
  public static fromLookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
    return new Mat4().lookAt(eye, target, up);
  }

  /** Builds a basis matrix from three column vectors and an origin. */
  public static fromBasis(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3, origin: Vec3): Mat4 {
    return new Mat4().makeBasis(xAxis, yAxis, zAxis, origin);
  }

  /* ------------------------------------------------------------ assignment */

  /** Sets all sixteen elements (column-major). */
  public set(
    m11: number,
    m21: number,
    m31: number,
    m41: number,
    m12: number,
    m22: number,
    m32: number,
    m42: number,
    m13: number,
    m23: number,
    m33: number,
    m43: number,
    m14: number,
    m24: number,
    m34: number,
    m44: number,
  ): this {
    const e = this.elements;
    e[0] = m11;
    e[1] = m21;
    e[2] = m31;
    e[3] = m41;
    e[4] = m12;
    e[5] = m22;
    e[6] = m32;
    e[7] = m42;
    e[8] = m13;
    e[9] = m23;
    e[10] = m33;
    e[11] = m43;
    e[12] = m14;
    e[13] = m24;
    e[14] = m34;
    e[15] = m44;
    return this;
  }

  /** Sets every element from a column-major array. */
  public fromArray(array: ArrayLike<number>, offset: number = 0): this {
    const e = this.elements;
    for (let i = 0; i < 16; i++) e[i] = array[offset + i] ?? 0;
    return this;
  }

  /** Resets to the identity matrix. */
  public identity(): this {
    return this.set(
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );
  }

  /** Sets every element to `scalar`. */
  public setScalar(scalar: number): this {
    const e = this.elements;
    for (let i = 0; i < 16; i++) e[i] = scalar;
    return this;
  }

  /** Copies another matrix. */
  public copy(m: Mat4): this {
    return this.fromArray(m.elements);
  }

  /** Returns a new matrix with the same elements. */
  public clone(): Mat4 {
    return new Mat4().copy(this);
  }

  /** Copies the tuple stored in another matrix's elements array. */
  public setPosition(v: Vec3 | number, y?: number, z?: number): this {
    const e = this.elements;
    if (typeof v === 'number') {
      e[12] = v;
      e[13] = y ?? 0;
      e[14] = z ?? 0;
    } else {
      e[12] = v.x;
      e[13] = v.y;
      e[14] = v.z;
    }
    return this;
  }

  /** Copies the upper-left 3x3 block of `m` into this matrix. */
  public setFromMat3(m: Mat3): this {
    const e = this.elements;
    const me = m.elements;
    e[0] = me[0];
    e[1] = me[1];
    e[2] = me[2];
    e[4] = me[3];
    e[5] = me[4];
    e[6] = me[5];
    e[8] = me[6];
    e[9] = me[7];
    e[10] = me[8];
    return this;
  }

  /* -------------------------------------------------------------- products */

  /** `this = this * m`. */
  public multiply(m: Mat4): this {
    return this.multiplyMatrices(this, m);
  }

  /** `this = m * this`. */
  public premultiply(m: Mat4): this {
    return this.multiplyMatrices(m, this);
  }

  /**
   * `this = a * b`.
   *
   * Matrices are column-major: column `c` of `a` lives at `ae[4c .. 4c+3]`.
   * Multiplying a matrix by a column vector produces the linear combination of
   * its columns, so
   *
   * ```text
   * column c of (a * b) = a * (column c of b)
   *                     = a0 * b[c][0] + a1 * b[c][1] + a2 * b[c][2] + a3 * b[c][3]
   * ```
   *
   * where `ak` is column `k` of `a`. Writing the method that way keeps each term
   * self-evidently correct — there is no row/column index arithmetic left to get
   * wrong, which is the mistake this method previously contained.
   *
   * `this` may alias `a` or `b`: both operands are read into locals first.
   */
  public multiplyMatrices(a: Mat4, b: Mat4): this {
    const ae = a.elements;
    const be = b.elements;
    const te = this.elements;

    // Columns of `a`, hoisted so `this` may alias `a`.
    const c0x = ae[0], c0y = ae[1], c0z = ae[2], c0w = ae[3];
    const c1x = ae[4], c1y = ae[5], c1z = ae[6], c1w = ae[7];
    const c2x = ae[8], c2y = ae[9], c2z = ae[10], c2w = ae[11];
    const c3x = ae[12], c3y = ae[13], c3z = ae[14], c3w = ae[15];

    // Columns of `b`, hoisted so `this` may alias `b`.
    const d0 = be[0], d1 = be[1], d2 = be[2], d3 = be[3];
    const d4 = be[4], d5 = be[5], d6 = be[6], d7 = be[7];
    const d8 = be[8], d9 = be[9], d10 = be[10], d11 = be[11];
    const d12 = be[12], d13 = be[13], d14 = be[14], d15 = be[15];

    // Column 0 of the product = a * (d0, d1, d2, d3).
    te[0] = c0x * d0 + c1x * d1 + c2x * d2 + c3x * d3;
    te[1] = c0y * d0 + c1y * d1 + c2y * d2 + c3y * d3;
    te[2] = c0z * d0 + c1z * d1 + c2z * d2 + c3z * d3;
    te[3] = c0w * d0 + c1w * d1 + c2w * d2 + c3w * d3;

    // Column 1 = a * (d4, d5, d6, d7).
    te[4] = c0x * d4 + c1x * d5 + c2x * d6 + c3x * d7;
    te[5] = c0y * d4 + c1y * d5 + c2y * d6 + c3y * d7;
    te[6] = c0z * d4 + c1z * d5 + c2z * d6 + c3z * d7;
    te[7] = c0w * d4 + c1w * d5 + c2w * d6 + c3w * d7;

    // Column 2 = a * (d8, d9, d10, d11).
    te[8] = c0x * d8 + c1x * d9 + c2x * d10 + c3x * d11;
    te[9] = c0y * d8 + c1y * d9 + c2y * d10 + c3y * d11;
    te[10] = c0z * d8 + c1z * d9 + c2z * d10 + c3z * d11;
    te[11] = c0w * d8 + c1w * d9 + c2w * d10 + c3w * d11;

    // Column 3 = a * (d12, d13, d14, d15).
    te[12] = c0x * d12 + c1x * d13 + c2x * d14 + c3x * d15;
    te[13] = c0y * d12 + c1y * d13 + c2y * d14 + c3y * d15;
    te[14] = c0z * d12 + c1z * d13 + c2z * d14 + c3z * d15;
    te[15] = c0w * d12 + c1w * d13 + c2w * d14 + c3w * d15;

    return this;
  }
  /** Multiplies every element by `scalar`. */
  public multiplyScalar(scalar: number): this {
    const e = this.elements;
    for (let i = 0; i < 16; i++) e[i] *= scalar;
    return this;
  }

  /**
   * Post-multiplies by a translation.
   *
   * Equivalent to `this * translation(tx, ty, tz)` but avoids building the
   * translation matrix.
   */
  public translate(tx: number, ty: number, tz: number): this {
    const e = this.elements;
    e[12] = e[0] * tx + e[4] * ty + e[8] * tz + e[12];
    e[13] = e[1] * tx + e[5] * ty + e[9] * tz + e[13];
    e[14] = e[2] * tx + e[6] * ty + e[10] * tz + e[14];
    e[15] = e[3] * tx + e[7] * ty + e[11] * tz + e[15];
    return this;
  }

  /** Multiplies the columns by a `Vec3`, i.e. `this * scaleMatrix(s)`. */
  public scale(v: Vec3): this {
    const e = this.elements;
    e[0] *= v.x;
    e[1] *= v.x;
    e[2] *= v.x;
    e[3] *= v.x;
    e[4] *= v.y;
    e[5] *= v.y;
    e[6] *= v.y;
    e[7] *= v.y;
    e[8] *= v.z;
    e[9] *= v.z;
    e[10] *= v.z;
    e[11] *= v.z;
    return this;
  }

  /* ---------------------------------------------------------- construction */

  /** Builds a translation matrix. */
  public makeTranslation(tx: number, ty: number, tz: number): this {
    return this.set(
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      tx, ty, tz, 1,
    );
  }

  /** Builds a scale matrix. */
  public makeScale(sx: number, sy: number, sz: number): this {
    return this.set(
      sx, 0, 0, 0,
      0, sy, 0, 0,
      0, 0, sz, 0,
      0, 0, 0, 1,
    );
  }

  /**
   * Builds a matrix that rotates around `+X` by `angle` radians.
   *
   * Elements are listed column-major, i.e. the first four arguments are column 0.
   * A right-handed column-vector rotation maps `+Y` to `+Z`, so column 1 is
   * `(0, cos, sin)` and column 2 is `(0, -sin, cos)`.
   */
  public makeRotationX(angle: number): this {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return this.set(
      1, 0, 0, 0,
      0, c, s, 0,
      0, -s, c, 0,
      0, 0, 0, 1,
    );
  }

  /** Builds a matrix that rotates around `+Y` by `angle` radians (`+Z` -> `+X`). */
  public makeRotationY(angle: number): this {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return this.set(
      c, 0, -s, 0,
      0, 1, 0, 0,
      s, 0, c, 0,
      0, 0, 0, 1,
    );
  }

  /** Builds a matrix that rotates around `+Z` by `angle` radians (`+X` -> `+Y`). */
  public makeRotationZ(angle: number): this {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return this.set(
      c, s, 0, 0,
      -s, c, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );
  }

  /** Builds a matrix that rotates around the unit `axis` by `angle` radians. */
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
      0,
      t * nx * ny - s * nz,
      t * ny * ny + c,
      t * ny * nz + s * nx,
      0,
      t * nx * nz + s * ny,
      t * ny * nz - s * nx,
      t * nz * nz + c,
      0,
      0, 0, 0, 1,
    );
  }

  /**
   * Writes the rotation matrix for a single axis into a 3x3 block.
   *
   * @param axis `0` = X, `1` = Y, `2` = Z.
   * @param angle Rotation in radians.
   * @param out Receives nine column-major values.
   */
  private static writeAxisRotation(axis: number, angle: number, out: Float64Array): void {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    switch (axis) {
      case 0: // X: +Y -> +Z, +Z -> -Y
        out[0] = 1; out[1] = 0; out[2] = 0;
        out[3] = 0; out[4] = c; out[5] = s;
        out[6] = 0; out[7] = -s; out[8] = c;
        break;
      case 1: // Y: +Z -> +X, +X -> -Z
        out[0] = c; out[1] = 0; out[2] = -s;
        out[3] = 0; out[4] = 1; out[5] = 0;
        out[6] = s; out[7] = 0; out[8] = c;
        break;
      default: // Z: +X -> +Y, +Y -> -X
        out[0] = c; out[1] = s; out[2] = 0;
        out[3] = -s; out[4] = c; out[5] = 0;
        out[6] = 0; out[7] = 0; out[8] = 1;
        break;
    }
  }

  /** Multiplies two column-major 3x3 blocks: `out = a * b`. */
  private static multiplyRotationBlocks(a: Float64Array, b: Float64Array, out: Float64Array): void {
    const a00 = a[0], a01 = a[3], a02 = a[6];
    const a10 = a[1], a11 = a[4], a12 = a[7];
    const a20 = a[2], a21 = a[5], a22 = a[8];
    const b00 = b[0], b01 = b[3], b02 = b[6];
    const b10 = b[1], b11 = b[4], b12 = b[7];
    const b20 = b[2], b21 = b[5], b22 = b[8];

    out[0] = a00 * b00 + a01 * b10 + a02 * b20;
    out[3] = a00 * b01 + a01 * b11 + a02 * b21;
    out[6] = a00 * b02 + a01 * b12 + a02 * b22;

    out[1] = a10 * b00 + a11 * b10 + a12 * b20;
    out[4] = a10 * b01 + a11 * b11 + a12 * b21;
    out[7] = a10 * b02 + a11 * b12 + a12 * b22;

    out[2] = a20 * b00 + a21 * b10 + a22 * b20;
    out[5] = a20 * b01 + a21 * b11 + a22 * b21;
    out[8] = a20 * b02 + a21 * b12 + a22 * b22;
  }

  /** Maps an order letter to its axis index. */
  private static axisIndex(letter: string): number {
    return letter === 'x' ? 0 : letter === 'y' ? 1 : 2;
  }

  /** Scratch buffers reused by the Euler composition (never exposed). */
  private static readonly rotationA = new Float64Array(9);
  private static readonly rotationB = new Float64Array(9);
  private static readonly rotationC = new Float64Array(9);
  private static readonly rotationTmp = new Float64Array(9);

  /** Builds a rotation matrix from `Euler` angles (radians). */
  public makeRotationFromEuler(euler: Euler): this {
    const order = (euler.order ?? 'XYZ').toLowerCase();
    const angles = [euler.x, euler.y, euler.z] as const;

    // Compose the three axis rotations in the order the name lists them:
    // 'XYZ' means "rotate about X, then the new Y, then the new Z", which as a
    // product of column-vector matrices is Rx * Ry * Rz. Composing (rather than
    // expanding a 15-term closed form per order) guarantees this agrees exactly
    // with makeRotationX/Y/Z instead of drifting from them.
    const first = Mat4.axisIndex(order.charAt(0));
    const second = Mat4.axisIndex(order.charAt(1));
    const third = Mat4.axisIndex(order.charAt(2));

    Mat4.writeAxisRotation(first, angles[first], Mat4.rotationA);
    Mat4.writeAxisRotation(second, angles[second], Mat4.rotationB);
    Mat4.writeAxisRotation(third, angles[third], Mat4.rotationC);

    Mat4.multiplyRotationBlocks(Mat4.rotationA, Mat4.rotationB, Mat4.rotationTmp);
    Mat4.multiplyRotationBlocks(Mat4.rotationTmp, Mat4.rotationC, Mat4.rotationA);

    const r = Mat4.rotationA;
    const e = this.elements;
    e[0] = r[0]; e[1] = r[1]; e[2] = r[2];
    e[4] = r[3]; e[5] = r[4]; e[6] = r[5];
    e[8] = r[6]; e[9] = r[7]; e[10] = r[8];
    e[3] = 0; e[7] = 0; e[11] = 0;
    e[12] = 0; e[13] = 0; e[14] = 0;
    e[15] = 1;
    return this;
  }
  /** Builds a rotation matrix from a unit quaternion. */
  public makeRotationFromQuat(q: Quat): this {
    return this.makeRotationFromQuatElements(q.x, q.y, q.z, q.w);
  }

  /** Builds a rotation matrix from raw quaternion components. */
  public makeRotationFromQuatElements(x: number, y: number, z: number, w: number): this {
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

    const e = this.elements;
    e[0] = 1 - (yy + zz);
    e[4] = xy - wz;
    e[8] = xz + wy;
    e[1] = xy + wz;
    e[5] = 1 - (xx + zz);
    e[9] = yz - wx;
    e[2] = xz - wy;
    e[6] = yz + wx;
    e[10] = 1 - (xx + yy);
    e[3] = 0;
    e[7] = 0;
    e[11] = 0;
    e[12] = 0;
    e[13] = 0;
    e[14] = 0;
    e[15] = 1;
    return this;
  }

  /**
   * Builds a matrix from a position, rotation and scale (TRS).
   *
   * The composed transform applies scale first, then rotation, then translation.
   */
  public compose(position: Vec3, quaternion: Quat, scale: Vec3): this {
    const e = this.elements;
    const x = quaternion.x;
    const y = quaternion.y;
    const z = quaternion.z;
    const w = quaternion.w;
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

    const sx = scale.x;
    const sy = scale.y;
    const sz = scale.z;

    e[0] = (1 - (yy + zz)) * sx;
    e[1] = (xy + wz) * sx;
    e[2] = (xz - wy) * sx;
    e[3] = 0;

    e[4] = (xy - wz) * sy;
    e[5] = (1 - (xx + zz)) * sy;
    e[6] = (yz + wx) * sy;
    e[7] = 0;

    e[8] = (xz + wy) * sz;
    e[9] = (yz - wx) * sz;
    e[10] = (1 - (xx + yy)) * sz;
    e[11] = 0;

    e[12] = position.x;
    e[13] = position.y;
    e[14] = position.z;
    e[15] = 1;
    return this;
  }

  /**
   * Decomposes a TRS matrix into position, quaternion and scale.
   *
   * @returns `false` (and leaves the targets untouched) when the matrix is
   *   singular, which happens when a scale component is zero.
   */
  public decompose(position: Vec3, quaternion: Quat, scale: Vec3): boolean {
    const e = this.elements;

    let sx = Math.hypot(e[0], e[1], e[2]);
    const sy = Math.hypot(e[4], e[5], e[6]);
    const sz = Math.hypot(e[8], e[9], e[10]);

    // A negative determinant means the basis is mirrored; fold the flip into X.
    if (this.determinant() < 0) sx = -sx;

    position.x = e[12];
    position.y = e[13];
    position.z = e[14];

    // Build the rotation-only matrix without allocating a second Mat4.
    const invSX = sx !== 0 ? 1 / sx : 0;
    const invSY = sy !== 0 ? 1 / sy : 0;
    const invSZ = sz !== 0 ? 1 / sz : 0;

    const m11 = e[0] * invSX;
    const m12 = e[4] * invSY;
    const m13 = e[8] * invSZ;
    const m21 = e[1] * invSX;
    const m22 = e[5] * invSY;
    const m23 = e[9] * invSZ;
    const m31 = e[2] * invSX;
    const m32 = e[6] * invSY;
    const m33 = e[10] * invSZ;

    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      quaternion.w = 0.25 / s;
      quaternion.x = (m32 - m23) * s;
      quaternion.y = (m13 - m31) * s;
      quaternion.z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
      quaternion.w = (m32 - m23) / s;
      quaternion.x = 0.25 * s;
      quaternion.y = (m12 + m21) / s;
      quaternion.z = (m13 + m31) / s;
    } else if (m22 > m33) {
      const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
      quaternion.w = (m13 - m31) / s;
      quaternion.x = (m12 + m21) / s;
      quaternion.y = 0.25 * s;
      quaternion.z = (m23 + m32) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
      quaternion.w = (m21 - m12) / s;
      quaternion.x = (m13 + m31) / s;
      quaternion.y = (m23 + m32) / s;
      quaternion.z = 0.25 * s;
    }

    scale.x = sx;
    scale.y = sy;
    scale.z = sz;
    return true;
  }

  /** Builds a basis matrix from three column vectors and an origin. */
  public makeBasis(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3, origin: Vec3 = new Vec3()): this {
    return this.set(
      xAxis.x, xAxis.y, xAxis.z, 0,
      yAxis.x, yAxis.y, yAxis.z, 0,
      zAxis.x, zAxis.y, zAxis.z, 0,
      origin.x, origin.y, origin.z, 1,
    );
  }

  /** Builds a shear matrix. */
  public makeShear(
    xy: number,
    xz: number,
    yx: number,
    yz: number,
    zx: number,
    zy: number,
  ): this {
    return this.set(
      1, yx, zx, 0,
      xy, 1, zy, 0,
      xz, yz, 1, 0,
      0, 0, 0, 1,
    );
  }

  /**
   * Builds a right-handed perspective projection matrix with an OpenGL depth
   * range of `[-1, 1]` (what WebGL expects).
   *
   * @param fovYRadians Vertical field of view in radians.
   * @param aspect Width divided by height.
   * @param near Distance to the near plane (must be > 0).
   * @param far Distance to the far plane (must be > near).
   */
  public makePerspective(fovYRadians: number, aspect: number, near: number, far: number): this {
    if (near <= 0 || far <= near) {
      throw new RangeError(`makePerspective requires 0 < near < far (received ${near}, ${far})`);
    }
    if (aspect <= 0) {
      throw new RangeError(`makePerspective requires a positive aspect (received ${aspect})`);
    }
    const top = near * Math.tan(fovYRadians * 0.5);
    const height = 2 * top;
    const width = aspect * height;
    const left = -0.5 * width;
    return this.makePerspectiveOffCenter(left, left + width, top, top - height, near, far);
  }

  /**
   * Builds a right-handed perspective matrix from explicit frustum planes.
   *
   * @param left,right,top,bottom Frustum extents at the near plane (top > bottom).
   */
  public makePerspectiveOffCenter(
    left: number,
    right: number,
    top: number,
    bottom: number,
    near: number,
    far: number,
  ): this {
    const x = (2 * near) / (right - left);
    const y = (2 * near) / (top - bottom);
    const a = (right + left) / (right - left);
    const b = (top + bottom) / (top - bottom);
    const c = -(far + near) / (far - near);
    const d = (-2 * far * near) / (far - near);

    return this.set(
      x, 0, 0, 0,
      0, y, 0, 0,
      a, b, c, -1,
      0, 0, d, 0,
    );
  }

  /** Builds a right-handed orthographic projection matrix. */
  public makeOrthographic(
    left: number,
    right: number,
    top: number,
    bottom: number,
    near: number,
    far: number,
  ): this {
    const w = 1 / (right - left);
    const h = 1 / (top - bottom);
    const p = 1 / (far - near);

    return this.set(
      2 * w, 0, 0, 0,
      0, 2 * h, 0, 0,
      0, 0, -2 * p, 0,
      -(right + left) * w,
      -(top + bottom) * h,
      -(far + near) * p,
      1,
    );
  }

  /** Builds a viewing frustum from a vertical field of view. */
  public makeFrustum(
    left: number,
    right: number,
    bottom: number,
    top: number,
    near: number,
    far: number,
  ): this {
    return this.makePerspectiveOffCenter(left, right, top, bottom, near, far);
  }

  /**
   * Builds a view matrix that looks from `eye` towards `target`.
   *
   * `up` must not be parallel to the view direction; a fallback axis is used when
   * it is (degenerate look-at), matching camera behaviour.
   */
  public lookAt(eye: Vec3, target: Vec3, up: Vec3): this {
    const e = this.elements;

    let zx = eye.x - target.x;
    let zy = eye.y - target.y;
    let zz = eye.z - target.z;
    let length = Math.hypot(zx, zy, zz);
    if (length === 0) {
      zx = 0;
      zy = 0;
      zz = 1;
      length = 1;
    }
    zx /= length;
    zy /= length;
    zz /= length;

    let xx = up.y * zz - up.z * zy;
    let xy = up.z * zx - up.x * zz;
    let xz = up.x * zy - up.y * zx;
    length = Math.hypot(xx, xy, xz);

    if (length === 0) {
      // `up` was parallel to the view direction; pick any perpendicular axis.
      if (Math.abs(zx) > Math.abs(zz)) {
        xx = -zy;
        xy = zx;
        xz = 0;
      } else {
        xx = 0;
        xy = -zz;
        xz = zy;
      }
      length = Math.hypot(xx, xy, xz) || 1;
    }
    xx /= length;
    xy /= length;
    xz /= length;

    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    e[0] = xx;
    e[4] = xy;
    e[8] = xz;
    e[12] = -(xx * eye.x + xy * eye.y + xz * eye.z);

    e[1] = yx;
    e[5] = yy;
    e[9] = yz;
    e[13] = -(yx * eye.x + yy * eye.y + yz * eye.z);

    e[2] = zx;
    e[6] = zy;
    e[10] = zz;
    e[14] = -(zx * eye.x + zy * eye.y + zz * eye.z);

    e[3] = 0;
    e[7] = 0;
    e[11] = 0;
    e[15] = 1;
    return this;
  }

  /* ------------------------------------------------------------ transforms */

  /** Transposes the matrix in place. */
  public transpose(): this {
    const e = this.elements;
    let t: number;
    t = e[1]; e[1] = e[4]; e[4] = t;
    t = e[2]; e[2] = e[8]; e[8] = t;
    t = e[6]; e[6] = e[9]; e[9] = t;
    t = e[3]; e[3] = e[12]; e[12] = t;
    t = e[7]; e[7] = e[13]; e[13] = t;
    t = e[11]; e[11] = e[14]; e[14] = t;
    return this;
  }

  /** Inverts the matrix in place. A singular matrix is reset to zero. */
  public invert(): this {
    const te = this.elements;
    const n11 = te[0];
    const n21 = te[1];
    const n31 = te[2];
    const n41 = te[3];
    const n12 = te[4];
    const n22 = te[5];
    const n32 = te[6];
    const n42 = te[7];
    const n13 = te[8];
    const n23 = te[9];
    const n33 = te[10];
    const n43 = te[11];
    const n14 = te[12];
    const n24 = te[13];
    const n34 = te[14];
    const n44 = te[15];

    const t11 =
      n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
    const t12 =
      n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
    const t13 =
      n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
    const t14 =
      n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;

    const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
    if (det === 0) return this.setScalar(0);

    const detInv = 1 / det;
    te[0] = t11 * detInv;
    te[1] =
      (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * detInv;
    te[2] =
      (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * detInv;
    te[3] =
      (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * detInv;

    te[4] = t12 * detInv;
    te[5] =
      (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * detInv;
    te[6] =
      (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * detInv;
    te[7] =
      (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * detInv;

    te[8] = t13 * detInv;
    te[9] =
      (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * detInv;
    te[10] =
      (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * detInv;
    te[11] =
      (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * detInv;

    te[12] = t14 * detInv;
    te[13] =
      (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * detInv;
    te[14] =
      (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * detInv;
    te[15] =
      (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * detInv;

    return this;
  }

  /** Returns a new inverted matrix. */
  public inverse(): Mat4 {
    return this.clone().invert();
  }

  /** Determinant of the matrix. */
  public determinant(): number {
    const te = this.elements;
    const n11 = te[0];
    const n21 = te[1];
    const n31 = te[2];
    const n41 = te[3];
    const n12 = te[4];
    const n22 = te[5];
    const n32 = te[6];
    const n42 = te[7];
    const n13 = te[8];
    const n23 = te[9];
    const n33 = te[10];
    const n43 = te[11];
    const n14 = te[12];
    const n24 = te[13];
    const n34 = te[14];
    const n44 = te[15];

    return (
      n41 *
        (+n14 * n23 * n32 -
          n13 * n24 * n32 -
          n14 * n22 * n33 +
          n12 * n24 * n33 +
          n13 * n22 * n34 -
          n12 * n23 * n34) +
      n42 *
        (+n11 * n23 * n34 -
          n11 * n24 * n33 +
          n14 * n21 * n33 -
          n13 * n21 * n34 +
          n13 * n24 * n31 -
          n14 * n23 * n31) +
      n43 *
        (+n11 * n24 * n32 -
          n11 * n22 * n34 -
          n14 * n21 * n32 +
          n12 * n21 * n34 +
          n14 * n22 * n31 -
          n12 * n24 * n31) +
      n44 *
        (-n13 * n22 * n31 -
          n11 * n23 * n32 +
          n11 * n22 * n33 +
          n13 * n21 * n32 -
          n12 * n21 * n33 +
          n12 * n23 * n31)
    );
  }

  /* -------------------------------------------------------------- columns */

  /** Writes column `index` into `target`. */
  public getColumn(index: number, target: Vec4 = new Vec4()): Vec4 {
    const e = this.elements;
    const offset = index * 4;
    return target.set(e[offset], e[offset + 1], e[offset + 2], e[offset + 3]);
  }

  /** Replaces column `index`. */
  public setColumn(index: number, v: Vec4): this {
    const e = this.elements;
    const offset = index * 4;
    e[offset] = v.x;
    e[offset + 1] = v.y;
    e[offset + 2] = v.z;
    e[offset + 3] = v.w;
    return this;
  }

  /** Writes row `index` into `target`. */
  public getRow(index: number, target: Vec4 = new Vec4()): Vec4 {
    const e = this.elements;
    return target.set(e[index], e[index + 4], e[index + 8], e[index + 12]);
  }

  /** Replaces row `index`. */
  public setRow(index: number, v: Vec4): this {
    const e = this.elements;
    e[index] = v.x;
    e[index + 4] = v.y;
    e[index + 8] = v.z;
    e[index + 12] = v.w;
    return this;
  }

  /** Extracts the translation component. */
  public getTranslation(target: Vec3 = new Vec3()): Vec3 {
    const e = this.elements;
    return target.set(e[12], e[13], e[14]);
  }

  /** Copies the upper-left 3x3 block into `target`. */
  public getRotation(target: Mat3): Mat3 {
    return target.setFromMat4(this);
  }

  /** Extracts the scale from the basis columns (length of each axis). */
  public getScale(target: Vec3 = new Vec3()): Vec3 {
    const e = this.elements;
    return target.set(
      Math.hypot(e[0], e[1], e[2]),
      Math.hypot(e[4], e[5], e[6]),
      Math.hypot(e[8], e[9], e[10]),
    );
  }

  /** Largest of the three basis scale factors. */
  public getMaxScaleOnAxis(): number {
    const e = this.elements;
    return Math.sqrt(
      Math.max(
        e[0] * e[0] + e[1] * e[1] + e[2] * e[2],
        e[4] * e[4] + e[5] * e[5] + e[6] * e[6],
        e[8] * e[8] + e[9] * e[9] + e[10] * e[10],
      ),
    );
  }

  /* ------------------------------------------------------------ queries */

  /** `true` when every element is finite. */
  public isFinite(): boolean {
    const e = this.elements;
    for (let i = 0; i < 16; i++) if (!Number.isFinite(e[i])) return false;
    return true;
  }

  /** `true` when the matrix is (close to) the identity. */
  public isIdentity(tolerance: number = EPSILON): boolean {
    const e = this.elements;
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let i = 0; i < 16; i++) if (Math.abs(e[i] - identity[i]) > tolerance) return false;
    return true;
  }

  /** `true` when the determinant is non-zero. */
  public isInvertible(tolerance: number = EPSILON): boolean {
    return Math.abs(this.determinant()) > tolerance;
  }

  /** `true` when every element matches `m` within `tolerance`. */
  public equals(m: Mat4, tolerance: number = EPSILON): boolean {
    const a = this.elements;
    const b = m.elements;
    for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > tolerance) return false;
    return true;
  }

  /* --------------------------------------------------------------- output */

  /** Column-major array of sixteen numbers. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    const e = this.elements;
    for (let i = 0; i < 16; i++) target[offset + i] = e[i];
    return target;
  }

  /** Copies the elements into a `Float32Array`. */
  public toFloat32Array(target: Float32Array = new Float32Array(16), offset: number = 0): Float32Array {
    target.set(this.elements, offset);
    return target;
  }

  /** Row-major array of sixteen numbers (for serialisation/debug output). */
  public toRowMajorArray(target: number[] = []): number[] {
    const e = this.elements;
    let index = 0;
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) target[index++] = e[column * 4 + row];
    }
    return target;
  }

  /** JSON-friendly column-major array. */
  public toJSON(): number[] {
    return this.toArray();
  }

  /** Human-readable multi-line representation. */
  public toString(precision: number = 3): string {
    const e = this.elements;
    const f = (v: number) => {
      const text = Number.isFinite(v) ? v.toFixed(precision) : String(v);
      return text.padStart(precision + 4, ' ');
    };
    const rows: string[] = [];
    for (let row = 0; row < 4; row++) {
      const cells = [
        e[row],
        e[row + 4],
        e[row + 8],
        e[row + 12],
      ].map(f);
      rows.push(`[${cells.join(', ')}]`);
    }
    return `Mat4 ${rows.join('\n     ')}`;
  }

  /** Iterates over the elements in column-major order. */
  public *[Symbol.iterator](): IterableIterator<number> {
    yield* this.elements;
  }
}

/** Creates a `Mat4` from a column-major array or nothing (identity). */
export function mat4(elements?: ArrayLike<number>): Mat4 {
  return elements ? new Mat4().fromArray(elements) : new Mat4();
}
