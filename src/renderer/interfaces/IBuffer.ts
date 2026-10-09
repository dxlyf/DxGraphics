/**
 * Graphics-buffer contract.
 *
 * One interface covers vertex, index and uniform buffers: the `type` discriminator
 * selects which of the optional members are meaningful, and the `usage` field
 * describes the intended update frequency. Backends are expected to throw a
 * descriptive error when `setData` is called on a uniform buffer.
 *
 * @packageDocumentation
 */

/** Kind of buffer resource. */
export enum BufferType {
  Vertex = 'vertex',
  Index = 'index',
  Uniform = 'uniform',
  Storage = 'storage',
  Indirect = 'indirect',
}

/** Update-frequency hint, named after the WebGL `usage` constants. */
export enum BufferUsage {
  Static = 'static',
  Dynamic = 'dynamic',
  Stream = 'stream',
}

/** Options accepted by {@link IBuffer.setData}. */
export interface BufferDataOptions {
  /** Element count to write; defaults to the whole source array. */
  count?: number;
  /** Element offset inside the source array. */
  srcOffset?: number;
  /** Element offset inside the destination buffer. */
  dstOffset?: number;
}

/** Options accepted when creating a buffer. */
export interface BufferOptions {
  /** Kind of buffer; defaults to {@link BufferType.Vertex}. */
  type?: BufferType;
  /** Update-frequency hint; defaults to {@link BufferUsage.Static}. */
  usage?: BufferUsage;
  /** Initial element count. */
  count?: number;
  /**
   * Attribute locations for vertex buffers, keyed by semantic name.
   *
   * One slot per attribute, in declaration order (`{ position: 0, uv: 1 }`).
   * Supplying this makes the buffer a vertex buffer; passing it for a uniform
   * buffer is a type error, which is the intended guard.
   */
  attributes?: Record<string, number>;
}

/** Common contract implemented by every buffer backend. */
export interface IBuffer {
  /** Stable identifier used in cache keys and diagnostics. */
  readonly id: string;

  /** Kind of buffer resource. */
  readonly type: BufferType;

  /** Update-frequency hint the backend was created with. */
  readonly usage: BufferUsage;

  /** Number of elements the buffer can currently hold. */
  readonly count: number;

  /** Bytes per element of the underlying typed array. */
  readonly bytesPerElement: number;

  /** Attribute locations, for vertex buffers. Empty otherwise. */
  readonly attributes: Readonly<Record<string, number>>;

  /** `true` once backend resources exist. */
  readonly isInitialised: boolean;

  /** `true` when the buffer has been released. */
  readonly isDisposed: boolean;

  /**
   * Uploads data into the buffer, reallocating when it does not fit.
   *
   * @param data Typed array, plain array or raw `ArrayBuffer` of element data.
   * @param options Partial-write description.
   */
  setData(data: ArrayLike<number> | ArrayBufferView | ArrayBuffer, options?: BufferDataOptions): void;

  /**
   * Reallocates the buffer to hold `count` elements, discarding its contents.
   *
   * @param count New element count.
   */
  setCount(count: number): void;

  /**
   * Reads the CPU-side mirror of the buffer.
   *
   * @returns The buffered data, or `null` when no mirror is kept.
   */
  getData(): ArrayLike<number> | null;

  /** Uploads any pending changes to the backend. */
  update(): void;

  /** Releases every resource owned by the buffer. */
  dispose(): void;
}

/** `true` when `value` satisfies the minimum {@link IBuffer} shape. */
export function isBuffer(value: unknown): value is IBuffer {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<IBuffer>;
  return typeof candidate.count === 'number' && typeof candidate.dispose === 'function';
}

/** Alias kept for symmetry with the other `I*` guards. */
export const isBufferLike = isBuffer;
