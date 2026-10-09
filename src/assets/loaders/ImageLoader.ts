/**
 * `ImageLoader` — decoded bitmaps for textures, sprites and 2D fills.
 *
 * Bitmap decoding has exactly one hard requirement — a real host — so the interesting
 * design decisions here are about *testability* and *memory*:
 *
 * - **Injectable decode.** `setDecoder(fn)` replaces the host path entirely. A unit
 *   test supplies a 2×2 fake and exercises progress, retry and error handling
 *   without a canvas; a worker supplies `createImageBitmap`.
 * - **Transport choice.** `fetch` + `createImageBitmap` is preferred (it can be
 *   aborted and keeps the decoded bytes off the DOM), with `HTMLImageElement` as the
 *   fallback for hosts without `createImageBitmap`.
 * - **Explicit release.** A decoded bitmap is GPU-adjacent memory, so
 *   {@link ImageLoader.release} calls `close()` when the host provides it. That is
 *   the difference between an editor that streams sprites forever and one that leaks
 *   until the tab dies.
 *
 * ```ts
 * const loader = new ImageLoader();
 * loader.setDecoder(async (bytes) => createImageBitmap(new Blob([bytes])));
 * const bitmap = await loader.loadAsync('sprite.png');
 * ```
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import { Loader, LoadAbortError, type LoadedSource } from './Loader';
import type { FetchLike, ImageDecoder, ImageLike, LoadOptions } from '../types';

/** Logger shared by the image loader. */
const log = createLogger('assets:image');

/** Options accepted by {@link ImageLoader.loadAsync}. */
export interface ImageLoadOptions extends LoadOptions {
  /** `fetch` implementation override. */
  fetcher?: FetchLike;
  /** Decoder override; takes precedence over the loader's own. */
  decoder?: ImageDecoder;
  /** MIME type assumed when the server does not report one. */
  mimeType?: string;
  /** `crossOrigin` applied to the `HTMLImageElement` fallback. */
  crossOrigin?: string;
}

/**
 * Decodes PNG, JPEG, WebP, GIF, AVIF and SVG into bitmaps.
 */
export class ImageLoader extends Loader<ImageLike, ArrayBuffer> {
  /** `fetch` implementation in use. */
  public fetcher: FetchLike | null = null;

  /** Decode override; `null` uses the host path. */
  public decoder: ImageDecoder | null = null;

  /** MIME type assumed when the server reports none. */
  public mimeType = 'image/png';

  /** MIME type observed on the most recent load. */
  public lastMimeType = '';

  /** Number of bitmaps this loader has handed out. */
  public decodedCount = 0;

  /**
   * Creates an image loader.
   *
   * @param options Transport and decoder overrides.
   */
  constructor(options: ImageLoadOptions = {}) {
    super();
    this.fetcher = options.fetcher ?? null;
    this.decoder = options.decoder ?? null;
    this.mimeType = options.mimeType ?? 'image/png';
  }

  /**
   * Installs a decoder, replacing the host path.
   *
   * @param decoder Decoder, or `null` to fall back to the host.
   * @returns This loader, for chaining.
   */
  public setDecoder(decoder: ImageDecoder | null): this {
    this.decoder = decoder;
    return this;
  }

  /**
   * Installs a `fetch` implementation.
   *
   * @param fetcher Fetcher, or `null` for the global one.
   * @returns This loader, for chaining.
   */
  public setFetcher(fetcher: FetchLike | null): this {
    this.fetcher = fetcher;
    return this;
  }

  /**
   * Sets the MIME type assumed when the server reports none.
   *
   * @param mimeType MIME type.
   * @returns This loader, for chaining.
   */
  public setMimeType(mimeType: string): this {
    this.mimeType = mimeType;
    return this;
  }

  /**
   * @inheritdoc
   *
   * Downloads the bytes; the decode happens in {@link ImageLoader.parse}.
   */
  protected override async loadData(url: string, options: LoadOptions): Promise<LoadedSource<ArrayBuffer>> {
    const imageOptions = options as ImageLoadOptions;
    const fetcher = this.resolveFetcher(imageOptions);

    if (fetcher === null) {
      throw new Error(
        `ImageLoader("${url}"): no \`fetch\` implementation is available. Pass \`fetcher\` ` +
          'when running on a host without it.',
      );
    }

    const headers: Record<string, string> = { ...this.requestHeaders };
    if (this.crossOrigin.length > 0) headers['X-Cross-Origin'] = this.crossOrigin;

    const response = await fetcher(url, {
      method: 'GET',
      headers,
      credentials: this.withCredentials ? 'include' : 'same-origin',
      ...(this.crossOrigin.length > 0 ? { mode: 'cors' } : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (response.ok === false) {
      throw new Error(`ImageLoader("${url}"): HTTP ${response.status ?? '?'} ${response.statusText ?? ''}`.trim());
    }

    const mime = response.headers?.get('content-type') ?? imageOptions.mimeType ?? this.mimeType;
    this.lastMimeType = mime;

    const bytes = await response.arrayBuffer();
    this.reportProgress(url, bytes.byteLength, bytes.byteLength, options);

    return { data: bytes, fromCache: false, byteLength: bytes.byteLength };
  }

  /**
   * @inheritdoc
   *
   * Decodes the downloaded bytes, preferring `createImageBitmap` and falling back to
   * an `HTMLImageElement` built from a blob URL.
   */
  public override async parse(
    source: ArrayBuffer,
    url?: string,
    options?: LoadOptions,
  ): Promise<ImageLike> {
    const imageOptions = (options ?? {}) as ImageLoadOptions;
    const decoder = imageOptions.decoder ?? this.decoder;

    if (decoder !== null) {
      const decoded = await decoder(source, this.lastMimeType || this.mimeType);
      this.decodedCount++;
      return decoded;
    }

    const globalDecoder = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    if (typeof globalDecoder === 'function') {
      const blob = createBlob(source, this.lastMimeType || this.mimeType);
      const bitmap = await (globalDecoder as (input: unknown) => Promise<ImageLike>).call(
        globalThis,
        blob,
      );
      this.decodedCount++;
      return bitmap;
    }

    return this.decodeWithImageElement(source, url ?? '<bytes>');
  }

  /** `HTMLImageElement` fallback: object URL plus a decode promise. */
  private decodeWithImageElement(source: ArrayBuffer, url: string): Promise<ImageLike> {
    const ImageCtor = (globalThis as { Image?: unknown }).Image;
    const URLImpl = (globalThis as { URL?: unknown }).URL as
      | { createObjectURL?(blob: unknown): string; revokeObjectURL?(url: string): void }
      | undefined;

    if (typeof ImageCtor !== 'function' || URLImpl === undefined || typeof URLImpl.createObjectURL !== 'function') {
      throw new Error(
        `ImageLoader("${url}"): this host provides neither \`createImageBitmap\` nor ` +
          '`Image` + `URL.createObjectURL`. Pass a `decoder` to supply your own path ' +
          '(for example a worker-side decoder).',
      );
    }

    const objectUrl = URLImpl.createObjectURL(createBlob(source, this.lastMimeType || this.mimeType));

    return new Promise<ImageLike>((resolve, reject) => {
      const element = new (ImageCtor as new () => ImageLike & {
        onload: (() => void) | null;
        onerror: ((error: unknown) => void) | null;
        src: string;
      })();

      const cleanup = (): void => {
        URLImpl.revokeObjectURL?.(objectUrl);
      };

      const unregister = this.onAbort(() => {
        cleanup();
        reject(new LoadAbortError(url));
      });

      element.onload = () => {
        unregister();
        cleanup();
        this.decodedCount++;
        resolve(element);
      };
      element.onerror = (error: unknown) => {
        unregister();
        cleanup();
        reject(new Error(`ImageLoader("${url}"): the image failed to decode (${String(error)})`));
      };

      element.src = objectUrl;
    });
  }

  /**
   * Releases a decoded bitmap.
   *
   * A no-op on hosts whose bitmaps have no `close`; call it from a texture's
   * `dispose` so a long-lived editor does not accumulate decoded images.
   *
   * @param image Bitmap to release.
   * @returns `true` when the host released it.
   */
  public release(image: ImageLike | null | undefined): boolean {
    if (image == null) return false;
    if (typeof image.close === 'function') {
      image.close();
      this.decodedCount = Math.max(0, this.decodedCount - 1);
      return true;
    }
    return false;
  }

  /** Resolves the `fetch` implementation to use. */
  private resolveFetcher(options: ImageLoadOptions): FetchLike | null {
    if (options.fetcher !== undefined) return options.fetcher;
    if (this.fetcher !== null) return this.fetcher;
    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    return typeof globalFetch === 'function' ? (globalFetch as FetchLike) : null;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    super.onDispose();
    this.fetcher = null;
    this.decoder = null;
  }
}

/** Builds a `Blob` when the host has one, falling back to a plain record. */
function createBlob(bytes: ArrayBuffer, mimeType: string): unknown {
  const BlobCtor = (globalThis as { Blob?: unknown }).Blob;
  if (typeof BlobCtor === 'function') {
    return new (BlobCtor as new (parts: unknown[], options: { type: string }) => unknown)([bytes], {
      type: mimeType,
    });
  }
  log.debug('no Blob constructor; passing raw bytes to the decoder');
  return bytes;
}

/**
 * Convenience factory mirroring `new ImageLoader(options)`.
 *
 * @param options Transport and decoder overrides.
 * @returns A new image loader.
 */
export function imageLoader(options: ImageLoadOptions = {}): ImageLoader {
  return new ImageLoader(options);
}
