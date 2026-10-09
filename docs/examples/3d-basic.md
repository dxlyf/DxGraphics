# 3D basics

A 3D scene graph and hand-built geometry, projected and painter-sorted by hand because the CPU backend has no depth buffer.

**Backend:** Canvas2D (software-rasterised)

## What it shows

`Object3D.updateMatrixWorld` composing `world = parentWorld * local`, the documented column-vector convention.
The view matrix as `inverse(camera.matrixWorld)`, and the projection as `projection * view * world`.
`Vec3.applyMat4` performing the perspective divide, so the result is already an NDC point.
Cross-layer frustum culling: `BoundingVolume.setFromGeometry(geometry).update(mesh.matrixWorld)` tested against `camera.frustum.intersectsSphere`.
The painter's algorithm — faces sorted back-to-front by their camera-space centroid, because there is no z-test.
A `BufferGeometry` and `BufferAttribute` built by hand, since `src/geometry/3d/` has no primitive generators in the state this example was written against.

## What to look for

A knot-shaped tube rotating slowly with a cube orbiting the origin, both apparently lit from the upper right.
Nearer faces correctly covering farther ones, including as the tube passes in front of the cube.
Drag to orbit and scroll to zoom; pitch is clamped and so is the orbit distance.

Zoom in and watch `culled` rise — that is the frustum test rejecting whole meshes. `triangles` is the number of faces that survived and were painted.

## Running it

From the repository root:

```bash
pnpm exec vite examples/3d-basic
```

Vite treats `examples/3d-basic/` as the project root, so the `../../src/index` imports resolve to
the library source with no build step. The full source is in
[`../../examples/3d-basic/`](../../../examples/3d-basic/README.md).