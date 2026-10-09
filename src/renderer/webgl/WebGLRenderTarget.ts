/**
 * WebGL render target.
 *
 * Extends the backend-agnostic {@link RenderTarget}, which owns sizing, mipmap
 * counting, attachment slots and disposal semantics; this class only allocates the
 * GL objects.
 *
 * ## MSAA
 *
 * A multisampled framebuffer cannot be sampled by a shader, so an MSAA target keeps
 * two framebuffers: one holding multisampled renderbuffers that receives the draws,
 * and one holding the resolve textures. {@link WebGLRenderTarget.resolve} performs
 * the `blitFramebuffer` copy, and {@link WebGLRenderTarget.framebuffer} returns the
 * one a draw should bind.
 *
 * ## Context loss
 *
 * Every attachment is keyed to a context generation. {@link WebGLRenderTarget.isStale}
 * reports whether the handles predate the current generation, and
 * {@link WebGLRenderTarget.reinitialise} (inherited) reallocates them.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import type { IRenderTarget } from '../interfaces/IRenderTarget';
import {
  PixelFormat,
  TextureFilter,
  TextureWrap,
  type RenderTargetOptions,
} from '../interfaces/types';
import { RenderTarget, type ResolvedRenderTargetOptions } from '../core/RenderTarget';
import type { WebGLCapabilities } from './WebGLCapabilities';
import type { WebGLExtensions } from './WebGLExtensions';
import { WebGLFramebuffer } from './WebGLFramebuffer';
import { WebGLTexture } from './WebGLTexture';
import { glConst, isDepthFormat } from './WebGLUtils';

/** Logger for render-target diagnostics. */
const log = createLogger('renderer:webgl:target');

/** Context plumbing a render target needs. */
export interface WebGLRenderTargetContext {
  /** Context the target allocates on. */
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  /** `true` when the context is WebGL2. */
  isWebGL2?: boolean;
  /** Capability report, used to clamp sample counts. */
  capabilities?: WebGLCapabilities | null;
  /** Extension cache. */
  extensions?: WebGLExtensions | null;
  /** Context generation counter, for staleness checks. */
  generation?: number;
}

/**
 * An off-screen colour (plus optional depth) destination.
 *
 * ```ts
 * const target = new WebGLRenderTarget({ width: 1024, height: 1024, samples: 4 }, ctx);
 * renderer.setRenderTarget(target);
 * // ... draw ...
 * renderer.setRenderTarget(null);
 * target.resolve();          // MSAA: copy the renderbuffers into the textures
 * ```
 */
export class WebGLRenderTarget extends RenderTarget implements IRenderTarget {
  /** Context the target allocates on. */
  private readonly context: WebGLRenderTargetContext;

  /** `true` when the context is WebGL2. */
  private readonly isWebGL2: boolean;

  /** Framebuffer that receives draws (`FRAMEBUFFER`/`DRAW_FRAMEBUFFER`). */
  private drawFramebuffer: WebGLFramebuffer | null = null;

  /** Framebuffer holding the resolve textures when the target is multisampled. */
  private resolveFramebuffer: WebGLFramebuffer | null = null;

  /** `true` when a resolve blit is pending. */
  private needsResolve: boolean = false;

  /** Context generation the attachments were created in. */
  private allocationGeneration: number = 0;

  /**
   * Creates and allocates a render target.
   *
   * @param options Requested dimensions, formats and attachments.
   * @param context Context plumbing.
   */
  constructor(options: RenderTargetOptions, context: WebGLRenderTargetContext) {
    super(options, (context.isWebGL2 ?? true) ? 'webgl2' : 'webgl');
    this.context = context;
    this.isWebGL2 = context.isWebGL2 ?? true;
    this.allocationGeneration = context.generation ?? 0;
    this.initialise();
  }

  /* ------------------------------------------------------------------ access */

  /** Framebuffer a draw should bind. */
  public get framebuffer(): WebGLFramebuffer {
    const framebuffer = this.drawFramebuffer;
    if (framebuffer === null) {
      throw new Error(
        `WebGLRenderTarget(${this.id}): the target has no framebuffer. It was either disposed ` +
          'or never initialised; create a new target, or call reinitialise().',
      );
    }
    return framebuffer;
  }

  /** Framebuffer holding the resolve textures, or `null` when not multisampled. */
  public get resolveTarget(): WebGLFramebuffer | null {
    return this.resolveFramebuffer;
  }

  /** `true` when {@link WebGLRenderTarget.samples} is greater than one. */
  public get isMultisampled(): boolean {
    return this.samples > 1;
  }

  /** Context generation the attachments were allocated in. */
  public get generation(): number {
    return this.allocationGeneration;
  }

  /**
   * `true` when the target's handles predate the current context generation.
   *
   * The renderer calls this after a context restore and calls `reinitialise()` when
   * it returns `true`.
   *
   * @param generation Current context generation.
   */
  public isStale(generation: number): boolean {
    return this.allocationGeneration !== generation;
  }

  /* ---------------------------------------------------------------- plumbing */

  /**
   * Binds the framebuffer that receives draws.
   *
   * @returns This target, for chaining.
   */
  public bind(): this {
    this.framebuffer.bind('draw');
    return this;
  }

  /** Unbinds, returning to the canvas' default framebuffer. */
  public unbind(): void {
    const gl = this.context.gl;
    gl.bindFramebuffer(glConst(gl, 'FRAMEBUFFER', 0x8d40), null);
  }

  /**
   * Resolves the multisampled attachments into the sampleable textures.
   *
   * A no-op for single-sampled targets.
   *
   * @returns `true` when a blit was issued.
   */
  public resolve(): boolean {
    if (!this.needsResolve || this.drawFramebuffer === null || this.resolveFramebuffer === null) return false;
    const resolved = this.resolveFramebuffer.blitColor(this.drawFramebuffer, this.width, this.height);
    if (resolved) this.needsResolve = false;
    return resolved;
  }

  /**
   * Reports whether a resolve is pending.
   *
   * @returns `true` when {@link WebGLRenderTarget.resolve} still has work to do.
   */
  public get hasPendingResolve(): boolean {
    return this.needsResolve;
  }

  /* ------------------------------------------------------- RenderTarget hooks */

  /** @inheritdoc */
  protected override createAttachments(options: ResolvedRenderTargetOptions): void {
    const context = this.context;
    const gl = context.gl;
    const capabilities = context.capabilities ?? null;
    const samples = capabilities !== null ? capabilities.clampSamples(options.samples) : Math.max(1, options.samples);

    if (options.samples > 1 && samples === 1) {
      log.warn(
        `WebGLRenderTarget(${this.id}): ${options.samples}x MSAA was requested but this context ` +
          'cannot multisample; falling back to a single-sampled target.',
      );
    }

    const depthFormat = options.depth
      ? resolveDepthFormat(options.depthFormat, options.stencil, this.isWebGL2)
      : PixelFormat.Depth24Stencil8;

    const attachmentCount = Math.max(1, options.colorAttachments);
    const mipmaps = options.mipmaps === true;
    const resolveTarget = new WebGLFramebuffer(gl, {
      isWebGL2: this.isWebGL2,
      label: `${this.id}-resolve`,
    });

    for (let index = 0; index < attachmentCount; index++) {
      const texture = new WebGLTexture(
        { ...context, isWebGL2: this.isWebGL2 },
        {
          width: options.width,
          height: options.height,
          format: options.format,
          magFilter: options.filter,
          minFilter: mipmaps ? TextureFilter.LinearMipmapLinear : options.filter,
          wrapS: options.wrap,
          wrapT: options.wrap,
          mipmaps,
          label: `${this.id}-color${index}`,
        },
      );
      texture.setGeneration(this.allocationGeneration);
      texture.allocate();
      resolveTarget.attachColorTexture(texture, index, options.format, options.width, options.height);
      this.colorAttachments[index] = texture;
    }

    if (options.depth) {
      const depthTexture = new WebGLTexture(
        { ...context, isWebGL2: this.isWebGL2 },
        {
          width: options.width,
          height: options.height,
          format: depthFormat,
          magFilter: TextureFilter.Nearest,
          minFilter: TextureFilter.Nearest,
          wrapS: TextureWrap.ClampToEdge,
          wrapT: TextureWrap.ClampToEdge,
          label: `${this.id}-depth`,
        },
      );
      depthTexture.setGeneration(this.allocationGeneration);
      depthTexture.allocate();
      resolveTarget.attachDepthTexture(depthTexture, depthFormat, options.width, options.height);
      this.depthAttachment = depthTexture;
    }

    if (samples > 1) {
      const msaaTarget = new WebGLFramebuffer(gl, { isWebGL2: this.isWebGL2, label: `${this.id}-msaa` });
      for (let index = 0; index < attachmentCount; index++) {
        msaaTarget.attachColorRenderbuffer(index, options.width, options.height, options.format, samples);
      }
      if (options.depth) {
        msaaTarget.attachDepthRenderbuffer(options.width, options.height, depthFormat, samples);
      }
      this.drawFramebuffer = msaaTarget;
      this.resolveFramebuffer = resolveTarget;
      this.needsResolve = true;
    } else {
      this.drawFramebuffer = resolveTarget;
      this.resolveFramebuffer = null;
      this.needsResolve = false;
    }

    const status = this.drawFramebuffer.checkStatus();
    if (!status.complete) {
      log.error(status.reason);
    }

    log.debug(`created ${this.toString()}`);
  }

  /** @inheritdoc */
  protected override releaseAttachments(): void {
    for (let index = 0; index < this.colorAttachments.length; index++) {
      const texture = this.colorAttachments[index];
      texture?.dispose();
      this.colorAttachments[index] = null;
    }
    this.depthAttachment?.dispose();
    this.depthAttachment = null;

    this.drawFramebuffer?.dispose();
    this.drawFramebuffer = null;
    this.resolveFramebuffer?.dispose();
    this.resolveFramebuffer = null;
    this.needsResolve = false;
  }

  /** @inheritdoc */
  protected override readPixelsFromTarget(
    x: number,
    y: number,
    width: number,
    height: number,
  ): Uint8ClampedArray | null {
    // A pending resolve means the sampleable texture is one blit out of date.
    this.resolve();
    const framebuffer = this.drawFramebuffer;
    if (framebuffer === null) return null;
    return framebuffer.readPixels(x, y, width, height, this.format);
  }

  /**
   * Records the context generation the attachments now belong to.
   *
   * @param generation Current context generation.
   */
  public setGeneration(generation: number): void {
    this.allocationGeneration = generation;
    for (const attachment of this.colorAttachments) {
      if (attachment instanceof WebGLTexture) attachment.setGeneration(generation);
    }
    if (this.depthAttachment instanceof WebGLTexture) this.depthAttachment.setGeneration(generation);
  }

  /** @inheritdoc */
  public override dispose(): void {
    if (this.isDisposed) return;
    super.dispose();
    this.drawFramebuffer = null;
    this.resolveFramebuffer = null;
    this.needsResolve = false;
  }

  /** @returns A human-readable description. */
  public override toString(): string {
    return (
      `WebGLRenderTarget(${this.id}, ${this.width}x${this.height}, format=${this.format}, ` +
      `samples=${this.samples}, depth=${this.depthTexture !== null})`
    );
  }
}

/**
 * Chooses a depth format the context can actually attach.
 *
 * `DEPTH24_STENCIL8` is only guaranteed on WebGL2 (WebGL1 reaches it through
 * `WEBGL_depth_texture`, and some drivers accept the renderbuffer form but not the
 * texture form), so a WebGL1 context falls back to 16-bit depth when no stencil was
 * requested.
 *
 * @param requested Caller-requested format.
 * @param stencil Whether a stencil buffer was requested.
 * @param isWebGL2 Whether the context is WebGL2.
 */
export function resolveDepthFormat(requested: PixelFormat, stencil: boolean, isWebGL2: boolean): PixelFormat {
  if (!isWebGL2) {
    if (requested === PixelFormat.Depth32F) return PixelFormat.Depth16;
    if (requested === PixelFormat.Depth24Stencil8 && !stencil) return PixelFormat.Depth16;
    return PixelFormat.Depth16;
  }
  if (stencil && !isDepthFormat(requested)) return PixelFormat.Depth24Stencil8;
  return requested;
}

/** Type guard used by tests and the renderer. */
export function isWebGLRenderTarget(value: unknown): value is WebGLRenderTarget {
  return value instanceof WebGLRenderTarget;
}
