# Visual tests

Pixel-snapshot regression tests: render a scene, compare the pixels against a committed
baseline, and write a diff when they disagree.

These are **not** part of `pnpm test`. The root `vitest.config.ts` explicitly excludes
`tests/visual/**`, because a real comparison needs a browser to produce the pixels and this
repository has no headless GPU.

## Workflow

```text
actual/<name>.<w>x<h>.rgba      (produced by a browser, git-ignored)
        │
        │  tools/visual-test-runner/runner.ts
        ▼
baselines/<name>.<w>x<h>.rgba   (committed reference)
        │
        ▼
diff/<name>.<w>x<h>.diff.png    (generated, viewable)
diff/report.json                (generated)
```

1. **Render.** Run a page in a real browser and dump the pixels.
2. **Compare.** `node --experimental-strip-types tools/visual-test-runner/runner.ts`
3. **Inspect.** Open `tests/visual/diff/*.diff.png`. Unchanged pixels are a desaturated ghost
   of the baseline, changed pixels are magenta, and pixels present in only one image are red
   (baseline only) or blue (actual only).
4. **Accept or fix.** Fix the regression, or — only once you have looked at the diff and are
   satisfied the new render is correct — promote it:
   `… runner.ts --update`

## Why `.rgba` and not `.png`

Comparing images means comparing **decoded pixels**. Decoding PNG without a dependency means
implementing inflate, which would be the least trustworthy code in the repository, and this
project adds no runtime dependencies.

A raw RGBA buffer needs no decoding at all, and the renderer can already produce one:

```js
// Canvas2D, in the browser
const { data } = ctx.getImageData(0, 0, width, height);
save(new Uint8Array(data.buffer), `${name}.${width}x${height}.rgba`);

// WebGL, in the browser
const buffer = new Uint8Array(width * height * 4);
gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
```

The runner still reads PNG when a decoder happens to be installed (`sharp` or `pngjs`) — pass
`--png`. Nothing is installed for you: if neither resolves, `--png` fails with an explanation
rather than guessing. Diff images are always written as **real PNGs** through Node's built-in
`zlib`, so the artifacts you inspect are ordinary viewable images.

## Naming convention

```text
<name>.<width>x<height>.rgba
```

Examples:

```text
2d-basic.800x500.rgba
canvas2d-gradients.1280x720.rgba
webgl-cube.960x540.rgba
```

- **`<name>`** identifies the case. Use the example directory name for example-driven cases
  (`2d-basic`), or `<area>-<what>` for library-driven ones (`render-queue-transparency`).
  Lowercase, hyphen-separated.
- **`<width>x<height>`** is the **device-pixel** size of the buffer, not the CSS size. A
  800×500 canvas at `devicePixelRatio: 2` produces `1600x1000`.
- The extension is always `.rgba`.

The dimensions live in the **filename** because a headerless format cannot report them. The
runner parses them rather than being told, so a baseline can never silently disagree with its
own size — a mismatch is reported as a byte-length error naming both numbers.

## What to look for in a diff

| Symptom | Likely cause |
| --- | --- |
| A clean shift of the whole image | A camera, DPR or `setSize` change, not a scene change. Check `devicePixelRatio` first. |
| Magenta on shape edges only | Antialiasing or GPU rasterisation differences. Raise `--threshold` slightly rather than accepting a wrong baseline. |
| A solid magenta region | A genuine geometry, material or ordering change. |
| Red/blue bands at the borders | The buffer size changed. Confirm the new size is intended before `--update`. |
| Everything magenta | Background/clear colour changed, or the render failed and produced a blank frame. |

## Runner options

```bash
runner                                    # compare everything
runner --name 2d-basic                    # one case
runner --threshold 0.15 --max-diff 0.02   # looser tolerance
runner --alpha-cutoff 8                   # ignore near-transparent pixels
runner --update                           # promote actuals to baselines
runner --clean                            # clear tests/visual/diff first
runner --json                             # machine-readable report
```

- `--threshold` (default `0.1`) is the per-channel allowance, `0..1`, below which a pixel
  counts as unchanged. `0` demands exact equality.
- `--max-diff` (default `0.01`) is the fraction of pixels allowed to differ before the case
  fails. This is what makes the tool usable: a handful of edge pixels always move.

Exit codes: `0` pass, `1` a comparison failed or a baseline is missing, `2` bad usage or an
unreadable input.

## Directory contents

| Path | Committed? | Contents |
| --- | --- | --- |
| `baselines/` | **yes** | `.rgba` references plus `.gitkeep` and `README.md`. |
| `actual/` | no (git-ignored) | Freshly rendered snapshots. |
| `diff/` | no (git-ignored) | Generated diff PNGs and `report.json`. |

## A warning about `--update`

Promoting an actual to a baseline makes whatever it contains the new truth. Run it **only
after** opening the diff image and confirming the change is intended. A visual suite that is
updated without reading the diff is worse than no visual suite: it converts a caught
regression into a permanently accepted one.
