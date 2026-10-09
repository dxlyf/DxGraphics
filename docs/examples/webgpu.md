# WebGPU detection

Capability probing that reports the platform's answer and the library's answer separately, instead of pretending to render.

**Backend:** WebGPU (detection only)

## What it shows

`detectBackendStrict('webgpu')` and `getSupportedBackendNames()` cross-checked against a direct `navigator.gpu` probe.
Every failure mode as **data** rather than an exception: no `navigator.gpu`, `requestAdapter()` resolving to `null`, and `requestDevice()` rejecting are three distinct reported states.
Reading the adapter's vendor, architecture, feature list and limits — the numbers that decide whether a scene fits in memory.
A Canvas2D fallback that renders in the same canvas, so the page is never blank while the report explains why.

## What to look for

On a Chromium browser, a green report naming the adapter vendor and architecture, plus the library agreeing that `webgpu` is supported — and the Canvas2D fallback still drawing, because there is no renderer behind the detection.

The probe result and the library's own answer are printed side by side. A disagreement between them would be a bug worth seeing, which is why both are shown.

## Running it

From the repository root:

```bash
pnpm exec vite examples/webgpu
```

Vite treats `examples/webgpu/` as the project root, so the `../../src/index` imports resolve to
the library source with no build step. The full source is in
[`../../examples/webgpu/`](../../../examples/webgpu/README.md).