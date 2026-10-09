/**
 * Render-pipeline construction and caching.
 *
 * A `GPURenderPipeline` is immutable and expensive to create (the implementation
 * compiles the WGSL and validates the whole vertex/fragment interface), so the
 * renderer keeps a cache keyed by a *structural hash* of the descriptor it would
 * build. Two draws that differ only in a uniform value must hit the same pipeline;
 * two draws that differ in blend state, vertex layout, topology or shader must not.
 *
 * ## Structural hash
 *
 * {@link hashPipelineDescriptor} serialises the descriptor with sorted object keys and
 * a fixed treatment of functions and typed arrays, then hashes the result. The hash is
 * deliberately *complete* rather than minimal: it includes every member the
 * descriptor carries, so a member that is added later and forgotten in the key
 * function can only cause a cache miss, never a wrong pipeline.
 *
 * ## Render state translation
 *
 * Depth/stencil, blend, primitive and multisample state are all built from the
 * renderer-agnostic {@link RenderState}, so a scene describes blending once and every
 * backend agrees on what it means.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import { createId } from '../../utils/Id';
import type { RenderState } from '../core/RenderState';
import {
  GPUBufferBindingType,
  GPUShaderStage,
  GPUTextureSampleType,
  toGPUBlendFactor,
  toGPUBlendOperation,
  toGPUColorWriteMask,
  toGPUCompareFunction,
  toGPUCullMode,
  toGPUFrontFace,
  toGPUPrimitiveTopology,
  type GPUBindGroupLayoutLike,
  type GPUDeviceLike,
  type GPUPipelineLayoutLike,
  type GPURenderPipelineLike,
} from './WebGPUUtils';
import type { PrimitiveTopology } from '../interfaces/types';

/** Logger for pipeline diagnostics. */
const log = createLogger('renderer:webgpu:pipeline');

/* -------------------------------------------------------------------------- */
/* Structural hashing                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Serialises a value into a stable string.
 *
 * Object keys are sorted so two descriptors written in a different member order hash
 * the same; typed arrays and `ArrayBuffer` views hash their contents; functions hash
 * as their name plus source length (enough to distinguish two different entry-point
 * wrappers without embedding megabytes of code in the key).
 *
 * @param value Value to serialise.
 * @returns A stable textual representation.
 */
export function stableSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value as number) ? String(value) : 'NaN';
  if (type === 'boolean' || type === 'bigint') return String(value);
  if (type === 'string') return JSON.stringify(value);
  if (type === 'function') {
    const fn = value as { name?: string; length?: number };
    return `fn:${fn.name ?? 'anonymous'}:${fn.length ?? 0}`;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as ArrayLike<number>;
    const parts: string[] = [];
    for (let i = 0; i < view.length; i++) parts.push(String(view[i]));
    return `[${parts.join(',')}]`;
  }
  if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([k, v]) => `${stableSerialize(k)}:${stableSerialize(v)}`);
    return `{${entries.sort().join(',')}}`;
  }
  if (value instanceof Set) {
    return `{${[...value].map((entry) => stableSerialize(entry)).sort().join(',')}}`;
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${key}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return String(value);
}

/**
 * 32-bit FNV-1a hash rendered as eight hex digits.
 *
 * @param value Text to hash.
 */
export function hashString32(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Builds the cache key for a render pipeline.
 *
 * The key is `<serialised-length>x<hash>` so that two descriptors of different sizes
 * cannot collide into the same key even if the 32-bit hash does.
 *
 * @param descriptor Pipeline descriptor.
 * @returns A stable key.
 */
export function hashPipelineDescriptor(descriptor: unknown): string {
  const serialised = stableSerialize(descriptor);
  return `${serialised.length.toString(36)}x${hashString32(serialised)}`;
}

/* -------------------------------------------------------------------------- */
/* State builders                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Builds the `depthStencil` half of a pipeline descriptor from a {@link RenderState}.
 *
 * @param state Render state to translate.
 * @param format Depth (or depth/stencil) attachment format.
 * @param options Depth-write override and stencil reference.
 * @returns The `depthStencil` descriptor, or `undefined` when no format was given.
 */
export function buildDepthStencilState(
  state: Readonly<RenderState>,
  format: string | null,
  options: { depthWriteEnabled?: boolean; stencilReference?: number } = {},
): Record<string, unknown> | undefined {
  if (format === null) return undefined;

  const depthCompare = toGPUCompareFunction(state.depth.compare);
  const depthWriteEnabled = options.depthWriteEnabled ?? (state.depth.write && state.depth.test);

  const descriptor: Record<string, unknown> = {
    format,
    depthWriteEnabled,
    depthCompare: state.depth.test ? depthCompare : 'always',
  };

  if (format.includes('stencil')) {
    const operation: Record<string, unknown> = {
      compare: state.stencil.enabled ? toGPUCompareFunction(state.stencil.compare) : 'always',
      failOp: 'keep',
      depthFailOp: 'keep',
      passOp: 'keep',
    };
    descriptor['stencilFront'] = { ...operation };
    descriptor['stencilBack'] = { ...operation };
    descriptor['stencilReadMask'] = state.stencil.readMask;
    descriptor['stencilWriteMask'] = state.stencil.writeMask;
    descriptor['stencilReference'] = options.stencilReference ?? state.stencil.reference;
  }

  return descriptor;
}

/**
 * Builds one `GPUColorTargetState` from a {@link RenderState}.
 *
 * @param state Render state to translate.
 * @param format Colour attachment format.
 * @param writeMask Colour-write mask override.
 * @returns The colour target descriptor.
 */
export function buildColorTargetState(
  state: Readonly<RenderState>,
  format: string,
  writeMask?: number,
): Record<string, unknown> {
  const target: Record<string, unknown> = { format };
  const mask = writeMask ?? toGPUColorWriteMask(state.colorWrite);
  if (mask !== 0xf) target['writeMask'] = mask;

  if (state.blend.enabled) {
    target['blend'] = {
      color: {
        srcFactor: toGPUBlendFactor(state.blend.srcFactor),
        dstFactor: toGPUBlendFactor(state.blend.dstFactor),
        operation: toGPUBlendOperation(state.blend.equation),
      },
      alpha: {
        srcFactor: toGPUBlendFactor(state.blend.separateAlpha ? state.blend.srcAlphaFactor : state.blend.srcFactor),
        dstFactor: toGPUBlendFactor(state.blend.separateAlpha ? state.blend.dstAlphaFactor : state.blend.dstFactor),
        operation: toGPUBlendOperation(state.blend.separateAlpha ? state.blend.alphaEquation : state.blend.equation),
      },
    };
  }

  return target;
}

/**
 * Builds the `primitive` half of a pipeline descriptor.
 *
 * @param state Render state to translate.
 * @param topology Topology for the pipeline.
 * @param options Strip index format and label used in diagnostics.
 * @returns The `primitive` descriptor.
 */
export function buildPrimitiveState(
  state: Readonly<RenderState>,
  topology: PrimitiveTopology,
  options: { stripIndexFormat?: string; label?: string } = {},
): Record<string, unknown> {
  const mode = toGPUPrimitiveTopology(topology, options.label ?? '');
  const descriptor: Record<string, unknown> = {
    topology: mode,
    cullMode: toGPUCullMode(state.cull),
    frontFace: toGPUFrontFace(state.frontFaceCCW),
  };
  if ((mode === 'line-strip' || mode === 'triangle-strip') && options.stripIndexFormat !== undefined) {
    descriptor['stripIndexFormat'] = options.stripIndexFormat;
  }
  return descriptor;
}

/**
 * Builds the `multisample` half of a pipeline descriptor.
 *
 * @param samples Sample count; `1` disables multisampling.
 * @param alphaToCoverage Enable alpha-to-coverage.
 * @returns The `multisample` descriptor.
 */
export function buildMultisampleState(samples: number, alphaToCoverage: boolean = false): Record<string, unknown> {
  const count = Math.max(1, Math.floor(samples));
  return count > 1 ? { count, alphaToCoverageEnabled: alphaToCoverage } : { count: 1 };
}

/* -------------------------------------------------------------------------- */
/* Layout builders                                                            */
/* -------------------------------------------------------------------------- */

/** One binding in a bind-group layout description. */
export interface BindGroupLayoutEntryLike {
  /** `@binding(n)` slot. */
  readonly binding: number;
  /** Stages that may read the binding. */
  readonly visibility: number;
  /** Buffer binding kind, when the binding is a buffer. */
  readonly bufferType?: string;
  /** `true` when the binding is a uniform with a dynamic offset. */
  readonly hasDynamicOffset?: boolean;
  /** Minimum binding size in bytes. */
  readonly minBindingSize?: number;
  /** Sampler type, when the binding is a sampler. */
  readonly samplerType?: string;
  /** Texture sample type, when the binding is a texture. */
  readonly sampleType?: string;
  /** Texture view dimension. */
  readonly viewDimension?: string;
  /** Storage texture access mode. */
  readonly access?: string;
  /** Storage texture format. */
  readonly format?: string;
}

/**
 * Builds a `GPUBindGroupLayoutDescriptor`.
 *
 * @param entries Bindings to describe.
 * @param label Optional label.
 * @returns The layout descriptor.
 */
export function buildBindGroupLayoutDescriptor(
  entries: readonly BindGroupLayoutEntryLike[],
  label?: string,
): Record<string, unknown> {
  return {
    ...(label === undefined ? {} : { label }),
    entries: entries.map((entry) => {
      const built: Record<string, unknown> = { binding: entry.binding, visibility: entry.visibility };
      if (entry.bufferType !== undefined) {
        built['buffer'] = {
          type: entry.bufferType,
          ...(entry.hasDynamicOffset === true ? { hasDynamicOffset: true } : {}),
          ...(entry.minBindingSize !== undefined ? { minBindingSize: entry.minBindingSize } : {}),
        };
      }
      if (entry.samplerType !== undefined) built['sampler'] = { type: entry.samplerType };
      if (entry.sampleType !== undefined || entry.viewDimension !== undefined) {
        built['texture'] = {
          sampleType: entry.sampleType ?? GPUTextureSampleType.Float,
          ...(entry.viewDimension === undefined ? {} : { viewDimension: entry.viewDimension }),
        };
      }
      if (entry.access !== undefined) {
        built['storageTexture'] = {
          access: entry.access,
          ...(entry.format === undefined ? {} : { format: entry.format }),
        };
      }
      return built;
    }),
  };
}

/**
 * Describes a uniform buffer binding.
 *
 * @param binding `@binding(n)` slot.
 * @param stages Stages that read it.
 * @param options Dynamic offset and minimum size.
 */
export function uniformBufferEntry(
  binding: number,
  stages: readonly ('vertex' | 'fragment' | 'compute')[],
  options: { dynamic?: boolean; minBindingSize?: number } = {},
): BindGroupLayoutEntryLike {
  let visibility = 0;
  for (const stage of stages) {
    visibility |= stage === 'vertex' ? GPUShaderStage.VERTEX : stage === 'fragment' ? GPUShaderStage.FRAGMENT : GPUShaderStage.COMPUTE;
  }
  return {
    binding,
    visibility,
    bufferType: GPUBufferBindingType.Uniform,
    ...(options.dynamic === true ? { hasDynamicOffset: true } : {}),
    ...(options.minBindingSize === undefined ? {} : { minBindingSize: options.minBindingSize }),
  };
}

/**
 * Describes a read-only storage buffer binding.
 *
 * @param binding `@binding(n)` slot.
 * @param stages Stages that read it.
 */
export function storageBufferEntry(
  binding: number,
  stages: readonly ('vertex' | 'fragment' | 'compute')[],
): BindGroupLayoutEntryLike {
  let visibility = 0;
  for (const stage of stages) {
    visibility |= stage === 'vertex' ? GPUShaderStage.VERTEX : stage === 'fragment' ? GPUShaderStage.FRAGMENT : GPUShaderStage.COMPUTE;
  }
  return { binding, visibility, bufferType: GPUBufferBindingType.ReadOnlyStorage };
}

/**
 * Describes a sampled-texture binding.
 *
 * @param binding `@binding(n)` slot.
 * @param stages Stages that read it.
 * @param options Sample type and view dimension.
 */
export function textureEntry(
  binding: number,
  stages: readonly ('vertex' | 'fragment' | 'compute')[],
  options: { sampleType?: string; viewDimension?: string } = {},
): BindGroupLayoutEntryLike {
  let visibility = 0;
  for (const stage of stages) {
    visibility |= stage === 'vertex' ? GPUShaderStage.VERTEX : stage === 'fragment' ? GPUShaderStage.FRAGMENT : GPUShaderStage.COMPUTE;
  }
  return {
    binding,
    visibility,
    sampleType: options.sampleType ?? GPUTextureSampleType.Float,
    ...(options.viewDimension === undefined ? {} : { viewDimension: options.viewDimension }),
  };
}

/* -------------------------------------------------------------------------- */
/* Pipeline cache                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Bounded LRU cache for pipelines.
 *
 * Same shape as the WebGL program cache, implemented separately so the two backends
 * stay independent. WebGPU pipelines cannot be destroyed explicitly — they are
 * released when nothing references them — so eviction simply drops the reference.
 */
export class PipelineLRUCache<V> {
  /** Entries in least-recently-used-first order. */
  private readonly entries: Map<string, V> = new Map();

  /** Upper bound on the number of entries. */
  private readonly limit: number;

  /** Successful lookups. */
  private hits: number = 0;

  /** Failed lookups. */
  private misses: number = 0;

  /** Evictions performed. */
  private evictions: number = 0;

  /**
   * Creates a cache.
   *
   * @param maxSize Maximum number of entries; clamped to at least `1`.
   */
  constructor(maxSize: number = 64) {
    this.limit = Math.max(1, Math.floor(maxSize));
  }

  /** Maximum number of entries. */
  public get maxSize(): number {
    return this.limit;
  }

  /** Current number of entries. */
  public get size(): number {
    return this.entries.size;
  }

  /** Successful lookups. */
  public get hitCount(): number {
    return this.hits;
  }

  /** Failed lookups. */
  public get missCount(): number {
    return this.misses;
  }

  /** Evictions performed. */
  public get evictionCount(): number {
    return this.evictions;
  }

  /**
   * Looks a value up, marking it most recently used.
   *
   * @param key Cache key.
   */
  public get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /**
   * Inserts a value, evicting the least recently used entry when full.
   *
   * @param key Cache key.
   * @param value Value to store.
   */
  public set(key: string, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
      this.evictions++;
    }
  }

  /**
   * Removes one entry.
   *
   * @param key Cache key.
   */
  public delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Removes every entry. */
  public clear(): void {
    this.entries.clear();
  }

  /** Cache keys, least recently used first. */
  public keys(): string[] {
    return [...this.entries.keys()];
  }
}

/** Descriptor accepted by {@link WebGPUPipeline.describe}. */
export interface RenderPipelineDescriptorLike {
  /** Pipeline label. */
  readonly label?: string;
  /** Vertex state. */
  readonly vertex: Record<string, unknown>;
  /** Fragment state, or `null` for a depth-only pipeline. */
  readonly fragment?: Record<string, unknown> | null;
  /** Primitive state. */
  readonly primitive: Record<string, unknown>;
  /** Depth/stencil state. */
  readonly depthStencil?: Record<string, unknown>;
  /** Multisample state. */
  readonly multisample?: Record<string, unknown>;
  /** Pipeline layout. */
  readonly layout: GPUPipelineLayoutLike | 'auto';
}

/**
 * A cached render pipeline.
 *
 * ```ts
 * const pipelines = new WebGPUPipelineCache(device);
 * const pipeline = pipelines.acquire(descriptor);
 * pass.setPipeline(pipeline.pipeline);
 * ```
 */
export class WebGPUPipeline {
  /** Stable identifier. */
  public readonly id: string;

  /** Cache key the pipeline is stored under. */
  public readonly key: string;

  /** The native pipeline. */
  public readonly pipeline: GPURenderPipelineLike;

  /** Descriptor the pipeline was built from. */
  public readonly descriptor: RenderPipelineDescriptorLike;

  /**
   * Wraps a created pipeline.
   *
   * @param pipeline Native pipeline.
   * @param key Cache key.
   * @param descriptor Descriptor it was built from.
   */
  constructor(pipeline: GPURenderPipelineLike, key: string, descriptor: RenderPipelineDescriptorLike) {
    this.pipeline = pipeline;
    this.key = key;
    this.descriptor = descriptor;
    this.id = `webgpu-pipeline-${createId()}`;
  }

  /**
   * Returns a bind group layout the pipeline derived, when the implementation
   * exposes it.
   *
   * @param index Bind group index.
   */
  public getBindGroupLayout(index: number = 0): GPUBindGroupLayoutLike | null {
    if (typeof this.pipeline.getBindGroupLayout !== 'function') return null;
    return this.pipeline.getBindGroupLayout(index);
  }

  /** @returns A human-readable description. */
  public toString(): string {
    return `WebGPUPipeline(${this.descriptor.label ?? this.id}, key=${this.key})`;
  }
}

/**
 * Creates and caches render pipelines for one device.
 */
export class WebGPUPipelineCache {
  /** Device pipelines are created on. */
  private readonly device: GPUDeviceLike;

  /** Underlying LRU. */
  private readonly cache: PipelineLRUCache<WebGPUPipeline>;

  /** Layouts, keyed by structural hash. */
  private readonly layouts: Map<string, GPUPipelineLayoutLike> = new Map();

  /** Bind group layouts, keyed by structural hash. */
  private readonly bindGroupLayouts: Map<string, GPUBindGroupLayoutLike> = new Map();

  /** Number of pipelines actually created. */
  private creationCount: number = 0;

  /**
   * Creates a cache.
   *
   * @param device Device to create pipelines on.
   * @param maxSize Maximum number of pipelines kept. Defaults to `64`.
   */
  constructor(device: GPUDeviceLike, maxSize: number = 64) {
    this.device = device;
    this.cache = new PipelineLRUCache<WebGPUPipeline>(maxSize);
  }

  /** Number of cached pipelines. */
  public get size(): number {
    return this.cache.size;
  }

  /** Pipelines created since construction. */
  public get creations(): number {
    return this.creationCount;
  }

  /** Successful cache lookups. */
  public get hits(): number {
    return this.cache.hitCount;
  }

  /** Failed cache lookups. */
  public get misses(): number {
    return this.cache.missCount;
  }

  /**
   * Returns the cached pipeline for a descriptor, creating it when absent.
   *
   * @param descriptor Pipeline descriptor.
   * @returns The pipeline, or `null` when creation failed.
   */
  public acquire(descriptor: RenderPipelineDescriptorLike): WebGPUPipeline | null {
    const key = hashPipelineDescriptor(descriptor);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    try {
      const pipeline = this.device.createRenderPipeline(descriptor as unknown as Record<string, unknown>);
      const wrapped = new WebGPUPipeline(pipeline, key, descriptor);
      this.cache.set(key, wrapped);
      this.creationCount++;
      return wrapped;
    } catch (error) {
      log.error(
        `WebGPUPipelineCache: createRenderPipeline failed for '${descriptor.label ?? key}'`,
        error,
      );
      return null;
    }
  }

  /**
   * Returns a cached pipeline layout, creating it when absent.
   *
   * @param descriptor Pipeline layout descriptor.
   * @returns The layout.
   */
  public acquireLayout(descriptor: Record<string, unknown>): GPUPipelineLayoutLike {
    const key = hashPipelineDescriptor(descriptor);
    const cached = this.layouts.get(key);
    if (cached !== undefined) return cached;
    const layout = this.device.createPipelineLayout(descriptor);
    this.layouts.set(key, layout);
    return layout;
  }

  /**
   * Returns a cached bind group layout, creating it when absent.
   *
   * @param descriptor Bind group layout descriptor.
   * @returns The layout.
   */
  public acquireBindGroupLayout(descriptor: Record<string, unknown>): GPUBindGroupLayoutLike {
    const key = hashPipelineDescriptor(descriptor);
    const cached = this.bindGroupLayouts.get(key);
    if (cached !== undefined) return cached;
    const layout = this.device.createBindGroupLayout(descriptor);
    this.bindGroupLayouts.set(key, layout);
    return layout;
  }

  /**
   * Removes one cached pipeline.
   *
   * @param descriptor Descriptor whose pipeline should be dropped.
   */
  public release(descriptor: RenderPipelineDescriptorLike): boolean {
    return this.cache.delete(hashPipelineDescriptor(descriptor));
  }

  /** Drops every cached pipeline and layout. */
  public clear(): void {
    this.cache.clear();
    this.layouts.clear();
    this.bindGroupLayouts.clear();
  }

  /** @returns A human-readable description. */
  public toString(): string {
    return `WebGPUPipelineCache(${this.cache.size} pipelines, ${this.creationCount} created)`;
  }
}
