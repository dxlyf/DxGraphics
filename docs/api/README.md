# API reference — generated

This directory holds the **generated** API reference. It is produced by two commands and must not
be edited by hand.

```bash
pnpm docs   # Typedoc  -> docs/api/
pnpm api    # API Extractor -> the .api.md report
```

## Why nothing here is committed by hand

The reference is derived from the JSDoc comments in `src/`. A hand-edited page would drift from the
source within one commit, and a reader would have no way to tell which of the two was current.
Anything you want to change in the reference, change in the source comment and regenerate.

## Building it

`pnpm docs` reads `typedoc.json` and writes HTML into `docs/api/`. It requires a type-clean
program: a syntax error anywhere in `src/` can make Typedoc emit an **incomplete site without
failing**, which is why the docs workflow runs `pnpm typecheck` first.

`.github/workflows/docs.yml` does exactly this and deploys the result to GitHub Pages, with a guard
that fails the build if `docs/api` comes out empty — an empty site is a configuration error, not a
successful build.

`pnpm api` runs `scripts/run-api-extractor.mjs` against `api-extractor.json`, which produces the
`.api.md` report used to review whether a change alters the public surface. That report is what
makes an accidental breaking change visible in a pull request rather than at release time.

## Reading order

If you are looking for something specific:

| You want | Go to |
| --- | --- |
| How to do a task | [`../guide/`](../guide/README.md) |
| Why the library is shaped this way | [`../architecture/`](../architecture/README.md) |
| A member's exact signature and defaults | this directory, after running `pnpm docs` |
| Which members are on the public surface | the API Extractor report from `pnpm api` |

The guide and architecture pages are the right entry point for almost every question. The generated
reference answers "what are the arguments to this method" and nothing wider, because that is all a
generator can know.

## What is in the public surface

`src/index.ts` re-exports eighteen layers:

| Layer | Contents |
| --- | --- |
| `constants` | Every shared numeric literal, and `BackendNames` |
| `types` | Foundation-level vocabulary: `Vector2Like`, `TypedArray`, `IDisposable`, … |
| `utils` | Math, array, object, path, DOM, browser and logging helpers |
| `math` | Vectors, matrices, quaternions, colours, primitives, intersections |
| `core` | `Node`, `Scene`, `Camera`, events, lifecycle, timing, bounds |
| `geometry` | Buffer geometry, 2D curves/paths/shapes, 3D primitives, modifiers |
| `materials` | Material classes and render state |
| `textures` | Texture types, samplers and formats |
| `shaders` | Descriptors, chunks, the compile cache, `ShaderLib` |
| `scene` | 2D and 3D graph nodes, meshes, cameras, lights |
| `renderer` | Backend contracts, the shared implementation, Canvas2D and SVG |
| `animation` | Clips, mixers, keyframe tracks, tweens, timelines, easing |
| `controls` | Camera, pointer and gesture controls |
| `picking` | Raycasting, 2D hit testing and GPU picking |
| `assets` | Loaders, cache and the scheduler |
| `text` | Fonts, glyph atlases, layout and SDF text |
| `effects` | Post-processing passes, shadows, fog and particles — **an empty module** |
| `wasm` | Optional WebAssembly acceleration modules |

Plus `DXYL`, a namespace object containing every module. It exists for browser consoles and
prototyping; prefer named imports in application code, because the namespace object references every
module eagerly and therefore defeats tree-shaking.

## Two exceptions worth knowing

- **`WebGLRenderer` and `WebGPURenderer` are not on the root export.** `src/renderer/index.ts`
  documents that the GPU backends are owned by a separate layer and are imported from their own
  modules, so that a bundle pulls in only the backend it chooses.
- **`src/effects/` is implemented but is not part of the `DXYL` namespace object.** It exports an
  effect composer with render, shader, bloom, blur, FXAA, SSAO and outline passes, shadow maps with
  cascades, linear and exponential fog, and a pooled particle system. See
  [`../guide/effects.md`](../guide/effects.md).
