# Tests

How this project is tested, and what belongs in each directory.

## The shape of the suite

| Directory | Environment | Runs in `pnpm test` | Purpose |
| --- | --- | --- | --- |
| `unit/` | Node, no DOM | **yes** | One module at a time. Pure functions, value objects, parsers, state machines. |
| `integration/` | Node, no DOM or GPU | **yes** | Several layers together: geometry → bounds → culling, scene graph → camera, render list → queue, event propagation, resource lifetimes. |
| `visual/` | A real browser, driven out of band | **no** | Pixel snapshots compared against committed baselines by `tools/visual-test-runner`. |
| `e2e/` | A real browser via Playwright (not installed) | **no** | Whole examples loaded and driven through their public surface. |
| `fixtures/` | — | — | Small hand-written inputs read by the suites above. See `fixtures/README.md`. |
| `setup.ts` | Node | **yes** | The global Vitest setup: resets the id counter and quietens logging, once per test file. |

The root `vitest.config.ts` selects what runs:

```ts
include: ['tests/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
exclude: ['node_modules', 'dist', 'tests/e2e/**', 'tests/visual/**'],
```

So `tests/e2e/` and `tests/visual/` are excluded by design, and `benchmarks/**` is not in
`include` at all — `pnpm bench` is a separate command.

## Commands

```bash
pnpm test                # vitest run — unit + integration
pnpm test:watch          # vitest
pnpm test:coverage       # vitest run --coverage
pnpm exec vitest run tests/integration      # one directory
pnpm exec vitest run -t 'frustum'           # one test name
pnpm bench               # vitest bench --run, all of benchmarks/
```

## What belongs where

### `unit/` — one module, no neighbours

A unit test may import anything from `src/`, but it should exercise **one module's** public
surface. If a test needs a `BufferGeometry` to check a `Frustum`, that is an integration
test.

Characteristics: no I/O, no timers, no randomness that is not seeded, no DOM assumptions.
Where a DOM is unavoidable, the test supplies its own minimal double rather than installing
a DOM implementation — `tests/unit/renderer-canvas-svg.test.ts` contains a hand-written
`CanvasRenderingContext2D` double for exactly this reason.

### `integration/` — several layers, still no GPU

An integration test exists to catch the thing unit tests structurally cannot: a **wrong
seam between two correct modules**. The current suites are:

| File | Seam it pins |
| --- | --- |
| `geometry-bounds-frustum.test.ts` | `BufferGeometry` bounds → `BoundingVolume` fitting → `Frustum` culling → `Scene.computeBounds()`. |
| `scene-graph-camera.test.ts` | `Object3D` transforms → `updateMatrixWorld` → `Camera3D` view matrix → projection round-trip, plus the core `Camera` screen-space helpers. |
| `render-queue-order.test.ts` | `Renderable`-shaped objects → `RenderList` bucketing → `RenderQueue` ordering, bucket sequence and comparator rules. |
| `event-propagation.test.ts` | `EventEmitter` → `EventDispatcher` → `Node` parent/child events, and the `Scene` structural events. |
| `resource-lifetimes.test.ts` | `Disposable` ownership ordering → `BufferGeometry` attribute release → `Pool` reuse → `BoundingVolume` cache invalidation. |

Rules these follow, and new ones should too:

- **No GPU and no DOM.** Everything must run in the default Node environment, or it cannot
  run in CI's fastest job.
- **Use real classes across the seam.** A stub is acceptable only where the real class would
  drag in a dependency the layer is forbidden to import — and when a stub is used, say so in
  a comment and explain what it stands in for.
- **Assert the contract, not the implementation.** Prefer "the view matrix maps the origin
  to −Z" over "element 14 equals −5".
- **Name the seam in the test name**, so a failure reads as a diagnosis rather than a
  location.
- **Do not share helpers between files.** A helper module would let a change in one seam
  silently alter another seam's test. Each file carries the small builders it needs.

### `visual/` — pixel snapshots

Not part of `pnpm test`, because it needs a browser and a committed baseline per case.
See `tests/visual/README.md` for the workflow and the naming convention, and
`.github/workflows/visual.yml` for the manual job that produces the artifacts.

### `e2e/` — whole examples

Playwright is **not installed** and must not be added. `tests/e2e/` therefore contains a
documented flow and a `playwright.config.ts.example` to copy once Playwright is available.
See `tests/e2e/README.md`.

### `fixtures/` — inputs

Small, hand-written, dependency-free, under 2 KB each. A fixture contains **no expected
output**: assertions live in the test, so one fixture can serve several tests without
inheriting another's expectations. See `fixtures/README.md`.

## Conventions

- **Vitest globals are on** (`globals: true`), so `describe`/`it`/`expect` need no import.
  The existing files import them explicitly anyway, which survives a config change.
- **`tests/setup.ts` runs once per file.** It calls `resetIdCounter()` and sets the log level
  to `Error` unless `LYF_TEST_LOG=1`. Set that variable to see library warnings:
  `$env:LYF_TEST_LOG='1'; pnpm test` on Windows, `LYF_TEST_LOG=1 pnpm test` elsewhere.
- **Floating point gets a tolerance.** `toBeCloseTo(value, 4)` rather than `toBe`, except
  where exactness is the point (a hex round-trip, a refcount).
- **No test asserts wall-clock time.** Timing belongs in `benchmarks/`, where a regression is
  a number to read rather than a flaky failure. The one exception is `>= 0` sanity checks on
  durations.
- **No snapshots of whole objects.** Prefer specific assertions: an inline snapshot of a
  forty-field object fails on every unrelated change and teaches reviewers to accept the
  update without reading it.
- **A test name states the behaviour**, not the method: "culls a cube that sits behind the
  camera", not "intersectsSphere returns false".

## Adding a test

1. Decide the directory by asking what is under test: one module → `unit/`; a seam →
   `integration/`; pixels → `visual/`; a running page → `e2e/`.
2. Name the file after the behaviour area (`render-queue-order`), not the class.
3. Put the *why* in a file-level doc comment. A future reader needs to know what regression
   the file exists to prevent, which is rarely obvious from the assertions.
4. Run `pnpm exec vitest run <path>` while iterating, then `pnpm test` for the whole suite.
5. Run `pnpm exec tsc -p tsconfig.json --noEmit` — the suite is type-checked like the library.
