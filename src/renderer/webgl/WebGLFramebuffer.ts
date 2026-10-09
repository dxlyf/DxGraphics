/**
 * Framebuffer wrapper with actionable completeness diagnostics.
 *
 * `gl.checkFramebufferStatus` returns a bare enumeration. A render-to-texture pass
 * that silently renders nothing because the attachment combination is illegal is one
 * of the hardest bugs to find in a GPU renderer, so {@link WebGLFramebuffer.checkStatus}
 * translates every status the specification defines into a sentence that names the
 * likely cause.
 *
 * The wrapper also owns the MSAA plumbing: a multisampled framebuffer cannot be
 * sampled, so the target keeps a second framebuffer holding the resolve textures and
 * {@link WebGLFramebuffer.blitColor} copies between them.
 *
 * @packageDocumentation
 */

import { createId } from '../../utils/Id';
import { createLogger } from '../../utils/Logger';
import { PixelFormat } from '../interfaces/types';
import { bytesPerPixel, glConst, toGLFormat, type GL, type GLFramebufferObject } from './WebGLUtils';
/** Logger for framebuffer diagnostics. */
const log = createLogger('renderer:webgl:framebuffer');

/* -------------------------------------------------------------------------- */
/* Attachment bookkeeping                                                     */
/* -------------------------------------------------------------------------- */

/** Kind of attachment slot. */
export type FramebufferAttachmentKind = 'color' | 'depth' | 'depth-stencil';

/** One recorded attachment. */
export interface FramebufferAttachment {
  /** Slot kind. */
  readonly kind: FramebufferAttachmentKind;
  /** Colour attachment index; `0` for depth slots. */
  readonly index: number;
  /** GL attachment point. */
  readonly attachmentPoint: number;
  /** GL attachment target (`TEXTURE_2D` or `RENDERBUFFER`). */
  readonly target: number;
  /** Raw format the attachment was allocated with. */
  readonly format: PixelFormat;
  /** Width in device pixels. */
  readonly width: number;
  /** Height in device pixels. */
  readonly height: number;
  /** Sample count; `1` when not multisampled. */
  readonly samples: number;
}

/** Result of a completeness check. */
export interface FramebufferStatusReport {
  /** `true` when the framebuffer is `FRAMEBUFFER_COMPLETE`. */
  readonly complete: boolean;
  /** Raw status enumeration. */
  readonly status: number;
  /** Status name, e.g. `'FRAMEBUFFER_INCOMPLETE_ATTACHMENT'`. */
  readonly statusName: string;
  /** Human-readable explanation of what to change. */
  readonly reason: string;
}

/* -------------------------------------------------------------------------- */
/* WebGLFramebuffer                                                           */
/* -------------------------------------------------------------------------- */

/** Options accepted by {@link WebGLFramebuffer}. */
export interface WebGLFramebufferOptions {
  /** `true` when the context is WebGL2. */
  isWebGL2?: boolean;
  /** Human-readable label used in diagnostics. */
  label?: string;
}

/**
 * One framebuffer object plus the attachments bound into it.
 *
 * ```ts
 * const fbo = new WebGLFramebuffer(gl, { isWebGL2: true });
 * fbo.attachColorTexture(texture, 0);
 * fbo.attachDepthRenderbuffer(1024, 1024, PixelFormat.Depth24Stencil8);
 * const status = fbo.checkStatus();
 * if (!status.complete) throw new Error(status.reason);
 * ```
 */
export class WebGLFramebuffer {
  /** Stable identifier. */
  public readonly id: string;

  /** Context the framebuffer belongs to. */
  private readonly gl: GL;

  /** `true` when the context is WebGL2. */
  private readonly isWebGL2: boolean;

  /** Label used in diagnostics. */
  private readonly label: string;

  /** Native handle, or `null`. */
  private handle: GLFramebufferObject | null = null;

  /** Recorded attachments. */
  private readonly attachments: FramebufferAttachment[] = [];

  /** Renderbuffers this framebuffer owns and must delete. */
  private readonly renderbuffers: GLRenderbufferLike[] = [];

  /** `true` once {@link WebGLFramebuffer.dispose} has run. */
  private disposed: boolean = false;

  /**
   * Creates an (unbound) framebuffer.
   *
   * @param gl Context to create the framebuffer on.
   * @param options Context version and label.
   */
  constructor(gl: GL, options: WebGLFramebufferOptions = {}) {
    this.gl = gl;
    this.isWebGL2 = options.isWebGL2 ?? true;
    this.label = options.label ?? 'framebuffer';
    this.id = `webgl-framebuffer-${createId()}`;
  }

  /** Native handle, or `null`. */
  public get handleOrNull(): GLFramebufferObject | null {
    return this.handle;
  }

  /** `true` once a handle exists. */
  public get isInitialised(): boolean {
    return this.handle !== null;
  }

  /** `true` once {@link WebGLFramebuffer.dispose} has run. */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /** Recorded attachments, in the order they were bound. */
  public getAttachments(): readonly FramebufferAttachment[] {
    return this.attachments;
  }

  /**
   * Returns the native handle, creating it on first use.
   *
   * @returns The handle.
   * @throws Error When the context refuses to create the framebuffer.
   */
  public getHandle(): GLFramebufferObject {
    if (this.disposed) {
      throw new Error(`WebGLFramebuffer(${this.label}): the framebuffer has been disposed.`);
    }
    if (this.handle === null) {
      const handle = this.gl.createFramebuffer();
      if (handle === null) {
        throw new Error(
          `WebGLFramebuffer(${this.label}): gl.createFramebuffer returned null. The context ` +
            'is most likely lost, or the driver ran out of framebuffer objects.',
        );
      }
      this.handle = handle;
    }
    return this.handle;
  }

  /**
   * Binds the framebuffer.
   *
   * @param mode `'both'` (default), `'draw'` or `'read'`.
   * @returns This framebuffer, for chaining.
   */
  public bind(mode: 'both' | 'draw' | 'read' = 'both'): this {
    const handle = this.getHandle();
    const gl = this.gl;
    if (this.isWebGL2) {
      const gl2 = gl as WebGL2RenderingContext;
      if (mode === 'both' || mode === 'draw') gl2.bindFramebuffer(glConst(gl, 'DRAW_FRAMEBUFFER', 0x8ca9), handle);
      if (mode === 'both' || mode === 'read') gl2.bindFramebuffer(glConst(gl, 'READ_FRAMEBUFFER', 0x8ca8), handle);
      return this;
    }
    gl.bindFramebuffer(glConst(gl, 'FRAMEBUFFER', 0x8d40), handle);
    return this;
  }

  /** Binds the canvas' default framebuffer. */
  public unbind(): void {
    const gl = this.gl;
    const target = glConst(gl, 'FRAMEBUFFER', 0x8d40);
    gl.bindFramebuffer(target, null);
  }

  /**
   * Attaches a texture as a colour output.
   *
   * @param texture Native texture handle.
   * @param index Colour attachment index.
   * @param format Format the texture was allocated with.
   * @param width Texture width in device pixels.
   * @param height Texture height in device pixels.
   * @returns This framebuffer, for chaining.
   */
  public attachColorTexture(
    texture: WebGLTexture,
    index: number = 0,
    format: PixelFormat = PixelFormat.RGBA8,
    width: number = 1,
    height: number = 1,
  ): this {
    const gl = this.gl;
    const target = glConst(gl, 'FRAMEBUFFER', 0x8d40);
    const point = glConst(gl, 'COLOR_ATTACHMENT0', 0x8ce0) + Math.max(0, index);
    this.bind('draw');
    gl.framebufferTexture2D(target, point, glConst(gl, 'TEXTURE_2D', 0x0de1), texture, 0);
    this.record({ kind: 'color', index, attachmentPoint: point, target: glConst(gl, 'TEXTURE_2D', 0x0de1), format, width, height, samples: 1 });
    this.setDrawBuffers(index + 1);
    return this;
  }

  /**
   * Attaches a texture as the depth (or depth/stencil) output.
   *
   * @param texture Native texture handle.
   * @param format Format the texture was allocated with.
   * @param width Texture width in device pixels.
   * @param height Texture height in device pixels.
   * @returns This framebuffer, for chaining.
   */
  public attachDepthTexture(
    texture: WebGLTexture,
    format: PixelFormat = PixelFormat.Depth24Stencil8,
    width: number = 1,
    height: number = 1,
  ): this {
    const gl = this.gl;
    const target = glConst(gl, 'FRAMEBUFFER', 0x8d40);
    const isStencil = format === PixelFormat.Depth24Stencil8;
    const point = isStencil
      ? glConst(gl, 'DEPTH_STENCIL_ATTACHMENT', 0x821a)
      : glConst(gl, 'DEPTH_ATTACHMENT', 0x8d00);

    this.bind('draw');
    gl.framebufferTexture2D(target, point, glConst(gl, 'TEXTURE_2D', 0x0de1), texture, 0);
    this.record({
      kind: isStencil ? 'depth-stencil' : 'depth',
      index: 0,
      attachmentPoint: point,
      target: glConst(gl, 'TEXTURE_2D', 0x0de1),
      format,
      width,
      height,
      samples: 1,
    });
    return this;
  }

  /**
   * Allocates and attaches a depth (or depth/stencil) renderbuffer.
   *
   * @param width Width in device pixels.
   * @param height Height in device pixels.
   * @param format Depth format.
   * @param samples Sample count; `>1` allocates a multisampled buffer on WebGL2.
   * @returns This framebuffer, for chaining.
   */
  public attachDepthRenderbuffer(
    width: number,
    height: number,
    format: PixelFormat = PixelFormat.Depth24Stencil8,
    samples: number = 1,
  ): this {
    const gl = this.gl;
    const target = glConst(gl, 'FRAMEBUFFER', 0x8d40);
    const descriptor = toGLFormat(gl, format, { webgl2: this.isWebGL2 });
    const isStencil = format === PixelFormat.Depth24Stencil8;
    const point = isStencil ? glConst(gl, 'DEPTH_STENCIL_ATTACHMENT', 0x821a) : glConst(gl, 'DEPTH_ATTACHMENT', 0x8d00);

    const renderbuffer = gl.createRenderbuffer();
    if (renderbuffer === null) {
      log.warn(`WebGLFramebuffer(${this.label}): could not allocate a depth renderbuffer.`);
      return this;
    }

    this.bind('draw');
    gl.bindRenderbuffer(glConst(gl, 'RENDERBUFFER', 0x8d41), renderbuffer);
    this.storageRenderbuffer(descriptor.internalFormat, width, height, samples);
    gl.framebufferRenderbuffer(target, point, glConst(gl, 'RENDERBUFFER', 0x8d41), renderbuffer);
    gl.bindRenderbuffer(glConst(gl, 'RENDERBUFFER', 0x8d41), null);

    this.renderbuffers.push(renderbuffer);
    this.record({
      kind: isStencil ? 'depth-stencil' : 'depth',
      index: 0,
      attachmentPoint: point,
      target: glConst(gl, 'RENDERBUFFER', 0x8d41),
      format,
      width,
      height,
      samples: Math.max(1, samples),
    });
    return this;
  }

  /**
   * Allocates and attaches a colour renderbuffer, used for MSAA targets.
   *
   * @param index Colour attachment index.
   * @param width Width in device pixels.
   * @param height Height in device pixels.
   * @param format Colour format.
   * @param samples Sample count; `>1` allocates a multisampled buffer on WebGL2.
   * @returns This framebuffer, for chaining.
   */
  public attachColorRenderbuffer(
    index: number,
    width: number,
    height: number,
    format: PixelFormat = PixelFormat.RGBA8,
    samples: number = 1,
  ): this {
    const gl = this.gl;
    const target = glConst(gl, 'FRAMEBUFFER', 0x8d40);
    const descriptor = toGLFormat(gl, format, { webgl2: this.isWebGL2 });
    const point = glConst(gl, 'COLOR_ATTACHMENT0', 0x8ce0) + Math.max(0, index);

    const renderbuffer = gl.createRenderbuffer();
    if (renderbuffer === null) {
      log.warn(`WebGLFramebuffer(${this.label}): could not allocate a colour renderbuffer.`);
      return this;
    }

    this.bind('draw');
    gl.bindRenderbuffer(glConst(gl, 'RENDERBUFFER', 0x8d41), renderbuffer);
    this.storageRenderbuffer(descriptor.internalFormat, width, height, samples);
    gl.framebufferRenderbuffer(target, point, glConst(gl, 'RENDERBUFFER', 0x8d41), renderbuffer);
    gl.bindRenderbuffer(glConst(gl, 'RENDERBUFFER', 0x8d41), null);

    this.renderbuffers.push(renderbuffer);
    this.record({
      kind: 'color',
      index,
      attachmentPoint: point,
      target: glConst(gl, 'RENDERBUFFER', 0x8d41),
      format,
      width,
      height,
      samples: Math.max(1, samples),
    });
    this.setDrawBuffers(index + 1);
    return this;
  }

  /**
   * Declares how many colour attachments the fragment shader may write.
   *
   * @param count Number of draw buffers; clamped to at least one.
   * @returns This framebuffer, for chaining.
   */
  public setDrawBuffers(count: number): this {
    const gl = this.gl;
    const buffers: number[] = [];
    for (let i = 0; i < Math.max(1, count); i++) {
      buffers.push(glConst(gl, 'COLOR_ATTACHMENT0', 0x8ce0) + i);
    }

    const base = glConst(gl, 'DRAW_BUFFER0', 0x8825);
    void base;
    if (this.isWebGL2) {
      const gl2 = gl as WebGL2RenderingContext;
      gl2.drawBuffers(buffers);
      return this;
    }
    const extension = gl.getExtension('WEBGL_draw_buffers') as WEBGL_draw_buffers | null;
    if (extension !== null) extension.drawBuffersWEBGL(buffers);
    return this;
  }

  /**
   * Checks framebuffer completeness and explains any failure.
   *
   * @returns The status report.
   */
  public checkStatus(): FramebufferStatusReport {
    const gl = this.gl;
    const target = glConst(gl, 'FRAMEBUFFER', 0x8d40);
    this.bind('draw');

    const status = gl.checkFramebufferStatus(target);
    const name = this.statusName(status);
    if (status === glConst(gl, 'FRAMEBUFFER_COMPLETE', 0x8cd5)) {
      return { complete: true, status, statusName: name, reason: '' };
    }

    return { complete: false, status, statusName: name, reason: this.explainStatus(name) };
  }

  /**
   * Resolves a multisampled framebuffer into a single-sampled one.
   *
   * @param source Framebuffer holding the multisampled renderbuffers.
   * @param width Width in device pixels.
   * @param height Height in device pixels.
   * @param colorAttachmentIndex Colour attachment index to resolve.
   * @returns `true` when a blit was issued.
   */
  public blitColor(source: WebGLFramebuffer, width: number, height: number, colorAttachmentIndex: number = 0): boolean {
    if (!this.isWebGL2) {
      log.debug(
        `WebGLFramebuffer(${this.label}): MSAA resolve needs WebGL2 (blitFramebuffer); ` +
          'the multisampled contents cannot be copied on this context.',
      );
      return false;
    }

    const gl = this.gl as WebGL2RenderingContext;
    const readTarget = glConst(this.gl, 'READ_FRAMEBUFFER', 0x8ca8);
    const drawTarget = glConst(this.gl, 'DRAW_FRAMEBUFFER', 0x8ca9);

    const previousRead = gl.getParameter(readTarget) as GLFramebufferObject | null;
    const previousDraw = gl.getParameter(drawTarget) as GLFramebufferObject | null;

    try {
      gl.bindFramebuffer(readTarget, source.getHandle());
      gl.bindFramebuffer(drawTarget, this.getHandle());
      gl.blitFramebuffer(
        0,
        0,
        width,
        height,
        0,
        0,
        width,
        height,
        glConst(this.gl, 'COLOR_BUFFER_BIT', 0x4000),
        glConst(this.gl, 'NEAREST', 0x2600),
      );
      void colorAttachmentIndex;
      return true;
    } catch (error) {
      log.warn(`WebGLFramebuffer(${this.label}): MSAA resolve failed`, error);
      return false;
    } finally {
      gl.bindFramebuffer(readTarget, previousRead);
      gl.bindFramebuffer(drawTarget, previousDraw);
    }
  }

  /**
   * Reads pixels from the bound colour attachment.
   *
   * @param x Left edge in device pixels.
   * @param y Bottom edge in device pixels.
   * @param width Region width.
   * @param height Region height.
   * @param format Pixel format of the colour attachment.
   * @returns RGBA bytes, or `null` when readback is not possible.
   */
  public readPixels(
    x: number,
    y: number,
    width: number,
    height: number,
    format: PixelFormat = PixelFormat.RGBA8,
  ): Uint8ClampedArray | null {
    if (width <= 0 || height <= 0) return null;
    if (bytesPerPixel(format) === 0) return null;

    const gl = this.gl;
    const readTarget = this.isWebGL2
      ? glConst(gl, 'READ_FRAMEBUFFER', 0x8ca8)
      : glConst(gl, 'FRAMEBUFFER', 0x8d40);
    const previous = gl.getParameter(glConst(gl, 'FRAMEBUFFER_BINDING', 0x8ca6)) as GLFramebufferObject | null;

    try {
      gl.bindFramebuffer(readTarget, this.getHandle());
      const buffer = new Uint8Array(width * height * 4);
      gl.readPixels(
        Math.max(0, Math.floor(x)),
        Math.max(0, Math.floor(y)),
        Math.floor(width),
        Math.floor(height),
        glConst(gl, 'RGBA', 0x1908),
        glConst(gl, 'UNSIGNED_BYTE', 0x1401),
        buffer,
      );
      return new Uint8ClampedArray(buffer.buffer.slice(0));
    } catch {
      return null;
    } finally {
      gl.bindFramebuffer(glConst(gl, 'FRAMEBUFFER', 0x8d40), previous);
    }
  }

  /** Releases the framebuffer and every renderbuffer it owns. */
  public dispose(): void {
    if (this.disposed) return;
    const gl = this.gl;
    for (const renderbuffer of this.renderbuffers) gl.deleteRenderbuffer(renderbuffer);
    this.renderbuffers.length = 0;
    if (this.handle !== null) {
      gl.deleteFramebuffer(this.handle);
      this.handle = null;
    }
    this.attachments.length = 0;
    this.disposed = true;
  }

  /** @returns A human-readable description. */
  public toString(): string {
    return `WebGLFramebuffer(${this.label}, ${this.attachments.length} attachments)`;
  }

  /* ---------------------------------------------------------------- internals */

  /** Allocates renderbuffer storage, multisampled when the context allows it. */
  private storageRenderbuffer(internalFormat: number, width: number, height: number, samples: number): void {
    const gl = this.gl;
    const target = glConst(gl, 'RENDERBUFFER', 0x8d41);
    const sampleCount = Math.max(1, Math.floor(samples));

    if (sampleCount > 1 && this.isWebGL2) {
      const gl2 = gl as WebGL2RenderingContext;
      gl2.renderbufferStorageMultisample(target, sampleCount, internalFormat, Math.max(1, width), Math.max(1, height));
      return;
    }
    gl.renderbufferStorage(target, internalFormat, Math.max(1, width), Math.max(1, height));
  }

  /** Appends an attachment record, replacing any previous record in the same slot. */
  private record(attachment: FramebufferAttachment): void {
    const index = this.attachments.findIndex(
      (existing) => existing.kind === attachment.kind && existing.index === attachment.index,
    );
    if (index >= 0) this.attachments[index] = attachment;
    else this.attachments.push(attachment);
  }

  /** Resolves a status enumeration to its specification name. */
  private statusName(status: number): string {
    const gl = this.gl;
    const table: readonly (readonly [string, number])[] = [
      ['FRAMEBUFFER_COMPLETE', 0x8cd5],
      ['FRAMEBUFFER_INCOMPLETE_ATTACHMENT', 0x8cd6],
      ['FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT', 0x8cd7],
      ['FRAMEBUFFER_INCOMPLETE_DIMENSIONS', 0x8cd9],
      ['FRAMEBUFFER_UNSUPPORTED', 0x8cdd],
      ['FRAMEBUFFER_INCOMPLETE_MULTISAMPLE', 0x8d56],
      ['FRAMEBUFFER_INCOMPLETE_LAYER_TARGETS', 0x8da8],
    ];
    for (const [name, fallback] of table) {
      if (glConst(gl, name, fallback) === status) return name;
    }
    return `0x${status.toString(16)}`;
  }

  /** Explains a completeness failure in terms of what to change. */
  private explainStatus(name: string): string {
    switch (name) {
      case 'FRAMEBUFFER_INCOMPLETE_ATTACHMENT':
        return (
          `WebGLFramebuffer(${this.label}) is incomplete: at least one attachment point is not ` +
          'framebuffer-complete. The usual cause is a zero-sized attachment, or a texture whose ' +
          'internal format the driver cannot render to (check EXT_color_buffer_float for float ' +
          'formats).'
        );
      case 'FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT':
        return (
          `WebGLFramebuffer(${this.label}) is incomplete: no attachment is bound. Attach a colour ` +
          'texture/renderbuffer, or a depth renderbuffer, before drawing into it.'
        );
      case 'FRAMEBUFFER_INCOMPLETE_DIMENSIONS':
        return (
          `WebGLFramebuffer(${this.label}) is incomplete: the attachments do not all have the same ` +
          'dimensions. Resize the target so every attachment matches.'
        );
      case 'FRAMEBUFFER_UNSUPPORTED':
        return (
          `WebGLFramebuffer(${this.label}) is unsupported: the driver rejects this attachment ` +
          'format combination. Try a different colour or depth format.'
        );
      case 'FRAMEBUFFER_INCOMPLETE_MULTISAMPLE':
        return (
          `WebGLFramebuffer(${this.label}) is incomplete: the multisampled attachments disagree on ` +
          'their sample count, or the requested count exceeds MAX_SAMPLES. Clamp the request with ' +
          'WebGLCapabilities.clampSamples().'
        );
      default:
        return (
          `WebGLFramebuffer(${this.label}) is incomplete (status ${name}). Check every attachment's ` +
          'size and format against the capabilities the context reported.'
        );
    }
  }
}

/** Native renderbuffer handle, aliased because this module declares no such class. */
type GLRenderbufferLike = WebGLRenderbuffer;
