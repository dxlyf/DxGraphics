/**
 * `Quat` — a quaternion used for rotation, with a chainable API.
 *
 * Components are stored as `(x, y, z, w)` where the axis part is the vector
 * `(x, y, z)` and `w` is the cosine of half the rotation angle; the identity
 * rotation is therefore `(0, 0, 0, 1)`. Every mutating method returns `this`
 * so calls compose:
 *
 * ```ts
 * const q = new Quat().setFromAxisAngle(Vec3.unitZ(), Math.PI / 2);
 * q.multiply(new Quat().setFromAxisAngle(Vec3.unitX(), Math.PI));
 * ```
 *
 * {@link Quat.rotateVec3}, {@link Quat.multiply} and
 * {@link Quat.multiplyQuaternions} use the standard, numerically stable
 * formulas (three.js compatible), and every method that writes into a target
 * is safe to call with the target aliasing one of its inputs.
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import { Euler } from './Euler';
import type { EulerOrder } from './Euler';
import type { Mat3 } from './Mat3';
import type { Mat4 } from './Mat4';
import { Vec3 } from './Vec3';

/** A rotation matrix accepted by {@link Quat.setFromRotationMatrix}. */
export type QuatMatrixLike = Mat3 | Mat4;

/** A quaternion expressed as a plain 4-component object. */
export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Random source used by {@link Quat.random}. */
export type QuatRandomFn = () => number;

/**
 * Reads the coefficient at `row`, `column` of a column-major matrix.
 *
 * `Mat3` and `Mat4` both store column-major `elements` arrays, so a single
 * stride expression covers either by inspecting the array length.
 */
function readMatrixComponent(m: QuatMatrixLike, row: number, column: number): number {
  const elements = m.elements;
  const stride = elements.length === 9 ? 3 : 4;
  return elements[column * stride + row];
}

/** Recovers the rotation axis and angle from a unit quaternion. */
function axisAngleFromQuaternion(q: Quat): { axis: [number, number, number]; angle: number } {
  const w = q.w > 1 ? 1 : q.w < -1 ? -1 : q.w;
  const angle = 2 * Math.acos(w);
  const s = Math.sqrt(1 - w * w);
  if (s < 1e-6) {
    // The axis is undefined for the identity and for 180 degree turns whose
    // vector part vanished; fall back to a valid perpendicular direction.
    return { axis: [1, 0, 0], angle };
  }
  return { axis: [q.x / s, q.y / s, q.z / s], angle };
}

/** A quaternion. */
export class Quat {
  /** Backing field for {@link Quat.x}. */
  private _x: number;

  /** Backing field for {@link Quat.y}. */
  private _y: number;

  /** Backing field for {@link Quat.z}. */
  private _z: number;

  /** Backing field for {@link Quat.w}. */
  private _w: number;

  /**
   * Optional observer invoked whenever a component, or the quaternion as a
   * whole, is mutated. `Transform` uses it to keep Euler angles and matrices in
   * sync; `null` by default.
   */
  public onChange: (() => void) | null = null;

  /** X component of the vector (axis) part. */
  public get x(): number {
    return this._x;
  }

  public set x(value: number) {
    if (value === this._x) return;
    this._x = value;
    this.onChange?.();
  }

  /** Y component of the vector (axis) part. */
  public get y(): number {
    return this._y;
  }

  public set y(value: number) {
    if (value === this._y) return;
    this._y = value;
    this.onChange?.();
  }

  /** Z component of the vector (axis) part. */
  public get z(): number {
    return this._z;
  }

  public set z(value: number) {
    if (value === this._z) return;
    this._z = value;
    this.onChange?.();
  }

  /** Scalar part: `cos(angle / 2)`. */
  public get w(): number {
    return this._w;
  }

  public set w(value: number) {
    if (value === this._w) return;
    this._w = value;
    this.onChange?.();
  }

  /** Creates a quaternion; defaults to the identity `(0, 0, 0, 1)`. */
  constructor(x: number = 0, y: number = 0, z: number = 0, w: number = 1) {
    this._x = x;
    this._y = y;
    this._z = z;
    this._w = w;
  }

  /** Fires {@link Quat.onChange} explicitly for direct backing-field writes. */
  public notifyChange(): this {
    this.onChange?.();
    return this;
  }

  /* ---------------------------------------------------------------- static */

  /** The identity quaternion `(0, 0, 0, 1)`. */
  public static identity(): Quat {
    return new Quat(0, 0, 0, 1);
  }

  /** The identity quaternion; alias of {@link Quat.identity}. */
  public static one(): Quat {
    return new Quat(0, 0, 0, 1);
  }

  /** Coerces an array or plain object into a `Quat` (allocating). */
  public static from(source: QuatLike | ArrayLike<number>): Quat {
    if (Array.isArray(source)) {
      const values = source as readonly number[];
      return new Quat(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1);
    }
    const like = source as QuatLike;
    return new Quat(like.x, like.y, like.z, like.w);
  }

  /** Reads a quaternion from a `[x, y, z, w]` array. */
  public static fromArray(source: ArrayLike<number>, offset: number = 0): Quat {
    return new Quat(
      source[offset] ?? 0,
      source[offset + 1] ?? 0,
      source[offset + 2] ?? 0,
      source[offset + 3] ?? 1,
    );
  }

  /** Rotation of `angle` radians about `axis`; the axis is normalised first. */
  public static fromAxisAngle(axis: Vec3, angle: number): Quat {
    return new Quat().setFromAxisAngle(axis, angle);
  }

  /** Rotation described by an Euler angle triple (radians). */
  public static fromEuler(e: Euler): Quat {
    return new Quat().setFromEuler(e);
  }

  /** Rotation described by a 3x3 or 4x4 rotation matrix. */
  public static fromRotationMatrix(m: QuatMatrixLike): Quat {
    return new Quat().setFromRotationMatrix(m);
  }

  /** Shortest-arc rotation taking the unit vector `from` to the unit vector `to`. */
  public static fromUnitVectors(from: Vec3, to: Vec3): Quat {
    return new Quat().setFromUnitVectors(from, to);
  }

  /** Uniformly distributed random rotation (Shoemake's method). */
  public static random(random: QuatRandomFn = Math.random): Quat {
    const u1 = random();
    const u2 = random();
    const u3 = random();
    const sqrt1 = Math.sqrt(1 - u1);
    const sqrt2 = Math.sqrt(u1);
    return new Quat(
      sqrt1 * Math.sin(2 * Math.PI * u2),
      sqrt1 * Math.cos(2 * Math.PI * u2),
      sqrt2 * Math.sin(2 * Math.PI * u3),
      sqrt2 * Math.cos(2 * Math.PI * u3),
    ).normalize();
  }

  /**
   * Writes the spherical interpolation of `a` and `b` at `t` into `out`.
   *
   * `out` may alias `a` or `b`. The result is a unit quaternion (within
   * rounding), the shortest arc is taken when the two inputs point away from
   * each other, and near-parallel inputs fall back to a normalised linear
   * blend so the divide-by-zero in the `sin` ratio is never reached.
   */
  public static slerpFlat(
    out: number[] | Float32Array,
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    t: number,
    offset: number = 0,
  ): number[] | Float32Array {
    let ax = a[offset];
    let ay = a[offset + 1];
    let az = a[offset + 2];
    let aw = a[offset + 3];
    let bx = b[offset];
    let by = b[offset + 1];
    let bz = b[offset + 2];
    let bw = b[offset + 3];

    if (t === 0) {
      out[offset] = ax;
      out[offset + 1] = ay;
      out[offset + 2] = az;
      out[offset + 3] = aw;
      return out;
    }
    if (t === 1) {
      out[offset] = bx;
      out[offset + 1] = by;
      out[offset + 2] = bz;
      out[offset + 3] = bw;
      return out;
    }

    let cos = ax * bx + ay * by + az * bz + aw * bw;
    if (cos < 0) {
      cos = -cos;
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }

    if (cos > 0.9995) {
      // Very close (or antipodal after the flip): normalise a linear blend.
      const inv = 1 - t;
      let rx = inv * ax + t * bx;
      let ry = inv * ay + t * by;
      let rz = inv * az + t * bz;
      let rw = inv * aw + t * bw;
      const norm = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw) || 1;
      const scale = 1 / norm;
      rx *= scale;
      ry *= scale;
      rz *= scale;
      rw *= scale;
      out[offset] = rx;
      out[offset + 1] = ry;
      out[offset + 2] = rz;
      out[offset + 3] = rw;
      return out;
    }

    const theta = Math.acos(cos);
    const sinTheta = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / sinTheta;
    const wb = Math.sin(t * theta) / sinTheta;
    out[offset] = wa * ax + wb * bx;
    out[offset + 1] = wa * ay + wb * by;
    out[offset + 2] = wa * az + wb * bz;
    out[offset + 3] = wa * aw + wb * bw;
    return out;
  }

  /* ----------------------------------------------------------- accessors */

  /** Sets all four components, notifying {@link Quat.onChange} at most once. */
  public set(x: number, y: number = x, z: number = x, w: number = x): this {
    this._x = x;
    this._y = y;
    this._z = z;
    this._w = w;
    this.onChange?.();
    return this;
  }

  /** Resets to the identity rotation `(0, 0, 0, 1)`. */
  public setIdentity(): this {
    return this.set(0, 0, 0, 1);
  }

  /** Copies another quaternion (or plain object/array) into this one. */
  public copy(source: QuatLike | ArrayLike<number>): this {
    if (Array.isArray(source)) {
      const values = source as readonly number[];
      return this.set(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1);
    }
    const like = source as QuatLike;
    return this.set(like.x, like.y, like.z, like.w);
  }

  /** Returns a new quaternion with the same components. */
  public clone(): Quat {
    return new Quat(this.x, this.y, this.z, this.w);
  }

  /** Iterates over the components in `(x, y, z, w)` order. */
  public *[Symbol.iterator](): IterableIterator<number> {
    yield this.x;
    yield this.y;
    yield this.z;
    yield this.w;
  }

  /* --------------------------------------------------------------- setters */

  /** Sets this quaternion from an Euler angle triple (radians). */
  public setFromEuler(e: Euler): this {
    const order = (e.order ?? 'XYZ').toUpperCase();
    const c1 = Math.cos(e.x / 2);
    const c2 = Math.cos(e.y / 2);
    const c3 = Math.cos(e.z / 2);
    const s1 = Math.sin(e.x / 2);
    const s2 = Math.sin(e.y / 2);
    const s3 = Math.sin(e.z / 2);

    switch (order) {
      case 'XYZ':
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case 'YXZ':
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      case 'ZXY':
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case 'ZYX':
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      case 'YZX':
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case 'XZY':
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      default:
        // Unknown orders fall back to the library default (`XYZ`) rather than
        // silently dropping a rotation, so the caller always gets a unit
        // quaternion back.
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
    }

    return this;
  }

  /**
   * Sets the rotation of `angle` radians about `axis`.
   *
   * The axis is normalised first, so a non-unit axis is safe; a zero-length
   * axis leaves this quaternion at the identity rotation.
   */
  public setFromAxisAngle(axis: Vec3, angle: number): this {
    const length = axis.length();
    if (length === 0) return this.setIdentity();

    const half = angle / 2;
    const s = Math.sin(half) / length;
    this.x = axis.x * s;
    this.y = axis.y * s;
    this.z = axis.z * s;
    this.w = Math.cos(half);
    return this;
  }

  /**
   * Sets this quaternion from a 3x3 or 4x4 rotation matrix.
   *
   * The trace-based branch selection is the numerically stable standard
   * formulation, so the result is correct for every rotation including the
   * 180 degree cases where the naive formulas divide by a vanishing term.
   */
  public setFromRotationMatrix(m: QuatMatrixLike): this {
    const m11 = readMatrixComponent(m, 0, 0);
    const m12 = readMatrixComponent(m, 0, 1);
    const m13 = readMatrixComponent(m, 0, 2);
    const m21 = readMatrixComponent(m, 1, 0);
    const m22 = readMatrixComponent(m, 1, 1);
    const m23 = readMatrixComponent(m, 1, 2);
    const m31 = readMatrixComponent(m, 2, 0);
    const m32 = readMatrixComponent(m, 2, 1);
    const m33 = readMatrixComponent(m, 2, 2);

    const trace = m11 + m22 + m33;

    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      this.w = 0.25 / s;
      this.x = (m32 - m23) * s;
      this.y = (m13 - m31) * s;
      this.z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
      this.w = (m32 - m23) / s;
      this.x = 0.25 * s;
      this.y = (m12 + m21) / s;
      this.z = (m13 + m31) / s;
    } else if (m22 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
      this.w = (m13 - m31) / s;
      this.x = (m12 + m21) / s;
      this.y = 0.25 * s;
      this.z = (m23 + m32) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
      this.w = (m21 - m12) / s;
      this.x = (m13 + m31) / s;
      this.y = (m23 + m32) / s;
      this.z = 0.25 * s;
    }

    return this;
  }

  /**
   * Sets the shortest-arc rotation taking the unit vector `from` to `to`.
   *
   * The inputs are assumed to be normalised. Opposite vectors have no unique
   * axis, so any perpendicular one is chosen.
   */
  public setFromUnitVectors(from: Vec3, to: Vec3): this {
    let r = from.x * to.x + from.y * to.y + from.z * to.z + 1;

    if (r < EPSILON) {
      // `from` and `to` point in opposite directions: pick a perpendicular axis.
      r = 0;
      if (Math.abs(from.x) > Math.abs(from.z)) {
        this.x = -from.y;
        this.y = from.x;
        this.z = 0;
      } else {
        this.x = 0;
        this.y = -from.z;
        this.z = from.y;
      }
    } else {
      this.x = from.y * to.z - from.z * to.y;
      this.y = from.z * to.x - from.x * to.z;
      this.z = from.x * to.y - from.y * to.x;
    }

    this.w = r;
    return this.normalize();
  }

  /* -------------------------------------------------------------- query */

  /** Angle between this rotation and `q`, in radians, in `[0, PI]`. */
  public angleTo(q: QuatLike): number {
    return 2 * Math.acos(Math.min(Math.abs(this.dot(q)), 1));
  }

  /** Dot product with `q`; `+/-1` when both describe the same rotation. */
  public dot(q: QuatLike): number {
    return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w;
  }

  /** Euclidean length (norm) of the quaternion. */
  public length(): number {
    return Math.sqrt(this.lengthSquared());
  }

  /** Squared length (cheaper than {@link Quat.length}). */
  public lengthSquared(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
  }

  /** `true` when every component equals `q` within `tolerance`. */
  public equals(q: QuatLike, tolerance: number = EPSILON): boolean {
    return (
      Math.abs(this.x - q.x) <= tolerance &&
      Math.abs(this.y - q.y) <= tolerance &&
      Math.abs(this.z - q.z) <= tolerance &&
      Math.abs(this.w - q.w) <= tolerance
    );
  }

  /** `true` when every component is a finite number. */
  public isFinite(): boolean {
    return (
      Number.isFinite(this.x) &&
      Number.isFinite(this.y) &&
      Number.isFinite(this.z) &&
      Number.isFinite(this.w)
    );
  }

  /** `true` when the quaternion is (close to) the identity rotation. */
  public isIdentity(tolerance: number = EPSILON): boolean {
    return (
      Math.abs(this.x) <= tolerance &&
      Math.abs(this.y) <= tolerance &&
      Math.abs(this.z) <= tolerance &&
      Math.abs(this.w - 1) <= tolerance
    );
  }

  /** `true` when the norm is `1` within `tolerance`. */
  public isNormalized(tolerance: number = EPSILON): boolean {
    return Math.abs(this.lengthSquared() - 1) <= tolerance;
  }

  /* ---------------------------------------------------------- arithmetic */

  /** Resets to the identity rotation `(0, 0, 0, 1)`. */
  public identity(): this {
    return this.setIdentity();
  }

  /**
   * Inverts the rotation, normalising the conjugate so the result is a unit
   * quaternion even when this one drifted. Use `q.clone().invert()` when the
   * receiver must be preserved.
   */
  public invert(): this {
    const lengthSquared = this.lengthSquared();
    if (lengthSquared === 0) return this.setIdentity();
    const inverse = 1 / lengthSquared;
    this.x = -this.x * inverse;
    this.y = -this.y * inverse;
    this.z = -this.z * inverse;
    this.w = this.w * inverse;
    return this;
  }

  /** Alias of {@link Quat.invert}. */
  public inverse(): this {
    return this.invert();
  }

  /** Negates the vector part, which describes the opposite rotation. */
  public conjugate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  /** Scales this quaternion to unit length; a zero quaternion becomes identity. */
  public normalize(): this {
    const lengthSquared = this.lengthSquared();
    if (lengthSquared === 0) return this.setIdentity();
    const inverse = 1 / Math.sqrt(lengthSquared);
    this.x *= inverse;
    this.y *= inverse;
    this.z *= inverse;
    this.w *= inverse;
    return this;
  }

  /** `this = this * q`, i.e. rotate by `q` first and then by this one. */
  public multiply(q: QuatLike): this {
    return this.multiplyQuaternions(this, q);
  }

  /** `this = q * this`, i.e. rotate by this one first and then by `q`. */
  public premultiply(q: QuatLike): this {
    return this.multiplyQuaternions(q, this);
  }

  /**
   * `this = a * b`, applying `b` first and `a` second.
   *
   * Safe when `this` aliases `a` or `b`, because both operands are read before
   * any component is written.
   */
  public multiplyQuaternions(a: QuatLike, b: QuatLike): this {
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    const aw = a.w;
    const bx = b.x;
    const by = b.y;
    const bz = b.z;
    const bw = b.w;

    this.x = ax * bw + aw * bx + ay * bz - az * by;
    this.y = ay * bw + aw * by + az * bx - ax * bz;
    this.z = az * bw + aw * bz + ax * by - ay * bx;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }

  /**
   * Spherical interpolation towards `qb` by `t`, along the shortest arc.
   *
   * Near-parallel rotations fall back to a normalised linear blend, which is
   * indistinguishable from `slerp` there but avoids the `0 / 0` of the
   * trigonometric form.
   */
  public slerp(qb: QuatLike, t: number): this {
    if (t === 0) return this;
    if (t === 1) return this.copy(qb);

    const x = this.x;
    const y = this.y;
    const z = this.z;
    const w = this.w;
    let cosHalfTheta = w * qb.w + x * qb.x + y * qb.y + z * qb.z;

    let bx = qb.x;
    let by = qb.y;
    let bz = qb.z;
    let bw = qb.w;

    if (cosHalfTheta < 0) {
      cosHalfTheta = -cosHalfTheta;
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }

    if (cosHalfTheta >= 1) {
      this.x = x;
      this.y = y;
      this.z = z;
      this.w = w;
      return this;
    }

    const sqrSinHalfTheta = 1 - cosHalfTheta * cosHalfTheta;
    if (sqrSinHalfTheta <= Number.EPSILON) {
      const s = 1 - t;
      this.x = s * x + t * bx;
      this.y = s * y + t * by;
      this.z = s * z + t * bz;
      this.w = s * w + t * bw;
      return this.normalize();
    }

    const sinHalfTheta = Math.sqrt(sqrSinHalfTheta);
    const halfTheta = Math.atan2(sinHalfTheta, cosHalfTheta);
    const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;

    this.x = x * ratioA + bx * ratioB;
    this.y = y * ratioA + by * ratioB;
    this.z = z * ratioA + bz * ratioB;
    this.w = w * ratioA + bw * ratioB;
    return this;
  }

  /** `this = slerp(qa, qb, t)`; safe when `this` aliases `qa` or `qb`. */
  public slerpQuaternions(qa: QuatLike, qb: QuatLike, t: number): this {
    return this.copy(qa).slerp(qb, t);
  }

  /* -------------------------------------------------------------- output */

  /** Writes `[x, y, z, w]` into `target` at `offset` and returns it. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    target[offset] = this.x;
    target[offset + 1] = this.y;
    target[offset + 2] = this.z;
    target[offset + 3] = this.w;
    return target;
  }

  /**
   * Converts this quaternion into Euler angles (radians).
   *
   * Writes into `target` when supplied (allocating an `Euler` otherwise) and
   * uses `order` when given, falling back to the target's own order. The
   * formulas mirror `Euler.setFromQuat`, which is the inverse of
   * {@link Quat.setFromEuler}.
   */
  public toEuler(target?: Euler, order?: string): Euler {
    const e: Euler = target ?? new Euler(0, 0, 0, (order as EulerOrder | undefined) ?? 'XYZ');
    const resolved: EulerOrder = (order as EulerOrder | undefined) ?? e.order ?? 'XYZ';

    const x = this.x;
    const y = this.y;
    const z = this.z;
    const w = this.w;

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

    switch (resolved.toUpperCase()) {
      case 'XYZ':
        e.x = Math.atan2(xz + wy, 1 - (yy + zz));
        e.y = Math.asin(Math.min(1, Math.max(-1, yz - wx)));
        e.z = Math.atan2(xy + wz, 1 - (xx + zz));
        break;
      case 'YXZ':
        e.x = Math.asin(Math.min(1, Math.max(-1, xy + wz)));
        e.y = Math.atan2(yz - wx, 1 - (yy + zz));
        e.z = Math.atan2(xz + wy, 1 - (xx + yy));
        break;
      case 'ZXY':
        e.x = Math.asin(Math.min(1, Math.max(-1, xy - wz)));
        e.y = Math.atan2(yz + wx, 1 - (yy + zz));
        e.z = Math.atan2(xz - wy, 1 - (xx + yy));
        break;
      case 'ZYX':
        e.x = Math.atan2(xy - wz, 1 - (xx + zz));
        e.y = Math.asin(Math.min(1, Math.max(-1, yz + wx)));
        e.z = Math.atan2(xz - wy, 1 - (yy + zz));
        break;
      case 'YZX':
        e.x = Math.atan2(xy + wz, 1 - (xx + zz));
        e.y = Math.atan2(yz + wx, 1 - (yy + zz));
        e.z = Math.asin(Math.min(1, Math.max(-1, xz - wy)));
        break;
      case 'XZY':
        e.x = Math.atan2(xy - wz, 1 - (xx + zz));
        e.y = Math.atan2(yz - wx, 1 - (yy + zz));
        e.z = Math.asin(Math.min(1, Math.max(-1, xz + wy)));
        break;
      default:
        return this.toEuler(e, 'XYZ');
    }

    if (e.order !== undefined || order !== undefined) e.order = resolved;
    return e;
  }

  /* ------------------------------------------------------------- rotation */

  /**
   * Rotates `v` by this quaternion and writes the result into `target`.
   *
   * Uses the optimised `t = 2 * cross(q.xyz, v)` form, which needs two cross
   * products instead of building a rotation matrix. Safe when `target` is `v`.
   */
  public rotateVec3(v: Vec3, target: Vec3 = new Vec3()): Vec3 {
    const x = v.x;
    const y = v.y;
    const z = v.z;
    const qx = this.x;
    const qy = this.y;
    const qz = this.z;
    const qw = this.w;

    // t = 2 * (q.xyz x v)
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);

    const out = target;
    out.x = x + qw * tx + (qy * tz - qz * ty);
    out.y = y + qw * ty + (qz * tx - qx * tz);
    out.z = z + qw * tz + (qx * ty - qy * tx);
    return out;
  }

  /* -------------------------------------------------------------- output */

  /** `"[x, y, z, w]"` with each component rounded to `precision` digits. */
  public toString(precision: number = 4): string {
    return `[${this.x.toFixed(precision)}, ${this.y.toFixed(precision)}, ${this.z.toFixed(
      precision,
    )}, ${this.w.toFixed(precision)}]`;
  }

  /** JSON-friendly representation. */
  public toJSON(): { x: number; y: number; z: number; w: number } {
    return { x: this.x, y: this.y, z: this.z, w: this.w };
  }

  /** Axis and angle of this rotation, as `{ axis, angle }` in radians. */
  public toAxisAngle(): { axis: [number, number, number]; angle: number } {
    return axisAngleFromQuaternion(this);
  }
}

/** Creates a quaternion; defaults to the identity `(0, 0, 0, 1)`. */
export function quat(x: number = 0, y: number = 0, z: number = 0, w: number = 1): Quat {
  return new Quat(x, y, z, w);
}
