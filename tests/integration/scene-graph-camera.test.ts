/**
 * Scene graph -> `updateMatrixWorld` -> camera projection round-trip integration.
 *
 * This is the chain a frame actually performs:
 *
 * ```
 * Object3D.position/quaternion/scale
 *        -> updateMatrixWorld()               (parent * local, column vectors)
 *        -> Camera3D.updateMatrixWorld()      (matrixWorldInverse = inverse(world))
 *        -> projection * view                 (forward projection to NDC)
 *        -> inverse(projection) * world       (back to world space)
 * ```
 *
 * It also pins the library's two headline conventions: **column-major matrices
 * with column vectors** (`parentWorld * local`) and a **right-handed `+X -> +Y`
 * rotation about `+Z`**.
 *
 * > **Note:** the scene layer's `PerspectiveCamera`/`Camera3D` deliberately expose
 * > only `projectionMatrix`, `projectionMatrixInverse` and `matrixWorldInverse`;
 * > the convenience helpers (`worldToScreen`, `screenPointToRay`,
 * > `unprojectPoint`, `setViewportSize`) live on the core `Camera` in
 * > `src/core/Camera.ts`, which belongs to a different hierarchy. The final test
 * > block covers those helpers on the core camera.
 */

import { describe, expect, it } from 'vitest';

import { Camera } from '../../src/core/Camera';
import { Mat4 } from '../../src/math/Mat4';
import { Quat } from '../../src/math/Quat';
import { Ray } from '../../src/math/Ray';
import { Vec3 } from '../../src/math/Vec3';
import { Object3D } from '../../src/scene/3d/Object3D';
import { PerspectiveCamera } from '../../src/scene/3d/PerspectiveCamera';
import { Scene3D } from '../../src/scene/3d/Scene3D';
import { Group3D } from '../../src/scene/3d/Group3D';

/** Creates a 16:9 perspective camera placed on `+Z` looking at the origin. */
function makeCamera(z = 5): PerspectiveCamera {
  const camera = new PerspectiveCamera({ fov: 50, aspect: 16 / 9, near: 0.1, far: 100 });
  camera.position.set(0, 0, z);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

/** Projects a world point into NDC using `projection * view`, perspective divide included. */
function projectToNdc(
  camera: PerspectiveCamera,
  point: Vec3,
): { x: number; y: number; z: number; w: number } {
  const e = new Mat4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
  // Column-major: clip_i = column i of the matrix dotted with (x, y, z, 1).
  const clipX = e[0] * point.x + e[4] * point.y + e[8] * point.z + e[12];
  const clipY = e[1] * point.x + e[5] * point.y + e[9] * point.z + e[13];
  const clipZ = e[2] * point.x + e[6] * point.y + e[10] * point.z + e[14];
  const clipW = e[3] * point.x + e[7] * point.y + e[11] * point.z + e[15];
  return { x: clipX, y: clipY, z: clipZ, w: clipW };
}

/**
 * Un-projects an NDC point back to world space.
 *
 * The composition order is `matrixWorld * projectionMatrixInverse`, **not** the
 * reverse: applying a matrix to a column vector runs right to left, so this reads
 * "undo the projection (NDC -> camera space), then apply the camera's world
 * transform (camera space -> world space)". Composing them the other way round
 * composes two unrelated transforms and produces a small point near the origin
 * rather than the original world position.
 *
 * `Vec3.applyMat4` treats the vector as a position and does **not** perform the
 * perspective divide, so the caller must divide by the recovered `w` explicitly.
 */
function unprojectFromNdc(camera: PerspectiveCamera, ndc: Vec3): Vec3 {
  const e = new Mat4().multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse).elements;
  const x = e[0] * ndc.x + e[4] * ndc.y + e[8] * ndc.z + e[12];
  const y = e[1] * ndc.x + e[5] * ndc.y + e[9] * ndc.z + e[13];
  const z = e[2] * ndc.x + e[6] * ndc.y + e[10] * ndc.z + e[14];
  const w = e[3] * ndc.x + e[7] * ndc.y + e[11] * ndc.z + e[15];
  return new Vec3(x / w, y / w, z / w);
}

describe('scene graph -> world matrices -> camera projection', () => {
  it('composes a child world matrix as parentWorld * local', () => {
    const parent = new Object3D();
    parent.position.set(10, 0, 0);
    const child = new Object3D();
    child.position.set(0, 2, 0);
    parent.add(child);

    parent.updateMatrixWorld(true);

    const world = child.getWorldPosition();
    expect(world.x).toBeCloseTo(10, 5);
    expect(world.y).toBeCloseTo(2, 5);
    expect(world.z).toBeCloseTo(0, 5);

    // The composition order is observable in the matrix product itself, and in
    // the matrix that the graph cached while traversing.
    const product = new Mat4().multiplyMatrices(parent.matrixWorld, child.matrix);
    expect(product.equals(child.matrixWorld)).toBe(true);
  });

  it('does not commute: local*parentWorld would place the child elsewhere', () => {
    // A rotation makes the product order observable; two pure translations would
    // commute and hide the bug.
    const parent = new Object3D();
    parent.position.set(10, 0, 0);
    parent.quaternion.setFromAxisAngle(new Vec3(0, 0, 1), Math.PI / 2);
    const child = new Object3D();
    child.position.set(2, 0, 0);
    parent.add(child);
    parent.updateMatrixWorld(true);

    const wrongOrder = new Mat4().multiplyMatrices(child.matrix, parent.matrixWorld);
    expect(wrongOrder.equals(child.matrixWorld)).toBe(false);

    const rightOrder = new Mat4().multiplyMatrices(parent.matrixWorld, child.matrix);
    expect(rightOrder.equals(child.matrixWorld)).toBe(true);

    // Rotating +X onto +Y about +Z puts the child 2 units up from the parent.
    expect(child.getWorldPosition().equals(new Vec3(10, 2, 0), 1e-5)).toBe(true);
  });

  it('rotates +X onto +Y about +Z (right-handed convention)', () => {
    const matrix = new Mat4().makeRotationZ(Math.PI / 2);
    const rotated = new Vec3(1, 0, 0).applyMat4(matrix);

    expect(rotated.x).toBeCloseTo(0, 5);
    expect(rotated.y).toBeCloseTo(1, 5);
    expect(rotated.z).toBeCloseTo(0, 5);

    // Column-major storage: elements[column * 4 + row].
    expect(matrix.elements[0]).toBeCloseTo(Math.cos(Math.PI / 2), 5);
    expect(matrix.elements[1]).toBeCloseTo(Math.sin(Math.PI / 2), 5);
  });

  it('builds a view matrix that maps a +Z camera to -Z view space', () => {
    const camera = makeCamera(5);
    const originInView = new Vec3(0, 0, 0).applyMat4(camera.matrixWorldInverse);

    expect(originInView.x).toBeCloseTo(0, 5);
    expect(originInView.y).toBeCloseTo(0, 5);
    expect(originInView.z).toBeCloseTo(-5, 5);
  });

  it('keeps matrixWorldInverse as the exact inverse of matrixWorld', () => {
    const camera = makeCamera(5);
    camera.rotation.set(0.3, -0.7, 0.15);
    camera.updateMatrixWorld(true);

    const identity = new Mat4().multiplyMatrices(camera.matrixWorld, camera.matrixWorldInverse);
    expect(identity.isIdentity(1e-5)).toBe(true);
  });

  it('round-trips a world point through projection and unprojection', () => {
    const camera = makeCamera(5);
    const worldPoint = new Vec3(1, 0.5, 0);

    const ndc = projectToNdc(camera, worldPoint);
    expect(ndc.w).toBeGreaterThan(0);

    // Perspective divide: +X is right of centre, +Y stays up in NDC.
    const ndcX = ndc.x / ndc.w;
    const ndcY = ndc.y / ndc.w;
    const ndcZ = ndc.z / ndc.w;
    expect(ndcX).toBeGreaterThan(0);
    expect(ndcY).toBeGreaterThan(0);

    const back = unprojectFromNdc(camera, new Vec3(ndcX, ndcY, ndcZ));
    expect(back.x).toBeCloseTo(worldPoint.x, 4);
    expect(back.y).toBeCloseTo(worldPoint.y, 4);
    expect(back.z).toBeCloseTo(worldPoint.z, 4);
  });

  it('maps the origin to the centre of the screen', () => {
    const camera = makeCamera(5);
    const ndc = projectToNdc(camera, new Vec3(0, 0, 0));

    expect(ndc.x / ndc.w).toBeCloseTo(0, 5);
    expect(ndc.y / ndc.w).toBeCloseTo(0, 5);
    // OpenGL depth range: -1 at the near plane, +1 at the far plane, so a point
    // 5 units in front of the eye lands inside (-1, 1).
    const depth = ndc.z / ndc.w;
    expect(depth).toBeGreaterThan(-1);
    expect(depth).toBeLessThan(1);
  });

  it('reports a point behind the camera with a negative clip w', () => {
    const camera = makeCamera(5);
    // 15 units further from the origin than the camera: 20 units behind the eye.
    const behind = projectToNdc(camera, new Vec3(0, 0, 20));
    expect(behind.w).toBeLessThan(0);
  });

  it('carries a node through a nested group into world space', () => {
    // A common real failure: content parented to a moving rig. The graph must
    // propagate the rig's transform into the child's world matrix.
    const rig = new Group3D();
    rig.position.set(0, 5, 0);
    rig.quaternion.setFromAxisAngle(new Vec3(1, 0, 0), Math.PI / 2);

    const child = new Object3D();
    child.position.set(0, 0, -3);
    rig.add(child);
    rig.updateMatrixWorld(true);

    const world = child.getWorldPosition();
    expect(world.x).toBeCloseTo(0, 4);
    expect(world.y).toBeCloseTo(8, 4);
    expect(world.z).toBeCloseTo(0, 4);
  });

  it('reparents with attach() without moving the object in world space', () => {
    const root = new Scene3D();
    const a = new Object3D();
    a.position.set(4, 0, 0);
    const b = new Object3D();
    b.position.set(0, 3, 0);
    b.scale.setScalar(2);
    root.add(a, b);
    root.updateMatrixWorld(true);

    // Capture the position of the object that is being reparented — `a`. Capturing
    // `b`'s position would compare against the new parent's world position, which is
    // a different point entirely (and would only pass if the child landed exactly on
    // top of its parent).
    const before = a.getWorldPosition();
    b.attach(a);
    b.updateMatrixWorld(true);

    const after = a.getWorldPosition();
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
    expect(after.z).toBeCloseTo(before.z, 4);

    // `attach` must also rewrite the local transform, not just the parent pointer:
    // `b` is scaled 2x and offset by (0, 3, 0), so `a`'s local position has to become
    // (2, -1.5, 0) for the world position to stay at (4, 0, 0).
    expect(a.position.x).toBeCloseTo(2, 4);
    expect(a.position.y).toBeCloseTo(-1.5, 4);
    expect(a.position.z).toBeCloseTo(0, 4);
  });

  it('keeps quaternion and euler in sync on the same node', () => {
    const node = new Object3D();
    node.rotation.set(0, Math.PI / 3, 0);

    const rebuilt = Quat.fromEuler(node.rotation);
    expect(node.quaternion.equals(rebuilt, 1e-5)).toBe(true);
    // A half-angle basis component: sin(pi/6) == 0.5.
    expect(node.quaternion.y).toBeCloseTo(Math.sin(Math.PI / 6), 5);
  });
});

describe('core Camera screen-space helpers', () => {
  /** Builds the core `Camera` with an explicit viewport, ready for pixel maths. */
  function makeCoreCamera(): Camera {
    const camera = new Camera({ near: 0.1, far: 100 });
    camera.setViewportSize(1280, 720);
    camera.setPerspective((50 * Math.PI) / 180, 0.1, 100, 16 / 9);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    return camera;
  }

  it('projects a world point to viewport pixels', () => {
    const camera = makeCoreCamera();
    const screen = camera.worldToScreen(new Vec3(1, 0.5, 0));

    expect(screen.behind).toBe(false);
    // +X is right of centre; +Y is above centre (screen y grows downwards).
    expect(screen.x).toBeGreaterThan(camera.viewportWidth / 2);
    expect(screen.y).toBeLessThan(camera.viewportHeight / 2);
  });

  it('round-trips pixels through worldToScreen and unprojectPoint', () => {
    const camera = makeCoreCamera();
    const worldPoint = new Vec3(1, 0.5, 0);
    const screen = camera.worldToScreen(worldPoint);

    const ndcX = (screen.x / camera.viewportWidth) * 2 - 1;
    const ndcY = -((screen.y / camera.viewportHeight) * 2 - 1);
    const back = camera.unprojectPoint(new Vec3(ndcX, ndcY, screen.depth));

    expect(back.x).toBeCloseTo(worldPoint.x, 4);
    expect(back.y).toBeCloseTo(worldPoint.y, 4);
    expect(back.z).toBeCloseTo(worldPoint.z, 4);
  });

  it('builds a ray through a pixel that projects back to the same pixel', () => {
    const camera = makeCoreCamera();
    const screen = camera.worldToScreen(new Vec3(0.5, -0.25, 0));
    const ray = camera.screenPointToRay(screen.x, screen.y, new Ray());

    expect(ray.direction.length()).toBeCloseTo(1, 5);
    // The camera looks down -Z, so the ray must travel in that direction.
    expect(ray.direction.z).toBeLessThan(0);

    const along = ray.at(5);
    const reprojected = camera.worldToScreen(along);
    expect(reprojected.x).toBeCloseTo(screen.x, 2);
    expect(reprojected.y).toBeCloseTo(screen.y, 2);
  });

  it('reports a point behind the camera as behind', () => {
    const camera = makeCoreCamera();
    expect(camera.worldToScreen(new Vec3(0, 0, 20)).behind).toBe(true);
  });
});
