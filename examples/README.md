# Examples

Twelve runnable, self-contained demonstrations of `@dxyl/graphics`, one per feature area.

Every example is a standalone Vite project: `index.html` + `main.ts` + this `README.md`.
Each `main.ts` imports the library through a **relative** path (`../../src/index`), so
nothing needs to be built and no `dist/` directory is required. There are no shared
helper modules between examples, no CDN scripts, and no npm packages beyond `vite` and
the library itself.

## Running an example

From the repository root:

```bash
pnpm exec vite examples/2d-basic
```

Vite treats `examples/<name>/` as the project root. The `../../src/index` import resolves
to the library source, so edits to `src/` are picked up live. Substitute any directory
name from the table below.

## Index

| Example | Backend required | Library feature demonstrated |
| --- | --- | --- |
| [`2d-basic/`](2d-basic/README.md) | Canvas2D | Runtime backend selection; the structural scene contract (`{ children }` + `render(painter)`); world-space camera semantics; `delta`-driven motion. |
| [`3d-basic/`](3d-basic/README.md) | Canvas2D (software-rasterised) | 3D scene graph (`Scene3D`/`Object3D`/`Mesh`/`PerspectiveCamera`), hand-built `BufferGeometry`, column-vector matrix composition, frustum culling via `BoundingVolume` + `Frustum`, painter's algorithm. |
| [`canvas2d/`](canvas2d/README.md) | Canvas2D | `Canvas2DPainter` on its own: the save/restore state stack, paths, `roundRect`, `setLineDash`, `clip`, gradients, shadows, measured text. |
| [`svg/`](svg/README.md) | SVG | `SVGRenderer`: live DOM output, `viewBox` sizing, per-renderable `<g>` groups, the path-only `SVGPainter` API, `toSVGString()`. |
| [`webgl/`](webgl/README.md) | WebGL2 or WebGL | `WebGLRenderer`: GLSL materials through a structural interface, automatic uniforms, context-loss recovery, `renderInfo` resource accounting. |
| [`webgpu/`](webgpu/README.md) | WebGPU (detection only) | Capability probing with `detectBackendStrict`/`getSupportedBackendNames`, `navigator.gpu` adapter probing, graceful Canvas2D fallback. |
| [`animation/`](animation/README.md) | Canvas2D | `Clock` and `Timer` for time, hand-written keyframe interpolation, two easing curves, `ManualClock` for deterministic checks. |
| [`controls/`](controls/README.md) | Canvas2D | Pan/zoom/rotate input written inline: pointer capture, non-passive wheel, zoom about the cursor, rotation-aware panning. |
| [`picking/`](picking/README.md) | Canvas2D | Hit testing with `Box2.containsPoint`/`Vec2.distanceTo`, plus 3D ray construction and `Ray.intersectTriangle`. |
| [`text/`](text/README.md) | Canvas2D | `measureText`-driven word wrap, `textAlign`/`textBaseline` semantics, `fillText` with `maxWidth`, `strokeText` layering. |
| [`effects/`](effects/README.md) | Canvas2D | Eight `globalCompositeOperation` modes, `shadowBlur` glows, gradients, `clip()` masking, and an offscreen canvas as a CPU render target. |
| [`assets/`](assets/README.md) | Canvas2D | A concurrent, cached, retrying loader: in-flight de-duplication, an LRU `Map` cache, exponential backoff, and a deliberate 404 failure path. |

## Which backends exist today

| Backend | Module | Status in this checkout |
| --- | --- | --- |
| Canvas2D | `src/renderer/canvas2d/` | Complete; drives ten of the twelve examples. |
| SVG | `src/renderer/svg/` | Complete. |
| WebGL | `src/renderer/webgl/` | Complete; imported from its own module, not the root barrel. |
| WebGPU | `src/renderer/webgpu/` | **Empty directory.** No renderer exists; `webgpu/` demonstrates detection only. |

## Features that are documented as absent

Several examples would normally lean on a layer that is still being written. In each
case the example says so explicitly, demonstrates what *does* exist, and implements the
missing piece inline rather than inventing an API:

| Layer | Status | What the example does instead |
| --- | --- | --- |
| `src/materials/` | Empty | Materials are plain structural objects (`{ vertexShader, fragmentShader, uniforms }`, `{ transparent, opacity }`). |
| `src/geometry/3d/` | Placeholder `index.ts` only | `3d-basic/` and `webgl/` build `BufferGeometry` by hand with `BufferAttribute`. |
| `src/picking/` | Types + raycast helpers, no `Raycaster` | `picking/` uses `Box2`, `Vec2` and `Ray.intersectTriangle` directly. |
| `src/controls/` | Empty | `controls/` and `3d-basic/` write pointer and wheel handling inline. |
| `src/text/` | Empty | `text/` uses `Canvas2DPainter.measureText`/`fillText`/`strokeText` and the `Text2D` scene node. |
| `src/effects/` | Empty | `effects/` uses Canvas2D compositing plus an offscreen canvas, because `createRenderTarget()` throws on this backend. |
| `src/assets/` | Empty | `assets/` implements the queue/cache/retry shape the `src/constants.ts` values anticipate. |
| `src/textures/` | Empty | No example loads a GPU texture; `assets/` decodes images for CPU drawing only. |
| `src/renderer/webgpu/` | Empty | `webgpu/` reports the probe result and renders the Canvas2D fallback. |

## Conventions every example follows

- **Feature detection before use.** `detectBackendStrict(...)`, `getSupportedBackendNames()`,
  `renderer.isLive`, `renderer.isHeadless` or a `try`/`catch`, followed by a **visible
  on-page message** — never an exception into a blank page.
- **An overlay** showing FPS and the active backend, updated at most a few times a second.
- **A `dispose()`** that stops the loop, disposes the renderer and removes every listener,
  wired to `window.addEventListener('beforeunload', dispose)` and safe to call twice.
- **No `console.log` noise** in the steady state. Diagnostics go to the overlay.
- **No cross-example imports.** Each `main.ts` is complete on its own.
