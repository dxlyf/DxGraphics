# Rendering backends

Four backends, one contract. Which to reach for, what each can and cannot do, and how to pick
one at runtime without shipping a blank canvas.

## The shared contract

Every backend extends `AbstractRenderer`, so sizing, pixel ratio, the clear colour, the
animation loop, render statistics and disposal behave identically:

```ts
interface IRenderer {
  readonly backend: BackendName;
  readonly domElement: HTMLElement | null;
  readonly canvas: HTMLCanvasElement | null;
  readonly width: number;             // logical (CSS) pixels
  readonly height: number;
  readonly pixelRatio: number;
  readonly info: RendererInfo;
  readonly stats: RenderStats;
  readonly viewport: ViewportLike;
  readonly clearColor: { r: number; g: number; b: number; a: number };

  setSize(width: number, height: number, updateStyle?: boolean): void;
  setPixelRatio(ratio: number): void;
  getPixelRatio(): number;
  setViewport(viewport: ViewportLike): void;
  setScissor(scissor: ScissorRect | null): void;
  setClearColor(color: ClearColorInput, alpha?: number): void;
  clear(color?: ClearColorInput | null, depth?: number, stencil?: number): void;
  render(scene: SceneLike | null, camera?: CameraLike | null): void;
  createRenderTarget(options: RenderTargetOptions): IRenderTarget;
  onResize(callback: ResizeCallback): ResizeUnsubscribe;
  setAnimationLoop(callback: AnimationLoopCallback | null, options?: AnimationLoopOptions): void;
  start(): void;
  stop(): void;
  renderFrame(): void;
  resetStats(): void;
  dispose(): void;
  isDisposed(): boolean;
}
```

`width`/`height` are **logical pixels**; `canvas.width`/`canvas.height` are **device pixels**,
equal to the logical size times `pixelRatio`. `setViewport`/`setScissor` take device pixels
unless a backend documents otherwise.

## Comparison

| | Canvas2D | SVG | WebGL | WebGPU |
| --- | --- | --- | --- | --- |
| Module | `src/renderer/canvas2d/` | `src/renderer/svg/` | `src/renderer/webgl/` | `src/renderer/webgpu/` |
| Output | Pixel buffer | Live DOM | Pixel buffer | Pixel buffer |
| Host element | `<canvas>` | `<div>` | `<canvas>` | `<canvas>` |
| Depth buffer | no | no | yes | yes |
| Render targets | **throws** | **throws** | yes | — |
| Text | native font stack + `measureText` | `<text>`, styled by CSS | via shaders | — |
| Compositing | the full CSS blend-mode list | CSS `mix-blend-mode` | programmable | — |
| Cost model | per-draw-call CPU | per-DOM-node | per-vertex GPU | per-vertex GPU |
| Status here | complete | complete | complete, deep import | **empty module** |

The two things that most often decide the choice:

- **No depth buffer on the CPU backends.** You sort; there is no z-test. That is why
  `Renderable2D` has a `depth` field.
- **No render targets on the CPU backends.** `createRenderTarget` throws by design, because
  there is no second surface to draw into. On Canvas2D, an offscreen `<canvas>` plus
  `drawImage` is the substitute — see [effects.md](effects.md).

## Choosing at runtime

```ts
import {
  BackendNames,
  detectBackend,
  detectBackendStrict,
  getSupportedBackendNames,
  isBackendSupported,
  isBackendName,
  getBackendPriority,
} from '@dxyl/graphics';

// What is usable right now, in preference order.
getSupportedBackendNames();  // e.g. ['webgl2', 'webgl', 'canvas2d', 'svg']

// Strict: returns null when nothing is usable. Use this for feature detection.
const strict = detectBackendStrict([BackendNames.WebGL2, BackendNames.Canvas2D]);

// Lenient: never returns null; falls back to 'canvas2d'.
const lenient = detectBackend([BackendNames.WebGPU]);

// Probe one backend without choosing it.
isBackendSupported(BackendNames.WebGPU); // boolean

// Validate a value from config or a URL.
isBackendName(localStorage.backend);

// The full preference order, optionally with your own entries moved to the front.
getBackendPriority([BackendNames.SVG]);
```

`detectBackend`'s default order is WebGPU, WebGL2, WebGL, Canvas2D, SVG — the 3D-capable
backends first, so a scene with 3D content is not silently flattened onto a 2D backend. When
you pass a `canvas`, every candidate is probed by requesting its context on that exact canvas,
which is the only reliable test: several browsers expose a constructor that then refuses to
create a context.

Probing is not free — it creates and discards a canvas — so do it once and reuse the answer
rather than calling it per frame.

## Constructing a backend

```ts
import { BackendNames, Canvas2DRenderer, SVGRenderer } from '@dxyl/graphics';
import { WebGLRenderer } from './renderer/webgl/WebGLRenderer'; // deep import

const gl = new WebGLRenderer({
  canvas: '#stage',        // selector, element, OffscreenCanvas, or a container
  clearColor: '#11151d',
  clearAlpha: 1,
  pixelRatio: Math.min(2, window.devicePixelRatio || 1),
  maxPixelRatio: 4,        // default; the pixelRatio is clamped to this
  autoResize: true,
  preferWebGL2: true,      // WebGL only
});
```

Shared options: `canvas`, `container`, `width`, `height`, `pixelRatio`, `maxPixelRatio`,
`clearColor`, `clearAlpha`, `autoResize`, `updateStyle`, `autoClear`, `name`.

Backend-specific options:

| Backend | Extra options |
| --- | --- |
| Canvas2D | `contextAttributes`, `reportContextFailure` |
| SVG | `attachRoot` (default `true`), `rootAttributes`, `preserveAspectRatio` (default `'xMidYMid meet'`) |
| WebGL | `contextAttributes`, `preset`, `preferWebGL2`, `forceWebGL1`, `maxPrograms`, `quietContextProbe` |

`canvas` accepts a CSS selector, an element, an `OffscreenCanvas`, a container element (a
canvas is created inside it), or nothing (a detached canvas is created). When none of those
work, the renderer binds a **null surface** and reports `isHeadless === true`.

## Degrading gracefully

The three failure modes are distinct, and each should produce a visible message rather than a
blank canvas.

```ts
// 1. No backend at all.
const backend = detectBackendStrict([BackendNames.Canvas2D]);
if (backend === null) {
  showNotice('This browser cannot create a 2D canvas context.');
}

// 2. The backend exists but the renderer is headless.
const renderer = new Canvas2DRenderer({ canvas, autoResize: true });
if (renderer.isHeadless) {
  // setSize / setPixelRatio / clear / dispose are still safe. Only render() throws.
  showNotice('No drawing surface could be bound.');
}

// 3. SVG specifically: it constructs, but render() throws without a DOM.
const svg = new SVGRenderer({ container });
if (!svg.isLive) {
  showNotice('No SVG root exists, so nothing can be painted.');
}
```

`renderer.isHeadless` is the reliable check for the CPU and GPU canvas backends. `SVGRenderer`
overrides `render` to throw explicitly when it has no root, and it overrides
`allowsHeadlessClear()` to return `true` — clearing an SVG document with no DOM is a no-op, not
an error.

## What each backend draws

Neither 2D backend interprets a scene graph for you. Both collect renderables structurally:

| Step | Behaviour |
| --- | --- |
| 1 | `scene.collectRenderables(list, camera)` if the scene defines it |
| 2 | else `scene.children`, submitting each child with a `render` function |
| 3 | else the scene itself |

A renderable is any object with `visible` and `render(painter)`. The painter is
backend-specific:

| Backend | Painter type | Key members |
| --- | --- | --- |
| Canvas2D | `Canvas2DPainter` | `beginPath`, `moveTo`, `lineTo`, `arc`, `rect`, `roundRect`, `ellipse`, `polygon`, `fill`, `stroke`, `clip`, `fillText`, `measureText`, `drawImage`, gradients, `setLineDash`, transform stack |
| SVG | `SVGPainter` | `create`, `path`, `rect`, `circle`, `ellipse`, `line`, `polygon`, `polyline`, `text`, `image`, `group`, `defs`, `setTarget` |

They overlap on the element builders (`rect`, `circle`, `line`, `polygon`, `text`) but **not** on
the immediate-mode path: `SVGPainter` has no `beginPath`/`moveTo`/`fill`, because SVG is
retained-mode markup. A renderable that must serve both branches on which painter it received:

```ts
const isSvg = typeof (painter as { create?: unknown }).create === 'function';
```

`SVGRenderer` inserts its own wrapper `<div>` and keeps a `<g data-dxyl-world>` that receives
the camera transform, plus one `<g data-dxyl-node="…">` per renderable. `toSVGString()` returns
the document for export.

## Sorting and the render queue

Both 2D backends share one queue. The documented order is:

1. `renderOrder` ascending
2. `materialId` ascending (numeric before string; `undefined` last)
3. `depth` ascending — inverted for the transparent bucket
4. submission sequence, as a stable tie-break

Buckets are emitted `ordered`, `opaque`, `transparent`, each configurable through
`RenderQueueOptions` (`sortByMaterial`, `sortTransparentBackToFront`, `transparentFirst`,
`orderedLast`). Objects are bucketed as transparent when their material is, when
`transparent` is set, or when `opaque` is explicitly `false`.

## Statistics

```ts
renderer.stats.fps;             // smoothed frames per second
renderer.stats.frameTime;       // milliseconds for the last frame
renderer.stats.drawCalls;       // submissions this frame
renderer.stats.triangles;
renderer.stats.objects;
renderer.stats.culled;
renderer.stats.stateChanges;    // 2D backends count save/restore pairs
renderer.info.capabilities;     // e.g. ['immediate-mode', 'clipping', 'gradients', …]
renderer.info.pixelRatio;
```

`stats.fps` is a smoothed estimate, so it is not useful for the first few frames — guard with
`> 0` before displaying it, as the examples do.

## Backend capability strings

`renderer.info.capabilities` reports what the acquired context actually supports, which is more
useful than the backend name alone:

| Backend | Typical capabilities |
| --- | --- |
| Canvas2D | `immediate-mode`, `clipping`, `gradients`, `shadows`, `image-blit`, `css-filter`, `path2d` |
| SVG | `vector-output`, `css-styling`, `gradients`, `patterns`, `filters`, `markers`, `defs` |
| WebGL | the context's extension and limit names |

`css-filter` and `path2d` are conditional, because not every implementation has them. Log the
list rather than assuming.

## WebGL specifics

WebGL is imported from its own module, and its draw path is structural: a renderable is any
object with a `geometry` and an optional `material`, where a material is
`{ vertexShader, fragmentShader, uniforms, defines, textures, depthTest, depthWrite, topology, side }`.
Supplying no shader falls back to the renderer's built-in ES 1.00 program, which links on both
WebGL generations.

One detail is load-bearing: `uploadAutomaticUniforms` reads **`camera.viewMatrix`**. `Camera3D`
exposes exactly that name as an alias of its `matrixWorldInverse`, so a scene-layer camera
satisfies the contract with no adapter:

```ts
import { Mat4, PerspectiveCamera, Vec3 } from '@dxyl/graphics';

const camera = new PerspectiveCamera({ fov: 50, aspect: 16 / 9, near: 0.1, far: 100 });
camera.position.set(0, 1.4, 5.2);
camera.updateMatrixWorld(true);   // refreshes matrixWorldInverse, which viewMatrix aliases

renderer.render(scene, camera);
```

A plain object works too, which is what the examples do when they want to own the matrices
themselves. The only requirement is that `viewMatrix` and `projectionMatrix` are live — a snapshot
taken before the camera moves will render the frame from the old position.

```ts
const projection = Mat4.fromPerspective((50 * Math.PI) / 180, 16 / 9, 0.1, 100);
const view = Mat4.fromLookAt(new Vec3(0, 1.4, 5.2), new Vec3(0, 0, 0), new Vec3(0, 1, 0));

const camera = {
  projectionMatrix: projection,
  get viewMatrix() { return view; },   // the name the WebGL backend queries
  position: new Vec3(0, 1.4, 5.2),
};
```

The same applies to `Canvas2DRenderer`, whose 3D branch also reads `camera.viewMatrix` and
`projectionMatrix`.

## WebGPU

`src/renderer/webgpu/` implements the backend: `WebGPURenderer`, `WebGPUDevice`, `WebGPUAdapter`,
`WebGPUSwapChain`, `WebGPUPipeline`, `WebGPUShader`, `WebGPUBuffer`, `WebGPUTexture`,
`WebGPURenderTarget`, `WebGPUCompute`, `WebGPUState` and `WebGPUUtils`.

Device acquisition is **asynchronous**, so the renderer exposes `readiness` (a `Promise<boolean>`)
rather than a synchronous flag. Before the device exists, `render` logs and skips; in Node —
where there is no `navigator.gpu` — it resolves to `false`. Constructing, sizing, setting the pixel
ratio and disposing are all headless-safe; only `render` throws when there is no drawing surface.

The project ships no `@webgpu/types`, so the backend declares a structural WebGPU handle set
(`GPUDeviceLike`, `GPUTextureLike`, …). Real WebGPU objects satisfy them structurally.

Detection works independently of the backend:

```ts
const gpu = (navigator as { gpu?: { requestAdapter(o?: object): Promise<unknown | null> } }).gpu;
const adapter = gpu ? await gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
const libraryAgrees = detectBackendStrict(BackendNames.WebGPU) === BackendNames.WebGPU;
```

Note that `detectBackend`'s WebGPU probe calls `canvas.getContext('webgpu')`, which succeeds
only when `navigator.gpu` is present **and** the page is in a secure context. See
`examples/webgpu` for a complete probe that reports every outcome, including the one where the
adapter is granted but the device request is not.

## See also

- [../architecture/renderer-interface.md](../architecture/renderer-interface.md) — why the
  interface is shaped this way.
- [../architecture/layers.md](../architecture/layers.md) — the rule that nothing below
  `renderer` imports a backend.
- [performance.md](performance.md) — what actually costs time on each backend.
