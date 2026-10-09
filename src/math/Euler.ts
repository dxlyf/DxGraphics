/**
 * `Euler` — a rotation expressed as three intrinsic angles.
 *
 * Angles are stored in **radians**. The `order` string lists the axes in the
 * order the rotations are applied, and follows the three.js convention: `'XYZ'`
 * means "rotate about X, then about the *new* Y, then about the *new* Z", which
 * is what `Mat4.makeRotationFromEuler` implements.
 *
 * @packageDocumentation
 */

import { DEG2RAD, EPSILON, RAD2DEG } from '../constants';
import { clamp } from '../utils/MathUtils';
import type { Mat3 } from './Mat3';
import type { Mat4 } from './Mat4';
import type { Quat } from './Quat';
import type { Vec3 } from './Vec3';

/** All six supported Euler orders. */
export type EulerOrder = 'XYZ' | 'YXZ' | 'ZXY' | 'ZYX' | 'YZX' | 'XZY';

/** Every valid Euler order, useful for iteration and validation. */
export const EULER_ORDERS: readonly EulerOrder[] = ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'];

/** A rotation described by three intrinsic Euler angles (radians). */
export class Euler {
  /** Backing field for {@link Euler.x}. */
  private _x: number;

  /** Backing field for {@link Euler.y}. */
  private _y: number;

  /** Backing field for {@link Euler.z}. */
  private _z: number;

  /**
   * Optional observer invoked whenever an angle or the order changes.
   * `Transform` uses it to keep the companion quaternion in sync; `null` by default.
   */
  public onChange: (() => void) | null = null;

  /** Rotation about X, in radians. */
  public get x(): number {
    return this._x;
  }

  public set x(value: number) {
    if (value === this._x) return;
    this._x = value;
    this.onChange?.();
  }

  /** Rotation about Y, in radians. */
  public get y(): number {
    return this._y;
  }

  public set y(value: number) {
    if (value === this._y) return;
    this._y = value;
    this.onChange?.();
  }

  /** Rotation about Z, in radians. */
  public get z(): number {
    return this._z;
  }

  public set z(value: number) {
    if (value === this._z) return;
    this._z = value;
    this.onChange?.();
  }

  /** Order in which the axes are applied. */
  public order: EulerOrder;

  /** Creates an Euler triple; defaults to the identity rotation in `'XYZ'`. */
  constructor(x: number = 0, y: number = 0, z: number = 0, order: EulerOrder = 'XYZ') {
    this._x = x;
    this._y = y;
    this._z = z;
    this.order = order;
  }

  /** Fires {@link Euler.onChange} explicitly for direct backing-field writes. */
  public notifyChange(): this {
    this.onChange?.();
    return this;
  }

  /* ---------------------------------------------------------------- static */

  /** The identity rotation. */
  public static identity(order: EulerOrder = 'XYZ'): Euler {
    return new Euler(0, 0, 0, order);
  }

  /** Creates an Euler triple whose angles are given in **degrees**. */
  public static fromDegrees(
    xDegrees: number,
    yDegrees: number = 0,
    zDegrees: number = 0,
    order: EulerOrder = 'XYZ',
  ): Euler {
    return new Euler(xDegrees * DEG2RAD, yDegrees * DEG2RAD, zDegrees * DEG2RAD, order);
  }

  /** Extracts the Euler angles of a matrix (allocating a new instance). */
  public static fromRotationMatrix(m: Mat4 | Mat3, order: EulerOrder = 'XYZ'): Euler {
    return new Euler().setFromRotationMatrix(m, order);
  }

  /** Extracts the Euler angles of a quaternion. */
  public static fromQuat(q: Quat, order: EulerOrder = 'XYZ'): Euler {
    return new Euler().setFromQuat(q, order);
  }

  /** Builds an Euler triple from a direction (yaw/pitch, `'YXZ'`). */
  public static fromDirection(direction: { x: number; y: number; z: number }, order: EulerOrder = 'YXZ'): Euler {
    const euler = new Euler(0, 0, 0, order);
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const y = direction.y / length;
    return euler.set(
      Math.asin(-clamp(y, -1, 1)),
      Math.atan2(-direction.x, -direction.z),
      0,
      order,
    );
  }

  /** Validates an order string. */
  public static isValidOrder(order: string): order is EulerOrder {
    return (EULER_ORDERS as readonly string[]).includes(order);
  }

  /* ------------------------------------------------------------ assignment */

  /** Sets the three angles (and optionally the order); values are radians. */
  public set(x: number, y: number, z: number, order: EulerOrder = this.order): this {
    this._x = x;
    this._y = y;
    this._z = z;
    this.order = order;
    this.onChange?.();
    return this;
  }

  /** Sets the angles from degree values. */
  public setFromDegrees(xDegrees: number, yDegrees: number, zDegrees: number): this {
    this.x = xDegrees * DEG2RAD;
    this.y = yDegrees * DEG2RAD;
    this.z = zDegrees * DEG2RAD;
    return this;
  }

  /** Copies another Euler triple, including its order. */
  public copy(euler: Euler): this {
    return this.set(euler.x, euler.y, euler.z, euler.order);
  }

  /** Returns a new Euler triple with the same values. */
  public clone(): Euler {
    return new Euler(this.x, this.y, this.z, this.order);
  }

  /** Copies the values into `target`. */
  public to(target: { x: number; y: number; z: number; order?: EulerOrder }): {
    x: number;
    y: number;
    z: number;
    order?: EulerOrder;
  } {
    target.x = this.x;
    target.y = this.y;
    target.z = this.z;
    target.order = this.order;
    return target;
  }

  /**
   * Extracts the rotation from a 4x4 or 3x3 rotation matrix.
   *
   * The matrix must be orthonormal (rotation only, no scale/shear); callers with
   * a scaled matrix should normalise the basis first.
   */
  public setFromRotationMatrix(m: Mat4 | Mat3, order: EulerOrder = this.order): this {
    const e = m.elements;
    const is3 = e.length === 9;

    const m11 = e[0];
    const m12 = is3 ? e[3] : e[4];
    const m13 = is3 ? e[6] : e[8];
    const m21 = e[1];
    const m22 = is3 ? e[4] : e[5];
    const m23 = is3 ? e[7] : e[9];
    const m31 = e[2];
    const m32 = is3 ? e[5] : e[6];
    const m33 = is3 ? e[8] : e[10];

    switch (order) {
      case 'XYZ':
        this.y = Math.asin(clamp(m13, -1, 1));
        if (Math.abs(m13) < 0.9999999) {
          this.x = Math.atan2(-m23, m33);
          this.z = Math.atan2(-m12, m11);
        } else {
          this.x = Math.atan2(m32, m22);
          this.z = 0;
        }
        break;
      case 'YXZ':
        this.x = Math.asin(-clamp(m23, -1, 1));
        if (Math.abs(m23) < 0.9999999) {
          this.y = Math.atan2(m13, m33);
          this.z = Math.atan2(m21, m22);
        } else {
          this.y = Math.atan2(-m31, m11);
          this.z = 0;
        }
        break;
      case 'ZXY':
        this.x = Math.asin(clamp(m32, -1, 1));
        if (Math.abs(m32) < 0.9999999) {
          this.y = Math.atan2(-m31, m33);
          this.z = Math.atan2(-m12, m22);
        } else {
          this.y = 0;
          this.z = Math.atan2(m21, m11);
        }
        break;
      case 'ZYX':
        this.y = Math.asin(-clamp(m31, -1, 1));
        if (Math.abs(m31) < 0.9999999) {
          this.x = Math.atan2(m32, m33);
          this.z = Math.atan2(m21, m11);
        } else {
          this.x = 0;
          this.z = Math.atan2(-m12, m22);
        }
        break;
      case 'YZX':
        this.z = Math.asin(clamp(m21, -1, 1));
        if (Math.abs(m21) < 0.9999999) {
          this.x = Math.atan2(-m23, m22);
          this.y = Math.atan2(-m31, m11);
        } else {
          this.x = 0;
          this.y = Math.atan2(m13, m33);
        }
        break;
      case 'XZY':
        this.z = Math.asin(-clamp(m12, -1, 1));
        if (Math.abs(m12) < 0.9999999) {
          this.x = Math.atan2(m32, m22);
          this.y = Math.atan2(m13, m11);
        } else {
          this.x = Math.atan2(-m23, m33);
          this.y = 0;
        }
        break;
      default:
        throw new RangeError(`Unknown Euler order: ${String(order)}`);
    }

    this.order = order;
    return this;
  }

  /**
   * Extracts the rotation from a quaternion.
   *
   * Computes the rotation matrix entries inline (rather than allocating a
   * `Mat3`) and then delegates to the same branch logic as
   * {@link setFromRotationMatrix}, so both paths agree exactly.
   */
  public setFromQuat(q: Quat, order: EulerOrder = this.order): this {
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

    // Column-major 3x3 rotation matrix.
    this.rotationMatrix[0] = 1 - (yy + zz);
    this.rotationMatrix[1] = xy + wz;
    this.rotationMatrix[2] = xz - wy;
    this.rotationMatrix[3] = xy - wz;
    this.rotationMatrix[4] = 1 - (xx + zz);
    this.rotationMatrix[5] = yz + wx;
    this.rotationMatrix[6] = xz + wy;
    this.rotationMatrix[7] = yz - wx;
    this.rotationMatrix[8] = 1 - (xx + yy);

    return this.setFromRotationMatrix(this.rotationMatrixView, order);
  }

  /** Scratch buffer reused by {@link setFromQuat}; never exposed. */
  private readonly rotationMatrix = new Float32Array(9);

  /** `Mat3`-shaped view over {@link rotationMatrix}. */
  private readonly rotationMatrixView = {
    elements: this.rotationMatrix,
  } as unknown as Mat3;

  /** Sets the rotation from a direction vector (yaw/pitch). */
  public setFromDirection(
    direction: { x: number; y: number; z: number },
    order: EulerOrder = this.order,
  ): this {
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
    return this.set(
      Math.asin(-clamp(direction.y / length, -1, 1)),
      Math.atan2(-direction.x, -direction.z),
      0,
      order,
    );
  }

  /* -------------------------------------------------------------- algebra */

  /** Adds another Euler triple component-wise (angles add; order is kept). */
  public add(euler: Euler): this {
    return this.set(this.x + euler.x, this.y + euler.y, this.z + euler.z, this.order);
  }

  /** Adds a scalar to all three angles. */
  public addScalar(scalar: number): this {
    return this.set(this.x + scalar, this.y + scalar, this.z + scalar, this.order);
  }

  /** Subtracts another Euler triple component-wise. */
  public sub(euler: Euler): this {
    return this.set(this.x - euler.x, this.y - euler.y, this.z - euler.z, this.order);
  }

  /** Multiplies all three angles by a scalar. */
  public multiplyScalar(scalar: number): this {
    return this.set(this.x * scalar, this.y * scalar, this.z * scalar, this.order);
  }

  /** Linear interpolation towards `euler` (angles are not wrapped). */
  public lerp(euler: Euler, t: number): this {
    return this.set(
      this.x + (euler.x - this.x) * t,
      this.y + (euler.y - this.y) * t,
      this.z + (euler.z - this.z) * t,
      this.order,
    );
  }

  /** Normalises every angle into `(-PI, PI]`. */
  public wrap(): this {
    const wrap = (angle: number) => {
      let a = angle % (Math.PI * 2);
      if (a > Math.PI) a -= Math.PI * 2;
      if (a <= -Math.PI) a += Math.PI * 2;
      return a;
    };
    return this.set(wrap(this.x), wrap(this.y), wrap(this.z), this.order);
  }

  /** Returns the angles converted to degrees. */
  public toDegrees(target: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }): {
    x: number;
    y: number;
    z: number;
  } {
    target.x = this.x * RAD2DEG;
    target.y = this.y * RAD2DEG;
    target.z = this.z * RAD2DEG;
    return target;
  }

  /* -------------------------------------------------------------- queries */

  /** `true` when all three angles are (close to) zero. */
  public isZero(tolerance: number = EPSILON): boolean {
    return (
      Math.abs(this.x) <= tolerance &&
      Math.abs(this.y) <= tolerance &&
      Math.abs(this.z) <= tolerance
    );
  }

  /** `true` when every angle is finite. */
  public isFinite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z);
  }

  /** `true` when every angle matches `euler` within `tolerance`. */
  public equals(euler: Euler, tolerance: number = EPSILON): boolean {
    return (
      Math.abs(this.x - euler.x) <= tolerance &&
      Math.abs(this.y - euler.y) <= tolerance &&
      Math.abs(this.z - euler.z) <= tolerance &&
      this.order === euler.order
    );
  }

  /**
   * `true` when both triples describe the same rotation.
   *
   * Euler triples are not unique, so this compares the resulting quaternions
   * instead of the angles; it allocates through {@link toQuat}, so prefer
   * {@link equals} in hot paths.
   */
  public representsSameRotation(euler: Euler, tolerance: number = 1e-5): boolean {
    const a = this.toQuatElements();
    const b = euler.toQuatElements();
    const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    return Math.abs(1 - dot) <= tolerance;
  }

  /* ------------------------------------------------------------- conversion */

  /** Writes the rotation into `target` as a quaternion. */
  public toQuat(target: Quat): Quat {
    return target.setFromEuler(this);
  }

  /**
   * Returns the quaternion components as `[x, y, z, w]`.
   *
   * Implemented inline so `Euler` needs no runtime import of `Quat`.
   */
  public toQuatElements(): [number, number, number, number] {
    const c1 = Math.cos(this.x / 2);
    const c2 = Math.cos(this.y / 2);
    const c3 = Math.cos(this.z / 2);
    const s1 = Math.sin(this.x / 2);
    const s2 = Math.sin(this.y / 2);
    const s3 = Math.sin(this.z / 2);

    switch (this.order) {
      case 'XYZ':
        return [
          s1 * c2 * c3 + c1 * s2 * s3,
          c1 * s2 * c3 - s1 * c2 * s3,
          c1 * c2 * s3 + s1 * s2 * c3,
          c1 * c2 * c3 - s1 * s2 * s3,
        ];
      case 'YXZ':
        return [
          s1 * c2 * c3 + c1 * s2 * s3,
          c1 * s2 * c3 - s1 * c2 * s3,
          c1 * c2 * s3 - s1 * s2 * c3,
          c1 * c2 * c3 + s1 * s2 * s3,
        ];
      case 'ZXY':
        return [
          s1 * c2 * c3 - c1 * s2 * s3,
          c1 * s2 * c3 + s1 * c2 * s3,
          c1 * c2 * s3 + s1 * s2 * c3,
          c1 * c2 * c3 - s1 * s2 * s3,
        ];
      case 'ZYX':
        return [
          s1 * c2 * c3 - c1 * s2 * s3,
          c1 * s2 * c3 + s1 * c2 * s3,
          c1 * c2 * s3 - s1 * s2 * c3,
          c1 * c2 * c3 + s1 * s2 * s3,
        ];
      case 'YZX':
        return [
          s1 * c2 * c3 + c1 * s2 * s3,
          c1 * s2 * c3 + s1 * c2 * s3,
          c1 * c2 * s3 - s1 * s2 * c3,
          c1 * c2 * c3 - s1 * s2 * s3,
        ];
      case 'XZY':
        return [
          s1 * c2 * c3 - c1 * s2 * s3,
          c1 * s2 * c3 - s1 * c2 * s3,
          c1 * c2 * s3 + s1 * s2 * c3,
          c1 * c2 * c3 + s1 * s2 * s3,
        ];
      default:
        return [0, 0, 0, 1];
    }
  }

  /** Fills `target` (a 3x3 matrix) with this rotation. */
  public toMat3(target: Mat3): Mat3 {
    return target.makeRotationFromEuler(this);
  }

  /** Fills `target` (a 4x4 matrix) with this rotation. */
  public toMat4(target: Mat4): Mat4 {
    return target.makeRotationFromEuler(this);
  }

  /** The forward (`-Z`) direction implied by this rotation. */
  public getForward(target: Vec3): Vec3 {
    const q = this.toQuatElements();
    // Rotate (0, 0, -1) by the quaternion without allocating a second Vec3.
    const x = 0;
    const y = 0;
    const z = -1;
    const tx = 2 * (q[1] * z - q[2] * y);
    const ty = 2 * (q[2] * x - q[0] * z);
    const tz = 2 * (q[0] * y - q[1] * x);
    return target.set(
      x + q[3] * tx + (q[1] * tz - q[2] * ty),
      y + q[3] * ty + (q[2] * tx - q[0] * tz),
      z + q[3] * tz + (q[0] * ty - q[1] * tx),
    );
  }

  /* --------------------------------------------------------------- output */

  /** `[x, y, z]` in radians. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    target[offset] = this.x;
    target[offset + 1] = this.y;
    target[offset + 2] = this.z;
    return target;
  }

  /** `[x, y, z, order]`, JSON-friendly. */
  public toJSON(): [number, number, number, EulerOrder] {
    return [this.x, this.y, this.z, this.order];
  }

  /** `"[x, y, z] order"` in radians, or degrees when `asDegrees` is set. */
  public toString(precision: number = 4, asDegrees: boolean = false): string {
    const factor = asDegrees ? RAD2DEG : 1;
    const x = (this.x * factor).toFixed(precision);
    const y = (this.y * factor).toFixed(precision);
    const z = (this.z * factor).toFixed(precision);
    return `[${x}, ${y}, ${z}] ${this.order}${asDegrees ? ' (deg)' : ''}`;
  }

  /** Iterates over `x`, `y`, `z`. */
  public *[Symbol.iterator](): IterableIterator<number> {
    yield this.x;
    yield this.y;
    yield this.z;
  }
}

/** Creates an `Euler` triple. */
export function euler(x: number = 0, y: number = 0, z: number = 0, order: EulerOrder = 'XYZ'): Euler {
  return new Euler(x, y, z, order);
}
