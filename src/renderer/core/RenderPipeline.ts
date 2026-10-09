/**
 * Render pipeline.
 *
 * The reference {@link IPipeline} implementation: an ordered, stable collection of
 * {@link IRenderPass} objects plus the loop that executes them. Passes are sorted
 * by `order` (ties keep insertion order) and each pass receives the shared
 * {@link RenderContext}.
 *
 * @packageDocumentation
 */

import { createId } from '../../utils/Id';
import { createLogger } from '../../utils/Logger';
import type {
  IPipeline,
  PipelineExecutionResult,
  PipelineInsertPosition,
} from '../interfaces/IPipeline';
import type { IRenderPass } from '../interfaces/IRenderPass';
import type { RenderContext } from './RenderContext';

/** Logger shared by every pipeline. */
const log = createLogger('renderer:pipeline');

/** Options accepted by the {@link RenderPipeline} constructor. */
export interface RenderPipelineOptions {
  /** Identifier override; a generated one is used when omitted. */
  id?: string;
  /** Initial passes, in order. */
  passes?: readonly IRenderPass[];
  /** Sort the passes before each execution. Defaults to `true`. */
  autoSort?: boolean;
  /** Keep executing after a pass throws. Defaults to `false`. */
  continueOnError?: boolean;
}

/**
 * Ordered pass list with a `render(context)` entry point.
 *
 * ```ts
 * const pipeline = new RenderPipeline({ passes: [shadowPass, mainPass] });
 * const result = pipeline.render(context);
 * ```
 */
export class RenderPipeline implements IPipeline {
  /** Identifier used by the owning renderer. */
  public readonly id: string;

  /** `true` when the pipeline should be executed by its owner. */
  public enabled: boolean = true;

  /** When `true`, a throwing pass does not abort the remaining passes. */
  public continueOnError: boolean;

  /** When `true`, {@link RenderPipeline.render} sorts the passes first. */
  public autoSort: boolean;

  /** Passes in their current order. */
  private readonly passList: IRenderPass[] = [];

  /** `true` once {@link RenderPipeline.initialise} has run. */
  private initialised: boolean = false;

  /**
   * Creates a pipeline.
   *
   * @param options Initial passes and behaviour flags.
   */
  constructor(options: RenderPipelineOptions = {}) {
    this.id = options.id ?? `pipeline-${createId()}`;
    this.autoSort = options.autoSort ?? true;
    this.continueOnError = options.continueOnError ?? false;
    if (options.passes) {
      for (const pass of options.passes) this.passList.push(pass);
      if (this.autoSort) this.sort();
    }
  }

  /** @inheritdoc */
  public get passes(): readonly IRenderPass[] {
    return this.passList;
  }

  /** Number of passes currently registered. */
  public get length(): number {
    return this.passList.length;
  }

  /** @inheritdoc */
  public add(pass: IRenderPass, position: PipelineInsertPosition = 'last'): this {
    if (this.passList.includes(pass)) return this;

    if (position === 'first') {
      this.passList.unshift(pass);
    } else if (position === 'last') {
      this.passList.push(pass);
    } else {
      const index = Math.max(0, Math.min(Math.floor(position), this.passList.length));
      this.passList.splice(index, 0, pass);
    }

    if (this.initialised && typeof pass.onAttach === 'function') {
      // Re-attaching after construction needs a context; the owner produces a
      // fresh one on the next render, so defer the notification to the renderer.
      log.debug(`pass '${pass.id}' added to an initialised pipeline '${this.id}'; onAttach deferred`);
    }
    return this;
  }

  /** @inheritdoc */
  public remove(pass: IRenderPass | string): boolean {
    const index = typeof pass === 'string' ? this.passList.findIndex((entry) => entry.id === pass) : this.passList.indexOf(pass);
    if (index < 0) return false;

    const [removed] = this.passList.splice(index, 1);
    if (removed && typeof removed.onDetach === 'function') {
      try {
        removed.onDetach();
      } catch (error) {
        log.warn(`pass '${removed.id}' onDetach threw`, error);
      }
    }
    return true;
  }

  /** @inheritdoc */
  public get(id: string): IRenderPass | undefined {
    return this.passList.find((pass) => pass.id === id);
  }

  /** @inheritdoc */
  public clear(): void {
    for (const pass of this.passList) {
      if (typeof pass.onDetach === 'function') {
        try {
          pass.onDetach();
        } catch (error) {
          log.warn(`pass '${pass.id}' onDetach threw`, error);
        }
      }
    }
    this.passList.length = 0;
  }

  /** @inheritdoc */
  public sort(): void {
    // `Array#sort` is stable in every ES2019+ engine, so equal `order` values keep
    // insertion order without an explicit index tie-break.
    this.passList.sort((a, b) => a.order - b.order);
  }

  /** @inheritdoc */
  public initialise(context: RenderContext): void {
    for (const pass of this.passList) {
      if (typeof pass.onAttach !== 'function') continue;
      try {
        pass.onAttach(context);
      } catch (error) {
        log.warn(`pass '${pass.id}' onAttach threw`, error);
      }
    }
    this.initialised = true;
  }

  /** @inheritdoc */
  public render(context: RenderContext): PipelineExecutionResult {
    const startedAt = now();
    if (this.autoSort) this.sort();

    const errors: Error[] = [];
    let executed = 0;
    let skipped = 0;
    let failed = 0;

    for (const pass of this.passList) {
      if (!pass.enabled) {
        skipped++;
        continue;
      }

      try {
        if (typeof pass.onBeforeExecute === 'function') pass.onBeforeExecute(context);
        pass.execute(context);
        if (typeof pass.onAfterExecute === 'function') pass.onAfterExecute(context);
        executed++;
      } catch (error) {
        failed++;
        const wrapped = error instanceof Error ? error : new Error(String(error));
        errors.push(wrapped);
        log.error(`pass '${pass.id}' failed`, wrapped);
        if (!this.continueOnError) break;
      }
    }

    return {
      executed,
      skipped,
      failed,
      errors,
      duration: now() - startedAt,
    };
  }

  /** @inheritdoc */
  public dispose(): void {
    this.clear();
    this.enabled = false;
    this.initialised = false;
  }

  /**
   * Notifies every pass that the surface was resized.
   *
   * @param width New logical width in CSS pixels.
   * @param height New logical height in CSS pixels.
   * @param pixelRatio Active device-pixel ratio.
   */
  public notifyResize(width: number, height: number, pixelRatio: number): void {
    for (const pass of this.passList) {
      if (typeof pass.onResize !== 'function') continue;
      try {
        pass.onResize(width, height, pixelRatio);
      } catch (error) {
        log.warn(`pass '${pass.id}' onResize threw`, error);
      }
    }
  }

  /** @returns `true` once {@link RenderPipeline.initialise} has run. */
  public isInitialised(): boolean {
    return this.initialised;
  }
}

/** Monotonic clock reading in milliseconds. */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
