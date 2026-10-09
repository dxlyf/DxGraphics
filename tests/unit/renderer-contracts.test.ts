/**
 * Contract tests for the two hooks that connect the scene layer to the renderers.
 *
 * Both were missing from the source and both fail *silently* when absent, which is
 * the worst failure mode:
 *
 * 1. `CameraLike.viewMatrix` — the WebGL backend and the Canvas2D 3D path read it, so
 *    a camera without it does not merely render wrong, it makes the renderer take its
 *    2D pan/zoom branch and ignore the 3D transform entirely.
 * 2. `SceneLike.collectRenderables` — without it the renderer's fallback walks
 *    `children` one level deep, so anything inside a group is never submitted.
 *
 * These tests pin both, including the traversal rules that are easy to get wrong
 * (hiding a group must hide its subtree; ordering must be depth-first pre-order).
 */

import { describe, expect, it } from 'vitest';

import { Scene } from '../../src/core/Scene';
import { Node } from '../../src/core/Node';
import { Mat4 } from '../../src/math/Mat4';
import { Vec3 } from '../../src/math/Vec3';
import { Group3D } from '../../src/scene/3d/Group3D';
import { Object3D } from '../../src/scene/3d/Object3D';
import { PerspectiveCamera } from '../../src/scene/3d/PerspectiveCamera';
import { Scene3D } from '../../src/scene/3d/Scene3D';

/** A minimal drawable: the traversal only looks for `geometry`. */
function drawable(): Object3D & { geometry: unknown } {
  const object = new Object3D() as Object3D & { geometry: unknown };
  object.geometry = {};
  return object;
}

describe('CameraLike.viewMatrix', () => {
  it('is exposed by every 3D camera and aliases matrixWorldInverse', () => {
    const camera = new PerspectiveCamera({ fov: 50, aspect: 1, near: 0.1, far: 100 });
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);

    // The renderer contract is satisfied structurally.
    const asCameraLike: { viewMatrix?: { elements: ArrayLike<number> } | null } = camera;
    expect(asCameraLike.viewMatrix).toBeDefined();
    expect(asCameraLike.viewMatrix!.elements).toBeDefined();

    // It is the same matrix object, not a copy, so it can never go stale.
    expect(camera.viewMatrix).toBe(camera.matrixWorldInverse);
  });

  it('actually maps a +Z camera to -Z view space', () => {
    const camera = new PerspectiveCamera({ fov: 50, aspect: 1, near: 0.1, far: 100 });
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);

    const originInView = new Vec3(0, 0, 0).applyMat4(camera.viewMatrix);
    expect(originInView.x).toBeCloseTo(0, 5);
    expect(originInView.y).toBeCloseTo(0, 5);
    expect(originInView.z).toBeCloseTo(-5, 5);
  });

  it('stays in sync when the camera moves', () => {
    const camera = new PerspectiveCamera({ fov: 50, aspect: 1, near: 0.1, far: 100 });
    camera.updateMatrixWorld(true);
    const first = new Vec3(0, 0, 0).applyMat4(camera.viewMatrix);

    camera.position.set(3, 0, 0);
    camera.updateMatrixWorld(true);
    const second = new Vec3(0, 0, 0).applyMat4(camera.viewMatrix);

    expect(first.equals(second, 1e-6)).toBe(false);
    expect(second.x).toBeCloseTo(-3, 5);
  });

  it('is the exact inverse of matrixWorld', () => {
    const camera = new PerspectiveCamera({ fov: 50, aspect: 1, near: 0.1, far: 100 });
    camera.position.set(1, 2, 3);
    camera.rotation.set(0.2, -0.4, 0.1);
    camera.updateMatrixWorld(true);

    const identity = new Mat4().multiplyMatrices(camera.matrixWorld, camera.viewMatrix);
    expect(identity.isIdentity(1e-5)).toBe(true);
  });
});

describe('Scene3D.collectRenderables', () => {
  it('reaches renderables nested inside groups', () => {
    const scene = new Scene3D();
    const group = new Group3D();
    const nested = new Group3D();
    const deep = drawable();

    nested.add(deep);
    group.add(nested);
    scene.add(group);

    const list: unknown[] = [];
    scene.collectRenderables(list);

    // The renderer's one-level fallback would find nothing here.
    expect(list).toHaveLength(1);
    expect(list[0]).toBe(deep);
  });

  it('submits depth-first in child order', () => {
    const scene = new Scene3D();
    const first = drawable();
    const second = drawable();
    const group = new Group3D();
    const insideGroup = drawable();

    group.add(insideGroup);
    scene.add(first, group, second);

    const list: unknown[] = [];
    scene.collectRenderables(list);

    expect(list).toEqual([first, insideGroup, second]);
  });

  it('skips a hidden node together with its subtree', () => {
    const scene = new Scene3D();
    const hidden = new Group3D();
    hidden.visible = false;
    const hiddenChild = drawable();
    hidden.add(hiddenChild);

    const visible = drawable();
    scene.add(hidden, visible);

    const list: unknown[] = [];
    scene.collectRenderables(list);

    expect(list).toEqual([visible]);
  });

  it('skips a hidden leaf but keeps its visible siblings', () => {
    const scene = new Scene3D();
    const hidden = drawable();
    hidden.visible = false;
    const shown = drawable();
    scene.add(hidden, shown);

    const list: unknown[] = [];
    scene.collectRenderables(list);

    expect(list).toEqual([shown]);
  });

  it('accepts a node that carries a renderable payload instead of a geometry', () => {
    const scene = new Scene3D();
    const sprite = new Object3D() as Object3D & { renderable: unknown };
    sprite.renderable = { draw: () => undefined };
    scene.add(sprite);

    const list: unknown[] = [];
    scene.collectRenderables(list);

    expect(list).toEqual([sprite]);
  });

  it('ignores plain transform nodes', () => {
    const scene = new Scene3D();
    scene.add(new Group3D(), new Group3D());
    const list: unknown[] = [];
    scene.collectRenderables(list);
    expect(list).toHaveLength(0);
  });

  it('fills the caller-supplied list in place rather than returning a new one', () => {
    // The renderer passes its own reusable array (it must not allocate per frame).
    const scene = new Scene3D();
    scene.add(drawable());
    const list: unknown[] = [];
    const returned = scene.collectRenderables(list);
    expect(returned).toBeUndefined();
    expect(list).toHaveLength(1);
  });

  it('matches the renderer contract signature', () => {
    const scene = new Scene3D();
    // Structurally assignable to `SceneLike`, which is what the backends check.
    // The render list is typed as an array (rather than `unknown`) so a caller can
    // index it, which means the local view below must say so too.
    const asSceneLike: { collectRenderables?: (list: unknown[], camera: unknown) => void } = scene;
    expect(typeof asSceneLike.collectRenderables).toBe('function');
  });
});

describe('core Scene.collectRenderables', () => {
  it('reaches renderables nested inside groups', () => {
    const scene = new Scene();
    const group = new Node();
    const nested = new Node() as Node & { geometry: unknown };
    nested.geometry = {};

    group.add(nested);
    scene.add(group);

    const list: unknown[] = [];
    scene.collectRenderables(list);

    expect(list).toEqual([nested]);
  });

  it('skips a hidden subtree', () => {
    const scene = new Scene();
    const hidden = new Node();
    hidden.visible = false;
    hidden.add(Object.assign(new Node(), { geometry: {} }));
    const shown = Object.assign(new Node(), { geometry: {} });
    scene.add(hidden, shown);

    const list: unknown[] = [];
    scene.collectRenderables(list);

    expect(list).toEqual([shown]);
  });

  it('fills the caller list in place and accepts a camera argument', () => {
    const scene = new Scene();
    scene.add(Object.assign(new Node(), { geometry: {} }));
    const list: unknown[] = [];
    scene.collectRenderables(list, {});
    expect(list).toHaveLength(1);
  });
});
