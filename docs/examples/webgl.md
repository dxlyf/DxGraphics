# WebGL backend

Real GPU draws from GLSL written in the example, through the backend's structural material interface.

**Backend:** WebGL2 or WebGL

## What it shows

A material as a plain object — `{ vertexShader, fragmentShader, uniforms, depthTest, depthWrite }` — because there are no material classes to speak of in the shape this was written against.
`uploadAutomaticUniforms` supplying `projectionMatrix`/`modelViewMatrix`/`normalMatrix` automatically once the program declares them.
The **camera adapter** it requires: the backend reads `camera.viewMatrix`, while the library's cameras expose `matrixWorldInverse`. Without the adapter, `modelViewMatrix` silently degrades to the model matrix alone.
Live introspection through `renderer.info` (vendor, renderer, capabilities, limits) and `renderer.renderInfo` (`render.calls`, `memory.programs`, `memory.geometries`).
Context-loss recovery through `renderer.isContextUsable` and `contextGeneration`.

## What to look for

A smooth-shaded cube spinning on two axes, with per-face normals, a two-sided Lambert term and a Blinn-style specular highlight.

The overlay lists the live vendor and renderer strings, the adapter's maximum texture size, and the linked-program count. Run `WEBGL_lose_context.loseContext()` in the console: the overlay switches to `LOST` and rendering resumes on its own when the driver restores the context.

## Running it

From the repository root:

```bash
pnpm exec vite examples/webgl
```

Vite treats `examples/webgl/` as the project root, so the `../../src/index` imports resolve to
the library source with no build step. The full source is in
[`../../examples/webgl/`](../../../examples/webgl/README.md).