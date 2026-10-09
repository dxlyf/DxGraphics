/**
 * `Geometry` 閳?the legacy, authorable geometry representation.
 *
 * > **`BufferGeometry` is the recommended path for rendering.** `Geometry`
 * > exists for authoring and import: it stores an indexed vertex pool
 * > (`vertices`) plus a face list whose corners reference that pool, which is
 * > exactly the shape produced by OBJ/STL-style importers, modelling tools and
 * > hand-written generators. Rendering it directly would force the backend to
 * > rebuild a vertex buffer whenever a single vertex moves.
 * >
 * > Convert once with {@link Geometry.toBufferGeometry} and render the result.
 * > Keep a `Geometry` only while it is still being edited.
 *
 * Differences from `BufferGeometry` that matter in practice:
 *
 * | | `Geometry` | `BufferGeometry` |
 * | --- | --- | --- |
 * | Vertex reuse | shared indices, `faces[i].a..d` | index buffer |
 * | Attributes | `vertices`, `normals`, `colors`, `uvs[i]` | named typed arrays |
 * | Per-face data | normals, colours, material index | groups + separate attributes |
 * | Quad support | yes (`face.d >= 0`) | no, triangles only |
 * | GPU friendliness | low | high |
 *
 * @packageDocumentation
 */

import { Disposable } from '../../core/Disposable';
import { Box3 } from '../../math/Box3';
import { Color } from '../../math/Color';
import { Sphere } from '../../math/Sphere';
import type { Mat4 } from '../../math/Mat4';
import { Vec2 } from '../../math/Vec2';
import { Vec3 } from '../../math/Vec3';
import { Float32BufferAttribute } from './BufferAttribute';
import { BufferGeometry } from './BufferGeometry';
import type { FaceJSON, GeometryJSON } from './types';

/* -------------------------------------------------------------------------- */
/* Face                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One polygon of a {@link Geometry}.
 *
 * A face is a triangle when `d < 0` and a quad otherwise (corners `a`, `b`, `c`
 * then `d`). Quads are split into two triangles during conversion.
 */
export class Face {
  /** First corner index. */
  public a: number;

  /** Second corner index. */
  public b: number;

  /** Third corner index. */
  public c: number;

  /** Fourth corner index, or `-1` for a triangle. */
  public d: number;

  /** Flat face normal, in object space. */
  public normal: Vec3;

  /** Per-corner normals, in `a, b, c, d` order; empty means "use {@link normal}". */
  public vertexNormals: Vec3[];

  /** Flat face colour. */
  public color: Color;

  /** Per-corner colours, in `a, b, c, d` order; empty means "use {@link color}". */
  public vertexColors: Color[];

  /** Index into the owning mesh's material array. */
  public materialIndex: number;

  /**
   * Creates a face.
   *
   * @param a First corner index.
   * @param b Second corner index.
   * @param c Third corner index.
   * @param d Fourth corner index, or `-1` for a triangle.
   * @param normal Flat face normal.
   * @param color Flat face colour.
   * @param materialIndex Material slot.
   */
  constructor(
    a: number = 0,
    b: number = 0,
    c: number = 0,
    d: number = -1,
    normal: Vec3 = new Vec3(),
    color: Color = new Color(),
    materialIndex: number = 0,
  ) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.normal = normal;
    this.vertexNormals = [];
    this.color = color;
    this.vertexColors = [];
    this.materialIndex = materialIndex;
  }

  /** `true` when the face has four corners. */
  public get isQuad(): boolean {
    return this.d >= 0;
  }

  /** Number of corners (`3` or `4`). */
  public get cornerCount(): number {
    return this.d >= 0 ? 4 : 3;
  }

  /** Corner indices as a fresh array, in `a, b, c, d` order. */
  public getIndices(): number[] {
    return this.d >= 0 ? [this.a, this.b, this.c, this.d] : [this.a, this.b, this.c];
  }

  /** Copies every field from `source`. */
  public copy(source: Face): this {
    this.a = source.a;
    this.b = source.b;
    this.c = source.c;
    this.d = source.d;
    this.normal.copy(source.normal);
    this.color.copy(source.color);
    this.materialIndex = source.materialIndex;
    this.vertexNormals = source.vertexNormals.map((normal) => normal.clone());
    this.vertexColors = source.vertexColors.map((color) => color.clone());
    return this;
  }

  /** Returns a new face with the same data. */
  public clone(): Face {
    return new Face().copy(this);
  }

  /** Serialises the face; round-trips through {@link Face.fromJSON}. */
  public toJSON(): FaceJSON {
    return {
      a: this.a,
      b: this.b,
      c: this.c,
      d: this.d,
      normal: this.normal.toArray(),
      vertexNormals: this.vertexNormals.length
        ? this.vertexNormals.map((normal) => normal.toArray())
        : null,
      color: this.color.toArray(),
      vertexColors: this.vertexColors.length
        ? this.vertexColors.map((color) => color.toArray())
        : null,
      materialIndex: this.materialIndex,
    };
  }

  /** Rebuilds a face from {@link Face.toJSON} output. */
  public static fromJSON(json: FaceJSON): Face {
    const face = new Face(json.a, json.b, json.c, json.d);
    if (json.normal) face.normal.fromArray(json.normal);
    if (json.color) face.color.set(json.color[0], json.color[1], json.color[2], json.color[3] ?? 1);
    if (json.vertexNormals) {
      face.vertexNormals = json.vertexNormals.map((values) => new Vec3().fromArray(values));
    }
    if (json.vertexColors) {
      face.vertexColors = json.vertexColors.map(
        (values) => new Color(values[0], values[1], values[2], values[3] ?? 1),
      );
    }
    face.materialIndex = json.materialIndex;
    return face;
  }
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * An indexed vertex pool plus a face list, intended for authoring and import.
 *
 * @see {@link Geometry.toBufferGeometry} to hand the result to a renderer.
 */
export class Geometry extends Disposable<'Geometry'> {
  /** Diagnostic label used by {@link Disposable}. */
  public override readonly label = 'Geometry' as const;

  /** Discriminator for structural checks. */
  public readonly isGeometry = true;

  /** Debug name copied into {@link Geometry.toJSON} output. */
  public name: string;

  /** Class name; always `'Geometry'`. */
  public type: string;

  /** Shared vertex pool referenced by every face corner. */
  public vertices: Vec3[];

  /** Optional per-vertex colours, parallel to {@link vertices}. */
  public colors: Color[];

  /** Optional per-vertex normals, parallel to {@link vertices}. */
  public normals: Vec3[];

  /**
   * Texture coordinate channels.
   *
   * `uvs[channel][vertexIndex]` is the uv of vertex `vertexIndex`. An empty
   * outer array means "no uvs"; a shorter inner array means "uvs for the first
   * `n` vertices only".
   */
  public uvs: Vec2[][];

  /** The polygon list. */
  public faces: Face[];

  /** Local-space bounding box; `null` until {@link computeBoundingBox} runs. */
  public boundingBox: Box3 | null;

  /** Local-space bounding sphere; `null` until {@link computeBoundingSphere} runs. */
  public boundingSphere: Sphere | null;

  /** Set when {@link vertices} changed and derived data must be rebuilt. */
  public verticesNeedUpdate: boolean;

  /** Set when {@link normals} changed. */
  public normalsNeedUpdate: boolean;

  /** Set when {@link uvs} changed. */
  public uvsNeedUpdate: boolean;

  /** Set when {@link faces} changed. */
  public elementsNeedUpdate: boolean;

  /** Free-form data carried through `copy` and serialisation. */
  public userData: Record<string, unknown>;

  /** Creates an empty geometry. */
  constructor() {
    super();
    this.name = '';
    this.type = 'Geometry';
    this.vertices = [];
    this.colors = [];
    this.normals = [];
    this.uvs = [];
    this.faces = [];
    this.boundingBox = null;
    this.boundingSphere = null;
    this.verticesNeedUpdate = false;
    this.normalsNeedUpdate = false;
    this.uvsNeedUpdate = false;
    this.elementsNeedUpdate = false;
    this.userData = {};
  }

  /** Releases the geometry and clears the vertex and face lists. */
  protected override onDispose(): void {
    this.vertices = [];
    this.colors = [];
    this.normals = [];
    this.uvs = [];
    this.faces = [];
    this.boundingBox = null;
    this.boundingSphere = null;
  }

  /* -------------------------------------------------------------- mutation */

  /**
   * Adds a vertex and returns its index.
   *
   * @param x X coordinate.
   * @param y Y coordinate.
   * @param z Z coordinate.
   */
  public addVertex(x: number, y: number, z: number): number {
    this.vertices.push(new Vec3(x, y, z));
    this.verticesNeedUpdate = true;
    this.boundingBox = null;
    this.boundingSphere = null;
    return this.vertices.length - 1;
  }

  /**
   * Adds a triangle using three vertex indices.
   *
   * @returns The new face.
   */
  public addTriangle(a: number, b: number, c: number, materialIndex: number = 0): Face {
    const face = new Face(a, b, c, -1, new Vec3(), new Color(), materialIndex);
    this.faces.push(face);
    this.elementsNeedUpdate = true;
    return face;
  }

  /**
   * Adds a quad using four vertex indices; it is split into two triangles on
   * conversion.
   *
   * @returns The new face.
   */
  public addQuad(a: number, b: number, c: number, d: number, materialIndex: number = 0): Face {
    const face = new Face(a, b, c, d, new Vec3(), new Color(), materialIndex);
    this.faces.push(face);
    this.elementsNeedUpdate = true;
    return face;
  }

  /** Ensures `uvs[channel]` exists and is long enough for every vertex. */
  private ensureUvChannel(channel: number): Vec2[] {
    while (this.uvs.length <= channel) this.uvs.push([]);
    const list = this.uvs[channel];
    while (list.length < this.vertices.length) list.push(new Vec2());
    return list;
  }

  /**
   * Writes one uv coordinate.
   *
   * @param vertexIndex Vertex the uv belongs to.
   * @param u Horizontal coordinate.
   * @param v Vertical coordinate.
   * @param channel UV channel, `0` by default.
   */
  public addUv(vertexIndex: number, u: number, v: number, channel: number = 0): this {
    const list = this.ensureUvChannel(channel);
    const uv = list[vertexIndex] ?? new Vec2();
    uv.set(u, v);
    list[vertexIndex] = uv;
    this.uvsNeedUpdate = true;
    return this;
  }

  /* ----------------------------------------------------------- computation */

  /** Recomputes every face normal from its corners (Newell's method; handles quads). */
  public computeFaceNormals(): this {
    const cb = new Vec3();
    const ab = new Vec3();
    for (const face of this.faces) {
      const vA = this.vertices[face.a];
      const vB = this.vertices[face.b];
      const vC = this.vertices[face.c];
      if (!vA || !vB || !vC) continue;
      cb.subVectors(vC, vB);
      ab.subVectors(vA, vB);
      cb.cross(ab);
      const length = cb.length();
      if (length > 0) cb.divideScalar(length);
      face.normal.copy(cb);
    }
    return this;
  }

  /**
   * Computes smoothed per-vertex normals and stores them in the `normal`
   * attribute of the converted geometry's source pool ({@link normals}).
   *
   * Faces are weighted equally unless `areaWeighted` is set, in which case the
   * un-normalised cross product (proportional to twice the triangle area) is
   * accumulated instead.
   *
   * @param areaWeighted Weight each face by its area.
   */
  public computeVertexNormals(areaWeighted: boolean = false): this {
    const pool: Vec3[] = new Array(this.vertices.length);
    for (let i = 0; i < this.vertices.length; i++) pool[i] = new Vec3();

    const cb = new Vec3();
    const ab = new Vec3();
    const faceNormal = new Vec3();

    for (const face of this.faces) {
      const corners = face.getIndices();
      const vA = this.vertices[face.a];
      const vB = this.vertices[face.b];
      const vC = this.vertices[face.c];
      if (!vA || !vB || !vC) continue;

      if (areaWeighted) {
        cb.subVectors(vC, vB);
        ab.subVectors(vA, vB);
        cb.cross(ab);
      } else {
        cb.subVectors(vC, vB);
        ab.subVectors(vA, vB);
        cb.cross(ab).normalize();
      }

      for (const corner of corners) {
        const target = pool[corner];
        if (target) target.add(cb);
      }

      if (face.vertexNormals.length !== corners.length) {
        face.vertexNormals = corners.map(() => new Vec3());
      }
      faceNormal.copy(cb).normalize();
      for (let i = 0; i < corners.length; i++) face.vertexNormals[i].copy(faceNormal);
    }

    this.normals = pool;
    this.normalsNeedUpdate = true;
    return this;
  }

  /** Fits {@link boundingBox} around the vertex pool. */
  public computeBoundingBox(): this {
    if (!this.boundingBox) this.boundingBox = new Box3();
    this.boundingBox.setFromPoints(this.vertices);
    return this;
  }

  /**
   * Fits {@link boundingSphere} around the vertex pool.
   *
   * The centre is the centre of {@link boundingBox} and the radius is the
   * farthest vertex distance 閳?the standard conservative cheap fit.
   */
  public computeBoundingSphere(): this {
    if (!this.boundingSphere) this.boundingSphere = new Sphere();
    const sphere = this.boundingSphere;
    if (!this.boundingBox) this.computeBoundingBox();
    const box = this.boundingBox;
    if (!box || box.isEmpty()) {
      sphere.makeEmpty();
      return this;
    }
    box.getCenter(sphere.center);
    let maxRadiusSquared = 0;
    for (const vertex of this.vertices) {
      const distanceSquared = vertex.distanceToSquared(sphere.center);
      if (distanceSquared > maxRadiusSquared) maxRadiusSquared = distanceSquared;
    }
    sphere.radius = Math.sqrt(maxRadiusSquared);
    return this;
  }

  /* ------------------------------------------------------------ transforms */

  /** Applies a column-major 4x4 matrix to every vertex, normal and bounding volume. */
  public applyMat4(m: Mat4): this {
    for (const vertex of this.vertices) vertex.applyMat4(m);
    for (const normal of this.normals) normal.applyMat4(m);
    for (const face of this.faces) {
      face.normal.applyMat4(m);
      for (const normal of face.vertexNormals) normal.applyMat4(m);
    }
    if (this.boundingBox) this.boundingBox.applyMat4(m);
    if (this.boundingSphere) this.boundingSphere.applyMat4(m);
    this.verticesNeedUpdate = true;
    this.normalsNeedUpdate = true;
    return this;
  }

  /** Moves every vertex so the bounding box centre sits at the origin. */
  public center(): this {
    if (!this.boundingBox) this.computeBoundingBox();
    const box = this.boundingBox;
    if (!box || box.isEmpty()) return this;
    const offset = box.getCenter(new Vec3()).negate();
    for (const vertex of this.vertices) vertex.add(offset);
    this.verticesNeedUpdate = true;
    return this;
  }

  /* ---------------------------------------------------------------- merging */

  /**
   * Merges `source` into this geometry, optionally transformed.
   *
   * @param source Geometry to append.
   * @param matrix Optional matrix applied to the appended vertices and normals.
   * @param materialIndexOffset Added to every appended face's material index.
   */
  public merge(source: Geometry, matrix?: Mat4, materialIndexOffset: number = 0): this {
    const vertexOffset = this.vertices.length;
    for (const vertex of source.vertices) {
      const copy = vertex.clone();
      if (matrix) copy.applyMat4(matrix);
      this.vertices.push(copy);
    }
    for (const color of source.colors) this.colors.push(color.clone());
    for (const normal of source.normals) {
      const copy = normal.clone();
      if (matrix) copy.applyMat4(matrix);
      this.normals.push(copy);
    }
    for (let channel = 0; channel < source.uvs.length; channel++) {
      const list = this.ensureUvChannel(channel);
      for (let i = 0; i < vertexOffset; i++) {
        if (!list[i]) list[i] = new Vec2();
      }
      for (let i = 0; i < source.uvs[channel].length; i++) {
        const uv = source.uvs[channel][i];
        list[vertexOffset + i] = uv ? uv.clone() : new Vec2();
      }
    }
    for (const face of source.faces) {
      const copy = face.clone();
      copy.a += vertexOffset;
      copy.b += vertexOffset;
      copy.c += vertexOffset;
      if (copy.d >= 0) copy.d += vertexOffset;
      copy.materialIndex += materialIndexOffset;
      this.faces.push(copy);
    }
    this.verticesNeedUpdate = true;
    this.normalsNeedUpdate = true;
    this.uvsNeedUpdate = true;
    this.elementsNeedUpdate = true;
    this.boundingBox = null;
    this.boundingSphere = null;
    return this;
  }

  /**
   * Welds vertices that coincide within `precision` decimal places.
   *
   * Faces are rewritten to reference the surviving vertex. Attributes are kept
   * from the first occurrence of each welded vertex. This is what makes
   * {@link computeVertexNormals} produce smooth shading on imported meshes that
   * duplicated their corners.
   *
   * @param precision Decimal places used to build the weld key.
   * @returns `this`, so calls chain.
   */
  public mergeVertices(precision: number = 4): this {
    const factor = Math.pow(10, precision);
    const keyOf = (v: Vec3): string =>
      `${Math.round(v.x * factor)}|${Math.round(v.y * factor)}|${Math.round(v.z * factor)}`;

    const unique: Vec3[] = [];
    const uniqueNormals: Vec3[] = [];
    const uniqueColors: Color[] = [];
    const uniqueUvs: Vec2[][] = this.uvs.map(() => []);
    const lookup = new Map<string, number>();
    const remap: number[] = new Array(this.vertices.length);

    for (let i = 0; i < this.vertices.length; i++) {
      const key = keyOf(this.vertices[i]);
      const existing = lookup.get(key);
      if (existing !== undefined) {
        remap[i] = existing;
        continue;
      }
      const index = unique.length;
      lookup.set(key, index);
      remap[i] = index;
      unique.push(this.vertices[i]);
      if (this.normals[i]) uniqueNormals[index] = this.normals[i];
      if (this.colors[i]) uniqueColors[index] = this.colors[i];
      uniqueUvs.forEach((list, channel) => {
        const source = this.uvs[channel]?.[i];
        if (source) list[index] = source;
      });
    }

    for (const face of this.faces) {
      face.a = remap[face.a] ?? face.a;
      face.b = remap[face.b] ?? face.b;
      face.c = remap[face.c] ?? face.c;
      if (face.d >= 0) face.d = remap[face.d] ?? face.d;
    }

    this.vertices = unique;
    this.normals = uniqueNormals;
    this.colors = uniqueColors;
    this.uvs = uniqueUvs;
    this.verticesNeedUpdate = true;
    this.elementsNeedUpdate = true;
    return this;
  }

  /* ------------------------------------------------------------- conversion */

  /**
   * Converts to a non-indexed `BufferGeometry`.
   *
   * Every face corner becomes its own vertex, because a face corner can carry a
   * per-corner normal, colour and uv that do not agree with the shared vertex
   * pool. Quads are split into two triangles `(a, b, c)` and `(a, c, d)`.
   *
   * The produced attributes are:
   *  - `position` (`itemSize` 3) 閳?always present;
   *  - `normal` (3) 閳?when {@link normals} or a face normal is available;
   *  - `color` (3) 閳?when {@link colors} or a face colour is available;
   *  - `uv` (2) 閳?when {@link uvs} has a channel `0`;
   *  - `uv1`, `uv2`, ... (2) 閳?additional uv channels.
   *
   * @returns A new, independent `BufferGeometry`. This geometry is not modified
   *   and is not owned by the result.
   */
  public toBufferGeometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.name = this.name;

    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const uvs: number[][] = this.uvs.map(() => []);
    // A fresh `Color` is the "no colour was authored" sentinel: a face whose
    // colour still matches it must not force a colour attribute into existence.
    const defaultColor = new Color();
    let hasNormals = this.normals.length > 0;
    let hasColors = this.colors.length > 0;
    for (const face of this.faces) {
      if (face.vertexNormals.length > 0 || face.normal.lengthSquared() > 0) hasNormals = true;
      if (face.vertexColors.length > 0 || !face.color.equals(defaultColor, 1e-6)) hasColors = true;
    }
    const materialIndices: number[] = [];

    const pushCorner = (vertexIndex: number, face: Face, corner: number, normal: Vec3): void => {
      const vertex = this.vertices[vertexIndex];
      if (!vertex) return;
      positions.push(vertex.x, vertex.y, vertex.z);

      const vertexNormal = this.normals[vertexIndex];
      const cornerNormal = face.vertexNormals[corner];
      const chosenNormal = cornerNormal ?? vertexNormal ?? normal;
      normals.push(chosenNormal.x, chosenNormal.y, chosenNormal.z);

      const vertexColor = this.colors[vertexIndex];
      const cornerColor = face.vertexColors[corner];
      const chosenColor = cornerColor ?? vertexColor ?? face.color;
      colors.push(chosenColor.r, chosenColor.g, chosenColor.b);

      for (let channel = 0; channel < this.uvs.length; channel++) {
        const uv = this.uvs[channel]?.[vertexIndex];
        uvs[channel].push(uv ? uv.x : 0, uv ? uv.y : 0);
      }
    };

    for (const face of this.faces) {
      const corners = face.getIndices();
      // Triangulate the polygon as a fan around its first corner.
      for (let i = 1; i + 1 < corners.length; i++) {
        pushCorner(face.a, face, 0, face.normal);
        pushCorner(corners[i], face, i, face.normal);
        pushCorner(corners[i + 1], face, i + 1, face.normal);
        materialIndices.push(face.materialIndex);
      }
    }

    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3, false, 'static', 'position'));
    if (hasNormals) {
      geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3, false, 'static', 'normal'));
    }
    if (hasColors) {
      geometry.setAttribute('color', new Float32BufferAttribute(colors, 3, false, 'static', 'color'));
    }
    for (let channel = 0; channel < uvs.length; channel++) {
      const name = channel === 0 ? 'uv' : `uv${channel}`;
      geometry.setAttribute(name, new Float32BufferAttribute(uvs[channel], 2, false, 'static', name));
    }

    // One group per contiguous run sharing a material index.
    let runStart = 0;
    let runMaterial = materialIndices[0] ?? 0;
    for (let i = 1; i <= materialIndices.length; i++) {
      if (i === materialIndices.length || materialIndices[i] !== runMaterial) {
        geometry.addGroup(runStart * 3, (i - runStart) * 3, runMaterial);
        runStart = i;
        runMaterial = materialIndices[i] ?? 0;
      }
    }

    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  /* ------------------------------------------------------------------ copies */

  /** Deep-copies vertices, attributes, faces and user data from `source`. */
  public copy(source: Geometry): this {
    this.name = source.name;
    this.type = source.type;
    this.userData = { ...source.userData };
    this.vertices = source.vertices.map((vertex) => vertex.clone());
    this.colors = source.colors.map((color) => color.clone());
    this.normals = source.normals.map((normal) => normal.clone());
    this.uvs = source.uvs.map((list) => list.map((uv) => uv.clone()));
    this.faces = source.faces.map((face) => face.clone());
    this.boundingBox = source.boundingBox ? source.boundingBox.clone() : null;
    this.boundingSphere = source.boundingSphere ? source.boundingSphere.clone() : null;
    this.verticesNeedUpdate = source.verticesNeedUpdate;
    this.normalsNeedUpdate = source.normalsNeedUpdate;
    this.uvsNeedUpdate = source.uvsNeedUpdate;
    this.elementsNeedUpdate = source.elementsNeedUpdate;
    return this;
  }

  /** Returns an independent copy of this geometry. */
  public clone(): Geometry {
    return new Geometry().copy(this);
  }

  /* ------------------------------------------------------------------ output */

  /** Serialises the geometry; round-trips through {@link Geometry.fromJSON}. */
  public toJSON(): GeometryJSON {
    const vertices: number[] = [];
    for (const vertex of this.vertices) vertices.push(vertex.x, vertex.y, vertex.z);

    const colors: number[] = [];
    for (const color of this.colors) colors.push(color.r, color.g, color.b);

    const normals: number[] = [];
    for (const normal of this.normals) normals.push(normal.x, normal.y, normal.z);

    const uvs = this.uvs.map((list) => {
      const flat: number[] = [];
      for (const uv of list) flat.push(uv.x, uv.y);
      return flat;
    });

    return {
      type: 'Geometry',
      name: this.name,
      vertices,
      colors,
      normals,
      uvs,
      faces: this.faces.map((face) => face.toJSON()),
      userData: { ...this.userData },
    };
  }

  /** Rebuilds a geometry from {@link Geometry.toJSON} output. */
  public static fromJSON(json: GeometryJSON): Geometry {
    const geometry = new Geometry();
    geometry.name = json.name ?? '';
    geometry.userData = { ...(json.userData ?? {}) };

    for (let i = 0; i + 2 < json.vertices.length; i += 3) {
      geometry.vertices.push(new Vec3(json.vertices[i], json.vertices[i + 1], json.vertices[i + 2]));
    }
    for (let i = 0; i + 2 < json.colors.length; i += 3) {
      geometry.colors.push(new Color(json.colors[i], json.colors[i + 1], json.colors[i + 2]));
    }
    for (let i = 0; i + 2 < json.normals.length; i += 3) {
      geometry.normals.push(new Vec3(json.normals[i], json.normals[i + 1], json.normals[i + 2]));
    }
    geometry.uvs = (json.uvs ?? []).map((flat) => {
      const list: Vec2[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) list.push(new Vec2(flat[i], flat[i + 1]));
      return list;
    });
    geometry.faces = (json.faces ?? []).map((faceJSON) => Face.fromJSON(faceJSON));
    return geometry;
  }

  /** `"Geometry(name=mesh, vertices=8, faces=12)"`. */
  public override toString(): string {
    return `Geometry(name=${this.name || 'unnamed'}, vertices=${this.vertices.length}, faces=${this.faces.length})`;
  }
}
