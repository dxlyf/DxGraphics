/**
 * WebGPU adapter acquisition and safe device requests.
 *
 * `requestDevice` fails wholesale when *any* requested feature or limit is not
 * supported, which turns "I would like timestamp queries" into "the renderer does
 * not start on this machine". {@link requestDeviceSafe} therefore filters the
 * requested features against the adapter's feature set and clamps every requested
 * limit to the adapter's own value before asking, and retries with an empty
 * descriptor if the filtered request still fails.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import {
  featureList,
  getGPUProvider,
  hasFeature,
  type GPUAdapterInfoLike,
  type GPUAdapterLike,
  type GPUDeviceLike,
  type GPUProviderLike,
} from './WebGPUUtils';

/** Logger for adapter diagnostics. */
const log = createLogger('renderer:webgpu:adapter');

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/** Options accepted by {@link requestAdapterSafe}. */
export interface WebGPUAdapterOptions {
  /** Power preference hint. Defaults to `'high-performance'`. */
  powerPreference?: 'low-power' | 'high-performance';
  /** Accept the software fallback adapter. Defaults to `false`. */
  forceFallbackAdapter?: boolean;
  /** Reject adapters the driver reports as a major performance caveat. */
  requireHardware?: boolean;
}

/** Options accepted by {@link requestDeviceSafe}. */
export interface WebGPUDeviceRequestOptions {
  /** Features to request; unsupported ones are dropped rather than fatal. */
  requiredFeatures?: readonly string[];
  /**
   * Limits to request, keyed by `GPUSupportedLimits` member name.
   *
   * Each value is clamped to the adapter's own limit, so asking for
   * `maxTextureDimension2D: 16384` on hardware that reports `8192` yields `8192`.
   */
  requiredLimits?: Readonly<Record<string, number>>;
  /** Human-readable label applied to the device. */
  label?: string;
}

/** Result of a safe device request. */
export interface WebGPUDeviceAcquireResult {
  /** The device, or `null` when acquisition failed. */
  readonly device: GPUDeviceLike | null;
  /** Features that were actually granted. */
  readonly features: readonly string[];
  /** Features that were requested but are unavailable on this adapter. */
  readonly droppedFeatures: readonly string[];
  /** Limits that were clamped down from the request. */
  readonly clampedLimits: Readonly<Record<string, number>>;
  /** `true` when the final attempt used an empty descriptor. */
  readonly degraded: boolean;
  /** Error message from the last failed attempt, when there was one. */
  readonly error: string | null;
}

/* -------------------------------------------------------------------------- */
/* Capabilities report                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Feature and limit report for one adapter.
 *
 * The shape mirrors {@link RendererInfo.capabilities}: `toList()` produces the
 * labels, and the numeric members answer the "can I use this path?" questions.
 */
export class WebGPUCapabilities {
  /** Adapter the report was built from, or `null` for a synthetic report. */
  public readonly adapter: GPUAdapterLike | null;

  /** Features the adapter reported, sorted. */
  public readonly features: readonly string[];

  /** Adapter identification, when the driver exposes it. */
  public readonly info: GPUAdapterInfoLike | null;

  /** Largest 2D texture dimension, in texels. */
  public readonly maxTextureDimension2D: number;

  /** Largest 3D texture dimension, in texels. */
  public readonly maxTextureDimension3D: number;

  /** Largest texture array layer count. */
  public readonly maxTextureArrayLayers: number;

  /** Largest buffer size in bytes. */
  public readonly maxBufferSize: number;

  /** Maximum number of vertex buffers. */
  public readonly maxVertexBuffers: number;

  /** Maximum number of vertex attributes. */
  public readonly maxVertexAttributes: number;

  /** Maximum number of bind groups. */
  public readonly maxBindGroups: number;

  /** Maximum number of sampled textures per shader stage. */
  public readonly maxSampledTexturesPerShaderStage: number;

  /** Maximum number of storage buffers per shader stage. */
  public readonly maxStorageBuffersPerShaderStage: number;

  /** Maximum number of uniform buffers per shader stage. */
  public readonly maxUniformBuffersPerShaderStage: number;

  /** Workgroup size limit along X. */
  public readonly maxComputeWorkgroupSizeX: number;

  /** Workgroups per dispatch dimension. */
  public readonly maxComputeWorkgroupsPerDimension: number;

  /** Bytes of workgroup storage. */
  public readonly maxComputeWorkgroupStorageSize: number;

  /** Largest supported MSAA sample count. */
  public readonly maxSamples: number;

  /** Uniform buffer offset alignment, in bytes. */
  public readonly minUniformBufferOffsetAlignment: number;

  /** `true` when timestamp queries are available. */
  public readonly supportsTimestampQuery: boolean;

  /** `true` when a float32-filterable texture can be sampled with linear filtering. */
  public readonly supportsFloat32Filterable: boolean;

  /** `true` when depth-clip control is available. */
  public readonly supportsDepthClipControl: boolean;

  /** `true` when indirect-first-instance is available. */
  public readonly supportsIndirectFirstInstance: boolean;

  /**
   * Builds a report.
   *
   * @param adapter Adapter to read, or `null` for a synthetic report.
   * @param overrides Optional limit overrides (used by tests and fallback paths).
   */
  constructor(adapter: GPUAdapterLike | null = null, overrides: Readonly<Record<string, number>> = {}) {
    this.adapter = adapter;
    const limits: Readonly<Record<string, number>> = adapter?.limits ?? {};
    this.info = adapter?.info ?? null;
    this.features = featureList(adapter?.features ?? []).sort();

    const read = (name: string, fallback: number): number => {
      const override = overrides[name];
      if (typeof override === 'number' && Number.isFinite(override)) return override;
      const value = limits[name];
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
    };

    this.maxTextureDimension2D = read('maxTextureDimension2D', 8192);
    this.maxTextureDimension3D = read('maxTextureDimension3D', 2048);
    this.maxTextureArrayLayers = read('maxTextureArrayLayers', 256);
    this.maxBufferSize = read('maxBufferSize', 256 * 1024 * 1024);
    this.maxVertexBuffers = read('maxVertexBuffers', 8);
    this.maxVertexAttributes = read('maxVertexAttributes', 16);
    this.maxBindGroups = read('maxBindGroups', 4);
    this.maxSampledTexturesPerShaderStage = read('maxSampledTexturesPerShaderStage', 16);
    this.maxStorageBuffersPerShaderStage = read('maxStorageBuffersPerShaderStage', 8);
    this.maxUniformBuffersPerShaderStage = read('maxUniformBuffersPerShaderStage', 12);
    this.maxComputeWorkgroupSizeX = read('maxComputeWorkgroupSizeX', 256);
    this.maxComputeWorkgroupsPerDimension = read('maxComputeWorkgroupsPerDimension', 65535);
    this.maxComputeWorkgroupStorageSize = read('maxComputeWorkgroupStorageSize', 16384);
    this.maxSamples = read('maxSamples', 4);
    this.minUniformBufferOffsetAlignment = read('minUniformBufferOffsetAlignment', 256);

    this.supportsTimestampQuery = this.features.includes('timestamp-query');
    this.supportsFloat32Filterable = this.features.includes('float32-filterable');
    this.supportsDepthClipControl = this.features.includes('depth-clip-control');
    this.supportsIndirectFirstInstance = this.features.includes('indirect-first-instance');
  }

  /**
   * Reports whether a feature is available.
   *
   * @param name Feature name, e.g. `'timestamp-query'`.
   */
  public supports(name: string): boolean {
    return this.features.includes(name);
  }

  /**
   * Clamps a 2D texture size to the adapter's limit.
   *
   * Only `maxTextureDimension2D` applies: a 2D texture is not constrained by the 3D
   * limit, and clamping against the smaller of the two would under-report what the
   * device can allocate.
   *
   * @param size Requested dimension.
   */
  public clampTextureSize(size: number): number {
    const value = Math.floor(size);
    if (!Number.isFinite(value) || value < 1) return 1;
    return Math.min(value, Math.max(1, this.maxTextureDimension2D));
  }

  /**
   * Clamps a sample count to the adapter's limit.
   *
   * @param samples Requested sample count.
   */
  public clampSamples(samples: number): number {
    if (!Number.isFinite(samples) || samples <= 1) return 1;
    return Math.max(1, Math.min(Math.floor(samples), Math.max(1, this.maxSamples)));
  }

  /**
   * Converts the report into the labels {@link RendererInfo.capabilities} carries.
   *
   * @returns Capability names, sorted so snapshots stay stable.
   */
  public toList(): string[] {
    const names: string[] = ['webgpu'];
    if (this.supportsTimestampQuery) names.push('timestamp-query');
    if (this.supportsFloat32Filterable) names.push('float32-filterable');
    if (this.supportsDepthClipControl) names.push('depth-clip-control');
    if (this.supportsIndirectFirstInstance) names.push('indirect-first-instance');
    names.push(`max-texture-2d:${this.maxTextureDimension2D}`);
    names.push(`max-buffer:${this.maxBufferSize}`);
    return names.sort();
  }

  /** @returns A human-readable summary. */
  public toString(): string {
    return (
      `WebGPUCapabilities(${this.features.length} features, ` +
      `maxTextureDimension2D=${this.maxTextureDimension2D}, maxBufferSize=${this.maxBufferSize}, ` +
      `maxSamples=${this.maxSamples})`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Adapter acquisition                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Requests an adapter, returning `null` instead of throwing.
 *
 * @param options Power preference and fallback acceptance.
 * @param provider GPU entry point; defaults to `navigator.gpu`.
 * @returns The adapter, or `null` when WebGPU is unavailable or no adapter exists.
 */
export async function requestAdapterSafe(
  options: WebGPUAdapterOptions = {},
  provider: GPUProviderLike | null = getGPUProvider(),
): Promise<GPUAdapterLike | null> {
  if (provider === null) {
    log.warn(
      'WebGPU is not available in this runtime: `navigator.gpu.requestAdapter` was not found. ' +
        'Use the WebGL backend, or run in a browser/worker with WebGPU enabled.',
    );
    return null;
  }

  const descriptor: Record<string, unknown> = {};
  if (options.powerPreference !== undefined) descriptor['powerPreference'] = options.powerPreference;
  if (options.forceFallbackAdapter !== undefined) {
    descriptor['forceFallbackAdapter'] = options.forceFallbackAdapter;
  }

  try {
    const adapter = await provider.requestAdapter(descriptor);
    if (adapter == null) {
      log.warn(
        'WebGPU reported no adapter. This normally means the GPU is blocklisted, the page is not ' +
          'cross-origin isolated where required, or the driver refused a device.',
      );
      return null;
    }
    if (options.requireHardware === true && !hasFeature(adapter.features, 'timestamp-query')) {
      // A cheap heuristic for "software adapter": the fallback adapter is the only
      // one that does not expose timestamp queries on any current implementation.
      log.debug('the adapter does not expose timestamp queries; it may be a software fallback');
    }
    return adapter;
  } catch (error) {
    log.warn('requestAdapter() threw', error);
    return null;
  }
}

/**
 * Requests a device from an adapter, dropping unsupported requirements.
 *
 * Filtering order:
 *  1. every `requiredFeatures` entry the adapter does not have is dropped;
 *  2. every `requiredLimits` value is clamped to the adapter's own limit;
 *  3. if the filtered request still fails, an empty descriptor is retried so the
 *     renderer starts in a degraded but working state.
 *
 * @param adapter Adapter to request from.
 * @param options Requested features, limits and label.
 * @returns The acquisition result, including what was dropped or clamped.
 */
export async function requestDeviceSafe(
  adapter: GPUAdapterLike,
  options: WebGPUDeviceRequestOptions = {},
): Promise<WebGPUDeviceAcquireResult> {
  const requestedFeatures = options.requiredFeatures ?? [];
  const droppedFeatures: string[] = [];
  const grantedFeatures: string[] = [];

  for (const feature of requestedFeatures) {
    if (hasFeature(adapter.features, feature)) grantedFeatures.push(feature);
    else droppedFeatures.push(feature);
  }

  if (droppedFeatures.length > 0) {
    log.warn(
      `requestDeviceSafe: this adapter does not support ${droppedFeatures.join(', ')}. ` +
        'The device is created without them; the corresponding rendering paths are disabled.',
    );
  }

  const clampedLimits: Record<string, number> = {};
  const requestedLimits: Record<string, number> = {};
  const limits = options.requiredLimits ?? {};
  for (const name of Object.keys(limits)) {
    const wanted = limits[name];
    const available = adapter.limits[name];
    if (typeof available !== 'number' || !Number.isFinite(available)) {
      log.debug(`requestDeviceSafe: dropping unknown limit '${name}'`);
      continue;
    }
    const resolved = Math.max(1, Math.min(Math.floor(wanted), Math.floor(available)));
    requestedLimits[name] = resolved;
    if (resolved !== Math.floor(wanted)) clampedLimits[name] = resolved;
  }

  if (Object.keys(clampedLimits).length > 0) {
    log.debug('requestDeviceSafe: limits clamped to the adapter maximum', clampedLimits);
  }

  const buildDescriptor = (): Record<string, unknown> => {
    const descriptor: Record<string, unknown> = {};
    if (options.label !== undefined) descriptor['label'] = options.label;
    if (grantedFeatures.length > 0) descriptor['requiredFeatures'] = grantedFeatures;
    if (Object.keys(requestedLimits).length > 0) descriptor['requiredLimits'] = requestedLimits;
    return descriptor;
  };

  try {
    const device = await adapter.requestDevice(buildDescriptor());
    return {
      device,
      features: grantedFeatures,
      droppedFeatures,
      clampedLimits,
      degraded: droppedFeatures.length > 0 || Object.keys(clampedLimits).length > 0,
      error: null,
    };
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    log.warn(
      `requestDeviceSafe: the filtered device request failed (${message}). Retrying with an empty ` +
        'descriptor so the renderer can start in a degraded state.',
    );
  }

  try {
    const device = await adapter.requestDevice({});
    return {
      device,
      features: [],
      droppedFeatures: requestedFeatures.slice(),
      clampedLimits,
      degraded: true,
      error: null,
    };
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    log.error('requestDeviceSafe: even an empty device descriptor was rejected', error);
    return {
      device: null,
      features: [],
      droppedFeatures: requestedFeatures.slice(),
      clampedLimits,
      degraded: true,
      error: message,
    };
  }
}

/**
 * Convenience wrapper: request an adapter and a device in one call.
 *
 * @param adapterOptions Adapter acquisition options.
 * @param deviceOptions Device request options.
 * @param provider GPU entry point; defaults to `navigator.gpu`.
 * @returns The result plus the adapter, or a failure record.
 */
export async function acquireDevice(
  adapterOptions: WebGPUAdapterOptions = {},
  deviceOptions: WebGPUDeviceRequestOptions = {},
  provider: GPUProviderLike | null = getGPUProvider(),
): Promise<{ adapter: GPUAdapterLike | null; result: WebGPUDeviceAcquireResult }> {
  const adapter = await requestAdapterSafe(adapterOptions, provider);
  if (adapter === null) {
    return {
      adapter: null,
      result: {
        device: null,
        features: [],
        droppedFeatures: deviceOptions.requiredFeatures?.slice() ?? [],
        clampedLimits: {},
        degraded: false,
        error: 'no WebGPU adapter is available in this runtime',
      },
    };
  }
  return { adapter, result: await requestDeviceSafe(adapter, deviceOptions) };
}

/**
 * Builds a capability report for an adapter.
 *
 * @param adapter Adapter to read, or `null`.
 * @param overrides Optional limit overrides.
 */
export function getCapabilities(
  adapter: GPUAdapterLike | null = null,
  overrides: Readonly<Record<string, number>> = {},
): WebGPUCapabilities {
  return new WebGPUCapabilities(adapter, overrides);
}
