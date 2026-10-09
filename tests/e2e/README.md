# End-to-end tests

Load a real page in a real browser and drive it through its public surface.

**Playwright is not installed, and must not be installed by this repository.** The root
`package.json` is deliberately dependency-free beyond build tooling, and `pnpm test` excludes
`tests/e2e/**`. What is here instead is the flow to follow, plus a
`playwright.config.ts.example` you can copy once you have Playwright available in your own
environment.

## Why these are excluded from `pnpm test`

An e2e run needs a browser binary, a web server and a GPU for the WebGL/WebGPU cases. None of
those is guaranteed on a CI runner, and a suite that fails on infrastructure rather than on
code trains people to ignore it. The unit and integration suites cover behaviour; e2e covers
**integration with the platform** — a canvas that actually paints, a listener that actually
fires, a teardown that actually releases.

## The flow

```text
  ┌─────────────────────────────────────────────────────────────────┐
  │ 1. Start a dev server for the target example                    │
  │      pnpm exec vite examples/2d-basic --port 5175 --strictPort  │
  └───────────────────────────────┬─────────────────────────────────┘
                                  ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ 2. Launch a browser with a fixed viewport and DPR               │
  │      viewport 1280×800, deviceScaleFactor 1                     │
  │      (a fixed DPR is what makes pixel assertions stable)        │
  └───────────────────────────────┬─────────────────────────────────┘
                                  ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ 3. Collect console errors and page errors BEFORE navigating     │
  │      fail the test if any appear — a blank page usually throws  │
  └───────────────────────────────┬─────────────────────────────────┘
                                  ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ 4. Wait for the overlay to report a backend, not for a timeout  │
  │      await page.waitForFunction(                                │
  │        () => document.querySelector('#overlay')?.textContent    │
  │              ?.includes('FPS'))                                 │
  └───────────────────────────────┬─────────────────────────────────┘
                                  ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ 5. Assert the observable contract                               │
  │      - the backend line names the expected backend              │
  │      - the draw-call count is greater than zero                 │
  │      - no notice element is visible                             │
  │      - the canvas has non-background pixels                     │
  └───────────────────────────────┬─────────────────────────────────┘
                                  ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ 6. Drive the interaction the example advertises                 │
  │      drag / wheel / pointer move, then assert the readout moved  │
  └───────────────────────────────┬─────────────────────────────────┘
                                  ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ 7. Assert teardown releases the frame loop                      │
  │      evaluate window.dispatchEvent(new Event('beforeunload'))    │
  │      then assert the FPS readout has stopped changing           │
  └─────────────────────────────────────────────────────────────────┘
```

## Why each step is written that way

- **Start a server rather than opening `file://`.** The examples import `../../src/index`, which
  only resolves through Vite's transform pipeline. A `file://` load gets a bare
  `Failed to resolve module specifier` and tests nothing.
- **Fix the viewport and DPR.** The examples size their drawing buffer from the CSS size times
  `devicePixelRatio`. A viewport that varies per machine makes every pixel assertion flaky.
- **Collect errors before navigating.** A listener attached after `goto` misses the errors that
  happen during module evaluation, which are exactly the ones that produce a blank canvas.
- **Wait on a condition, not a timeout.** The overlay showing `FPS` is the examples' own signal
  that the first frame completed. `waitForTimeout(2000)` is either too short on a loaded
  machine or wastes two seconds on every run.
- **Assert the draw count, not just the presence of the canvas.** A canvas element exists even
  when nothing was drawn; `draw calls > 0` is the assertion that proves a frame was submitted.
- **Assert no notice is visible.** Every example renders a `.notice` element when its backend
  is unavailable. Checking it is hidden turns "silently degraded to a blank page" into a
  failure.
- **Drive a real interaction.** The value of e2e over unit tests is the event wiring; a test
  that never sends a pointer event does not cover it.
- **Exercise `beforeunload`.** The examples wire a `dispose()` to it, and a leak there is
  invisible to every other kind of test.

## Per-example starting points

| Example | Assertion worth making |
| --- | --- |
| `2d-basic` | `draw calls` ≥ 3 (three squares), overlay names `canvas2d`. |
| `3d-basic` | `triangles` > 0, and the count changes after dragging (the orbit moved). |
| `canvas2d` | `state depth` returns to `0` between frames. |
| `svg` | `svg nodes` > 0, and the stage contains a real `<svg>` element. |
| `webgl` | `backend` is `webgl2` or `webgl`; `context` reads `usable`; skip the case when the browser has no GPU. |
| `webgpu` | Either the report names WebGPU as available, or it explains why not. Both are passes. |
| `animation` | The progress bar's width increases between two samples. |
| `controls` | After a drag, the overlay's `x, y` differs from its initial value. |
| `picking` | After a pointer move over a shape, the badge is not `no hit`. |
| `text` | `lines` > 1 and `longest line` ≤ the reported wrap limit. |
| `effects` | Hovering a swatch makes the overlay's `blend mode` read that mode's name. |
| `assets` | `status` reaches `ready`, and the 404 report is visible. |

## Enabling this suite

1. Install Playwright **in your own environment**, not in this repository:
   `npm i -D @playwright/test && npx playwright install chromium`
2. `cp tests/e2e/playwright.config.ts.example tests/e2e/playwright.config.ts`
3. Write the specs as `tests/e2e/<example>.spec.ts`.
4. Run `npx playwright test --config tests/e2e/playwright.config.ts`.

Do not add `playwright.config.ts` (without `.example`), and do not add a `test:e2e` script to
`package.json`: both would make the e2e suite look like part of the guaranteed build when it is
not.

## Files

| File | Purpose |
| --- | --- |
| `README.md` | This file. |
| `playwright.config.ts.example` | A ready-to-copy config: fixed viewport, one Chromium project, a `webServer` block. |
