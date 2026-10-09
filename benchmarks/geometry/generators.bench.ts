/**
 * Geometry hot-path benchmarks.
 *
 * Run with `pnpm bench`. All geometry and vertex data is built **outside** the `bench`
 * callbacks; only the measured operation runs inside.
 *
 * ## How to read the numbers
 *
 * `hz` is operations per second and `mean` is milliseconds per operation, as reported
 * by Vitest. These benches measure whole-geometry work rather than per-vertex work, so
 * `mean` is the more natural figure: a cube tessellation should land in the tens of
 * microseconds, and a bounding-volume pass over 100k vertices in the low milliseconds.
 * Compare runs on the **same machine**; the useful signal is the ratio between benches.
 *
 * ## What would regress these
 *
 * - **`setAttribute` / `setIndex`** — converting the typed array on every call, or
 *   copying it instead of storing the reference.
 * - **`computeBoundingBox`** — replacing the strided `getX/getY/getZ` accessors with
 *   per-element object allocation, or dropping the reused scratch vector.
 * - **`computeBoundingSphere`** — recomputing the box inside the radius loop, or
 *   accumulating `distanceTo` (which square-roots per vertex) instead of
 *   `distanceToSquared`.
 * - **`computeVertexNormals`** — allocating a `Vec3` per triangle corner instead of
 *   reusing the module-scratch vectors.
 * - **`BoundingVolume.setFromGeometry`** — losing the memoised local box, so the
 *   position scan runs twice per call.
 */

import { bench, describe } from 'vitest';

import { BoundingVolume } from '../../src/core/BoundingVolume';
import { Box3 } from '../../src/math/Box3';
import { Frustum } from '../../src/math/Frustum';
import { Mat4 } from '../../src/math/Mat4';
import { Sphere } from '../../src/math/Sphere';
import { Vec3 } from '../../src/math/Vec3';
import { BufferAttribute } from '../../src/geometry/core/BufferAttribute';
import { BufferGeometry } from '../../src/geometry/core/BufferGeometry';

/* -------------------------------------------------------------------------- */
/* Pre-built inputs                                                           */
/* -------------------------------------------------------------------------- */

/** Builds an indexed cube's positions and indices. */
function cubeData(): { positions: Float32Array; indices: number[] } {
  const corners: [number, number, number][] = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const positions = new Float32Array(corners.length * 3);
  for (let i = 0; i < corners.length; i++) {
    positions[i * 3] = corners[i][0];
    positions[i * 3 + 1] = corners[i][1];
    positions[i * 3 + 2] = corners[i][2];
  }
  const indices: number[] = [];
  for (const [a, b, c, d] of [
    [0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4],
    [2, 3, 7, 6], [1, 2, 6, 5], [0, 3, 7, 4],
  ]) {
    indices.push(a, b, c, a, c, d);
  }
  return { positions, indices };
}

const cube = cubeData();

/** A grid mesh with `side * side` vertices and `2 * (side-1)^2` triangles. */
function gridGeometry(side: number): BufferGeometry {
  const positions = new Float32Array(side * side * 3);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = (y * side + x) * 3;
      positions[i] = x - side / 2;
      positions[i + 1] = Math.sin(x * 0.3) * Math.cos(y * 0.2);
      positions[i + 2] = y - side / 2;
    }
  }
  const indices: number[] = [];
  for (let y = 0; y < side - 1; y++) {
    for (let x = 0; x < side - 1; x++) {
      const a = y * side + x;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** 160×160 = 25 600 vertices, ~50k triangles. */
const grid = gridGeometry(160);

/** A geometry with a precomputed box, for the `setFromGeometry` fast path. */
const boxedGeometry = (() => {
  const geometry = gridGeometry(64);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
})();

/** 100 000 points, for the bulk bounding-volume pass. */
const manyPoints: Vec3[] = (() => {
  const points: Vec3[] = [];
  for (let i = 0; i < 100_000; i++) {
    points.push(new Vec3(Math.sin(i) * 10, Math.cos(i * 1.7) * 10, Math.sin(i * 0.3) * 10));
  }
  return points;
})();

const worldMatrix = Mat4.fromTranslation(new Vec3(12, -4, 7));
const volume = new BoundingVolume().setFromGeometry(boxedGeometry);
const frustum = Frustum.fromProjectionAndView(
  Mat4.fromPerspective((50 * Math.PI) / 180, 16 / 9, 0.1, 200),
  Mat4.fromLookAt(new Vec3(0, 0, 30), new Vec3(0, 0, 0), new Vec3(0, 1, 0)),
);

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

describe('BufferGeometry construction', () => {
  bench('setAttribute + setIndex on a 25.6k-vertex grid', () => {
    // The cost of assembling a geometry that was indexed into flat arrays elsewhere.
    // Regresses if `setIndex` copies the array instead of wrapping it, or if
    // `setAttribute` validates every element.
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(grid.getAttribute('position')!.array, 3));
    geometry.setIndex([0, 1, 2]);
  });

  bench('clone the 25.6k-vertex grid', () => {
    // `clone` deep-copies every attribute. Used when two meshes must not share buffers.
    // Regresses if `copy` starts round-tripping through JSON.
    grid.clone();
  });

  bench('dispose the 25.6k-vertex grid', () => {
    // Disposal is on the frame-teardown path, so it should stay cheap: releasing
    // references, not clearing arrays element by element.
    grid.clone().dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* Bounding volumes                                                           */
/* -------------------------------------------------------------------------- */

describe('bounding volumes', () => {
  bench('computeBoundingBox on 25.6k vertices', () => {
    // One strided read per vertex into a reused scratch vector. This is the per-mesh
    // cost paid once after a geometry is built or deformed.
    grid.computeBoundingBox();
  });

  bench('computeBoundingSphere on 25.6k vertices', () => {
    // Strictly more work than the box: it computes the box, then scans again for the
    // maximum squared distance. Expect roughly twice the box figure.
    grid.computeBoundingSphere();
  });

  bench('computeVertexNormals on 25.6k vertices', () => {
    // The heaviest generator: per triangle, two subtractions, a cross product and three
    // accumulate-and-write backs, then a normalisation pass over every vertex.
    grid.computeVertexNormals();
  });

  bench('Box3.setFromPoints over 100k points', () => {
    // The bulk path used by `Scene.computeBounds` and by the 3D generators.
    new Box3().setFromPoints(manyPoints);
  });

  bench('Sphere.setFromPoints over 100k points', () => {
    // Same scan, plus the centroid and radius pass. Expect it to sit above the box.
    new Sphere().setFromPoints(manyPoints);
  });

  bench('BoundingVolume.setFromGeometry (memoised box)', () => {
    // The fast path: the geometry already carries a box and a sphere, so nothing is
    // scanned. This should be far cheaper than the two benches above — if it is not,
    // the memoisation has been lost.
    new BoundingVolume().setFromGeometry(boxedGeometry);
  });

  bench('BoundingVolume.update (world matrix)', () => {
    // Eight transformed corners for the box plus one for the sphere centre. Called once
    // per renderable per frame during culling.
    volume.update(worldMatrix);
  });

  bench('volume.update + frustum.intersectsSphere', () => {
    // The whole per-object cull, which is what a frame actually pays.
    volume.update(worldMatrix);
    void frustum.intersectsSphere(volume.sphere);
  });
});
