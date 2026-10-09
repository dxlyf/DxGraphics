/**
 * Regression tests for the perspective projection matrix's bottom row.
 *
 * The bottom row is what makes a perspective projection *perspective*: it is
 * `(0, 0, -1, 0)`, so `clip.w = -view.z`, which is exactly the eye-space depth the
 * divide later uses. Several failure modes are possible and every one of them is
 * invisible without a test:
 *
 * - the row is transposed to `(0, 0, 4.81, 5)`-style garbage, in which case
 *   `clip.w` depends on the near/far planes rather than on depth, and every point
 *   projects to roughly the same screen position;
 * - the sign of the `-1` is flipped, which mirrors the whole scene;
 * - the row is left as the identity's `(0, 0, 0, 1)`, which produces an orthographic
 *   divide.
 *
 * The tests below pin the row itself, the near/far NDC mapping it implies, and the
 * round trip through `worldToScreen`/`unprojectPoint`, because a wrong `w` still
 * round-trips *consistently* — it is only the absolute screen position that reveals
 * it.
 */

import { describe, expect, it } from 'vitest';

import { Camera } from '../../src/core/Camera';
import { Mat4 } from '../../src/math/Mat4';
import { Vec3 } from '../../src/math/Vec3';
import { PerspectiveCamera } from '../../src/scene/3d/PerspectiveCamera';

describe('perspective projection bottom row', () => {
  it('Mat4.makePerspective writes (0, 0, -1, 0)', () => {
    const e = new Mat4().makePerspective(Math.PI / 4, 16 / 9, 0.1, 100).elements;

    // Column-major storage: the bottom row is elements[3], [7], [11], [15].
    expect(e[3]).toBeCloseTo(0, 10);
    expect(e[7]).toBeCloseTo(0, 10);
    expect(e[11]).toBeCloseTo(-1, 10);
    expect(e[15]).toBeCloseTo(0, 10);
  });

  it('maps the near plane to NDC z = -1 and the far plane to +1', () => {
    const near = 0.1;
    const far = 100;
    const e = new Mat4().makePerspective(Math.PI / 4, 1, near, far).elements;

    /** Projects an eye-space depth through the perspective divide. */
    const project = (viewZ: number): number => {
      const clipZ = e[10] * viewZ + e[14];
      const clipW = e[11] * viewZ + e[15];
      return clipZ / clipW;
    };

    expect(project(-near)).toBeCloseTo(-1, 6);
    expect(project(-far)).toBeCloseTo(1, 5);
  });

  it('makes clip.w equal the eye-space distance in front of the camera', () => {
    const e = new Mat4().makePerspective(Math.PI / 4, 1, 0.1, 100).elements;

    for (const distance of [0.5, 1, 5, 42]) {
      const viewZ = -distance;
      const clipW = e[11] * viewZ + e[15];
      expect(clipW).toBeCloseTo(distance, 10);
    }
  });

  it('PerspectiveCamera builds a projection matrix with a valid inverse', () => {
    const camera = new PerspectiveCamera({ fov: 50, aspect: 16 / 9, near: 0.1, far: 100 });
    camera.updateProjectionMatrix();

    const e = camera.projectionMatrix.elements;
    expect(e[11]).toBeCloseTo(-1, 10);
    expect(e[3]).toBeCloseTo(0, 10);
    expect(e[7]).toBeCloseTo(0, 10);
    expect(e[15]).toBeCloseTo(0, 10);

    const identity = new Mat4().multiplyMatrices(camera.projectionMatrix, camera.projectionMatrixInverse);
    expect(identity.isIdentity(1e-4)).toBe(true);
  });
});

describe('core Camera screen-space projection', () => {
  /** A 1280x720 perspective camera at `(0, 0, 5)` looking down `-Z`. */
  function makeCamera(): Camera {
    const camera = new Camera({ near: 0.1, far: 100 });
    camera.setViewportSize(1280, 720);
    camera.setPerspective((50 * Math.PI) / 180, 0.1, 100, 16 / 9);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    return camera;
  }

  it('puts the origin exactly at the centre of the viewport', () => {
    const centre = makeCamera().worldToScreen(new Vec3(0, 0, 0));
    expect(centre.behind).toBe(false);
    // A wrong bottom row shows up here as an off-centre or NaN result.
    expect(centre.x).toBeCloseTo(640, 1);
    expect(centre.y).toBeCloseTo(360, 1);
  });

  it('puts +X right of centre and +Y above centre', () => {
    const screen = makeCamera().worldToScreen(new Vec3(1, 0.5, 0));
    expect(screen.behind).toBe(false);
    expect(screen.x).toBeGreaterThan(640);
    // Screen y grows downwards, so above centre is a smaller number.
    expect(screen.y).toBeLessThan(360);
  });

  it('reports a point behind the camera as behind', () => {
    expect(makeCamera().worldToScreen(new Vec3(0, 0, 20)).behind).toBe(true);
  });

  it('round-trips a world point through worldToScreen and unprojectPoint', () => {
    const camera = makeCamera();
    const point = new Vec3(1, 0.5, 0);

    const screen = camera.worldToScreen(point);
    const ndcX = (screen.x / 1280) * 2 - 1;
    const ndcY = -((screen.y / 720) * 2 - 1);
    const back = camera.unprojectPoint(new Vec3(ndcX, ndcY, screen.depth));

    expect(back.x).toBeCloseTo(point.x, 3);
    expect(back.y).toBeCloseTo(point.y, 3);
    expect(back.z).toBeCloseTo(point.z, 3);
  });

  it('builds a ray through a pixel that reprojects to the same pixel', () => {
    const camera = makeCamera();
    const screen = camera.worldToScreen(new Vec3(0.5, -0.25, 0));
    const ray = camera.screenPointToRay(screen.x, screen.y);

    expect(ray.direction.length()).toBeCloseTo(1, 5);
    // The camera looks down -Z.
    expect(ray.direction.z).toBeLessThan(0);

    const along = ray.at(5);
    const reprojected = camera.worldToScreen(along);
    expect(reprojected.x).toBeCloseTo(screen.x, 2);
    expect(reprojected.y).toBeCloseTo(screen.y, 2);
  });
});
