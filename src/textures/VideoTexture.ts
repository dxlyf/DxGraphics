/**
 * `VideoTexture` — a texture that follows a playing `<video>`.
 *
 * The class polls the video element instead of asking the renderer to: when
 * `requestVideoFrameCallback` exists it is used (the browser then only wakes the
 * texture when a *new* frame was decoded), otherwise a `setInterval` timer stands
 * in at a configurable rate.
 *
 * ```ts
 * const video = document.querySelector('video');
 * const texture = new VideoTexture(video);
 * texture.start();   // re-uploads every decoded frame
 * // ...
 * texture.stop();
 * ```
 *
 * @packageDocumentation
 */

import { Mapping, TextureFilter, type TextureSource } from './types';
import { Texture } from './Texture';

/** The subset of `HTMLVideoElement` this class drives. */
interface VideoLike {
  readyState?: number;
  videoWidth?: number;
  videoHeight?: number;
  currentTime?: number;
  requestVideoFrameCallback?: (callback: (now: number, metadata: unknown) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

/** Options accepted by {@link VideoTexture}. */
export interface VideoTextureOptions {
  /** Sampling-space interpretation. Defaults to `Mapping.UVMapping`. */
  mapping?: Mapping;
  /** Start polling in the constructor. Defaults to `true`. */
  autoStart?: boolean;
  /**
   * Fallback polling interval in milliseconds, used when the element has no
   * `requestVideoFrameCallback`. Defaults to `1000 / 30`.
   */
  fallbackInterval?: number;
  /** Mipmap generation. Defaults to `false`: video frames change every tick. */
  generateMipmaps?: boolean;
}

/**
 * A texture whose contents follow a video element.
 */
export class VideoTexture extends Texture<'VideoTexture'> {
  /** Human-readable label used in diagnostics. */
  public override readonly label = 'VideoTexture' as const;

  /** `true` while the texture is polling the element. */
  public autoUpdate: boolean = true;

  /** Fallback polling interval, in milliseconds. */
  public readonly fallbackInterval: number;

  /** Handle of the pending `requestVideoFrameCallback`, when in use. */
  private frameHandle: number | null = null;

  /** Handle of the fallback interval timer, when in use. */
  private timer: ReturnType<typeof setInterval> | null = null;

  /** `true` when the last seen frame was already uploaded. */
  private frameUploaded: boolean = false;

  /** Presentation time of the last uploaded frame. */
  private lastFrameTime: number = -1;

  /**
   * @param video Video element to follow.
   * @param options Polling and sampling options.
   */
  constructor(video: TextureSource | null = null, options: VideoTextureOptions = {}) {
    super(video, options.mapping ?? Mapping.UVMapping);
    this.fallbackInterval = Math.max(1, options.fallbackInterval ?? 1000 / 30);
    this.generateMipmaps = options.generateMipmaps ?? false;
    this.minFilter = this.generateMipmaps ? TextureFilter.LinearMipmapLinear : TextureFilter.Linear;
    this.magFilter = TextureFilter.Linear;
    this.flipY = true;
    if (options.autoStart ?? true) this.start();
  }

  /** The video element this texture follows, when one was attached. */
  public get video(): VideoLike | null {
    return (this.image as VideoLike | null) ?? null;
  }

  /** `true` while a frame callback or a fallback timer is pending. */
  public get isPolling(): boolean {
    return this.frameHandle !== null || this.timer !== null;
  }

  /* -------------------------------------------------------------- polling */

  /**
   * Starts following the element.
   *
   * Idempotent: a second call while polling does nothing.
   *
   * @returns This texture, for chaining.
   */
  public start(): this {
    if (this.isPolling) return this;
    const video = this.video;
    if (!video) return this;

    if (typeof video.requestVideoFrameCallback === 'function') {
      this.scheduleFrameCallback(video);
    } else {
      this.timer = setInterval(() => this.update(), this.fallbackInterval);
    }
    return this;
  }

  /**
   * Stops following the element.
   *
   * @returns This texture, for chaining.
   */
  public stop(): this {
    const video = this.video;
    if (this.frameHandle !== null && video?.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(this.frameHandle);
    }
    this.frameHandle = null;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this;
  }

  /**
   * Uploads the current frame when it changed.
   *
   * @returns `true` when the frame was new and {@link Texture.markNeedsUpdate}
   *   ran.
   */
  public update(): boolean {
    const video = this.video;
    if (!video || this.isDisposed) return false;

    const readyState = video.readyState ?? 0;
    if (readyState < 2) return false;

    const time = video.currentTime ?? 0;
    if (this.frameUploaded && time === this.lastFrameTime) return false;

    this.lastFrameTime = time;
    this.frameUploaded = true;
    this.markLoaded();
    this.markNeedsUpdate();
    return true;
  }

  /** Schedules the next `requestVideoFrameCallback`. */
  private scheduleFrameCallback(video: VideoLike): void {
    const callback = video.requestVideoFrameCallback;
    if (typeof callback !== 'function') return;
    this.frameHandle = callback.call(video, () => {
      this.frameHandle = null;
      this.update();
      if (this.autoUpdate && !this.isDisposed) this.scheduleFrameCallback(video);
    });
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    this.stop();
    super.onDispose();
  }
}
