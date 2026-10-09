# WebGPU detection

Capability probing with an honest report. The WebGPU backend is implemented (`src/renderer/webgpu/`), but device acquisition is asynchronous and fails outright where `navigator.gpu` is absent, so this example reports exactly which step succeeded rather than assuming a device.

## Read this first

**`src/renderer/webgpu/` is an empty directory.** There is no `WebGPURenderer` to
construct. `detectBackend`'s preference list names `'webgpu'` and the renderer
contracts are written to accommodate a GPU backend, but nothing implements one.

This example therefore does **not** pretend to render through WebGPU. It does what a
real application must do before choosing a backend, and it says so on the page:

1. **Probe the platform** — `navigator.gpu`, `requestAdapter({ powerPreference })`,
   `requestDevice()`. Each outcome (`navigator.gpu` missing, adapter `null`, device
   rejection) is a distinct, reported state rather than a thrown error.
2. **Cross-check the library's own answer** — `detectBackendStrict('webgpu')` and
   `getSupportedBackendNames()`. If the two ever disagree, that is a bug worth seeing.
3. **Report adapter details** — vendor, architecture, device, description, feature
   list and every limit the probe could read. These are the numbers that decide
   whether a scene will fit in memory.
4. **Always render something** — the Canvas2D fallback draws in the same canvas, so
   the page is never blank, and the report explains that the fallback is what you are
   looking at.

For a GPU backend that renders today, see `examples/webgl/`.

## What to look for

- **Chromium-based browsers** expose WebGPU: the report says so, the overlay lists the
  adapter vendor and architecture, and the library agrees `'webgpu'` is supported. The
  canvas still shows the Canvas2D fallback, because there is no renderer behind the
  detection.
- **Safari, Firefox builds without the flag, and every browser on an insecure origin**
  report `navigator.gpu` as missing; the page explains the secure-context and
  browser-support requirements.
- A device that is present but cannot serve a device request produces the third state:
  `navigator.gpu` present, adapter granted, device refused — with the rejection message
  printed verbatim.
- The overlay cross-checks the platform probe against the library: `'webgpu' detect`
  and the `supported list` come from `detectBackendStrict` and
  `getSupportedBackendNames()`, not from the probe.

## Key API

| Call | Purpose |
| --- | --- |
| `detectBackendStrict(BackendNames.WebGPU)` | `BackendName \| null` — the feature-detection call. |
| `getSupportedBackendNames()` | The usable subset of the preference list. |
| `navigator.gpu?.requestAdapter()` | Platform probe; `null` when unsupported. |
| `canvas.getContext('webgpu')` | Not attempted here; the backend would own it. |

## How to run it

From the repository root:

```bash
pnpm exec vite examples/webgpu
```

Vite uses `examples/webgpu/` as the project root, and the `../../src/index` imports in
`main.ts` resolve to the library source, so there is no build step and no `dist/`
requirement. The dev server prints the URL it is listening on.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Complete page: canvas, overlay, report panel, styles. |
| `main.ts` | The demonstration. |
| `README.md` | This file. |
