/**
 * Vertex, index and uniform buffer wrapper.
 *
 * The class owns one `WebGLBuffer` handle plus the byte capacity it was allocated
 * with. Capacity is tracked separately from the element count because growable
 * attributes reallocate in powers of two: an attribute that grows from 100 to 101
 * elements must not force a reallocation on every frame.
 *
 * `bufferSubData` writes are clamped to the allocated capacity and reported at
 * debug level rather than throwing, because a partially uploaded attribute still
 * renders (with stale tail data) which is far easier to diagnose than a frame that
 * aborts mid-draw.
 *
 * @packageDocumentation
 */

import { nextPowerOfTwo } from '../../utils/MathUtils';
import { createId } from '../../utils/Id';
import { createLogger } from '../../utils/Logger';
import { BufferType, BufferUsage } from '../interfaces/IBuffer';
import {
  glConst,
  toGLBufferTarget,
  toGLBufferUsage,
  type GL,
  type GLBufferObject,
} from './WebGLUtils';

/** Logger for buffer diagnostics. */
const log = createLogger('renderer:webgl:buffer');

/** Options accepted by {@link WebGLBuffer}. */
export interface WebGLBufferOptions {
  /** Kind of buffer; defaults to {@link BufferType.Vertex}. */
  type?: BufferType;
  /** Update-frequency hint; defaults to {@link BufferUsage.Static}. */
  usage?: BufferUsage;
  /** Bytes per element; defaults to `4` (`Float32Array`). */
  bytesPerElement?: number;
  /** Human-readable label used in diagnostics. */
  label?: string;
}

/**
 * A single GL buffer object.
 *
 * ```ts
 * const buffer = new WebGLBuffer(gl, { type: BufferType.Vertex });
 * buffer.setData(new Float32Array(positions));   // allocates and uploads
 * buffer.setData(morePositions, { dstOffset: 12 }); // partial write
 * ```
 */
export class WebGLBuffer {
  /** Stable identifier. */
  public readonly id: string;

  /** Kind of buffer resource. */
  public readonly type: BufferType;

  /** Update-frequency hint. */
  public readonly usage: BufferUsage;

  /** Context the buffer belongs to. */
  private readonly gl: GL;

  /** Label used in diagnostics. */
  private readonly label: string;

  /** Native handle, or `null` before the first upload. */
  private handle: GLBufferObject | null = null;

  /** Bytes currently allocated on the GPU. */
  private capacity: number = 0;

  /** Number of elements the buffer holds. */
  private elements: number = 0;

  /** Bytes per element. */
  private readonly elementSize: number;

  /** `true` once the buffer has been released. */
  private disposed: boolean = false;

  /**
   * Creates an unallocated buffer.
   *
   * @param gl Context to create the buffer on.
   * @param options Type, usage and element size.
   */
  constructor(gl: GL, options: WebGLBufferOptions = {}) {
    this.gl = gl;
    this.type = options.type ?? BufferType.Vertex;
    this.usage = options.usage ?? BufferUsage.Static;
    this.elementSize = Math.max(1, Math.floor(options.bytesPerElement ?? 4));
    this.label = options.label ?? this.type;
    this.id = `webgl-buffer-${createId()}`;

    if (toGLBufferTarget(gl, this.type) === null) {
      throw new Error(
        `WebGLBuffer: buffer type '${this.type}' has no WebGL bind target. ` +
          'Indirect draw buffers are not part of WebGL; use the WebGPU backend for them.',
      );
    }
  }

  /** Native handle, or `null`. */
  public get handleOrNull(): GLBufferObject | null {
    return this.handle;
  }

  /** `true` once a handle exists. */
  public get isInitialised(): boolean {
    return this.handle !== null;
  }

  /** `true` once {@link WebGLBuffer.dispose} has run. */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /** Number of elements currently stored. */
  public get count(): number {
    return this.elements;
  }

  /** Bytes per element. */
  public get bytesPerElement(): number {
    return this.elementSize;
  }

  /** Bytes currently allocated on the GPU. */
  public get capacityBytes(): number {
    return this.capacity;
  }

  /** Bytes actually holding data (`elements * bytesPerElement`). */
  public get usedBytes(): number {
    return this.elements * this.elementSize;
  }

  /**
   * Returns the native handle, creating the buffer lazily.
   *
   * @returns The handle.
   * @throws Error When the context refuses to create the buffer (lost context).
   */
  public getHandle(): GLBufferObject {
    if (this.disposed) {
      throw new Error(`WebGLBuffer(${this.label}): the buffer has been disposed.`);
    }
    if (this.handle === null) {
      const handle = this.gl.createBuffer();
      if (handle === null) {
        throw new Error(
          `WebGLBuffer(${this.label}): gl.createBuffer returned null. The context is most ` +
            'likely lost; the renderer will rebuild the buffer after a restore.',
        );
      }
      this.handle = handle;
    }
    return this.handle;
  }

  /**
   * Returns the GL bind target, or throws when the type has none.
   *
   * @returns The `gl.*` target enumeration.
   */
  public getTarget(): number {
    const target = toGLBufferTarget(this.gl, this.type);
    if (target === null) {
      throw new Error(`WebGLBuffer(${this.label}): buffer type '${this.type}' has no bind target.`);
    }
    return target;
  }

  /**
   * Allocates (or reallocates) the buffer and uploads data.
   *
   * @param data Source data; omit to allocate without uploading.
   * @param byteLength Byte length to allocate; defaults to the data's own length.
   * @returns This buffer, for chaining.
   */
  public setData(data?: ArrayBufferView | ArrayBuffer | null, byteLength?: number): this {
    const handle = this.getHandle();
    const target = this.getTarget();
    const bytes = Math.max(0, Math.floor(byteLength ?? byteLengthOf(data)));

    this.gl.bindBuffer(target, handle);
    this.gl.bufferData(target, bytes, toGLBufferUsage(this.gl, this.usage));

    if (data != null && bytes > 0) this.gl.bufferSubData(target, 0, data as ArrayBufferView);

    this.capacity = bytes;
    this.elements = Math.floor(bytes / this.elementSize);
    return this;
  }

  /**
   * Writes into the middle of an allocated buffer.
   *
   * @param data Source data.
   * @param byteOffset Destination byte offset.
   * @returns `true` when the whole write fit inside the allocation.
   */
  public setSubData(data: ArrayBufferView | ArrayBuffer, byteOffset: number): boolean {
    const length = byteLengthOf(data);
    if (byteOffset < 0 || byteOffset + length > this.capacity) {
      log.debug(
        `WebGLBuffer(${this.label}): refusing to write ${length} bytes at offset ${byteOffset} ` +
          `into a ${this.capacity}-byte allocation; call grow() first`,
      );
      return false;
    }

    this.gl.bindBuffer(this.getTarget(), this.getHandle());
    this.gl.bufferSubData(this.getTarget(), byteOffset, data as ArrayBufferView);
    this.elements = Math.max(this.elements, Math.floor((byteOffset + length) / this.elementSize));
    return true;
  }

  /**
   * Grows the allocation to hold at least `byteLength`, when it does not already.
   *
   * The new capacity is the next power of two at or above the request, so a slowly
   * growing attribute reallocates `O(log n)` times instead of once per write.
   *
   * @param byteLength Required capacity in bytes.
   * @param data Optional data uploaded into the new allocation.
   * @returns `true` when a reallocation happened.
   */
  public grow(byteLength: number, data?: ArrayBufferView | ArrayBuffer | null): boolean {
    const required = Math.max(1, Math.ceil(byteLength));
    if (this.handle !== null && required <= this.capacity && data == null) return false;

    const target = required > this.capacity ? nextPowerOfTwo(required) : Math.max(1, this.capacity);
    this.setData(data ?? null, target);
    return true;
  }

  /**
   * Reallocates to hold exactly `count` elements, discarding the contents.
   *
   * @param count Element count.
   * @returns This buffer, for chaining.
   */
  public setElementCount(count: number): this {
    const elements = Math.max(0, Math.floor(count));
    this.setData(null, elements * this.elementSize);
    this.elements = elements;
    return this;
  }

  /** Releases the native handle. */
  public dispose(): void {
    if (this.disposed) return;
    if (this.handle !== null) {
      this.gl.deleteBuffer(this.handle);
      this.handle = null;
    }
    this.capacity = 0;
    this.elements = 0;
    this.disposed = true;
  }

  /** @returns A human-readable description. */
  public toString(): string {
    return (
      `WebGLBuffer(${this.label}, ${this.type}/${this.usage}, ` +
      `${this.elements} elements, ${this.capacity} bytes)`
    );
  }
}

/**
 * Byte length of any buffer source.
 *
 * @param data Typed array, `DataView`, `ArrayBuffer` or `null`.
 * @returns The byte length, or `0`.
 */
export function byteLengthOf(data: ArrayBufferView | ArrayBuffer | null | undefined): number {
  if (data == null) return 0;
  if (data instanceof ArrayBuffer) return data.byteLength;
  // A shared-memory backing store is not an `ArrayBuffer`, so the byte length is read
  // off the view instead of narrowing the type.
  const view = data as ArrayBufferView;
  return typeof view.byteLength === 'number' ? view.byteLength : 0;
}

/** Size in bytes of one element of a typed array. */
export function bytesPerElementOf(array: ArrayLike<number>): number {
  const name = (array as { constructor?: { BYTES_PER_ELEMENT?: number; name?: string } }).constructor;
  if (typeof name?.BYTES_PER_ELEMENT === 'number') return name.BYTES_PER_ELEMENT;
  switch (name?.name) {
    case 'Float64Array':
      return 8;
    case 'Int32Array':
    case 'Uint32Array':
    case 'Float32Array':
      return 4;
    case 'Int16Array':
    case 'Uint16Array':
      return 2;
    default:
      return 1;
  }
}

/** `true` when a typed array holds integer components. */
export function isIntegerArray(array: ArrayLike<number>): boolean {
  const name = (array as { constructor?: { name?: string } }).constructor?.name ?? '';
  return (
    name === 'Int8Array' ||
    name === 'Uint8Array' ||
    name === 'Int16Array' ||
    name === 'Uint16Array' ||
    name === 'Int32Array' ||
    name === 'Uint32Array'
  );
}

/** Number of components a GL vertex type has, for `vertexAttribPointer`. */
export function componentCountForType(gl: GL, type: number): number {
  const float = glConst(gl, 'FLOAT', 0x1406);
  const vec2 = glConst(gl, 'FLOAT_VEC2', 0x8b50);
  const vec3 = glConst(gl, 'FLOAT_VEC3', 0x8b51);
  const vec4 = glConst(gl, 'FLOAT_VEC4', 0x8b52);
  if (type === float) return 1;
  if (type === vec2) return 2;
  if (type === vec3) return 3;
  if (type === vec4) return 4;
  return 4;
}
