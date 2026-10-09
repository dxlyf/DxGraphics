/**
 * `Pass` — the base class for every post-processing stage.
 *
 * A pass is an {@link IRenderPass} with post-processing semantics bolted on: it knows
 * whether the composer should swap buffers after it, whether it draws to the screen, and
 * how to size its own intermediate targets. Everything a pass *needs* from a backend goes
 * through the structural {@link RendererLike}, so a pass can be driven headlessly.
 *
 * ## The ping-pong contract
 *
 * A composer holds two targets. A pass reads from one and writes to the other:
 *
 * ```
 *   readBuffer ──┐                    ┌──> writeBuffer
 *                │   [ ShaderPass ]   │
 *                └────────────────────┘
 *                        │
 *              needsSwap = true  ⇒  the composer exchanges read/write
 * ```
 *
 * A pass that renders *into* the read buffer (an in-place effect) sets `needsSwap = false`
 * and the composer leaves the buffers alone. Getting this flag wrong is the single most
 * common cause of a black screen, so every pass in this package documents its choice.
 *
 * ## `renderToScreen`
 *
 * When a pass sets `renderToScreen`, the composer binds the screen instead of
 * `writeBuffer`, and stops swapping. That is how a pass chain terminates.
 *
 * ```ts
 * class MyPass extends Pass {
 *   constructor() { super({ name: 'MyPass' }); this.needsSwap = true; }
 *   protected draw(context: RenderContext): void {
 *     // bind the read buffer as a texture, draw a full-screen quad
 *   }
 * }
 * ```
 *
 * @packageDocumentation
 */

import { Disposable } from '../../core/Disposable';
import { createId } from '../../utils/Id';
import { createLogger } from '../../utils/Logger';
import type { RenderContext } from '../../renderer/core/RenderContext';
import type { IRenderPass } from '../../renderer/interfaces/IRenderPass';
import type { IRenderTarget } from '../../renderer/interfaces/IRenderTarget';
import type { ClearOptions } from '../../renderer/interfaces/types';
import type { PostProcessOptions, PassLike } from '../types';

/** Logger shared by every pass. */
const log = createLogger('effects:pass');

/**
 * Abstract base for a post-processing pass.
 */
export abstract class Pass extends Disposable<'Pass'> implements IRenderPass {
  /** @inheritdoc */
  public override readonly label = 'Pass' as const;

  /** @inheritdoc */
  public override readonly id: string;

  /** @inheritdoc */
  public readonly name: string;

  /** @inheritdoc */
  public enabled: boolean;

  /** @inheritdoc */
  public order: number;

  /** @inheritdoc */
  public readonly target: IRenderTarget | null = null;

  /** @inheritdoc */
  public readonly clearOptions: ClearOptions | null = null;

  /**
   * `true` when the composer must exchange its read and write buffers after this pass.
   *
   * Defaults to `true`, because most passes read one texture and write another. Set it to
   * `false` for a pass that mutates the read buffer in place.
   */
  public needsSwap = true;

  /** `true` when this pass draws to the screen rather than to a target. */
  public renderToScreen = false;

  /** Resolution scale applied to this pass's own targets. */
  public resolutionScale: number;

  /** Log width, in device pixels. */
  public width = 1;

  /** Log height, in device pixels. */
  public height = 1;

  /** Compilation/initialisation state, for a pass that needs one. */
  public initialised = false;

  /**
   * Creates a pass.
   *
   * @param options Name, order, enablement and resolution scale.
   */
  protected constructor(options: PostProcessOptions = {}) {
    super();
    this.id = createId('pass');
    this.name = options.name ?? this.constructor.name;
    this.order = options.order ?? 0;
    this.enabled = options.enabled ?? true;
    this.resolutionScale = options.resolutionScale ?? 1;
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Called by the composer before the first execution.
   *
   * @param context Per-frame render context.
   */
  public onAttach(context: RenderContext): void {
    void context;
    this.initialised = true;
  }

  /** Called by the composer when the pass is removed. */
  public onDetach(): void {
    this.initialised = false;
  }

  /**
   * Called once per frame before {@link Pass.execute}.
   *
   * @param context Per-frame render context.
   */
  public onBeforeExecute(context: RenderContext): void {
    void context;
  }

  /**
   * Called once per frame after {@link Pass.execute}.
   *
   * @param context Per-frame render context.
   */
  public onAfterExecute(context: RenderContext): void {
    void context;
  }

  /**
   * Called after a resize.
   *
   * @param width Logical width in CSS pixels.
   * @param height Logical height in CSS pixels.
   * @param pixelRatio Device-pixel ratio.
   */
  public onResize(width: number, height: number, pixelRatio: number): void {
    this.setSize(Math.max(1, Math.round(width * pixelRatio)), Math.max(1, Math.round(height * pixelRatio)));
  }

  /**
   * Sizes the pass's own targets.
   *
   * @param width Width in device pixels.
   * @param height Height in device pixels.
   */
  public setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width * this.resolutionScale));
    this.height = Math.max(1, Math.floor(height * this.resolutionScale));
  }

  /** Resets internal state so the pass can be re-run from scratch. */
  public reset(): void {
    /* nothing to reset in the base class */
  }

  /**
   * Executes the pass.
   *
   * @param context Per-frame render context.
   */
  public execute(context: RenderContext): void {
    if (!this.enabled) return;
    if (!this.initialised) this.onAttach(context);
    try {
      this.draw(context);
    } catch (error) {
      log.error(`pass "${this.name}" failed`, error);
      throw error;
    }
  }

  /**
   * The pass body.
   *
   * @param context Per-frame render context.
   */
  protected abstract draw(context: RenderContext): void;

  /* --------------------------------------------------------------- helpers */

  /**
   * The viewport this pass writes into.
   *
   * @returns Width and height in device pixels.
   */
  public getViewport(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    this.enabled = false;
    this.initialised = false;
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `${this.constructor.name}("${this.name}", order=${this.order}, enabled=${this.enabled}, ` +
      `swap=${this.needsSwap}, screen=${this.renderToScreen})`
    );
  }
}

/**
 * A pass built from a callback.
 *
 * The escape hatch for a one-off effect: `new FunctionPass('grade', (context) => { ... })`
 * is a real `IRenderPass` without a subclass.
 */
export class FunctionPass extends Pass {
  /** The pass body. */
  public readonly callback: (context: RenderContext) => void;

  /**
   * Creates a callback pass.
   *
   * @param name Display name.
   * @param callback Pass body.
   * @param options Order and enablement.
   */
  constructor(
    name: string,
    callback: (context: RenderContext) => void,
    options: PostProcessOptions = {},
  ) {
    super({ ...options, name });
    this.callback = callback;
  }

  /** @inheritdoc */
  protected override draw(context: RenderContext): void {
    this.callback(context);
  }
}

/**
 * `true` when a value satisfies the minimum post-processing pass shape.
 *
 * @param value Candidate value.
 * @returns `true` when the value can be added to a composer.
 */
export function isPass(value: unknown): value is PassLike {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<PassLike>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.order === 'number' &&
    typeof candidate.enabled === 'boolean'
  );
}
