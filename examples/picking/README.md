# Picking

Hit testing in 2D and ray/triangle intersection in 3D, both written inline because the picking layer is not complete.

## What it shows

> **Note:** this module is still stabilising — `src/picking/` contains type declarations and raycast data helpers but **no `Raycaster` class**. `main.ts` implements both hit tests directly against verified library primitives.

- **2D bounds testing.** `Box2.fromCenterAndSize(center, size)` plus `Box2.containsPoint(point)` for rectangles, and `Vec2.distanceTo` against a radius for circles. Both take a tolerance so small shapes stay clickable.
- **Screen-to-world mapping.** The same formula the Canvas2D backend applies is inverted (`(screen − centre) / zoom + position`, with `Y` negated), so a click lands where the pixel actually is — including after panning and zooming.
- **3D ray construction.** The ray is built by un-projecting the near and far NDC points through `inverse(projection · view)` and running a `Ray` through them. `Vec3.applyMat4` performs the perspective divide.
- **Ray/triangle intersection.** `Ray.intersectTriangle(a, b, c, backfaceCulling, target)` returns the hit point or `null`; the nearest hit wins by `ray.origin.distanceTo(hitPoint)`.
- **Painter order matters.** 2D hit tests run from the last-drawn object backwards, so the topmost object wins and matches what the user sees.
- **Pinning.** A click pins the current hit, so you can move the pointer away and keep reading the result.

## What to look for

- Move the pointer: whatever is under it gains a white outline and the badge in the bottom-right names it — `2D <name> @ (x, y)` in world units, or `3D <face> @ <distance> units`.
- The panel on the right is a small 3D scene: a four-triangle pyramid projected with `Mat4.fromPerspective` and `Mat4.fromLookAt`. Move the pointer inside the panel and the pierced face highlights; empty space reports `3D miss`.
- The overlay shows the pointer position, the 2D/3D object counts, and the pinned selection.

## Key API

| Call | Purpose |
| --- | --- |
| `Box2.fromCenterAndSize(center, size)` | Builds a bounds box. |
| `box.containsPoint(point)` | 2D hit test. |
| `new Vec2(a).distanceTo(b)` | Circle hit test. |
| `Ray.intersectTriangle(a, b, c, cull, target)` | Möller–Trumbore intersection; `null` on a miss. |
| `mat.multiplyMatrices(p, v).invert()` | The un-projection matrix. |
| `version.applyMat4(mat)` | Transforms a point, dividing by `w`. |

## How to run it

From the repository root:

```bash
pnpm exec vite examples/picking
```

Vite uses `examples/picking/` as the project root, and the `../../src/index` imports in
`main.ts` resolve to the library source, so there is no build step and no `dist/`
requirement. The dev server prints the URL it is listening on.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Complete page: host element, overlay, hit badge, styles. |
| `main.ts` | The demonstration. |
| `README.md` | This file. |
