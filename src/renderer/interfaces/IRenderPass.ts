/**
 * Render-pass contract.
 *
 * A pass owns one stage of a frame: the main geometry pass, a shadow pass, a
 * post-processing pass, and so on. Passes are ordered and executed by a
 * `RenderPipeline`; each pass is handed the shared per-frame `RenderContext`.
 *
 * `RenderContext` is imported as a *type only* from `core`, which keeps the
 * `interfaces` ↔ `core` relationship one-directional at runtime.
 *
 * @packageDocumentation
 */

import type { RenderContext } from '../core/RenderContext';
import type { IRenderTarget } from './IRenderTarget';
import type { ClearOptions, ViewportLike } from './types';

/**
 * Lifecycle callbacks a pass may implement.
 *
 * All members are optional so a pass can be written as a bare object literal.
 */
export interface PassHooks {
  /** Called once, before the first {@link IRenderPass.execute}. */
  onAttach?(context: RenderContext): void;
  /** Called when the pass is removed from its pipeline. */
  onDetach?(): void;
  /** Called once per frame, before the pass executes. */
  onBeforeExecute?(context: RenderContext): void;
  /** Called once per frame, after the pass executed. */
  onAfterExecute?(context: RenderContext): void;
  /** Called after a resize, with the new logical size. */
  onResize?(width: number, height: number, pixelRatio: number): void;
}

/** A single ordered stage of a frame. */
export interface IRenderPass extends PassHooks {
  /** Stable identifier, used for reordering and diagnostics. */
  readonly id: string;

  /** Human-readable label shown by profilers. */
  readonly name: string;

  /** `true` when the pass participates in the frame. */
  enabled: boolean;

  /**
   * Sort position within the pipeline; lower values run first.
   *
   * Equal values keep insertion order (the sort is stable).
   */
  order: number;

  /**
   * Render target the pass draws into.
   *
   * `null` means "the renderer's current target", which lets the pipeline drive
   * the binding instead of the pass.
   */
  readonly target: IRenderTarget | null;

  /**
   * Clears the target before executing, when set.
   *
   * `null`/`undefined` leaves the target's contents intact.
   */
  readonly clearOptions?: ClearOptions | null;

  /** Viewport to apply before executing, or `null` to keep the current one. */
  readonly viewport?: ViewportLike | null;

  /**
   * Executes the pass.
   *
   * @param context Shared per-frame state, already updated for this frame.
   */
  execute(context: RenderContext): void;
}

/** Options accepted by {@link createRenderPass}. */
export interface RenderPassOptions extends PassHooks {
  /** Identifier override; defaults to a generated one. */
  id?: string;
  /** Display name; defaults to the identifier. */
  name?: string;
  /** Initial `order`; defaults to `0`. */
  order?: number;
  /** Initial `enabled`; defaults to `true`. */
  enabled?: boolean;
  /** Render target the pass draws into. */
  target?: IRenderTarget | null;
  /** Clear description applied before the pass executes. */
  clearOptions?: ClearOptions | null;
  /** Viewport applied before the pass executes. */
  viewport?: ViewportLike | null;
  /** Body of the pass. */
  execute: (context: RenderContext) => void;
}

/**
 * Builds an {@link IRenderPass} from a description object.
 *
 * Convenience for the common "one pass, one callback" case; classes are just as
 * valid an implementation of the interface.
 *
 * @param options Pass description, including the required `execute` callback.
 * @returns A pass object.
 */
export function createRenderPass(options: RenderPassOptions): IRenderPass {
  const pass: IRenderPass = {
    id: options.id ?? `pass-${nextPassId++}`,
    name: options.name ?? options.id ?? `pass-${nextPassId}`,
    enabled: options.enabled ?? true,
    order: options.order ?? 0,
    target: options.target ?? null,
    clearOptions: options.clearOptions ?? null,
    viewport: options.viewport ?? null,
    execute: options.execute,
  };

  if (options.onAttach) pass.onAttach = options.onAttach;
  if (options.onDetach) pass.onDetach = options.onDetach;
  if (options.onBeforeExecute) pass.onBeforeExecute = options.onBeforeExecute;
  if (options.onAfterExecute) pass.onAfterExecute = options.onAfterExecute;
  if (options.onResize) pass.onResize = options.onResize;

  return pass;
}

/** Counter backing the default pass identifiers. */
let nextPassId = 0;
