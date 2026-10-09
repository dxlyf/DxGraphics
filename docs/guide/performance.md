# Performance

What actually costs time, what the library does to avoid it, and how to find out where your
frame went.

Measured figures in this page come from `benchmarks/`. Run `pnpm bench` on your own hardware
before treating any of them as a budget — the numbers that matter are the **ratios**, not the
absolute values.

## The frame budget

At 60 fps you have **16.7 ms**. At 120 fps, 8.3 ms. Divided across everything a frame does:

| Stage | Typical share |
| --- | --- |
| Animation and game logic | Often the largest single share, and usually the caller's |
| `updateMatrixWorld` | Proportional to node count; ~2.2 ms for a 3 279-node tree |
| Culling | Microseconds per object once bounds are cached |
| Render queue build and sort | ~3.2 ms for 10 000 objects, under 1 ms for 1 000 |
| Draw submission | Backend-specific; the GPU backends' real cost |
| Paint | Canvas2D's dominant cost; entirely on the CPU |

That puts a realistic ceiling on the CPU backends at a few thousand objects, and on the GPU
backends at whatever the draw-call count allows.

## Measure first

```ts
renderer.stats.fps;             // smoothed; ignore the first few frames
renderer.stats.frameTime;       // milliseconds for the last frame
renderer.stats.drawCalls;       // submissions this frame
renderer.stats.triangles;
renderer.stats.objects;
renderer.stats.culled;
renderer.stats.stateChanges;    // 2D backends count save/restore pairs
renderer.stats.textureUploads;
renderer.stats.bufferUploads;
renderer.stats.programCompiles;  // should stop rising after the first frames
renderer.info.pixelRatio;
renderer.info.capabilities;
```

Three signals that point at specific problems:

- **`programCompiles` still rising** → shader cache misses, so materials are being recreated or
  their `defines` are varying. See [shaders.md](shaders.md).
- **`bufferUploads` rising every frame** → a geometry's `version` is being bumped, so its whole
  buffer is re-uploaded. Deform in a preallocated attribute rather than rebuilding.
- **`culled` near zero on a large scene** → bounds were never computed, so nothing is rejected.

For a finer look, wrap a section and time it yourself; the library deliberately ships no
profiler:

```ts
const t0 = performance.now();
scene.updateMatrixWorld();
const t1 = performance.now();
renderer.render(scene, camera);
const t2 = performance.now();

overlay.textContent = `update ${(t1 - t0).toFixed(2)} ms · render ${(t2 - t1).toFixed(2)} ms`;
```

## The five things that actually regress

### 1. Allocating in the frame loop

This is the dominant cause of stutter, and the reason for the library's central convention:
**mutators return `this`, read methods take an optional `target`.**

```ts
// Bad: two allocations per object per frame, thousands of objects.
for (const node of nodes) {
  node.position.copy(scratch.add(offset).normalize());
}

// Good: the scratch vector is allocated once, outside the loop.
for (const node of nodes) {
  node.position.copy(scratch.addVectors(offset, bias).normalize());
}
```

The read methods that accept a target include `getWorldPosition`, `getWorldQuaternion`,
`getWorldScale`, `localToWorld`, `worldToLocal`, `Frustum.fromProjectionMatrix`,
`Mat4.getColumn`/`getRow`/`getTranslation`/`getScale`, `Box3.getCenter`/`getSize`,
`Sphere.getBoundingBox`, `Vec3.toVec2` and `Euler.toQuat`/`toMat4`.

`Pool` recycles per-frame objects rather than relying on the garbage collector:

```ts
import { Pool, Vec3 } from '@dxyl/graphics';

const scratches = new Pool<Vec3>(() => new Vec3(), {
  capacity: 64,
  onAcquire: (v) => v.set(0, 0, 0),
});

scratches.use((v) => {
  v.copy(a).sub(b);
  // ... automatically released, even if this throws
});
```

`use(callback)` releases in a `finally`, which is what stops a throw from leaking a pooled
object. `releaseAll()` at the end of a frame is the belt-and-braces version.

### 2. Recomputing what did not change

`Object3D.updateMatrixWorld` recomputes **every** child unconditionally, so a static graph pays
for itself each frame. Freeze it:

```ts
staticProp.matrixAutoUpdate = false;   // the local matrix is never recomposed
staticSubtree.matrixAutoUpdate = false;
```

And compute geometry bounds **once**, after building or deforming:

```ts
geometry.computeBoundingBox();
geometry.computeBoundingSphere();
```

`BoundingVolume.setFromGeometry` prefers those cached volumes and only scans the position
attribute when neither exists. On the benchmark geometry that is the difference between
**~0.9 µs** and **~2.9 ms** — three orders of magnitude, per object, per frame.

`updateMatrixWorld(force)` and `updateWorldMatrix(updateParents, updateChildren)` let you update
just the part of the graph that moved:

```ts
// Only this node's chain, not the whole scene.
arm.updateWorldMatrix(true, false);
```

### 3. Drawing one object at a time

Both 2D backends issue one draw per renderable; WebGL issues one per renderable per material.
Reducing the count is the highest-leverage change on a GPU backend.

Order the queue so draws that share state are adjacent — which the default comparator already
does:

```ts
// Give objects that share a program and texture the same material id.
const shared = { id: 'terrain', /* … */ };
for (const tile of tiles) scene.add(new Mesh({ geometry: tile, material: shared }));
```

`RenderQueue.sort` groups by `renderOrder`, then `materialId`, then depth. The benchmark shows
material grouping costs about **half the sort throughput** (~3.85k vs ~7.15k sorts/sec at 1 000
objects) and buys back state changes at draw time, which is normally the better trade. For a
depth pre-pass or a shadow pass, where depth order matters and state does not, turn it off:

```ts
const shadowQueue = new RenderQueue({ sortByMaterial: false });
```

### 4. Over-drawing on Canvas2D

Canvas2D has no depth buffer, so every pixel is painted in order and whatever is drawn last
wins. Two consequences:

- **Cull aggressively.** `BoundingVolume` + `Frustum` is cheap; painting is not.
- **Clip before filling.** `painter.clip()` bounds the cost of an expensive fill, and
  `painter.setScissor(...)` on the renderer bounds it at the backend level.

Also watch the state stack: `painter.save()`/`restore()` are cheap individually, but
`renderer.stats.stateChanges` climbing frame over frame means a `restore()` is missing.

### 5. Rebuilding what could be mutated

```ts
// Bad: a new BufferAttribute every frame, so the whole buffer re-uploads.
geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));

// Good: mutate in place; the attribute's `version` is what the backend caches on.
const position = geometry.getAttribute('position') as BufferAttribute;
for (let i = 0; i < position.count; i++) position.setXYZ(i, …);
position.needsUpdate = true;   // or bump `version`, depending on the version of the API
```

Preallocate the attribute at the maximum size you will need, then use `setDrawRange(start, count)`
to draw a prefix. That keeps the buffer identity stable across frames.

## Known hot spots, measured

From `benchmarks/geometry/generators.bench.ts` on the development host:

| Operation | Cost | Notes |
| --- | --- | --- |
| `BoundingVolume.setFromGeometry` (cached bounds) | ~0.9 µs | The fast path. Keep bounds computed. |
| `BoundingVolume.update` | ~3.1 µs | Eight transformed box corners per object per frame. |
| `computeBoundingBox`, 25.6k vertices | ~2.9 ms | One-time. Never run per frame. |
| `computeVertexNormals`, 25.6k vertices | ~26.5 ms | One-time. The most expensive generator. |
| `Box3.setFromPoints`, 100k points | ~9.2 ms | Bulk scan; `Scene.computeBounds` uses it. |
| `Sphere.setFromPoints`, 100k points | ~29.5 ms | Budget for a periodic recompute, not per frame. |

From `benchmarks/renderer/render-queue.bench.ts`:

| Operation | Cost |
| --- | --- |
| `RenderList.pushAll` 1 000 objects | ~5.6 µs |
| `RenderQueue.sort` 1 000 objects | ~260 µs |
| `RenderQueue.sort` 10 000 objects | ~3.2 ms |
| `Node.traverse` 3 279 nodes | ~0.78 ms |
| `Node.updateMatrixWorld` 3 279 nodes | ~2.16 ms |

The queue sort at 10 000 objects is already a fifth of a 60 fps frame. If you have that many
objects and are CPU-bound, reduce the count that reaches the queue — cull before submitting,
rather than submitting and sorting everything.

## A checklist

1. **Cache bounds.** `computeBoundingBox()`/`computeBoundingSphere()` once, after construction
   or deformation.
2. **Freeze static transforms.** `matrixAutoUpdate = false` where nothing moves.
3. **Preallocate.** Positions, matrices, scratch vectors, pooled objects.
4. **Update narrowly.** `updateWorldMatrix(true, false)` for a single moving branch.
5. **Share materials.** One material object, one `id`, many meshes.
6. **Cull before sorting.** Frustum-test first; only survivors reach the queue.
7. **Match the pixel ratio to the display.** `pixelRatio: Math.min(2, devicePixelRatio)` is
   usually the right cap — 3× costs 2.25× the pixels of 2× for no visual gain on most screens.
8. **Stop the loop when nothing is happening.** `renderer.stop()` when a scene is idle, and
   `controls.update(delta)`'s boolean return tells you when it is not idle.
9. **Profile before optimising.** The five regressions above are in order of how often they are
   the actual cause.
10. **Do not guess the ratio.** Change one thing, re-run `pnpm bench` or the frame timer, and
    compare.

## See also

- [../benchmarks/README.md](../../benchmarks/README.md) — the suites, the baseline table, and how
  to read the output.
- [rendering-backends.md](rendering-backends.md) — the per-backend cost model.
- [geometry.md](geometry.md) — bounds, normals and attribute mutation.
