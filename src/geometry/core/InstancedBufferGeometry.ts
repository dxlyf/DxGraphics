/**
 * `InstancedBufferGeometry` — one geometry drawn many times with per-instance
 * data.
 *
 * A mesh built from this geometry is submitted **once**; the backend asks the
 * vertex shader to run `instanceCount` times and to read the instance attributes
 * from a second, per-instance buffer. That is the difference between a forest of
 * 10 000 trees costing one draw call and costing 10 000.
 *
 * Per-instance attributes live in {@link InstancedBufferGeometry.instanceAttributes}
 * rather than in the shared `attributes` map, because their item count is
 * `instanceCount` and their divisor is 1, not 0. Keeping them apart means
 * `computeBoundingBox`, `computeVertexNormals`, `toNonIndexed`, `merge` and the
 * bounding-volume path keep operating on real per-vertex data and never mistake
 * an instance stream for vertex data.
 *
 * ```ts
 * const geometry = new InstancedBufferGeometry();
 * geometry.copy(base);
 * geometry.instanceCount = transforms.length;
 * geometry.setInstanceAttribute('instanceMatrix', new Float32BufferAttribute(flat, 16));
 * ```
 *
 * @packageDocumentation
 */

import { BufferAttribute } from './BufferAttribute';
import { BufferGeometry } from './BufferGeometry';
import type {
  AnyBufferAttribute,
  AttributeJSON,
  BufferGeometryJSON,
  InterleavedAttributeJSON,
} from './types';

/** JSON form of an `InstancedBufferGeometry`. */
export interface InstancedBufferGeometryJSON extends BufferGeometryJSON {
  /** Base class marker. */
  type: 'InstancedBufferGeometry';
  /** Number of instances drawn. */
  instanceCount: number;
  /** Instance attribute name -> serialised attribute. */
  instanceAttributes: Record<string, AttributeJSON | InterleavedAttributeJSON>;
}

/**
 * A `BufferGeometry` plus a per-instance attribute set and an instance count.
 */
export class InstancedBufferGeometry extends BufferGeometry {
  /** Discriminator used by the scene layer. */
  public readonly isInstancedBufferGeometry = true;

  /** Number of instances the backend must draw. */
  public instanceCount: number;

  /** Instance attribute name -> attribute whose `count` is the instance count. */
  public instanceAttributes: Record<string, AnyBufferAttribute>;

  /** Creates an empty instanced geometry. */
  constructor() {
    super();
    this.type = 'InstancedBufferGeometry';
    this.instanceCount = Infinity;
    this.instanceAttributes = {};
  }

  /* ------------------------------------------------------------ attributes */

  /**
   * Installs a per-instance attribute under `name`, replacing any previous one.
   *
   * The attribute's `count` is normally the instance count; the backend binds it
   * with a vertex-attrib divisor of `1`.
   *
   * @returns `this`, so calls chain.
   */
  public setInstanceAttribute(name: string, attribute: AnyBufferAttribute): this {
    this.instanceAttributes[name] = attribute;
    return this;
  }

  /** Returns the instance attribute bound to `name`, or `undefined`. */
  public getInstanceAttribute(name: string): AnyBufferAttribute | undefined {
    return this.instanceAttributes[name];
  }

  /** Removes and disposes the instance attribute bound to `name`. */
  public deleteInstanceAttribute(name: string): this {
    const attribute = this.instanceAttributes[name];
    if (attribute) {
      attribute.dispose();
      delete this.instanceAttributes[name];
    }
    return this;
  }

  /** `true` when an instance attribute is bound to `name`. */
  public hasInstanceAttribute(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.instanceAttributes, name);
  }

  /** Names of every installed instance attribute, in insertion order. */
  public getInstanceAttributeNames(): string[] {
    return Object.keys(this.instanceAttributes);
  }

  /**
   * Restricts drawing to `count` instances.
   *
   * @returns `this`, so calls chain.
   */
  public setInstanceCount(count: number): this {
    this.instanceCount = count;
    return this;
  }

  /* ------------------------------------------------------------- lifecycle */

  /** Releases the vertex attributes, the instance attributes and the index. */
  public override dispose(): void {
    for (const name of Object.keys(this.instanceAttributes)) {
      this.instanceAttributes[name].dispose();
    }
    this.instanceAttributes = {};
    super.dispose();
  }

  /* ----------------------------------------------------------------- copies */

  /** Deep-copies the base geometry and every instance attribute. */
  public override copy(source: BufferGeometry): this {
    super.copy(source);
    this.instanceAttributes = {};
    this.instanceCount = Infinity;
    if (source instanceof InstancedBufferGeometry) {
      this.instanceCount = source.instanceCount;
      for (const name of Object.keys(source.instanceAttributes)) {
        this.instanceAttributes[name] = source.instanceAttributes[name].clone();
      }
    }
    return this;
  }

  /** Returns an independent copy of this geometry, including instance attributes. */
  public override clone(): InstancedBufferGeometry {
    return new InstancedBufferGeometry().copy(this);
  }

  /* ------------------------------------------------------------------ output */

  /** Serialises the geometry, including the instance stream. */
  public override toJSON(): InstancedBufferGeometryJSON {
    const instanceAttributes: Record<string, AttributeJSON | InterleavedAttributeJSON> = {};
    for (const name of Object.keys(this.instanceAttributes)) {
      instanceAttributes[name] = this.instanceAttributes[name].toJSON();
    }
    return {
      ...super.toJSON(),
      type: 'InstancedBufferGeometry',
      instanceCount: this.instanceCount,
      instanceAttributes,
    };
  }

  /** Rebuilds an instanced geometry from {@link InstancedBufferGeometry.toJSON} output. */
  public static override fromJSON(json: InstancedBufferGeometryJSON): InstancedBufferGeometry {
    const geometry = new InstancedBufferGeometry();
    const base = BufferGeometry.fromJSON(json);
    geometry.copy(base);
    geometry.type = 'InstancedBufferGeometry';
    geometry.instanceCount = json.instanceCount ?? Infinity;
    geometry.instanceAttributes = {};
    for (const name of Object.keys(json.instanceAttributes ?? {})) {
      const attributeJSON = json.instanceAttributes[name];
      geometry.instanceAttributes[name] = BufferAttribute.fromJSON(attributeJSON);
    }
    return geometry;
  }
}
