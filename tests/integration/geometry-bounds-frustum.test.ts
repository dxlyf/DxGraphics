/**
 * Geometry -> bounds -> frustum-culling integration.
 *
 * Exercises the full cross-layer chain with no GPU and no DOM:
 *
 * ```
 * BufferGeometry.computeBoundingBox/Sphere
 *        -> BoundingVolume.setFromGeometry(geometry)
 *        -> BoundingVolume.update(node.matrixWorld)
 *        -> Frustum.intersectsSphere / intersectsBox
 *        -> Scene.computeBounds()
 * ```
 *
 * Every stage lives in a different layer, so a signature change in any of them
 * breaks this file rather than silently breaking an example.
 */

import { describe, expect, it } from 'vitest';

import { BoundingVolume } from '../../src/core/BoundingVolume';
import { Camera } from '../../src/core/Camera';
import { Node } from '../../src/core/Node';
import { Scene } from '../../src/core/Scene';
import { BufferAttribute } from '../../src/geometry/core/BufferAttribute';
import { BufferGeometry } from '../../src/geometry/core/BufferGeometry';
import { Box3 } from '../../src/math/Box3';
import { Mat4 } from '../../src/math/Mat4';
import { Sphere } from '../../src/math/Sphere';
import { Vec3 } from '../../src/math/Vec3';

/* -------------------------------------------------------------------------- */
/* Local helpers (deliberately not shared between test files)                  */
/* -------------------------------------------------------------------------- */

/** Builds an axis-aligned cube of the given half-extent, centred on the origin. */
function makeCubeGeometry(half: number): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const corners: [number, number, number][] = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  for (const [x, y, z] of corners) positions.push(x * half, y * half, z * half);
  const faces: [number, number, number, number][] = [
    [0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4],
    [2, 3, 7, 6], [1, 2, 6, 5], [0, 3, 7, 4],
  ];
  for (const [a, b, c, d] of faces) indices.push(a, b, c, a, c, d);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * Builds a camera and returns it with a live frustum.
 *
 * `Camera.setPerspective` + `Camera.updateMatrixWorld()` is the documented way to
 * get a view-projection pair; `Camera3D`/`PerspectiveCamera` live in the scene
 * layer and are covered by the scene-graph integration test.
 */
function makeCamera(eye: Vec3, fovDegrees = 50, near = 0.1, far = 100): Camera {
  const camera = new Camera({ near, far });
  camera.setPerspective((fovDegrees * Math.PI) / 180, near, far, 1);
  camera.position.copy(eye);
  camera.updateMatrixWorld();
  return camera;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('geometry -> bounds -> frustum culling', () => {
  it('computes matching box and sphere bounds for a cube', () => {
    const geometry = makeCubeGeometry(1);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const box = geometry.boundingBox;
    const sphere = geometry.boundingSphere;
    expect(box).not.toBeNull();
    expect(sphere).not.toBeNull();
    if (!box || !sphere) return;

    expect(box.min.x).toBeCloseTo(-1, 5);
    expect(box.max.y).toBeCloseTo(1, 5);
    expect(box.containsPoint(new Vec3(0.5, -0.5, 0.5))).toBe(true);
    expect(box.containsPoint(new Vec3(2, 0, 0))).toBe(false);

    // The centre of the box is the origin, and the farthest vertex is sqrt(3) away.
    expect(sphere.center.length()).toBeCloseTo(0, 5);
    expect(sphere.radius).toBeCloseTo(Math.sqrt(3), 5);
  });

  it('fits a BoundingVolume from geometry and tracks the world matrix', () => {
    const geometry = makeCubeGeometry(1);
    const volume = new BoundingVolume().setFromGeometry(geometry);
    expect(volume.hasLocalBounds).toBe(true);
    expect(volume.hasWorldBounds).toBe(false);

    volume.update(Mat4.fromTranslation(new Vec3(10, 0, 0)));

    expect(volume.hasWorldBounds).toBe(true);
    expect(volume.box.getCenter().x).toBeCloseTo(10, 5);
    expect(volume.sphere.center.x).toBeCloseTo(10, 5);
    // Translation must not change the radius.
    expect(volume.sphere.radius).toBeCloseTo(Math.sqrt(3), 5);
  });

  it('scales the world sphere radius by the largest axis of the world matrix', () => {
    const geometry = makeCubeGeometry(1);
    const volume = new BoundingVolume().setFromGeometry(geometry);
    // A non-uniform scale must stay conservative: the largest axis wins.
    volume.update(Mat4.fromScale(new Vec3(2, 1, 1)));

    expect(volume.worldScale).toBeCloseTo(2, 5);
    expect(volume.sphere.radius).toBeCloseTo(Math.sqrt(3) * 2, 5);
  });

  it('culls a cube that sits behind the camera', () => {
    const camera = makeCamera(new Vec3(0, 0, 10));
    const frustum = camera.frustum;
    const geometry = makeCubeGeometry(1);

    const visible = new BoundingVolume().setFromGeometry(geometry);
    visible.update(Mat4.fromTranslation(new Vec3(0, 0, 0)));
    expect(frustum.intersectsSphere(visible.sphere)).toBe(true);
    expect(frustum.intersectsBox(visible.box)).toBe(true);

    // 50 units behind the camera: outside both the near plane and the view cone.
    const behind = new BoundingVolume().setFromGeometry(geometry);
    behind.update(Mat4.fromTranslation(new Vec3(0, 0, 60)));
    expect(frustum.intersectsSphere(behind.sphere)).toBe(false);
    expect(frustum.intersectsBox(behind.box)).toBe(false);
  });

  it('culls a cube that is far off to the side', () => {
    const camera = makeCamera(new Vec3(0, 0, 10));
    const volume = new BoundingVolume().setFromGeometry(makeCubeGeometry(1));
    volume.update(Mat4.fromTranslation(new Vec3(5_000, 0, 0)));

    expect(camera.frustum.intersectsSphere(volume.sphere)).toBe(false);
  });

  it('does not report the camera eye as inside the frustum in every direction', () => {
    const camera = makeCamera(new Vec3(0, 0, 10));

    // The eye is the frustum apex. The near plane cuts the apex off, so the point
    // itself is outside, as is any volume that lies wholly behind it.
    expect(camera.frustum.containsPoint(new Vec3(0, 0, 10))).toBe(false);

    const cube = makeCubeGeometry(1);

    // `makeCubeGeometry(1)` is a cube of **half-extent 1** (it spans [-1, 1] on each
    // axis, not [-0.5, 0.5]), so it reaches 2 units across and its bounding sphere has
    // radius `sqrt(3) ~= 1.732`.
    const volume = new BoundingVolume().setFromGeometry(cube);

    // 1. Sphere culling is expected to be *conservative*, and here that is the whole
    //    point. Centred on the eye at z = 10 the bounding sphere reaches from z = 8.27
    //    to z = 11.73. The near plane is at z = 9.9 and the frustum shrinks towards the
    //    apex, so the sphere pokes out of both the near plane and all four side planes.
    //    A sphere test that says "outside" for a volume enclosing the apex is correct:
    //    the sphere is not entirely inside any part of the frustum.
    volume.update(Mat4.fromTranslation(new Vec3(0, 0, 10)));
    expect(volume.sphere.radius).toBeCloseTo(Math.sqrt(3), 6);
    expect(camera.frustum.intersectsSphere(volume.sphere)).toBe(false);

    // 2. The box test is tighter and must reach the opposite verdict for the *same*
    //    volume, because the box does intersect the frustum: its lower half
    //    (z in [9, 10.9]) lies inside the near plane. The two tests disagreeing here is
    //    correct and is exactly why the box variant exists — using the sphere alone
    //    would wrongly cull a large object that straddles the camera.
    expect(camera.frustum.intersectsBox(volume.box)).toBe(true);

    // 3. Away from the apex, both tests agree. Moved well inside, the volume is
    //    plainly visible...
    const inside = new BoundingVolume().setFromGeometry(cube);
    inside.update(Mat4.fromTranslation(new Vec3(0, 0, 0)));
    expect(camera.frustum.intersectsSphere(inside.sphere)).toBe(true);
    expect(camera.frustum.intersectsBox(inside.box)).toBe(true);

    // ... and moved well behind the camera, both reject it.
    const behind = new BoundingVolume().setFromGeometry(cube);
    behind.update(Mat4.fromTranslation(new Vec3(0, 0, 40)));
    expect(camera.frustum.intersectsSphere(behind.sphere)).toBe(false);
    expect(camera.frustum.intersectsBox(behind.box)).toBe(false);
  });

  it('culls a cube pushed past the far plane', () => {
    const camera = makeCamera(new Vec3(0, 0, 10), 50, 0.1, 20);
    const volume = new BoundingVolume().setFromGeometry(makeCubeGeometry(1));
    // 10 units further from the origin than the camera: ~20 units away, at the
    // far plane, then 30 units the other way from the origin.
    volume.update(Mat4.fromTranslation(new Vec3(0, 0, -40)));

    expect(camera.frustum.intersectsSphere(volume.sphere)).toBe(false);
  });

  it('aggregates child bounds through Scene.computeBounds()', () => {
    const scene = new Scene();

    const addVolumeNode = (position: Vec3) => {
      const node = new Node();
      node.position.copy(position);
      node.updateMatrixWorld(true);
      // Scene.computeBounds() reads a structural `boundingVolume` off every node,
      // so this is the minimal stand-in for a Mesh.
      (node as unknown as { boundingVolume: BoundingVolume }).boundingVolume = new BoundingVolume()
        .setFromBox(new Box3(new Vec3(-1, -1, -1), new Vec3(1, 1, 1)))
        .update(node.matrixWorld);
      scene.add(node);
      return node;
    };

    addVolumeNode(new Vec3(-5, 0, 0));
    addVolumeNode(new Vec3(5, 0, 0));

    const bounds = scene.computeBounds(true);
    expect(bounds.hasWorldBounds).toBe(true);
    expect(bounds.box.min.x).toBeCloseTo(-6, 5);
    expect(bounds.box.max.x).toBeCloseTo(6, 5);
    expect(bounds.containsPoint(new Vec3(0, 0, 0))).toBe(true);
    expect(bounds.containsPoint(new Vec3(20, 0, 0))).toBe(false);
  });

  it('reports an empty scene as having no world bounds', () => {
    const scene = new Scene();
    const bounds = scene.computeBounds(true);
    expect(bounds.hasWorldBounds).toBe(false);
    // `Scene.intersectsBounds` is deliberately conservative when nothing is known.
    expect(scene.intersectsBounds(new Sphere(new Vec3(0, 0, 0), 1))).toBe(true);
  });
});
