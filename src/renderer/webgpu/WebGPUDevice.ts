/**
 * WebGPU device wrapper.
 *
 * Owns the `GPUDevice`, its queue, the staging-buffer pool, the deferred-destroy
 * queue and the `device.lost` plumbing.
 *
 * ## Staging buffers (zero copy where it counts)
 *
 * `queue.writeBuffer` copies through the driver's own staging, which is convenient
 * but allocates per call. For large or frequently rewritten data the cheaper route is
 * `createBuffer({ mappedAtCreation: true })`: the buffer is created already mapped, so
 * the caller writes straight into the driver's memory and unmaps once, with no
 * intermediate CPU copy. {@link WebGPUDevice.createStagingBuffer} returns such a
 * buffer together with a typed view onto its mapped range.
 *
 * ## Deferred destruction
 *
 * A buffer or texture that is destroyed while a submitted command buffer still
 * references it is a use-after-free from the driver's point of view: WebGPU allows it
 * (the object stays alive until the work completes) but the resource is gone for any
 * later frame. {@link DeferredDestroyQueue} holds destruction until the submissions
 * that were in flight when `destroy` was requested have completed, which keeps the
 * lifetime unambiguous.
 *
 * ## Device loss
 *
 * `device.lost` is a promise that resolves once, when the device is gone. It is wired
 * to {@link WebGPUDevice.onLost} so the renderer can take the same path it takes for a
 * lost WebGL context: stop submitting work, mark resources stale, and report.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import { createId } from '../../utils/Id';
import {
  GPUBufferUsageFlags,
  GPUMapMode,
  type GPUCommandBufferLike,
  type GPUDeviceLike,
  type GPUDeviceLostInfoLike,
  type GPUFeatureSetLike,
  type GPUBufferLike,
} from './WebGPUUtils';

/** Logger for device diagnostics. */
const log = createLogger('renderer:webgpu:device');

/* -------------------------------------------------------------------------- */
/* Deferred destruction                                                       */
/* -------------------------------------------------------------------------- */

/** Anything the deferred queue can release. */
export interface Destroyable {
  destroy(): void;
}

/** A handle the queue can wait on before destroying anything. */
export type SubmissionToken = Promise<unknown>;

/**
 * Holds `destroy()` calls until the submissions in flight complete.
 *
 * ```ts
 * const queue = new DeferredDestroyQueue();
 * const token = queue.beginSubmission(queue.submit(commandBuffers));  // wait on this
 * queue.destroy(texture);        // destroyed once `token` settles
 * ```
 *
 * Waiting on the promise returned by `onSubmittedWorkDone` rather than a timer keeps
 * the guarantee exact: nothing is released while the GPU can still read it.
 */
export class DeferredDestroyQueue {
  /** Objects waiting for the current submission window to close. */
  private pending: Destroyable[] = [];

  /** Promise for the submissions currently in flight, or `null`. */
  private inFlight: SubmissionToken | null = null;

  /** Number of objects destroyed so far. */
  private destroyedCount: number = 0;

  /** `true` once {@link DeferredDestroyQueue.dispose} has run. */
  private disposed: boolean = false;

  /** Number of objects currently waiting. */
  public get size(): number {
    return this.pending.length;
  }

  /** Number of objects actually destroyed. */
  public get destroyed(): number {
    return this.destroyedCount;
  }

  /** `true` while a submission window is open. */
  public get isWaiting(): boolean {
    return this.inFlight !== null;
  }

  /**
   * Registers the promise that guards the current window.
   *
   * @param token Promise that settles once the submissions have completed.
   */
  public beginSubmission(token: SubmissionToken): SubmissionToken {
    this.inFlight = token;
    void token.then(
      () => {
        if (this.inFlight === token) this.inFlight = null;
        this.flush();
      },
      () => {
        if (this.inFlight === token) this.inFlight = null;
        this.flush();
      },
    );
    return token;
  }

  /**
   * Queues an object for destruction.
   *
   * @param target Object to destroy.
   */
  public destroy(target: Destroyable): void {
    if (this.disposed) {
      target.destroy();
      return;
    }
    this.pending.push(target);
    if (this.inFlight === null) this.flush();
  }

  /** Destroys everything queued, when no submission is in flight. */
  public flush(): void {
    if (this.inFlight !== null || this.pending.length === 0) return;
    const pending = this.pending;
    this.pending = [];
    for (const target of pending) {
      try {
        target.destroy();
        this.destroyedCount++;
      } catch (error) {
        log.debug('a deferred destroy threw', error);
      }
    }
  }

  /**
   * Destroys everything immediately, ignoring in-flight submissions.
   *
   * Used by `dispose()`, where the device is going away regardless.
   */
  public dispose(): void {
    this.disposed = true;
    this.inFlight = null;
    this.flush();
  }
}

/* -------------------------------------------------------------------------- */
/* Device options and reports                                                 */
/* -------------------------------------------------------------------------- */

/** Options accepted by {@link WebGPUDevice}. */
export interface WebGPUDeviceOptions {
  /** Human-readable label used in diagnostics. */
  label?: string;
  /** Default size of the staging-buffer pool, in bytes. */
  stagingSize?: number;
}

/** A staging buffer plus the view onto its mapped range. */
export interface StagingBuffer {
  /** The GPU buffer, created `mappedAtCreation`. */
  readonly buffer: GPUBufferLike;
  /** View over the buffer's entire mapped range. */
  readonly view: Uint8Array;
  /** Size in bytes. */
  readonly size: number;
  /**
   * Unmaps the buffer, making it readable by the GPU.
   *
   * Must be called exactly once before the buffer is used in a submission.
   */
  unmap(): void;
}

/* -------------------------------------------------------------------------- */
/* WebGPUDevice                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A live WebGPU device.
 *
 * ```ts
 * const device = new WebGPUDevice(gpuDevice, { label: 'main' });
 * device.onLost((info) => console.warn(info.message));
 * const { buffer, view, unmap } = device.createStagingBuffer(65536);
 * view.set(data);
 * unmap();
 * device.queue.writeBuffer(target, 0, buffer, 0, data.byteLength);
 * ```
 */
export class WebGPUDevice {
  /** Stable identifier used in diagnostics and cache keys. */
  public readonly id: string;

  /** The underlying device. */
  public readonly device: GPUDeviceLike;

  /** The device's queue. */
  public readonly queue: GPUDeviceLike['queue'];

  /** Label used in diagnostics. */
  public readonly label: string;

  /** Number of staging buffers created through {@link WebGPUDevice.createStagingBuffer}. */
  private stagingCount: number = 0;

  /** Number of command buffers submitted. */
  private submissionCount: number = 0;

  /** Number of times the device was reported lost. */
  private lossCount: number = 0;

  /** `true` once the device is lost or destroyed. */
  private lost: boolean = false;

  /** `true` once {@link WebGPUDevice.destroy} has run. */
  private disposed: boolean = false;

  /** Reason the device was lost, when known. */
  private lostInfo: GPUDeviceLostInfoLike | null = null;

  /** Destruction queue shared by every resource the renderer creates. */
  public readonly deferredDestroy: DeferredDestroyQueue = new DeferredDestroyQueue();

  /** Listeners notified when the device is lost. */
  private readonly lostListeners: Set<(info: GPUDeviceLostInfoLike) => void> = new Set();

  /** Listeners notified when the device is restored (a new device was swapped in). */
  private readonly restoredListeners: Set<() => void> = new Set();

  /**
   * Wraps a device and starts watching `device.lost`.
   *
   * @param device Device to wrap.
   * @param options Label and staging defaults.
   */
  constructor(device: GPUDeviceLike, options: WebGPUDeviceOptions = {}) {
    this.device = device;
    this.queue = device.queue;
    this.label = options.label ?? 'webgpu-device';
    this.id = `webgpu-device-${createId()}`;

    // `device.lost` never rejects; it resolves once, either on an unexpected loss or
    // on an explicit `destroy()`.
    try {
      void device.lost.then(
        (info) => {
          if (this.disposed) return;
          this.lossCount++;
          this.lost = true;
          this.lostInfo = info;
          log.warn(
            `the WebGPU device was lost (reason=${info?.reason ?? 'unknown'})` +
              `${info?.message !== undefined ? `: ${info.message}` : ''}. GPU resources must be ` +
              're-created; the renderer stops submitting work until a new device is installed.',
          );
          for (const listener of this.lostListeners) {
            try {
              listener(info);
            } catch (error) {
              log.error('a device-loss listener threw', error);
            }
          }
        },
        (error: unknown) => {
          log.debug('device.lost rejected', error);
        },
      );
    } catch (error) {
      log.debug('this device does not expose a `lost` promise', error);
    }
  }

  /* ------------------------------------------------------------------ queries */

  /** `true` when the device can accept new commands. */
  public get isUsable(): boolean {
    return !this.lost && !this.disposed;
  }

  /** `true` when the device has been reported lost. */
  public get isLost(): boolean {
    return this.lost;
  }

  /** `true` once {@link WebGPUDevice.destroy} has run. */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /** Information about the loss, when known. */
  public get lostReason(): GPUDeviceLostInfoLike | null {
    return this.lostInfo;
  }

  /** Number of command-buffer submissions made through this wrapper. */
  public get submissions(): number {
    return this.submissionCount;
  }

  /** Number of staging buffers created. */
  public get stagingBuffers(): number {
    return this.stagingCount;
  }

  /** Features reported by the device, as a set-like object. */
  public get features(): GPUFeatureSetLike | readonly string[] {
    return this.device.features;
  }

  /** Limits reported by the device. */
  public get limits(): Readonly<Record<string, number>> {
    return this.device.limits;
  }

  /* ---------------------------------------------------------------- listeners */

  /**
   * Registers a device-loss listener.
   *
   * @param listener Invoked with the loss information.
   * @returns A function removing the listener.
   */
  public onLost(listener: (info: GPUDeviceLostInfoLike) => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  /**
   * Registers a listener for "a new device replaced the lost one".
   *
   * @param listener Invoked once a replacement device is installed.
   * @returns A function removing the listener.
   */
  public onRestored(listener: () => void): () => void {
    this.restoredListeners.add(listener);
    return () => this.restoredListeners.delete(listener);
  }

  /**
   * Marks the device usable again after a replacement was installed.
   *
   * @param reason Human-readable note recorded at debug level.
   */
  public notifyRestored(reason: string = 'device replaced'): void {
    this.lost = false;
    this.lostInfo = null;
    log.debug(`the WebGPU device is usable again (${reason})`);
    for (const listener of this.restoredListeners) {
      try {
        listener();
      } catch (error) {
        log.error('a device-restore listener threw', error);
      }
    }
  }

  /* ------------------------------------------------------------------ helpers */

  /**
   * Creates a buffer that is mapped at creation, for zero-copy uploads.
   *
   * @param size Size in bytes.
   * @param options Usage bits and label.
   * @returns The buffer, a byte view onto its mapped range, and an `unmap` function.
   * @throws Error When the device is unusable or the buffer could not be mapped.
   */
  public createStagingBuffer(
    size: number,
    options: { usage?: number; label?: string } = {},
  ): StagingBuffer {
    if (!this.isUsable) {
      throw new Error(
        `WebGPUDevice(${this.label}): cannot create a staging buffer because the device is ` +
          `${this.disposed ? 'disposed' : 'lost'}. Wait for a replacement device before uploading.`,
      );
    }

    const bytes = Math.max(4, Math.ceil(size));
    const usage = options.usage ?? GPUBufferUsageFlags.COPY_SRC | GPUBufferUsageFlags.MAP_WRITE;
    const buffer = this.device.createBuffer({
      label: options.label ?? `${this.label}-staging`,
      size: bytes,
      usage,
      mappedAtCreation: true,
    });

    this.stagingCount++;
    const range = buffer.getMappedRange();
    const view = new Uint8Array(range);
    let unmapped = false;

    return {
      buffer,
      view,
      size: bytes,
      unmap: (): void => {
        if (unmapped) return;
        unmapped = true;
        buffer.unmap();
      },
    };
  }

  /**
   * Uploads data into a buffer through the queue.
   *
   * @param buffer Destination buffer.
   * @param data Source data.
   * @param offset Destination byte offset; must be a multiple of 4 for typed data.
   * @param dataOffset Element offset inside `data`.
   * @param size Bytes to write; defaults to the rest of `data`.
   */
  public writeBuffer(
    buffer: GPUBufferLike,
    data: ArrayBufferView | ArrayBuffer,
    offset: number = 0,
    dataOffset?: number,
    size?: number,
  ): void {
    if (!this.isUsable) {
      log.debug(`WebGPUDevice(${this.label}): dropping a write into a lost device`);
      return;
    }
    this.queue.writeBuffer(buffer, offset, data, dataOffset, size);
  }

  /**
   * Creates a mapped-readback buffer and fills it with the queue's contents.
   *
   * The returned promise resolves with the bytes once the copy completes.
   *
   * @param source Buffer to read.
   * @param size Bytes to read; defaults to the whole source buffer.
   * @param offset Source byte offset.
   * @returns The bytes, or `null` when the device is unusable.
   */
  public async readBuffer(source: GPUBufferLike, size?: number, offset: number = 0): Promise<Uint8Array | null> {
    if (!this.isUsable) return null;

    const bytes = alignReadbackSize(size ?? source.size);
    const readback = this.device.createBuffer({
      label: `${this.label}-readback`,
      size: bytes,
      usage: GPUBufferUsageFlags.COPY_DST | GPUBufferUsageFlags.MAP_READ,
    });

    const encoder = this.device.createCommandEncoder({ label: `${this.label}-readback` });
    encoder.copyBufferToBuffer(source, offset, readback, 0, bytes);
    this.submit([encoder.finish()]);

    try {
      await readback.mapAsync(GPUMapMode.READ);
      const copy = new Uint8Array(readback.getMappedRange().slice(0));
      readback.unmap();
      readback.destroy();
      return copy;
    } catch (error) {
      log.warn('buffer readback failed', error);
      readback.destroy();
      return null;
    }
  }

  /**
   * Submits command buffers and opens a deferred-destruction window.
   *
   * @param commandBuffers Buffers to submit.
   * @returns A promise that settles once the GPU completed the work.
   */
  public submit(commandBuffers: readonly GPUCommandBufferLike[]): Promise<unknown> {
    if (!this.isUsable) {
      log.debug(`WebGPUDevice(${this.label}): dropping a submission to a lost device`);
      return Promise.resolve();
    }
    if (commandBuffers.length === 0) return this.queue.onSubmittedWorkDone();

    this.queue.submit(commandBuffers);
    this.submissionCount++;
    return this.deferredDestroy.beginSubmission(this.queue.onSubmittedWorkDone());
  }

  /**
   * Runs a callback inside an error scope, surfacing the validation error it caught.
   *
   * @param filter Error scope filter (`'validation'`, `'out-of-memory'`, `'internal'`).
   * @param body Work to run.
   * @returns The error the scope captured, or `null`.
   */
  public async captureErrors(filter: 'validation' | 'out-of-memory' | 'internal', body: () => void): Promise<Error | null> {
    if (typeof this.device.pushErrorScope !== 'function' || typeof this.device.popErrorScope !== 'function') {
      try {
        body();
      } catch (error) {
        return error as Error;
      }
      return null;
    }

    this.device.pushErrorScope(filter);
    let thrown: Error | null = null;
    try {
      body();
    } catch (error) {
      thrown = error as Error;
    }
    const captured = await this.device.popErrorScope();
    if (thrown !== null) return thrown;
    if (captured != null) return new Error(captured.message ?? `WebGPU ${filter} error`);
    return null;
  }

  /** Waits until the GPU has completed every submitted command buffer. */
  public async onSubmittedWorkDone(): Promise<void> {
    try {
      await this.queue.onSubmittedWorkDone();
    } catch (error) {
      log.debug('onSubmittedWorkDone rejected', error);
    }
  }

  /**
   * Releases every deferred resource and the device itself.
   *
   * The `destroy()` call makes `device.lost` resolve, which would be reported as an
   * unexpected loss; {@link WebGPUDevice.disposed} is set first so the loss handler
   * stays quiet.
   */
  public destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deferredDestroy.dispose();
    this.lostListeners.clear();
    this.restoredListeners.clear();
    try {
      this.device.destroy();
    } catch (error) {
      log.debug('device.destroy() threw', error);
    }
  }

  /** @returns A human-readable description. */
  public toString(): string {
    return `WebGPUDevice(${this.label}, ${this.submissionCount} submissions, ${this.stagingCount} staging buffers)`;
  }
}

/** Rounds a readback size up to the 4-byte multiple `copyBufferToBuffer` requires. */
export function alignReadbackSize(size: number): number {
  const bytes = Math.max(4, Math.ceil(size));
  return Math.ceil(bytes / 4) * 4;
}
