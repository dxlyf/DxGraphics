# Testing

How the suite is organised and how to run it. See [`tests/README.md`](../../tests/README.md) for
the full strategy; this page is the guide-shaped summary.

## Commands

```bash
pnpm test                                  # vitest run — unit + integration
pnpm test:watch                            # re-run on change
pnpm test:coverage                         # with a v8 coverage report
pnpm exec vitest run tests/integration     # one directory
pnpm exec vitest run -t 'frustum'          # one test name
pnpm bench                                 # benchmarks, separate from the suite
```

## What runs where

| Directory | Environment | In `pnpm test`? | Purpose |
| --- | --- | --- | --- |
| `tests/unit/` | Node | yes | One module at a time |
| `tests/integration/` | Node | yes | Several layers together, no GPU |
| `tests/visual/` | A real browser | **no** | Pixel snapshots against committed baselines |
| `tests/e2e/` | A real browser (Playwright, not installed) | **no** | Whole examples driven through their UI |
| `tests/fixtures/` | — | — | Small hand-written inputs |

The root `vitest.config.ts` excludes `tests/e2e/**` and `tests/visual/**`, and does not include
`benchmarks/**` at all.

## Writing a unit test

```ts
import { describe, expect, it } from 'vitest';

import { Vec3 } from '../../src/math/Vec3';

describe('Vec3.single-number constructor', () => {
  it('sets every component', () => {
    expect(new Vec3(3).toArray()).toEqual([3, 3, 3]);
  });
});
```

Conventions the existing suites follow:

- **Import the module directly** (`../../src/math/Vec3`) rather than the root barrel. It keeps a
  unit test isolated from unrelated layers and makes the dependency visible.
- **Globals are on**, so the `vitest` import is optional — but the existing files import
  explicitly, which survives a config change.
- **File-level doc comment explaining the *why*.** A future reader needs to know what regression
  the file prevents, which is rarely obvious from the assertions.
- **A tolerance on floats**: `toBeCloseTo(value, 4)`, except where exactness is the point.
- **A test name that states behaviour**: "culls a cube that sits behind the camera", not
  "intersectsSphere returns false".

## Writing an integration test

An integration test exists to catch a **wrong seam between two correct modules**. That is the
whole criterion: if a unit test could cover it, it belongs in `unit/`.

The five seams currently pinned:

| File | Seam |
| --- | --- |
| `geometry-bounds-frustum.test.ts` | Geometry bounds → `BoundingVolume` → `Frustum` → `Scene.computeBounds` |
| `scene-graph-camera.test.ts` | Node transforms → world matrices → camera view/projection |
| `render-queue-order.test.ts` | Renderable-shaped objects → `RenderList` → `RenderQueue` |
| `event-propagation.test.ts` | `EventEmitter` → `EventDispatcher` → `Node`/`Scene` events |
| `resource-lifetimes.test.ts` | `Disposable` → attributes → `Pool` → bounds invalidation |

Rules:

- **No GPU and no DOM**, or it cannot run in the fast job.
- **Use the real classes across the seam.** A stub is acceptable only where the real class would
  drag in a layer the module is forbidden to import — and say so in a comment.
- **Assert the contract, not the implementation.** "The view matrix maps the origin to −Z", not
  "element 14 is −5".
- **Do not share helpers between integration files.** A shared helper lets a change in one seam
  silently alter another seam's test. Each file carries the small builders it needs.

## Fixtures

Small, hand-written, dependency-free, under 2 KB each, with no expected output stored — the
assertions live in the test so one fixture can serve several tests. See
[`tests/fixtures/README.md`](../../tests/fixtures/README.md).

## Determinism

The suite runs in Node with no DOM, so most nondeterminism is already gone. What remains:

- **Ids are sequential.** `tests/setup.ts` calls `resetIdCounter()` before every test, so an id
  is predictable within a file. Do not assert on absolute id values across files.
- **Logging is quietened** to `LogLevel.Error`. Set `LYF_TEST_LOG=1` to see library warnings:
  `$env:LYF_TEST_LOG='1'; pnpm test` on Windows, `LYF_TEST_LOG=1 pnpm test` elsewhere.
- **Randomness must be seeded.** `seededRandom(seed)` from `src/utils/MathUtils.ts` exists for
  this; `Math.random` is deliberately not stubbed globally.
- **Time must be supplied.** `ManualClock` (`advance(delta)`, `setTime(seconds)`) is the tool for
  anything time-dependent. The one place the suite reads a real clock is a `>= 0` sanity check on
  a measured duration.

## What is deliberately not tested

- **Wall-clock performance.** Timing belongs in `benchmarks/`, where a regression is a number to
  read rather than a flaky failure.
- **Whole-object snapshots.** A forty-field inline snapshot fails on every unrelated change and
  teaches reviewers to accept the update without reading it. Assert specific fields instead.
- **Pixels, in `pnpm test`.** They need a browser; see
  [`tests/visual/README.md`](../../tests/visual/README.md).
- **GPU behaviour.** No headless GPU. The WebGL backend's CPU-side state machine is testable and
  is tested; the draws are not.

## Coverage

```bash
pnpm test:coverage
```

Configured in `vitest.config.ts` with the v8 provider, reporting to `coverage/`. The include list
is `src/**/*.ts`, excluding type-only files (`src/**/types.ts`, `src/types/**`, `src/**/*.d.ts`).

Coverage is a **diagnostic, not a gate**: no threshold is enforced, because a threshold rewards
testing getters and punishes testing a hard seam. Read the report to find an untested branch, not
to hit a number.

## See also

- [performance.md](performance.md) — turning a benchmark result into a decision.
- [contributing.md](contributing.md) — the full change workflow.
