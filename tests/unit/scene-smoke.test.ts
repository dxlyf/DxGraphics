/**
 * Smoke tests for the scene layer.
 *
 * These cover the invariants the rest of the library builds on: matrix
 * composition, reparenting without drift, projection maths, geometry picking and
 * 2D hit testing. The geometry and picking modules are still being written by
 * other agents, so the raycast tests feed hand-built structural objects into the
 * public API rather than importing those modules.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';

import { Bone } from '../../src/scene/3d/Bone';
import { InstancedMesh } from '../../src/scene/3d/InstancedMesh';
import { Mesh } from '../../src/scene/3d/Mesh';
import { Object3D } from '../../src/scene/3d/Object3D';
import { PerspectiveCamera } from '../../src/scene/3d/PerspectiveCamera';
import { Skeleton } from '../../src/scene/3d/Skeleton';
import { Group2D } from '../../src/scene/2d/Group2D';
import { Node2D } from '../../src/scene/2d/Node2D';
import { Mat4 } from '../../src/math/Mat4';
import { Quat } from '../../src/math/Quat';
import { Rect } from '../../src/math/Rect';
import { Vec2 } from '../../src/math/Vec2';
import { Vec3 } from '../../src/math/Vec3';
import type { GeometryLike, Intersects, RaycasterLike } from '../../src/scene/3d/types';

/** Builds the smallest object the picking code accepts from an index list. */
function makeGeometry(
  positions: number[],
  indices?: number[],
): GeometryLike {
  return {
    attributes: {
      position: {
        array: new Float32Array(positions),
        itemSize: 3,
        count: positions.length / 3,
      },
    },
    index: indices ? { array: new Uint16Array(indices), itemSize: 1 } : null,
    boundingSphere: null,
  };
}

/** Builds a raycaster-shaped object whose ray starts at the origin. */
function makeRaycaster(direction: Vec3, origin: Vec3 = new Vec3(0, 0, 0)): RaycasterLike {
  return { ray: { origin, direction }, near: 0, far: Number.POSITIVE_INFINITY };
}

describe('Object3D world matrices', () => {
  it('composes a child world matrix from its ancestors', () => {
    const parent = new Object3D();
    parent.position.set(1, 2, 3);
    parent.scale.set(2, 1, 1);

    const child = new Object3D();
    child.position.set(1, 2, 3);
    parent.add(child);
    parent.updateMatrixWorld();

    // world = T(1,2,3) * S(2,1,1) * T(1,2,3) => translation (3, 4, 6)
    const world = child.getWorldPosition(new Vec3());
    expect(world.x).toBeCloseTo(3, 6);
    expect(world.y).toBeCloseTo(4, 6);
    expect(world.z).toBeCloseTo(6, 6);

    // The child's own origin maps through the parent's scale on X only.
    const scale = child.getWorldScale(new Vec3());
    expect(scale.x).toBeCloseTo(2, 6);
    expect(scale.y).toBeCloseTo(1, 6);
    expect(scale.z).toBeCloseTo(1, 6);
  });

  it('keeps the Euler triple and the quaternion in sync', () => {
    const object = new Object3D();
    object.rotation.set(0.25, 0.5, 0.75);
    const fromEuler = object.quaternion.clone();

    object.rotation.y = 0.5; // direct field write goes through Euler.onChange
    expect(object.quaternion.y).toBeCloseTo(fromEuler.y, 6);

    object.setRotationFromQuaternion(fromEuler);
    expect(object.rotation.x).toBeCloseTo(0.25, 6);
    expect(object.rotation.z).toBeCloseTo(0.75, 6);
  });

  it('reports a local transform through localToWorld and back', () => {
    const object = new Object3D();
    object.position.set(10, 0, 0);
    object.updateMatrixWorld();

    const world = object.localToWorld(new Vec3(1, 2, 3));
    expect(world.x).toBeCloseTo(11, 6);

    const local = object.worldToLocal(world);
    expect(local.x).toBeCloseTo(1, 6);
    expect(local.y).toBeCloseTo(2, 6);
    expect(local.z).toBeCloseTo(3, 6);
  });
});

describe('Object3D attach and detach', () => {
  it('round-trips a world position through attach and detach', () => {
    const root = new Object3D();
    root.position.set(1, 2, 3);

    const a = new Object3D();
    a.position.set(5, 0, 0);
    a.rotation.set(0, Math.PI / 2, 0);
    root.add(a);

    const b = new Object3D();
    b.position.set(10, 0, 0);
    root.add(b);
    root.updateMatrixWorld();

    const before = b.getWorldPosition(new Vec3());

    a.attach(b);
    a.updateMatrixWorld();
    const afterAttach = b.getWorldPosition(new Vec3());
    expect(afterAttach.x).toBeCloseTo(before.x, 5);
    expect(afterAttach.y).toBeCloseTo(before.y, 5);
    expect(afterAttach.z).toBeCloseTo(before.z, 5);

    root.detach(b);
    root.updateMatrixWorld();
    const afterDetach = b.getWorldPosition(new Vec3());
    expect(afterDetach.x).toBeCloseTo(before.x, 5);
    expect(afterDetach.y).toBeCloseTo(before.y, 5);
    expect(afterDetach.z).toBeCloseTo(before.z, 5);
  });

  it('refuses to create a cycle', () => {
    const parent = new Object3D();
    const child = new Object3D();
    parent.add(child);
    child.add(parent);
    expect(parent.parent).toBeNull();
    expect(child.children).toHaveLength(0);
  });
});

describe('PerspectiveCamera projection', () => {
  it('maps a point at -near onto the near clip plane', () => {
    const camera = new PerspectiveCamera({ fov: 50, aspect: 1, near: 1, far: 100 });
    camera.position.set(0, 0, 0);
    camera.updateMatrixWorld();

    const projected = new Vec3(0, 0, -camera.near).applyMat4(camera.projectionMatrix);
    expect(projected.z).toBeCloseTo(-1, 6);

    const atFar = new Vec3(0, 0, -camera.far).applyMat4(camera.projectionMatrix);
    expect(atFar.z).toBeCloseTo(1, 5);
  });

  it('inverts its own projection matrix', () => {
    const camera = new PerspectiveCamera({ fov: 60, aspect: 1.5, near: 0.5, far: 50 });
    const identity = new Mat4().multiplyMatrices(
      camera.projectionMatrix,
      camera.projectionMatrixInverse,
    );
    expect(identity.isIdentity(1e-4)).toBe(true);
  });

  it('keeps matrixWorldInverse in step with matrixWorld', () => {
    const camera = new PerspectiveCamera();
    camera.position.set(3, 4, 5);
    camera.updateMatrixWorld();
    const roundTrip = new Vec3(1, 1, 1).applyMat4(camera.matrixWorld).applyMat4(
      camera.matrixWorldInverse,
    );
    expect(roundTrip.x).toBeCloseTo(1, 5);
    expect(roundTrip.y).toBeCloseTo(1, 5);
    expect(roundTrip.z).toBeCloseTo(1, 5);
  });
});

describe('Mesh.raycast', () => {
  it('hits a hand-built indexed triangle', () => {
    const mesh = new Mesh({
      geometry: makeGeometry([0, 0, 0, 2, 0, 0, 0, 2, 0], [0, 1, 2]),
    });
    mesh.updateMatrixWorld();

    const intersects: Intersects = [];
    mesh.raycast(makeRaycaster(new Vec3(0, 0, -1), new Vec3(0.5, 0.5, 5)), intersects);

    expect(intersects).toHaveLength(1);
    expect(intersects[0].distance).toBeCloseTo(5, 5);
    expect(intersects[0].point.z).toBeCloseTo(0, 5);
    expect(intersects[0].faceIndex).toBe(0);
    expect(intersects[0].object).toBe(mesh);
  });

  it('misses a triangle it does not cross', () => {
    const mesh = new Mesh({
      geometry: makeGeometry([0, 0, 0, 2, 0, 0, 0, 2, 0], [0, 1, 2]),
    });
    mesh.updateMatrixWorld();

    const intersects: Intersects = [];
    mesh.raycast(makeRaycaster(new Vec3(0, 0, -1), new Vec3(5, 5, 5)), intersects);
    expect(intersects).toHaveLength(0);
  });

  it('picks through the world transform', () => {
    const mesh = new Mesh({
      geometry: makeGeometry([0, 0, 0, 2, 0, 0, 0, 2, 0], [0, 1, 2]),
    });
    mesh.position.set(10, 0, 0);
    mesh.updateMatrixWorld();

    const intersects: Intersects = [];
    mesh.raycast(makeRaycaster(new Vec3(0, 0, -1), new Vec3(10.5, 0.5, 5)), intersects);

    expect(intersects).toHaveLength(1);
    expect(intersects[0].point.x).toBeCloseTo(10.5, 5);
  });
});

describe('InstancedMesh instance data', () => {
  it('round-trips a matrix through setMatrixAt and getMatrixAt', () => {
    const mesh = new InstancedMesh({
      geometry: makeGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]),
      count: 4,
    });

    const matrix = new Mat4().compose(
      new Vec3(1, 2, 3),
      // `compose` takes a `Quat` (or a plain quaternion literal), not an arbitrary
      // object with a `w` component: the identity rotation is what this instanced
      // matrix needs, and `Quat.identity()` says so without a cast.
      Quat.identity(),
      new Vec3(2, 2, 2),
    );
    mesh.setMatrixAt(2, matrix);

    const readBack = mesh.getMatrixAt(2, new Mat4());
    expect(readBack.equals(matrix, 1e-6)).toBe(true);

    // Untouched slots keep their identity default.
    expect(mesh.getMatrixAt(0, new Mat4()).isIdentity()).toBe(true);
    expect(() => mesh.getMatrixAt(4, new Mat4())).toThrow(RangeError);
  });

  it('stores per-instance colours', () => {
    const mesh = new InstancedMesh({ count: 2 });
    mesh.setColorAt(1, { r: 0.25, g: 0.5, b: 0.75 });
    const color = mesh.getColorAt(1, { r: 0, g: 0, b: 0 });
    expect(color?.r).toBeCloseTo(0.25, 6);
    expect(color?.g).toBeCloseTo(0.5, 6);
    expect(color?.b).toBeCloseTo(0.75, 6);
  });
});

describe('Skeleton.update', () => {
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  it('writes worldMatrix * boneInverse into the palette', () => {
    const root = new Bone();
    root.name = 'root';
    root.position.set(1, 0, 0);

    const tip = new Bone();
    tip.name = 'tip';
    tip.position.set(0, 2, 0);
    root.add(tip);

    root.updateMatrixWorld();
    const skeleton = new Skeleton([root, tip]);

    // Re-bind from a pose that has moved away from the bind pose.
    root.position.set(4, 0, 0);
    root.updateMatrixWorld();

    skeleton.update();

    for (let bone = 0; bone < skeleton.bones.length; bone++) {
      const expected = new Mat4().multiplyMatrices(
        skeleton.bones[bone].matrixWorld,
        skeleton.boneInverses[bone],
      );
      const actual = skeleton.boneMatrices.subarray(bone * 16, bone * 16 + 16);
      for (let i = 0; i < 16; i++) {
        // Compare against the float32-rounded expectation.
        expect(actual[i]).toBeCloseTo(expected.elements[i], 5);
      }
    }

    // The bind pose had the bone at x = 1 and it is now at x = 4.
    expect(skeleton.boneMatrices[12]).toBeCloseTo(3, 5);
  });

  it('starts from an identity-inverse bind pose', () => {
    const bone = new Bone();
    const skeleton = new Skeleton([bone]);
    for (let i = 0; i < 16; i++) {
      expect(skeleton.boneInverses[0].elements[i]).toBeCloseTo(IDENTITY[i], 6);
    }
    expect(skeleton.getBoneByName('missing')).toBeUndefined();
    expect(skeleton.computeBoneTexture().size).toBe(4);
  });
});

describe('Node2D.hitTest', () => {
  it('finds a child inside its bounds and rejects a point outside', () => {
    const parent = new Group2D({ x: 10, y: 10 });
    const child = new Node2D({ x: 40, y: -10, interactive: true });
    child.setBounds(new Rect(0, 0, 20, 20));
    parent.add(child);

    // World bounds of the child: (50, 0) to (70, 20).
    const inside = new Vec2(60, 10);
    expect(child.hitTest(inside)).toBe(child);
    expect(parent.hitTest(inside)).toBe(child);

    const outside = new Vec2(200, 200);
    expect(child.hitTest(outside)).toBeNull();
    expect(parent.hitTest(outside)).toBeNull();
  });

  it('honours the interactive flag and the tolerance', () => {
    const node = new Node2D();
    node.setBounds(new Rect(0, 0, 10, 10));
    expect(node.hitTest(new Vec2(5, 5))).toBeNull();

    expect(node.hitTest(new Vec2(5, 5), { includeNonInteractive: true })).toBe(node);

    node.interactive = true;
    expect(node.hitTest(new Vec2(-2, 5))).toBeNull();
    expect(node.hitTest(new Vec2(-2, 5), { tolerance: 3 })).toBe(node);
  });

  it('reports containment of a child and derives bounds from children', () => {
    const parent = new Node2D();
    const child = new Node2D({ x: 100, y: 0 });
    child.setBounds(new Rect(0, 0, 10, 10));
    parent.add(child);

    expect(parent.bounds).toBeNull();
    expect(parent.getBounds()?.width).toBeCloseTo(10, 6);
    expect(parent.containsPoint(new Vec2(105, 5), 0, true)).toBe(true);
    expect(parent.containsPoint(new Vec2(105, 5), 0, false)).toBe(false);
  });

  it('composes a child world matrix through the parent transform', () => {
    const parent = new Node2D({ x: 10, y: 20, rotation: Math.PI / 2 });
    const child = new Node2D({ x: 5, y: 0 });
    parent.add(child);

    const world = child.localToWorld(new Vec2(0, 0));
    expect(world.x).toBeCloseTo(10, 5);
    expect(world.y).toBeCloseTo(25, 5);
  });
});
