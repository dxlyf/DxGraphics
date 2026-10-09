# Guide

Task-oriented documentation. Every page has runnable, copy-pasteable code that matches the real
API, and every page states what it covers and what it does not.

## Start here

| Page | Covers |
| --- | --- |
| [installation.md](installation.md) | Installing from npm, running from source, TypeScript config, common problems. |
| [getting-started.md](getting-started.md) | One scene, four backends, and the smallest program that renders. |
| [**math-conventions.md**](math-conventions.md) | **Read this before writing any maths.** Column-major, column vectors, right-handed, `Vec`/`Color`/`Euler` semantics. |

## Core concepts

| Page | Covers |
| --- | --- |
| [rendering-backends.md](rendering-backends.md) | The four backends, capability probing, graceful degradation, sorting, statistics. |
| [scene-graph.md](scene-graph.md) | `Node` vs `Object3D`, transforms, traversal, `attach`, lookAt, bounds, events. |
| [performance.md](performance.md) | The frame budget, the five regressions that matter, measured hot spots. |

## Features

| Page | Covers | Module state |
| --- | --- | --- |
| [geometry.md](geometry.md) | `BufferGeometry`, attributes, normals, bounds, the 2D curve/path/shape layer. | complete |
| [materials-and-textures.md](materials-and-textures.md) | The structural material contracts and what each backend reads. | landed |
| [shaders.md](shaders.md) | `ShaderLib`, `ShaderCompiler`, descriptors, chunks, uniform conventions. | landed |
| [animation.md](animation.md) | Clips and mixers, tweens and timelines, easing, time-keeping. | landed |
| [controls.md](controls.md) | Orbit/map/trackball/fly/first-person, pointer/touch/gesture, writing your own. | landed |
| [picking.md](picking.md) | Six picking strategies, `ndcFromPointer`, layer filtering. | landed |
| [assets.md](assets.md) | Loaders, the LRU cache, `LoaderManager` concurrency and retries, cancellation. | landed |
| [text.md](text.md) | Fonts, glyph atlases, layout, SDF text, the platform painter path. | landed |
| [effects.md](effects.md) | The composer and its passes, shadow maps, fog, particles. | landed |

## Working on the library

| Page | Covers |
| --- | --- |
| [testing.md](testing.md) | Suite layout, commands, writing unit and integration tests, determinism. |
| [contributing.md](contributing.md) | The six design rules, the layer rule, style, review expectations. |
| [migration-from-three.md](migration-from-three.md) | The differences that break a port, and a checklist. |

## Where each page's claims come from

Every API name, constructor shape, default and convention in these pages was read out of `src/`.
Where a module is incomplete, the page documents the **verified subset** and carries a
clearly-labelled note rather than inventing a signature. The module-state column above is the
current summary; the authoritative version is the table at the end of
[../README.md](../README.md).

Two conventions worth knowing before you read any code sample:

- **Imports** are shown from the package root (`'@dxyl/graphics'`). When running from source in
  this repository, use the relative form the examples use (`'../../src/index'`). The two
  exceptions are `WebGLRenderer` and `WebGPURenderer`, which are **not** on the root export — see
  [rendering-backends.md](rendering-backends.md#webgl-specifics).
- **Time is in seconds.** The renderer's animation-loop callback receives `deltaSeconds`, `Clock`
  returns seconds, and every animation API takes seconds. Milliseconds appear only where a name
  says so (`getDeltaMilliseconds`, `frameTime`).
