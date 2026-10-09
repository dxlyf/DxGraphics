# Layers

The dependency rule, why it exists, and the mechanisms that keep it true.

## The rule

**Dependencies point downward only. Nothing below `renderer` imports a backend.**

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │ L6  application-facing                                               │
  │     scene (2d, 3d) · animation · controls · picking · assets ·       │
  │     text · effects                                                   │
  ├──────────────────────────────────────────────────────────────────────┤
  │ L5  renderer                                                         │
  │     interfaces · core · canvas2d · svg                               │
  │     webgl · webgpu  — separate entry points, same band               │
  ├──────────────────────────────────────────────────────────────────────┤
  │ L4  data                                                             │
  │     geometry (core, 2d, 3d) · materials · textures · shaders         │
  ├──────────────────────────────────────────────────────────────────────┤
  │ L3  core abstractions                                                │
  │     Node · Scene · Camera · EventEmitter · Disposable · Clock · Pool │
  ├──────────────────────────────────────────────────────────────────────┤
  │ L2  math                                                             │
  │     Vec2/3/4 · Mat2/3/4 · Quat · Euler · Color · Frustum · Ray · …   │
  ├──────────────────────────────────────────────────────────────────────┤
  │ L1  foundation                                                       │
  │     utils · constants · types                                        │
  └──────────────────────────────────────────────────────────────────────┘
```

Two arrows are the ones that matter, because they are the ones a well-meaning change breaks:

- **L5 must not import L6.** The renderer may not import `src/scene`, `src/materials`,
  `src/textures` or `src/shaders`. It consumes them through structural interfaces.
- **L6 must not import L5.** The scene graph may not import `src/renderer`. It declares its own
  interfaces for the few renderer-shaped things it needs.

## Why the rule exists

A browser bundle should not pay for a backend it does not use. If `src/scene` imported
`src/renderer`, then importing `Mesh` would pull in `Canvas2DRenderer`, `SVGRenderer`,
`WebGLRenderer` and the whole shader library — and tree-shaking cannot always remove them,
because the import graph is what it is.

The second reason is testability. `tests/integration/` runs with **no GPU and no DOM**, which is
only possible because the scene graph, geometry and math layers compile without a renderer. A
single import in the wrong direction would make the fast test job impossible.

The third reason is that it forces the interfaces to be honest. `Renderable2D`,
`MaterialLike`, `GeometryLike`, `CameraLike` and `SceneLike` all exist because the renderer
cannot import the classes — and a structural interface is a more accurate description of what the
renderer actually needs than the concrete class would be.

## How the rule is implemented

The mechanism is **structural interfaces declared in the consuming layer**, with a comment naming
the file that provides the real class.

| Declared in | Interface | Satisfied by |
| --- | --- | --- |
| `src/renderer/core/RenderList.ts` | `Renderable2D` | Any object with `visible` + `render(painter)` |
| `src/renderer/interfaces/types.ts` | `MaterialLike`, `GeometryLike`, `AttributeLike`, `TextureLike` | `src/materials`, `src/geometry`, `src/textures` |
| `src/renderer/interfaces/IRenderer.ts` | `SceneLike`, `CameraLike` | `src/scene`, `src/core` |
| `src/scene/3d/types.ts` | `GeometryLike`, `MaterialLike`, `RaycasterLike`, `Object3DLike` | `src/geometry`, `src/materials`, `src/picking` |
| `src/scene/2d/types.ts` | `Painter2D`, `Material2DLike`, `Texture2DLike` | `src/renderer`, `src/materials`, `src/textures` |
| `src/picking/types.ts` | its own `GeometryLike`, `Object3DLike`, `CameraLike`, `RaycasterLike` | `src/geometry`, `src/scene`, `src/core` |
| `src/core/BoundingVolume.ts` | `BoundsSource` | `src/geometry/core/BufferGeometry` |

The duplication across `renderer`, `scene` and `picking` is **deliberate**. Three independent
declarations of "something with a `position` attribute" is the price of three independently
compilable layers, and the alternative — one shared type module — would be a fourth layer every
other layer depends on.

A concrete demonstration of the payoff: `picking.Raycaster` implements
`scene.3d.types.RaycasterLike`, so `Mesh.raycast(raycaster, intersects)` accepts it with no
adapter, **and neither module imports the other**.

## What to do when the rule gets in the way

| Situation | Correct move |
| --- | --- |
| The renderer needs a field from a material | Add it to the renderer's `MaterialLike` as optional, with a comment. |
| The scene graph needs to know about a renderer class | Declare the structural subset in `src/scene/*/types.ts`. |
| Two layers need the same vocabulary type | Declare it in both, or move it down to `src/types/index.ts` if it is genuinely foundation-level. |
| A helper genuinely belongs in both | Move it down a band. If it needs a backend, it belongs in `renderer`. |
| You are tempted to add an import plus a `// TODO` | Do not. Move the code or declare the interface. |

`src/types/index.ts` is the escape hatch for genuine foundation-level vocabulary:
`Vector2Like`, `Vector3Like`, `ColorLike`, `TypedArray`, `IDisposable`, `DeepPartial`. If a type
is needed by three layers and depends on nothing, that is where it goes.

## Deviation: geometry

`src/geometry/core/BufferGeometry.ts` imports `src/core/Disposable` and `src/math/*`, which is
downward and therefore fine — but it also satisfies `src/core/BoundingVolume.ts`'s `BoundsSource`
**without either importing the other**. `BoundingVolume` declares the interface, `BufferGeometry`
happens to satisfy it, and a `Scene.computeBounds()` call connects them at runtime.

That is the rule working as intended: the connection exists in the type system, not in the import
graph.

## Deviation: the GPU backends

`src/renderer/webgl/` and `src/renderer/webgpu/` are in the same band as `renderer/core`, but
they are **not re-exported** from `src/renderer/index.ts`:

```
`webgl/` and `webgpu/` are owned by a separate layer and are intentionally not
re-exported here; import them directly from their own entry points.
```

The reason is bundle size in the other direction: most applications want exactly one GPU backend,
and a barrel that re-exports both makes it easy to pull in the one you did not choose.
`WebGLRenderer` is imported from its own module, and the same will apply to `WebGPURenderer`.

## Tooling conventions

Two conventions exist because of how the tools are run rather than because of the layering, and
both are deliberate:

1. **`scripts/**` and `tools/**` import with explicit `.ts` extensions**
   (`import { log } from './_shared.ts'`). Node's ESM loader does not resolve extensions, and these
   run through `node --experimental-strip-types` with no build step. The root `tsconfig.json`
   reports `TS5097` for these imports because `allowImportingTsExtensions` is not enabled. The
   errors are known and accepted; the alternative is a build step for the tools, which defeats
   their purpose.
2. **`tests/` and `benchmarks/` import extensionless** (`'../../src/math/Vec3'`), because they run
   through Vite, which resolves extensions. Keeping the two styles separate makes it obvious at a
   glance whether a file is executed by Node directly or by Vite.

## Verifying the rule

There is no lint rule enforcing it yet. To check by hand:

```bash
# Does anything below renderer import a backend?
rg "from '.*renderer" src/geometry src/materials src/textures src/shaders src/scene src/core src/math src/utils src/animation src/picking src/assets src/text

# Does the renderer import a layer above it?
rg "from '\.\./\.\./(scene|materials|textures|shaders|geometry)/(?!interfaces)" src/renderer
```

Both should report nothing beyond the structural-interface comments. Adding a lint rule for this
is a good first contribution — see [extending.md](extending.md).
