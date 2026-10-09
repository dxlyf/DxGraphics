/**
 * Attribute buffer manager.
 *
 * Owns the GPU-side mirror of every geometry attribute the renderer has seen.
 * Records are keyed by object identity in a `WeakMap`, so an attribute that goes
 * out of scope is collected automatically once nothing references its geometry.
 *
 * ## Change detection
 *
 * Geometry layers mutate a typed array in place and bump a monotonic `version`
 * counter. Comparing that counter is what makes `update(attribute)` cheap: an
 * attribute that has not changed since the last frame costs one integer compare
 * instead of a buffer upload.
 *
 * Attributes without a `version` are compared structurally against the values last
 * written (item size, element count, first and last element), which catches the
 * common "the array grew" and "the values changed" cases without hashing the whole
 * array every frame.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import { BufferType, BufferUsage } from '../interfaces/IBuffer';
import type { AttributeLike } from '../interfaces/types';
import {
  bytesPerElementOf,
  isIntegerArray,
  WebGLBuffer,
  byteLengthOf,
} from './WebGLBuffer';
import type { WebGLState } from './WebGLState';
import { glConst, toGLDataType, type GL } from './WebGLUtils';

/** Logger for attribute diagnostics. */
const log = createLogger('renderer:webgl:attributes');

/** Structural view of an index buffer, mirroring {@link GeometryLike.getIndex}. */
export interface IndexLike {
  /** Component array. */
  array: ArrayLike<number>;
  /** Components per index; `1` for a scalar index. */
  itemSize: number;
  /** Number of indices. */
  count?: number;
  /** Monotonic version used for change detection. */
  version?: number;
}

/** Bookkeeping for one uploaded attribute. */
export interface WebGLAttributeRecord {
  /** GPU buffer holding the data. */
  readonly buffer: WebGLBuffer;

  /** The live attribute object this record mirrors. */
  attribute: AttributeLike | IndexLike;

  /** Attribute version the buffer was uploaded from. */
  version: number;

  /** Components per vertex (1..4). */
  itemSize: number;

  /** `true` when integer components are normalised on read. */
  normalized: boolean;

  /** `gl.*` component type. */
  type: number;

  /** Bytes between consecutive vertices (0 = tightly packed). */
  byteStride: number;

  /** Number of vertices. */
  count: number;

  /** Instancing divisor (`0` = per-vertex). */
  divisor: number;

  /** `true` when the record mirrors an index buffer. */
  isIndex: boolean;

  /** Fingerprint of the last uploaded contents, used when there is no version. */
  fingerprint: string;
}

/** Options accepted by {@link WebGLAttributes}. */
export interface WebGLAttributesOptions {
  /** `true` when the context is WebGL2 (enables integer attribute pointers). */
  isWebGL2?: boolean;
  /** State object used for deduplicated buffer binding. */
  state?: WebGLState | null;
}

/**
 * The renderer's attribute store.
 *
 * ```ts
 * const record = attributes.update(geometry.getAttribute('position'));
 * attributes.setPointer(0, record);
 * ```
 */
export class WebGLAttributes {
  /** Context buffers are created on. */
  private readonly gl: GL;

  /** `true` when the context is WebGL2. */
  private readonly isWebGL2: boolean;

  /** Optional state object used for binding. */
  private readonly state: WebGLState | null;

  /** Attribute records, keyed by object identity. */
  private readonly records: WeakMap<object, WebGLAttributeRecord> = new WeakMap();

  /** Records kept in insertion order, so disposal can walk them. */
  private readonly tracked: WebGLAttributeRecord[] = [];

  /** Last index-buffer record, for `bindIndexBuffer()`. */
  private indexRecord: WebGLAttributeRecord | null = null;

  /** Number of uploads performed since construction (reported as `bufferUploads`). */
  private uploads: number = 0;

  /** `true` once {@link WebGLAttributes.dispose} has run. */
  private disposed: boolean = false;

  /**
   * Creates the store.
   *
   * @param gl Context to allocate buffers on.
   * @param options Context version and state plumbing.
   */
  constructor(gl: GL, options: WebGLAttributesOptions = {}) {
    this.gl = gl;
    this.isWebGL2 = options.isWebGL2 ?? true;
    this.state = options.state ?? null;
  }

  /** Number of live attribute records (reported through `memory.geometries`). */
  public get geometryCount(): number {
    return this.tracked.length;
  }

  /** Number of uploads performed. */
  public get uploadCount(): number {
    return this.uploads;
  }

  /** The current index-buffer record, or `null`. */
  public get index(): WebGLAttributeRecord | null {
    return this.indexRecord;
  }

  /**
   * Looks an attribute record up without uploading.
   *
   * @param attribute Attribute object previously passed to {@link WebGLAttributes.update}.
   */
  public get(attribute: AttributeLike | IndexLike | null | undefined): WebGLAttributeRecord | undefined {
    if (attribute == null || typeof attribute !== 'object') return undefined;
    return this.records.get(attribute as object);
  }

  /**
   * Uploads an attribute if it changed, and returns its record.
   *
   * @param attribute Attribute to synchronise.
   * @param usage Update-frequency hint; defaults to `Static` for the first upload.
   * @returns The record, or `null` when the attribute holds no data.
   */
  public update(attribute: AttributeLike | IndexLike | null | undefined, usage?: BufferUsage): WebGLAttributeRecord | null {
    if (attribute == null || typeof attribute !== 'object') return null;

    const array = attribute.array;
    if (array == null || typeof array.length !== 'number' || array.length === 0) return null;

    const itemSize = Math.max(1, Math.floor(attribute.itemSize ?? 1));
    const normalized = (attribute as AttributeLike).normalized === true;
    const version = typeof attribute.version === 'number' ? attribute.version : -1;
    const fingerprint = version >= 0 ? `v${version}` : fingerprintOf(array, itemSize);
    const elementSize = bytesPerElementOf(array);
    const byteLength = array.length * elementSize;

    let record = this.records.get(attribute as object);

    if (record !== undefined && record.fingerprint === fingerprint && record.itemSize === itemSize) {
      record.attribute = attribute;
      return record;
    }

    if (record === undefined) {
      const buffer = new WebGLBuffer(this.gl, {
        type: BufferType.Vertex,
        usage: usage ?? BufferUsage.Static,
        bytesPerElement: elementSize,
        label: 'attribute',
      });
      record = {
        buffer,
        attribute,
        version,
        itemSize,
        normalized,
        type: toGLDataType(this.gl, array),
        byteStride: 0,
        count: Math.floor(array.length / itemSize),
        divisor: 0,
        isIndex: false,
        fingerprint,
      };
      this.records.set(attribute as object, record);
      this.tracked.push(record);
    }

    // Growable reallocation: the buffer keeps a power-of-two capacity so an
    // attribute that grows every frame does not reallocate every frame.
    record.buffer.setData(toUploadable(array), byteLength);

    record.version = version;
    record.fingerprint = fingerprint;
    record.itemSize = itemSize;
    record.normalized = normalized;
    record.type = toGLDataType(this.gl, array);
    record.count = Math.floor(array.length / itemSize);
    this.uploads++;

    return record;
  }

  /**
   * Uploads an index buffer, replacing the previous one when it changed.
   *
   * @param index Index description.
   * @param usage Update-frequency hint.
   * @returns The record, or `null` when there is no index data.
   */
  public updateIndex(index: IndexLike | null | undefined, usage?: BufferUsage): WebGLAttributeRecord | null {
    if (index == null || index.array == null || index.array.length === 0) return null;

    const itemSize = Math.max(1, Math.floor(index.itemSize ?? 1));
    const version = typeof index.version === 'number' ? index.version : -1;
    const fingerprint = version >= 0 ? `v${version}` : fingerprintOf(index.array, itemSize);
    const elementSize = bytesPerElementOf(index.array);
    const byteLength = index.array.length * elementSize;

    let record = this.records.get(index as object);

    if (record !== undefined && record.fingerprint === fingerprint) {
      record.attribute = index;
      this.indexRecord = record;
      return record;
    }

    if (record === undefined) {
      const buffer = new WebGLBuffer(this.gl, {
        type: BufferType.Index,
        usage: usage ?? BufferUsage.Static,
        bytesPerElement: elementSize >= 4 ? 4 : 2,
        label: 'index',
      });
      record = {
        buffer,
        attribute: index,
        version,
        itemSize,
        normalized: false,
        type: elementSize >= 4 ? glConst(this.gl, 'UNSIGNED_INT', 0x1405) : glConst(this.gl, 'UNSIGNED_SHORT', 0x1403),
        byteStride: 0,
        count: Math.floor(index.array.length / itemSize),
        divisor: 0,
        isIndex: true,
        fingerprint,
      };
      this.records.set(index as object, record);
      this.tracked.push(record);
    }

    record.buffer.setData(toUploadable(index.array), byteLength);
    record.version = version;
    record.fingerprint = fingerprint;
    record.count = Math.floor(index.array.length / itemSize);
    this.uploads++;
    this.indexRecord = record;
    return record;
  }

  /**
   * Points a program attribute slot at a record's buffer.
   *
   * @param location Attribute location, or `-1` to skip.
   * @param record Attribute record.
   * @returns `true` when the pointer was configured.
   */
  public setPointer(location: number, record: WebGLAttributeRecord | null): boolean {
    if (record === null || location < 0) return false;

    const handle = record.buffer.getHandle();
    const target = record.buffer.getTarget();

    if (this.state !== null) {
      this.state.bindArrayBuffer(handle);
    } else {
      this.gl.bindBuffer(target, handle);
    }

    const integer = this.isWebGL2 && record.type !== glConst(this.gl, 'FLOAT', 0x1406) && isIntegerArray(record.attribute.array);

    if (integer) {
      (this.gl as WebGL2RenderingContext).vertexAttribIPointer(
        location,
        record.itemSize,
        record.type,
        record.byteStride,
        0,
      );
    } else {
      this.gl.vertexAttribPointer(location, record.itemSize, record.type, record.normalized, record.byteStride, 0);
    }

    if (record.divisor > 0) this.setDivisor(location, record.divisor);
    return true;
  }

  /**
   * Sets an attribute's instancing divisor.
   *
   * @param location Attribute location.
   * @param divisor Instances between advances.
   */
  public setDivisor(location: number, divisor: number): void {
    if (location < 0) return;
    const value = Math.max(0, Math.floor(divisor));
    if (this.isWebGL2) {
      (this.gl as WebGL2RenderingContext).vertexAttribDivisor(location, value);
      return;
    }
    const extension = this.gl.getExtension('ANGLE_instanced_arrays');
    if (extension != null) {
      (extension as ANGLE_instanced_arrays).vertexAttribDivisorANGLE(location, value);
    }
  }

  /**
   * Binds the index buffer of a record.
   *
   * @param record Index record, or `null` to unbind.
   * @returns `true` when a buffer was bound.
   */
  public bindIndexBuffer(record: WebGLAttributeRecord | null): boolean {
    if (record === null) {
      if (this.state !== null) this.state.bindElementArrayBuffer(null);
      else this.gl.bindBuffer(glConst(this.gl, 'ELEMENT_ARRAY_BUFFER', 0x8893), null);
      return false;
    }
    const handle = record.buffer.getHandle();
    if (this.state !== null) {
      this.state.bindElementArrayBuffer(handle);
    } else {
      this.gl.bindBuffer(record.buffer.getTarget(), handle);
    }
    this.indexRecord = record;
    return true;
  }

  /**
   * Releases the buffer behind one attribute.
   *
   * @param attribute Attribute object previously uploaded.
   * @returns `true` when a record existed.
   */
  public remove(attribute: AttributeLike | IndexLike): boolean {
    const record = this.records.get(attribute as object);
    if (record === undefined) return false;
    record.buffer.dispose();
    const index = this.tracked.indexOf(record);
    if (index >= 0) this.tracked.splice(index, 1);
    if (this.indexRecord === record) this.indexRecord = null;
    return true;
  }

  /** Releases every buffer this store owns. */
  public dispose(): void {
    if (this.disposed) return;
    for (const record of this.tracked) record.buffer.dispose();
    this.tracked.length = 0;
    this.indexRecord = null;
    this.disposed = true;
  }

  /**
   * Forgets every record without releasing it.
   *
   * Used after a context loss, where the handles are already gone and disposing
   * them would issue calls on a dead context.
   */
  public invalidate(): void {
    this.tracked.length = 0;
    this.indexRecord = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Coerces an attribute array into something `bufferSubData` accepts.
 *
 * `ArrayLike<number>` covers plain arrays, which the GL API cannot take directly;
 * those are copied into a `Float32Array` or `Uint16Array` depending on their
 * content.
 *
 * @param array Attribute component array.
 * @returns A typed array view.
 */
export function toUploadable(array: ArrayLike<number>): ArrayBufferView {
  if (ArrayBuffer.isView(array)) return array as ArrayBufferView;

  if (array instanceof Array || (typeof array === 'object' && typeof (array as ArrayLike<number>).length === 'number')) {
    const values = array as ArrayLike<number>;
    let allIntegers = true;
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
        allIntegers = false;
        break;
      }
    }
    if (allIntegers && values.length > 0) {
      const out = new Uint16Array(values.length);
      for (let i = 0; i < values.length; i++) out[i] = values[i];
      return out;
    }
    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) out[i] = values[i];
    return out;
  }

  return new Float32Array(0);
}

/**
 * Builds a cheap content fingerprint for an attribute without a version counter.
 *
 * Reading the first and last element plus the length catches the two changes that
 * matter in practice (the array grew, the values were rewritten) for a fixed cost
 * instead of a full pass over the data.
 */
function fingerprintOf(array: ArrayLike<number>, itemSize: number): string {
  const length = array.length;
  if (length === 0) return `e${itemSize}`;
  const first = array[0];
  const last = array[length - 1];
  return `c${length}:${itemSize}:${first}:${last}`;
}

/** Byte length of an attribute, exported for renderer bookkeeping. */
export function attributeByteLength(attribute: AttributeLike): number {
  const array = attribute.array;
  return byteLengthOf(toUploadable(array));
}
