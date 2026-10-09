/**
 * `Node2D` - the base class of every 2D scene object.
 *
 * 2D scenes almost never need the full vector transform machinery, so a node
 * stores flat numbers (`x`, `y`, `rotation`, `scaleX`, `scaleY`) instead of
 * `Vec3`/`Euler`/`Quat` triples. The composed transform is still a `Mat4`, which
 * keeps one matrix pipeline for both dimensions and lets a 3D camera compose
 * with a 2D layer:
 *
 * ```text
 * local = T(x, y) * T(pivot) * R(rotation) * Skew(skew) * S(scale) * T(-pivot)
 * ```
 *
 * `getBounds()` returns bounds in the node's own coordinate space; `hitTest`
 * and `containsPoint` accept points in **world** space, which is the space a
 * pointer event arrives in.
 *
 * @packageDocumentation
 */

import { createId } from '../../utils/Id';
import { Mat4 } from '../../math/Mat4';
import { Rect } from '../../math/Rect';
import { Vec2 } from '../../math/Vec2';
import { TypedEventEmitter } from '../internal/emitter';
import type { BlendMode2D, HitTestOptions, Node2DJson, Node2DOptions } from './types';
import { SCENE2D_JSON_GENERATOR, SCENE2D_JSON_VERSION } from './types';

/** Events emitted by every 2D node. */
export interface Node2DEventMap {
  /** The node was added to a parent. */
  added: { parent: Node2D };
  /** The node was removed from a parent. */
  removed: { parent: Node2D };
  /** The local transform changed and the cached matrices are stale. */
  transformchange: undefined;
  /** The node's bounds changed; the parent chain should recompute. */
  boundschange: undefined;
  /** The node was disposed. */
  dispose: undefined;
}

/** Scratch matrix used while composing a local transform. */
const scratchMatrix = new Mat4();

/** Scratch matrix used while composing a world transform. */
const scratchWorldMatrix = new Mat4();

/** Scratch rectangle reused by the bounds accumulators. */
const scratchRect = new Rect();

/** Scratch rectangle holding the accumulated subtree bounds. */
const scratchBounds = new Rect();

/** Identity matrix used when a node has no parent. */
const IDENTITY_MATRIX = new Mat4();

/** Base class for every object placed in a 2D scene. */
export class Node2D extends TypedEventEmitter<Node2DEventMap> {
  /** Allows consumers to detect the base class without an `instanceof` check. */
  public readonly isNode2D = true;

  /** Stable, process-unique identifier. */
  public readonly id: string;

  /** Human-readable name; `''` unless the caller sets one. */
  public name: string;

  /** Skips this subtree while rendering when `false`. */
  public visible: boolean;

  /** Parent node, or `null` while detached. */
  public parent: Node2D | null = null;

  /** Direct children, in insertion order (draw order is the sorted `zIndex`). */
  public readonly children: Node2D[] = [];

  /** Draw order within the parent; lower values are drawn first. */
  public zIndex: number;

  /** Opacity in `[0, 1]`, multiplied down the tree. */
  public alpha: number;

  /** Compositing operation applied while drawing this node. */
  public blendMode: BlendMode2D;

  /** Plain payload carried by the node; never touched by the library. */
  public userData: Record<string, unknown>;

  /** Rotation/scale origin, in the node's local units. */
  public readonly pivot: Vec2;

  /** Shear applied before the rotation, in radians. */
  public readonly skew: Vec2;

  /** Enables hit testing for this node. */
  public interactive: boolean;

  /** Class name, overridden by every subclass. */
  public readonly type: string = 'Node2D';

  /** Local bounds; `null` asks the node to derive them from its children. */
  public bounds: Rect | null;

  /** Read-only view of the node's world-space opacity, refreshed while rendering. */
  public worldAlpha = 1;

  /** Cached local matrix; rebuilt by {@link Node2D.updateTransform}. */
  public readonly localMatrix: Mat4 = new Mat4();

  /** Cached world matrix; rebuilt by {@link Node2D.updateTransform}. */
  public readonly worldMatrix: Mat4 = new Mat4();

  /** X position in the parent's coordinate space. */
  private positionX: number;

  /** Y position in the parent's coordinate space. */
  private positionY: number;

  /** Rotation in radians. */
  private angle: number;

  /** Horizontal scale. */
  private scaleFactorX: number;

  /** Vertical scale. */
  private scaleFactorY: number;

  /** Creates a node. */
  constructor(options: Node2DOptions = {}) {
    super();
    this.id = createId('node2d');
    this.name = options.name ?? '';
    this.visible = options.visible ?? true;
    this.zIndex = options.zIndex ?? 0;
    this.alpha = options.alpha ?? 1;
    this.blendMode = options.blendMode ?? 'normal';
    this.interactive = options.interactive ?? false;
    this.userData = options.userData ? { ...options.userData } : {};
    this.pivot = options.pivot ? options.pivot.clone() : new Vec2(0, 0);
    this.skew = options.skew ? options.skew.clone() : new Vec2(0, 0);
    this.bounds = options.bounds ?? null;
    this.positionX = options.x ?? 0;
    this.positionY = options.y ?? 0;
    this.angle = options.rotation ?? 0;
    this.scaleFactorX = options.scaleX ?? 1;
    this.scaleFactorY = options.scaleY ?? 1;
    this.updateTransform();
  }

  /* -------------------------------------------------------------- transform */

  /** X position in the parent's coordinate space. */
  public get x(): number {
    return this.positionX;
  }

  public set x(value: number) {
    if (this.positionX === value) return;
    this.positionX = value;
    this.notifyTransformChanged();
  }

  /** Y position in the parent's coordinate space. */
  public get y(): number {
    return this.positionY;
  }

  public set y(value: number) {
    if (this.positionY === value) return;
    this.positionY = value;
    this.notifyTransformChanged();
  }

  /** Rotation in radians. */
  public get rotation(): number {
    return this.angle;
  }

  public set rotation(value: number) {
    if (this.angle === value) return;
    this.angle = value;
    this.notifyTransformChanged();
  }

  /** Horizontal scale. */
  public get scaleX(): number {
    return this.scaleFactorX;
  }

  public set scaleX(value: number) {
    if (this.scaleFactorX === value) return;
    this.scaleFactorX = value;
    this.notifyTransformChanged();
  }

  /** Vertical scale. */
  public get scaleY(): number {
    return this.scaleFactorY;
  }

  public set scaleY(value: number) {
    if (this.scaleFactorY === value) return;
    this.scaleFactorY = value;
    this.notifyTransformChanged();
  }

  /** Uniform scale convenience accessor; reads and writes `scaleX`. */
  public get scale(): number {
    return this.scaleFactorX;
  }

  public set scale(value: number) {
    this.scaleX = value;
    this.scaleY = value;
  }

  /** Sets the flat transform in one call, emitting `transformchange` once. */
  public setTransform(
    x: number,
    y: number,
    rotation: number = this.angle,
    scaleX: number = this.scaleFactorX,
    scaleY: number = this.scaleFactorY,
  ): this {
    this.positionX = x;
    this.positionY = y;
    this.angle = rotation;
    this.scaleFactorX = scaleX;
    this.scaleFactorY = scaleY;
    this.notifyTransformChanged();
    return this;
  }

  /** Moves the node by `(dx, dy)` in the parent's coordinate space. */
  public translate(dx: number, dy: number): this {
    this.positionX += dx;
    this.positionY += dy;
    this.notifyTransformChanged();
    return this;
  }

  /** Rotates the node by `radians`. */
  public rotate(radians: number): this {
    this.angle += radians;
    this.notifyTransformChanged();
    return this;
  }

  /* ----------------------------------------------------------------- width */

  /** Width of the node's local bounds; `0` when it has none. */
  public get width(): number {
    return this.bounds ? this.bounds.width : 0;
  }

  public set width(value: number) {
    this.ensureBounds().width = value;
    this.notifyBoundsChanged();
  }

  /** Height of the node's local bounds; `0` when it has none. */
  public get height(): number {
    return this.bounds ? this.bounds.height : 0;
  }

  public set height(value: number) {
    this.ensureBounds().height = value;
    this.notifyBoundsChanged();
  }

  /* ------------------------------------------------------------------ tree */

  /**
   * Adds one or more children, reparenting them when necessary.
   *
   * A node cannot be added to itself or to one of its own descendants.
   *
   * @returns `this`, so calls chain.
   */
  public add(...nodes: Node2D[]): this {
    for (const node of nodes) {
      if (!node || node === this) continue;
      // Adding an ancestor would create a cycle.
      if (this.isDescendantOf(node)) continue;
      if (node.parent !== null) node.parent.remove(node);
      node.parent = this;
      this.children.push(node);
      node.emit('added', { parent: this });
    }
    this.notifyBoundsChanged();
    return this;
  }

  /**
   * Removes one or more direct children.
   *
   * Removing a node that is not a child is a no-op.
   *
   * @returns `this`, so calls chain.
   */
  public remove(...nodes: Node2D[]): this {
    for (const node of nodes) {
      if (!node) continue;
      const index = this.children.indexOf(node);
      if (index === -1) continue;
      this.children.splice(index, 1);
      node.parent = null;
      node.emit('removed', { parent: this });
    }
    this.notifyBoundsChanged();
    return this;
  }

  /** Detaches this node from its parent, preserving its transform. */
  public removeFromParent(): this {
    if (this.parent !== null) this.parent.remove(this);
    return this;
  }

  /** Detaches every child. */
  public clear(): this {
    for (let i = this.children.length - 1; i >= 0; i--) this.remove(this.children[i]);
    return this;
  }

  /** Removes this node from its parent and releases its listeners. */
  public dispose(): void {
    this.removeFromParent();
    this.removeAllListeners();
    this.emit('dispose');
  }

  /** Depth-first walk over this node and every descendant. */
  public traverse(callback: (node: Node2D) => void): void {
    callback(this);
    for (let i = 0; i < this.children.length; i++) this.children[i].traverse(callback);
  }

  /** Depth-first walk that skips the subtrees of invisible nodes. */
  public traverseVisible(callback: (node: Node2D) => void): void {
    if (!this.visible) return;
    callback(this);
    for (let i = 0; i < this.children.length; i++) this.children[i].traverseVisible(callback);
  }

  /** Walks from this node up to the root, `this` first. */
  public traverseAncestors(callback: (node: Node2D) => void): void {
    const parent = this.parent;
    if (parent !== null) {
      callback(parent);
      parent.traverseAncestors(callback);
    }
  }

  /** Finds the first node in the subtree whose `id` matches. */
  public getChildById(id: string): Node2D | undefined {
    return this.find((node) => node.id === id);
  }

  /** Finds the first node in the subtree whose `name` matches. */
  public getChildByName(name: string): Node2D | undefined {
    return this.find((node) => node.name === name);
  }

  /** Returns the first node (depth first, `this` first) matching `predicate`. */
  public find(predicate: (node: Node2D) => boolean): Node2D | undefined {
    if (predicate(this)) return this;
    for (let i = 0; i < this.children.length; i++) {
      const found = this.children[i].find(predicate);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Returns every node (including `this`) matching `predicate`. */
  public filter(predicate: (node: Node2D) => boolean): Node2D[] {
    const result: Node2D[] = [];
    this.traverse((node) => {
      if (predicate(node)) result.push(node);
    });
    return result;
  }

  /**
   * `true` when `node` is this node or one of its ancestors.
   *
   * Walks *up* the parent chain; use {@link Node2D.isAncestorOf} for the inverse
   * question.
   */
  public isDescendantOf(node: Node2D): boolean {
    let current: Node2D | null = this;
    while (current !== null) {
      if (current === node) return true;
      current = current.parent;
    }
    return false;
  }

  /** `true` when `node` is this node or one of its descendants. */
  public isAncestorOf(node: Node2D): boolean {
    return node.isDescendantOf(this);
  }

  /** Direct children sorted by `zIndex`, then by insertion order. */
  public getChildrenByZIndex(): Node2D[] {
    return this.children
      .map((child, index) => ({ child, index }))
      .sort((a, b) => a.child.zIndex - b.child.zIndex || a.index - b.index)
      .map((entry) => entry.child);
  }

  /* --------------------------------------------------------------- matrices */

  /**
   * Recomputes {@link Node2D.localMatrix} and {@link Node2D.worldMatrix}.
   *
   * The world matrix is
   * `parent.worldMatrix * localMatrix`, so a parent's transform applies to every
   * descendant without extra bookkeeping.
   */
  public updateTransform(): void {
    this.composeLocalMatrix(this.localMatrix);
    this.worldMatrix.multiplyMatrices(
      this.parent === null ? IDENTITY_MATRIX : this.parent.worldMatrix,
      this.localMatrix,
    );
    for (let i = 0; i < this.children.length; i++) this.children[i].updateTransform();
  }

  /** Returns the cached {@link Node2D.localMatrix}. */
  public getLocalMatrix(): Mat4 {
    return this.localMatrix;
  }

  /** Returns the cached {@link Node2D.worldMatrix}. */
  public getWorldMatrix(): Mat4 {
    return this.worldMatrix;
  }

  /**
   * Transforms a point from this node's local space into world space.
   *
   * @param point Point in local units.
   * @param target Receives the result; a new `Vec2` is allocated when omitted.
   */
  public localToWorld(point: Vec2, target: Vec2 = new Vec2()): Vec2 {
    const e = this.worldMatrix.elements;
    const x = point.x;
    const y = point.y;
    return target.set(e[0] * x + e[4] * y + e[12], e[1] * x + e[5] * y + e[13]);
  }

  /**
   * Transforms a point from world space into this node's local space.
   *
   * @param point Point in world units.
   * @param target Receives the result; a new `Vec2` is allocated when omitted.
   */
  public worldToLocal(point: Vec2, target: Vec2 = new Vec2()): Vec2 {
    const e = scratchMatrix.copy(this.worldMatrix).invert().elements;
    const x = point.x;
    const y = point.y;
    return target.set(e[0] * x + e[4] * y + e[12], e[1] * x + e[5] * y + e[13]);
  }

  /** Multiplies the node's transform by `matrix` and decomposes the result. */
  public applyMatrix(matrix: Mat4): this {
    scratchMatrix.copy(this.localMatrix).premultiply(matrix);
    const e = scratchMatrix.elements;
    this.positionX = e[12];
    this.positionY = e[13];
    this.angle = Math.atan2(e[1], e[0]);
    this.scaleFactorX = Math.hypot(e[0], e[1]);
    this.scaleFactorY = Math.hypot(e[4], e[5]);
    this.notifyTransformChanged();
    return this;
  }

  /* ----------------------------------------------------------------- bounds */

  /**
   * Returns the node's bounds in **local** units.
   *
   * A node with explicit {@link Node2D.bounds} returns them unchanged; otherwise
   * the bounds are the union of the children's bounds converted into this node's
   * coordinate space, or `null` when the subtree has no measurable geometry.
   *
   * @param target Receives the result; a new `Rect` is allocated when omitted.
   */
  public getBounds(target: Rect = new Rect()): Rect | null {
    if (this.bounds) return target.copy(this.bounds);

    const childWorld = this.collectChildWorldBounds();
    if (!childWorld) return null;

    // Convert the children's world bounds into this node's local space.
    const e = scratchWorldMatrix.copy(this.worldMatrix).invert().elements;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let corner = 0; corner < 4; corner++) {
      const worldX = corner === 0 || corner === 3 ? childWorld.left : childWorld.right;
      const worldY = corner === 0 || corner === 1 ? childWorld.top : childWorld.bottom;
      const localX = e[0] * worldX + e[4] * worldY + e[12];
      const localY = e[1] * worldX + e[5] * worldY + e[13];
      if (localX < minX) minX = localX;
      if (localY < minY) minY = localY;
      if (localX > maxX) maxX = localX;
      if (localY > maxY) maxY = localY;
    }
    return target.set(minX, minY, maxX - minX, maxY - minY);
  }

  /**
   * Returns the axis-aligned bounds of the whole subtree, in world space.
   *
   * The result encloses the node's local bounds and every descendant's, which is
   * what culling and broad-phase picking need.
   */
  public getWorldBounds(target: Rect = new Rect()): Rect | null {
    return this.collectWorldBounds(target);
  }

  /** Resets {@link Node2D.bounds} so the node derives them from its children. */
  public clearBounds(): this {
    this.bounds = null;
    this.notifyBoundsChanged();
    return this;
  }

  /** Replaces the node's local bounds. */
  public setBounds(rect: Rect | null): this {
    this.bounds = rect;
    this.notifyBoundsChanged();
    return this;
  }

  /* ---------------------------------------------------------------- picking */

  /**
   * `true` when `point` (world space) lies inside this node.
   *
   * Picking is bounds-based: the point is converted into local space and tested
   * against the node's **own** bounds. A container without explicit bounds does
   * not claim the area its children occupy unless `includeChildren` is set, since
   * that area may be disjoint; subclasses with an exact shape (`Path2DObject`)
   * override this method instead.
   *
   * @param point Point in world space.
   * @param tolerance Pixels of slack added around the bounds.
   * @param includeChildren When `true`, a point inside a child counts as inside
   *   this node even when it falls outside the node's own bounds.
   */
  public containsPoint(point: Vec2, tolerance = 0, includeChildren = false): boolean {
    if (this.bounds) {
      const local = this.worldToLocal(point);
      if (rectContainsPoint(this.bounds, local, tolerance)) return true;
    }
    if (!includeChildren) return false;

    for (let i = 0; i < this.children.length; i++) {
      if (this.children[i].containsPoint(point, tolerance, true)) return true;
    }
    return false;
  }

  /**
   * Returns the deepest interactive node under `point` (world space), or `null`.
   *
   * Children are tested before their parent and in descending `zIndex` order, so
   * the node drawn on top wins - the behaviour a pointer event expects.
   */
  public hitTest(point: Vec2, options: HitTestOptions = {}): Node2D | null {
    this.updateTransform();
    return this.hitTestInternal(point, options);
  }

  /**
   * Recursive half of {@link Node2D.hitTest}.
   *
   * @param point Point in world space.
   * @param options Hit-test switches.
   */
  protected hitTestInternal(point: Vec2, options: HitTestOptions = {}): Node2D | null {
    if (!this.visible) return null;
    const tolerance = options.tolerance ?? 0;
    const includeChildren = options.includeChildren ?? true;

    let selfHit = false;
    const bounds = this.getBounds();
    if (bounds) {
      selfHit = rectContainsPoint(bounds, this.worldToLocal(point), tolerance);
    }

    if (!bounds || selfHit || includeChildren) {
      const children = this.getChildrenByZIndex();
      for (let i = children.length - 1; i >= 0; i--) {
        const hit = children[i].hitTestInternal(point, options);
        if (hit) return hit;
      }
    }

    if (selfHit && (this.interactive || options.includeNonInteractive)) return this;
    return null;
  }

  /* --------------------------------------------------------------- lifecycle */

  /**
   * Per-frame hook.
   *
   * The base implementation refreshes the transform and then updates the
   * children; subclasses extend it for animation.
   *
   * @param delta Seconds elapsed since the previous frame.
   */
  public update(delta: number): void {
    this.updateTransform();
    for (let i = 0; i < this.children.length; i++) this.children[i].update(delta);
  }

  /**
   * Draw hook.
   *
   * The base implementation refreshes the transform and recurses into the
   * children; subclasses draw their own geometry.
   *
   * @param painter Backend supplied by the renderer.
   */
  public render(painter: unknown): void {
    void painter;
    this.updateTransform();
    for (let i = 0; i < this.children.length; i++) this.children[i].render(painter);
  }

  /* ------------------------------------------------------- copy / serialise */

  /** Copies every public field of `source` into this node. */
  public copy(source: Node2D, recursive = true): this {
    this.name = source.name;
    this.visible = source.visible;
    this.zIndex = source.zIndex;
    this.alpha = source.alpha;
    this.blendMode = source.blendMode;
    this.interactive = source.interactive;
    this.userData = cloneUserData(source.userData);
    this.positionX = source.positionX;
    this.positionY = source.positionY;
    this.angle = source.angle;
    this.scaleFactorX = source.scaleFactorX;
    this.scaleFactorY = source.scaleFactorY;
    this.pivot.copy(source.pivot);
    this.skew.copy(source.skew);
    this.bounds = source.bounds ? source.bounds.clone() : null;
    this.worldAlpha = source.worldAlpha;

    if (recursive) {
      this.clear();
      for (let i = 0; i < source.children.length; i++) this.add(source.children[i].clone(true));
    }
    this.updateTransform();
    return this;
  }

  /** Returns a copy of this node, children included when `recursive` is set. */
  public clone(recursive = true): Node2D {
    return this.createInstance().copy(this, recursive);
  }

  /** Serialises this node, and optionally its whole subtree. */
  public toJSON(recursive = true): Node2DJson {
    const json: Node2DJson = {
      metadata: { version: SCENE2D_JSON_VERSION, generator: SCENE2D_JSON_GENERATOR },
      type: this.type,
      id: this.id,
      name: this.name,
      x: this.positionX,
      y: this.positionY,
      rotation: this.angle,
      scaleX: this.scaleFactorX,
      scaleY: this.scaleFactorY,
      zIndex: this.zIndex,
      alpha: this.alpha,
      blendMode: this.blendMode,
      visible: this.visible,
      interactive: this.interactive,
      pivot: this.pivot.toJSON(),
      skew: this.skew.toJSON(),
      matrix: this.localMatrix.toArray(),
      userData: this.userData,
    };
    if (recursive) json.children = this.children.map((child) => child.toJSON(true));
    return json;
  }

  /* ---------------------------------------------------------------- helpers */

  /**
   * Creates an empty instance of this node's concrete class.
   *
   * Subclasses override it so `clone()` returns the right type; the base
   * implementation returns a plain `Node2D`.
   */
  protected createInstance(): Node2D {
    return new Node2D();
  }

  /**
   * Writes this node's local transform into `target`.
   *
   * Provided as a `protected` hook so subclasses that cache extra state (a mesh
   * with a baked geometry, for instance) can reuse the composition rules.
   */
  protected composeLocalMatrix(target: Mat4): Mat4 {
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    const skewX = this.skew.x;
    const skewY = this.skew.y;
    const sx = this.scaleFactorX;
    const sy = this.scaleFactorY;
    const tx = this.positionX - (this.pivot.x * cos * sx + this.pivot.y * (cos * skewY - sin) * sy);
    const ty = this.positionY - (this.pivot.x * sin * sx + this.pivot.y * (sin * skewY + cos) * sy);

    return target.set(
      cos * sx,
      sin * sx,
      0,
      0,
      (cos * skewY - sin) * sy,
      (sin * skewY + cos) * sy,
      0,
      0,
      0,
      0,
      1,
      0,
      tx,
      ty,
      0,
      1,
    );
  }

  /** Marks the transform stale and notifies the parent chain. */
  protected notifyTransformChanged(): void {
    this.updateTransform();
    this.emit('transformchange');
  }

  /** Notifies this node and its ancestors that the bounds may have changed. */
  protected notifyBoundsChanged(): void {
    this.updateTransform();
    this.emit('boundschange');
    if (this.parent !== null) this.parent.notifyBoundsChanged();
  }

  /** Ensures {@link Node2D.bounds} exists so a size can be assigned. */
  private ensureBounds(): Rect {
    if (!this.bounds) this.bounds = new Rect(0, 0, 0, 0);
    return this.bounds;
  }

  /**
   * Accumulates the world bounds of this subtree into `target`.
   *
   * @param target Result rectangle; untouched when the subtree has no bounds.
   */
  private collectWorldBounds(target: Rect): Rect | null {
    const localBounds = this.getBounds(scratchRect);
    let hasBounds = false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    if (localBounds) {
      const e = this.worldMatrix.elements;
      for (let corner = 0; corner < 4; corner++) {
        const localX = corner === 0 || corner === 3 ? localBounds.left : localBounds.right;
        const localY = corner === 0 || corner === 1 ? localBounds.top : localBounds.bottom;
        const worldX = e[0] * localX + e[4] * localY + e[12];
        const worldY = e[1] * localX + e[5] * localY + e[13];
        if (worldX < minX) minX = worldX;
        if (worldY < minY) minY = worldY;
        if (worldX > maxX) maxX = worldX;
        if (worldY > maxY) maxY = worldY;
      }
      hasBounds = true;
    }

    for (let i = 0; i < this.children.length; i++) {
      const childBounds = this.children[i].getWorldBounds(scratchBounds);
      if (!childBounds) continue;
      if (childBounds.left < minX) minX = childBounds.left;
      if (childBounds.top < minY) minY = childBounds.top;
      if (childBounds.right > maxX) maxX = childBounds.right;
      if (childBounds.bottom > maxY) maxY = childBounds.bottom;
      hasBounds = true;
    }

    if (!hasBounds) return null;
    return target.set(minX, minY, maxX - minX, maxY - minY);
  }

  /** Union of the children's world bounds, or `null` when there are none. */
  private collectChildWorldBounds(): Rect | null {
    let hasBounds = false;
    for (let i = 0; i < this.children.length; i++) {
      const childBounds = this.children[i].getWorldBounds(scratchBounds);
      if (!childBounds) continue;
      if (!hasBounds) {
        scratchRect.set(
          childBounds.x,
          childBounds.y,
          childBounds.width,
          childBounds.height,
        );
        hasBounds = true;
        continue;
      }
      const minX = Math.min(scratchRect.left, childBounds.left);
      const minY = Math.min(scratchRect.top, childBounds.top);
      const maxX = Math.max(scratchRect.right, childBounds.right);
      const maxY = Math.max(scratchRect.bottom, childBounds.bottom);
      scratchRect.set(minX, minY, maxX - minX, maxY - minY);
    }
    return hasBounds ? scratchRect : null;
  }
}

/** `true` when `rect` contains `point` within `tolerance`. */
function rectContainsPoint(rect: Rect, point: Vec2, tolerance: number): boolean {
  const left = rect.left - tolerance;
  const right = rect.right + tolerance;
  const top = rect.top - tolerance;
  const bottom = rect.bottom + tolerance;
  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
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
