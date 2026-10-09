/**
 * Pipeline contract.
 *
 * A pipeline is the ordered list of {@link IRenderPass} objects that turns one
 * `RenderContext` into one finished frame. Backends rarely implement this
 * themselves; `core/RenderPipeline` is the reference implementation and the GPU
 * backends compose it with their own state objects.
 *
 * @packageDocumentation
 */

import type { RenderContext } from '../core/RenderContext';
import type { IRenderPass } from './IRenderPass';

/** Insertion position accepted by {@link IPipeline.add}. */
export type PipelineInsertPosition = 'first' | 'last' | number;

/** Aggregate numbers produced by a pipeline execution. */
export interface PipelineExecutionResult {
  /** Number of passes that actually executed. */
  readonly executed: number;
  /** Number of enabled passes that were skipped because a target was unbound. */
  readonly skipped: number;
  /** Number of passes that threw; their errors are reported in `errors`. */
  readonly failed: number;
  /** Errors collected from failing passes, in execution order. */
  readonly errors: readonly Error[];
  /** Wall-clock duration of the execution, in milliseconds. */
  readonly duration: number;
}

/** Ordered collection of render passes. */
export interface IPipeline {
  /** Identifier, used by the renderer to look a pipeline up. */
  readonly id: string;

  /** `true` when the pipeline should be executed by its owner. */
  enabled: boolean;

  /**
   * When `true`, a pass that throws does not abort the remaining passes.
   *
   * Errors are still surfaced through {@link PipelineExecutionResult.errors}.
   */
  continueOnError: boolean;

  /** Passes in their current (possibly unsorted) order. */
  readonly passes: readonly IRenderPass[];

  /**
   * Adds a pass.
   *
   * @param pass Pass to add; adding the same instance twice is a no-op.
   * @param position `'last'` (default), `'first'`, or an explicit index.
   * @returns The pipeline, for chaining.
   */
  add(pass: IRenderPass, position?: PipelineInsertPosition): this;

  /**
   * Removes a pass.
   *
   * @param pass Pass instance, or its `id`.
   * @returns `true` when a pass was removed.
   */
  remove(pass: IRenderPass | string): boolean;

  /**
   * Looks a pass up by id.
   *
   * @param id Pass identifier.
   * @returns The pass, or `undefined`.
   */
  get(id: string): IRenderPass | undefined;

  /** Removes every pass. */
  clear(): void;

  /**
   * Sorts the passes by `order`, stably.
   *
   * Call this after mutating a pass' `order` field; {@link IPipeline.render} sorts
   * automatically when {@link IPipeline.autoSort} is `true`.
   */
  sort(): void;

  /** When `true` (the default) `render` sorts the passes before executing. */
  autoSort: boolean;

  /**
   * Executes every enabled pass.
   *
   * @param context Shared per-frame state.
   * @returns Aggregate statistics for the frame.
   */
  render(context: RenderContext): PipelineExecutionResult;

  /** Calls `onAttach` on every pass and marks the pipeline as ready. */
  initialise(context: RenderContext): void;

  /** Calls `onDetach` on every pass. */
  dispose(): void;
}

/** `true` when `value` satisfies the minimum {@link IPipeline} shape. */
export function isPipeline(value: unknown): value is IPipeline {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<IPipeline>;
  return Array.isArray(candidate.passes) && typeof candidate.render === 'function';
}

/** `true` when `value` satisfies the minimum {@link IRenderPass} shape. */
export function isRenderPass(value: unknown): value is IRenderPass {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<IRenderPass>;
  return typeof candidate.id === 'string' && typeof candidate.execute === 'function';
}
