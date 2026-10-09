/**
 * `Transform` — a composable position/rotation/scale record with matrix sync.
 *
 * Keeping position, rotation and scale in one object (instead of scattered
 * fields) makes it possible to observe changes from a single place: any mutation
 * sets {@link Transform.dirty}, and {@link Transform.updateMatrix} recomposes the
 * local matrix only when needed.
 *
 * `rotation` and `quaternion` are kept in sync: writing to `rotation.x` triggers
 * the `onChange` callback installed here, which flags the transform dirty, and
 * reading {@link Transform.getQuaternion} lazily converts when the rotation was
 * the value that changed.
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import { Euler, type EulerOrder } from '../math/Euler';
import { Mat4 } from '../math/Mat4';
import { Quat } from '../math/Quat';
import { Vec3 } from '../math/Vec3';

/** A plain snapshot of a transform's values. */
export interface TransformSnapshot {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
  order: EulerOrder;
}

/** Options accepted by {@link Transform}. */
export interface TransformOptions {
  /** Initial position. */
  position?: Vec3 | [number, number, number];
  /** Initial rotation as a quaternion. */
  quaternion?: Quat | [number, number, number, number];
  /** Initial rotation as Euler angles (radians). */
  rotation?: Euler | [number, number, number];
  /** Initial scale. */
  scale?: Vec3 | number | [number, number, number];
  /** Euler order used by {@link Transform.rotation} (default `'XYZ'`). */
  order?: EulerOrder;
  /** Called whenever a component changes. */
  onChange?: () => void;
}

/**
 * Position, rotation and scale with a lazily recomposed local matrix.
 */
export class Transform {
  /** World/local position. */
  public readonly position: Vec3;

  /** Euler rotation in radians; kept in sync with {@link quaternion}. */
  public readonly rotation: Euler;

  /** Rotation as a quaternion; kept in sync with {@link rotation}. */
  public readonly quaternion: Quat;

  /** Non-uniform scale. */
  public readonly scale: Vec3;

  /** Local matrix derived from `position`, `quaternion` and `scale`. */
  public readonly matrix: Mat4 = new Mat4();

  /** `true` when {@link matrix} needs recomposing. */
  public dirty = true;

  /** `true` when the transform has never been composed. */
  private neverComposed = true;

  /** Invoked after every accepted mutation. */
  public onChange: (() => void) | null;

  /** Internal guard so sync callbacks do not recurse. */
  private syncing = false;

  /** Creates a transform with the given initial values. */
  constructor(options: TransformOptions = {}) {
    this.position = new Vec3();
    this.rotation = new Euler(0, 0, 0, options.order ?? 'XYZ');
    this.quaternion = new Quat();
    this.scale = new Vec3(1, 1, 1);
    this.onChange = options.onChange ?? null;

    this.installChangeCallbacks();

    if (options.position) this.setPosition(options.position);
    if (options.quaternion) this.setQuaternion(options.quaternion);
    else if (options.rotation) this.setRotation(options.rotation);
    if (options.scale !== undefined) this.setScale(options.scale);

    this.dirty = true;
    this.neverComposed = true;
  }

  /* --------------------------------------------------------------- wiring */

  /**
   * Installs change hooks so that direct field writes (`transform.position.x = 1`,
   * `transform.quaternion.set(...)`) keep the local matrix and the companion
   * representation in sync:
   *
   *  - writing `quaternion` recomputes `rotation`;
   *  - writing `rotation` recomputes `quaternion`;
   *  - writing `position`/`scale` only flags the matrix.
   *
   * `Vec3`/`Euler`/`Quat` invoke `onChange` (if set) from their mutating methods,
   * so every supported mutation path is covered.
   */
  private installChangeCallbacks(): void {
    this.position.onChange = () => this.markDirty();
    this.scale.onChange = () => this.markDirty();
    this.quaternion.onChange = () => {
      if (this.syncing) return;
      this.syncing = true;
      try {
        this.rotation.setFromQuat(this.quaternion, this.rotation.order);
      } finally {
        this.syncing = false;
      }
      this.markDirty();
    };
    this.rotation.onChange = () => {
      if (this.syncing) return;
      this.syncing = true;
      try {
        this.quaternion.setFromEuler(this.rotation);
      } finally {
        this.syncing = false;
      }
      this.markDirty();
    };
  }

  /**
   * Reinstalls the change hooks after {@link copy} or deserialisation.
   *
   * Call this if a consumer ever replaces `position`/`rotation`/`scale`/`quaternion`
   * with new instances (the fields are `readonly`, so this is only necessary for
   * exotic subclassing).
   */
  public refreshChangeCallbacks(): this {
    this.installChangeCallbacks();
    return this;
  }

  /** Flags the matrix as stale and notifies the owner. */
  public markDirty(): this {
    this.dirty = true;
    if (!this.syncing) {
      this.syncing = true;
      try {
        this.onChange?.();
      } finally {
        this.syncing = false;
      }
    }
    return this;
  }

  /* ------------------------------------------------------------ assignment */

  /** Sets the position from a vector or tuple. */
  public setPosition(value: Vec3 | [number, number, number] | number, y?: number, z?: number): this {
    if (typeof value === 'number') this.position.set(value, y ?? value, z ?? value);
    else if (Array.isArray(value)) this.position.set(value[0], value[1], value[2]);
    else this.position.copy(value);
    return this.markDirty();
  }

  /**
   * Sets the rotation from Euler angles (radians), updating the quaternion.
   *
   * Accepts an {@link Euler} instance, a `[x, y, z]` tuple, a single number
   * (`setRotation(x)` rotates only about X) or a plain `{ x, y, z, order? }`
   * object literal.
   */
  public setRotation(
    value: Euler | [number, number, number] | { x: number; y: number; z: number; order?: EulerOrder } | number,
    y?: number,
    z?: number,
    order?: EulerOrder,
  ): this {
    if (typeof value === 'number') {
      this.rotation.set(value, y ?? 0, z ?? 0, order ?? this.rotation.order);
    } else if (Array.isArray(value)) {
      this.rotation.set(value[0], value[1], value[2], order ?? this.rotation.order);
    } else if (value instanceof Euler) {
      this.rotation.copy(value);
    } else {
      const plain = value as { x: number; y: number; z: number; order?: EulerOrder };
      this.rotation.set(plain.x, plain.y, plain.z, plain.order ?? order ?? this.rotation.order);
    }
    this.quaternion.setFromEuler(this.rotation);
    return this.markDirty();
  }

  /** Sets the rotation from a quaternion, updating the Euler angles. */
  public setQuaternion(value: Quat | [number, number, number, number]): this {
    if (Array.isArray(value)) this.quaternion.set(value[0], value[1], value[2], value[3]);
    else this.quaternion.copy(value);
    this.rotation.setFromQuat(this.quaternion, this.rotation.order);
    return this.markDirty();
  }

  /** Sets the rotation around a single axis, in radians. */
  public setRotationFromAxisAngle(axis: Vec3, angle: number): this {
    this.quaternion.setFromAxisAngle(axis, angle);
    this.rotation.setFromQuat(this.quaternion, this.rotation.order);
    return this.markDirty();
  }

  /** Sets the scale from a number, vector or tuple. */
  public setScale(value: Vec3 | number | [number, number, number], y?: number, z?: number): this {
    if (typeof value === 'number') this.scale.set(value, y ?? value, z ?? value);
    else if (Array.isArray(value)) this.scale.set(value[0], value[1], value[2]);
    else this.scale.copy(value);
    return this.markDirty();
  }

  /** Copies every component from another transform. */
  public copy(other: Transform): this {
    this.position.copy(other.position);
    this.rotation.copy(other.rotation);
    this.quaternion.copy(other.quaternion);
    this.scale.copy(other.scale);
    this.dirty = true;
    this.neverComposed = true;
    return this.markDirty();
  }

  /** Returns a new transform with the same values. */
  public clone(): Transform {
    return new Transform().copy(this);
  }

  /** Resets to the identity transform. */
  public identity(): this {
    this.position.set(0, 0, 0);
    this.rotation.set(0, 0, 0, this.rotation.order);
    this.quaternion.set(0, 0, 0, 1);
    this.scale.set(1, 1, 1);
    return this.markDirty();
  }

  /* -------------------------------------------------------------- matrices */

  /**
   * Recomposes {@link matrix} from position, quaternion and scale.
   *
   * @param force Recompute even when {@link dirty} is `false`.
   * @returns The local matrix.
   */
  public updateMatrix(force: boolean = false): Mat4 {
    if (this.dirty || force || this.neverComposed) {
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.dirty = false;
      this.neverComposed = false;
    }
    return this.matrix;
  }

  /** Local matrix, recomposing first when needed. */
  public getMatrix(): Mat4 {
    return this.updateMatrix();
  }

  /** Composes `parentWorld * local` into `target`. */
  public getWorldMatrix(parentWorld: Mat4, target: Mat4 = new Mat4()): Mat4 {
    this.updateMatrix();
    return target.multiplyMatrices(parentWorld, this.matrix);
  }

  /* --------------------------------------------------------------- queries */

  /** `true` when position, rotation and scale are all identity. */
  public isIdentity(tolerance: number = EPSILON): boolean {
    return (
      this.position.lengthSquared() <= tolerance * tolerance &&
      Math.abs(this.quaternion.w - 1) <= tolerance &&
      Math.abs(this.quaternion.x) <= tolerance &&
      Math.abs(this.quaternion.y) <= tolerance &&
      Math.abs(this.quaternion.z) <= tolerance &&
      Math.abs(this.scale.x - 1) <= tolerance &&
      Math.abs(this.scale.y - 1) <= tolerance &&
      Math.abs(this.scale.z - 1) <= tolerance
    );
  }

  /** `true` when every component is finite. */
  public isFinite(): boolean {
    return (
      this.position.isFinite() && this.quaternion.isFinite() && this.scale.isFinite()
    );
  }

  /** `true` when any scale component is zero (matrix will be singular). */
  public isDegenerate(tolerance: number = EPSILON): boolean {
    return (
      Math.abs(this.scale.x) <= tolerance ||
      Math.abs(this.scale.y) <= tolerance ||
      Math.abs(this.scale.z) <= tolerance
    );
  }

  /** Component-wise comparison with another transform. */
  public equals(other: Transform, tolerance: number = EPSILON): boolean {
    return (
      this.position.equals(other.position, tolerance) &&
      this.quaternion.equals(other.quaternion, tolerance) &&
      this.scale.equals(other.scale, tolerance)
    );
  }

  /** Maximum absolute scale component, useful for bounding-volume scaling. */
  public getMaxScale(): number {
    return Math.max(Math.abs(this.scale.x), Math.abs(this.scale.y), Math.abs(this.scale.z));
  }

  /* ------------------------------------------------------------ operations */

  /** Translates the position by `offset`. */
  public translate(offset: Vec3): this {
    this.position.add(offset);
    return this.markDirty();
  }

  /** Rotates the quaternion around a local axis. */
  public rotateOnAxis(axis: Vec3, angle: number): this {
    const q = Transform.scratchQuat.setFromAxisAngle(axis, angle);
    this.quaternion.multiply(q);
    this.rotation.setFromQuat(this.quaternion, this.rotation.order);
    return this.markDirty();
  }

  /** Rotates around a world-space axis. */
  public rotateOnWorldAxis(axis: Vec3, angle: number): this {
    const q = Transform.scratchQuat.setFromAxisAngle(axis, angle);
    this.quaternion.premultiply(q);
    this.rotation.setFromQuat(this.quaternion, this.rotation.order);
    return this.markDirty();
  }

  /** Multiplies the scale component-wise. */
  public multiplyScale(factor: Vec3 | number): this {
    if (typeof factor === 'number') this.scale.multiplyScalar(factor);
    else this.scale.multiply(factor);
    return this.markDirty();
  }

  /** Writes this transform's local matrix and decomposes the result. */
  public applyMatrix(m: Mat4): this {
    m.decompose(this.position, this.quaternion, this.scale);
    this.rotation.setFromQuat(this.quaternion, this.rotation.order);
    return this.markDirty();
  }

  /** Interpolates towards `other`. Quaternions are slerped, not lerped. */
  public lerp(other: Transform, t: number): this {
    this.position.lerp(other.position, t);
    this.scale.lerp(other.scale, t);
    this.quaternion.slerp(other.quaternion, t);
    this.rotation.setFromQuat(this.quaternion, this.rotation.order);
    return this.markDirty();
  }

  /* --------------------------------------------------------------- output */

  /** Plain snapshot of the transform values. */
  public toJSON(): TransformSnapshot {
    return {
      position: [this.position.x, this.position.y, this.position.z],
      rotation: [this.quaternion.x, this.quaternion.y, this.quaternion.z, this.quaternion.w],
      scale: [this.scale.x, this.scale.y, this.scale.z],
      order: this.rotation.order,
    };
  }

  /** Restores the values produced by {@link toJSON}. */
  public fromJSON(snapshot: TransformSnapshot): this {
    this.position.set(snapshot.position[0], snapshot.position[1], snapshot.position[2]);
    this.quaternion.set(snapshot.rotation[0], snapshot.rotation[1], snapshot.rotation[2], snapshot.rotation[3]);
    this.rotation.setFromQuat(this.quaternion, snapshot.order ?? 'XYZ');
    this.scale.set(snapshot.scale[0], snapshot.scale[1], snapshot.scale[2]);
    return this.markDirty();
  }

  /** Human-readable representation. */
  public toString(precision: number = 4): string {
    return `Transform(pos=${this.position.toString(precision)}, rot=${this.rotation.toString(precision)}, scale=${this.scale.toString(precision)})`;
  }

  /** Scratch quaternion used by the rotation helpers. */
  private static readonly scratchQuat = new Quat();
}

/**
 * A reusable transform that writes its world matrix into a caller-owned matrix.
 *
 * Scene objects own a {@link Transform}; this helper is for code (skinning, GPU
 * instancing) that stores transforms in flat arrays and never needs a local
 * matrix.
 */
export class FlatTransform {
  /** Positions, three floats per entry. */
  public readonly positions: Float32Array;

  /** Quaternions, four floats per entry. */
  public readonly quaternions: Float32Array;

  /** Scales, three floats per entry. */
  public readonly scales: Float32Array;

  /** Number of entries. */
  public readonly count: number;

  /** Creates a flat transform buffer for `count` entries. */
  constructor(count: number) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.quaternions = new Float32Array(count * 4);
    this.scales = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.quaternions[i * 4 + 3] = 1;
      this.scales[i * 3] = 1;
      this.scales[i * 3 + 1] = 1;
      this.scales[i * 3 + 2] = 1;
    }
  }

  /** Reads entry `index` into a {@link Transform}. */
  public get(index: number, target: Transform = new Transform()): Transform {
    const p = index * 3;
    const q = index * 4;
    target.position.set(this.positions[p], this.positions[p + 1], this.positions[p + 2]);
    target.quaternion.set(this.quaternions[q], this.quaternions[q + 1], this.quaternions[q + 2], this.quaternions[q + 3]);
    target.rotation.setFromQuat(target.quaternion, target.rotation.order);
    target.scale.set(this.scales[p], this.scales[p + 1], this.scales[p + 2]);
    return target.markDirty();
  }

  /** Writes entry `index` from a {@link Transform}. */
  public set(index: number, value: Transform): this {
    const p = index * 3;
    const q = index * 4;
    value.position.toFloat32Array(this.positions, p);
    this.quaternions[q] = value.quaternion.x;
    this.quaternions[q + 1] = value.quaternion.y;
    this.quaternions[q + 2] = value.quaternion.z;
    this.quaternions[q + 3] = value.quaternion.w;
    value.scale.toFloat32Array(this.scales, p);
    return this;
  }

  /** Composes every entry into `target` (12 floats each: position + quaternion + scale). */
  public toInterleaved(target: Float32Array = new Float32Array(this.count * 10)): Float32Array {
    for (let i = 0; i < this.count; i++) {
      const offset = i * 10;
      const p = i * 3;
      const q = i * 4;
      target[offset] = this.positions[p];
      target[offset + 1] = this.positions[p + 1];
      target[offset + 2] = this.positions[p + 2];
      target[offset + 3] = this.quaternions[q];
      target[offset + 4] = this.quaternions[q + 1];
      target[offset + 5] = this.quaternions[q + 2];
      target[offset + 6] = this.quaternions[q + 3];
      target[offset + 7] = this.scales[p];
      target[offset + 8] = this.scales[p + 1];
      target[offset + 9] = this.scales[p + 2];
    }
    return target;
  }
}
