# WebGL backend

Real GPU draws from GLSL sources written in the example, driven through the library's structural material interface.

## What it shows

- **The same `AbstractRenderer` contract.** `WebGLRenderer` provides sizing, pixel ratio, the animation loop, statistics and disposal exactly like Canvas2D/SVG, and adds context acquisition (WebGL2 first, then WebGL1), a redundant-state-change eliminator, VAO/program caches and context-loss/restore wiring.
- **A structural draw path.** A renderable is any object with a `geometry` and an optional `material`. The material layer ships its own classes, but the backend reads only the structural shape `{ vertexShader, fragmentShader, uniforms, defines, textures, depthTest, depthWrite, topology, side }` — so any material-like object works, and nothing in `src/renderer` imports `src/materials`.
- **The built-in fallback program.** Supplying no shader at all makes the renderer use its own `DEFAULT_VERTEX_SHADER`/`DEFAULT_FRAGMENT_SHADER` (GLSL ES 1.00, so the same text links on both WebGL generations). This example supplies its own so the lighting is visible.
- **A camera adapter, and why it is needed.** `uploadAutomaticUniforms` looks for `camera.viewMatrix` and `camera.projectionMatrix`. The library's camera classes expose `matrixWorldInverse`, not `viewMatrix`, so without an adapter `projectionMatrix` would upload while `modelViewMatrix` silently fell back to the model matrix alone. `BackendCamera` presents both names without copying either matrix. This is a genuine, load-bearing detail rather than ceremony.
- **Live introspection.** `renderer.info` gives vendor, renderer string, capability list and texture limits; `renderer.renderInfo` gives `render.calls`/`triangles`/`lines`/`points` and `memory.geometries`/`textures`/`programs`; `renderer.contextGeneration` increments on every loss and restore, so a driver reset is observable.
- **Graceful degradation.** `detectBackendStrict` runs first, the `isHeadless` case is handled separately, and no path throws into a blank page.

## What to look for

- A smooth-shaded cube spinning on two axes, drawn with per-face normals and a two-sided Lambert plus a Blinn-style specular highlight — all computed in the fragment shader in this file.
- The overlay lists the live vendor and renderer strings, the context generation, whether the context is currently usable, the draw call and triangle counts, the linked-program count, and the adapter's maximum texture size.
- **Context loss is testable.** In DevTools, use `WEBGL_lose_context.loseContext()`. The overlay switches to `LOST` and rendering resumes automatically when the context is restored, because the renderer wires `onLost`/`onRestored` itself.
- Resize the window: the viewport follows through `onSizeChanged`.
- If WebGL is unavailable, the page explains why instead of showing a blank canvas.

## Key API

| Call | Purpose |
| --- | --- |
| `new WebGLRenderer({ canvas, preferWebGL2, autoResize })` | Imported from `../../src/renderer/webgl/WebGLRenderer`; the root barrel does not re-export GPU backends. |
| `renderer.info` | Vendor, renderer, capabilities, limits. |
| `renderer.renderInfo` | `render.*` counters and `memory.*` resource totals. |
| `renderer.isContextUsable` / `contextGeneration` | Context-loss state. |
| `material.{ vertexShader, fragmentShader, uniforms }` | The structural material contract. |
| `camera.viewMatrix` | Required by `uploadAutomaticUniforms`; exposed here via an adapter. |

## Why the import path is deep

`src/renderer/index.ts` documents that `webgl/` and `webgpu/` are owned by a separate
layer and are intentionally **not** re-exported from the renderer barrel. Import
`WebGLRenderer` from its own module.

## How to run it

From the repository root:

```bash
pnpm exec vite examples/webgl
```

Vite uses `examples/webgl/` as the project root, and the `../../src/...` imports in
`main.ts` resolve to the library source, so there is no build step and no `dist/`
requirement. The dev server prints the URL it is listening on.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Complete page: canvas, overlay, styles. |
| `main.ts` | The demonstration. |
| `README.md` | This file. |
