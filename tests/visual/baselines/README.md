# Visual baselines — naming convention

Committed reference images for the visual regression suite. Read `../README.md` first for the
workflow; this file describes only what a file in this directory must be called.

## Format

```text
<name>.<width>x<height>.rgba
```

- Headerless, tightly packed **RGBA**, 4 bytes per pixel, row-major, **top-left origin**.
- `width * height * 4` bytes exactly, with no row padding.
- The dimensions are part of the filename because the format carries no header. The runner
  parses them from the name, so a baseline cannot disagree with its own size.

## Examples

| Filename | Meaning |
| --- | --- |
| `2d-basic.800x500.rgba` | The `examples/2d-basic` page, rendered into an 800×500 device-pixel buffer. |
| `canvas2d-gradients.1280x720.rgba` | A library-driven case covering gradients, at 1280×720 device pixels. |
| `webgl-cube.960x540.rgba` | The WebGL example's cube, at 960×540 device pixels. |

## Rules

1. **Lowercase, hyphen-separated `<name>`.** Use the example directory name for
   example-driven cases; use `<area>-<what>` for library-driven ones.
2. **Device pixels, not CSS pixels.** A 800×500 CSS canvas at `devicePixelRatio: 2` is
   `1600x1000`. Record the renderer's `pixelRatio` in `../README.md` if a case pins it, so the
   number is reproducible.
3. **One baseline per case.** Do not keep a `2d-basic-latest.rgba` alongside a
   `2d-basic.800x500.rgba`; `--update` overwrites, and history belongs in version control.
4. **Size changes are intentional edits.** Renaming from `800x500` to `1600x1000` means the
   runner will report a missing baseline rather than a diff. That is deliberate: a size change
   should be a visible commit, not a silent pass.
5. **Keep them small.** Use the smallest buffer that still exercises the case — 800×500 is
   ~1.5 MB, so a dozen cases is already ~18 MB of repository. Prefer a couple of small cases
   per area over one large one.

## No fabricated baselines

There are **no** `.rgba` files committed here, and that is correct: this repository has no
headless GPU, so the pixels cannot be produced in CI or by a script in this checkout. A
baseline must come from a real browser rendering the real page. Generating a plausible-looking
file by hand would make the suite pass without testing anything, which is worse than having no
baseline at all — the runner reports a missing baseline as a **failure** precisely so that
absence stays visible.

Populate this directory by running the suite in a browser (see `../README.md`), then promoting
the first known-good render with `runner.ts --update` and committing the result.
