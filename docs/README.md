# `@dxyl/graphics` documentation

A dependency-free 2D/3D graphics library for TypeScript with pluggable backends, plus the
guides, architecture notes and reference material for working on it.

One library renders the same scene through **Canvas2D**, **SVG**, **WebGL** (1 and 2) or
**WebGPU** — chosen at runtime. Everything above the renderer is backend-agnostic: math,
geometry, scene graph, animation, picking, assets, text and effects never import a backend.

## Reading order

If you are new to the library, read in this order:

| # | Page | Why |
| --- | --- | --- |
| 1 | [guide/installation.md](guide/installation.md) | Get it resolving. |
| 2 | [guide/getting-started.md](guide/getting-started.md) | One scene, four backends. |
| 3 | [guide/math-conventions.md](guide/math-conventions.md) | **Read this before writing any maths.** Column-major, column vectors, right-handed. |
| 4 | [architecture/overview.md](architecture/overview.md) | The layer map and the dependency rule. |
| 5 | [guide/rendering-backends.md](guide/rendering-backends.md) | Which backend answers which question. |
| 6 | [guide/scene-graph.md](guide/scene-graph.md) | Nodes, transforms, traversal. |
| — | [guide/](guide/README.md) | Then whichever feature guide matches your task. |

If you are working **on** the library rather than with it, read
[architecture/layers.md](architecture/layers.md),
[architecture/renderer-interface.md](architecture/renderer-interface.md) and
[architecture/extending.md](architecture/extending.md) after the list above.

## What is here

| Directory | Contents |
| --- | --- |
| [`guide/`](guide/README.md) | Task-oriented guides. Every page has runnable, copy-pasteable code that matches the real API. |
| [`architecture/`](architecture/README.md) | Why the library is shaped the way it is: layers, the renderer interface, resource lifetimes, events, and how to extend each seam. |
| [`examples/`](examples/README.md) | One short page per runnable example in `examples/`, describing what it demonstrates and what to look for. |
| [`api/`](api/README.md) | The generated Typedoc reference. **Generated, not hand-written.** |

The runnable examples themselves live in [`../examples/`](../examples/README.md), and the
benchmarks in [`../benchmarks/`](../benchmarks/README.md).

## Building the API reference

The `api/` directory is produced by two scripts and must not be edited by hand:

```bash
pnpm docs   # Typedoc -> docs/api/
pnpm api    # API Extractor -> the .api.md report
```

`pnpm docs` reads `typedoc.json`; `pnpm api` runs `scripts/run-api-extractor.mjs` against
`api-extractor.json`. Both require a type-clean program, so run `pnpm typecheck` first — a
syntax error makes Typedoc emit an incomplete site without necessarily failing.

The `.github/workflows/docs.yml` workflow does exactly this and deploys the result to GitHub
Pages.

## The design rules, in brief

These are the constraints every page below assumes:

1. **No runtime dependencies.** Nothing in `src/` imports an npm package.
2. **Column-major matrices, column vectors.** `v' = M * v`; right-handed rotations
   (`Mat4.makeRotationZ(Math.PI / 2)` maps `+X` to `+Y`). Every matrix uploads to
   WebGL/WGSL verbatim.
3. **Allocation-light hot paths.** Mutators return `this`; read methods take an optional
   `target`; `Pool` recycles per-frame objects.
4. **Explicit lifetimes.** Anything holding GPU or DOM resources extends `Disposable`, and
   children are released through `addDisposable`.
5. **Events are opt-in.** `EventEmitter`/`EventDispatcher` share one documented event map
   (`CoreEventMap`), so `emit(name, ...args)` stays fully typed.
6. **Nothing below `renderer` imports a backend.** The layer above owns the backend choice;
   the layers below consume renderers through structural interfaces.

Rule 6 is the one that keeps the library honest, and the one a well-meaning change is most
likely to break. See [architecture/layers.md](architecture/layers.md).

## Status of this checkout

All layers have now landed. Two caveats remain, and both are stated where they matter rather than
worked around:

| Layer | State |
| --- | --- |
| `math`, `core`, `utils` | Complete |
| `geometry/core`, `geometry/2d`, `geometry/3d` | Complete |
| `scene/2d`, `scene/3d` | Complete |
| `materials`, `textures`, `shaders` | Complete |
| `renderer` (interfaces, core, Canvas2D, SVG) | Complete |
| `renderer/webgl` | Complete, but **not re-exported** from the renderer barrel — import it from its own module |
| `animation`, `controls`, `picking`, `assets`, `text`, `effects` | Complete |
| `wasm` | Present; the modules load lazily and degrade when WebAssembly is unavailable |
| `renderer/webgpu` | Present, but **unproven** — probe with `detectBackendStrict('webgpu')` before relying on it |

Two cross-cutting notes a reader should have:

- **`src/index.ts` resolves its cross-layer name collisions explicitly.** Several names legitimately
  exist in more than one layer (each layer declares its own structural view such as `MaterialLike`
  or `GeometryLike` rather than importing another's), and a bare `export *` would silently drop the
  shadowed one. The root barrel now lists every colliding name with the layer that owns it, so
  `import { MaterialLike } from '@dxyl/graphics'` works. `PixelFormat` is the one name that is *not*
  a duplicate of the same concept — the texture-layer enum describes pixel data layout and the
  renderer one describes a GPU internal format — so the GPU enum is exported as `GPUPixelFormat`.
  See [architecture/extending.md](architecture/extending.md#a-warning-about-name-collisions).
- **`camera.viewMatrix` exists.** `Camera3D` exposes it as an alias of its `matrixWorldInverse`, so
  a `PerspectiveCamera` satisfies the renderer contract directly and the 3D branches of
  `Canvas2DRenderer` and `WebGLRenderer` take the 3D path. See
  [guide/rendering-backends.md](guide/rendering-backends.md#webgl-specifics).

Where a guide documents a module whose API is still moving, the page carries a clearly-labelled
note and documents the **verified subset** rather than inventing a signature.
