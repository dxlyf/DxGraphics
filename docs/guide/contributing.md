# Contributing

How to make a change that fits the library. The build commands are in
[testing.md](testing.md); this page is about the rules a change has to satisfy.

## The one-sentence summary

**A change is correct when it type-checks, its tests pass, and it does not break the layer rule**
— nothing below `renderer` imports a backend.

## The design rules

Every change is measured against these. They are the same six stated in `src/index.ts`, and the
reason each exists:

| Rule | Why |
| --- | --- |
| **No runtime dependencies.** Nothing in `src/` imports an npm package. | The package's whole promise. A single import turns one lockfile entry into a tree, and it propagates: the tools then need the dependency too. |
| **Column-major matrices, column vectors.** `v' = M * v`; right-handed. | Every matrix uploads to WebGL/WGSL verbatim, with no transpose and no per-backend conversion. See [math-conventions.md](math-conventions.md). |
| **Allocation-light hot paths.** Mutators return `this`; read methods take an optional `target`; `Pool` recycles. | Per-frame allocation is the dominant cause of stutter. The convention is what makes it avoidable without a profiler. |
| **Explicit lifetimes.** Anything holding GPU or DOM resources extends `Disposable`; children go through `addDisposable`. | A missed release is invisible until it is a leak. Making ownership explicit is the only cheap defence. |
| **Events are opt-in, one shared map.** `EventEmitter`/`EventDispatcher` use `CoreEventMap`. | `emit` stays fully typed without threading a generic through the whole class hierarchy. |
| **Nothing below `renderer` imports a backend.** | The layer above owns the backend choice. Break this and the library stops being backend-agnostic. |

## The layer rule, in detail

The dependency direction is:

```
utils  <-  math  <-  core  <-  geometry  <-  materials/textures/shaders
                                              |
                                              v
                    scene  <-  animation/controls/picking/assets/text/effects
                                              |
                                              v
                              renderer (interfaces, core, canvas2d, svg)
                                              |
                                              v
                              renderer/webgl, renderer/webgpu
```

Two mechanical consequences:

1. **`src/renderer/**` may not import `src/scene`, `src/materials`, `src/textures`, `src/shaders`,
   `src/geometry` or any other layer above it.** It consumes them through **structural
   interfaces** declared beside the code that needs them. `src/renderer/core/RenderList.ts`
   declares `Renderable2D`; `src/renderer/interfaces/types.ts` declares `MaterialLike` and
   `GeometryLike`. That is why the renderer compiles on its own.
2. **`src/scene/**` may not import `src/renderer`.** `src/scene/3d/types.ts` declares its own
   `RaycasterLike`, `GeometryLike` and `MaterialLike` for the same reason, and
   `src/picking/types.ts` declares a third set. The duplication is deliberate: it keeps each
   layer independently compilable and independently testable.

When you need a type from another layer, **declare the structural subset you actually read** in
the consuming layer's `types.ts`, with a comment naming the file that provides the real class.
That is the pattern throughout the codebase, and it is what lets `picking` implement the contract
`scene` already declared without either importing the other.

If you must cross the direction, the honest options are to move the code or to introduce a
structural interface — not to add an import and a `// TODO`.

## Before you open a pull request

```bash
pnpm exec tsc -p tsconfig.json --noEmit     # zero errors outside pre-existing ones
pnpm run lint
pnpm test
pnpm build
```

`pnpm verify` runs the typecheck, lint, test and build together, which is what CI does.

Two things to know about the current state of the tree:

- **`scripts/**` and `tools/**` have `TS5097` errors** for `.ts`-extension imports, because Node's
  ESM loader needs the extension and the root `tsconfig.json` does not enable
  `allowImportingTsExtensions`. The convention is deliberate; see
  [../architecture/layers.md](../architecture/layers.md#tooling-conventions).
- **`src/index.ts` may have barrel-ambiguity errors** while layers land. They are resolved by
  adding explicit re-exports, not by changing the layers.

## Code style

The repository uses Prettier and ESLint; run `pnpm format` and `pnpm run lint:fix`. Beyond
formatting:

- **Document every public member.** The API reference is generated from the JSDoc, so an
  undocumented export is an undocumented feature.
- **Put the *why* in comments, not the *what*.** `// rotate about Y first` is noise; `// the
  renderer reads +Z here, unlike Node` is the kind of thing that saves the next reader an hour.
- **Narrow the public surface.** An export is a promise. Prefer a free function over a static
  method, and keep scratch state module-private.
- **Name for behaviour.** `DistanceDescending`, not `SortMode3`.

### Comments that earn their place

The existing code comments three things consistently, and new code should too:

1. **A convention that contradicts the obvious.** Every `+Y`/`-Z` sign, every "returns `this`",
   every "unsafe with a non-uniform parent".
2. **A decision the reader would otherwise reverse.** Why a comparator is not stable, why a
   disposal order is children-first, why a bound is conservative rather than tight.
3. **A known limitation, stated as one.** "This is implemented inline because that helper does not
   exist yet" is more useful than silence.

## Adding a layer, a backend, or a generator

[../architecture/extending.md](../architecture/extending.md) has the step-by-step for each of the
four extension points: a backend, a material, a geometry generator, and a loader. The generator
tool scaffolds the file skeleton:

```bash
node --experimental-strip-types tools/generator/generate.ts module widgets
node --experimental-strip-types tools/generator/generate.ts class src/widgets Gauge
```

It deliberately does **not** edit `src/index.ts`: adding to the public barrel changes the
published API and the API-extractor report, so that stays a deliberate edit.

## Tests

- **Unit tests** for one module; **integration tests** for a seam. If a unit test can cover it, it
  belongs in `unit/`. See [testing.md](testing.md).
- **A bug fix needs a test that fails before it.** Otherwise the fix is unverified.
- **A new export needs the test that would catch its most likely misuse** — a boundary, an empty
  input, a disposal-after-use.
- **Performance-sensitive code needs a bench entry**, not a timing assertion. See
  [../benchmarks/README.md](../../benchmarks/README.md).

## Documentation

A change that alters behaviour updates, in this order:

1. The **JSDoc** on the member.
2. The **guide page** for that feature, if it exists.
3. The **architecture page**, if the structure changed rather than the behaviour.
4. The **README** of the example it affects.

A new guide page must have a title, a one-line purpose statement, and runnable code that matches
the real API. If you cannot verify an API, document the verified subset and add a labelled
`> **Note:** this module is still stabilising` callout — never invent a signature.

## Commits and pull requests

- **One logical change per commit.** A rename and a behaviour fix in one commit cannot be
  reviewed or reverted independently.
- **The message says why**, not which files moved.
- **The PR description names the layer rule implications** if the change touches a boundary.
- **Say what you did not do.** A deliberate omission ("this does not handle interpolation for
  non-uniform scales") is a reviewable decision; silence is not.

## Reporting a problem

Include the backend (`renderer.backend`), whether the renderer is headless
(`renderer.isHeadless`), the capability list (`renderer.info.capabilities`), and the smallest
reproduction you have. For a rendering bug, `painter.commandCount` and `renderer.stats` narrow it
down faster than a screenshot does.
