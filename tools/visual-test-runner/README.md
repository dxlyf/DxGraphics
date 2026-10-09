# Visual test runner

Compares rendered snapshots against the committed baselines in `tests/visual/baselines/`,
reports a per-pixel diff ratio, and writes viewable diff images to `tests/visual/diff/`.

## The decoder question, answered

Comparing snapshots means comparing **decoded pixels**. Decoding PNG without a dependency means
implementing inflate — hundreds of lines of bit-twiddling that would be the least trustworthy
code in this repository — and `package.json` may not gain a dependency.

So this tool compares **headerless raw RGBA** files, which need no decoding because the renderer
can already produce them:

```js
// Canvas2D, in the browser where the snapshot is taken
const { data } = ctx.getImageData(0, 0, width, height);
save(new Uint8Array(data.buffer), `${name}.${width}x${height}.rgba`);

// WebGL, likewise
const buffer = new Uint8Array(width * height * 4);
gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
```

- **PNG input is supported when a decoder already exists** in the environment: `sharp` or
  `pngjs` is used if it resolves. Nothing is installed for you; if neither is present, `--png`
  fails with an explanation naming both options and pointing at the raw path.
- **Diff images are always written as real PNGs**, encoded through Node's built-in `zlib`. The
  compression is ordinary deflate, so the artifacts are small and viewable in any image tool —
  only the *inputs* are restricted to raw.
- **`--update` promotes raw snapshots to `.rgba` baselines**, which are small and diff poorly in
  git. That is the deliberate trade: correct comparisons over pretty diffs. Record the
  dimensions and DPR for a case in `tests/visual/README.md` so a size change is a visible edit.

## The three directories

| Path | Committed? | Role |
| --- | --- | --- |
| `tests/visual/actual/` | no | Fresh snapshots, written by a browser. |
| `tests/visual/baselines/` | **yes** | References, named `<name>.<w>x<h>.rgba`. |
| `tests/visual/diff/` | no | Generated `.diff.png` images plus `report.json`. |

## Usage

```bash
# Compare every snapshot against its baseline
node --experimental-strip-types tools/visual-test-runner/runner.ts

# One case
node --experimental-strip-types tools/visual-test-runner/runner.ts --name 2d-basic

# Loosen the tolerance
node --experimental-strip-types tools/visual-test-runner/runner.ts --threshold 0.15 --max-diff 0.02

# Promote every actual to be the new baseline
node --experimental-strip-types tools/visual-test-runner/runner.ts --update

# Machine-readable
node --experimental-strip-types tools/visual-test-runner/runner.ts --json
```

| Option | Default | Effect |
| --- | --- | --- |
| `--update` | off | Write actuals as baselines instead of comparing. |
| `--name <case>` | all | Only process matching snapshots. |
| `--threshold 0..1` | `0.1` | Per-channel allowance counted as unchanged (~25 of 255 per channel at the default). |
| `--max-diff 0..1` | `0.01` | Fraction of pixels allowed to differ before the case fails. |
| `--alpha-cutoff 0..255` | `0` | Ignore pixels whose alpha is at or below this. |
| `--png` | off | Also read `.png` snapshots, if a decoder is installed. |
| `--clean` | off | Delete `tests/visual/diff` first. |
| `--json` | off | Emit a machine-readable report. |
| `--quiet` | off | Only print failures and the summary. |

**Exit codes:** `0` pass (or `--update` ran), `1` a comparison failed or a baseline is missing,
`2` bad usage or an unreadable input.

Note that **no snapshots means exit 1**, not exit 0. "Nothing to compare" is reported as a
failure, because a visual suite that passes when it ran nothing is worse than no suite.

## What the diff image shows

| Colour | Meaning |
| --- | --- |
| Grey (desaturated ghost) | Unchanged: the baseline's luminance at low opacity, so the frame's composition is still visible. |
| **Magenta** | Changed beyond the threshold. |
| **Red** | Present in the baseline only (the actual image is smaller). |
| **Blue** | Present in the actual image only (the actual image is larger). |

A dimension mismatch is therefore self-describing in the image, rather than being a bare error
you have to cross-reference.

## `compare.ts`

The comparison is a separate module so it can be used as a library and unit-tested without the
filesystem:

```ts
import { compareBitmaps, type Bitmap } from './compare';

const baseline: Bitmap = { width, height, data: baselineRgba };
const actual: Bitmap = { width, height, data: actualRgba };
const result = compareBitmaps(baseline, actual, { threshold: 0.1, maxDiffRatio: 0.01 });

if (!result.passed) {
  console.error(result.reason, `${(result.diffRatio * 100).toFixed(2)}% differ`);
}
```

| Export | Purpose |
| --- | --- |
| `compareBitmaps(baseline, actual, options)` | The comparison. Pure; no filesystem access. |
| `assertBitmap(bitmap, label)` | Validates dimensions against byte length, with a precise message. |
| `readRawRgba(path, width, height)` | Reads a headerless buffer, checking the size. |
| `writeRawRgba(path, bitmap)` | Writes one. |
| `readPngToRgba(path)` | Uses `sharp`/`pngjs` **if present**, else throws with an explanation. |
| `encodePng(bitmap)` | Encodes a real PNG through `node:zlib`. |
| `BitmapError` | Raised for every unusable input. |
| `Bitmap`, `CompareOptions`, `CompareResult` | Types. |

`compareBitmaps` is deliberately free of Node built-ins so it stays importable in a browser
bundle. The free functions that need `fs`/`zlib` load them through `import()` at call time.

## Interpreting a failure

| Symptom | Likely cause |
| --- | --- |
| A clean shift of the whole image | Camera, DPR or `setSize` changed, not the scene. Check `devicePixelRatio` first. |
| Magenta on shape edges only | Antialiasing or rasteriser differences. Raise `--threshold` slightly rather than accepting a wrong baseline. |
| A solid magenta region | A genuine geometry, material or draw-order change. |
| Red/blue bands at the borders | The buffer size changed. Confirm the new size is intended before `--update`. |
| Everything magenta | Clear colour changed, or the render produced a blank frame. |
| `NO BASE` | No baseline for that case. Render it, inspect it, then `--update`. |
| `ERROR` naming a byte count | The filename's dimensions disagree with the file's size. |

## A warning about `--update`

Promoting an actual to a baseline makes whatever it contains the new truth. Run it **only after
opening the diff image** and confirming the change is intended. A visual suite updated without
reading the diff converts a caught regression into a permanently accepted one, which is worse
than having no visual suite at all.

## Files

| File | Purpose |
| --- | --- |
| `runner.ts` | The CLI: discovery, comparison, reporting, `--update`, diff emission. |
| `compare.ts` | Pure comparison plus the optional-decode and PNG-encode helpers. |
| `README.md` | This file. |
