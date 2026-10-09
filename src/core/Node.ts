/**
 * `Node` — the backend-agnostic scene-graph node.
 *
 * `Node` is the *core* graph: identity, parenting, a {@link Transform}, a
 * {@link Layers} mask, visibility flags and lifecycle hooks. The 2D and 3D scene
 * layers (`scene/2d/Node2D`, `scene/3d/Object3D`) build their richer APIs on top
 * of it, and the renderer consumes the graph through the interfaces in
 * `core/types.ts` rather than through concrete classes.
 *
 * ```ts
 * const root = new Node({ name: 'root' });
 * const child = root.add(new Node({ name: 'child' }));
 * child.position.set(1, 0, 0);
 * root.updateMatrixWorld();
 * ```
 *
 * @packageDocumentation
 */

import { Mat4 } from '../math/Mat4';
import { Quat } from '../math/Quat';
import { Vec3 } from '../math/Vec3';
import { createId } from '../utils/Id';
import { log } from '../utils/Logger';
import { EventDispatcher } from './EventDispatcher';
import type { CoreEventMap } from './events';
import { Layers, type Layer } from './Layer';
import { Transform } from './Transform';
import type { FrameInfo, NodeType } from './types';

/** Options accepted by the {@link Node} constructor. */
export interface NodeOptions {
  /** Human-readable name; defaults to a generated id. */
  name?: string;
  /** Initial position. */
  position?: { x: number; y: number; z: number } | [number, number, number];
  /** Initial rotation (Euler radians). */
  rotation?: { x: number; y: number; z: number; order?: string } | [number, number, number];
  /** Initial scale. */
  scale?: { x: number; y: number; z: number } | number | [number, number, number];
  /** `false` to hide the node (and therefore its subtree) immediately. */
  visible?: boolean;
  /** Layer bits to enable. */
  layers?: readonly (Layer | number)[];
  /** Arbitrary user payload. */
  userData?: Record<string, unknown>;
}

/**
 * A scene-graph node.
 *
 * Every graph object shares the single {@link CoreEventMap} event map, so `on`
 * and `emit` stay fully type-checked without threading a generic parameter
 * through the whole hierarchy. See `core/events.ts` for the rationale.
 */
export class Node extends EventDispatcher<CoreEventMap> {
  /** Unique identifier, stable for the lifetime of the object. */
  public readonly id: string = createId('node');

  /** Human-readable name, used by lookups and debug output. */
  public name: string;

  /** Concrete type name, overridden by subclasses (`'Mesh'`, `'Points'`, ...). */
  public get type(): NodeType {
    return 'Node';
  }

  /** `false` hides the node and its subtree. */
  public visible = true;

  /** Draw order hint consumed by the render queue. */
  public renderOrder = 0;

  /** Layer mask tested against the camera's. */
  public readonly layers: Layers = new Layers();

  /** Parent in the scene graph, or `null` when detached. */
  public override parent: Node | null = null;

  /** Child nodes, in insertion order. */
  public readonly children: Node[] = [];

  /** Position, rotation and scale, plus the composed local matrix. */
  public readonly transform: Transform;

  /** `false` to skip the automatic local-matrix recomposition. */
  public matrixAutoUpdate = true;

  /** `true` when the world matrix needs recomputing. */
  public matrixWorldNeedsUpdate = true;

  /** `false` to exclude the node from frustum culling. */
  public frustumCulled = true;

  /** `true` when the node should be traversed by update schedulers. */
  public enabled = true;

  /** Arbitrary application payload, untouched by the library. */
  public userData: Record<string, unknown>;

  /** `true` once {@link dispose} has run. */
  public nodesDisposed = false;

  /** Depth in the graph, maintained by {@link add}/{@link remove}. */
  public depth = 0;

  /**
   * Creates a node.
   *
   * @param options Optional initial state.
   */
  constructor(options: NodeOptions = {}) {
    super();
    this.name = options.name ?? this.id;
    this.userData = options.userData ?? {};
    this.visible = options.visible ?? true;

    this.transform = new Transform({
      onChange: () => {
        this.matrixWorldNeedsUpdate = true;
        this.emit('matrixchanged');
      },
    });

    if (options.position) {
      if (Array.isArray(options.position)) this.transform.position.set(...options.position);
      else this.transform.position.copy(options.position as Vec3);
    }
    if (options.rotation) {
      if (Array.isArray(options.rotation)) this.transform.rotation.set(...options.rotation);
      else {
        const rotation = options.rotation;
        this.transform.rotation.set(rotation.x, rotation.y, rotation.z);
        this.transform.quaternion.setFromEuler(this.transform.rotation);
      }
    }
    if (options.scale !== undefined) {
      if (typeof options.scale === 'number') this.transform.scale.setScalar(options.scale);
      else if (Array.isArray(options.scale)) this.transform.scale.set(...options.scale);
      else this.transform.scale.copy(options.scale as Vec3);
    }
    if (options.layers) {
      for (const layer of options.layers) this.layers.enable(layer);
    }
  }

  /* -------------------------------------------------------- local transform */

  /** Local position. Alias of `this.transform.position`. */
  public get position(): Vec3 {
    return this.transform.position;
  }

  /** Local Euler rotation (radians). */
  public get rotation(): import('../math/Euler').Euler {
    return this.transform.rotation;
  }

  /** Local rotation as a quaternion. */
  public get quaternion(): Quat {
    return this.transform.quaternion;
  }

  /** Local scale. */
  public get scale(): Vec3 {
    return this.transform.scale;
  }

  /** Composed local matrix. */
  public get matrix(): Mat4 {
    return this.transform.getMatrix();
  }

  /** Composed world matrix; only valid after {@link updateMatrixWorld}. */
  public readonly matrixWorld: Mat4 = new Mat4();

  /** Recomputes the local matrix from position/quaternion/scale. */
  public updateMatrix(): this {
    this.transform.updateMatrix();
    return this;
  }

  /**
   * Recomputes this node's world matrix and, when needed, its children's.
   *
   * @param force Recompute even when no change was flagged.
   */
  public updateMatrixWorld(force: boolean = false): this {
    if (this.matrixAutoUpdate) this.transform.updateMatrix();

    if (this.matrixWorldNeedsUpdate || force) {
      if (this.parent) {
        this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.transform.matrix);
      } else {
        this.matrixWorld.copy(this.transform.matrix);
      }
      this.matrixWorldNeedsUpdate = false;
      this.emit('worldmatrixchanged');
      force = true;
    }

    for (let i = 0; i < this.children.length; i++) {
      this.children[i].updateMatrixWorld(force);
    }
    return this;
  }

  /* ------------------------------------------------------------ parenting */

  /**
   * Attaches children.
   *
   * Reparenting an already parented node detaches it from its previous parent
   * first, so a node is never in two places at once.
   *
   * @returns The first added child, so `const child = parent.add(new Node())` works.
   */
  public add<T extends Node>(...nodes: T[]): T {
    for (const node of nodes) {
      if (!node) continue;
      if (node === (this as unknown as Node)) {
        log.warn('Node.add: refusing to add a node to itself');
        continue;
      }
      // A cycle appears when the prospective child is already an ancestor of
      // this node: attaching it would make `node` both a parent and a
      // grandchild of itself. Checking the other direction (is `this` an
      // ancestor of `node`) is always false for a not-yet-attached node, so it
      // would never catch the case this guard exists for.
      if (node.isAncestorOf(this as unknown as Node)) {
        log.warn('Node.add: refusing to create a cycle in the scene graph');
        continue;
      }
      if (node.parent) node.parent.remove(node);

      node.parent = this as unknown as Node;
      node.depth = this.depth + 1;
      node.matrixWorldNeedsUpdate = true;
      this.children.push(node);
      this.emit('added', this, node);
    }
    return nodes[0];
  }

  /** Detaches children. */
  public remove(...nodes: Node[]): this {
    for (const node of nodes) {
      const index = this.children.indexOf(node);
      if (index < 0) continue;
      this.children.splice(index, 1);
      node.parent = null;
      node.depth = 0;
      node.matrixWorldNeedsUpdate = true;
      this.emit('removed', this, node);
    }
    return this;
  }

  /** Detaches this node from its parent. */
  public removeFromParent(): this {
    this.parent?.remove(this);
    return this;
  }

  /** Removes every child. */
  public clear(): this {
    while (this.children.length > 0) {
      const child = this.children[this.children.length - 1];
      this.remove(child);
    }
    return this;
  }

  /**
   * Attaches `child` while preserving its world transform.
   *
   * The child's local transform is rewritten so that its world matrix is
   * unchanged by the reparenting: `local = inverse(parentWorld) * childWorld`.
   * Decomposing that product into position/quaternion/scale clears the transform's
   * dirty flag, so the next `updateMatrixWorld` recomposes exactly the same local
   * matrix instead of overwriting it from stale TRS values.
   */
  public attach<T extends Node>(child: T): T {
    this.updateMatrixWorld();
    child.updateMatrixWorld();

    const childWorld = child.matrixWorld.clone();
    const inverseParentWorld = this.matrixWorld.clone().invert();
    const localMatrix = new Mat4().multiplyMatrices(inverseParentWorld, childWorld);

    this.add(child);
    child.transform.applyMatrix(localMatrix);
    child.matrixWorld.copy(childWorld);
    child.matrixWorldNeedsUpdate = true;
    return child;
  }

  /** Detaches `child` while preserving its world transform (inverse of `attach`). */
  public detach<T extends Node>(child: T): T {
    if (!child.parent) return child;
    const parent = child.parent;
    child.updateMatrixWorld();
    const childWorld = child.matrixWorld.clone();
    parent.remove(child);
    // Detached, the node's local transform IS its world transform.
    child.transform.applyMatrix(childWorld);
    child.matrixWorld.copy(childWorld);
    child.matrixWorldNeedsUpdate = true;
    return child;
  }

  /** Replaces `oldChild` with `newChild`, keeping the position in the child list. */
  public replaceChild(oldChild: Node, newChild: Node): boolean {
    const index = this.children.indexOf(oldChild);
    if (index < 0) return false;
    if (newChild.parent) newChild.parent.remove(newChild);
    this.children[index] = newChild;
    newChild.parent = this as unknown as Node;
    newChild.depth = this.depth + 1;
    newChild.matrixWorldNeedsUpdate = true;
    oldChild.parent = null;
    this.emit('removed', this, oldChild);
    this.emit('added', this, newChild);
    return true;
  }

  /** `true` when `node` is a descendant of this node. */
  public isAncestorOf(node: Node): boolean {
    let current = node.parent;
    while (current) {
      if (current === (this as unknown as Node)) return true;
      current = current.parent;
    }
    return false;
  }

  /** `true` when `node` is an ancestor of this node. */
  public isDescendantOf(node: Node): boolean {
    return node.isAncestorOf(this as unknown as Node);
  }

  /** Root of this node's tree. */
  public getRoot(): Node {
    let current: Node = this;
    while (current.parent) current = current.parent;
    return current;
  }

  /* ------------------------------------------------------------ traversal */

  /** Visits this node and every descendant, depth first, in child order. */
  public traverse(callback: (node: Node) => void): this {
    callback(this);
    for (let i = 0; i < this.children.length; i++) {
      this.children[i].traverse(callback);
    }
    return this;
  }

  /** Like {@link traverse} but skips invisible subtrees. */
  public traverseVisible(callback: (node: Node) => void): this {
    if (!this.visible) return this;
    callback(this);
    for (let i = 0; i < this.children.length; i++) {
      this.children[i].traverseVisible(callback);
    }
    return this;
  }

  /** Visits this node's ancestors, starting with the direct parent. */
  public traverseAncestors(callback: (node: Node) => void): this {
    let current = this.parent;
    while (current) {
      callback(current);
      current = current.parent;
    }
    return this;
  }

  /** Collects every node satisfying `predicate`. */
  public findNodes(predicate: (node: Node) => boolean, results: Node[] = []): Node[] {
    this.traverse((node) => {
      if (predicate(node)) results.push(node);
    });
    return results;
  }

  /** Finds the first node with the given id. */
  public getNodeById(id: string): Node | null {
    let found: Node | null = null;
    this.traverse((node) => {
      if (!found && node.id === id) found = node;
    });
    return found;
  }

  /** Finds the first node with the given name. */
  public getNodeByName(name: string): Node | null {
    let found: Node | null = null;
    this.traverse((node) => {
      if (!found && node.name === name) found = node;
    });
    return found;
  }

  /** Finds the first node carrying `value` under `property`. */
  public getNodeByProperty(property: string, value: unknown): Node | null {
    let found: Node | null = null;
    this.traverse((node) => {
      if (!found && (node as unknown as Record<string, unknown>)[property] === value) found = node;
    });
    return found;
  }

  /** Number of nodes in this subtree, including this one. */
  public getNodeCount(): number {
    let count = 0;
    this.traverse(() => {
      count++;
    });
    return count;
  }

  /* -------------------------------------------------------------- matrices */

  /** Copies this node's world position into `target`. */
  public getWorldPosition(target: Vec3 = new Vec3()): Vec3 {
    this.updateMatrixWorld();
    return target.setFromMatrixPosition(this.matrixWorld);
  }

  /** Copies the world-space quaternion into `target`. */
  public getWorldQuaternion(target: Quat = new Quat()): Quat {
    this.updateMatrixWorld();
    this.matrixWorld.decompose(Node.scratchPosition, target, Node.scratchScale);
    return target;
  }

  /** Copies the world-space scale into `target`. */
  public getWorldScale(target: Vec3 = new Vec3()): Vec3 {
    this.updateMatrixWorld();
    Node.scratchQuaternion.set(0, 0, 0, 1);
    this.matrixWorld.decompose(Node.scratchPosition, Node.scratchQuaternion, target);
    return target;
  }

  /** World-space forward direction (`-Z` of the world matrix). */
  public getWorldDirection(target: Vec3 = new Vec3()): Vec3 {
    this.updateMatrixWorld();
    const e = this.matrixWorld.elements;
    return target.set(-e[8], -e[9], -e[10]).normalize();
  }

  /** Transforms a local-space point into world space. */
  public localToWorld(vector: Vec3): Vec3 {
    this.updateMatrixWorld();
    return vector.applyMat4(this.matrixWorld);
  }

  /** Transforms a world-space point into this node's local space. */
  public worldToLocal(vector: Vec3): Vec3 {
    this.updateMatrixWorld();
    return vector.applyMat4(Node.scratchInverse.copy(this.matrixWorld).invert());
  }

  /* ------------------------------------------------------------ transforms */

  /** Rotates around an axis expressed in local space. */
  public rotateOnAxis(axis: Vec3, angle: number): this {
    this.transform.rotateOnAxis(axis, angle);
    return this;
  }

  /** Rotates around an axis expressed in world space. */
  public rotateOnWorldAxis(axis: Vec3, angle: number): this {
    this.transform.rotateOnWorldAxis(axis, angle);
    return this;
  }

  /** Rotates around `+X` by `angle` radians. */
  public rotateX(angle: number): this {
    return this.rotateOnAxis(Vec3.unitX(), angle);
  }

  /** Rotates around `+Y` by `angle` radians. */
  public rotateY(angle: number): this {
    return this.rotateOnAxis(Vec3.unitY(), angle);
  }

  /** Rotates around `+Z` by `angle` radians. */
  public rotateZ(angle: number): this {
    return this.rotateOnAxis(Vec3.unitZ(), angle);
  }

  /** Translates along an axis expressed in local space. */
  public translateOnAxis(axis: Vec3, distance: number): this {
    this.transform.translate(Node.scratchAxis.copy(axis).applyQuat(this.quaternion).multiplyScalar(distance));
    return this;
  }

  /** Translates along the local `+X`. */
  public translateX(distance: number): this {
    return this.translateOnAxis(Vec3.unitX(), distance);
  }

  /** Translates along the local `+Y`. */
  public translateY(distance: number): this {
    return this.translateOnAxis(Vec3.unitY(), distance);
  }

  /** Translates along the local `+Z`. */
  public translateZ(distance: number): this {
    return this.translateOnAxis(Vec3.unitZ(), distance);
  }

  /** Orients the node so that its `-Z` axis points at `target`. */
  public lookAt(target: Vec3 | number, y?: number, z?: number): this {
    const point = typeof target === 'number' ? Node.scratchLookAt.set(target, y ?? 0, z ?? 0) : target;

    // `lookAt` reads the world position, so make sure the parents are current.
    this.updateMatrixWorld();

    const eye = this.getWorldPosition(Node.scratchEye);
    if (this.parent) {
      // Convert the target into the parent's space so the local rotation is right.
      const parentInverse = Node.scratchInverse.copy(this.parent.matrixWorld).invert();
      point.applyMat4(parentInverse);
    }

    Node.scratchMatrix.lookAt(eye, point, Node.DEFAULT_UP);
    this.quaternion.setFromRotationMatrix(Node.scratchMatrix);
    return this;
  }

  /** Applies a quaternion to the local rotation. */
  public applyQuaternion(quaternion: Quat): this {
    this.quaternion.premultiply(quaternion);
    return this;
  }

  /** Sets the local rotation from a quaternion, updating the Euler angles. */
  public setRotationFromQuaternion(quaternion: Quat): this {
    this.transform.setQuaternion(quaternion);
    return this;
  }

  /** Sets the scale uniformly. */
  public setScale(scalar: number): this;
  public setScale(x: number, y: number, z: number): this;
  public setScale(x: number, y?: number, z?: number): this {
    this.scale.set(x, y ?? x, z ?? x);
    return this;
  }

  /** Enables a layer on this node. */
  public enableLayer(layer: Layer | number): this {
    this.layers.enable(layer);
    return this;
  }

  /** Disables a layer on this node. */
  public disableLayer(layer: Layer | number): this {
    this.layers.disable(layer);
    return this;
  }

  /* --------------------------------------------------------------- update */

  /** Per-frame hook; the default does nothing. */
  public update(_delta: number, _frame?: FrameInfo): void {
    /* no-op */
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Releases the node and its subtree.
   *
   * Subclasses overriding this **must** call `super.dispose()`.
   */
  public override dispose(): void {
    if (this.nodesDisposed) return;

    // Dispose children first (depth-first), so parents can still reference them.
    for (const child of this.children.slice()) {
      child.dispose();
    }
    this.children.length = 0;

    this.removeFromParent();
    this.emit('dispose');
    this.nodesDisposed = true;
    super.dispose();
  }

  /** `true` once {@link dispose} has run. */
  public override get isDisposed(): boolean {
    return this.nodesDisposed || super.isDisposed;
  }

  /* --------------------------------------------------------------- copying */

  /**
   * Copies another node's state onto this one.
   *
   * `id` is never copied: identity stays unique. When `recursive` is set, children
   * are cloned through {@link Node.clone} and attached.
   */
  public copy(source: Node, recursive: boolean = true): this {
    this.name = source.name;
    this.visible = source.visible;
    this.renderOrder = source.renderOrder;
    this.frustumCulled = source.frustumCulled;
    this.enabled = source.enabled;
    this.matrixAutoUpdate = source.matrixAutoUpdate;
    this.layers.copy(source.layers);
    this.transform.copy(source.transform);
    this.userData = { ...source.userData };

    if (recursive) {
      this.clear();
      for (const child of source.children) this.add(child.clone(true) as Node);
    }
    return this;
  }

  /** Returns a deep clone of this node (children included when `recursive`). */
  public clone(recursive: boolean = true): Node {
    return new Node().copy(this, recursive);
  }

  /** JSON-friendly representation of the node and, optionally, its subtree. */
  public toJSON(recursive: boolean = true): Record<string, unknown> {
    return {
      type: this.type,
      id: this.id,
      name: this.name,
      visible: this.visible,
      renderOrder: this.renderOrder,
      layers: this.layers.mask,
      position: this.position.toArray(),
      rotation: [this.rotation.x, this.rotation.y, this.rotation.z, this.rotation.order],
      scale: this.scale.toArray(),
      matrixWorld: this.matrixWorld.toArray(),
      userData: this.userData,
      children: recursive ? this.children.map((child) => child.toJSON(true)) : undefined,
    };
  }

  /** `"Mesh "name" (3 children)"`-style description for debug overlays. */
  public override toString(): string {
    const childText = this.children.length === 1 ? '1 child' : `${this.children.length} children`;
    return `${this.type} "${this.name}" (${childText})`;
  }

  /* ---------------------------------------------------------------- statics */

  /** Default up vector used by {@link Node.lookAt}. */
  public static readonly DEFAULT_UP: Vec3 = new Vec3(0, 1, 0);

  /** Scratch objects reused by the transform helpers (never exposed). */
  private static readonly scratchPosition = new Vec3();
  private static readonly scratchScale = new Vec3();
  private static readonly scratchQuaternion = new Quat();
  private static readonly scratchInverse = new Mat4();
  private static readonly scratchMatrix = new Mat4();
  private static readonly scratchAxis = new Vec3();
  private static readonly scratchEye = new Vec3();
  private static readonly scratchLookAt = new Vec3();
}

/** Convenience factory mirroring the `Vec3`/`Mat4` helpers. */
export function node(options?: NodeOptions): Node {
  return new Node(options);
}

/** Type guard for {@link Node}. */
export function isNode(value: unknown): value is Node {
  return value instanceof Node;
}

/** Re-exported so consumers can reference the shared event map without an extra import. */
export type { CoreEventMap };
