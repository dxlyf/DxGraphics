# Picking

Hit testing in 2D and ray/triangle intersection in 3D space, side by side so the difference between the two techniques is visible.

**Backend:** Canvas2D

## What it shows

`Box2.fromCenterAndSize` plus `containsPoint` for rectangles, and `Vec2.distanceTo` against a radius for circles.
Screen-to-world mapping that inverts the same formula the backend applies, so a click lands where the pixel is even after panning and zooming.
Building a world-space ray by un-projecting the near and far NDC points through `inverse(projection * view)`.
`Ray.intersectTriangle(a, b, c, backfaceCulling, target)` returning the hit point or `null`, with the nearest hit winning on distance.
Testing 2D targets from the last-drawn backwards, so the topmost object wins and matches what the user sees.

## What to look for

Five shapes and a projected four-triangle pyramid, with whatever is under the pointer outlined in white and named in the badge.

Move the pointer into the 3D panel: the pierced face highlights and the badge reports the distance. Move it outside and the badge reads `3D miss`, then `no hit`.

## Running it

From the repository root:

```bash
pnpm exec vite examples/picking
```

Vite treats `examples/picking/` as the project root, so the `../../src/index` imports resolve to
the library source with no build step. The full source is in
[`../../examples/picking/`](../../../examples/picking/README.md).