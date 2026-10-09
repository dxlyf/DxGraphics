# Overview

The mental model: one scene description, several backends, and a strict direction of dependency.

## The one-paragraph version

The library describes a scene — nodes, transforms, geometry, materials — in a way that mentions
no rendering API. A **backend** is chosen at runtime and asked to draw that description. The
backend owns everything platform-specific (a canvas context, a DOM tree, GL state); everything
above it owns the scene and is written against structural interfaces rather than classes. That is
what lets the same `Scene3D` render through Canvas2D, SVG, WebGL or WebGPU with no branching in
application code.

## The pieces

```
                      ┌─────────────────────┐
   chosen at runtime  │  detectBackend(…)   │
                      └──────────┬──────────┘
                                 ▼
   application ────────►  renderer.render(scene, camera)
                                 │
        ┌────────────┬───────────┼───────────┬────────────┐
        ▼            ▼           ▼           ▼            ▼
   Canvas2D       SVG        WebGL       WebGPU      (your own)
        │            │           │           │
        └────────────┴───────────┴───────────┘
                     │
                     ▼
        a painter per renderable: render(painter)
```

| Piece | Responsibility | Does not do |
| --- | --- | --- |
| `math` | Vectors, matrices, quaternions, colours, primitives, intersections | Know that rendering exists |
| `core` | `Node`, `Scene`, `Camera`, events, lifecycle, clock, pools | Know about a backend |
| `geometry` | `BufferGeometry`, attributes, 2D curves/paths/shapes, 3D primitives | Know about a material |
| `materials` / `textures` / `shaders` | Shading description and the GPU resources behind it | Know about a scene |
| `scene` | 2D and 3D graph nodes, meshes, cameras, lights | Know about a renderer |
| `renderer` | Backend contracts, the shared implementation, and the four backends | Know about the scene graph |
| `animation` / `controls` / `picking` / `assets` / `text` / `effects` | Feature layers that address objects structurally | Import `scene` or a backend |

## How a frame flows

1. **The application updates.** `clock.getDelta()`, then game or animation logic. Time is
   **seconds**.
2. **`scene.updateMatrixWorld()`** recomposes local matrices from TRS and multiplies them into
   world matrices — `world = parentWorld * local`.
3. **`camera.updateMatrixWorld()`** refreshes the view matrix (`matrixWorldInverse`), the
   view-projection product, and the `Frustum`.
4. **`renderer.render(scene, camera)`**:
   - collects renderables — `collectRenderables(list, camera)`, else `scene.children`, else the
     scene itself;
   - pushes each into a `RenderList`, which buckets them as **ordered**, **opaque** or
     **transparent**;
   - sorts with a `RenderQueue`: `renderOrder`, then `materialId`, then depth, then submission
     sequence;
   - walks the produced order and calls `render(painter)` on each, or issues a draw call on a GPU
     backend;
   - counts `drawCalls`, `triangles`, `objects`, `culled` and `stateChanges` into `renderer.stats`.
5. **The backend paints.** Canvas2D issues context calls; SVG creates or updates DOM nodes; WebGL
   compiles a program and issues `drawElements`.

Culling happens **before** step 4 in practice: a scene that frustum-tests its children submits
only the survivors. `renderer.stats.culled` is how you confirm it is happening.

## The three contracts that make it work

Everything in the library is an instance of one of three shapes, and knowing which you are dealing
with is most of the mental model.

### A renderable

```ts
interface Renderable2D {
  readonly visible: boolean;
  render(painter: unknown): void;
  readonly material?: MaterialLike | null;
  readonly renderOrder?: number;
  readonly depth?: number;
}
```

Anything with `visible` and `render(painter)`. **No base class**, so a plain object works and the
painter is the backend's own surface.

### A scene

```ts
interface SceneLike {
  readonly visible?: boolean;
  collectRenderables?(list: unknown, camera: unknown): void;
  readonly children?: readonly unknown[];
  readonly background?: unknown;
}
```

The renderer asks for `collectRenderables` first, then `children`, then the object itself. A scene
graph owns its own traversal; a plain `{ children: [...] }` is a valid scene.

### A camera

```ts
interface CameraLike {
  readonly viewMatrix?: { elements: ArrayLike<number> } | null;
  readonly projectionMatrix?: { elements: ArrayLike<number> } | null;
  readonly isOrthographic?: boolean;
  readonly position?: { x: number; y: number; z?: number };
  readonly zoom?: number;
  readonly rotation?: number;
}
```

The 3D branch uses `viewMatrix` + `projectionMatrix`; the 2D branch uses `position` + `zoom` +
`rotation`. Because it is structural, a plain object is a camera — which is how the examples
implement pan/zoom in a few lines.

> **Note:** `Camera3D` exposes `viewMatrix` as an alias of its `matrixWorldInverse`, so the scene
> layer's cameras satisfy this contract directly and a `PerspectiveCamera` takes the 3D branch. The
> structural shape still means a plain object is a camera too, which is how the examples implement
> pan/zoom in a few lines. See
> [../guide/rendering-backends.md](../guide/rendering-backends.md#webgl-specifics).

## Why structural contracts rather than a base class

Three reasons, in order of how much they matter:

1. **The layer rule.** The renderer cannot import `Mesh`, so it cannot require `Mesh`. A
   structural interface is the only way to accept one. See [layers.md](layers.md).
2. **A description that is accurate.** `Renderable2D` says exactly what the renderer reads — five
   members. A base class would say "be one of ours", which is both more restrictive and less
   informative.
3. **Composability.** A renderable can be a plain object, a scene node, a procedural generator, or
   a closure-based wrapper. The examples use all four, and none of them needed a class hierarchy.

The cost is that a typo in a member name is a runtime no-op rather than a compile error. That is
the real trade, and it is why the renderer's traversal checks rather than trusts: `pushRenderable`
verifies `typeof object.render === 'function'` and skips anything that fails, instead of
assuming.

## The capability model

Backends differ, and the library reports the difference rather than hiding it:

```ts
renderer.backend;                 // 'canvas2d' | 'svg' | 'webgl' | 'webgl2' | 'webgpu'
renderer.info.capabilities;       // e.g. ['immediate-mode', 'clipping', 'gradients', 'shadows']
renderer.isHeadless;              // true when no drawing surface could be bound
```

Some differences are in the type system: `Canvas2DRenderer.createRenderTarget` **throws**, and so
does `SVGRenderer`'s, because neither has a second surface to draw into. A backend that cannot do
something says so at the call site rather than silently returning nothing.

## Where to go next

| Question | Page |
| --- | --- |
| Which layer may import which? | [layers.md](layers.md) |
| How exactly does one frame flow, and why is `IRenderer` shaped that way? | [renderer-interface.md](renderer-interface.md) |
| Why two scene graphs and two camera families? | [scene-2d-3d.md](scene-2d-3d.md) |
| Who releases what, and when? | [resource-lifetimes.md](resource-lifetimes.md) |
| How do events work? | [events.md](events.md) |
| How do I add a backend, a material, a generator or a loader? | [extending.md](extending.md) |
