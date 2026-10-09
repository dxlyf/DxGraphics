/**
 * `EffectComposer` — an ordered, ping-ponged post-processing chain.
 *
 * The composer is an {@link IPipeline}: it owns an ordered list of passes, executes them
 * against one {@link RenderContext}, and reports the same `PipelineExecutionResult` the
 * core pipeline does. On top of that it owns the two render targets a post-processing
 * chain needs.
 *
 * ```
 *   scene ──> [ RenderPass ] ──> readBuffer
 *                                   │
 *                              [ BloomPass ]  needsSwap
 *                                   │
 *                              [ FXAAPass ]   needsSwap
 *                                   │
 *                              [ OutputPass ] renderToScreen ──> screen
 * ```
 *
 * ## Why two targets, and not one
 *
 * A pass cannot read and write the same texture: sampling a texture while rendering into
 * it is undefined behaviour on every backend. So the composer keeps two, and every pass
 * whose `needsSwap` is set causes an exchange. A pass that does not need the exchange (an
 * in-place effect, or a pass that only writes depth) sets `needsSwap = false` and the
 * buffers stay put.
 *
 * ## Headless by design
 *
 * `render(delta)` accepts a number or a `RenderContext`, and every renderer call is
 * guarded. A test can construct a composer with no renderer at all, add three fake passes,
 * and assert the execution order and the buffer swaps — which is exactly what the test
 * suite does.
 *
 * ```ts
 * const composer = new EffectComposer(renderer);
 * composer.addPass(new RenderPass(scene, camera));
 * composer.addPass(new BloomPass({ strength: 1.2 }));
 * composer.renderToScreen = true;
 * composer.render(clock.getDelta());
 * ```
 *
 * @packageDocumentation
 */

import { Disposable } from '../../core/Disposable';
import { createId } from '../../utils/Id';
import { createLogger } from '../../utils/Logger';
import { RenderContext } from '../../renderer/core/RenderContext';
import { NullRenderTarget } from '../../renderer/core/RenderTarget';
import type { IRenderTarget } from '../../renderer/interfaces/IRenderTarget';
import { PixelFormat, TextureFilter, TextureWrap } from '../../renderer/interfaces/types';
import type { PipelineExecutionResult, PipelineInsertPosition } from '../../renderer/interfaces/IPipeline';
import type {
  EffectComposerOptions,
  PassLike,
  RendererLike,
  RenderTargetFactoryLike,
} from '../types';
import { isPass } from './Pass';

/** Logger shared by the composer. */
const log = createLogger('effects:composer');

/**
 * An ordered chain of post-processing passes with ping-ponged targets.
 */
export class EffectComposer extends Disposable<'EffectComposer'> {
  /** @inheritdoc */
  public override readonly label = 'EffectComposer' as const;

  /** Identifier. */
  public override readonly id: string;

  /** `false` suspends execution. */
  public enabled = true;

  /** `true` keeps executing after a pass throws. */
  public continueOnError: boolean;

  /** `true` sorts the passes by `order` before each execution. */
  public autoSort: boolean;

  /** First ping-pong target. */
  public renderTarget1: IRenderTarget | null = null;

  /** Second ping-pong target. */
  public renderTarget2: IRenderTarget | null = null;

  /** Logical width in CSS pixels. */
  public width: number;

  /** Logical height in CSS pixels. */
  public height: number;

  /** Device-pixel ratio applied to the target size. */
  public pixelRatio: number;

  /** `true` makes the last pass draw to the screen. */
  public renderToScreen = true;

  /** Renderer used for the pass sequence. */
  public renderer: RendererLike | null;

  /** Passes in their current order. */
  private readonly passList: PassLike[] = [];

  /** `0` reads from target 1, `1` reads from target 2. */
  private readIndex = 0;

  /** Target factory; falls back to a resource-less target when absent. */
  private factory: RenderTargetFactoryLike | null;

  /** `true` once `initialise` has run. */
  private initialised = false;

  /** Reused context when the caller passes a number instead of a context. */
  private readonly fallbackContext = new RenderContext();

  /** Total frames executed. */
  public frameCount = 0;

  /** Number of buffer swaps performed. */
  public swapCount = 0;

  /**
   * Creates a composer.
   *
   * @param renderer Renderer used for the sequence, or an option bag.
   * @param options Explicit size, factory and behaviour flags.
   */
  constructor(renderer: RendererLike | null = null, options: EffectComposerOptions = {}) {
    super();
    this.id = options.name === undefined ? createId('composer') : `${options.name}-${createId('composer')}`;
    this.renderer = renderer;
    this.factory = resolveFactory(renderer, options.targetFactory ?? null);
    this.autoSort = options.autoSort ?? true;
    this.continueOnError = options.continueOnError ?? false;

    const size = readRendererSize(renderer);
    this.pixelRatio = Math.max(0.01, options.pixelRatio ?? 1);
    this.width = Math.max(1, options.width ?? size.width);
    this.height = Math.max(1, options.height ?? size.height);

    this.createTargets();
  }

  /* ----------------------------------------------------------------- targets */

  /** Allocates the two ping-pong targets. */
  private createTargets(): void {
    const options = {
      width: Math.max(1, Math.round(this.width * this.pixelRatio)),
      height: Math.max(1, Math.round(this.height * this.pixelRatio)),
      colorAttachments: 1,
      depth: true,
      format: PixelFormat.RGBA8,
      filter: TextureFilter.Linear,
      wrap: TextureWrap.ClampToEdge,
    };

    this.renderTarget1 = this.createTarget(options);
    this.renderTarget2 = this.createTarget(options);
    this.readIndex = 0;
  }

  /** Creates one target through the factory, or a resource-less fallback. */
  private createTarget(options: Record<string, unknown>): IRenderTarget {
    if (this.factory !== null) {
      const created = this.factory.createRenderTarget(options);
      if (created != null && typeof created === 'object') return created as IRenderTarget;
    }

    // No factory: a `NullRenderTarget` keeps the composer's geometry bookkeeping correct
    // and lets the whole chain run headlessly, which is what a unit test wants.
    return new NullRenderTarget(
      {
        width: options.width as number,
        height: options.height as number,
        depth: options.depth as boolean,
      },
      'null',
    );
  }

  /** The target the next pass reads from. */
  public get readBuffer(): IRenderTarget | null {
    return this.readIndex === 0 ? this.renderTarget1 : this.renderTarget2;
  }

  /** The target the next pass writes into. */
  public get writeBuffer(): IRenderTarget | null {
    return this.readIndex === 0 ? this.renderTarget2 : this.renderTarget1;
  }

  /**
   * Exchanges the read and write targets.
   *
   * @returns This composer, for chaining.
   */
  public swapBuffers(): this {
    this.readIndex = this.readIndex === 0 ? 1 : 0;
    this.swapCount++;
    return this;
  }

  /**
   * Replaces the target factory.
   *
   * @param factory New factory, or `null` for the resource-less fallback.
   * @returns This composer, for chaining.
   */
  public setRenderTargetFactory(factory: RenderTargetFactoryLike | null): this {
    this.releaseTargets();
    this.factory = factory;
    this.createTargets();
    return this;
  }

  /* ------------------------------------------------------------------- passes */

  /** @inheritdoc */
  public get passes(): readonly PassLike[] {
    return this.passList;
  }

  /** Number of registered passes. */
  public get length(): number {
    return this.passList.length;
  }

  /**
   * Adds a pass.
   *
   * @param pass Pass to add; adding the same instance twice is a no-op.
   * @param position `'last'` (default), `'first'`, or an explicit index.
   * @returns This composer, for chaining.
   */
  public add(pass: PassLike, position: PipelineInsertPosition = 'last'): this {
    return this.addPass(pass, position);
  }

  /**
   * Adds a pass.
   *
   * @param pass Pass to add.
   * @param position `'last'` (default), `'first'`, or an explicit index.
   * @returns This composer, for chaining.
   * @throws TypeError When the value does not look like a pass.
   */
  public addPass(pass: PassLike, position: PipelineInsertPosition = 'last'): this {
    if (!isPass(pass)) {
      throw new TypeError(
        'EffectComposer.addPass: expected a pass with `id`, `order` and `enabled`. ' +
          'Extend `Pass`, or use `createRenderPass`/`FunctionPass` for a one-off.',
      );
    }
    if (this.passList.includes(pass)) return this;

    if (position === 'first') {
      this.passList.unshift(pass);
    } else if (position === 'last') {
      this.passList.push(pass);
    } else {
      const index = Math.max(0, Math.min(Math.floor(position), this.passList.length));
      this.passList.splice(index, 0, pass);
    }

    if (this.autoSort) this.sort();
    return this;
  }

  /**
   * Inserts a pass at an explicit index.
   *
   * @param pass Pass to insert.
   * @param index Index to insert at.
   * @returns This composer, for chaining.
   */
  public insertPass(pass: PassLike, index: number): this {
    return this.addPass(pass, index);
  }

  /**
   * Removes a pass.
   *
   * @param pass Pass instance, or its id.
   * @returns `true` when a pass was removed.
   */
  public remove(pass: PassLike | string): boolean {
    return this.removePass(pass);
  }

  /**
   * Removes a pass.
   *
   * @param pass Pass instance, or its id.
   * @returns `true` when a pass was removed.
   */
  public removePass(pass: PassLike | string): boolean {
    const index =
      typeof pass === 'string'
        ? this.passList.findIndex((entry) => entry.id === pass)
        : this.passList.indexOf(pass);
    if (index < 0) return false;

    const [removed] = this.passList.splice(index, 1);
    try {
      removed?.onDetach?.();
    } catch (error) {
      log.warn('a pass onDetach hook threw', error);
    }
    return true;
  }

  /**
   * Looks a pass up by id.
   *
   * @param id Pass identifier.
   * @returns The pass, or `undefined`.
   */
  public get(id: string): PassLike | undefined {
    return this.passList.find((pass) => pass.id === id);
  }

  /**
   * Looks a pass up by name.
   *
   * @param name Pass name.
   * @returns The pass, or `undefined`.
   */
  public getPassByName(name: string): PassLike | undefined {
    return this.passList.find((pass) => pass.name === name);
  }

  /**
   * Every enabled pass.
   *
   * @returns The enabled passes, in execution order.
   */
  public getEnabledPasses(): PassLike[] {
    return this.passList.filter((pass) => pass.enabled);
  }

  /**
   * Removes every pass.
   *
   * @returns This composer, for chaining.
   */
  public clear(): this {
    for (const pass of this.passList) {
      try {
        pass.onDetach?.();
      } catch (error) {
        log.warn('a pass onDetach hook threw', error);
      }
    }
    this.passList.length = 0;
    return this;
  }

  /**
   * Sorts the passes by `order`, stably.
   *
   * @returns This composer, for chaining.
   */
  public sort(): this {
    // `Array#sort` is stable in every ES2019+ engine, so equal orders keep insertion order.
    this.passList.sort((a, b) => a.order - b.order);
    return this;
  }

  /* ------------------------------------------------------------------ sizing */

  /**
   * Resizes both targets.
   *
   * @param width Logical width in CSS pixels.
   * @param height Logical height in CSS pixels.
   * @returns This composer, for chaining.
   */
  public setSize(width: number, height: number): this {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);

    const deviceWidth = Math.max(1, Math.round(this.width * this.pixelRatio));
    const deviceHeight = Math.max(1, Math.round(this.height * this.pixelRatio));

    this.renderTarget1?.setSize(deviceWidth, deviceHeight);
    this.renderTarget2?.setSize(deviceWidth, deviceHeight);

    for (const pass of this.passList) pass.setSize?.(deviceWidth, deviceHeight);
    return this;
  }

  /**
   * Sets the device-pixel ratio and resizes.
   *
   * @param pixelRatio New ratio.
   * @returns This composer, for chaining.
   */
  public setPixelRatio(pixelRatio: number): this {
    this.pixelRatio = Math.max(0.01, pixelRatio);
    return this.setSize(this.width, this.height);
  }

  /**
   * Resets every pass and the buffer state.
   *
   * @returns This composer, for chaining.
   */
  public reset(): this {
    for (const pass of this.passList) pass.reset?.();
    this.readIndex = 0;
    this.swapCount = 0;
    this.frameCount = 0;
    return this;
  }

  /* ---------------------------------------------------------------- execution */

  /**
   * Attaches every pass.
   *
   * @param context Per-frame render context.
   */
  public initialise(context: RenderContext): void {
    for (const pass of this.passList) {
      try {
        pass.onAttach?.(context);
      } catch (error) {
        log.warn(`pass "${pass.name}" onAttach threw`, error);
      }
    }
    this.initialised = true;
  }

  /**
   * Executes the pass chain.
   *
   * @param context A per-frame context, or a delta in seconds.
   * @returns Aggregate statistics for the frame.
   */
  public render(context: RenderContext | number): PipelineExecutionResult {
    const startedAt = now();

    if (!this.enabled) {
      return { executed: 0, skipped: this.passList.length, failed: 0, errors: [], duration: 0 };
    }

    const resolved =
      typeof context === 'number'
        ? this.prepareFallbackContext(context)
        : context;

    if (!this.initialised) this.initialise(resolved);
    if (this.autoSort) this.sort();

    const errors: Error[] = [];
    let executed = 0;
    let skipped = 0;
    let failed = 0;

    const enabledPasses = this.passList.filter((pass) => pass.enabled);

    for (let index = 0; index < enabledPasses.length; index++) {
      const pass = enabledPasses[index];
      const isLast = index === enabledPasses.length - 1;

      try {
        // Only the last pass may draw to the screen, and only when the composer says so.
        // Enforcing it here means a pass cannot accidentally write to the canvas mid-chain.
        pass.renderToScreen = this.renderToScreen && isLast;

        if (this.renderer !== null) {
          if (pass.renderToScreen) {
            this.renderer.setRenderTarget?.(null);
          } else {
            this.renderer.setRenderTarget?.(this.writeBuffer);
          }
        }

        pass.execute(resolved);
        executed++;

        if (pass.needsSwap && !pass.renderToScreen) this.swapBuffers();
      } catch (error) {
        failed++;
        const wrapped = error instanceof Error ? error : new Error(String(error));
        errors.push(wrapped);
        log.error(`pass "${pass.name}" failed`, wrapped);
        if (!this.continueOnError) break;
      }
    }

    skipped = this.passList.length - enabledPasses.length;
    this.frameCount++;

    if (this.renderer !== null) this.renderer.setRenderTarget?.(null);

    return { executed, skipped, failed, errors, duration: now() - startedAt };
  }

  /** Builds a context for a `render(delta)` call. */
  private prepareFallbackContext(delta: number): RenderContext {
    const context = this.fallbackContext;
    context.begin(this.frameCount, delta, context.time + delta, now());
    context.setSurface(
      this.width,
      this.height,
      this.pixelRatio,
      { x: 0, y: 0, width: this.width, height: this.height },
      null,
      context.clearColor,
      context.camera,
    );
    context.renderer = (this.renderer ?? null) as RenderContext['renderer'];
    return context;
  }

  /* ---------------------------------------------------------------- disposal */

  /** Releases both targets. */
  private releaseTargets(): void {
    const factory = this.factory;
    for (const target of [this.renderTarget1, this.renderTarget2]) {
      if (target === null) continue;
      if (factory !== null && typeof factory.destroyRenderTarget === 'function') {
        factory.destroyRenderTarget(target);
      } else {
        target.dispose();
      }
    }
    this.renderTarget1 = null;
    this.renderTarget2 = null;
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    this.clear();
    this.releaseTargets();
    this.enabled = false;
    this.initialised = false;
    this.renderer = null;
    this.factory = null;
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `EffectComposer(passes=${this.passList.length}, enabled=${this.getEnabledPasses().length}, ` +
      `${this.width}x${this.height}@${this.pixelRatio}, swaps=${this.swapCount})`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Resolves a target factory from an explicit factory or a renderer. */
function resolveFactory(
  renderer: RendererLike | null,
  explicit: RenderTargetFactoryLike | null,
): RenderTargetFactoryLike | null {
  if (explicit !== null) return explicit;
  if (renderer === null) return null;

  if (
    typeof renderer.createRenderTarget === 'function' &&
    typeof renderer.destroyRenderTarget === 'function'
  ) {
    return renderer as unknown as RenderTargetFactoryLike;
  }
  return null;
}

/** Reads a renderer's drawing-surface size, defaulting to 1x1. */
function readRendererSize(renderer: RendererLike | null): { width: number; height: number } {
  if (renderer !== null && typeof renderer.getSize === 'function') {
    const size = renderer.getSize();
    if (size != null && Number.isFinite(size.width) && Number.isFinite(size.height)) {
      return { width: Math.max(1, size.width), height: Math.max(1, size.height) };
    }
  }
  return { width: 1, height: 1 };
}

/** Monotonic clock reading in milliseconds. */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Convenience factory mirroring `new EffectComposer(renderer, options)`.
 *
 * @param renderer Renderer used for the sequence.
 * @param options Explicit size, factory and behaviour flags.
 * @returns A new composer.
 */
export function effectComposer(
  renderer: RendererLike | null = null,
  options: EffectComposerOptions = {},
): EffectComposer {
  return new EffectComposer(renderer, options);
}
