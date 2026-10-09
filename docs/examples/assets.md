# Assets

A concurrent, cached, retrying loader built from platform APIs, including a deliberate failure so the error path is exercised rather than assumed.

**Backend:** Canvas2D

## What it shows

A concurrency-limited queue at `DEFAULT_MAX_CONCURRENT_LOADS`, so a scene with many assets cannot open one socket per asset.
In-flight de-duplication: two concurrent requests for the same URL share a single promise.
An LRU cache at `DEFAULT_CACHE_LIMIT`, refreshed on hit and evicted oldest-first.
Retry with exponential backoff from `DEFAULT_RETRY_DELAY`.
Assets **generated in-page** as blobs and loaded through the ordinary `fetch` path, so the example is self-contained while still exercising real fetch, decode and caching.
Paired `URL.createObjectURL` / `revokeObjectURL`, because an object URL is a document-scoped leak if you forget.

## What to look for

A decoded PNG drawn as a textured quad, plus five objects from a parsed JSON scene document, with the status advancing through `generating assets-`, `loading scene document-`, `loading texture-`, `verifying cache-`, `ready`.

The repeated document URL raises the cache-hit counter while leaving the miss counter alone. The deliberate 404 retries and then reports on-page — while the rest of the scene keeps rendering, which is the behaviour a real loader must have.

## Running it

From the repository root:

```bash
pnpm exec vite examples/assets
```

Vite treats `examples/assets/` as the project root, so the `../../src/index` imports resolve to
the library source with no build step. The full source is in
[`../../examples/assets/`](../../../examples/assets/README.md).