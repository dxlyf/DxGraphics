/**
 * `GPUPicking` — object picking by rendering ids and reading one pixel back.
 *
 * Ray casting answers "does this ray hit this geometry?", which is exact but costs
 * CPU time proportional to the triangle count. GPU picking answers the same question
 * for the **whole scene at once**, at the cost of one extra render pass and one
 * pixel readback — the right trade for a large or heavily instanced scene, and the
 * only practical option for pixels produced by a vertex or fragment shader.
 *
 * ```ts
 * const picking = new GPUPicking({ renderer, width: 1024, height: 768 });
 * picking.register(meshA);
 * picking.register(meshB);
 *
 * picking.renderPickPass(scene, camera);       // draw ids
 * const hit = picking.pickAtPointer(512, 400); // read + decode + resolve
 * hit?.object;                                  // meshA or meshB
 * ```
 *
 * ## How the pass is meant to be driven
 *
 * The shader is the caller's: an override material whose fragment stage writes
 * `vec4(idBytes / 255.0)` (or the equivalent WGSL) for the object being drawn. This
 * class supplies the id *values* through {@link GPUPicking.getIdUniformData} and
 * drives the target/clear/render/readback sequence against a
 * {@link PickingRendererLike}. Nothing here imports a shader module, so the same
 * code works for GLSL and WGSL backends.
 *
 * ## Encoding
 *
 * See {@link PickingRenderTarget}: a 31-bit id packed into four bytes with the high
 * alpha bit reserved. Ids above the budget are **rejected** at registration with a
 * descriptive `RangeError`.
 *
 * @packageDocumentation
 */

import { createLogger } from '../utils/Logger';
import {
  PickingRenderTarget,
  assertIdWithinBudget,
  decodeId,
  encodeId,
  idToRgba,
} from './PickingRenderTarget';
import type { GPUPickResultLike, GPUPickingOptions, PickingRendererLike } from './types';

/** Logger shared by the GPU picking path. */
const log = createLogger('picking:gpu');

/** The scene/camera pair a pick pass renders. */
export interface PickingSceneLike {
  /** Root object; passed straight to the renderer. */
  [property: string]: unknown;
}

/**
 * Renders ids and resolves pixels to objects.
 *
 * @typeParam TTarget Object type held in the registry.
 */
export class GPUPicking<TTarget = unknown> {
  /** The registry and target description. */
  public readonly target: PickingRenderTarget<TTarget>;

  /** Material drawn with the id colour; supplied by the caller. */
  public overrideMaterial: unknown;

  /** `true` once a pick pass has been rendered for the current frame. */
  public pickPassRendered = false;

  /** Frame counter, used to skip redundant pick passes. */
  public pickPassFrame = -1;

  /** Last readback, for diagnostics. */
  public lastColor: [number, number, number, number] | null = null;

  /**
   * Creates a GPU picker.
   *
   * @param options Target size, renderer and override material.
   */
  constructor(options: GPUPickingOptions = {}) {
    this.target = new PickingRenderTarget<TTarget>(
      options.width ?? 1,
      options.height ?? 1,
      options.renderer ?? null,
      options.pixelRatio ?? 1,
    );
    this.overrideMaterial = options.overrideMaterial ?? null;
    if (options.clearColor !== undefined) this.target.clearColor = options.clearColor;
  }

  /** Renderer used for the pick pass. */
  public get renderer(): PickingRendererLike | null {
    return this.target.renderer;
  }

  /** Replaces the renderer, recreating the backend target. */
  public setRenderer(renderer: PickingRendererLike | null): this {
    this.target.destroy();
    this.target.renderer = renderer;
    return this;
  }

  /* ---------------------------------------------------------------- registry */

  /**
   * Registers an object.
   *
   * @param object Object to register.
   * @param id Explicit id, or `undefined` to allocate one.
   * @returns The id assigned to `object`.
   * @throws RangeError When the id is out of the 31-bit budget.
   */
  public register(object: TTarget, id?: number): number {
    return this.target.register(object, id);
  }

  /**
   * Removes an object or a bare id.
   *
   * @param target Object or id.
   * @returns `true` when something was removed.
   */
  public unregister(target: TTarget | number): boolean {
    return this.target.unregister(target);
  }

  /**
   * Looks an id up.
   *
   * @param id Id to resolve.
   * @returns The object, or `undefined`.
   */
  public getObject(id: number): TTarget | undefined {
    return this.target.getObject(id);
  }

  /**
   * Looks an object's id up.
   *
   * @param object Object to resolve.
   * @returns The id, or `undefined`.
   */
  public getId(object: TTarget): number | undefined {
    return this.target.getId(object);
  }

  /**
   * Removes every registration.
   *
   * @returns This picker, for chaining.
   */
  public clear(): this {
    this.target.clearRegistry();
    return this;
  }

  /** Number of registered ids. */
  public get size(): number {
    return this.target.size;
  }

  /* ---------------------------------------------------------------- codec */

  /**
   * Encodes an id into four bytes.
   *
   * @param id Id to encode.
   * @returns `[r, g, b, a]` bytes.
   */
  public encodeId(id: number): [number, number, number, number] {
    return encodeId(id);
  }

  /**
   * Decodes four bytes into an id.
   *
   * @param color `[r, g, b, a]` bytes.
   * @returns The id, or `0` for an empty pixel.
   */
  public decodeId(color: ArrayLike<number>): number {
    return decodeId(color);
  }

  /**
   * Id as a normalised RGBA tuple, ready for a uniform or a clear colour.
   *
   * @param id Id to convert.
   * @returns Four floats in `[0, 1]`.
   */
  public getIdUniformData(id: number): [number, number, number, number] {
    return idToRgba(id);
  }

  /**
   * Throws when an id cannot be encoded.
   *
   * @param id Candidate id.
   * @throws RangeError When the id is out of budget.
   */
  public assertId(id: number): void {
    assertIdWithinBudget(id, 'GPUPicking');
  }

  /* ------------------------------------------------------------ render pass */

  /**
   * Sizes the picking target.
   *
   * @param width New width in device pixels.
   * @param height New height in device pixels.
   * @returns This picker, for chaining.
   */
  public setSize(width: number, height: number): this {
    this.target.setSize(width, height);
    return this;
  }

  /**
   * Creates the backend target when it does not exist yet.
   *
   * @param options Extra target options forwarded to the renderer.
   * @returns This picker, for chaining.
   */
  public initialise(options: Record<string, unknown> = {}): this {
    this.target.create(options);
    return this;
  }

  /**
   * Renders the id pass.
   *
   * The sequence is: bind the picking target, clear it to id `0`, render the scene
   * with the override material, then restore the previous target. Every step is
   * guarded, so a renderer that only implements some of them still gets the pass
   * rendered as far as it can.
   *
   * @param scene Scene to render.
   * @param camera Camera to render with.
   * @param overrideMaterial Material override; defaults to the one supplied at
   *   construction.
   * @returns `true` when at least the `render` call was issued.
   */
  public renderPickPass(
    scene: PickingSceneLike | null,
    camera: unknown,
    overrideMaterial: unknown = this.overrideMaterial,
  ): boolean {
    const renderer = this.target.renderer;
    if (renderer === null) {
      log.warn('renderPickPass called with no renderer attached; nothing was drawn');
      return false;
    }

    this.initialise();

    if (typeof renderer.setRenderTarget === 'function') {
      renderer.setRenderTarget(this.target.handle);
    }

    if (typeof renderer.clear === 'function') {
      renderer.clear({
        color: this.target.clearColor,
        depth: true,
        stencil: false,
      });
    }

    let rendered = false;
    if (typeof renderer.render === 'function') {
      renderer.render(scene, camera, overrideMaterial ?? undefined);
      rendered = true;
    }

    if (typeof renderer.setRenderTarget === 'function') {
      renderer.setRenderTarget(null);
    }

    this.pickPassRendered = rendered;
    this.pickPassFrame++;
    return rendered;
  }

  /**
   * Skips the pick pass when it has already been rendered for `frame`.
   *
   * @param frame Frame index.
   * @returns `true` when the caller should render the pass.
   */
  public needsPickPass(frame: number): boolean {
    return !this.pickPassRendered || this.pickPassFrame !== frame;
  }

  /* ------------------------------------------------------------------ read */

  /**
   * Reads one device-pixel and resolves it.
   *
   * @param x Pixel X in device pixels.
   * @param y Pixel Y in device pixels.
   * @returns The pick result, or `null` when readback is unavailable.
   */
  public pick(x: number, y: number): GPUPickResultLike<TTarget> | null {
    const result = this.target.pick(x, y);
    this.lastColor = result?.color ?? null;
    return result;
  }

  /**
   * Reads one **logical** (CSS-pixel) coordinate and resolves it.
   *
   * @param x Logical X.
   * @param y Logical Y.
   * @returns The pick result, or `null`.
   */
  public pickAtPointer(x: number, y: number): GPUPickResultLike<TTarget> | null {
    const device = this.target.toDevicePixels(x, y);
    return this.pick(device.x, device.y);
  }

  /**
   * Resolves a colour that was read back by other means.
   *
   * Useful when the caller batches a whole region into one `readPixels` call and
   * then wants to decode individual pixels without another round trip.
   *
   * @param x Pixel X the colour came from.
   * @param y Pixel Y the colour came from.
   * @param color `[r, g, b, a]` bytes.
   * @returns The pick result.
   */
  public pickFromColor(x: number, y: number, color: ArrayLike<number>): GPUPickResultLike<TTarget> {
    const bytes: [number, number, number, number] = [
      (color[0] ?? 0) & 0xff,
      (color[1] ?? 0) & 0xff,
      (color[2] ?? 0) & 0xff,
      (color[3] ?? 0) & 0xff,
    ];
    const id = decodeId(bytes);
    const object = this.target.getObject(id);
    this.lastColor = bytes;
    return {
      id,
      x,
      y,
      color: bytes,
      ...(object === undefined ? {} : { object }),
    };
  }

  /**
   * Decodes a region read back as a flat RGBA byte array.
   *
   * @param bytes RGBA bytes, row-major from the top-left.
   * @param width Region width in pixels.
   * @param x Pixel X inside the region.
   * @param y Pixel Y inside the region.
   * @returns The pick result at `(x, y)`.
   */
  public pickFromRegion(
    bytes: ArrayLike<number>,
    width: number,
    x: number,
    y: number,
  ): GPUPickResultLike<TTarget> {
    const offset = (y * width + x) * 4;
    return this.pickFromColor(x, y, [bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0]);
  }

  /* --------------------------------------------------------------- dispose */

  /**
   * Releases the backend target and clears the registry.
   *
   * @returns This picker, for chaining.
   */
  public dispose(): this {
    this.target.destroy();
    this.target.clearRegistry();
    this.overrideMaterial = null;
    this.pickPassRendered = false;
    this.pickPassFrame = -1;
    this.lastColor = null;
    return this;
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return `GPUPicking(ids=${this.target.size}, size=${this.target.width}x${this.target.height})`;
  }
}

/**
 * Convenience factory mirroring `new GPUPicking(options)`.
 *
 * @typeParam TTarget Object type held in the registry.
 * @param options Target size, renderer and override material.
 * @returns A new GPU picker.
 */
export function gpuPicking<TTarget = unknown>(options: GPUPickingOptions = {}): GPUPicking<TTarget> {
  return new GPUPicking<TTarget>(options);
}
