# Generator

Scaffolds a new library module, or a single class inside an existing module, from the
templates in `templates/`.

## Usage

```bash
# A new module: src/widgets/{index,types,Widget}.ts plus tests/unit/widgets.test.ts
node --experimental-strip-types tools/generator/generate.ts module widgets

# A module without types.ts, and without a test
node --experimental-strip-types tools/generator/generate.ts module widgets --no-types --no-test

# One class inside an existing module, plus its test
node --experimental-strip-types tools/generator/generate.ts class src/widgets Gauge

# Preview without writing anything
node --experimental-strip-types tools/generator/generate.ts module widgets --dry-run

# Overwrite files that already exist
node --experimental-strip-types tools/generator/generate.ts module widgets --force
```

`--help` prints the same list.

## Why `node --experimental-strip-types`

The script is plain TypeScript and Node 22 runs it directly by stripping the types. There
is no build step, no `ts-node`, no `tsx` — the repository has zero runtime dependencies and
the tools honour that.

The generator is type-checked with everything else, because the root `tsconfig.json`
includes `tools/**/*.ts`. Run `pnpm exec tsc -p tsconfig.json --noEmit` after editing it.

## What it generates

| Command | Files |
| --- | --- |
| `module <name>` | `src/<name>/index.ts`, `src/<name>/<Name>.ts`, `src/<name>/types.ts`, `tests/unit/<name>.test.ts` |
| `class <path> <Name>` | `<path>/<Name>.ts`, `tests/unit/<name>.test.ts` |

Placeholders substituted into the templates:

| Token | `widgets` becomes | `Gauge` becomes |
| --- | --- | --- |
| `{{NAME_KEBAB}}` | `widgets` | `gauge` |
| `{{NAME_CAMEL}}` | `widgets` | `gauge` |
| `{{NAME_PASCAL}}` | `Widgets` | `Gauge` |
| `{{VERSION}}` | the `version` from `package.json` | same |

## What it deliberately does not do

- **It does not edit `src/index.ts`.** Adding a layer to the public barrel changes the
  published API surface and the API-extractor report, and it is the kind of edit that
  should be made on purpose. The script prints the exact line to add instead:
  `export * from './widgets';`
- **It does not run the formatter or the tests.** Run `pnpm format` and
  `pnpm exec vitest run tests/unit/<name>.test.ts` yourself, so a failure is attributed to
  the generated code rather than hidden inside the generator.
- **It does not overwrite by default.** A mis-typed name therefore cannot clobber an
  existing module; you have to pass `--force`.

## Template conventions

The templates encode what the rest of `src/` does:

- A `@packageDocumentation` header on `index.ts` with a short usage snippet.
- A JSDoc block on every public member, because the API reference is generated from them.
- Mutators return `this`; read methods take an optional `target`. Both are documented in
  `docs/architecture/extending.md` as the hot-path convention.
- A `dispose()` that is documented as idempotent, and a note that a class owning resources
  should extend `Disposable` and use `addDisposable`.
- Structural `…Like` interfaces in `types.ts`, which is how the library accepts classes
  from layers that may not exist yet without creating a circular import.
- A `README`-quality example inside the JSDoc rather than a placeholder comment.

## Layout

| Path | Contents |
| --- | --- |
| `generate.ts` | The CLI. |
| `templates/module-index.ts.tpl` | The module barrel. |
| `templates/class.ts.tpl` | A class plus its options interface, factory and type guard. |
| `templates/types.ts.tpl` | Cross-layer vocabulary and JSON metadata. |
| `templates/unit-test.ts.tpl` | A Vitest suite covering construction, chaining, disposal and the type guard. |
