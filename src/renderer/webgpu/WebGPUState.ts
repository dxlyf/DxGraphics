/**
 * Redundant-state-change eliminator for the WebGPU backend.
 *
 * WebGPU validates every encoder call, and unlike WebGL the driver does *not* skip
 * redundant ones: `setPipeline` with the pipeline that is already bound, or a
 * `setBindGroup` for a group that has not changed, still costs a validation pass and
 * a command-stream entry. Deduplicating them is therefore worth strictly more here
 * than it is in the WebGL backend.
 *
 * ## Shape
 *
 * Every setter takes the encoder it should forward to, plus the value. When the value
 * matches the cached one the setter returns immediately and the encoder is never
 * touched — which is exactly what the unit tests assert, by passing
 * `null` as the encoder and checking that nothing throws.
 *
 * ## Nesting and passes
 *
 * {@link WebGPUState.pushState}/{@link WebGPUState.popState} cover the "render to an
 * off-screen target, then continue" pattern, and
 * {@link WebGPUState.beginPass}/{@link WebGPUState.endPass} reset the per-pass caches
 * (pipeline, bind groups, vertex buffers) because a new pass starts from a clean
 * binding state by definition.
 *
 * @packageDocumentation
 */

import type { ScissorRect, ViewportLike } from '../interfaces/types';
import type { RenderState } from '../core/RenderState';
import type {
  GPUBindGroupLike,
  GPUBufferLike,
  GPUComputePassEncoderLike,
  GPUComputePipelineLike,
  GPURenderPassEncoderLike,
  GPURenderPipelineLike,
} from './WebGPUUtils';

/** Encoder a setter can forward to. */
export type PassEncoderLike = GPURenderPassEncoderLike;

/** One bound vertex buffer. */
export interface VertexBufferBinding {
  /** Buffer slot. */
  readonly slot: number;
  /** Bound buffer, or `null`. */
  readonly buffer: GPUBufferLike | null;
  /** Byte offset the slot starts at. */
  readonly offset: number;
  /** Bytes visible, or `null` for the whole buffer. */
  readonly size: number | null;
}

/** One bound index buffer. */
export interface IndexBufferBinding {
  /** Bound buffer. */
  readonly buffer: GPUBufferLike;
  /** Index format (`'uint16'`/`'uint32'`). */
  readonly format: string;
  /** Byte offset of the first index. */
  readonly offset: number;
}

/**
 * Comparable description of the shadow state.
 *
 * Two snapshots are equal exactly when the pass state they describe is equal.
 */
export interface WebGPUStateSnapshot {
  readonly pipeline: GPURenderPipelineLike | null;
  readonly computePipeline: GPUComputePipelineLike | null;
  readonly bindGroups: readonly (GPUBindGroupLike | null)[];
  readonly dynamicOffsets: readonly (readonly number[])[];
  readonly vertexBuffers: readonly VertexBufferBinding[];
  readonly indexBuffer: IndexBufferBinding | null;
  readonly viewport: ViewportLike;
  readonly scissor: ScissorRect | null;
  readonly blendConstant: readonly [number, number, number, number] | null;
  readonly stencilReference: number;
  readonly passActive: boolean;
  readonly passKind: 'render' | 'compute' | null;
}

/** Default maximum number of bind groups the shadow state tracks. */
export const DEFAULT_BIND_GROUP_SLOTS = 4;

/** Default maximum number of vertex buffer slots the shadow state tracks. */
export const DEFAULT_VERTEX_BUFFER_SLOTS = 8;

/**
 * Shadow copy of the WebGPU pass state.
 *
 * ```ts
 * const state = new WebGPUState();
 * state.setPipeline(pass, pipeline);   // records setPipeline
 * state.setPipeline(pass, pipeline);   // records nothing
 * ```
 */
export class WebGPUState {
  /** Cached pipeline. */
  private cachedPipeline: GPURenderPipelineLike | null = null;

  /** Cached compute pipeline. */
  private cachedComputePipeline: GPUComputePipelineLike | null = null;

  /** Cached bind groups, indexed by group index. */
  private readonly cachedBindGroups: (GPUBindGroupLike | null)[] = [];

  /** Cached dynamic offsets, indexed by group index. */
  private readonly cachedDynamicOffsets: number[][] = [];

  /** Cached vertex buffers, indexed by slot. */
  private readonly cachedVertexBuffers: (VertexBufferBinding | null)[] = [];

  /** Cached index buffer. */
  private cachedIndexBuffer: IndexBufferBinding | null = null;

  /** Cached viewport. */
  private cachedViewport: ViewportLike = { x: 0, y: 0, width: 0, height: 0 };

  /** `true` once a viewport has been recorded. */
  private viewportKnown: boolean = false;

  /** Cached scissor rectangle; `null` means "the whole attachment". */
  private cachedScissor: ScissorRect | null = null;

  /** `true` once a scissor state has been recorded. */
  private scissorKnown: boolean = false;

  /** Cached blend constant. */
  private cachedBlendConstant: [number, number, number, number] | null = null;

  /** Cached stencil reference. */
  private cachedStencilReference: number | null = null;

  /** `true` while a pass is active. */
  private passActive: boolean = false;

  /** Kind of the active pass. */
  private passKind: 'render' | 'compute' | null = null;

  /** Number of encoder calls this object has issued. */
  private issuedCalls: number = 0;

  /** Number of setters that actually changed something. */
  private changes: number = 0;

  /** Snapshot stack used by {@link WebGPUState.pushState}. */
  private readonly stack: WebGPUStateSnapshot[] = [];

  /** Encoder reference for {@link WebGPUState.popState}'s replay, when known. */
  private activeEncoder: GPURenderPassEncoderLike | null = null;

  /**
   * Creates the shadow state.
   *
   * @param options Slot counts; defaults suit a typical material.
   */
  constructor(options: { bindGroupSlots?: number; vertexBufferSlots?: number } = {}) {
    const groupSlots = Math.max(1, Math.floor(options.bindGroupSlots ?? DEFAULT_BIND_GROUP_SLOTS));
    const vertexSlots = Math.max(1, Math.floor(options.vertexBufferSlots ?? DEFAULT_VERTEX_BUFFER_SLOTS));
    for (let index = 0; index < groupSlots; index++) {
      this.cachedBindGroups.push(null);
      this.cachedDynamicOffsets.push([]);
    }
    for (let slot = 0; slot < vertexSlots; slot++) this.cachedVertexBuffers.push(null);
  }

  /* ------------------------------------------------------------------ queries */

  /** Encoder calls issued so far. */
  public get callCount(): number {
    return this.issuedCalls;
  }

  /** Setters that actually changed a value. */
  public get changeCount(): number {
    return this.changes;
  }

  /** `true` while a pass is active. */
  public get isPassActive(): boolean {
    return this.passActive;
  }

  /** Kind of the active pass, or `null`. */
  public get currentPassKind(): 'render' | 'compute' | null {
    return this.passKind;
  }

  /**
   * Returns the encoder of the active render pass.
   *
   * @returns The encoder recorded by {@link WebGPUState.beginPass}, or `null`.
   */
  public getActiveEncoder(): GPURenderPassEncoderLike | null {
    return this.activeEncoder;
  }

  /** Number of snapshots on the stack. */
  public get depth(): number {
    return this.stack.length;
  }

  /* ------------------------------------------------------------------- pipeline */

  /**
   * Binds a render pipeline.
   *
   * @param encoder Encoder to forward to, or `null` in a test.
   * @param pipeline Pipeline to bind, or `null`.
   * @returns This state, for chaining.
   */
  public setPipeline(encoder: PassEncoderLike | null, pipeline: GPURenderPipelineLike | null): this {
    if (this.cachedPipeline === pipeline) return this;
    this.cachedPipeline = pipeline;
    if (pipeline !== null && encoder !== null) {
      encoder.setPipeline(pipeline);
      this.issuedCalls++;
    }
    this.changes++;
    return this;
  }

  /**
   * Binds a compute pipeline.
   *
   * @param encoder Encoder to forward to, or `null`.
   * @param pipeline Pipeline to bind, or `null`.
   * @returns This state, for chaining.
   */
  public setComputePipeline(
    encoder: GPUComputePassEncoderLike | null,
    pipeline: GPUComputePipelineLike | null,
  ): this {
    if (this.cachedComputePipeline === pipeline) return this;
    this.cachedComputePipeline = pipeline;
    if (pipeline !== null && encoder !== null) {
      encoder.setPipeline(pipeline);
      this.issuedCalls++;
    }
    this.changes++;
    return this;
  }

  /* ---------------------------------------------------------------- bind groups */

  /**
   * Binds a bind group.
   *
   * Equality includes the dynamic offsets, because two bindings of the same group at
   * different offsets are genuinely different encodings.
   *
   * @param encoder Encoder to forward to.
   * @param index Group index.
   * @param group Bind group.
   * @param dynamicOffsets Dynamic offsets.
   * @returns This state, for chaining.
   */
  public setBindGroup(
    encoder: GPURenderPassEncoderLike | GPUComputePassEncoderLike | null,
    index: number,
    group: GPUBindGroupLike,
    dynamicOffsets?: readonly number[],
  ): this {
    const slot = Math.max(0, Math.floor(index));
    this.ensureGroupSlot(slot);

    const offsets = dynamicOffsets === undefined ? [] : [...dynamicOffsets];
    if (this.cachedBindGroups[slot] === group && sameNumbers(this.cachedDynamicOffsets[slot], offsets)) {
      return this;
    }

    this.cachedBindGroups[slot] = group;
    this.cachedDynamicOffsets[slot] = offsets;

    if (encoder !== null) {
      const target = encoder as GPURenderPassEncoderLike;
      if (offsets.length === 0) target.setBindGroup(slot, group);
      else target.setBindGroup(slot, group, offsets);
      this.issuedCalls++;
    }
    this.changes++;
    return this;
  }

  /* ------------------------------------------------------------- vertex buffers */

  /**
   * Binds a vertex buffer.
   *
   * @param encoder Encoder to forward to.
   * @param slot Buffer slot.
   * @param buffer Buffer, or `null` to unbind.
   * @param offset Byte offset.
   * @param size Bytes visible, or `undefined` for the whole buffer.
   * @returns This state, for chaining.
   */
  public setVertexBuffer(
    encoder: PassEncoderLike | null,
    slot: number,
    buffer: GPUBufferLike | null,
    offset: number = 0,
    size?: number,
  ): this {
    const index = Math.max(0, Math.floor(slot));
    this.ensureVertexSlot(index);

    const cached = this.cachedVertexBuffers[index];
    const byteOffset = Math.max(0, Math.floor(offset));
    const byteSize = size === undefined ? null : Math.max(0, Math.floor(size));

    if (
      cached !== null &&
      cached.buffer === buffer &&
      cached.offset === byteOffset &&
      cached.size === byteSize
    ) {
      return this;
    }

    this.cachedVertexBuffers[index] = { slot: index, buffer, offset: byteOffset, size: byteSize };

    if (encoder !== null) {
      if (byteSize === null) encoder.setVertexBuffer(index, buffer, byteOffset);
      else encoder.setVertexBuffer(index, buffer, byteOffset, byteSize);
      this.issuedCalls++;
    }
    this.changes++;
    return this;
  }

  /**
   * Binds an index buffer.
   *
   * @param encoder Encoder to forward to.
   * @param buffer Index buffer, or `null` to unbind.
   * @param format Index format.
   * @param offset Byte offset.
   * @returns This state, for chaining.
   */
  public setIndexBuffer(
    encoder: PassEncoderLike | null,
    buffer: GPUBufferLike | null,
    format: string = 'uint16',
    offset: number = 0,
  ): this {
    const byteOffset = Math.max(0, Math.floor(offset));

    if (buffer === null) {
      if (this.cachedIndexBuffer === null) return this;
      this.cachedIndexBuffer = null;
      this.changes++;
      return this;
    }

    const cached = this.cachedIndexBuffer;
    if (cached !== null && cached.buffer === buffer && cached.format === format && cached.offset === byteOffset) {
      return this;
    }

    this.cachedIndexBuffer = { buffer, format, offset: byteOffset };
    if (encoder !== null) {
      encoder.setIndexBuffer(buffer, format, byteOffset);
      this.issuedCalls++;
    }
    this.changes++;
    return this;
  }

  /* ------------------------------------------------------------- viewport/scissor */

  /**
   * Sets the viewport.
   *
   * @param encoder Encoder to forward to.
   * @param viewport Requested rectangle.
   * @returns This state, for chaining.
   */
  public setViewport(encoder: PassEncoderLike | null, viewport: ViewportLike): this {
    const cached = this.cachedViewport;
    if (
      this.viewportKnown &&
      cached.x === viewport.x &&
      cached.y === viewport.y &&
      cached.width === viewport.width &&
      cached.height === viewport.height
    ) {
      return this;
    }

    this.cachedViewport = {
      x: viewport.x,
      y: viewport.y,
      width: viewport.width,
      height: viewport.height,
    };
    this.viewportKnown = true;

    if (encoder !== null) {
      encoder.setViewport(viewport.x, viewport.y, Math.max(0, viewport.width), Math.max(0, viewport.height));
      this.issuedCalls++;
    }
    this.changes++;
    return this;
  }

  /**
   * Sets (or resets) the scissor rectangle.
   *
   * `null` means "the whole attachment"; WebGPU has no "disable scissor", so the
   * rectangle is set to a negative-origin full-coverage box by the caller, or the
   * renderer simply does not call `setScissorRect` again.
   *
   * @param encoder Encoder to forward to.
   * @param scissor Requested rectangle, or `null`.
   * @returns This state, for chaining.
   */
  public setScissor(encoder: PassEncoderLike | null, scissor: ScissorRect | null): this {
    const cached = this.cachedScissor;
    if (
      this.scissorKnown &&
      ((cached === null && scissor === null) ||
        (cached !== null &&
          scissor !== null &&
          cached.x === scissor.x &&
          cached.y === scissor.y &&
          cached.width === scissor.width &&
          cached.height === scissor.height))
    ) {
      return this;
    }

    this.cachedScissor = scissor === null ? null : { ...scissor };
    this.scissorKnown = true;

    if (encoder !== null && scissor !== null) {
      encoder.setScissorRect(
        Math.max(0, Math.floor(scissor.x)),
        Math.max(0, Math.floor(scissor.y)),
        Math.max(0, Math.floor(scissor.width)),
        Math.max(0, Math.floor(scissor.height)),
      );
      this.issuedCalls++;
    }
    this.changes++;
    return this;
  }

  /* -------------------------------------------------------------- misc state */

  /**
   * Sets the constant blend colour.
   *
   * @param encoder Encoder to forward to.
   * @param color Colour in 0..1 per channel.
   * @returns This state, for chaining.
   */
  public setBlendConstant(
    encoder: PassEncoderLike | null,
    color: readonly [number, number, number, number],
  ): this {
    const cached = this.cachedBlendConstant;
    if (
      cached !== null &&
      cached[0] === color[0] &&
      cached[1] === color[1] &&
      cached[2] === color[2] &&
      cached[3] === color[3]
    ) {
      return this;
    }

    this.cachedBlendConstant = [color[0], color[1], color[2], color[3]];
    if (encoder !== null && typeof encoder.setBlendConstant === 'function') {
      encoder.setBlendConstant({ r: color[0], g: color[1], b: color[2], a: color[3] });
      this.issuedCalls++;
    }
    this.changes++;
    return this;
  }

  /**
   * Sets the stencil reference value.
   *
   * @param encoder Encoder to forward to.
   * @param reference Reference value.
   * @returns This state, for chaining.
   */
  public setStencilReference(encoder: PassEncoderLike | null, reference: number): this {
    const value = Math.max(0, Math.floor(reference));
    if (this.cachedStencilReference === value) return this;

    this.cachedStencilReference = value;
    if (encoder !== null && typeof encoder.setStencilReference === 'function') {
      encoder.setStencilReference(value);
      this.issuedCalls++;
    }
    this.changes++;
    return this;
  }

  /* ------------------------------------------------------------------ passes */

  /**
   * Marks a render pass as started and clears the per-pass caches.
   *
   * A pass always starts with a clean binding state, so keeping the previous pass's
   * pipeline cached would skip a `setPipeline` the new pass needs.
   *
   * @param encoder Encoder the pass writes through.
   * @returns This state, for chaining.
   */
  public beginPass<T extends PassEncoderLike | GPUComputePassEncoderLike>(encoder: T, kind: 'render' | 'compute' = 'render'): T {
    this.passActive = true;
    this.passKind = kind;
    this.activeEncoder = kind === 'render' ? (encoder as unknown as GPURenderPassEncoderLike) : null;
    this.invalidatePassState();
    return encoder;
  }

  /**
   * Marks the active pass as finished.
   *
   * @returns This state, for chaining.
   */
  public endPass(): this {
    this.passActive = false;
    this.passKind = null;
    this.activeEncoder = null;
    this.invalidatePassState();
    return this;
  }

  /**
   * Clears the pass-scoped caches.
   *
   * Called by {@link WebGPUState.beginPass} and available directly for the case where
   * a pass was opened outside this object.
   */
  public invalidatePassState(): void {
    this.cachedPipeline = null;
    this.cachedComputePipeline = null;
    for (let index = 0; index < this.cachedBindGroups.length; index++) {
      this.cachedBindGroups[index] = null;
      this.cachedDynamicOffsets[index] = [];
    }
    for (let slot = 0; slot < this.cachedVertexBuffers.length; slot++) this.cachedVertexBuffers[slot] = null;
    this.cachedIndexBuffer = null;
    this.cachedBlendConstant = null;
    this.cachedStencilReference = null;
  }

  /**
   * Applies the members of a {@link RenderState} that a WebGPU pass can carry.
   *
   * Depth, blend, cull and topology live in the *pipeline*, not in the pass, so this
   * only forwards the pass-scoped state and is documented as such.
   *
   * @param encoder Encoder to forward to.
   * @param state Render state to read.
   * @param viewport Viewport to apply.
   * @param scissor Scissor rectangle to apply, or `null`.
   * @returns This state, for chaining.
   */
  public applyRenderState(
    encoder: PassEncoderLike | null,
    state: Readonly<RenderState>,
    viewport: ViewportLike,
    scissor: ScissorRect | null,
  ): this {
    this.setViewport(encoder, viewport);
    this.setScissor(encoder, scissor);
    if (state.stencil.enabled && this.cachedStencilReference !== state.stencil.reference) {
      this.setStencilReference(encoder, state.stencil.reference);
    }
    const blend = state.blend.constantColor;
    if (blend[0] !== 0 || blend[1] !== 0 || blend[2] !== 0 || blend[3] !== 0) {
      this.setBlendConstant(encoder, [blend[0], blend[1], blend[2], blend[3]]);
    }
    return this;
  }

  /* --------------------------------------------------------------- snapshots */

  /**
   * Describes the shadow state as a plain, comparable object.
   *
   * @returns A fresh snapshot.
   */
  public getSnapshot(): WebGPUStateSnapshot {
    return {
      pipeline: this.cachedPipeline,
      computePipeline: this.cachedComputePipeline,
      bindGroups: this.cachedBindGroups.map((group) => group),
      dynamicOffsets: this.cachedDynamicOffsets.map((offsets) => [...offsets]),
      vertexBuffers: this.cachedVertexBuffers
        .filter((binding): binding is VertexBufferBinding => binding !== null)
        .map((binding) => ({ ...binding })),
      indexBuffer: this.cachedIndexBuffer === null ? null : { ...this.cachedIndexBuffer },
      viewport: { ...this.cachedViewport },
      scissor: this.cachedScissor === null ? null : { ...this.cachedScissor },
      blendConstant: this.cachedBlendConstant === null ? null : ([...this.cachedBlendConstant] as [number, number, number, number]),
      stencilReference: this.cachedStencilReference ?? 0,
      passActive: this.passActive,
      passKind: this.passKind,
    };
  }

  /**
   * Pushes a snapshot of the current state.
   *
   * @returns This state, for chaining.
   */
  public pushState(): this {
    this.stack.push(this.getSnapshot());
    return this;
  }

  /**
   * Pops the most recent snapshot and re-applies it.
   *
   * @returns This state, for chaining.
   * @throws Error When the stack is empty.
   */
  public popState(): this {
    const snapshot = this.stack.pop();
    if (snapshot === undefined) {
      throw new Error(
        'WebGPUState.popState(): the state stack is empty. Every popState() must be paired ' +
          'with a pushState(); check that no early return skips the pop.',
      );
    }
    return this.restore(snapshot);
  }

  /**
   * Re-applies a snapshot through the ordinary setters.
   *
   * @param snapshot Snapshot to restore.
   * @returns This state, for chaining.
   */
  public restore(snapshot: WebGPUStateSnapshot): this {
    const encoder = this.activeEncoder;

    this.setPipeline(encoder, snapshot.pipeline);
    for (let index = 0; index < snapshot.bindGroups.length; index++) {
      const group = snapshot.bindGroups[index];
      if (group === null || group === undefined) continue;
      this.setBindGroup(encoder, index, group, snapshot.dynamicOffsets[index] ?? []);
    }
    for (const binding of snapshot.vertexBuffers) {
      this.setVertexBuffer(
        encoder,
        binding.slot,
        binding.buffer,
        binding.offset,
        binding.size === null ? undefined : binding.size,
      );
    }
    if (snapshot.indexBuffer !== null) {
      this.setIndexBuffer(encoder, snapshot.indexBuffer.buffer, snapshot.indexBuffer.format, snapshot.indexBuffer.offset);
    }
    this.setViewport(encoder, snapshot.viewport);
    this.setScissor(encoder, snapshot.scissor);
    if (snapshot.blendConstant !== null) this.setBlendConstant(encoder, snapshot.blendConstant);
    if (snapshot.stencilReference !== 0) this.setStencilReference(encoder, snapshot.stencilReference);
    return this;
  }

  /**
   * Empties the snapshot stack.
   *
   * @returns This state, for chaining.
   */
  public clearStack(): this {
    this.stack.length = 0;
    return this;
  }

  /**
   * Marks every cached value unknown, so the next setter re-issues its call.
   *
   * Used after a device loss, where the new device has no inherited state.
   */
  public invalidate(): void {
    this.cachedPipeline = null;
    this.cachedComputePipeline = null;
    this.cachedBindGroups.fill(null);
    for (const offsets of this.cachedDynamicOffsets) offsets.length = 0;
    this.cachedVertexBuffers.fill(null);
    this.cachedIndexBuffer = null;
    this.cachedViewport = { x: NaN, y: NaN, width: NaN, height: NaN };
    this.viewportKnown = false;
    this.cachedScissor = null;
    this.scissorKnown = false;
    this.cachedBlendConstant = null;
    this.cachedStencilReference = null;
    this.passActive = false;
    this.passKind = null;
    this.activeEncoder = null;
  }

  /** Resets the counters without touching the cached state. */
  public resetStatistics(): void {
    this.issuedCalls = 0;
    this.changes = 0;
  }

  /** @returns A human-readable summary. */
  public toString(): string {
    return (
      `WebGPUState(changes=${this.changes}, calls=${this.issuedCalls}, ` +
      `pass=${this.passKind ?? 'none'}, viewport=${this.cachedViewport.width}x${this.cachedViewport.height})`
    );
  }

  /* ---------------------------------------------------------------- internals */

  /** Grows the bind group cache so `index` exists. */
  private ensureGroupSlot(index: number): void {
    while (this.cachedBindGroups.length <= index) {
      this.cachedBindGroups.push(null);
      this.cachedDynamicOffsets.push([]);
    }
  }

  /** Grows the vertex buffer cache so `slot` exists. */
  private ensureVertexSlot(slot: number): void {
    while (this.cachedVertexBuffers.length <= slot) this.cachedVertexBuffers.push(null);
  }
}

/** `true` when two offset lists are element-wise equal. */
export function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
