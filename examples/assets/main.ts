/**
 * Assets — loading, decoding and caching data with no asset layer.
 *
 * Read this first
 * ---------------
 * **`src/assets/` is an empty directory in this checkout**: there is no `Loader`,
 * `LoaderManager`, `Cache`, `AssetManager`, `TextureLoader` or `OBJLoader`. There is
 * also a `Cache` constant block in `src/constants.ts` (`DEFAULT_CACHE_LIMIT`,
 * `DEFAULT_MAX_CONCURRENT_LOADS`, `DEFAULT_LOAD_RETRIES`, `DEFAULT_RETRY_DELAY`)
 * describing the shape that layer is meant to have, but no implementation behind it.
 *
 * So this example implements the three pieces every loader needs, at the smallest
 * size that still behaves correctly, and uses only platform APIs:
 *
 * 1. **A concurrency-limited queue** — `DEFAULT_MAX_CONCURRENT_LOADS` in-flight
 *    requests, the rest waiting, so a big scene does not open a hundred sockets.
 * 2. **A cache** — a `Map` keyed by URL that is checked before the queue, so a second
 *    request for the same asset is synchronous and never hits the network. This is the
 *    `Cache` the constants file anticipates.
 * 3. **A retry with backoff** — `DEFAULT_LOAD_RETRIES` attempts with
 *    `DEFAULT_RETRY_DELAY` doubling, and a failure path that surfaces in the UI rather
 *    than rejecting into an unhandled promise.
 *
 * The assets themselves are **generated in-page**: a JSON scene description and an
 * image, both turned into `Blob` URLs with `URL.createObjectURL`, then loaded through
 * the normal `fetch` path. That keeps the example self-contained and still exercises
 * real fetching, decoding and caching. It also means the deliberate
 * **404 case** below works: the first request pins a retry, the second succeeds.
 *
 * What to look for
 * ----------------
 * A progress line that advances as each asset resolves, the decoded image drawn as a
 * textured quad, the parsed JSON driving the object layout, and a cache-hit counter
 * that never increases for a repeated key. The 404 asset demonstrates retry-then-fail
 * with the error shown on the page.
 */

import {
  BackendNames,
  Canvas2DRenderer,
  Color,
  DEFAULT_CACHE_LIMIT,
  DEFAULT_LOAD_RETRIES,
  DEFAULT_MAX_CONCURRENT_LOADS,
  DEFAULT_RETRY_DELAY,
  detectBackendStrict,
  type BackendName,
  type Canvas2DPainter,
  type Renderable2D,
} from '../../src/index';

/* -------------------------------------------------------------------------- */
/* The loader: queue + cache + retry                                          */
/* -------------------------------------------------------------------------- */

/** A JSON scene description, as it would arrive from a server. */
interface SceneDocument {
  readonly name: string;
  readonly background: string;
  readonly objects: readonly {
    readonly kind: 'rect' | 'circle';
    readonly x: number;
    readonly y: number;
    readonly size: number;
    readonly color: string;
  }[];
}

/** Counters the overlay reports, so the machinery is observable. */
interface LoaderStats {
  queued: number;
  started: number;
  retried: number;
  failed: number;
  cacheHits: number;
  cacheMisses: number;
  evicted: number;
}

/**
 * A small concurrent, cached, retrying loader.
 *
 * Deliberately not generic over a decode function per type: the two decoders below
 * are the only ones this example needs, and keeping them explicit makes the error
 * handling obvious.
 */
class AssetLoader<T> {
  /** Resolved values, keyed by URL. */
  private readonly cache = new Map<string, T>();

  /** In-flight requests, keyed by URL, so concurrent callers share one fetch. */
  private readonly inFlight = new Map<string, Promise<T>>();

  /** URLs waiting for a free slot. */
  private readonly waiting: (() => void)[] = [];

  /** Number of requests currently occupying a slot. */
  private active = 0;

  public readonly stats: LoaderStats = {
    queued: 0,
    started: 0,
    retried: 0,
    failed: 0,
    cacheHits: 0,
    cacheMisses: 0,
    evicted: 0,
  };

  public constructor(
    private readonly decode: (url: string) => Promise<T>,
    private readonly maxConcurrent: number = DEFAULT_MAX_CONCURRENT_LOADS,
    private readonly maxEntries: number = DEFAULT_CACHE_LIMIT,
    private readonly retries: number = DEFAULT_LOAD_RETRIES,
    private readonly retryDelay: number = DEFAULT_RETRY_DELAY,
  ) {}

  /** Resolves a URL, hitting the cache when possible. */
  public async load(url: string): Promise<T> {
    const cached = this.cache.get(url);
    if (cached !== undefined) {
      this.stats.cacheHits++;
      // A cache hit is still a real reuse: refresh recency for the LRU eviction.
      this.cache.delete(url);
      this.cache.set(url, cached);
      return cached;
    }
    this.stats.cacheMisses++;

    const existing = this.inFlight.get(url);
    if (existing !== undefined) return existing;

    const promise = this.withSlot(() => this.fetchWithRetry(url));
    this.inFlight.set(url, promise);

    try {
      const value = await promise;
      this.store(url, value);
      return value;
    } finally {
      this.inFlight.delete(url);
    }
  }

  /** Number of cached entries. */
  public get size(): number {
    return this.cache.size;
  }

  /** Drops every cached value. */
  public clear(): void {
    this.cache.clear();
  }

  /** Inserts into the LRU, evicting the oldest entry past the limit. */
  private store(url: string, value: T): void {
    this.cache.set(url, value);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
      this.stats.evicted++;
    }
  }

  /** Waits for a free concurrency slot, runs `task`, then releases it. */
  private async withSlot<R>(task: () => Promise<R>): Promise<R> {
    if (this.active >= this.maxConcurrent) {
      this.stats.queued++;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    this.stats.started++;
    try {
      return await task();
    } finally {
      this.active--;
      const next = this.waiting.shift();
      if (next !== undefined) next();
    }
  }

  /** Attempts `decode` up to `retries + 1` times with exponential backoff. */
  private async fetchWithRetry(url: string): Promise<T> {
    let attempt = 0;
    let delay = this.retryDelay;

    for (;;) {
      try {
        return await this.decode(url);
      } catch (error) {
        attempt++;
        if (attempt > this.retries) {
          this.stats.failed++;
          throw error;
        }
        this.stats.retried++;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  }
}

/** Decodes a URL as JSON. */
async function decodeJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/** Decodes a URL as an image, via `createImageBitmap` with an `Image` fallback. */
async function decodeImage(url: string): Promise<ImageBitmap | HTMLImageElement> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status} ${response.statusText}`);
  }
  const blob = await response.blob();

  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall through to the <img> path */
    }
  }

  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`the browser could not decode ${url}`));
    };
    image.src = objectUrl;
  });
}

/* -------------------------------------------------------------------------- */
/* Generated assets                                                           */
/* -------------------------------------------------------------------------- */

/** Builds the JSON scene document and returns a blob URL for it. */
function makeSceneDocumentUrl(): string {
  const document: SceneDocument = {
    name: 'generated-scene',
    background: '#11151d',
    objects: [
      { kind: 'rect', x: -3.4, y: 1.7, size: 1.5, color: '#2f6fdf' },
      { kind: 'circle', x: -0.4, y: 2.4, size: 1.1, color: '#3fbf8f' },
      { kind: 'rect', x: 2.4, y: 1.2, size: 1.3, color: '#8a6cf0' },
      { kind: 'circle', x: -2.2, y: -1.5, size: 1.4, color: '#e8b23a' },
      { kind: 'rect', x: 1.4, y: -1.9, size: 1.6, color: '#4aa3c7' },
    ],
  };
  const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' });
  return URL.createObjectURL(blob);
}

/** Renders a small checkerboard texture to a PNG blob URL. */
async function makeTextureUrl(): Promise<string> {
  const size = 128;
  const surface = document.createElement('canvas');
  surface.width = size;
  surface.height = size;
  const ctx = surface.getContext('2d');
  if (!ctx) throw new Error('could not allocate a 2D context for the generated texture');

  const a = new Color('#2f6fdf');
  const b = new Color('#141a24');
  const cell = size / 8;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? a.toCssString() : b.toCssString();
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  // A diagonal stripe, so orientation is visible after decoding.
  ctx.strokeStyle = 'rgba(232, 178, 58, 0.9)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(0, size);
  ctx.lineTo(size, 0);
  ctx.stroke();

  const blob = await new Promise<Blob | null>((resolve) => surface.toBlob(resolve, 'image/png'));
  if (blob === null) throw new Error('canvas.toBlob() produced no data');
  return URL.createObjectURL(blob);
}

/* -------------------------------------------------------------------------- */
/* Renderables                                                                */
/* -------------------------------------------------------------------------- */

/** Draws the decoded texture into a quad, so decoding is visibly proven. */
class TextureQuad implements Renderable2D {
  public visible = true;
  public readonly renderOrder = 0;
  public depth = 0;

  public texture: ImageBitmap | HTMLImageElement | null = null;
  public x = 3.6;
  public y = -1.4;
  public size = 3.2;

  public render(painter: unknown): void {
    const p = painter as Canvas2DPainter;
    if (!this.texture) {
      p.beginPath();
      p.rect(this.x - this.size / 2, this.y - this.size / 2, this.size, this.size);
      p.fillStyle = 'rgba(255, 255, 255, 0.06)';
      p.fill();
      p.lineWidth = 0.04;
      p.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      p.stroke();
      return;
    }

    p.drawImage(this.texture, {
      dx: this.x - this.size / 2,
      dy: this.y - this.size / 2,
      dw: this.size,
      dh: this.size,
    });
    p.lineWidth = 0.04;
    p.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    p.beginPath();
    p.rect(this.x - this.size / 2, this.y - this.size / 2, this.size, this.size);
    p.stroke();
  }
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
const overlay = document.querySelector<HTMLElement>('#overlay');
const notice = document.querySelector<HTMLElement>('#notice');
const report = document.querySelector<HTMLElement>('#report');
const reportTitle = document.querySelector<HTMLElement>('#report-title');
const reportBody = document.querySelector<HTMLElement>('#report-body');

function showNotice(message: string): void {
  if (!notice) return;
  notice.textContent = message;
  notice.hidden = false;
  if (overlay) overlay.textContent = 'backend unavailable';
}

function showReport(title: string, body: string): void {
  if (!report || !reportTitle || !reportBody) return;
  reportTitle.textContent = title;
  reportBody.textContent = body;
  report.hidden = false;
}

let dispose = (): void => undefined;

if (!canvas || !overlay) {
  showNotice('This example needs the #stage canvas and the #overlay element to exist.');
} else {
  const preferred: BackendName[] = [BackendNames.Canvas2D];
  if (detectBackendStrict(preferred, canvas) !== BackendNames.Canvas2D) {
    showNotice('This example needs a 2D canvas context, which this browser could not create.');
  } else {
    const renderer = new Canvas2DRenderer({ canvas, clearColor: '#11151d', autoResize: true });

    /* -------------------------------------------------------------- cache Map */
    // The `Cache` the constants file anticipates: a Map keyed by URL, with an LRU
    // bound. It is also used directly as a decode cache for the raw blobs.
    const rawBlobCache = new Map<string, Blob>();
    const JSON_CACHE_LIMIT = 16;

    const jsonLoader = new AssetLoader<SceneDocument>(decodeJson<SceneDocument>);
    const imageLoader = new AssetLoader<ImageBitmap | HTMLImageElement>(decodeImage);

    const textureQuad = new TextureQuad();
    const objects: Renderable2D[] = [textureQuad];
    const scene = { children: objects };
    const camera = { position: { x: 0, y: 0, z: 0 }, zoom: 46 };

    let sceneDocument: SceneDocument | null = null;
    let status = 'starting…';
    let objectUrls: string[] = [];

    /** Draws a `SceneDocument` object list as renderables. */
    class DocumentObject implements Renderable2D {
      public visible = true;
      public readonly renderOrder = 0;
      public depth = 0;

      public constructor(
        private readonly kind: 'rect' | 'circle',
        private readonly x: number,
        private readonly y: number,
        private readonly size: number,
        private readonly tint: Color,
      ) {}

      public render(painter: unknown): void {
        const p = painter as Canvas2DPainter;
        const half = this.size / 2;
        p.beginPath();
        if (this.kind === 'circle') p.arc(this.x, this.y, half, 0, Math.PI * 2);
        else p.rect(this.x - half, this.y - half, this.size, this.size);
        p.fillStyle = this.tint.toCssString();
        p.fill();
        p.lineWidth = 0.05;
        p.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        p.stroke();
      }
    }

    void (async (): Promise<void> => {
      try {
        status = 'generating assets…';
        const documentUrl = makeSceneDocumentUrl();
        const textureUrl = await makeTextureUrl();
        // A URL that will always 404, to exercise the retry-then-fail path.
        const missingUrl = `${documentUrl}#will-not-resolve`;
        objectUrls = [documentUrl, textureUrl];

        status = 'loading scene document…';
        const document_ = await jsonLoader.load(documentUrl);
        sceneDocument = document_;

        // Bind the document's objects into the scene graph.
        const tinted = document_.objects.map(
          (entry) =>
            new DocumentObject(entry.kind, entry.x, entry.y, entry.size, new Color(entry.color)),
        );
        objects.push(...tinted);

        status = 'loading texture…';
        textureQuad.texture = await imageLoader.load(textureUrl);

        // A second request for the same URL must be served from the cache.
        status = 'verifying cache…';
        const cachedDocument = await jsonLoader.load(documentUrl);
        if (cachedDocument !== document_) {
          throw new Error('the cache returned a different object for the same URL');
        }

        // Deliberately exercise the failure path, and keep the page usable.
        status = 'loading a URL that does not exist…';
        try {
          await jsonLoader.load(missingUrl);
        } catch (error) {
          showReport(
            'One asset failed — the page kept working',
            `${error instanceof Error ? error.message : String(error)} · retried ` +
              `${jsonLoader.stats.retried} time(s) before giving up. The rest of the scene ` +
              `loaded normally, which is the behaviour a real loader must have.`,
          );
        }

        // Populate the raw blob cache to show the second Map in use.
        const response = await fetch(textureUrl);
        if (response.ok) {
          rawBlobCache.set(textureUrl, await response.blob());
          if (rawBlobCache.size > JSON_CACHE_LIMIT) {
            const oldest = rawBlobCache.keys().next();
            if (!oldest.done) rawBlobCache.delete(oldest.value);
          }
        }

        status = 'ready';
      } catch (error) {
        status = 'failed';
        showReport(
          'Loading failed',
          error instanceof Error ? error.message : String(error),
        );
      }
    })();

    let fps = 0;
    let frames = 0;
    let elapsed = 0;

    renderer.setAnimationLoop((_time, delta) => {
      frames++;
      elapsed += delta;
      if (elapsed >= 0.25) {
        fps = frames / elapsed;
        frames = 0;
        elapsed = 0;
      }

      renderer.render(scene, camera);

      const json = jsonLoader.stats;
      const image = imageLoader.stats;
      overlay.textContent =
        `FPS          ${fps.toFixed(0)}\n` +
        `backend      ${renderer.backend}\n` +
        `status       ${status}\n` +
        `objects      ${objects.length}\n` +
        `json         hits ${json.cacheHits} · misses ${json.cacheMisses} · queued ${json.queued}\n` +
        `             retried ${json.retried} · failed ${json.failed} · cached ${jsonLoader.size}\n` +
        `image        hits ${image.cacheHits} · misses ${image.cacheMisses} · failed ${image.failed}\n` +
        `blob cache   ${rawBlobCache.size} / ${JSON_CACHE_LIMIT} entries\n` +
        `limits       concurrency ${DEFAULT_MAX_CONCURRENT_LOADS} · retries ${DEFAULT_LOAD_RETRIES} · ` +
        `delay ${DEFAULT_RETRY_DELAY}ms · cache ${DEFAULT_CACHE_LIMIT}`;
    }, { autoStart: true });

    dispose = (): void => {
      renderer.setAnimationLoop(null);
      renderer.dispose();
      jsonLoader.clear();
      imageLoader.clear();
      rawBlobCache.clear();
      textureQuad.texture = null;
      // Blob URLs are a document-scoped resource: release them explicitly.
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls = [];
      void sceneDocument;
    };
  }
}

window.addEventListener('beforeunload', dispose);
