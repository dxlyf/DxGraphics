# 3D basics

A software-rasterised 3D scene built from the library's maths, scene graph and geometry container — including frustum culling through `BoundingVolume` and `Frustum`.

## What it shows

- **The column-vector convention in practice.** `world = parentWorld * local` is
  produced by `Object3D.updateMatrixWorld`; `Viewport`-free projection is
  `projection * view * world`, evaluated with `Mat4.multiplyMatrices` and
  `Vec3.applyMat4`. `Vec3.applyMat4` **already divides by `w`**, so the result is an
  NDC point.
- **Hand-built geometry.** `src/geometry/3d/` has no primitive generators yet
  (`BoxGeometry` and friends do not exist), so the cube and the swept tube are built
  by writing positions into a `BufferGeometry` with a `BufferAttribute`.
- **Real cross-layer culling.** Each mesh's local bounding sphere is fitted to its
  world matrix with `BoundingVolume.setFromGeometry(geometry).update(mesh.matrixWorld)`
  and tested against `PerspectiveCamera.frustum`. The overlay shows how many objects
  the frustum rejected.
- **Painter's algorithm.** The Canvas2D backend has no depth buffer, so faces are
  sorted back-to-front by the `-z` of their camera-space centroid.
- **Flat shading by hand.** A Lambert term from the face normal dotted with a fixed
  light direction; the albedo is lerped towards white with `Color.lerp`.
- **Inline orbit controls.** Written directly against pointer and wheel events so the
  is written directly in this file.

## Why the projection is not `canvas.render(scene, camera3d)`

The Canvas2D backend's 3D path reads `camera.viewMatrix`. No camera class in this
checkout defines that member — `Camera3D` exposes `matrixWorldInverse` — so passing a
`PerspectiveCamera` to `Canvas2DRenderer.render` would silently fall back to the 2D
pan/zoom transform. This example therefore computes its own projection, which is also
what makes it work without a GPU.

The same reason explains why this example passes `null` as the camera:
the rasteriser is its own `Renderable2D` and owns the projection.

## How to run it

From the repository root:

```bash
pnpm exec vite examples/3d-basic
```

Vite uses `examples/3d-basic/` as the project root and resolves the `../../src/index`
import to the library source; there is no build step.

## What to look for

- A knot-shaped tube rotating slowly while a cube orbits the origin; both appear lit
  from the upper right.
- Nearer faces correctly cover farther ones, including as the tube passes in front of
  the cube.
- Drag to orbit (yaw and pitch), scroll to zoom. Pitch is clamped to avoid gimbal
  weirdness, and zoom to `[3.5, 26]`.
- The overlay reports FPS, the backend, the number of triangles submitted, how many
  objects the frustum culled, and the orbit distance. Zoom far in and `culled` rises.

## Key API

| Call | Purpose |
| --- | --- |
| `new Mesh({ geometry, material })` | Binds a `BufferGeometry` to a node. `material` is structural (`{}` is valid — there are no material classes yet). |
| `new PerspectiveCamera({ fov, near, far })` | Owns `projectionMatrix` and (via `Camera3D`) `matrixWorldInverse`. |
| `mat.multiplyMatrices(a, b)` | `this = a * b`, column-major. |
| `version.applyMat4(mat)` | Transforms a point and performs the perspective divide. |
| `camera.lookAt(new Vec3(0, 0, 0))` | Orients the camera down its `-Z` axis. |
| `new BoundingVolume().setFromGeometry(g).update(worldMatrix)` | Local bounds fitted to world space. |
| `camera.frustum.intersectsSphere(volume.sphere)` | Conservative cull test. |

## Files

| File | Contents |
| --- | --- |
| `index.html` | Complete page: canvas, overlay, orbit hint, styles. |
| `main.ts` | Geometry builders, the `SoftwareRasteriser` renderable, orbit input, bootstrap. |
| `README.md` | This file. |
