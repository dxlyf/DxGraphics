# Scene 2D and 3D

Why there are two scene graphs, two camera families, and three separate declarations of the same
structural interfaces.

## The split

| | `Node` — `src/core/Node.ts` | `Object3D` — `src/scene/3d/Object3D.ts` | `Node2D` — `src/scene/2d/Node2D.ts` |
| --- | --- | --- | --- |
| Layer | `core` (L3) | `scene/3d` (L6) | `scene/2d` (L6) |
| Transform | `Transform` (`position`, `rotation`, `quaternion`, `scale`) | the same four fields, directly | flat: `x`, `y`, `rotation`, `scaleX`, `scaleY`, `skew` |
| `layers` | a `Layers` object | a number bitmask | none — `zIndex` |
| `add` returns | the first added child | `this` | `this` |
| `getWorldDirection` | `−Z` | `+Z` | n/a |
| Events | tuples on the actor | objects on the node | objects on the node |
| Painter | n/a | n/a | `render(painter)` — currently a no-op |

Three graphs, not two. The `core` one is what the renderer and the backend-agnostic layers consume,
and the other two are the ergonomic, dimension-specific APIs built on top.

## Why `Node` exists separately from `Object3D`

`Object3D` would have been the obvious single graph. It is not, for one concrete reason: **the core
layer may not import `scene/3d`**, because `scene/3d` is above it in the layer order and imports
`core` itself. If `Node` were `Object3D`, the renderer would have to import `scene/3d` to talk about
a graph node — which is exactly the L5→L6 arrow [layers.md](layers.md) forbids.

So `core/Node.ts` is the minimal graph the renderer can name: identity, parenting, a `Transform`, a
`Layers` mask, visibility, lifecycle hooks, and traversal. `Object3D` adds the 3D conveniences
(`lookAt` conventions, `castShadow`/`receiveShadow`, a numeric `layers`, `up`).

## Why `Layers` and a numeric bitmask both exist

```ts
// core Node
node.layers.enable(Layer.Default);
node.layers.test(camera.layers);

// scene/3d Object3D
mesh.layers = 1 << 2;
```

The core `Layers` class carries behaviour the renderer wants: `enable`, `disable`, `toggle`,
`set`, `copy`, `test`, `count`, `highest`, `Layers.from(...)`, `Layers.bit(layer)`,
`Layers.intersects(a, b)`, and `warnIfExcessive`. It also has one `mask` field, so a structural
consumer can read it without a method call.

`Object3D` uses a plain number because that is what the GPU path and the picking path compare, and
because a bitmask is what an artist-facing `layers` property means in every engine. The conversion
between the two happens where it must — `Node.Layers.test(other: Layers)` takes the object, while
`Raycaster.layers` (a number) is compared against `Object3D.layers` (also a number) directly.

The cost is the asymmetry: `mesh.layers.enable(...)` is a type error. That is the good outcome, and
it is why the two were not quietly unified into one type.

## Why two camera families

`src/core/Camera.ts` and `src/scene/3d/Camera3D.ts` are independent hierarchies that both extend
their layer's node.

| | core `Camera` | scene `Camera3D` |
| --- | --- | --- |
| Extends | `Node` | `Object3D` |
| Projection | `projectionMatrix`, `projectionMatrixInverse`, `matrixWorldProjection` | `projectionMatrix`, `projectionMatrixInverse` |
| View matrix | `matrixWorldInverse` | `matrixWorldInverse` |
| Screen-space helpers | `worldToScreen`, `unprojectPoint`, `screenPointToRay`, `setViewportSize`, `projectPoint` | none |
| Concrete subclasses | none (instantiate and configure) | `PerspectiveCamera`, `OrthographicCamera`, `CubeCamera` |
| `type` | `'Camera3D' \| 'Camera2D'` | `'PerspectiveCamera'`, … |

The **core** camera is for the renderer and the backend-agnostic layers: it owns the projection
matrices and the screen-space conversions, which is what picking, controls and culling need. It has
no concrete subclasses, because it is configured by calling
`setPerspective(fovYRadians, near, far, aspect)` or `setOrthographic(l, r, t, b, n, f)`.

The **scene** camera is for application code: `PerspectiveCamera({ fov, aspect, near, far })`
computes its own projection from its own fields, and `PerspectiveCamera` adds `view` (a frustum
sub-rectangle for tiled rendering), `filmGauge` and `filmOffset`.

Two consequences worth being explicit about:

1. **`PerspectiveCamera` does not have `worldToScreen`.** A reader who expects it there will not
   find it. It is on the core `Camera`, in a different hierarchy and a different layer.
2. **`Camera3D` does not have `matrixWorldProjection`.** Only the core camera composes it, because
   only the core camera's `updateMatrixWorld` does:

   ```ts
   // src/core/Camera.ts
   this.matrixWorldInverse.copy(this.matrixWorld).invert();
   this.matrixWorldProjection.multiplyMatrices(this.projectionMatrix, this.matrixWorldInverse);
   this.frustum.setFromProjectionMatrix(this.matrixWorldProjection);
   ```

   A `PerspectiveCamera` refreshes `matrixWorldInverse` and leaves the frustum to `updateFrustum()`.

The duplication is the layer rule again: `core` may not import `scene/3d`, so a camera the renderer
can name has to live in `core`.

## Three declarations of the same contracts

`GeometryLike`, `MaterialLike`, `RaycasterLike` and friends are declared **three times**:

| File | Consumes it from |
| --- | --- |
| `src/renderer/interfaces/types.ts` | `geometry`, `materials`, `textures` |
| `src/scene/3d/types.ts` | `geometry`, `materials`, `picking` |
| `src/picking/types.ts` | `geometry`, `scene`, `core` |

That is deliberate, not an oversight. Each file's header says so:

> The renderer, geometry, material and picking layers are written by other agents in parallel with
> this one. Nothing here imports those modules: every cross-layer dependency is expressed as a
> **structural interface** … so the scene graph compiles on its own and stays assignable from the
> concrete classes once they land.

Three independently compilable layers, at the cost of three declarations. The alternative — one
shared `types` module every layer imports — would be a fourth layer that everything depends on,
and would reintroduce the coupling the interfaces exist to avoid.

The payoff is measurable: `picking.Raycaster` implements `scene.3d.types.RaycasterLike` with no
adapter and **neither module imports the other**, so `Mesh.raycast(raycaster, intersects)` accepts
a `Raycaster` directly.

## How the renderer consumes a 3D scene

It does not, really. `Scene3D` extends `Object3D`, which satisfies `SceneLike` through its
`children` array; `Mesh` satisfies `Renderable2D`-adjacent structural shapes through `geometry` and
`material`. The renderer walks `children` one level deep and submits anything that looks renderable:

```ts
protected collectRenderables(scene: SceneLike | null, camera: CameraLike | null): readonly WebGLRenderableLike[] {
  if (scene == null || scene.visible === false) return this.collected;

  const collector = (scene as { collectRenderables?: (target: unknown, cam: unknown) => void }).collectRenderables;
  if (typeof collector === 'function') { collector.call(scene, this.collected, camera); return this.collected; }

  const children = (scene as { children?: readonly unknown[] }).children;
  if (Array.isArray(children)) { for (const child of children) this.pushRenderable(child); return this.collected; }

  this.pushRenderable(scene);
  return this.collected;
}
```

Two things follow from "one level deep":

- **A scene that wants a deep traversal implements `collectRenderables`.** That is the designed
  extension point, and it is why the method exists on `SceneLike` at all.
- **The `Scene`/`Scene3D` classes do not implement it yet**, so today a renderer sees only the
  direct children of a scene. Nesting deeper requires either a `collectRenderables` implementation
  on the scene or a renderable wrapper — which is what `examples/3d-basic` does, by making its
  rasteriser a single renderable that walks the graph itself.

## Which graph should I use?

| Situation | Use |
| --- | --- |
| 3D content, cameras, lights, skinning | `Object3D` and `scene/3d` |
| 2D content with flat transforms, layers and `zIndex` | `Node2D` and `scene/2d` |
| The renderer's inputs, backend-agnostic tooling, a custom graph | `Node` from `core` |
| A graph the renderer should walk deeply | Any of them, plus `collectRenderables` |

Mixing is fine and expected: a `Scene3D` can be the root while a custom renderable paints 2D
overlays, because the renderer only ever sees the structural shape.

## See also

- [layers.md](layers.md) — the dependency rule that forces the duplication.
- [../guide/scene-graph.md](../guide/scene-graph.md) — the practical API for both graphs.
- [../guide/math-conventions.md](../guide/math-conventions.md) — the transform conventions both
  graphs follow.
