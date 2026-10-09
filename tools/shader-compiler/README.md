# Shader compiler

Validates GLSL and WGSL sources, and reports **honestly** about whether a real compilation is
possible on this machine.

## The honest part, first

There is no shader compiler in this repository, and no dependency may be added. So:

- **`compile.ts` does not compile.** It runs a structural pass over the source and then prints
  exactly what a real compile would require. A file that passes may still fail to compile —
  the tool says so in its own output rather than implying success.
- **`--require-gpu` turns that into a failure.** If you ever provision `glslangValidator`,
  `naga` or `tint`, this flag lets CI assert that a real compile actually happened instead of
  silently falling back to the structural pass.
- **What the structural pass does catch:** the error classes that dominate real shader work —
  unbalanced or mismatched delimiters, a missing entry point, a `varying` that is never used, a
  binding that is never referenced, a missing fragment-shader `precision` declaration, and
  GLSL/WGSL syntax written in the wrong language. Those are the mistakes that cost a
  compile-fix-compile cycle each.

## What a real compile needs

| Language | Tool | How to get it |
| --- | --- | --- |
| GLSL | `glslangValidator` | The Vulkan SDK, or the `glslang` package from your package manager. |
| WGSL | `naga` or `tint` | `cargo install naga-cli`, or a Dawn/`tint` build. |
| either | a browser context | WebGL/WebGPU in a browser. Node does not provide one, and this tool does not start a browser. |

Node is deliberately not a `devDependency` for any of these, because a shader toolchain that
is not installed is indistinguishable from one that is not configured, and a tool that fails
ambiguously is worse than a tool that reports its own limits.

## Usage

```bash
node --experimental-strip-types tools/shader-compiler/compile.ts tests/fixtures/shaders/simple.glsl
node --experimental-strip-types tools/shader-compiler/compile.ts tests/fixtures/shaders/simple.wgsl
node --experimental-strip-types tools/shader-compiler/compile.ts tests/fixtures/shaders --quiet
node --experimental-strip-types tools/shader-compiler/compile.ts shader.glsl --json
node --experimental-strip-types tools/shader-compiler/compile.ts shader.glsl --require-gpu
```

| Option | Effect |
| --- | --- |
| `--json` | Emit `{ toolchain, results }` for a script to consume. |
| `--quiet` | Only report files that have findings. |
| `--require-gpu` | Exit `1` when no real compiler is available, even if the structural pass is clean. |

Directories are expanded to their `.glsl`, `.vert`, `.frag` and `.wgsl` files.

**Exit codes:** `0` no structural errors (which is *not* a successful compilation), `1`
structural errors found or `--require-gpu` with no compiler, `2` bad usage.

## `validate.ts`

The same checks, exposed as a **library** and as a second CLI. `compile.ts` is the
command-line front end that reports the toolchain situation; `validate.ts` is the
programmable one that only reports the structural verdict.

```ts
import { validateFile, isClean } from './validate';

const result = validateFile('tests/fixtures/shaders/simple.glsl');
if (!isClean(result)) {
  throw new Error(result.diagnostics.map((d) => d.message).join('\n'));
}
```

```bash
node --experimental-strip-types tools/shader-compiler/validate.ts <file...> [--json] [--quiet]
```

Unlike `compile`, `validate` never exits non-zero because the GPU toolchain is missing.

Both share one implementation, so a check cannot drift between what the CLI reports and what a
test asserts. `compile.ts` only runs its CLI when it is the process entry point, so importing
it from `validate.ts` has no side effects.

## Exported checks

| Function | Checks |
| --- | --- |
| `detectLanguage(path, source)` | Extension first, then `@vertex`/`fn`/`var<` vs `#version`/`void main`/`varying`. |
| `stripComments(source)` | Blanks comments while preserving every offset, so line numbers stay valid. |
| `checkDelimiters(source)` | `()[]{}` balance, order and mismatches, each with a line number. |
| `checkEntryPoint(source, language)` | `void main()` for GLSL; a `@vertex`/`@fragment`/`@compute` attribute for WGSL. |
| `checkPrecision(source, language)` | Warns when a GLSL fragment shader omits a default float precision. |
| `checkLanguageMixups(source, language)` | GLSL tokens in WGSL and vice versa. |
| `checkUnusedDeclarations(source, language)` | Unused `varying`s and unused WGSL `@binding`s. |
| `validateSource(path, source)` | All of the above, sorted by line. |
| `probeToolchain()` | Whether a real compiler exists, and what to install if not. |

`--json` output shape:

```json
{
  "toolchain": { "compilerFound": false, "compilerName": "…", "explanation": "…" },
  "results": [
    {
      "path": "…",
      "language": "glsl",
      "compiled": false,
      "diagnostics": [{ "code": "…", "severity": "error", "message": "…", "line": 12 }]
    }
  ]
}
```

`compiled` is always `false` today. It exists so a future real-compile path does not need a
schema change to report itself.

## Deliberate limitations

- **No type checking.** A shader can pass and still be rejected by a driver. `vec3 * mat4` in
  the wrong order, a bad swizzle or an unavailable extension are all invisible here.
- **No `#include` / `#import` resolution.** Multi-file shaders are validated file by file, so a
  symbol defined in another file reads as undefined to these checks (which is why the unused
  declaration check is a warning, not an error).
- **No preprocessor evaluation.** `#ifdef` branches are all scanned, so a declaration that only
  exists in an inactive branch still counts as present.
- **No WGSL entry-point signature validation.** Only the presence of a stage attribute is
  checked.
