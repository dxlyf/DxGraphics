# Assets

A concurrent, cached, retrying loader built from platform APIs — with generated assets and a deliberate failure.

## What it shows

> **Note:** this module is still stabilising — `src/assets/` is an **empty directory**. There is no `Loader`, `LoaderManager`, `Cache`, `AssetManager` or format-specific loader (`TextureLoader`, `OBJLoader`, …). What exists is the constant block in `src/constants.ts` (`DEFAULT_MAX_CONCURRENT_LOADS`, `DEFAULT_LOAD_RETRIES`, `DEFAULT_RETRY_DELAY`, `DEFAULT_CACHE_LIMIT`) describing the layer's intended shape, with no implementation behind it. `main.ts` implements exactly that shape at the smallest size that still behaves correctly.

- **A concurrency-limited queue.** At most `DEFAULT_MAX_CONCURRENT_LOADS` requests are in flight; the rest wait on a promise queue. This is what stops a large scene from opening one socket per asset.
- **In-flight de-duplication.** Two concurrent requests for the same URL share a single `Promise`, so the network is never hit twice even before the cache is populated.
- **An LRU cache.** A `Map` keyed by URL, refreshed on hit and evicted oldest-first past `DEFAULT_CACHE_LIMIT`. This is the `Cache` the constants file anticipates.
- **Retry with exponential backoff.** `DEFAULT_LOAD_RETRIES` attempts, doubling from `DEFAULT_RETRY_DELAY`.
- **A failure path that does not break the page.** A deliberately broken URL 404s, retries, then reports on-page while the rest of the scene keeps rendering.
- **Generated assets, real fetching.** The JSON document and the PNG texture are built in-page as `Blob`s and turned into object URLs, then loaded through the ordinary `fetch` path. So the example is self-contained *and* still exercises real fetch, decode and caching.
- **Explicit revocation.** Every `URL.createObjectURL` is paired with `URL.revokeObjectURL` in `dispose()` — object URLs are a document-scoped leak if you forget.

## What to look for

- Status advances through `generating assets…`, `loading scene document…`, `loading texture…`, `verifying cache…`, then `ready`.
- The decoded PNG appears as a world-unit quad: an 8×8 checkerboard with a diagonal stripe, so orientation after decoding is visible. The JSON document's five objects are created as renderables and drawn in the same scene.
- The **cache-hit counter increments while the miss counter does not** for the repeated document URL — the second `load(documentUrl)` is served from the `Map`.
- An amber report panel explains the 404 asset and how many retries it cost, while the scene continues to render behind it.
- The overlay prints the live counters and the constant values actually in use, so the queue, retry and cache limits are all verifiable on screen.

## Key API

| Constant | Meaning |
| --- | --- |
| `DEFAULT_MAX_CONCURRENT_LOADS` | In-flight request cap (6). |
| `DEFAULT_LOAD_RETRIES` | Attempts after the first (2). |
| `DEFAULT_RETRY_DELAY` | First backoff delay in ms (250, then doubled). |
| `DEFAULT_CACHE_LIMIT` | Eviction bound (1000). |

| Pattern | Purpose |
| --- | --- |
| `URL.createObjectURL(blob)` / `URL.revokeObjectURL(url)` | Paired object-URL lifetime. |
| `createImageBitmap(blob)` with an `Image` fallback | Decoding that works without `createImageBitmap`. |
| `await fetch(url)` then a `response.ok` check | Real error surfaces instead of a silent bad decode. |

## How to run it

From the repository root:

```bash
pnpm exec vite examples/assets
```

Vite uses `examples/assets/` as the project root, and the `../../src/index` imports in
`main.ts` resolve to the library source, so there is no build step and no `dist/`
requirement. The dev server prints the URL it is listening on.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Complete page: host element, overlay, report panel, styles. |
| `main.ts` | The demonstration. |
| `README.md` | This file. |
