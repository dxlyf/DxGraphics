# @dxyl/graphics

A dependency-free 2D/3D graphics library for the web with **pluggable rendering
backends**. One scene graph, one math library, four ways to put pixels on screen:
**Canvas2D**, **SVG**, **WebGL 1/2** and **WebGPU**.

```ts
import {
  Scene,
  PerspectiveCamera,
  Mesh,
  MeshStandardMaterial,
  BoxGeometry,
  WebGLRenderer,
} from '@dxyl/graphics';

const renderer = new WebGLRenderer({ canvas: '#stage' });
const scene = new Scene({ background: '#101018' });
const camera = new PerspectiveCamera(50, renderer.aspect, 0.1, 100);
camera.position.set(0, 0, 5);

const box = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
scene.add(box, camera);

renderer.setAnimationLoop((frame) => {
  box.rotation.y += frame.delta;
  renderer.render(scene, camera);
});
```

---

## Why this library

| Goal | How it is met |
| --- | --- |
| **No runtime dependencies** | `src/` imports nothing outside itself. The build verification step fails if a bare specifier appears in the bundle. |
| **One API, four backends** | Everything above `renderer/` is backend-agnostic. `detectBackend()` picks the best available one; the same scene renders through any of them. |
| **Predictable maths** | Column-major matrices, column vectors (`v' = M * v`), right-handed rotations. Every matrix uploads to WebGL/WGSL verbatim. |
| **Allocation-light hot paths** | Mutators return `this`; read methods take an optional `target`; `Pool` recycles per-frame objects. |
| **Explicit lifetimes** | Anything holding GPU or DOM resources extends `Disposable`; children are released with `addDisposable`; WebGL/WebGPU context loss is a first-class state. |
| **Typed events** | `EventEmitter`/`EventDispatcher` share one documented `CoreEventMap`, so `emit(name, ...args)` and `on(name, listener)` are fully type-checked. |
| **Verifiable** | 400+ tests, benchmarks, a build-artifact verifier and a generated API index. |

---

## Install

```bash
pnpm add @dxyl/graphics
```

```bash
npm install @dxyl/graphics
# or
yarn add @dxyl/graphics
```

The package ships ESM (`dist/esm`), CommonJS (`dist/cjs`) and type declarations
(`dist/types`). No peer dependencies, no plugins, no polyfills.

### Layer subpaths

The umbrella entry is the normal way in, but every layer is also published as its own
subpath, so you can import from one layer without pulling the rest of the barrel into
the module graph:

```ts
import { MeshStandardMaterial, RenderState } from '@dxyl/graphics/materials';
import { Vec3, Mat4 } from '@dxyl/graphics/math';
import { WebGLRenderer } from '@dxyl/graphics/renderer';
```

`animation`, `assets`, `controls`, `core`, `effects`, `geometry`, `materials`, `math`,
`picking`, `renderer`, `scene`, `shaders`, `text`, `textures`, `types`, `utils` and
`wasm` all resolve, in both ESM and CommonJS, with their own type declarations. The
split matters for the cross-layer name collisions: `MaterialLike` exists in both and
`@dxyl/graphics` exports the `scene` one, while `@dxyl/graphics/renderer` has the
backend-facing one.

## Quick start without a bundler

```html
<canvas id="stage" style="width: 100vw; height: 100vh; display: block"></canvas>
<script type="module">
  import { Scene, PerspectiveCamera, Mesh, BoxGeometry, MeshStandardMaterial, WebGLRenderer } from './node_modules/@dxyl/graphics/dist/esm/index.js';

  const renderer = new WebGLRenderer({ canvas: '#stage' });
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, renderer.aspect, 0.1, 100);
  camera.position.z = 5;
  scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()), camera);
  renderer.setAnimationLoop((frame) => {
    for (const child of scene.children) child.rotation.y += frame.delta;
    renderer.render(scene, camera);
  });
</script>
```

## Choosing a backend

```ts
import { detectBackend, getSupportedBackends } from '@dxyl/graphics';

getSupportedBackends();          // ['canvas2d', 'svg', 'webgl', 'webgl2', 'webgpu']
detectBackend(['webgpu', 'webgl2', 'canvas2d']); // first one that is actually usable
```

| Backend | Best for | Notes |
| --- | --- | --- |
| `canvas2d` | 2D UI, sprites, text, charts | Immediate-mode; shaders are emulated as pixel programs. |
| `svg` | Print-quality 2D, crisp text, DOM inspection | Live DOM; gradients/masks/clip paths via `<defs>`. |
| `webgl`/`webgl2` | 3D, large 2D scenes, custom GLSL | WebGL1 fallback is feature-detected. |
| `webgpu` | Modern 3D, compute, WGSL | Requires a WebGPU-capable browser. |

---

## Package layout

```text
src/
├── index.ts          # public entry point
├── namespace.ts      # DXYL.* umbrella object
├── version.ts        # version constants
├── constants.ts      # shared numeric constants
├── types/            # global, GLSL, WGSL and asset type declarations
├── core/             # events, lifecycle, timing, Node/Scene/Camera, layers, bounds
├── math/             # Vec2-4, Mat2-4, Quat, Euler, Color, Rect, Ray, Frustum, ...
├── geometry/         # BufferGeometry, 2D curves/paths/shapes, 3D primitives, modifiers
├── materials/        # material descriptions + GPU render state
├── textures/         # texture types, samplers, formats
├── shaders/          # shader descriptors, chunk registry, compile cache
├── scene/            # 2D and 3D scene objects, cameras, lights, bones
├── renderer/         # IRenderer + Canvas2D, SVG, WebGL and WebGPU backends
├── animation/        # clips, mixers, keyframe tracks, tweens, easing
├── controls/         # orbit/trackball/fly/first-person/pointer/gesture
├── picking/          # raycasting, 2D hit testing, GPU picking
├── assets/           # loaders (OBJ/STL/PLY/GLTF/SVG/...) and the asset manager
├── text/             # fonts, glyph atlases, layout, SDF text
├── effects/          # post-processing, shadows, fog, particles
└── wasm/             # optional WebAssembly acceleration
```

Each directory has an `index.ts` barrel; `src/index.ts` re-exports all of them, so
`import { Vec3 } from '@dxyl/graphics'` works for everything.

## Math conventions (read this first)

```ts
import { Vec3, Mat4, Quat, Color, Euler } from '@dxyl/graphics';
```

* **Matrices are column-major.** `matrix.elements[column * 4 + row]`. This is what
  `gl.uniformMatrix4fv` and WGSL's `mat4x4<f32>` expect, so a `Mat4` uploads as-is.
* **Vectors are column vectors.** Composing a transform is `world = parent * local`,
  and a point is `v' = M * v`.
* **Rotations are right-handed.** `Mat4.makeRotationZ(Math.PI / 2)` maps `+X` to
  `+Y`. Camera-space `-Z` is forward, `+Y` is up.
* **`lookAt` builds a view matrix** — the inverse of the camera's world matrix. A
  camera at `+Z` looking at the origin maps the origin to `-Z`.
* **`new Vec2(3)` is `(3, 3)`** — every component defaults to the first argument.
* **`new Color()` is opaque black**; use `Color.from(x)` to coerce a hex number, a
  CSS string or `{ r, g, b }`. The `(r, g, b)` constructor takes `0..1` floats while
  `setRgb`/`getRGB` use `0..255`.
* **`Euler.order` is required** (`'XYZ'` by default) and lists the axes in
  application order: `'XYZ'` rotates about X, then the new Y, then the new Z.

Full detail: [`docs/guide/math-conventions.md`](docs/guide/math-conventions.md).

## Documentation

The full set lives in [`docs/`](docs/README.md):

* **[Guides](docs/guide/README.md)** — getting started, architecture, geometry,
  materials, shaders, animation, controls, picking, assets, text, effects, performance.
* **[Architecture](docs/architecture/README.md)** — layer boundaries, the renderer
  interface, resource lifetimes, the event model, and how to extend the library.
* **[Examples](docs/examples/README.md)** — a page per runnable example.
* **API reference** — `pnpm docs` (Typedoc) writes `docs/api/`; `pnpm generate:api`
  writes a dependency-free [`docs/api/generated.md`](docs/api/generated.md) index.

---

## Development

```bash
pnpm install
pnpm typecheck      # tsc --noEmit over src, tests, examples, scripts, tools
pnpm test           # vitest (unit + integration)
pnpm test:coverage
pnpm bench          # vitest bench
pnpm build          # assets -> types -> bundle -> verify
pnpm docs           # typedoc
pnpm dev:serve      # watch + playground dev server

pnpm verify         # every gate below, in order, with a build at the end
pnpm verify:structure   # the prescribed directory tree is complete
pnpm verify:deps        # nothing under src/ imports a runtime dependency
pnpm verify:encoding    # no source file carries CP1252 mojibake
pnpm verify:brand       # every brand token agrees with the scope in package.json
```

`pnpm build` runs `scripts/build.ts`, which chains four stages and finishes with
`scripts/verify-build.mjs`. That verifier is not a formality: it loads the emitted
ESM and requires the emitted CJS, asserts the public API is present, and fails the
build if any bundle imports a package outside Node's built-ins.

`pnpm verify` is the gate to run before a release. The four `verify:*` scripts are
the checks that cannot be expressed as a compiler error or a unit test:

| Check | What it catches |
| --- | --- |
| `verify:structure` | a directory or root config the specification requires is missing |
| `verify:deps` | a bare `import 'some-package'` anywhere under `src/`, which would break the zero-dependency guarantee |
| `verify:encoding` | CP1252 mojibake: a UTF-8 em dash round-tripped through a CP1252 editor, which a terminal renders as plausible text and which a UTF-8 build then ships. The script fails on the marker sequences themselves, so it does not spell them out here. |
| `verify:brand` | the package name, the `DXYL` namespace export, the `data-dxyl-*` SVG attributes and the `__DXYL_GRAPHICS__` flag disagreeing with the scope in `package.json` after a rename. |

### Repository layout

```text
examples/        # 12 runnable examples, one per directory
playground/      # interactive demo shell with a backend switcher
docs/            # guides, architecture notes, generated API reference
tests/           # unit, integration, visual and e2e tests + fixtures
benchmarks/      # vitest benchmarks per layer
scripts/         # build, dev, release, generators, asset copy, verifier
tools/           # code generator, shader compiler CLI, visual test runner
assets/          # textures, models, fonts, images, shader sources
```

### Adding a change

1. `pnpm typecheck && pnpm test` must pass.2. Public API additions need JSDoc; `pnpm generate:api` reports undocumented
   declarations.
3. Anything that owns a GPU resource must extend `Disposable` and release children
   with `addDisposable`.
4. Anything that runs on a hot path needs a benchmark under `benchmarks/`.

See [`docs/guide/contributing.md`](docs/guide/contributing.md).

## Compatibility

| Environment | Supported |
| --- | --- |
| Browsers | Any current Chrome, Edge, Firefox or Safari (WebGPU only where shipped) |
| Node.js | ≥ 20.19 (library code runs headless; `Canvas2D`/`SVG` degrade to no-ops) |
| TypeScript | ≥ 5.0 (`strict` clean) |
| Bundlers | Vite, Rollup, webpack, esbuild, Parcel — no loader plugins needed |

## Browser support notes

* The library never touches `document` at module scope, so it imports cleanly in
  Node and in workers.
* Imports are typed with the `dom` lib; `BrowserUtils` declares the small slice of
  worker globals it needs so the two do not conflict.
* GLSL/WGSL sources ship as **TypeScript string constants**, not `.glsl` imports, so
  no bundler plugin is required. Regenerate with `pnpm generate:shaders`.

## License

[MIT](LICENSE) © dxyl
