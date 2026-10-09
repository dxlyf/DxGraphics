/**
 * `Object3D` - the base class of every node in the 3D scene graph.
 *
 * A node owns a local transform (position, quaternion, scale), a cached local
 * matrix and a cached world matrix. `position`, `rotation` and `scale` feed a
 * single `quaternion`, so the two rotation representations can never drift
 * apart, and every mutation routes through a change callback that flags the
 * local matrix as dirty.
 *
 * ```ts
 * const root = new Object3D();
 * const child = new Object3D({ name: 'child' });
 * child.position.set(1, 2, 3);
 * root.add(child);
 * root.updateMatrixWorld();
 * child.getWorldPosition(new Vec3());   // (1, 2, 3)
 * ```
 *
 * Composition follows the column-vector convention used by `Mat4`:
 * `matrixWorld = parent.matrixWorld * matrix`.
 *
 * @packageDocumentation
 */

import { createId } from '../../utils/Id';
import { Euler } from '../../math/Euler';
import { Mat4 } from '../../math/Mat4';
import { Quat } from '../../math/Quat';
import { Vec3 } from '../../math/Vec3';
import { TypedEventEmitter } from '../internal/emitter';
import type {
  Intersects,
  Object3DJson,
  Object3DOptions,
  RaycasterLike,
  Vector3Like,
} from './types';
import { SCENE_JSON_GENERATOR, SCENE_JSON_VERSION } from './types';

/** Framework-level events emitted by every scene node. */
export interface Object3DEventMap {
  /** The node was added to a parent. */
  added: { parent: Object3D };
  /** The node was removed from a parent. */
  removed: { parent: Object3D };
  /** A child was added. */
  childadded: { child: Object3D };
  /** A child was removed. */
  childremoved: { child: Object3D };
  /** The local transform changed and the local matrix is stale. */
  change: undefined;
  /** The node was disposed. */
  dispose: undefined;
}

/** Argument accepted by {@link Object3D.lookAt}. */
export type LookAtTarget = Vector3Like | readonly [number, number, number] | number;

/** Scratch quaternion shared by the world-state helpers; never exposed. */
const scratchQuat = new Quat();

/** Scratch scale shared by the world-state helpers; never exposed. */
const scratchScale = new Vec3();

/** First scratch vector shared by the world-state helpers. */
const scratchVecA = new Vec3();

/** Second scratch vector shared by the world-state helpers. */
const scratchVecB = new Vec3();

/** Scratch matrix shared by `attach`, `detach`, `lookAt` and `worldToLocal`. */
const scratchMat = new Mat4();

/** Scratch basis vectors used by `lookAt`. */
const scratchBasisX = new Vec3();

/** Scratch basis vector used by `lookAt`. */
const scratchBasisY = new Vec3();

/** Scratch basis vector used by `lookAt`. */
const scratchBasisZ = new Vec3();

/** Identity used when a node has no parent; avoids one allocation per update. */
const IDENTITY_MATRIX = new Mat4();

/** Shared origin used by `lookAt`'s basis construction. */
const ZERO_VEC = new Vec3(0, 0, 0);

/** Local axis constants; never mutated, so sharing them is safe. */
const AXIS_X = new Vec3(1, 0, 0);

/** Local `+Y` axis. */
const AXIS_Y = new Vec3(0, 1, 0);

/** Local `+Z` axis. */
const AXIS_Z = new Vec3(0, 0, 1);

/**
 * Base class for every object placed in a 3D scene.
 *
 * Subclasses add rendering payload (`Mesh`, `Points`, `Light`, ...) but never
 * change the transform semantics defined here.
 */
export class Object3D extends TypedEventEmitter<Object3DEventMap> {
  /** Up vector applied to a brand-new node; the `+Y` axis. */
  public static readonly DEFAULT_UP = new Vec3(0, 1, 0);

  /** Default value of {@link Object3D.matrixAutoUpdate}. */
  public static readonly DEFAULT_MATRIX_AUTO_UPDATE = true;

  /** Allows consumers to detect the base class without an `instanceof` check. */
  public readonly isObject3D = true;

  /** Stable, process-unique identifier. */
  public readonly id: string;

  /** Human-readable name; `''` unless the caller sets one. */
  public name: string = '';

  /** Class name, overridden by every subclass (`'Mesh'`, `'Light'`, ...). */
  public readonly type: string = 'Object3D';

  /** Parent node, or `null` while detached. */
  public parent: Object3D | null = null;

  /** Direct children, in traversal order. */
  public readonly children: Object3D[] = [];

  /** Skips this subtree while rendering when `false`. */
  public visible = true;

  /** Explicit draw-order override consumed by the renderer's sort. */
  public renderOrder = 0;

  /** User-owned payload; never touched by the library. */
  public userData: Record<string, unknown> = {};

  /** Recomputes {@link Object3D.matrix} from the transform before every update. */
  public matrixAutoUpdate = Object3D.DEFAULT_MATRIX_AUTO_UPDATE;

  /** Skips the frustum test for this node when `false`. */
  public frustumCulled = true;

  /** Includes this node in shadow-map passes. */
  public castShadow = false;

  /** Samples this node while shading shadow maps. */
  public receiveShadow = false;

  /**
   * Layer bitmask of this node. Bit `0` is set by default, and the renderer
   * compares it against `Camera3D.layers` during culling and picking.
   */
  public layers = 1;

  /** Local translation, relative to the parent's origin. */
  public readonly position: Vec3;

  /** Local rotation in radians; kept in sync with {@link Object3D.quaternion}. */
  public readonly rotation: Euler;

  /** Local scale; `1` on every axis by default. */
  public readonly scale: Vec3;

  /** Local rotation as a quaternion; the authoritative rotation storage. */
  public readonly quaternion: Quat;

  /** Up axis used exclusively by {@link Object3D.lookAt}. */
  public readonly up: Vec3;

  /** Cached local TRS matrix. */
  public readonly matrix: Mat4;

  /** Cached world matrix (`parent.matrixWorld * matrix`). */
  public readonly matrixWorld: Mat4;

  /** `true` while the local matrix is stale. */
  private matrixNeedsUpdate = true;

  /** Guards the rotation/quaternion feedback loop. */
  private syncingRotation = false;

  /** Creates a node; every field of `options` is optional. */
  constructor(options: Object3DOptions = {}) {
    super();
    this.id = createId('object3d');
    this.position = new Vec3(0, 0, 0);
    this.rotation = new Euler(0, 0, 0, 'XYZ');
    this.scale = new Vec3(1, 1, 1);
    this.quaternion = new Quat(0, 0, 0, 1);
    this.up = Object3D.DEFAULT_UP.clone();
    this.matrix = new Mat4();
    this.matrixWorld = new Mat4();

    if (options.name !== undefined) this.name = options.name;
    if (options.visible !== undefined) this.visible = options.visible;
    if (options.renderOrder !== undefined) this.renderOrder = options.renderOrder;
    if (options.matrixAutoUpdate !== undefined) this.matrixAutoUpdate = options.matrixAutoUpdate;
    if (options.frustumCulled !== undefined) this.frustumCulled = options.frustumCulled;
    if (options.castShadow !== undefined) this.castShadow = options.castShadow;
    if (options.receiveShadow !== undefined) this.receiveShadow = options.receiveShadow;
    if (options.layers !== undefined) this.layers = options.layers;
    if (options.userData !== undefined) this.userData = { ...options.userData };
    if (options.position) {
      this.position.set(
        readX(options.position),
        readY(options.position),
        readZ(options.position),
      );
    }
    if (options.scale) {
      this.scale.set(readX(options.scale), readY(options.scale), readZ(options.scale));
    }
    if (options.rotation) {
      this.rotation.set(
        options.rotation.x ?? 0,
        options.rotation.y ?? 0,
        options.rotation.z ?? 0,
        (options.rotation.order as Euler['order']) ?? 'XYZ',
      );
    }

    // Rotation is the primary input: it always regenerates the quaternion.
    this.rotation.onChange = () => this.syncQuaternionFromRotation();
    this.quaternion.onChange = () => this.syncRotationFromQuaternion();
    this.syncQuaternionFromRotation();
  }

  /* ------------------------------------------------------------------ tree */

  /**
   * Adds one or more children.
   *
   * A child is reparented automatically, and a node that is an ancestor of
   * `this` is rejected rather than corrupting the graph.
   *
   * @returns `this`, so calls chain.
   */
  public add(...objects: Object3D[]): this {
    for (const object of objects) {
      if (!object || object === this) continue;
      // Adding an ancestor would create a cycle.
      if (this.isDescendantOf(object)) continue;
      if (object.parent !== null) object.parent.remove(object);
      object.parent = this;
      this.children.push(object);
      object.emit('added', { parent: this });
      this.emit('childadded', { child: object });
    }
    return this;
  }

  /**
   * Removes one or more direct children.
   *
   * Removing an object that is not a child of `this` is a no-op, so calling
   * `remove` twice during teardown is safe.
   *
   * @returns `this`, so calls chain.
   */
  public remove(...objects: Object3D[]): this {
    for (const object of objects) {
      if (!object) continue;
      const index = this.children.indexOf(object);
      if (index === -1) continue;
      this.children.splice(index, 1);
      object.parent = null;
      object.emit('removed', { parent: this });
      this.emit('childremoved', { child: object });
    }
    return this;
  }

  /** Detaches this node from its parent, preserving its local transform. */
  public removeFromParent(): this {
    if (this.parent !== null) this.parent.remove(this);
    return this;
  }

  /** Detaches every child from this node. */
  public clear(): this {
    for (let i = this.children.length - 1; i >= 0; i--) this.remove(this.children[i]);
    return this;
  }

  /**
   * Reparents `child` **without** changing its world transform.
   *
   * @returns `this`, so calls chain.
   */
  public attach(child: Object3D): this {
    if (!child || child === this || this.isDescendantOf(child)) return this;
    this.updateWorldMatrix(true, false);
    scratchMat.copy(this.matrixWorld).invert();
    if (child.parent !== null) {
      child.parent.updateWorldMatrix(true, false);
      scratchMat.multiply(child.parent.matrixWorld);
    }
    child.applyMatrix4(scratchMat);
    this.add(child);
    return this;
  }

  /**
   * Inverse of {@link Object3D.attach}: detaches `child` while preserving its
   * world transform.
   */
  public detach(child: Object3D): this {
    if (child.parent !== this) return this;
    this.updateWorldMatrix(true, false);
    child.applyMatrix4(this.matrixWorld);
    this.remove(child);
    return this;
  }

  /* ------------------------------------------------------------- traversal */

  /** Depth-first walk over this node and every descendant. */
  public traverse(callback: (object: Object3D) => void): void {
    callback(this);
    for (let i = 0; i < this.children.length; i++) this.children[i].traverse(callback);
  }

  /** Depth-first walk that skips the subtrees of invisible nodes. */
  public traverseVisible(callback: (object: Object3D) => void): void {
    if (!this.visible) return;
    callback(this);
    for (let i = 0; i < this.children.length; i++) this.children[i].traverseVisible(callback);
  }

  /** Walks from this node up to the root, `this` first. */
  public traverseAncestors(callback: (object: Object3D) => void): void {
    const parent = this.parent;
    if (parent !== null) {
      callback(parent);
      parent.traverseAncestors(callback);
    }
  }

  /** Finds the first node in the subtree whose {@link Object3D.id} matches. */
  public getObjectById(id: string): Object3D | undefined {
    return this.getObjectByProperty('id', id);
  }

  /** Finds the first node in the subtree whose {@link Object3D.name} matches. */
  public getObjectByName(name: string): Object3D | undefined {
    return this.getObjectByProperty('name', name);
  }

  /** Finds the first node in the subtree whose `property` equals `value`. */
  public getObjectByProperty(name: string, value: unknown): Object3D | undefined {
    if ((this as unknown as Record<string, unknown>)[name] === value) return this;
    for (let i = 0; i < this.children.length; i++) {
      const found = this.children[i].getObjectByProperty(name, value);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /**
   * `true` when `node` is this node or one of its ancestors.
   *
   * Walks *up* the parent chain, so `child.isDescendantOf(root)` is `true` while
   * `root.isDescendantOf(child)` is `false`. Use
   * {@link Object3D.isAncestorOf} for the inverse question.
   */
  public isDescendantOf(node: Object3D): boolean {
    let current: Object3D | null = this;
    while (current !== null) {
      if (current === node) return true;
      current = current.parent;
    }
    return false;
  }

  /**
   * `true` when `node` is this node or one of its descendants.
   *
   * This is the test that keeps the graph acyclic: adding an ancestor as a child
   * of one of its own descendants would create a cycle.
   */
  public isAncestorOf(node: Object3D): boolean {
    return node.isDescendantOf(this);
  }

  /** Number of nodes in this subtree, including `this`. */
  public countDescendants(): number {
    let count = 1;
    for (let i = 0; i < this.children.length; i++) count += this.children[i].countDescendants();
    return count;
  }

  /* -------------------------------------------------------------- matrices */

  /** Rebuilds {@link Object3D.matrix} from position, quaternion and scale. */
  public updateMatrix(): void {
    this.matrix.compose(this.position, this.quaternion, this.scale);
    this.matrixNeedsUpdate = false;
    this.emit('change');
  }

  /** Marks the local matrix stale, so the next update recomposes it. */
  public markMatrixDirty(): void {
    this.matrixNeedsUpdate = true;
  }

  /** `true` while the cached local matrix is stale. */
  public get matrixDirty(): boolean {
    return this.matrixNeedsUpdate;
  }

  /**
   * Recomputes this node's world matrix.
   *
   * @param force When `true`, children are updated even if this node did not
   *   change.
   */
  public updateMatrixWorld(force = false): void {
    if (this.matrixAutoUpdate) this.updateMatrix();

    this.matrixWorld.multiplyMatrices(
      this.parent === null ? IDENTITY_MATRIX : this.parent.matrixWorld,
      this.matrix,
    );

    const children = this.children;
    for (let i = 0; i < children.length; i++) children[i].updateMatrixWorld(force);
  }

  /**
   * Updates this node's world matrix, optionally climbing to the root first.
   *
   * @param updateParents Recompute ancestors before this node.
   * @param updateChildren Recurse into descendents after this node.
   */
  public updateWorldMatrix(updateParents: boolean, updateChildren: boolean): void {
    if (updateParents && this.parent !== null) this.parent.updateWorldMatrix(true, false);
    if (this.matrixAutoUpdate) this.updateMatrix();
    this.matrixWorld.multiplyMatrices(
      this.parent === null ? IDENTITY_MATRIX : this.parent.matrixWorld,
      this.matrix,
    );

    if (updateChildren) {
      const children = this.children;
      for (let i = 0; i < children.length; i++) children[i].updateWorldMatrix(false, true);
    }
  }

  /**
   * Transforms a point from local space into world space.
   *
   * @param vector Point to transform.
   * @param target Receives the result; a new `Vec3` is allocated when omitted.
   */
  public localToWorld(vector: Vec3, target: Vec3 = new Vec3()): Vec3 {
    return target.copy(vector).applyMat4(this.matrixWorld);
  }

  /**
   * Transforms a point from world space into local space.
   *
   * @param vector Point to transform.
   * @param target Receives the result; a new `Vec3` is allocated when omitted.
   */
  public worldToLocal(vector: Vec3, target: Vec3 = new Vec3()): Vec3 {
    return target.copy(vector).applyMat4(scratchMat.copy(this.matrixWorld).invert());
  }

  /* ------------------------------------------------------------ world state */

  /** Writes this node's world position into `target`. */
  public getWorldPosition(target: Vec3 = new Vec3()): Vec3 {
    this.updateWorldMatrix(true, false);
    return this.matrixWorld.getTranslation(target);
  }

  /** Writes this node's world rotation into `target`. */
  public getWorldQuaternion(target: Quat = new Quat()): Quat {
    this.updateWorldMatrix(true, false);
    this.matrixWorld.decompose(scratchVecA, target, scratchScale);
    return target;
  }

  /** Writes this node's world scale into `target`. */
  public getWorldScale(target: Vec3 = new Vec3()): Vec3 {
    this.updateWorldMatrix(true, false);
    this.matrixWorld.decompose(scratchVecB, scratchQuat, target);
    return target;
  }

  /** Writes this node's world forward direction (`+Z` of the world matrix). */
  public getWorldDirection(target: Vec3 = new Vec3()): Vec3 {
    this.updateWorldMatrix(true, false);
    const e = this.matrixWorld.elements;
    return target.set(e[8], e[9], e[10]).normalize();
  }

  /* ------------------------------------------------------------- transforms */

  /**
   * Rotates this node so it faces `target`.
   *
   * Cameras and lights look down their `-Z` axis; every other node looks down
   * `+Z`, matching the billboard conventions the renderer uses.
   */
  public lookAt(target: LookAtTarget): this {
    if (target instanceof Object3D) {
      target.getWorldPosition(scratchVecA);
      target = scratchVecA;
    }
    const x = typeof target === 'number' ? target : (target as Vector3Like).x;
    const y = typeof target === 'number' ? target : (target as Vector3Like).y;
    const z = typeof target === 'number' ? target : (target as Vector3Like).z;

    this.updateWorldMatrix(true, false);
    const e = this.matrixWorld.elements;
    const eyeX = e[12];
    const eyeY = e[13];
    const eyeZ = e[14];

    // `z` is the axis that points away from the target.
    let zx: number;
    let zy: number;
    let zz: number;
    if (this.isCameraLike()) {
      zx = eyeX - x;
      zy = eyeY - y;
      zz = eyeZ - z;
    } else {
      zx = x - eyeX;
      zy = y - eyeY;
      zz = z - eyeZ;
    }
    const length = Math.hypot(zx, zy, zz);
    if (length === 0) return this;
    zx /= length;
    zy /= length;
    zz /= length;

    // x = normalize(cross(up, z))
    let xx = this.up.y * zz - this.up.z * zy;
    let xy = this.up.z * zx - this.up.x * zz;
    let xz = this.up.x * zy - this.up.y * zx;
    let xLength = Math.hypot(xx, xy, xz);

    if (xLength === 0) {
      // `up` is parallel to the look direction: pick a perpendicular axis.
      if (Math.abs(zx) > Math.abs(zz)) {
        xx = -zy;
        xy = zx;
        xz = 0;
      } else {
        xx = 0;
        xy = -zz;
        xz = zy;
      }
      xLength = Math.hypot(xx, xy, xz) || 1;
    }
    xx /= xLength;
    xy /= xLength;
    xz /= xLength;

    // y = cross(z, x)
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    scratchBasisX.set(xx, xy, xz);
    scratchBasisY.set(yx, yy, yz);
    scratchBasisZ.set(zx, zy, zz);
    scratchMat.makeBasis(scratchBasisX, scratchBasisY, scratchBasisZ, ZERO_VEC);
    this.quaternion.setFromRotationMatrix(scratchMat);
    return this;
  }

  /** Rotates about an axis expressed in this node's local frame. */
  public rotateOnAxis(axis: Vec3, angle: number): this {
    scratchQuat.setFromAxisAngle(axis, angle);
    this.quaternion.multiply(scratchQuat);
    return this;
  }

  /** Rotates about an axis expressed in world space. */
  public rotateOnWorldAxis(axis: Vec3, angle: number): this {
    scratchQuat.setFromAxisAngle(axis, angle);
    this.quaternion.premultiply(scratchQuat);
    return this;
  }

  /** Rotates about the local `+X` axis by `angle` radians. */
  public rotateX(angle: number): this {
    return this.rotateOnAxis(AXIS_X, angle);
  }

  /** Rotates about the local `+Y` axis by `angle` radians. */
  public rotateY(angle: number): this {
    return this.rotateOnAxis(AXIS_Y, angle);
  }

  /** Rotates about the local `+Z` axis by `angle` radians. */
  public rotateZ(angle: number): this {
    return this.rotateOnAxis(AXIS_Z, angle);
  }

  /** Moves along an axis expressed in this node's local frame. */
  public translateOnAxis(axis: Vec3, distance: number): this {
    scratchVecA.copy(axis).applyQuat(this.quaternion).multiplyScalar(distance);
    this.position.add(scratchVecA);
    return this;
  }

  /** Moves `distance` along the local `+X` axis. */
  public translateX(distance: number): this {
    return this.translateOnAxis(AXIS_X, distance);
  }

  /** Moves `distance` along the local `+Y` axis. */
  public translateY(distance: number): this {
    return this.translateOnAxis(AXIS_Y, distance);
  }

  /** Moves `distance` along the local `+Z` axis. */
  public translateZ(distance: number): this {
    return this.translateOnAxis(AXIS_Z, distance);
  }

  /** Applies a world-space rotation to this node (pre-multiplied). */
  public applyQuaternion(quaternion: Quat): this {
    this.quaternion.premultiply(quaternion);
    return this;
  }

  /** Replaces the rotation from a quaternion; refreshes the Euler triple. */
  public setRotationFromQuaternion(quaternion: Quat): this {
    this.quaternion.copy(quaternion);
    return this;
  }

  /** Replaces the rotation from an Euler triple; refreshes the quaternion. */
  public setRotationFromEuler(euler: Euler): this {
    this.rotation.copy(euler);
    return this;
  }

  /** Replaces the rotation from a matrix (rotation part only). */
  public setRotationFromMatrix(m: Mat4): this {
    this.quaternion.setFromRotationMatrix(m);
    return this;
  }

  /** Pre-multiplies the local transform by `m`, then decomposes it again. */
  public applyMatrix4(m: Mat4): this {
    this.matrix.premultiply(m);
    this.matrix.decompose(this.position, this.quaternion, this.scale);
    return this;
  }

  /* --------------------------------------------------------------- picking */

  /**
   * Appends every ray/object intersection to `intersects`.
   *
   * The base implementation is a deliberate no-op; geometry-bearing subclasses
   * override it.
   */
  public raycast(_raycaster: RaycasterLike, _intersects: Intersects): void {
    /* no-op: subclasses own their intersection tests */
  }

  /* ------------------------------------------------------- copy / serialise */

  /** Copies every public field of `source` into this node. */
  public copy(source: Object3D, recursive = true): this {
    this.name = source.name;
    this.visible = source.visible;
    this.renderOrder = source.renderOrder;
    this.matrixAutoUpdate = source.matrixAutoUpdate;
    this.frustumCulled = source.frustumCulled;
    this.castShadow = source.castShadow;
    this.receiveShadow = source.receiveShadow;
    this.layers = source.layers;
    this.userData = cloneUserData(source.userData);

    this.position.copy(source.position);
    this.rotation.copy(source.rotation);
    this.quaternion.copy(source.quaternion);
    this.scale.copy(source.scale);
    this.up.copy(source.up);
    this.matrix.copy(source.matrix);
    this.matrixWorld.copy(source.matrixWorld);
    this.matrixNeedsUpdate = source.matrixNeedsUpdate;

    if (recursive) {
      this.clear();
      for (let i = 0; i < source.children.length; i++) this.add(source.children[i].clone(true));
    }
    return this;
  }

  /** Returns a deep-ish copy of this node (children included when `recursive`). */
  public clone(recursive = true): Object3D {
    return new Object3D().copy(this, recursive);
  }

  /** Serialises this node, and optionally its whole subtree. */
  public toJSON(recursive = true): Object3DJson {
    const json: Object3DJson = {
      metadata: { version: SCENE_JSON_VERSION, generator: SCENE_JSON_GENERATOR },
      type: this.type,
      uuid: this.id,
      name: this.name,
      matrix: this.matrix.toArray(),
      position: this.position.toJSON(),
      rotation: [...this.rotation.toArray(), this.rotation.order],
      quaternion: this.quaternion.toJSON(),
      scale: this.scale.toJSON(),
      visible: this.visible,
      renderOrder: this.renderOrder,
      layers: this.layers,
      castShadow: this.castShadow,
      receiveShadow: this.receiveShadow,
      frustumCulled: this.frustumCulled,
      userData: this.userData,
    };
    if (recursive) json.children = this.children.map((child) => child.toJSON(true));
    return json;
  }

  /** Releases listeners and detaches the node from its parent. */
  public dispose(): void {
    this.emit('dispose');
    this.removeFromParent();
    this.removeAllListeners();
  }

  /* ---------------------------------------------------------------- helpers */

  /**
   * `true` for nodes that look down `-Z`, i.e. cameras and spot/directional
   * lights. Kept as a method so `Object3D` needs no import from `Camera3D`.
   */
  protected isCameraLike(): boolean {
    return false;
  }

  /**
   * Copies the Euler triple into the quaternion (rotation -> quaternion).
   *
   * Registered on `rotation.onChange`, so both `obj.rotation.x = 1` and
   * `obj.rotation.set(...)` keep the quaternion current.
   */
  protected syncQuaternionFromRotation(): void {
    if (this.syncingRotation) return;
    this.quaternion.setFromEuler(this.rotation);
  }

  /**
   * Copies the quaternion into the Euler triple (quaternion -> rotation).
   *
   * Registered on `quaternion.onChange`; the guard prevents the two change
   * callbacks from recursing into each other.
   */
  protected syncRotationFromQuaternion(): void {
    if (this.syncingRotation) return;
    this.syncingRotation = true;
    this.rotation.setFromQuat(this.quaternion, this.rotation.order);
    this.syncingRotation = false;
  }
}

/** Reads `x` from a partial vector, defaulting to `0`. */
function readX(value: { x?: number }): number {
  return value.x ?? 0;
}

/** Reads `y` from a partial vector, defaulting to `0`. */
function readY(value: { y?: number }): number {
  return value.y ?? 0;
}

/** Reads `z` from a partial vector, defaulting to `0`. */
function readZ(value: { z?: number }): number {
  return value.z ?? 0;
}

/** Shallow-clones `userData`, guarding against prototype-pollution keys. */
function cloneUserData(source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    result[key] = source[key];
  }
  return result;
}
