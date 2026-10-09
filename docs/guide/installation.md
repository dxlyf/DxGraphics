# Installation

How to add `@dxyl/graphics` to a project, and how to run it from source while developing the
library itself.

## From npm

```bash
pnpm add @dxyl/graphics
# or: npm install @dxyl/graphics
# or: yarn add @dxyl/graphics
```

The package ships ESM, CommonJS and type declarations, and has **no runtime dependencies** —
installing it adds one entry to your lockfile, not a tree.

| Entry point | Path |
| --- | --- |
| ESM | `./dist/esm/index.js` |
| CommonJS | `./dist/cjs/index.cjs` |
| Types | `./dist/types/index.d.ts` |

Node **20.19 or newer** is required (`engines.node` in `package.json`), because the package
uses modern ESM resolution and the tools rely on `--experimental-strip-types`.

## Importing

```ts
import {
  Vec3,
  Scene,
  Mesh,
  PerspectiveCamera,
  Canvas2DRenderer,
  detectBackend,
} from '@dxyl/graphics';
```

Everything is re-exported from the root, except the GPU backends. `src/renderer/index.ts`
documents that `webgl/` and `webgpu/` are owned by a separate layer and are intentionally not
re-exported from the renderer barrel, so `WebGLRenderer` comes from its own module:

```ts
import { WebGLRenderer } from '@dxyl/graphics/dist/esm/renderer/webgl/WebGLRenderer.js';
```

> **Note:** the published deep-import path is not yet listed in `package.json`'s `exports`
> map, which currently publishes only `"."` and `"./package.json"`. Until it is, import
> `WebGLRenderer` from source (see below) or construct a Canvas2D/SVG backend, which are both
> on the root export.

The `DXYL` namespace object is also available for console poking, though named imports are
preferred because the namespace defeats tree-shaking:

```ts
import { DXYL } from '@dxyl/graphics';

const v = new DXYL.math.Vec3(1, 2, 3);
```

## Running from source

For developing the library, or running the examples, nothing needs to be built. The examples
and the playground import the TypeScript source through a **relative path**, so a Vite dev
server compiles it on demand:

```bash
git clone <repository> && cd graphics-lib
pnpm install

# One example
pnpm exec vite examples/2d-basic

# The playground
pnpm playground
```

The `../../src/index` specifier in each example's `main.ts` resolves through Vite's transform
pipeline. Opening the file over `file://` will **not** work — a browser cannot resolve a
bare `src/index` from a file URL.

## Building the package

```bash
pnpm build
```

That runs, in order:

| Step | Command | Output |
| --- | --- | --- |
| `clean` | `node -e "…rmSync('dist')"` | removes `dist/` |
| `build:types` | `tsc -p tsconfig.build.json` | `dist/types/` |
| `build:bundle` | `vite build` | `dist/esm/`, `dist/cjs/` |
| `build:verify` | `node scripts/verify-build.mjs` | asserts the output exists and is well-formed |

`pnpm verify` additionally runs the typecheck, lint and test suites first, which is what CI
does.

## TypeScript configuration

The package is written for `"moduleResolution": "bundler"` or `"node16"`/`"nodenext"`. A
minimal setup:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true
  }
}
```

`strict` is required in practice: the public types use discriminated unions and optional
targets that are painful without it.

If you only want the shared type vocabulary and the ambient declarations, the package exposes
a `types` entry you can add to `compilerOptions.types`:

```jsonc
{ "compilerOptions": { "types": ["@dxyl/graphics/types"] } }
```

That brings in `src/types/global.d.ts`, which declares the WebKit-prefixed
`requestAnimationFrame` fallbacks, the opt-in `window.__DXYL_GRAPHICS__` flag, and the
structural `GPUCanvasContext` / `Navigator.gpu` shapes used by the WebGPU probe. They are
deliberately loose so the library neither depends on `@webgpu/types` nor fails to compile
without it.

## Verifying an install

```ts
import { BackendNames, detectBackendStrict, getSupportedBackendNames } from '@dxyl/graphics';

// `getSupportedBackendNames()` probes the runtime and returns only usable backends.
console.log(getSupportedBackendNames());

// `detectBackendStrict` returns null rather than pretending:
const backend = detectBackendStrict([BackendNames.WebGL2, BackendNames.Canvas2D]);
if (backend === null) throw new Error('no usable backend');
```

`detectBackend` never returns `null` — it falls back to `'canvas2d'` — which makes it the
convenience call and `detectBackendStrict` the feature-detection one.

## Common problems

| Symptom | Cause |
| --- | --- |
| `Failed to resolve module specifier "src/index"` | The page was opened over `file://`, or a bundler is not configured to resolve relative TypeScript imports. Serve it. |
| `Cannot find module './materials'` from `src/index.ts` | The layer barrel is missing. Every layer ships in this checkout, so this means a stale checkout or a partially applied update — run `pnpm run verify:structure`, which lists any missing directory or root config. |
| `WebGLRenderer is not exported` | It is not on the root export by design. Import it from its own module. |
| A blank canvas with no console error | Check whether the renderer is headless: `renderer.isHeadless` is `true` when no canvas could be bound. Construction, sizing, `clear` and `dispose` still work in that state; `render` does not. |
| `makePerspective requires 0 < near < far` | `Mat4.makePerspective` validates its arguments. `near` must be positive and strictly less than `far`. |
