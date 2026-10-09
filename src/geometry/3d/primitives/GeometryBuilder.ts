/**
 * `GeometryBuilder` — a small growable scratch buffer for the generators.
 *
 * Every generator in `geometry/3d/primitives` has the same shape: walk a parameter
 * grid, push a position/normal/uv per vertex, push three indices per triangle,
 * then hand the buffers to a `BufferGeometry`. Doing that with plain arrays and
 * `push` is simple but slow and hard to read; doing it with pre-sized typed arrays
 * requires knowing the vertex count up front, which most generators do but the
 * polyhedron subdivision does not.
 *
 * This builder is the middle ground: typed arrays that double when full, plus
 * `pushVertex`/`pushTriangle` so a generator reads like the maths it implements.
 *
 * ```ts
 * const builder = new GeometryBuilder();
 * for (let iy = 0; iy <= heightSegments; iy++) {
 *   for (let ix = 0; ix <= widthSegments; ix++) {
 *     builder.pushVertex(x, y, z, nx, ny, nz, u, v);
 *   }
 * }
 * builder.pushTriangle(a, b, c);
 * const geometry = builder.build();
 * ```
 *
 * @packageDocumentation
 */

import { Float32BufferAttribute, Uint32BufferAttribute } from '../../core/BufferAttribute';
import { BufferGeometry } from '../../core/BufferGeometry';
import { correctWinding } from '../utils/correctWinding';
import { computeBoundingBox } from '../utils/computeBoundingBox';
import { computeBoundingSphere } from '../utils/computeBoundingSphere';

/** Which optional attribute streams a builder should collect. */
export interface GeometryBuilderOptions {
  /** Collect `normal` data. @default true */
  normals?: boolean;
  /** Collect `uv` data. @default true */
  uv?: boolean;
  /** Collect `tangent` data (`xyzw`). @default false */
  tangents?: boolean;
  /** Collect `color` data (`rgba`). @default false */
  colors?: boolean;
  /** Initial capacity in vertices; grows automatically. @default 256 */
  initialCapacity?: number;
  /** Emit an index buffer. @default true */
  indexed?: boolean;
  /** Debug name for the produced geometry. */
  name?: string;
  /**
   * Re-derive the triangle winding from the vertex normals in {@link GeometryBuilder.build}.
   *
   * On by default. The pass is what makes each generator's incidental handedness
   * irrelevant: whether `v` runs up or down, or whether the `(u, v)` frame agrees
   * with the outward normal, is a per-generator detail that is easy to get
   * backwards and invisible with culling disabled. See `correctWinding`.
   *
   * @default true
   */
  correctWinding?: boolean;
}

/**
 * A growable vertex/index accumulator for geometry generation.
 */
export class GeometryBuilder {
  /** Positions, three floats per vertex. */
  public positions: Float32Array;

  /** Normals, three floats per vertex; `null` when not collected. */
  public normals: Float32Array | null;

  /** UVs, two floats per vertex; `null` when not collected. */
  public uvs: Float32Array | null;

  /** Tangents, four floats per vertex; `null` when not collected. */
  public tangents: Float32Array | null;

  /** Colours, four floats per vertex; `null` when not collected. */
  public colors: Float32Array | null;

  /** Triangle indices, three per triangle. */
  public indices: Uint32Array | null;

  /** Number of vertices written. */
  public vertexCount = 0;

  /** Number of indices written. */
  public indexCount = 0;

  /** `true` when an index buffer is being collected. */
  public readonly indexed: boolean;

  /** Debug name applied to the result. */
  public readonly name: string | undefined;

  /** Whether {@link GeometryBuilder.build} re-derives the winding. */
  public readonly correctWindingOnBuild: boolean;

  /**
   * Creates a builder.
   *
   * @param options See {@link GeometryBuilderOptions}.
   */
  constructor(options: GeometryBuilderOptions = {}) {
    const capacity = Math.max(4, options.initialCapacity ?? 256);
    this.positions = new Float32Array(capacity * 3);
    this.normals = (options.normals ?? true) ? new Float32Array(capacity * 3) : null;
    this.uvs = (options.uv ?? true) ? new Float32Array(capacity * 2) : null;
    this.tangents = options.tangents ? new Float32Array(capacity * 4) : null;
    this.colors = options.colors ? new Float32Array(capacity * 4) : null;
    this.indexed = options.indexed ?? true;
    this.indices = this.indexed ? new Uint32Array(capacity * 3) : null;
    this.name = options.name;
    this.correctWindingOnBuild = options.correctWinding ?? true;
  }

  /* -------------------------------------------------------------- capacity */

  /**
   * Ensures room for `additional` more vertices.
   *
   * @param additional Vertices about to be written.
   */
  public ensureVertexCapacity(additional: number): void {
    const required = this.vertexCount + additional;
    if (required * 3 <= this.positions.length) return;

    const capacity = Math.max(required, Math.floor(this.positions.length / 3) * 2);
    this.positions = grow(this.positions, capacity * 3);
    if (this.normals) this.normals = grow(this.normals, capacity * 3);
    if (this.uvs) this.uvs = grow(this.uvs, capacity * 2);
    if (this.tangents) this.tangents = grow(this.tangents, capacity * 4);
    if (this.colors) this.colors = grow(this.colors, capacity * 4);
    if (this.indices) this.indices = grow(this.indices, capacity * 3);
  }

  /* -------------------------------------------------------------- vertices */

  /**
   * Appends a vertex.
   *
   * @param x Position x.
   * @param y Position y.
   * @param z Position z.
   * @param nx Normal x.
   * @param ny Normal y.
   * @param nz Normal z.
   * @param u Texture u.
   * @param v Texture v.
   * @param r Colour red.
   * @param g Colour green.
   * @param b Colour blue.
   * @param a Colour alpha.
   * @returns The index of the new vertex.
   */
  public pushVertex(
    x: number,
    y: number,
    z: number,
    nx = 0,
    ny = 0,
    nz = 1,
    u = 0,
    v = 0,
    r = 1,
    g = 1,
    b = 1,
    a = 1,
  ): number {
    this.ensureVertexCapacity(1);
    const index = this.vertexCount++;

    const p = index * 3;
    this.positions[p] = x;
    this.positions[p + 1] = y;
    this.positions[p + 2] = z;

    if (this.normals) {
      this.normals[p] = nx;
      this.normals[p + 1] = ny;
      this.normals[p + 2] = nz;
    }
    if (this.uvs) {
      this.uvs[index * 2] = u;
      this.uvs[index * 2 + 1] = v;
    }
    if (this.tangents) {
      const t = index * 4;
      this.tangents[t] = 1;
      this.tangents[t + 1] = 0;
      this.tangents[t + 2] = 0;
      this.tangents[t + 3] = 1;
    }
    if (this.colors) {
      const c = index * 4;
      this.colors[c] = r;
      this.colors[c + 1] = g;
      this.colors[c + 2] = b;
      this.colors[c + 3] = a;
    }
    return index;
  }

  /**
   * Overwrites the normal of an existing vertex.
   *
   * Generators that accumulate normals (a sphere's caps, a tube's seam) need to
   * fix up a vertex after the fact.
   *
   * @param vertex Vertex index.
   * @param nx Normal x.
   * @param ny Normal y.
   * @param nz Normal z.
   */
  public setNormal(vertex: number, nx: number, ny: number, nz: number): void {
    if (!this.normals) return;
    const p = vertex * 3;
    this.normals[p] = nx;
    this.normals[p + 1] = ny;
    this.normals[p + 2] = nz;
  }

  /**
   * Overwrites the position of an existing vertex.
   *
   * @param vertex Vertex index.
   * @param x Position x.
   * @param y Position y.
   * @param z Position z.
   */
  public setPosition(vertex: number, x: number, y: number, z: number): void {
    const p = vertex * 3;
    this.positions[p] = x;
    this.positions[p + 1] = y;
    this.positions[p + 2] = z;
  }

  /* ------------------------------------------------------------- triangles */

  /**
   * Appends a triangle.
   *
   * @param a First vertex index.
   * @param b Second vertex index.
   * @param c Third vertex index.
   */
  public pushTriangle(a: number, b: number, c: number): void {
    if (!this.indices) return;
    if ((this.indexCount + 3) * 1 > this.indices.length) {
      this.indices = grow(this.indices, this.indices.length * 2);
    }
    this.indices[this.indexCount++] = a;
    this.indices[this.indexCount++] = b;
    this.indices[this.indexCount++] = c;
  }

  /**
   * Appends a quad as two triangles.
   *
   * @param a First corner.
   * @param b Second corner.
   * @param c Third corner.
   * @param d Fourth corner.
   */
  public pushQuad(a: number, b: number, c: number, d: number): void {
    this.pushTriangle(a, b, d);
    this.pushTriangle(b, c, d);
  }

  /* ---------------------------------------------------------------- output */

  /**
   * Materialises the accumulated data as a `BufferGeometry`.
   *
   * The buffers are sliced to their exact size, so the returned geometry does not
   * retain the builder's spare capacity. For a non-indexed build the positions are
   * returned as-is: callers that requested `indexed: false` are expected to have
   * pushed unique vertices per corner.
   *
   * @param computeBounds Compute the bounding box and sphere. @default true
   * @returns The finished geometry.
   */
  public build(computeBounds: boolean = true): BufferGeometry {
    const geometry = new BufferGeometry();
    if (this.name !== undefined) geometry.name = this.name;

    geometry.setAttribute(
      'position',
      new Float32BufferAttribute(this.positions.subarray(0, this.vertexCount * 3), 3, false, 'static', 'position'),
    );
    if (this.normals) {
      geometry.setAttribute(
        'normal',
        new Float32BufferAttribute(this.normals.subarray(0, this.vertexCount * 3), 3, false, 'static', 'normal'),
      );
    }
    if (this.uvs) {
      geometry.setAttribute(
        'uv',
        new Float32BufferAttribute(this.uvs.subarray(0, this.vertexCount * 2), 2, false, 'static', 'uv'),
      );
    }
    if (this.tangents) {
      geometry.setAttribute(
        'tangent',
        new Float32BufferAttribute(this.tangents.subarray(0, this.vertexCount * 4), 4, false, 'static', 'tangent'),
      );
    }
    if (this.colors) {
      geometry.setAttribute(
        'color',
        new Float32BufferAttribute(this.colors.subarray(0, this.vertexCount * 4), 4, false, 'static', 'color'),
      );
    }
    if (this.indices && this.indexCount > 0) {
      geometry.setIndex(new Uint32BufferAttribute(this.indices.subarray(0, this.indexCount), 1));
    }

    // Re-derive the winding from the vertex normals before the bounds are computed,
    // so a generator cannot ship an inside-out mesh. See `correctWinding` for why
    // the vertex normal, rather than the face centroid, is the right reference.
    if (this.correctWindingOnBuild) correctWinding(geometry);

    if (computeBounds) {
      computeBoundingBox(geometry);
      computeBoundingSphere(geometry);
    }
    return geometry;
  }

  /** Discards everything, keeping the allocated capacity. */
  public reset(): this {
    this.vertexCount = 0;
    this.indexCount = 0;
    return this;
  }
}

/**
 * Doubles a typed array, preserving its contents.
 *
 * @param array Source array.
 * @param length Requested minimum length.
 * @returns A larger array of the same element type.
 */
function grow<T extends Float32Array | Uint32Array>(array: T, length: number): T {
  const Type = array.constructor as new (length: number) => T;
  const next = new Type(Math.max(length, array.length * 2));
  next.set(array);
  return next;
}

/**
 * Returns a `[0, 1]` UV pair for an index on a grid of `segments` cells.
 *
 * The default mapping the generators use: `u` runs left to right and `v` runs
 * **bottom to top**, matching how WebGL samples a texture whose origin is the
 * bottom-left corner.
 *
 * @param ix Column index.
 * @param iy Row index.
 * @param widthSegments Columns.
 * @param heightSegments Rows.
 * @returns The UV pair.
 */
export function gridUv(
  ix: number,
  iy: number,
  widthSegments: number,
  heightSegments: number,
): [number, number] {
  return [ix / widthSegments, 1 - iy / heightSegments];
}
