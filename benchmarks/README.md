# Benchmarks

Vitest `bench` suites for the library's hot paths.

## Running them

```bash
pnpm bench
```

That runs `vitest bench --run`, which discovers every `benchmarks/**/*.bench.ts` (the glob
is configured in the root `vitest.config.ts` under `test.benchmark.include`). To run one
suite:

```bash
pnpm exec vitest bench --run benchmarks/math
```

Benchmarks are **not** part of `pnpm test`: the root config's `test.include` covers
`tests/**` and `src/**` only, and `benchmarks/**` is blocked from the normal test run, so
`vitest run` never picks a bench up as a test file.

## Suites

| File | Covers |
| --- | --- |
| `math/core.bench.ts` | `Vec3` arithmetic, `Mat4` multiply/compose/decompose/invert, `Quat` slerp, `Vec3.applyMat4`. |
| `geometry/generators.bench.ts` | `BufferGeometry` construction/clone/dispose, `computeBoundingBox`/`Sphere`/`VertexNormals`, bulk `Box3`/`Sphere.setFromPoints`, `BoundingVolume` fitting and the cull test. |
| `renderer/render-queue.bench.ts` | `RenderList` bucketing at 1k/10k, `RenderQueue.sort` at 100/1k/10k, sort with and without material grouping, `getDrawOrder`, scene-graph traversal and `updateMatrixWorld`. |
| `animation/keyframes.bench.ts` | Keyframe sampling at 16/512/4096 keys, six easing curves, 64-key quaternion slerp chains, a 32-bone pose loop, `Clock` reads. |

## How to read the output

Vitest prints one line per bench:

```text
 · Vec3 arithmetic > add (mutating, returns this)   12345678.90 hz   0.0001 ms
```

- **`hz`** — operations per second. **Higher is better.**
- **`mean`** — milliseconds per operation. **Lower is better**, and the easier unit to
  reason about against a frame budget: at 60 fps you have **16.7 ms** for everything.

Absolute numbers are machine-specific, so the useful signal is **relative**:

1. Compare a suite against another run of the **same** suite on the **same** host.
2. Prefer the ratio between two benches over either one alone. Several suites are built
   around a deliberate pair:

   | Pair | What the gap tells you |
   | --- | --- |
   | 16-key vs 512-key vs 4096-key sampling | A plateau means the binary search is intact; growth with the key count means it regressed to a scan. |
   | `RenderQueue.sort` with vs without material grouping | The cost of minimising GPU state changes. |
   | `BoundingVolume.setFromGeometry` (memoised) vs `computeBoundingBox` | Whether the geometry's cached bounds are still being used — this is the widest ratio in the suite. |
   | `Mat4.compose` vs `Mat4.decompose` | Decompose does a trace-branch quaternion extraction; expect it to be ~2–3× slower. |
   | `traverse` 340 vs 3279 nodes | Should be ~10×; worse means per-node allocation. |
   | `pushAll` 1 000 vs 10 000 | Should be ~23×; worse means a super-linear bucketing path. |

3. Watch for **allocation** regressions rather than arithmetic ones. Most of the library's
   hot paths are documented as allocation-light (mutators return `this`, read methods take
   an optional `target`, `Pool` recycles per-frame objects), and the symptom of losing
   that is a bench that gets slower *and* noisier run to run.

## Baseline expectations

Measured on the development host (Windows, Node 22, Vitest 3.2.7) with
`pnpm exec vitest bench --run`, while `src/` was still being written by several agents in
parallel.

**Two caveats, both important.**

1. These are a **snapshot, not a specification.** Absolute throughput moved by up to 2× between
   consecutive runs of the same suite during development, because the implementations changed
   underneath the benchmarks. Re-measure before drawing a conclusion.
2. **Read the ratios, not the absolute numbers.** The pairs called out below are the ones that
   carry a meaning: they compare two benches that differ in exactly one decision.

### Math (`benchmarks/math/core.bench.ts`)

| Bench | hz | mean |
| --- | --- | --- |
| `Vec3.dot` | ~7.5 M | 0.0001 ms |
| `Vec3.crossVectors` | ~7.1 M | 0.0001 ms |
| `Vec3.distanceToSquared` | ~6.9 M | 0.0001 ms |
| `Vec3.add` chain | ~4.9 M | 0.0002 ms |
| `Vec3.normalize` | ~3.9 M | 0.0003 ms |
| `Vec3.lerp` | ~3.5 M | 0.0003 ms |
| `Mat4.compose` | ~6.0 M | 0.0002 ms |
| `Mat4.multiplyMatrices` | ~4.8 M | 0.0002 ms |
| `Mat4.multiply` | ~4.1 M | 0.0002 ms |
| `Mat4.invert` | ~3.0 M | 0.0003 ms |
| `Mat4.decompose` | ~2.0 M | 0.0005 ms |
| `Quat.setFromRotationMatrix` | ~5.2 M | 0.0002 ms |
| `Quat.multiply` | ~4.7 M | 0.0002 ms |
| `Quat.slerp` | ~3.8 M | 0.0003 ms |
| `Vec3.applyMat4` (one point) | ~2.6 M | 0.0004 ms |
| `Vec3.applyMat4` (64 points) | ~182 k | 0.0055 ms |

`decompose` sits below `compose` (~2.0 M vs ~6.0 M) because it extracts a quaternion from a
rotation matrix via the trace branch, where `compose` only multiplies. That is expected, and a
change that reverses it would mean the trace extraction had been replaced by something heavier.

### Geometry (`benchmarks/geometry/generators.bench.ts`)

| Bench | hz | mean |
| --- | --- | --- |
| `BoundingVolume.setFromGeometry` (memoised) | ~1.47 M | 0.0007 ms |
| `setAttribute` + `setIndex` (25.6k verts) | ~567 k | 0.0018 ms |
| `BoundingVolume.update` (world matrix) | ~380 k | 0.0026 ms |
| `volume.update` + `frustum.intersectsSphere` | ~356 k | 0.0028 ms |
| `computeBoundingSphere` (25.6k verts) | ~1 027 | 0.97 ms |
| `clone` (25.6k verts) | ~675 | 1.48 ms |
| `dispose` (25.6k verts) | ~567 | 1.76 ms |
| `computeBoundingBox` (25.6k verts) | ~318 | 3.15 ms |
| `Box3.setFromPoints` (100k points) | ~116 | 8.65 ms |
| `Sphere.setFromPoints` (100k points) | ~38 | 26.6 ms |
| `computeVertexNormals` (25.6k verts) | ~35 | 28.5 ms |

**The ratio that matters is ~0.7 µs versus ~3.1 ms** — `BoundingVolume.setFromGeometry` on a
geometry with cached bounds versus `computeBoundingBox` scanning the same vertices. That is over
three orders of magnitude, and it is the entire justification for calling
`computeBoundingBox()`/`computeBoundingSphere()` once after building or deforming a geometry.
Calling them per frame instead of using the cache is the single most expensive mistake available in
this library.

Note that `computeBoundingSphere` measures *faster* than `computeBoundingBox` here, because the
box bench runs first and populates the cache the sphere bench then reuses. Read
`computeVertexNormals` (which scans every triangle and writes every vertex) as the true cost of a
full geometry pass.

### Renderer (`benchmarks/renderer/render-queue.bench.ts`)

| Bench | hz | mean |
| --- | --- | --- |
| `RenderList.pushAll` 1 000 + reset | ~36.6 k | 0.027 ms |
| `RenderList.pushAll` 10 000 + reset | ~1.61 k | 0.62 ms |
| `RenderQueue.sort` 100 objects | ~35.6 k | 0.028 ms |
| `RenderQueue.sort` 1 000 objects | ~1 356 | 0.74 ms |
| `RenderQueue.sort` 1 000, no material grouping | ~2 679 | 0.37 ms |
| `RenderQueue.sort` 10 000 objects | ~120 | 8.35 ms |
| `getDrawOrder` after sorting 1 000 | ~1 255 | 0.80 ms |
| `Node.traverse` 340 nodes | ~93.5 k | 0.011 ms |
| `Node.traverse` 3 279 nodes | ~2 873 | 0.35 ms |
| `Node.updateMatrixWorld` 340 nodes | ~14.2 k | 0.070 ms |
| `Node.updateMatrixWorld` 3 279 nodes | ~506 | 1.98 ms |

Three ratios worth watching:

- **`sort` with material grouping (~1 356) is about half the throughput of `sort` without it
  (~2 679).** That gap *is* the cost of grouping draws by material to reduce GPU state changes —
  exactly the trade the `sortByMaterial` option exists to expose. Turn it off for a depth pre-pass
  or a shadow pass, where depth order matters and state does not.
- **`pushAll` 1 000 vs 10 000 is ~23×, close to linear**, so bucketing has no super-linear
  regression.
- **`RenderQueue.sort` at 10 000 objects is ~8.4 ms**, which is half of a 60 fps frame spent before
  any drawing. Cull *before* submitting rather than submitting everything and sorting it.

### Animation (`benchmarks/animation/keyframes.bench.ts`)

| Bench | hz |
| --- | --- |
| sample 16-key track × 1 024 | ~40.3 k |
| sample 512-key track × 1 024 | ~15.8 k |
| sample 4 096-key track × 1 024 | ~17.2 k |
| `linear` easing | ~7.5 M |
| `smoothstep` easing | ~8.7 M |
| `cubicInOut` easing | ~8.4 M |
| all six easings | ~7.2 M |
| slerp 64 sequential keyframes | ~106 k |
| apply 32 node matrices | ~338 k |
| interpolate a 32-bone pose | ~132 k |
| `Clock.getDelta` | ~3.0 M |
| `Clock.getDeltaMilliseconds` | ~2.7 M |
| `Clock.fixedStepCount` | ~7.4 M |

The keyframe figures are the important ones: **16 keys costs ~2.5× less than 512 keys, and 4 096
keys costs no more than 512.** That plateau is the signature of a **binary search** — five to
seven extra comparisons, not the 256× a linear scan would cost. If the 4 096-key figure ever grows
toward 256× the 16-key one, the search has regressed to a scan.

The easing numbers are counter-intuitive and repeatable: single-curve benches are dominated by call
overhead and JIT warm-up, so `evaluate all six curves` can measure *faster per call* than `linear`
alone, and `smoothstep` (a polynomial) beats `linear` (a return). Read those four as "all within a
small constant factor", not as a ranking.

`Clock.fixedStepCount` (~7.4 M) is the cheapest clock call despite doing accumulator arithmetic,
because `getDelta` reads a monotonic clock while `fixedStepCount` only divides.

## Adding a suite

- One file per area under `benchmarks/<area>/`, named `*.bench.ts`.
- Use `import { bench, describe } from 'vitest'`.
- Build every input **outside** the `bench` callback. Anything constructed inside is
  measured, which turns a benchmark into an allocation test.
- Keep the callback side-effect-free with respect to the inputs, so repetition is
  meaningful. Where a mutator would corrupt the input (a matrix accumulator, for example),
  copy from a pristine source at the top of the callback and say so in a comment.
- Add a comment saying **what the number means** and **what would regress it** — that is
  the part a future reader actually needs.
