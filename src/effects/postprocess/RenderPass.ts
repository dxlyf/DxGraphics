/**
 * `RenderPass` — the geometry pass that starts a post-processing chain.
 *
 * Every composer begins with one: it draws `context.scene` with `context.camera` into the
 * composer's write buffer, optionally with a clear. Without it the chain has nothing to
 * post-process.
 *
 * ```
 *   context.scene ──[ RenderPass ]──> writeBuffer ──> [ Bloom ] ──> ...
 * ```
 *
 * ## Clear behaviour
 *
 * `clear` clears the colour buffer before drawing; `clearDepth` clears depth. Both default
 * to `true`, which is what a first pass wants. Disable them when the pass is layered on
 * top of something already in the buffer — a 2D overlay, a split-screen second viewport,
 * or a chain that renders two scenes in sequence.
 *
 * ## Override material
 *
 * Supplying `overrideMaterial` draws the whole scene with one material. That is how a
 * depth-only prepass, a normal buffer, an id buffer for GPU picking, or a wireframe debug
 * view is built.
 *
 * @packageDocumentation
 */

import type { RenderContext } from '../../renderer/core/RenderContext';
import type { ClearOptions } from '../../renderer/interfaces/types';
import { Pass } from './Pass';
import type { CameraLike, MaterialLike, PostProcessOptions, SceneLike } from '../types';

/**
 * Converts a `[r, g, b, a]` tuple in `[0, 1]` into the colour shape the renderer accepts.
 *
 * The renderer's `ColorInput` is `string | number | ColorLike | RGBA`, and `RGBA` is
 * `{ r, g, b, a }`, so a tuple has to be converted rather than passed through.
 *
 * @param rgba Normalised channels.
 * @returns An `RGBA` record.
 */
function toColorInput(rgba: readonly [number, number, number, number]): {
  r: number;
  g: number;
  b: number;
  a: number;
} {
  return { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] };
}

/** Options accepted by {@link RenderPass}. */
export interface RenderPassOptions extends PostProcessOptions {
  /** Scene to draw; defaults to `context.scene`. */
  scene?: SceneLike | null;
  /** Camera to draw with; defaults to `context.camera`. */
  camera?: CameraLike | null;
  /** Clear the colour buffer first; defaults to `true`. */
  clear?: boolean;
  /** Clear the depth buffer first; defaults to `true`. */
  clearDepth?: boolean;
  /** Clear colour, as `[r, g, b, a]` in `[0, 1]`. */
  clearColor?: [number, number, number, number];
  /** Material drawn instead of each object's own. */
  overrideMaterial?: MaterialLike | null;
  /** `true` skips the depth clear but keeps colour; overridden by `clear`/`clearDepth`. */
  autoClear?: boolean;
}

/**
 * Draws the scene into the composer's write buffer.
 */
export class RenderPass extends Pass {
  /** Scene override, or `null` to use `context.scene`. */
  public scene: SceneLike | null;

  /** Camera override, or `null` to use `context.camera`. */
  public camera: CameraLike | null;

  /** `true` clears colour before drawing. */
  public clear: boolean;

  /** `true` clears depth before drawing. */
  public clearDepth: boolean;

  /** Clear colour in `[0, 1]`. */
  public clearColor: [number, number, number, number];

  /** Material drawn instead of each object's own. */
  public overrideMaterial: MaterialLike | null;

  /** Frames this pass has rendered. */
  public renderCount = 0;

  /**
   * Creates a render pass.
   *
   * @param scene Scene to draw.
   * @param camera Camera to draw with.
   * @param options Clear behaviour and material override.
   */
  constructor(
    scene: SceneLike | null = null,
    camera: CameraLike | null = null,
    options: RenderPassOptions = {},
  ) {
    super({ name: options.name ?? 'RenderPass', order: options.order ?? 0, ...options });

    this.scene = options.scene ?? scene;
    this.camera = options.camera ?? camera;
    this.clear = options.autoClear === false ? false : (options.clear ?? true);
    this.clearDepth = options.clearDepth ?? true;
    this.clearColor = options.clearColor ?? [0, 0, 0, 1];
    this.overrideMaterial = options.overrideMaterial ?? null;

    // A geometry pass that reads and writes the same buffer would sample the scene it is
    // drawing; the composer must swap.
    this.needsSwap = true;
  }

  /**
   * Replaces the scene.
   *
   * @param scene New scene.
   * @returns This pass, for chaining.
   */
  public setScene(scene: SceneLike | null): this {
    this.scene = scene;
    return this;
  }

  /**
   * Replaces the camera.
   *
   * @param camera New camera.
   * @returns This pass, for chaining.
   */
  public setCamera(camera: CameraLike | null): this {
    this.camera = camera;
    return this;
  }

  /**
   * Sets the material override.
   *
   * @param material Material, or `null` to clear it.
   * @returns This pass, for chaining.
   */
  public setOverrideMaterial(material: MaterialLike | null): this {
    this.overrideMaterial = material;
    return this;
  }

  /**
   * The clear description handed to the renderer.
   *
   * @returns The clear options.
   */
  public getClearOptions(): ClearOptions {
    return {
      color: this.clear ? toColorInput(this.clearColor) : null,
      depth: this.clearDepth ? 0 : undefined,
      stencil: undefined,
    };
  }

  /** @inheritdoc */
  protected override draw(context: RenderContext): void {
    const renderer = context.renderer;
    const scene = this.scene ?? (context.scene as SceneLike | null);
    const camera = this.camera ?? (context.camera as CameraLike | null);

    if (renderer === null || renderer === undefined) {
      // Headless: record the intent so a test (or a tool) can assert the pass ran.
      context.values.set('renderPass', { scene, camera, clear: this.clear, clearDepth: this.clearDepth });
      this.renderCount++;
      return;
    }

    const clearColor = this.clear ? toColorInput(this.clearColor) : null;

    if (typeof renderer.clearWith === 'function') {
      // The precise path: `clearWith` takes the full description and honours `flags`.
      renderer.clearWith(this.getClearOptions());
    } else if (this.clear || this.clearDepth) {
      renderer.clear(clearColor, this.clearDepth ? 0 : undefined);
    }

    // `IRenderer.render` has no material-override parameter; a renderer that supports one
    // (the structural `RendererLike`) is used instead.
    const structural = renderer as unknown as {
      render?(scene: unknown, camera: unknown, overrideMaterial?: unknown): void;
    };

    if (this.overrideMaterial !== null && typeof structural.render === 'function') {
      structural.render(scene, camera, this.overrideMaterial);
    } else {
      renderer.render(scene as never, camera as never);
    }

    this.renderCount++;
  }

  /** @inheritdoc */
  public override reset(): void {
    this.renderCount = 0;
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `RenderPass("${this.name}", clear=${this.clear}, clearDepth=${this.clearDepth}, ` +
      `override=${this.overrideMaterial === null ? 'none' : 'set'}, renders=${this.renderCount})`
    );
  }
}
