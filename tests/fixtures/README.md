# Fixtures

Small, hand-written, dependency-free inputs for the test suites and the tools. Nothing here
is generated, and nothing here is a binary blob.

Every file is kept **under 2 KB** on purpose: a fixture that has to be regenerated is a
fixture nobody trusts, so these are all short enough to read and diff by eye.

## `models/`

| File | Format | Contents |
| --- | --- | --- |
| `triangle.obj` | Wavefront OBJ | One triangle: 3 `v`, 1 `vn`, 3 `vt`, one `f` using the `v/vt/vn` reference form. Chosen so a parser must handle all three reference kinds and 1-based indexing. |
| `cube.stl` | **ASCII** STL | Six facets of a unit cube (`-Z`, `+Z`, `-Y`, `+Y` as two triangles each, `-X`/`+X` omitted to stay under the size budget). Enough to exercise `facet normal … outer loop … endloop … endfacet` and a shared edge between the two triangles of one face. |
| `square.ply` | **ASCII** PLY 1.0 | A centred unit square as 4 vertices and 2 `element face` entries with `property list uchar int vertex_indices`. No normals and no UVs, so a loader has to decide whether to generate them. |

Binary STL and binary PLY are deliberately absent: they are unreadable in a diff, and the
library's loader layer is not written yet, so there is nothing to validate them against.

## `data/`

| File | Format | Contents |
| --- | --- | --- |
| `simple.json` | JSON | A scene description exercising the value shapes a loader must handle: a nested object (`camera`), an array of objects (`lights`, `objects`), a `null` (`lights[1].shadow`), a boolean (`transparent`), an integer (`version`) and floats (`roughness`). |
| `glyphs.fnt` | BMFont text | The `info`/`common`/`page`/`chars`/`kernings` structure with 5 glyphs (space, `A`, `B`, `C`, `i`) and one kerning pair. The `page` line references a PNG that does not exist — the fixture tests the *format parser*, not image loading. |

## `shaders/`

| File | Language | Contents |
| --- | --- | --- |
| `simple.glsl` | GLSL ES 3.00 | A vertex shader with one attribute pair, two matrix uniforms, a `normalMatrix` and one `out` varying. A vertex shader on purpose: it therefore has no `precision` declaration and no `gl_FragColor`, which is what stops `tools/shader-compiler` from demanding either. |
| `simple.wgsl` | WGSL | The same pipeline as a WGSL module: a `Uniforms` struct in a `@group(0) @binding(0)` uniform, a vertex input struct with two `@location`s, an output struct with `@builtin(position)`, and a `@vertex`/`@fragment` entry pair. |

These two are the inputs `tools/shader-compiler/compile.ts` is smoke-tested against. Both
pass the structural checks, and the tool reports honestly that no GPU compiler is available
to do a real one.

## Why there are no expected-output files

The fixtures are inputs only. Assertions live in the test that reads them, so a fixture can
be reused by a different test without inheriting another test's expectations. Where an
expected value is non-obvious (a parsed triangle's normal, say), the test computes it from
first principles rather than storing a golden number.

## Adding a fixture

- Keep it under 2 KB and hand-written. No generated dumps, no captured network responses.
- Prefer ASCII over binary, so the file is readable and diffable.
- Add a row to the table above saying **what format feature it exercises**, not just what it
  contains — the interesting part of a fixture is the edge case it pins.
- Comment the file's purpose inline where the format allows it (`#` in OBJ/STL, `comment` in
  PLY, `"$comment"` in JSON, `//` in WGSL/GLSL).
