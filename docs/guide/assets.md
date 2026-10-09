# Assets

Loaders, the cache, and the manager that schedules them.

> **Note:** `src/assets/` has landed and exports the classes below. Treat the API as accurate (it
> is read from the source) and the behaviour as unproven against the examples.

## The three pieces

| Piece | Role |
| --- | --- |
| `Loader` | One format: decode a URL into a value. |
| `Cache` | Keyed storage so a second request for the same URL is free. |
| `LoaderManager` | Scheduling: concurrency, retries, progress, and the loaders registry. |

```ts
import { LoaderManager } from '@dxyl/graphics';

const manager = new LoaderManager({
  maxConcurrent: 6,     // DEFAULT_MAX_CONCURRENT_LOADS
  retries: 2,           // DEFAULT_LOAD_RETRIES
  retryDelay: 250,      // DEFAULT_RETRY_DELAY, doubled on each subsequent attempt
});

const gltf = await manager.load('model.glb');
const [a, b] = await manager.loadAll(['a.png', 'b.png']);

manager.on('loadprogress', (loaded, total) => {
  progressBar.value = loaded / total;
});
```

## Concurrency

`DEFAULT_MAX_CONCURRENT_LOADS` (6) is the in-flight cap, and the rest wait on a promise queue.
This is what stops a scene with a hundred assets from opening a hundred sockets — a failure that
presents as a slow load on a fast connection, which is why it is a default rather than an option
nobody sets.

Two concurrent requests for the **same URL** should share one fetch, not two. That is what the
cache's in-flight map is for:

```ts
const [x, y] = await Promise.all([manager.load('model.glb'), manager.load('model.glb')]);
// one network request; `x` and `y` are the same value
```

## The cache

```ts
import { Cache } from '@dxyl/graphics';

const cache = new Cache({ limit: 1000 });   // DEFAULT_CACHE_LIMIT

cache.set('key', value);
cache.get('key');
cache.has('key');
cache.delete('key');
cache.clear();
cache.size;
```

It is an **LRU**: a hit refreshes recency, and inserting past the limit evicts the oldest entry.
`DEFAULT_CACHE_LIMIT` is `1000`, which bounds the entry count rather than the bytes — so a cache
of 1 000 large decoded images is still a lot of memory. For textures, cap by byte size yourself
and call `cache.delete` when a scene unloads.

## Built-in loaders

`src/assets/` ships loaders for the formats below. Each is a `Loader` subclass, so a custom one
follows the same shape.

| Loader | Format |
| --- | --- |
| `FileLoader` | Raw text or an `ArrayBuffer`. The base every other loader builds on. |
| `ImageLoader` | `<img>` / `ImageBitmap`, with an `Image` fallback. |
| `JSONLoader` | JSON, with an optional reviver. |
| `FontLoader` | A font description, into the text layer's types. |
| `OBJLoader` | Wavefront OBJ. |
| `FBXLoader` | Autodesk FBX. |
| `GLTFLoader` | glTF 2.0 — JSON, `.gltf` plus buffers, and `.glb`. |

```ts
import { GLTFLoader, OBJLoader } from '@dxyl/graphics';

const gltf = await new GLTFLoader().load('scene.glb');
gltf.scene;        // the root node
gltf.scenes;
gltf.animations;   // AnimationClip[] the mixer can play

const obj = await new OBJLoader().load('model.obj');
```

`ImageLoader` prefers `createImageBitmap` and falls back to an `<img>` element, because
`createImageBitmap` is not available everywhere and a silent failure there produces a blank
texture rather than an error.

## Writing a loader

A loader is small: decode a URL, return a value, and report failure by throwing.

```ts
import { FileLoader, Loader } from '@dxyl/graphics';

class CSLLoader extends Loader<string[]> {
  protected override async loadFrom(url: string, onProgress?: (loaded: number, total: number) => void): Promise<string[]> {
    const text = await new FileLoader().load(url, onProgress);
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }
}
```

The rules a loader must follow, all of which the manager depends on:

1. **Throw on failure; never return a partial value.** The manager's retry logic keys on a
   rejection, so a loader that returns `null` on a 404 defeats it — and the caller gets a
   confusing failure later instead of a clear one now.
2. **Report progress with `(loaded, total)`** where the transport supplies it. `total` may be `0`
   when the response has no `Content-Length`, so a progress bar must guard against dividing by
   zero.
3. **Accept an `AbortSignal`** where the transport supports it, so a scene that unloads mid-load
   can cancel rather than resolve into a disposed object.

## Lifetime and cancellation

The race that matters: a load resolves **after** its owner was disposed. The `Disposable` layer
is built for it — `addDisposable` on an already-disposed owner disposes the child immediately
rather than storing it:

```ts
import { createDisposable, disposeOnAbort, Disposable } from '@dxyl/graphics';

class Scene1 extends Disposable<'Scene1'> {
  public override readonly label = 'Scene1' as const;

  public async load(url: string, signal: AbortSignal): Promise<void> {
    const texture = await new ImageLoader().load(url);
    // If `this` was disposed while the request was in flight, the texture is released now.
    this.addDisposable(createDisposable('texture', () => texture.close?.()));
    void signal;
  }
}

// Or tie a resource's lifetime to an abort signal directly:
const controller = new AbortController();
disposeOnAbort(someResource, controller.signal);
```

`addDisposable` returning the child (and `addDisposables` returning `this`) is what makes the
pattern compose. See [../architecture/resource-lifetimes.md](../architecture/resource-lifetimes.md).

## Object URLs

A `Blob` turned into a URL is a document-scoped resource, and leaking one leaks the whole blob.
Always pair the calls:

```ts
const url = URL.createObjectURL(blob);
try {
  const image = await new ImageLoader().load(url);
  use(image);
} finally {
  URL.revokeObjectURL(url);
}
```

`examples/assets` generates its assets in-page and demonstrates the full cycle — create, load
through the ordinary `fetch` path, cache, and revoke on teardown.

## Loading from a fixture in a test

Tests should not reach the network. Two options, both used in this repository:

```ts
// 1. Read the fixture and hand the bytes to the loader's decode step, bypassing fetch.
import { readFileSync } from 'node:fs';
import { OBJLoader } from '@dxyl/graphics';

const text = readFileSync('tests/fixtures/models/triangle.obj', 'utf8');
const geometry = new OBJLoader().parse(text);   // a parse-only path, where the loader has one

// 2. Serve the fixture through a stubbed global fetch, so the real loader path runs.
globalThis.fetch = async () => new Response(text, { status: 200 });
```

Prefer the second when the loader's transport handling is what you are testing, and the first when
it is not. The fixtures are tiny and hand-written — see
[`tests/fixtures/README.md`](../../tests/fixtures/README.md).

## See also

- [text.md](text.md) — fonts and glyph atlases, which `FontLoader` feeds.
- [../architecture/resource-lifetimes.md](../architecture/resource-lifetimes.md) — the ownership
  protocol.
- [performance.md](performance.md) — why the cache is bounded by entries, not bytes.
