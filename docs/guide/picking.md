# Picking

Turning a pointer position into "what is under this point". Six strategies, one per situation.

## Choosing a strategy

| Entry point | Strategy | Use when |
| --- | --- | --- |
| `Raycaster` | World-space ray vs the scene graph | You need the object and a distance. The general-purpose choice. |
| `MeshPicker` | Precise ray vs triangles | You need UV, barycentric coordinates or a normal. |
| `BoundingBoxPicker` | Ray vs bounding volumes | You need speed, not accuracy — broad-phase culling. |
| `GPUPicking` | Render ids, read a pixel | The scene is huge, instanced, or shader-generated. |
| `HitTest2D` | A z-ordered tree walk | The scene is 2D. |
| `SpritePicker` | Ray vs a camera-facing quad | The target is a billboard. |

`src/picking/` imports **nothing** from `src/scene`, `src/geometry` or `src/renderer`: every
dependency is a structural interface declared in `src/picking/types.ts`. `Object3D`, `Mesh`,
`BufferGeometry`, `Camera3D`, `Node2D` and the concrete renderers all satisfy those interfaces
unchanged, and `Raycaster` implements the `RaycasterLike` contract the scene graph already
declares for its own raycast methods — so either layer can drive the other.

## `Raycaster` — the general case

```ts
import { Raycaster, Vec2, Vec3 } from '@dxyl/graphics';

const raycaster = new Raycaster({
  near: 0,
  far: Infinity,
  layers: 0xffffffff,
  params: { Points: { threshold: 1 }, Line: { threshold: 1 }, backfaceCulling: false },
});

// From a camera and normalised device coordinates.
raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);

// Or from a world-space ray.
raycaster.set(new Vec3(0, 0, 5), new Vec3(0, 0, -1).normalize());

const hits = raycaster.intersectObjects(scene.children, true);
hits[0]?.object;    // the nearest hit
hits[0]?.distance;
hits[0]?.point;
hits[0]?.faceIndex;
hits[0]?.uv;
hits[0]?.instanceId;
```

| Member | Purpose |
| --- | --- |
| `near`, `far` | Clip the ray's extent. `far: Infinity` tests everything. |
| `layers` | A bitmask; objects whose `layers` do not overlap are skipped. |
| `params` | `{ Points: { threshold }, Line: { threshold }, backfaceCulling }`. |
| `maxResults` | Cap on returned hits (`DEFAULT_MAX_PICK_RESULTS` is `100`). |
| `set(origin, direction)` | Install a world-space ray. |
| `setFromCamera(ndc, camera)` | Build the ray through an NDC point. |
| `intersectObject(object, recursive?)` / `intersectObjects(objects, recursive?)` | The main calls. |
| `intersectFlat(objects)` | A non-recursive pass over a flat list. |
| `ndcFromPointer(x, y, rect)` | Convert a client position to NDC; also a static form. |
| `testLayers(object)` / `passesBoundsReject(object)` | The two cheap rejections, exposed. |
| `intersectsSphere(cx, cy, cz, r)` | Broad-phase test. |
| `toLocalRay(object)` | The ray in an object's local space, or `null`. |
| `clone()` | An independent copy, for a per-thread or per-view raycaster. |

### Converting a pointer position

The DOM gives you a client position; the raycaster wants NDC in `-1..1` with `+Y` up:

```ts
canvas.addEventListener('pointerdown', (event) => {
  const rect = canvas.getBoundingClientRect();
  const ndc = Raycaster.ndcFromPointer(event.clientX, event.clientY, rect);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  select(hits[0]?.object ?? null);
});
```

Note the sign: NDC `y` is **flipped** relative to the DOM, because the canvas' `+Y` points down
and the world's points up. `ndcFromPointer` does that for you — doing it by hand is the single
most common picking bug.

## `MeshPicker` — precision

When you need more than "which object": interpolated UVs, barycentric weights, or the geometric
normal at the hit.

```ts
import { MeshPicker } from '@dxyl/graphics';

const picker = meshPicker();
const hit = picker.pick(raycaster, mesh, { /* MeshPickOptions */ });

hit?.distance;
hit?.point;
hit?.uv;            // interpolated across the triangle
hit?.faceIndex;
```

| Member | Purpose |
| --- | --- |
| `pick(raycaster, mesh, options?)` | Nearest hit on one mesh. |
| `intersect(raycaster, mesh, out?)` | Every hit, appended to `out`. |
| `pickTriangle(raycaster, a, b, c)` | One triangle, for custom geometry. |
| `interpolateUv(...)` | UV interpolation, exposed separately. |

`Mesh.raycast` already does the Möller–Trumbore test against its own geometry — reach for
`MeshPicker` when you want the extra per-hit data or a finer control over the traversal.

## `BoundingBoxPicker` — speed

The broad phase: reject most of the scene with sphere and box tests, then run a precise pass on
the survivors.

```ts
import { BoundingBoxPicker } from '@dxyl/graphics';

const broad = boundingBoxPicker();
const candidates = broad.pickAll(raycaster, scene.children, { recursive: true });
for (const candidate of candidates) {
  const precise = meshPicker().pick(raycaster, candidate.object);
  if (precise) { /* … */ }
}
```

| Member | Purpose |
| --- | --- |
| `pick(raycaster, objects)` | The nearest bounding-volume hit. |
| `pickAll(raycaster, objects, options?)` | Every candidate, for a second pass. |
| `pickRecursive(raycaster, root)` | Walks the tree itself. |
| `raySphere(...)` / `rayBox(...)` | The primitives, callable directly. |

This is the shape that keeps picking cheap on a large scene: `intersectsSphere` over 1 000
objects costs microseconds (see [../benchmarks/README.md](../../benchmarks/README.md)), while
triangle tests do not.

## `GPUPicking` — scale

Render each pickable object with a unique colour into an offscreen target, then read back one
pixel. Cost is independent of scene complexity, which is the only way to pick a scene of
instanced or shader-generated geometry.

```ts
import { GPUPicking } from '@dxyl/graphics';

const picking = new GPUPicking({ /* GPUPickingOptions */ });
picking.setRenderer(hostRenderer);   // must expose createRenderTarget/readPixels
picking.register(mesh);              // returns the assigned id
picking.setSize(width, height);

// Once per frame that needs a pick pass (needsPickPass caches the decision):
if (picking.needsPickPass(renderer.stats.frame)) {
  picking.renderPickPass(scene, camera, /* options */);
}

const result = picking.pick(screenX, screenY);
result?.object;
```

| Member | Purpose |
| --- | --- |
| `register(object, id?)` / `unregister(target)` | Id ↔ object mapping. |
| `getObject(id)` / `getId(object)` | The registry, both directions. |
| `encodeId(id)` / `decodeId(color)` | The colour-round-trip primitives. |
| `setRenderer(renderer)` | The host renderer that supplies targets and readback. |
| `setSize(width, height)` | Match the picking target to the viewport. |
| `renderPickPass(scene, camera, options)` | Draw the id buffer. |
| `needsPickPass(frame)` | Whether the cached pass is stale. |
| `pick(x, y)` / `pickAtPointer(x, y)` | Read one pixel and resolve it. |
| `pickFromColor(x, y, color)` | When the colour came from elsewhere. |
| `pickFromRegion(...)` | A rectangle — for a lasso or a rank of candidates. |
| `dispose()` | Release the target and registry. |

Ids are limited to 31 bits (`PICKING_ID_BUDGET`), which is what fits in an RGBA8 target with a
reserved value for "nothing". `assertIdWithinBudget(id, context)` fails loudly on an
out-of-range id rather than wrapping it into another object's value — a bug that would otherwise
present as "clicking picks the wrong thing, sometimes".

`PickingRenderTarget` is the lower-level piece: the registry, the id encode/decode, and
`readPixel`/`pick`/`toDevicePixels`. Use it directly when you want to own the render pass.

## `HitTest2D` — the 2D case

```ts
import { HitTest2D } from '@dxyl/graphics';

const hitTest = hitTest2D();
hitTest.contains(node2d, { x: 12, y: 30 }, { tolerance: 2, includeNonInteractive: false });
```

`Node2D.hitTest(point, options)` and `Node2D.containsPoint(point, tolerance, includeChildren)`
are the scene-graph conveniences over the same logic, and they walk the tree in **z order**, so
the topmost node wins — which is what a user expects from a click. `HitTestOptions` carries
`includeNonInteractive`, `tolerance` and `includeChildren`.

## `SpritePicker` — billboards

```ts
import { SpritePicker } from '@dxyl/graphics';

const sprites = spritePicker();
sprites.pick(raycaster, sprite3d);
sprites.pickNearest(raycaster, spriteList);
sprites.intersectRecursive(raycaster, root);
```

A `Sprite3D` is a camera-facing quad, so its geometry in world space depends on the camera; the
picker solves for the quad it presents rather than testing a stored mesh.

## The shared raycast contract

The scene graph declares its own `RaycasterLike` (`src/scene/3d/types.ts`) and `Raycaster`
implements it, so either layer drives the other:

```ts
interface RaycasterLike {
  readonly ray: { origin: Vec3; direction: Vec3 };
  readonly near?: number;
  readonly far?: number;
  readonly layers?: number;
  readonly params?: {
    Points?: { threshold?: number };
    Line?: { threshold?: number };
    backfaceCulling?: boolean;
  };
}
```

That is why `Mesh.raycast(raycaster, intersects)` accepts a `Raycaster` with no adapter, and why
`src/picking/raycastData.ts` exists: `readVertex`, `readUv`, `readIndices`, `readPositions`,
`intersectTriangle`, `forEachTriangle`, `raycastTriangles`, `raycastLine`, `raycastPoints` and
`toWorldPoint` are the shared primitives both layers use, so triangle-mesh picking has exactly
one implementation.

## Layer filtering

`Raycaster.layers` is a bitmask, and `Object3D.layers` is a number (bit 0 by default), so the
two are compared directly:

```ts
const UI_LAYER = 1 << 2;

raycaster.layers = ~UI_LAYER;   // pick everything except UI
mesh.layers = 1 | UI_LAYER;
```

`Raycaster.testLayers(object)` is public, so a custom traversal can use the same rule. Note that
`Node.layers` is a `Layers` **object** while `Object3D.layers` is a number — 2D hit testing and
3D raycasting use different representations.

## A minimal, complete example

```ts
import { PerspectiveCamera, Raycaster, Vec3 } from '@dxyl/graphics';

const camera = new PerspectiveCamera({ fov: 50, aspect: 16 / 9, near: 0.1, far: 100 });
camera.position.set(0, 2, 6);
camera.updateMatrixWorld(true);

const raycaster = new Raycaster();

canvas.addEventListener('pointermove', (event) => {
  const rect = canvas.getBoundingClientRect();
  raycaster.setFromCamera(Raycaster.ndcFromPointer(event.clientX, event.clientY, rect), camera);

  const hits = raycaster.intersectObjects(scene.children, true);
  const nearest = hits[0] ?? null;

  // Highlight, then report.
  for (const child of scene.children) child.userData.hovered = child === nearest?.object;
  badge.textContent = nearest === null
    ? 'no hit'
    : `${nearest.object.name} @ ${nearest.distance.toFixed(2)} units`;
});
```

Three things worth copying from it:

1. **`updateMatrixWorld(true)` before the first cast.** The raycaster uses `matrixWorld`, which
   is only valid after an update — a stale world matrix picks against where the object used to
   be.
2. **Reuse one `Raycaster`.** `set`/`setFromCamera` mutate it, so a per-event allocation buys
   nothing.
3. **`hits[0]` is already the nearest.** The results are sorted by distance ascending.

## See also

- [math-conventions.md](math-conventions.md) — `Ray`, `Plane`, `Box3`, `Sphere` and the sign
  conventions.
- [scene-graph.md](scene-graph.md) — layers, `matrixWorld` and `traverse`.
- [examples/picking](../../examples/picking/README.md) — 2D bounds testing alongside 3D ray
  picking.
