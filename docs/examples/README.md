# Examples, documented

One page per runnable example in [`../../examples/`](../../examples/README.md): what it
demonstrates, and what to look for.

Every example is a standalone Vite project — `index.html` + `main.ts` + `README.md` — importing
the library through a relative path (`../../src/index`), so nothing needs to be built.

```bash
pnpm exec vite examples/2d-basic
```

## Index

| Example | Backend required | Demonstrates | Look for |
| --- | --- | --- | --- |
| [2d-basic](2d-basic.md) | Canvas2D | Runtime backend selection, the structural scene contract, world-space camera semantics, `delta`-driven motion | Three squares that bounce and spin; the overlay's draw count |
| [3d-basic](3d-basic.md) | Canvas2D (software) | 3D graph + hand-built geometry, column-vector composition, frustum culling, painter's algorithm | A knot and an orbiting cube, correctly depth-sorted; `culled` rising as you zoom in |
| [canvas2d](canvas2d.md) | Canvas2D | `Canvas2DPainter` on its own: the state stack, paths, dashes, clipping, gradients, shadows, measured text | The state-stack depth reading `0` between frames |
| [svg](svg.md) | SVG | Live DOM output, `viewBox` sizing, per-renderable `<g>` groups, the path-only painter, `toSVGString()` | Real `<path>`/`<circle>`/`<text>` nodes in the inspector, updating in place |
| [webgl](webgl.md) | WebGL2 or WebGL | GLSL materials through a structural interface, automatic uniforms, context-loss recovery, resource accounting | `renderInfo` memory counts; `LOST` then recovery via `loseContext()` |
| [webgpu](webgpu.md) | WebGPU (detection) | Capability probing, adapter/device states, graceful fallback | The three distinct probe outcomes, reported on-page |
| [animation](animation.md) | Canvas2D | `Clock` and `Timer`, hand-written keyframe interpolation, two easing curves, `ManualClock` | The eased ghost arriving late and overshooting |
| [controls](controls.md) | Canvas2D | Pointer capture, non-passive wheel, zoom about the cursor, rotation-aware panning | The axes rotating with the view; the camera readout tracking the gesture |
| [picking](picking.md) | Canvas2D | `Box2`/`Vec2` hit testing plus 3D ray construction and `Ray.intersectTriangle` | The badge naming the 2D target or the pierced 3D face |
| [text](text.md) | Canvas2D | `measureText`-driven word wrap, `textAlign`/`textBaseline` semantics, `maxWidth`, `strokeText` | The wrap re-flowing when the browser's font size changes |
| [effects](effects.md) | Canvas2D | Eight blend modes, `shadowBlur` glows, gradients, `clip()` masking, an offscreen canvas as a render target | The badge's hard cut-out holes proving it came from a separate surface |
| [assets](assets.md) | Canvas2D | A concurrent, cached, retrying loader with a deliberate 404 | Cache hits rising while misses do not; the failure report |

## Conventions every example follows

- **Feature detection before use**, then a visible on-page message — never an exception into a blank
  page.
- **An overlay** showing FPS and the active backend, updated a few times per second.
- **A `dispose()`** that stops the loop, disposes the renderer and removes every listener, wired to
  `beforeunload` and safe to call twice.
- **No `console.log` noise** in the steady state.
- **No cross-example imports.** Each `main.ts` is complete on its own.

## Which backends exist

| Backend | Status |
| --- | --- |
| Canvas2D | Complete; drives ten of the twelve examples. |
| SVG | Complete. |
| WebGL | Complete, imported from its own module rather than the root barrel. |
| WebGPU | Landed in `src/renderer/webgpu/`, but treated as unproven — the example demonstrates detection. |

## Features an example documents as absent

Each of these examples says so on its page and implements the missing piece inline rather than
inventing an API:

| Layer | State |
| --- | --- |
| `src/effects/` | **Empty.** Post-processing on the CPU backends is compositing plus an offscreen canvas. |
| `src/renderer/webgpu/` | Landed, unproven. |

`src/materials/`, `src/textures/`, `src/geometry/3d/`, `src/picking/`, `src/controls/`, `src/assets/`
and `src/text/` have all landed since the examples were written, so some example READMEs describe
their layer as empty. The code is correct either way — it uses verified library primitives — but the
prose is due an update. Where an example's README and this table disagree, **this table is newer**.
