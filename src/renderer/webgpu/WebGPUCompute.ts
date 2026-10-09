/**
 * Compute pipelines, dispatch and GPU timing.
 *
 * Compute work on WebGPU is a first-class path: the adapter advertises
 * `maxComputeWorkgroupSizeX/Y/Z` and `maxComputeWorkgroupsPerDimension`, and a
 * dispatch outside those bounds is a validation error rather than a silent no-op.
 *
 * ## Why the dispatch arguments are validated here
 *
 * A `dispatchWorkgroups(0, 0, 0)` is *legal* and does nothing, which makes an
 * off-by-one in a workgroup calculation look like "the compute shader is broken".
 * {@link validateWorkgroupCount} rejects zero, negative, fractional and non-finite
 * counts with a message naming the axis, the value and the limit, so the mistake
 * surfaces where it was made.
 *
 * ## Timestamp queries
 *
 * When the adapter offers `timestamp-query`,
 * {@link WebGPUCompute.supportsTimestamps} reports it and
 * {@link WebGPUCompute.createTimestampQuerySet} allocates a query set that a compute
 * pass can write into; {@link WebGPUCompute.resolveTimestamps} copies the results into
 * a mappable buffer.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import { createId } from '../../utils/Id';
import type { DeferredDestroyQueue, WebGPUDevice } from './WebGPUDevice';
import {
  GPUBufferUsageFlags,
  GPUMapMode,
  featureList,
  type GPUBindGroupLayoutLike,
  type GPUBindGroupLike,
  type GPUCommandBufferLike,
  type GPUCommandEncoderLike,
  type GPUComputePassEncoderLike,
  type GPUComputePipelineLike,
  type GPUDeviceLike,
  type GPUPipelineLayoutLike,
  type GPUQuerySetLike,
  type GPUShaderModuleLike,
  type GPUBufferLike,
} from './WebGPUUtils';
import { WebGPUBuffer } from './WebGPUBuffer';
import { buildBindGroupLayoutDescriptor, storageBufferEntry } from './WebGPUPipeline';

/** Native buffer handle, aliased for readability in this module. */
export type GPUBufferHandle = GPUBufferLike;

/** Logger for compute diagnostics. */
const log = createLogger('renderer:webgpu:compute');

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/** Highest value `GPUSupportedLimits.maxComputeWorkgroupsPerDimension` can report. */
export const DEFAULT_MAX_WORKGROUPS_PER_DIMENSION = 65535;

/**
 * Validates one workgroup count.
 *
 * @param value Value to validate.
 * @param axis Axis name (`'X'`, `'Y'`, `'Z'`), used in the error message.
 * @param max Highest allowed value.
 * @returns The validated integer count.
 * @throws Error When the value is not a positive integer within `max`.
 */
export function validateWorkgroupCount(
  value: unknown,
  axis: 'X' | 'Y' | 'Z',
  max: number = DEFAULT_MAX_WORKGROUPS_PER_DIMENSION,
): number {
  if (typeof value !== 'number') {
    throw new Error(
      `WebGPUCompute.dispatch: workgroups${axis} must be a number, received ${describeValue(value)}. ` +
        'Dispatch dimensions are workgroup counts, not thread counts.',
    );
  }
  if (Number.isNaN(value)) {
    throw new Error(
      `WebGPUCompute.dispatch: workgroups${axis} is NaN. The workgroup count is usually computed ` +
        'from a problem size; check that the size was defined before the dispatch.',
    );
  }
  if (!Number.isFinite(value)) {
    throw new Error(`WebGPUCompute.dispatch: workgroups${axis} must be finite, received ${value}.`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(
      `WebGPUCompute.dispatch: workgroups${axis} must be an integer, received ${value}. Round the ` +
        'workgroup count up (`Math.ceil(size / workgroupSize)`) instead of truncating it.',
    );
  }
  if (value <= 0) {
    throw new Error(
      `WebGPUCompute.dispatch: workgroups${axis} must be a positive integer, received ${value}. A ` +
        'dispatch of zero workgroups is legal but does nothing, so it is rejected to make the ' +
        'likely mistake visible.',
    );
  }
  if (value > max) {
    throw new Error(
      `WebGPUCompute.dispatch: workgroups${axis} is ${value}, which exceeds the adapter limit of ` +
        `${max} (maxComputeWorkgroupsPerDimension). Split the dispatch into several smaller ones.`,
    );
  }
  return value;
}

/** Validates all three workgroup counts. */
export function validateWorkgroups(
  x: unknown,
  y: unknown = 1,
  z: unknown = 1,
  max: number = DEFAULT_MAX_WORKGROUPS_PER_DIMENSION,
): { x: number; y: number; z: number } {
  return {
    x: validateWorkgroupCount(x, 'X', max),
    y: validateWorkgroupCount(y, 'Y', max),
    z: validateWorkgroupCount(z, 'Z', max),
  };
}

/** Describes a value for an error message. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `the string '${value}'`;
  return `${typeof value} ${String(value)}`;
}

/* -------------------------------------------------------------------------- */
/* Descriptors                                                                */
/* -------------------------------------------------------------------------- */

/** Descriptor accepted by {@link WebGPUCompute.createPipeline}. */
export interface ComputePipelineDescriptorLike {
  /** Pipeline label. */
  readonly label?: string;
  /** Shader module the entry point lives in. */
  readonly module: GPUShaderModuleLike;
  /** Entry point name; defaults to `'main'`. */
  readonly entryPoint?: string;
  /** Bind group layout descriptors, in group order. */
  readonly bindGroupLayouts?: readonly (GPUBindGroupLayoutLike | Record<string, unknown>)[];
  /** Pre-built pipeline layout; overrides {@link ComputePipelineDescriptorLike.bindGroupLayouts}. */
  readonly layout?: GPUPipelineLayoutLike | 'auto';
  /** Constants substituted into `override` declarations. */
  readonly constants?: Readonly<Record<string, number>>;
}

/** One bind-group binding handed to a dispatch. */
export interface ComputeBindGroupEntry {
  /** Buffer the binding reads or writes. */
  readonly buffer: GPUBufferLikeInput;
  /** Byte offset inside the buffer. */
  readonly offset?: number;
  /** Bytes visible to the shader. */
  readonly size?: number;
}

/** Anything that can be handed in as a buffer: the wrapper or the raw handle. */
export type GPUBufferLikeInput = WebGPUBuffer | GPUBufferLike;

/** Bind group description accepted by {@link WebGPUCompute.createBindGroup}. */
export interface ComputeBindGroupDescriptor {
  /** Bind group label. */
  readonly label?: string;
  /** Layout to build against. */
  readonly layout: GPUBindGroupLayoutLike;
  /** Bindings, keyed by `@binding(n)` index. */
  readonly entries: Readonly<Record<number, ComputeBindGroupEntry>>;
}

/** One bind group handed to {@link WebGPUCompute.dispatch}. */
export interface ComputeDispatchBindGroup {
  /** Group index (`@group(n)`). */
  readonly index: number;
  /** The bind group. */
  readonly group: GPUBindGroupLike;
  /** Dynamic offsets, for bindings declared with `hasDynamicOffset`. */
  readonly dynamicOffsets?: readonly number[];
}

/** Options accepted by {@link WebGPUCompute.dispatch}. */
export interface ComputeDispatchOptions {
  /** Compute pipeline to run. */
  readonly pipeline: GPUComputePipelineLike | WebGPUComputePipeline;
  /** Workgroups along X. */
  readonly workgroupsX: number;
  /** Workgroups along Y; defaults to `1`. */
  readonly workgroupsY?: number;
  /** Workgroups along Z; defaults to `1`. */
  readonly workgroupsZ?: number;
  /** Bind groups to set before the dispatch. */
  readonly bindGroups?: readonly ComputeDispatchBindGroup[];
  /** Pass label. */
  readonly label?: string;
  /**
   * Timestamp writes for the pass, forwarded verbatim when the adapter supports
   * `timestamp-query`.
   */
  readonly timestampWrites?: unknown;
  /** Submit the command buffer immediately. Defaults to `true`. */
  readonly submit?: boolean;
}

/** Result of a dispatch. */
export interface ComputeDispatchResult {
  /** The command buffer, or `null` when the dispatch was rejected. */
  readonly commandBuffer: GPUCommandBufferLike | null;
  /** Workgroup counts that were dispatched. */
  readonly workgroups: { readonly x: number; readonly y: number; readonly z: number };
  /** Total number of workgroups. */
  readonly totalWorkgroups: number;
}

/* -------------------------------------------------------------------------- */
/* WebGPUComputePipeline                                                      */
/* -------------------------------------------------------------------------- */

/** A compute pipeline plus the layouts it was created with. */
export class WebGPUComputePipeline {
  /** Stable identifier. */
  public readonly id: string;

  /** The native pipeline. */
  public readonly pipeline: GPUComputePipelineLike;

  /** Group index →bind group layout. */
  private readonly layouts: Map<number, GPUBindGroupLayoutLike>;

  /**
   * Wraps a pipeline.
   *
   * @param pipeline Native pipeline.
   * @param layouts Bind group layouts, by group index.
   */
  constructor(pipeline: GPUComputePipelineLike, layouts: Map<number, GPUBindGroupLayoutLike> = new Map()) {
    this.pipeline = pipeline;
    this.layouts = layouts;
    this.id = `webgpu-compute-pipeline-${createId()}`;
  }

  /**
   * Returns the bind group layout for a group index.
   *
   * @param index Group index.
   */
  public getBindGroupLayout(index: number = 0): GPUBindGroupLayoutLike | null {
    const known = this.layouts.get(index);
    if (known !== undefined) return known;
    if (typeof this.pipeline.getBindGroupLayout === 'function') return this.pipeline.getBindGroupLayout(index);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* WebGPUCompute                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Compute dispatch for one device.
 *
 * ```ts
 * const compute = new WebGPUCompute(device, { wrapper });
 * const pipeline = compute.createPipeline({ module, entryPoint: 'main', bindGroupLayouts: [...] });
 * compute.dispatch({ pipeline, workgroupsX: 64, workgroupsY: 64, bindGroups: [{ index: 0, group }] });
 * ```
 */
export class WebGPUCompute {
  /** Stable identifier. */
  public readonly id: string;

  /** Device compute work is submitted to. */
  private readonly device: GPUDeviceLike;

  /** Device wrapper, used for submissions and deferred destruction. */
  private readonly wrapper: WebGPUDevice | null;

  /** Deferred-destroy queue, or `null`. */
  private readonly destroyQueue: DeferredDestroyQueue | null;

  /** Highest workgroup count per dimension the adapter reported. */
  private readonly maxWorkgroupsPerDimension: number;

  /** `true` when the adapter offers timestamp queries. */
  private readonly timestampsAvailable: boolean;

  /** Timestamp query sets handed out, so they can be released with the owner. */
  private readonly querySets: Set<GPUQuerySetLike> = new Set();

  /** Number of dispatches issued. */
  private dispatchCount: number = 0;

  /** `true` once {@link WebGPUCompute.dispose} has run. */
  private disposed: boolean = false;

  /**
   * Creates a compute helper.
   *
   * @param device Device to dispatch on.
   * @param options Device wrapper and limit overrides.
   */
  constructor(
    device: GPUDeviceLike,
    options: {
      wrapper?: WebGPUDevice | null;
      maxWorkgroupsPerDimension?: number;
      timestamps?: boolean;
    } = {},
  ) {
    this.device = device;
    this.wrapper = options.wrapper ?? null;
    this.destroyQueue = this.wrapper?.deferredDestroy ?? null;
    this.id = `webgpu-compute-${createId()}`;

    const reported = device.limits?.['maxComputeWorkgroupsPerDimension'];
    this.maxWorkgroupsPerDimension =
      options.maxWorkgroupsPerDimension ??
      (typeof reported === 'number' && reported > 0 ? reported : DEFAULT_MAX_WORKGROUPS_PER_DIMENSION);

    this.timestampsAvailable = options.timestamps ?? hasTimestampSupport(device);
  }

  /** Highest workgroup count per dimension. */
  public get maxWorkgroups(): number {
    return this.maxWorkgroupsPerDimension;
  }

  /** Number of dispatches issued. */
  public get dispatches(): number {
    return this.dispatchCount;
  }

  /** `true` when this device supports timestamp queries. */
  public get supportsTimestamps(): boolean {
    return this.timestampsAvailable;
  }

  /** `true` once {@link WebGPUCompute.dispose} has run. */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /* ---------------------------------------------------------------- pipelines */

  /**
   * Creates a compute pipeline.
   *
   * @param descriptor Module, entry point and bind group layouts.
   * @returns The pipeline, or `null` when creation failed.
   */
  public createPipeline(descriptor: ComputePipelineDescriptorLike): WebGPUComputePipeline | null {
    if (this.disposed) {
      throw new Error(`WebGPUCompute(${this.id}): cannot create a pipeline after dispose().`);
    }

    const layouts = new Map<number, GPUBindGroupLayoutLike>();
    const declared = descriptor.bindGroupLayouts ?? [];
    declared.forEach((layout, index) => {
      const resolved =
        isBindGroupLayout(layout)
          ? layout
          : this.device.createBindGroupLayout(layout as Record<string, unknown>);
      layouts.set(index, resolved);
    });

    let layout: GPUPipelineLayoutLike | 'auto';
    if (descriptor.layout !== undefined) {
      layout = descriptor.layout;
    } else if (layouts.size === 0) {
      layout = 'auto';
    } else {
      layout = this.device.createPipelineLayout({
        label: `${descriptor.label ?? 'compute'}-layout`,
        bindGroupLayouts: [...layouts.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value),
      });
    }

    try {
      const pipeline = this.device.createComputePipeline({
        ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
        layout,
        compute: {
          module: descriptor.module,
          entryPoint: descriptor.entryPoint ?? 'main',
          ...(descriptor.constants === undefined ? {} : { constants: descriptor.constants }),
        },
      });
      return new WebGPUComputePipeline(pipeline, layouts);
    } catch (error) {
      log.error(`WebGPUCompute(${this.id}): createComputePipeline failed`, error);
      return null;
    }
  }

  /**
   * Builds a bind group layout from storage-buffer bindings.
   *
   * @param bindings Binding indices visible to the compute stage.
   * @param label Optional label.
   * @returns The layout.
   */
  public createStorageBindGroupLayout(
    bindings: readonly number[],
    label: string = 'compute-storage',
  ): GPUBindGroupLayoutLike {
    return this.device.createBindGroupLayout(
      buildBindGroupLayoutDescriptor(
        bindings.map((binding) => storageBufferEntry(binding, ['compute'])),
        label,
      ),
    );
  }

  /**
   * Builds a bind group from buffer bindings.
   *
   * @param descriptor Layout and bindings.
   * @returns The bind group, or `null` when creation failed.
   */
  public createBindGroup(descriptor: ComputeBindGroupDescriptor): GPUBindGroupLike | null {
    try {
      const entries = Object.keys(descriptor.entries)
        .map((key) => Number.parseInt(key, 10))
        .filter((binding) => Number.isFinite(binding))
        .sort((a, b) => a - b)
        .map((binding) => {
          const entry = descriptor.entries[binding];
          const buffer = resolveBuffer(entry.buffer);
          return {
            binding,
            resource: {
              buffer,
              ...(entry.offset === undefined ? {} : { offset: entry.offset }),
              ...(entry.size === undefined ? {} : { size: entry.size }),
            },
          };
        });

      return this.device.createBindGroup({
        ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
        layout: descriptor.layout,
        entries,
      });
    } catch (error) {
      log.error(`WebGPUCompute(${this.id}): createBindGroup failed`, error);
      return null;
    }
  }

  /* ------------------------------------------------------------------ dispatch */

  /**
   * Validates the workgroup counts without dispatching.
   *
   * @param x Workgroups along X.
   * @param y Workgroups along Y.
   * @param z Workgroups along Z.
   * @returns The validated counts.
   * @throws Error When any count is not a positive integer within the adapter limit.
   */
  public validate(x: unknown, y: unknown = 1, z: unknown = 1): { x: number; y: number; z: number } {
    return validateWorkgroups(x, y, z, this.maxWorkgroupsPerDimension);
  }

  /**
   * Dispatches a compute pipeline.
   *
   * @param options Pipeline, workgroup counts and bind groups.
   * @returns The dispatch result, including the workgroup counts that were used.
   * @throws Error When the workgroup counts are invalid or the helper is disposed.
   */
  public dispatch(options: ComputeDispatchOptions): ComputeDispatchResult {
    if (this.disposed) {
      throw new Error(`WebGPUCompute(${this.id}): the helper has been disposed.`);
    }

    // Validation runs before any GPU object is touched, so a bad count throws even
    // when the device is lost.
    const workgroups = this.validate(options.workgroupsX, options.workgroupsY ?? 1, options.workgroupsZ ?? 1);
    const pipeline = resolvePipeline(options.pipeline);

    const encoder = this.device.createCommandEncoder({
      label: options.label ?? `${this.id}-dispatch`,
    });

    const pass = encoder.beginComputePass(
      options.timestampWrites === undefined ? {} : { timestampWrites: options.timestampWrites },
    );
    this.applyBindGroups(pass, options.bindGroups ?? []);
    pass.setPipeline(pipeline);
    pass.dispatchWorkgroups(workgroups.x, workgroups.y, workgroups.z);
    pass.end();

    const commandBuffer = encoder.finish();
    this.dispatchCount++;

    const submit = options.submit ?? true;
    if (submit) this.submit([commandBuffer]);

    return {
      commandBuffer,
      workgroups,
      totalWorkgroups: workgroups.x * workgroups.y * workgroups.z,
    };
  }

  /**
   * Dispatches and waits for the GPU to finish.
   *
   * @param options Pipeline, workgroup counts and bind groups.
   * @returns The dispatch result.
   */
  public async dispatchAsync(options: ComputeDispatchOptions): Promise<ComputeDispatchResult> {
    const result = this.dispatch({ ...options, submit: true });
    await (this.wrapper?.onSubmittedWorkDone() ?? this.device.queue.onSubmittedWorkDone());
    return result;
  }

  /**
   * Submits command buffers, opening a deferred-destruction window when a wrapper is
   * available.
   *
   * @param commandBuffers Buffers to submit.
   */
  public submit(commandBuffers: readonly GPUCommandBufferLike[]): void {
    if (commandBuffers.length === 0) return;
    if (this.wrapper !== null) {
      this.wrapper.submit(commandBuffers);
      return;
    }
    this.device.queue.submit(commandBuffers);
  }

  /* ---------------------------------------------------------------- timestamps */

  /**
   * Allocates a timestamp query set.
   *
   * @param count Number of timestamps the set holds.
   * @param label Optional label.
   * @returns The query set, or `null` when the adapter does not support timestamps.
   */
  public createTimestampQuerySet(count: number, label: string = 'timestamps'): GPUQuerySetLike | null {
    if (!this.timestampsAvailable) {
      log.warn(
        `WebGPUCompute(${this.id}): timestamp queries are unavailable (the adapter did not expose ` +
          "the 'timestamp-query' feature). Request it when acquiring the device, and fall back to " +
          'CPU timing when it is refused.',
      );
      return null;
    }
    if (typeof this.device.createQuerySet !== 'function') return null;

    const querySet = this.device.createQuerySet({
      label,
      type: 'timestamp',
      count: Math.max(2, Math.floor(count)),
    });
    this.querySets.add(querySet);
    return querySet;
  }

  /**
   * Copies timestamp results into a mappable buffer.
   *
   * @param encoder Encoder to record the resolve into.
   * @param querySet Query set to resolve.
   * @param count Number of queries to resolve.
   * @returns The destination buffer, or `null`.
   */
  public resolveTimestamps(
    encoder: GPUCommandEncoderLike,
    querySet: GPUQuerySetLike,
    count: number,
  ): GPUBufferHandle | null {
    if (typeof encoder.resolveQuerySet !== 'function') {
      log.debug('this device does not implement resolveQuerySet');
      return null;
    }

    const queries = Math.max(1, Math.floor(count));
    const size = Math.max(8, queries * 8);
    const destination = this.device.createBuffer({
      label: `${this.id}-timestamps`,
      size,
      usage: GPUBufferUsageFlags.QUERY_RESOLVE | GPUBufferUsageFlags.COPY_SRC | GPUBufferUsageFlags.MAP_READ,
    });

    encoder.resolveQuerySet(querySet, 0, queries, destination, 0);
    return destination;
  }

  /**
   * Maps a timestamp buffer and returns the nanosecond deltas.
   *
   * @param buffer Buffer created by {@link WebGPUCompute.resolveTimestamps}.
   * @param count Number of timestamps resolved.
   * @returns Durations between consecutive timestamps, in nanoseconds.
   */
  public async readTimestamps(buffer: GPUBufferHandle, count: number): Promise<number[] | null> {
    try {
      await buffer.mapAsync(GPUMapMode.READ);
      const range = buffer.getMappedRange();
      const view = new BigUint64Array(range);
      const results: number[] = [];
      for (let i = 1; i < Math.max(1, Math.floor(count)); i++) {
        results.push(Number(view[i] - view[i - 1]));
      }
      buffer.unmap();
      this.destroyBuffer(buffer);
      return results;
    } catch (error) {
      log.warn(`WebGPUCompute(${this.id}): reading timestamps failed`, error);
      this.destroyBuffer(buffer);
      return null;
    }
  }

  /** Releases the query sets this helper created. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const querySet of this.querySets) {
      try {
        querySet.destroy();
      } catch {
        /* already destroyed */
      }
    }
    this.querySets.clear();
  }

  /** @returns A human-readable description. */
  public toString(): string {
    return `WebGPUCompute(${this.id}, ${this.dispatchCount} dispatches, maxWorkgroups=${this.maxWorkgroupsPerDimension})`;
  }

  /* ---------------------------------------------------------------- internals */

  /** Applies bind groups to a compute pass. */
  private applyBindGroups(pass: GPUComputePassEncoderLike, groups: readonly ComputeDispatchBindGroup[]): void {
    const ordered = [...groups].sort((a, b) => a.index - b.index);
    for (const group of ordered) {
      if (group.dynamicOffsets === undefined) pass.setBindGroup(group.index, group.group);
      else pass.setBindGroup(group.index, group.group, group.dynamicOffsets);
    }
  }

  /** Destroys a buffer through the deferred queue when there is one. */
  private destroyBuffer(buffer: GPUBufferHandle): void {
    if (this.destroyQueue !== null) this.destroyQueue.destroy(buffer);
    else buffer.destroy();
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resolves a buffer argument into the native handle.
 *
 * @param buffer Wrapper or raw handle.
 */
export function resolveBuffer(buffer: GPUBufferLikeInput): GPUBufferLike {
  if (buffer instanceof WebGPUBuffer) {
    const handle = buffer.handle;
    if (handle === null) {
      throw new Error(
        `WebGPUCompute: the buffer '${buffer.id}' has been destroyed. Create a new buffer, or ` +
          'recreate it before recording the dispatch.',
      );
    }
    return handle;
  }
  return buffer;
}

/**
 * Resolves a pipeline argument into the native handle.
 *
 * @param pipeline Wrapper or raw handle.
 */
export function resolvePipeline(pipeline: GPUComputePipelineLike | WebGPUComputePipeline): GPUComputePipelineLike {
  return pipeline instanceof WebGPUComputePipeline ? pipeline.pipeline : pipeline;
}

/**
 * Reports whether a value already looks like a bind group layout.
 *
 * A pipeline-derived layout is opaque, so the discriminator is "not a plain
 * descriptor": a descriptor has an `entries` array.
 *
 * @param value Candidate.
 */
export function isBindGroupLayout(
  value: GPUBindGroupLayoutLike | Record<string, unknown>,
): value is GPUBindGroupLayoutLike {
  return !Array.isArray((value as Record<string, unknown>)['entries']);
}

/**
 * Reads the device's `timestamp-query` feature.
 *
 * @param device Device to inspect.
 */
export function hasTimestampSupport(device: GPUDeviceLike): boolean {
  return featureList(device.features).includes('timestamp-query');
}
