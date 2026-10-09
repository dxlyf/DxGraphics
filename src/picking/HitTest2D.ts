/**
 * `HitTest2D` — topmost-first hit testing over a 2D node tree.
 *
 * A 2D scene is drawn back-to-front and picked front-to-back, and "front" is a
 * *z-order* question, not a distance question. This class is the 2D counterpart of
 * `Raycaster`: it walks a tree, honours draw order, and stops at the first node that
 * accepts the point.
 *
 * ```ts
 * const tester = new HitTest2D();
 * const hit = tester.hitTest(scene, new Vec2(120, 40));
 * hit?.target;      // the topmost interactive node under the point
 * hit?.alpha;       // accumulated opacity along the chain
 * ```
 *
 * ## Traversal rules
 *
 * A node is **skipped but not its subtree** when it is non-interactive or fully
 * transparent, and **skipped with its subtree** when it is invisible or its
 * accumulated alpha falls below `minAlpha`. Children are visited before their
 * parent (a child draws on top of the node that owns it), and siblings are visited
 * in descending `zIndex`, with insertion order breaking ties.
 *
 * ## Point-space convention
 *
 * `hitTest` takes a **world-space** point by default and converts it into each
 * node's local space through `worldToLocal` when the node provides one; a node that
 * only exposes `getBounds`/`getWorldBounds` is tested in the space of whichever
 * bounds it has. Pass `worldSpace: false` when the tree is already flat and every
 * coordinate is local.
 *
 * @packageDocumentation
 */

import { Vec2 } from '../math/Vec2';
import type { HitTestOptions, Node2DLike } from './types';

/** One 2D hit. */
export interface Node2DHit<TTarget = Node2DLike> {
  /** The node that was hit. */
  target: TTarget;
  /** Hit point in the node's local space. */
  localPoint: Vec2;
  /** Hit point in the coordinate space the query was made in. */
  worldPoint: Vec2;
  /** Accumulated alpha along the chain from the root to the node. */
  alpha: number;
  /** Accumulated z-order along the chain. */
  order: number;
  /** Distance from the query point to the node's bounds centre. */
  distance: number;
}

/** A traversable frame during the walk. */
interface Frame {
  /** Node being visited. */
  node: Node2DLike;
  /** Accumulated alpha from the root, exclusive. */
  alpha: number;
  /** Accumulated z-order from the root, exclusive. */
  order: number;
}

/**
 * Hit tests 2D node trees.
 */
export class HitTest2D {
  /** Scratch local point. */
  private readonly localPoint = new Vec2();

  /** Scratch world point. */
  private readonly worldPoint = new Vec2();

  /**
   * Finds the topmost node under a point.
   *
   * @typeParam TTarget Node type, inferred from `root`.
   * @param root Root node (or any subtree root) to search.
   * @param point Query point.
   * @param options Traversal and tolerance configuration.
   * @returns The topmost hit, or `null`.
   */
  public hitTest<TTarget extends Node2DLike>(
    root: TTarget | null | undefined,
    point: { x: number; y: number },
    options: HitTestOptions = {},
  ): Node2DHit<TTarget> | null {
    const hits = this.hitTestAll(root, point, { ...options, all: false, limit: 1 });
    return (hits[0] as Node2DHit<TTarget> | undefined) ?? null;
  }

  /**
   * Collects every node under a point, topmost first.
   *
   * @typeParam TTarget Node type, inferred from `root`.
   * @param root Root node to search.
   * @param point Query point.
   * @param options Traversal and tolerance configuration.
   * @returns The hits, ordered topmost-first.
   */
  public hitTestAll<TTarget extends Node2DLike>(
    root: TTarget | null | undefined,
    point: { x: number; y: number },
    options: HitTestOptions = {},
  ): Node2DHit<TTarget>[] {
    const results: Node2DHit<TTarget>[] = [];
    if (root == null) return results;

    const worldSpace = options.worldSpace ?? true;
    const minAlpha = options.minAlpha ?? 0;
    const limit = options.limit ?? Infinity;

    // Depth-first, children before parents, siblings in descending z-order. The
    // stack holds frames whose *own* test has already run, so a node is recorded
    // after its subtree — which is exactly "topmost first".
    const stack: Frame[] = [{ node: root, alpha: 1, order: 0 }];
    const postOrder: Node2DHit<TTarget>[] = [];

    while (stack.length > 0) {
      const frame = stack.pop() as Frame;
      const node = frame.node;

      if (node.visible === false) continue;

      const nodeAlpha = clamp01(typeof node.alpha === 'number' ? node.alpha : 1);
      const alpha = frame.alpha * nodeAlpha;
      const order = frame.order + (typeof node.zIndex === 'number' ? node.zIndex : 0);

      if (alpha < minAlpha) continue;

      const children = node.children;
      if (Array.isArray(children) && children.length > 0) {
        // Push in ascending order so the highest z-order is popped first.
        const ordered = children
          .map((child, index) => ({ child, index }))
          .sort((a, b) => {
            const za = typeof a.child.zIndex === 'number' ? a.child.zIndex : 0;
            const zb = typeof b.child.zIndex === 'number' ? b.child.zIndex : 0;
            return za === zb ? b.index - a.index : za - zb;
          });

        for (const entry of ordered) {
          stack.push({ node: entry.child, alpha, order });
        }
      }

      const accepts =
        options.ignoreInteractive === true || node.interactive !== false;

      if (!accepts) continue;

      const local = this.toLocal(node, point, worldSpace);
      if (local === null) continue;

      const hit = this.testNode(node, local, point, options);
      if (hit === null) continue;

      postOrder.push({
        target: node as TTarget,
        localPoint: local.clone(),
        worldPoint: new Vec2(point.x, point.y),
        alpha,
        order,
        distance: hit.distance,
      });
    }

    // `postOrder` is children-before-parents already, but siblings within one frame
    // were pushed in ascending z-order and popped in descending order, so the array
    // is topmost-first. Sort defensively by z-order then by discovery order.
    postOrder.sort((a, b) => b.order - a.order);

    for (const hit of postOrder) {
      if (results.length >= limit) break;
      results.push(hit);
    }
    return results;
  }

  /**
   * Tests one node in isolation.
   *
   * @param node Node to test.
   * @param point Query point, in the node's own space.
   * @param options Tolerance configuration.
   * @returns `true` when the node accepts the point.
   */
  public contains(node: Node2DLike, point: { x: number; y: number }, options: HitTestOptions = {}): boolean {
    const local = this.toLocal(node, point, options.worldSpace ?? false);
    if (local === null) return false;
    return this.testNode(node, local, point, options) !== null;
  }

  /**
   * Converts a query point into a node's local space.
   *
   * @param node Node supplying the transform.
   * @param point Query point.
   * @param worldSpace When `false`, the point is returned unchanged.
   * @returns The local point, or `null` when the node has no usable transform.
   */
  private toLocal(
    node: Node2DLike,
    point: { x: number; y: number },
    worldSpace: boolean,
  ): Vec2 | null {
    this.worldPoint.set(point.x, point.y);
    if (!worldSpace) return this.worldPoint;

    if (typeof node.worldToLocal === 'function') {
      return node.worldToLocal(this.worldPoint, this.localPoint);
    }
    // No transform: the node's coordinates are already the query's.
    return this.worldPoint;
  }

  /**
   * Runs a node's own hit test, falling back to its bounds.
   *
   * @param node Node to test.
   * @param local Query point in the node's local space.
   * @param world Query point as supplied by the caller.
   * @param options Tolerance configuration.
   * @returns `{ distance }` on a hit, or `null`.
   */
  private testNode(
    node: Node2DLike,
    local: Vec2,
    world: { x: number; y: number },
    options: HitTestOptions,
  ): { distance: number } | null {
    const tolerance = options.tolerance ?? 0;

    if (typeof node.hitTest === 'function') {
      const result = node.hitTest(local, {
        tolerance,
        worldSpace: false,
      });

      if (result !== null && result !== undefined) {
        // A node may return itself or a descendant; either way it accepted the point.
        return { distance: this.distanceToCentre(node, local) };
      }
      return null;
    }

    if (typeof node.containsPoint === 'function') {
      if (!node.containsPoint(local, tolerance, false)) return null;
      return { distance: this.distanceToCentre(node, local) };
    }

    const bounds = this.boundsOf(node, options.worldSpace ?? true);
    if (bounds === null) {
      // No bounds and no test: a bare node accepts anything inside its own frame.
      return { distance: 0 };
    }

    const testPoint = options.worldSpace === false ? local : world;
    const inside =
      testPoint.x >= bounds.x - tolerance &&
      testPoint.x <= bounds.x + bounds.width + tolerance &&
      testPoint.y >= bounds.y - tolerance &&
      testPoint.y <= bounds.y + bounds.height + tolerance;

    if (!inside) return null;

    return {
      distance: Math.hypot(
        testPoint.x - (bounds.x + bounds.width * 0.5),
        testPoint.y - (bounds.y + bounds.height * 0.5),
      ),
    };
  }

  /** Reads a node's bounds in the requested space. */
  private boundsOf(
    node: Node2DLike,
    worldSpace: boolean,
  ): { x: number; y: number; width: number; height: number } | null {
    if (worldSpace && typeof node.getWorldBounds === 'function') {
      return node.getWorldBounds() ?? null;
    }
    if (typeof node.getBounds === 'function') {
      return node.getBounds() ?? null;
    }
    return null;
  }

  /** Distance from a local point to the centre of the node's local bounds. */
  private distanceToCentre(node: Node2DLike, local: Vec2): number {
    const bounds = this.boundsOf(node, false);
    if (bounds === null) return Math.hypot(local.x, local.y);
    return Math.hypot(
      local.x - (bounds.x + bounds.width * 0.5),
      local.y - (bounds.y + bounds.height * 0.5),
    );
  }
}

/** Clamps a value into `[0, 1]`. */
function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Convenience factory mirroring `new HitTest2D()`.
 *
 * @returns A new 2D hit tester.
 */
export function hitTest2D(): HitTest2D {
  return new HitTest2D();
}
