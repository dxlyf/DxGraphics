/**
 * WebGPU buffer wrapper.
 *
 * Owns one `GPUBuffer` plus its size, usage and (optionally) a CPU mirror. The class
 * is the single place that knows about WebGPU's two awkward buffer rules:
 *
 * 1. `queue.writeBuffer` offsets must be a multiple of 4, and a uniform buffer's
 *    dynamic offset must be a multiple of `minUniformBufferOffsetAlignment` (256) — *    {@link alignUniformOffset} and {@link WebGPUBuffer.writeUniform} handle both;
 * 2. a mapped buffer cannot be used in a submission until it is unmapped, which is
 *    why {@link WebGPUBuffer.withMappedWrite} always unmaps in a `finally`.
 *
 * ## Deferred destruction
 *
 * {@link WebGPUBuffer.destroy} hands the buffer to the device's
 * {@link DeferredDestroyQueue} by default, so a buffer that is dropped between frames
 * is not released while a submitted command buffer still reads it.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import { createId } from '../../utils/Id';
import { BufferType, BufferUsage } from '../interfaces/IBuffer';
import type { DeferredDestroyQueue, WebGPUDevice } from './WebGPUDevice';
import {
  GPUBufferUsageFlags,
  alignTo,
  alignUniformOffset,
  toGPUBufferUsage,
  type GPUBufferLike,
  type GPUDeviceLike,
} from './WebGPUUtils';

/** Logger for buffer diagnostics. */
const log = createLogger('renderer:webgpu:buffer');

/** Options accepted by {@link WebGPUBuffer}. */
export interface WebGPUBufferOptions {
  /** Kind of buffer; defaults to `BufferType.Vertex`. */
  type?: BufferType;
  /** Update-frequency hint; recorded for diagnostics. */
  usage?: BufferUsage;
  /** Bytes per element, for element-count bookkeeping. */
  bytesPerElement?: number;
  /** Explicit size in bytes; overrides the initial data's size. */
  size?: number;
  /** Extra `GPUBufferUsage` bits, OR-ed with the derived ones. */
  extraUsage?: number;
  /** Human-readable label. */
  label?: string;
  /** `true` to keep a CPU mirror so `getData()` works. */
  keepMirror?: boolean;
}

/**
 * A single GPU buffer.
 *
 * ```ts
 * const buffer = new WebGPUBuffer(device, { type: BufferType.Vertex, size: 1024 });
 * buffer.write(positions);
 * pass.setVertexBuffer(0, buffer.handle);
 * ```
 */
export class WebGPUBuffer {
  /** Stable identifier. */
  public readonly id: string;

  /** Kind of buffer resource. */
  public readonly type: BufferType;

  /** Update-frequency hint the buffer was created with. */
  public readonly usage: BufferUsage;

  /** Bytes per element. */
  public readonly bytesPerElement: number;

  /** Device the buffer belongs to. */
  private readonly device: GPUDeviceLike;

  /** Deferred-destruction queue, when the wrapper was given one. */
  private readonly destroyQueue: DeferredDestroyQueue | null;

  /** Label used in diagnostics. */
  private readonly label: string;

  /** Native handle. */
  private nativeHandle: GPUBufferLike | null = null;

  /** Size in bytes. */
  private byteSize: number = 0;

  /** Combined usage bits. */
  private usageBits: number = 0;

  /** CPU mirror, when `keepMirror` was requested. */
  private mirror: Uint8Array | null = null;

  /** `true` once the buffer has been released. */
  private disposed: boolean = false;

  /**
   * Creates and allocates a buffer.
   *
   * @param device Device to create the buffer on.
   * @param options Type, size, usage bits and mirroring.
   * @param context Optional plumbing: the renderer's device wrapper, so destruction
   *   is deferred until in-flight submissions complete.
   */
  constructor(
    device: GPUDeviceLike,
    options: WebGPUBufferOptions = {},
    context: { wrapper?: WebGPUDevice | null; destroyQueue?: DeferredDestroyQueue | null } = {},
  ) {
    this.device = device;
    this.type = options.type ?? BufferType.Vertex;
    this.usage = options.usage ?? BufferUsage.Static;
    this.bytesPerElement = Math.max(1, Math.floor(options.bytesPerElement ?? 4));
    this.label = options.label ?? this.type;
    this.id = `webgpu-buffer-${createId()}`;
    this.destroyQueue = context.destroyQueue ?? context.wrapper?.deferredDestroy ?? null;

    const bytes = Math.max(4, Math.ceil(options.size ?? 4));
    this.usageBits = toGPUBufferUsage(this.type, this.usage) | (options.extraUsage ?? 0);
    this.create(bytes);

    if (options.keepMirror === true) this.mirror = new Uint8Array(this.byteSize);
  }

  /* ------------------------------------------------------------------ queries */

  /** Native handle, or `null` once released. */
  public get handle(): GPUBufferLike | null {
    return this.nativeHandle;
  }

  /** Size in bytes. */
  public get size(): number {
    return this.byteSize;
  }

  /** Element count, derived from {@link WebGPUBuffer.bytesPerElement}. */
  public get count(): number {
    return Math.floor(this.byteSize / this.bytesPerElement);
  }

  /** Bytes per element. */
  public get elementSize(): number {
    return this.bytesPerElement;
  }

  /** Combined `GPUBufferUsage` bits. */
  public get usageFlags(): number {
    return this.usageBits;
  }

  /** `true` once the native buffer exists. */
  public get isInitialised(): boolean {
    return this.nativeHandle !== null;
  }

  /** `true` once {@link WebGPUBuffer.destroy} has run. */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Returns the native handle, or throws when it has been released.
   *
   * @returns The handle.
   * @throws Error When the buffer was destroyed.
   */
  public getHandle(): GPUBufferLike {
    if (this.nativeHandle === null) {
      throw new Error(
        `WebGPUBuffer(${this.label}): the buffer has been destroyed. Create a new one, or call ` +
          '`grow()` before the frame that needs it.',
      );
    }
    return this.nativeHandle;
  }

  /* ------------------------------------------------------------------ writing */

  /**
   * Overwrites the whole buffer (or a byte range of it) from a queue write.
   *
   * `dataOffset` and `size` are byte offsets into `data`'s underlying buffer, not
   * element offsets: the source is viewed as bytes first, which removes the
   * element/byte confusion `queue.writeBuffer`'s own `dataOffset` invites.
   *
   * @param data Source data.
   * @param byteOffset Destination byte offset; rounded up to a multiple of 4.
   * @param dataOffset Byte offset inside `data`.
   * @param size Bytes to write; defaults to the remainder of `data`.
   * @returns `true` when the write was performed.
   */
  public write(
    data: ArrayBufferView | ArrayBuffer,
    byteOffset: number = 0,
    dataOffset: number = 0,
    size?: number,
  ): boolean {
    if (!this.isInitialised) return false;

    if (byteOffset % 4 !== 0) {
      const aligned = alignTo(byteOffset, 4);
      log.warn(
        `WebGPUBuffer(${this.label}): queue.writeBuffer requires a 4-byte-aligned offset; ` +
          `${byteOffset} was rounded up to ${aligned}.`,
      );
      byteOffset = aligned;
    }

    const source = toUint8View(data);
    const start = Math.max(0, Math.floor(dataOffset));
    const bytes = size ?? source.byteLength - start;
    if (bytes <= 0) return false;

    const slice = source.subarray(start, start + bytes);
    if (byteOffset + slice.byteLength > this.byteSize) {
      log.debug(
        `WebGPUBuffer(${this.label}): growing from ${this.byteSize} to ` +
          `${byteOffset + slice.byteLength} bytes to fit the write`,
      );
      this.grow(byteOffset + slice.byteLength);
    }

    try {
      this.device.queue.writeBuffer(this.getHandle(), byteOffset, slice);
    } catch (error) {
      log.error(`WebGPUBuffer(${this.label}): writeBuffer failed`, error);
      return false;
    }

    if (this.mirror !== null) this.mirror.set(slice, byteOffset);
    return true;
  }

  /**
   * Writes a uniform block at a 256-byte-aligned offset.
   *
   * @param data Uniform data.
   * @param dynamicOffset Uniform slot index (multiplied by the alignment).
   * @returns `true` when the write was performed.
   */
  public writeUniform(data: ArrayBufferView | ArrayBuffer, dynamicOffset: number = 0): boolean {
    const offset = alignUniformOffset(dynamicOffset);
    return this.write(data, offset);
  }

  /**
   * Writes through a temporary mapping and copies the result into this buffer.
   *
   * `queue.writeBuffer` cannot express every layout (it has no offset for the
   * source's element type beyond the array's own), so for those cases the data is
   * written into a `mappedAtCreation` staging buffer and copied across with a
   * command encoder. The staging buffer is destroyed immediately afterwards, which
   * WebGPU permits: a submitted command keeps its own reference alive until the work
   * completes.
   *
   * @param size Bytes to write.
   * @param body Callback receiving the mapped view; it must fill `size` bytes.
   * @returns `true` when the mapping and copy succeeded.
   */
  public withMappedWrite(size: number, body: (view: Uint8Array) => void): boolean {
    if (!this.isInitialised) return false;

    const bytes = Math.max(4, alignTo(size, 4));
    let staging: GPUBufferLike | null = null;
    let captured: Uint8Array | null = null;

    try {
      staging = this.device.createBuffer({
        label: `${this.label}-staging`,
        size: bytes,
        usage: GPUBufferUsageFlags.MAP_WRITE | GPUBufferUsageFlags.COPY_SRC,
        mappedAtCreation: true,
      });
      const view = new Uint8Array(staging.getMappedRange());
      body(view);
      // The mapped range is detached by `unmap()`, so the mirror has to be filled
      // while the buffer is still mapped.
      if (this.mirror !== null) captured = view.slice(0, bytes);
    } catch (error) {
      log.error(`WebGPUBuffer(${this.label}): mapped write failed`, error);
      if (staging !== null) {
        try {
          staging.unmap();
        } catch {
          /* already unmapped */
        }
        staging.destroy();
      }
      return false;
    }

    // Unmapping has to happen before the buffer can be used in a submission.
    staging.unmap();
    if (this.mirror !== null && captured !== null) this.mirror.set(captured, 0);

    try {
      const encoder = this.device.createCommandEncoder({ label: `${this.label}-mapped-copy` });
      encoder.copyBufferToBuffer(staging, 0, this.getHandle(), 0, bytes);
      this.device.queue.submit([encoder.finish()]);
    } catch (error) {
      log.error(`WebGPUBuffer(${this.label}): copying the mapped staging buffer failed`, error);
      staging.destroy();
      return false;
    }

    staging.destroy();
    return true;
  }

  /* ------------------------------------------------------------------ resizing */

  /**
   * Reallocates the buffer to hold at least `byteLength` bytes.
   *
   * The reallocation is rounded up to the next power of two so a steadily growing
   * buffer does not reallocate on every write.
   *
   * @param byteLength Required capacity.
   * @returns `true` when a reallocation happened.
   */
  public grow(byteLength: number): boolean {
    const required = Math.max(4, Math.ceil(byteLength));
    if (this.nativeHandle !== null && required <= this.byteSize) return false;

    const next = nextPowerOfTwoAtLeast(required);
    this.releaseHandle();
    this.create(next);
    if (this.mirror !== null) {
      const grown = new Uint8Array(next);
      grown.set(this.mirror);
      this.mirror = grown;
    }
    return true;
  }

  /**
   * Replaces the buffer contents from a mapping, growing first when needed.
   *
   * @param data Source bytes.
   * @param byteOffset Destination byte offset.
   * @returns `true` when the write was performed.
   */
  public setData(data: ArrayBufferView | ArrayBuffer, byteOffset: number = 0): boolean {
    const bytes = viewByteLength(data);
    if (byteOffset + bytes > this.byteSize) this.grow(byteOffset + bytes);
    return this.write(data, byteOffset);
  }

  /** @returns The CPU mirror, or `null` when none is kept. */
  public getData(): Uint8Array | null {
    return this.mirror;
  }

  /* ------------------------------------------------------------------ releasing */

  /**
   * Releases the native buffer.
   *
   * @param immediate `true` to release now instead of waiting for in-flight
   *   submissions to complete.
   */
  public destroy(immediate: boolean = false): void {
    if (this.disposed) return;
    this.disposed = true;
    const handle = this.nativeHandle;
    this.nativeHandle = null;
    if (handle === null) return;

    if (!immediate && this.destroyQueue !== null) this.destroyQueue.destroy(handle);
    else handle.destroy();
  }

  /** Alias of {@link WebGPUBuffer.destroy}, for `Disposable`-style use. */
  public dispose(): void {
    this.destroy(false);
  }

  /** @returns A human-readable description. */
  public toString(): string {
    return `WebGPUBuffer(${this.label}, ${this.type}/${this.usage}, ${this.byteSize} bytes)`;
  }

  /* ---------------------------------------------------------------- internals */

  /** Allocates the native buffer. */
  private create(bytes: number): void {
    const size = Math.max(4, alignTo(bytes, 4));
    this.nativeHandle = this.device.createBuffer({
      label: this.label,
      size,
      usage: this.usageBits,
    });
    this.byteSize = size;
  }

  /** Releases the handle through the queue, if there is one. */
  private releaseHandle(): void {
    const handle = this.nativeHandle;
    if (handle === null) return;
    this.nativeHandle = null;
    if (this.destroyQueue !== null) this.destroyQueue.destroy(handle);
    else handle.destroy();
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Byte length of a buffer source. */
export function viewByteLength(data: ArrayBufferView | ArrayBuffer): number {
  if (data instanceof ArrayBuffer) return data.byteLength;
  const view = data as ArrayBufferView;
  return typeof view.byteLength === 'number' ? view.byteLength : 0;
}

/** Views a buffer source as bytes, for the CPU mirror. */
export function toUint8View(
  data: ArrayBufferView | ArrayBuffer,
  dataOffset?: number,
  size?: number,
): Uint8Array {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, viewByteLength(data));
  const start = dataOffset ?? 0;
  return size === undefined ? bytes.subarray(start) : bytes.subarray(start, start + size);
}

/** Smallest power of two greater than or equal to `value`. */
export function nextPowerOfTwoAtLeast(value: number): number {
  const target = Math.max(1, Math.ceil(value));
  let result = 1;
  while (result < target) result <<= 1;
  return result;
}

/**
 * Creates a uniform buffer sized for `count` slots of `slotSize` bytes.
 *
 * WebGPU requires each dynamically-offset uniform slot to start on a 256-byte
 * boundary, so the slot stride is rounded up.
 *
 * @param device Device to create the buffer on.
 * @param count Number of slots.
 * @param slotSize Size of one slot's data in bytes.
 * @param label Optional label.
 * @returns The buffer and the stride between slots.
 */
export function createUniformBufferPool(
  device: GPUDeviceLike,
  count: number,
  slotSize: number,
  label: string = 'uniforms',
): { buffer: WebGPUBuffer; stride: number; capacity: number } {
  const slots = Math.max(1, Math.floor(count));
  const stride = alignUniformOffset(Math.max(1, Math.ceil(slotSize)));
  return {
    buffer: new WebGPUBuffer(
      device,
      { type: BufferType.Uniform, size: stride * slots, label, keepMirror: false },
      {},
    ),
    stride,
    capacity: slots,
  };
}

/** Bit mask for a buffer that is only ever written from the CPU. */
export const COPY_DST_USAGE = GPUBufferUsageFlags.COPY_DST;

/** Bit mask for a readback buffer. */
export const READBACK_USAGE = GPUBufferUsageFlags.MAP_READ | GPUBufferUsageFlags.COPY_DST;
