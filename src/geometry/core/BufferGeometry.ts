/**
 * `BufferGeometry` 鈥?the GPU-facing geometry representation.
 *
 * A buffer geometry is nothing but named typed arrays plus the metadata needed
 * to draw them: an optional index buffer, a list of material groups, a draw
 * range and optional bounding volumes. It owns no rendering API objects by
 * itself; the backend derives buffers from the attributes and caches them by
 * {@link BufferAttribute.version}.
 *
 * ```ts
 * const geometry = new BufferGeometry();
 * geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
 * geometry.setIndex(indices);
 * geometry.computeVertexNormals();
 * geometry.computeBoundingSphere();
 * ```
 *
 * `BufferGeometry` satisfies the structural `BoundsSource` contract from
 * `src/core/BoundingVolume.ts`, so a `BoundingVolume` can be fitted from it
 * without either module importing the other.
 *
 * @packageDocumentation
 */

import { Disposable } from '../../core/Disposable';
import { Box3 } from '../../math/Box3';
import type { Mat4 } from '../../math/Mat4';
import { Sphere } from '../../math/Sphere';
import { Vec2 } from '../../math/Vec2';
import { Vec3 } from '../../math/Vec3';
import type { TypedArray, TypedArrayConstructor } from '../../types';
import { BufferAttribute, Uint32BufferAttribute } from './BufferAttribute';
import { InterleavedBufferAttribute } from './InterleavedBuffer';
import type {
  AnyBufferAttribute,
  AttributeJSON,
  BufferGeometryJSON,
  BufferGeometryOptions,
  DrawRange,
  GeometryGroup,
  InterleavedAttributeJSON,
  TransformTarget,
} from './types';

/* -------------------------------------------------------------------------- */
/* Shared scratch                                                             */
/* -------------------------------------------------------------------------- */

/** Scratch point reused by the bounding-volume passes. */
const _point = new Vec3();

/** Scratch vector for the tangent pass. */
const _vA = new Vec3();

/** Scratch vector for the tangent pass. */
const _vB = new Vec3();

/** Scratch vector for the tangent pass. */
const _vC = new Vec3();

/** Scratch uv for the tangent pass. */
const _uvA = new Vec2();

/** Scratch uv for the tangent pass. */
const _uvB = new Vec2();

/** Scratch uv for the tangent pass. */
const _uvC = new Vec2();

/** Scratch sdir for the tangent pass. */
const _sdir = new Vec3();

/** Scratch tdir for the tangent pass. */
const _tdir = new Vec3();

/** Scratch orthogonalised tangent for the tangent pass. */
const _tan = new Vec3();

/** Scratch cross product for the tangent pass. */
const _tmp = new Vec3();

/** Allocates a typed array of the same element type as `source`. */
function allocateLike(source: TypedArray, length: number): TypedArray {
  const Type = source.constructor as TypedArrayConstructor;
  return new Type(length) as TypedArray;
}

/** Writes `value` at `index` of a union-typed numeric store. */
function writeAt(array: TypedArray, index: number, value: number): void {
  (array as unknown as { [index: number]: number })[index] = value;
}

/* -------------------------------------------------------------------------- */
/* BufferGeometry                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Named vertex attributes plus index, groups and bounds.
 *
 * The class extends {@link Disposable}; `id` is inherited from it and is a
 * process-unique **string**, which makes it a valid `Map` key for backend
 * caches. There is deliberately no numeric id, because the base contract
 * declares `id` as a `string` and shadowing it with a number would be unsound.
 */
export class BufferGeometry extends Disposable<'BufferGeometry'> {
  /** Diagnostic label used by {@link Disposable}. */
  public override readonly label = 'BufferGeometry' as const;

  /** Discriminator used by the scene layer and by `isBufferGeometry` checks. */
  public readonly isBufferGeometry = true;

  /** Debug name, copied into {@link BufferGeometry.toJSON} output. */
  public name: string;

  /** Class name; `'InstancedBufferGeometry'` on the subclass. */
  public type: string;

  /** Attribute name -> attribute. Keyed exactly as the shader binds them. */
  public attributes: Record<string, AnyBufferAttribute>;

  /** Index buffer, or `null` for non-indexed geometry. */
  public index: AnyBufferAttribute | null;

  /** Contiguous index/vertex runs, each drawn with one material. */
  public groups: GeometryGroup[];

  /** Sub-range of the buffers the renderer may touch. */
  public drawRange: DrawRange;

  /** Local-space bounding box; `null` until {@link computeBoundingBox} runs. */
  public boundingBox: Box3 | null;

  /** Local-space bounding sphere; `null` until {@link computeBoundingSphere} runs. */
  public boundingSphere: Sphere | null;

  /** Free-form data carried through `copy` and serialisation. */
  public userData: Record<string, unknown>;

  /** Morph target name -> one delta attribute per morphed attribute. */
  public morphAttributes: Record<string, AnyBufferAttribute[]>;

  /**
   * Creates an empty geometry, optionally populated from `options`.
   *
   * @param options Initial attributes, index, groups, draw range and name.
   */
  constructor(options?: BufferGeometryOptions) {
    super();
    this.name = options?.name ?? '';
    this.type = 'BufferGeometry';
    this.attributes = {};
    this.index = null;
    this.groups = options?.groups ? options.groups.map((group) => ({ ...group })) : [];
    this.drawRange = options?.drawRange
      ? { start: options.drawRange.start, count: options.drawRange.count }
      : { start: 0, count: Infinity };
    this.boundingBox = null;
    this.boundingSphere = null;
    this.userData = options?.userData ?? {};
    this.morphAttributes = {};

    if (options?.attributes) {
      for (const name of Object.keys(options.attributes)) {
        this.setAttribute(name, options.attributes[name]);
      }
    }
    if (options?.index !== undefined && options.index !== null) {
      this.setIndex(options.index);
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Releases every attribute, the index buffer and registered children.
   *
   * Idempotent; clear the attribute map before calling `super.dispose()` so the
   * base class cannot report a partially released object.
   */
  public override dispose(): void {
    for (const name of Object.keys(this.attributes)) this.attributes[name].dispose();
    this.attributes = {};
    if (this.index) this.index.dispose();
    this.index = null;
    this.morphAttributes = {};
    this.groups = [];
    super.dispose();
  }

  /** Clears the last references held by the geometry so the arrays can be collected. */
  protected override onDispose(): void {
    this.boundingBox = null;
    this.boundingSphere = null;
    this.userData = {};
  }

  /* ------------------------------------------------------------ attributes */

  /**
   * Installs an attribute under `name`, replacing any previous one.
   *
   * @returns `this`, so calls chain.
   */
  public setAttribute(name: string, attribute: AnyBufferAttribute): this {
    this.attributes[name] = attribute;
    return this;
  }

  /** Returns the attribute bound to `name`, or `undefined`. */
  public getAttribute(name: string): AnyBufferAttribute | undefined {
    return this.attributes[name];
  }

  /** Alias of {@link getAttribute} matching the three.js spelling. */
  public getAttributeOrUndefined(name: string): AnyBufferAttribute | undefined {
    return this.attributes[name];
  }

  /** Removes and disposes the attribute bound to `name`. */
  public deleteAttribute(name: string): this {
    const attribute = this.attributes[name];
    if (attribute) {
      attribute.dispose();
      delete this.attributes[name];
    }
    return this;
  }

  /** `true` when an attribute is bound to `name`. */
  public hasAttribute(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  /** Names of every installed attribute, in insertion order. */
  public getAttributeNames(): string[] {
    return Object.keys(this.attributes);
  }

  /* ----------------------------------------------------------------- index */

  /**
   * Installs the index buffer.
   *
   * @param index Element data (widened to `Uint32Array`), a ready-made
   *   attribute, or `null` to remove the index.
   */
  public setIndex(index: ArrayLike<number> | AnyBufferAttribute | null): this {
    if (this.index) this.index.dispose();
    if (index === null) {
      this.index = null;
      return this;
    }
    if (typeof (index as AnyBufferAttribute).getX === 'function') {
      this.index = index as AnyBufferAttribute;
    } else {
      this.index = new Uint32BufferAttribute(index as ArrayLike<number>, 1, false, 'static', 'index');
    }
    return this;
  }

  /**
   * Returns the index buffer, or `undefined` when the geometry is non-indexed.
   *
   * Returns `undefined` rather than `null` so the method satisfies the optional
   * `BoundsSource.getIndex` contract exactly.
   */
  public getIndex(): AnyBufferAttribute | undefined {
    return this.index ?? undefined;
  }

  /** `true` when the geometry has an index buffer. */
  public get indexed(): boolean {
    return this.index !== null;
  }

  /* ---------------------------------------------------------------- groups */

  /**
   * Appends a contiguous run to be drawn with one material.
   *
   * @param start First index (or vertex) of the run.
   * @param count Number of indices (or vertices) in the run.
   * @param materialIndex Index into the object's material array.
   */
  public addGroup(start: number, count: number, materialIndex: number = 0): this {
    this.groups.push({ start, count, materialIndex });
    return this;
  }

  /** Removes every group. */
  public clearGroups(): this {
    this.groups = [];
    return this;
  }

  /** Restricts rendering to `count` elements starting at `start`. */
  public setDrawRange(start: number, count: number): this {
    this.drawRange.start = start;
    this.drawRange.count = count;
    return this;
  }

  /* ---------------------------------------------------------------- bounds */

  /** Total number of vertices addressed by the geometry. */
  public getVertexCount(): number {
    if (this.index) return this.index.count;
    const position = this.attributes['position'];
    return position ? position.count : 0;
  }

  /**
   * Fits {@link boundingBox} around the `position` attribute.
   *
   * Uses the attribute's strided accessors, so an interleaved position buffer is
   * measured correctly. The `drawRange` is deliberately ignored: bounds describe
   * the geometry, and a backend that draws a sub-range still needs the full box
   * for culling.
   *
   * **Note:** this is implemented inline rather than delegating to a
   * `src/geometry/3d/utils/computeBoundingBox` helper, because that module does
   * not exist yet (it belongs to the 3D layer). When it lands, this body can be
   * replaced by a one-line delegation; the observable behaviour is identical.
   *
   * @returns `this`, so calls chain.
   */
  public computeBoundingBox(): this {
    const position = this.attributes['position'];
    const box = this.boundingBox ?? new Box3();
    box.makeEmpty();
    this.boundingBox = box;
    if (!position) return this;

    for (let i = 0; i < position.count; i++) {
      _point.set(position.getX(i), position.getY(i), position.getZ(i));
      box.expandByPoint(_point);
    }
    return this;
  }

  /**
   * Fits {@link boundingSphere} around the `position` attribute.
   *
   * The centre is the centre of {@link boundingBox} and the radius is the
   * largest distance from that centre to any vertex. That is the standard cheap
   * fit: it never underestimates the extent, so it is safe for culling, but it
   * is up to roughly 15% larger than the minimal enclosing sphere.
   *
   * **Note:** implemented inline for the same reason as
   * {@link BufferGeometry.computeBoundingBox} — the `src/geometry/3d/utils`
   * helper it would otherwise delegate to is owned by the 3D layer and does not
   * exist yet.
   *
   * @returns `this`, so calls chain.
   */
  public computeBoundingSphere(): this {
    const position = this.attributes['position'];
    if (!this.boundingSphere) this.boundingSphere = new Sphere();
    const sphere = this.boundingSphere;
    sphere.makeEmpty();
    if (!position) return this;

    if (!this.boundingBox) this.computeBoundingBox();
    const box = this.boundingBox;
    if (!box || box.isEmpty()) return this;

    box.getCenter(sphere.center);
    let maxRadiusSquared = 0;
    for (let i = 0; i < position.count; i++) {
      _point.set(position.getX(i), position.getY(i), position.getZ(i));
      const distanceSquared = _point.distanceToSquared(sphere.center);
      if (distanceSquared > maxRadiusSquared) maxRadiusSquared = distanceSquared;
    }
    sphere.radius = Math.sqrt(maxRadiusSquared);
    return this;
  }

  /* ------------------------------------------------------------ transforms */

  /**
   * Applies a column-major 4x4 matrix to every transformable attribute and to
   * the cached bounding volumes.
   *
   * `position` is transformed as a point, `normal` by the inverse-transpose of
   * the model matrix and `tangent` as a direction with handedness correction.
   * Every other attribute is left untouched, because there is no way to know
   * whether it holds a direction, a colour or an index.
   */
  public applyMat4(m: Mat4): this {
    const position = this.attributes['position'];
    if (position) position.applyMat4(m, 'position' as TransformTarget);
    const normal = this.attributes['normal'];
    if (normal) normal.applyMat4(m, 'normal' as TransformTarget);
    const tangent = this.attributes['tangent'];
    if (tangent) tangent.applyMat4(m, 'tangent' as TransformTarget);

    if (this.boundingBox) this.boundingBox.applyMat4(m);
    if (this.boundingSphere) this.boundingSphere.applyMat4(m);
    return this;
  }

  /**
   * Computes smooth vertex normals and installs them as the `normal` attribute.
   *
   * Face normals are accumulated per vertex and then normalised, which is the
   * smooth-shading convention. Indexed geometry shares vertices and therefore
   * shares normals; non-indexed geometry produces one normal per triangle
   * corner, so the result is flat unless positions are duplicated and welded
   * first. Any previous `normal` attribute is replaced.
   */
  public computeVertexNormals(): this {
    const position = this.attributes['position'];
    if (!position) return this;

    const normalAttribute = new BufferAttribute(new Float32Array(position.count * 3), 3);
    const indices = this.index ? this.index.array : null;

    if (indices) {
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i];
        const b = indices[i + 1];
        const c = indices[i + 2];
        if (a === undefined || b === undefined || c === undefined) continue;
        readVec3(position, a, _vA);
        readVec3(position, b, _vB);
        readVec3(position, c, _vC);
        _vC.sub(_vB);
        _vA.sub(_vB);
        _vC.cross(_vA);
        accumulate(normalAttribute, a, _vC);
        accumulate(normalAttribute, b, _vC);
        accumulate(normalAttribute, c, _vC);
      }
    } else {
      for (let i = 0; i < position.count; i += 3) {
        readVec3(position, i, _vA);
        readVec3(position, i + 1, _vB);
        readVec3(position, i + 2, _vC);
        _vC.sub(_vB);
        _vA.sub(_vB);
        _vC.cross(_vA);
        normalAttribute.setXYZ(i, _vC.x, _vC.y, _vC.z);
        normalAttribute.setXYZ(i + 1, _vC.x, _vC.y, _vC.z);
        normalAttribute.setXYZ(i + 2, _vC.x, _vC.y, _vC.z);
      }
    }

    this.setAttribute('normal', normalAttribute);
    this.normalizeNormals();
    return this;
  }

  /**
   * Computes per-vertex tangents (xyz) plus a handedness sign (w) into a
   * `tangent` attribute.
   *
   * Requires `index`, `position`, `normal` and `uv`. Mirrors the three.js
   * algorithm: accumulate the per-triangle tangent/bitangent basis, then
   * Gram-Schmidt orthogonalise against the normal and derive `w` from the sign
   * of the bitangent projection.
   *
   * @throws Error when one of the four required inputs is missing.
   */
  public computeTangents(): this {
    const index = this.index;
    const position = this.attributes['position'];
    const normal = this.attributes['normal'];
    const uv = this.attributes['uv'];

    if (!index || !position || !normal || !uv) {
      throw new Error(
        'BufferGeometry.computeTangents(): requires an index buffer and the position, normal and uv attributes',
      );
    }

    const indices = index.array;
    const vertexCount = position.count;
    const tan1 = new Float32Array(vertexCount * 3);
    const tan2 = new Float32Array(vertexCount * 3);

    const handleTriangle = (a: number, b: number, c: number): void => {
      readVec3(position, a, _vA);
      readVec3(position, b, _vB);
      readVec3(position, c, _vC);
      readVec2(uv, a, _uvA);
      readVec2(uv, b, _uvB);
      readVec2(uv, c, _uvC);

      _vB.sub(_vA);
      _vC.sub(_vA);
      _uvB.sub(_uvA);
      _uvC.sub(_uvA);

      const determinant = _uvB.x * _uvC.y - _uvC.x * _uvB.y;
      if (determinant === 0) return;
      const r = 1 / determinant;

      _sdir.copy(_vB).multiplyScalar(_uvC.y).addScaledVector(_vC, -_uvB.y).multiplyScalar(r);
      _tdir.copy(_vC).multiplyScalar(_uvB.x).addScaledVector(_vB, -_uvC.x).multiplyScalar(r);

      accumulateTangent(tan1, tan2, a, _sdir, _tdir);
      accumulateTangent(tan1, tan2, b, _sdir, _tdir);
      accumulateTangent(tan1, tan2, c, _sdir, _tdir);
    };

    if (indices.length > 0) {
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i];
        const b = indices[i + 1];
        const c = indices[i + 2];
        if (a === undefined || b === undefined || c === undefined) continue;
        handleTriangle(a, b, c);
      }
    } else {
      for (let i = 0; i < vertexCount; i += 3) handleTriangle(i, i + 1, i + 2);
    }

    const tangentArray = new Float32Array(vertexCount * 4);
    for (let i = 0; i < vertexCount; i++) {
      const nx = normal.getX(i);
      const ny = normal.getY(i);
      const nz = normal.getZ(i);

      _tan.set(tan1[i * 3], tan1[i * 3 + 1], tan1[i * 3 + 2]);
      const projection = _tan.x * nx + _tan.y * ny + _tan.z * nz;
      _tan.set(_tan.x - nx * projection, _tan.y - ny * projection, _tan.z - nz * projection);
      if (_tan.lengthSquared() > 0) _tan.normalize();

      _tmp.set(nx, ny, nz).cross(_tan);
      const test = _tmp.x * tan2[i * 3] + _tmp.y * tan2[i * 3 + 1] + _tmp.z * tan2[i * 3 + 2];
      const handedness = test < 0 ? -1 : 1;

      tangentArray[i * 4] = _tan.x;
      tangentArray[i * 4 + 1] = _tan.y;
      tangentArray[i * 4 + 2] = _tan.z;
      tangentArray[i * 4 + 3] = handedness;
    }

    this.setAttribute('tangent', new BufferAttribute(tangentArray, 4));
    return this;
  }

  /** Normalises every vector of the `normal` attribute in place. */
  public normalizeNormals(): this {
    const normals = this.attributes['normal'];
    if (!normals) return this;
    for (let i = 0; i < normals.count; i++) {
      const x = normals.getX(i);
      const y = normals.getY(i);
      const z = normals.getZ(i);
      const length = Math.sqrt(x * x + y * y + z * z);
      const scale = length > 0 ? 1 / length : 1;
      normals.setXYZ(i, x * scale, y * scale, z * scale);
    }
    return this;
  }

  /* ----------------------------------------------------------------- copies */

  /**
   * Expands indexed geometry into an equivalent non-indexed geometry.
   *
   * Every index becomes a distinct vertex, so shared vertices are duplicated.
   * Interleaved inputs are expanded into plain (tightly packed) attributes.
   * Returns a clone when the geometry is already non-indexed.
   */
  public toNonIndexed(): BufferGeometry {
    if (!this.index) return this.clone();

    const geometry = new BufferGeometry();
    geometry.name = this.name ? `${this.name}-nonIndexed` : '';

    const indices = this.index.array;
    for (const name of Object.keys(this.attributes)) {
      const attribute = this.attributes[name];
      const itemSize = attribute.itemSize;
      const array = allocateLike(attribute.array, indices.length * itemSize);
      let write = 0;
      for (let i = 0; i < indices.length; i++) {
        const element = indices[i];
        for (let c = 0; c < itemSize; c++) writeAt(array, write++, attribute.getComponent(element, c));
      }
      geometry.setAttribute(name, new BufferAttribute(array, itemSize, attribute.normalized));
    }

    for (const group of this.groups) {
      geometry.addGroup(group.start, group.count, group.materialIndex ?? 0);
    }
    geometry.drawRange.start = this.drawRange.start;
    geometry.drawRange.count = this.drawRange.count;
    return geometry;
  }

  /**
   * Merges `other` into this geometry.
   *
   * Both geometries must be indexed or both non-indexed, and must expose the
   * same attribute names with the same `itemSize`. Attribute data is
   * concatenated, index values are offset by the number of existing vertices and
   * group starts are offset by the number of existing indices.
   *
   * @throws Error when the two geometries are structurally incompatible.
   */
  public merge(other: BufferGeometry): this {
    if ((this.index === null) !== (other.index === null)) {
      throw new Error(
        'BufferGeometry.merge(): both geometries must be indexed or both must be non-indexed',
      );
    }

    const thisNames = Object.keys(this.attributes).sort();
    const otherNames = Object.keys(other.attributes).sort();
    if (thisNames.length !== otherNames.length) {
      throw new Error('BufferGeometry.merge(): the two geometries do not have matching attributes');
    }
    for (let i = 0; i < thisNames.length; i++) {
      if (thisNames[i] !== otherNames[i]) {
        throw new Error(
          `BufferGeometry.merge(): attribute mismatch, expected '${thisNames[i]}' but found '${otherNames[i]}'`,
        );
      }
      const a = this.attributes[thisNames[i]];
      const b = other.attributes[otherNames[i]];
      if (a.itemSize !== b.itemSize) {
        throw new Error(
          `BufferGeometry.merge(): attribute '${thisNames[i]}' has itemSize ${a.itemSize} here and ${b.itemSize} there`,
        );
      }
    }

    const vertexOffset = this.index ? this.index.count : this.getVertexCount();
    const indexOffset = this.index ? this.index.count : vertexOffset;

    for (const name of thisNames) {
      const a = this.attributes[name];
      const b = other.attributes[name];
      const merged = allocateLike(a.array, a.count * a.itemSize + b.count * b.itemSize);
      let write = 0;
      for (let i = 0; i < a.count; i++) {
        for (let c = 0; c < a.itemSize; c++) writeAt(merged, write++, a.getComponent(i, c));
      }
      for (let i = 0; i < b.count; i++) {
        for (let c = 0; c < b.itemSize; c++) writeAt(merged, write++, b.getComponent(i, c));
      }
      this.attributes[name].dispose();
      this.attributes[name] = new BufferAttribute(merged, a.itemSize, a.normalized, a.usage, name);
    }

    if (this.index && other.index) {
      const a = this.index;
      const b = other.index;
      const mergedIndex = new Uint32Array(a.count + b.count);
      for (let i = 0; i < a.count; i++) mergedIndex[i] = a.getX(i);
      for (let i = 0; i < b.count; i++) mergedIndex[a.count + i] = b.getX(i) + vertexOffset;
      this.setIndex(mergedIndex);
    }

    for (const group of other.groups) {
      this.addGroup(group.start + indexOffset, group.count, group.materialIndex ?? 0);
    }

    this.boundingBox = null;
    this.boundingSphere = null;
    return this;
  }

  /** Deep-copies every attribute, the index, groups, draw range and user data. */
  public copy(source: BufferGeometry): this {
    this.name = source.name;
    this.type = source.type;
    this.userData = { ...source.userData };

    for (const name of Object.keys(this.attributes)) this.attributes[name].dispose();
    this.attributes = {};
    for (const name of Object.keys(source.attributes)) {
      this.attributes[name] = source.attributes[name].clone();
    }

    if (this.index) this.index.dispose();
    this.index = source.index ? source.index.clone() : null;

    this.groups = source.groups.map((group) => ({ ...group }));
    this.drawRange = { start: source.drawRange.start, count: source.drawRange.count };

    this.boundingBox = source.boundingBox ? source.boundingBox.clone() : null;
    this.boundingSphere = source.boundingSphere ? source.boundingSphere.clone() : null;

    this.morphAttributes = {};
    for (const name of Object.keys(source.morphAttributes)) {
      this.morphAttributes[name] = source.morphAttributes[name].map((attribute) => attribute.clone());
    }
    return this;
  }

  /** Returns an independent copy of this geometry. */
  public clone(): BufferGeometry {
    return new BufferGeometry().copy(this);
  }

  /* ------------------------------------------------------------------ output */

  /** Serialises the geometry; round-trips through {@link BufferGeometry.fromJSON}. */
  public toJSON(): BufferGeometryJSON {
    const attributes: Record<string, AttributeJSON | InterleavedAttributeJSON> = {};
    for (const name of Object.keys(this.attributes)) attributes[name] = this.attributes[name].toJSON();

    const morphAttributes: Record<string, AttributeJSON[]> = {};
    for (const name of Object.keys(this.morphAttributes)) {
      morphAttributes[name] = this.morphAttributes[name].map((attribute) => attribute.toJSON());
    }

    return {
      type: 'BufferGeometry',
      name: this.name,
      attributes,
      index: this.index ? (this.index.toJSON() as AttributeJSON) : null,
      groups: this.groups.map((group) => ({ ...group })),
      drawRange: { start: this.drawRange.start, count: this.drawRange.count },
      boundingBox: this.boundingBox
        ? { min: this.boundingBox.min.toArray(), max: this.boundingBox.max.toArray() }
        : null,
      boundingSphere: this.boundingSphere
        ? { center: this.boundingSphere.center.toArray(), radius: this.boundingSphere.radius }
        : null,
      morphAttributes,
      userData: { ...this.userData },
    };
  }

  /**
   * Rebuilds a geometry from {@link BufferGeometry.toJSON} output.
   *
   * Bounding volumes are restored from the serialised numbers, so a round trip
   * does not force a recomputation.
   */
  public static fromJSON(json: BufferGeometryJSON): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.name = json.name ?? '';
    geometry.userData = { ...(json.userData ?? {}) };

    for (const name of Object.keys(json.attributes ?? {})) {
      const attributeJSON = json.attributes[name];
      geometry.setAttribute(
        name,
        'interleaved' in attributeJSON && attributeJSON.interleaved
          ? InterleavedBufferAttribute.fromJSON(attributeJSON)
          : BufferAttribute.fromJSON(attributeJSON),
      );
    }

    if (json.index) geometry.setIndex(BufferAttribute.fromJSON(json.index));

    geometry.groups = (json.groups ?? []).map((group) => ({ ...group }));
    geometry.drawRange = {
      start: json.drawRange?.start ?? 0,
      count: json.drawRange?.count ?? Infinity,
    };

    if (json.boundingBox) {
      const box = new Box3();
      box.min.fromArray(json.boundingBox.min);
      box.max.fromArray(json.boundingBox.max);
      geometry.boundingBox = box;
    }
    if (json.boundingSphere) {
      const sphere = new Sphere();
      sphere.center.fromArray(json.boundingSphere.center);
      sphere.radius = json.boundingSphere.radius;
      geometry.boundingSphere = sphere;
    }

    for (const name of Object.keys(json.morphAttributes ?? {})) {
      geometry.morphAttributes[name] = json.morphAttributes[name].map((attribute) =>
        BufferAttribute.fromJSON(attribute),
      );
    }
    return geometry;
  }

  /** `"BufferGeometry(name=mesh, attributes=3, indexed=true)"`. */
  public override toString(): string {
    return `BufferGeometry(name=${this.name || 'unnamed'}, attributes=${
      Object.keys(this.attributes).length
    }, indexed=${this.indexed})`;
  }
}

/* -------------------------------------------------------------------------- */
/* Module-private helpers                                                     */
/* -------------------------------------------------------------------------- */

/** Reads three position components through either attribute flavour. */
function readVec3(attribute: AnyBufferAttribute, index: number, target: Vec3): Vec3 {
  return target.set(attribute.getX(index), attribute.getY(index), attribute.getZ(index));
}

/** Reads two components (typically a uv) through either attribute flavour. */
function readVec2(attribute: AnyBufferAttribute, index: number, target: Vec2): Vec2 {
  return target.set(attribute.getX(index), attribute.getY(index));
}

/** Adds a face normal to the running per-vertex normal. */
function accumulate(attribute: AnyBufferAttribute, index: number, contribution: Vec3): void {
  attribute.setXYZ(
    index,
    attribute.getX(index) + contribution.x,
    attribute.getY(index) + contribution.y,
    attribute.getZ(index) + contribution.z,
  );
}

/** Accumulates one triangle's tangent (`sdir`) and bitangent (`tdir`) onto a vertex. */
function accumulateTangent(
  tan1: Float32Array,
  tan2: Float32Array,
  vertex: number,
  sdir: Vec3,
  tdir: Vec3,
): void {
  const offset = vertex * 3;
  tan1[offset] += sdir.x;
  tan1[offset + 1] += sdir.y;
  tan1[offset + 2] += sdir.z;
  tan2[offset] += tdir.x;
  tan2[offset + 1] += tdir.y;
  tan2[offset + 2] += tdir.z;
}
