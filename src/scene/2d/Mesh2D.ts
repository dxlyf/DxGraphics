/**
 * `Mesh2D` - a 2D node driven by a `BufferGeometry`.
 *
 * `Mesh2D` is the escape hatch for content a sprite or a shape cannot express:
 * custom UV-mapped quads, text baked into a mesh, or geometry produced by a path
 * tessellator. The geometry is typed structurally (see
 * {@link Mesh2DGeometryLike}) because `src/geometry` is written by another agent;
 * this node only reads the attributes it needs for bounds and diagnostics.
 *
 * @packageDocumentation
 */

import { Rect } from '../../math/Rect';
import { Node2D } from './Node2D';
import type { Material2DLike, Node2DOptions } from './types';

/** Structural view of a GPU vertex attribute. */
export interface Mesh2DAttributeLike {
  /** Flat backing storage. */
  readonly array: ArrayLike<number>;
  /** Components per element (2 for a 2D position, 3 for a 3D one). */
  readonly itemSize: number;
  /** Number of elements, when the attribute reports it. */
  readonly count?: number;
}

/** Structural view of the geometry a `Mesh2D` draws. */
export interface Mesh2DGeometryLike {
  /** Dictionary of vertex attributes (`'position'`, `'uv'`, ...). */
  readonly attributes: Record<string, Mesh2DAttributeLike | undefined>;
  /** Index buffer, when the geometry is indexed. */
  readonly index?: Mesh2DAttributeLike | ArrayLike<number> | null;
  /** Optional display name. */
  readonly name?: string;
  /** Releases GPU-side resources. */
  dispose?(): void;
}

/** Options accepted by the {@link Mesh2D} constructor. */
export interface Mesh2DOptions extends Node2DOptions {
  /** Geometry drawn by the node. */
  geometry?: Mesh2DGeometryLike | null;
  /** Material (or material list) used to shade it. */
  material?: Material2DLike | readonly Material2DLike[] | null;
}

/** A node that draws an arbitrary `BufferGeometry` in a 2D scene. */
export class Mesh2D extends Node2D {
  /** Allows consumers to detect the class without an `instanceof` check. */
  public readonly isMesh2D: true = true;

  /** Class name used by serialisation and the backend's dispatch. */
  public override readonly type: string = 'Mesh2D';

  /** Geometry drawn by this node. */
  public geometry: Mesh2DGeometryLike | null;

  /** Material, or one material per geometry group. */
  public material: Material2DLike | readonly Material2DLike[] | null;

  /** `true` while the geometry changed and the backend must re-upload. */
  public needsUpdate = false;

  /** Creates a mesh node. */
  constructor(options: Mesh2DOptions = {}) {
    super(options);
    this.geometry = options.geometry ?? null;
    this.material = options.material ?? null;
    if (!this.bounds && this.geometry) this.bounds = this.computeGeometryBounds();
  }

  /** Replaces the geometry and, by default, refreshes the cached bounds. */
  public setGeometry(geometry: Mesh2DGeometryLike | null, refreshBounds = true): this {
    this.geometry = geometry;
    this.needsUpdate = true;
    if (refreshBounds && geometry) this.setBounds(this.computeGeometryBounds());
    return this;
  }

  /** Replaces the material(s) and flags the backend cache. */
  public setMaterial(material: Material2DLike | readonly Material2DLike[] | null): this {
    this.material = material;
    this.needsUpdate = true;
    return this;
  }

  /** Returns the material at `index` (`0` for a single-material mesh). */
  public getMaterialAt(index = 0): Material2DLike | undefined {
    const material = this.material;
    if (!material) return undefined;
    if (Array.isArray(material)) return (material as readonly Material2DLike[])[index];
    return index === 0 ? (material as Material2DLike) : undefined;
  }

  /** Number of triangles in the geometry. */
  public getTriangleCount(): number {
    const geometry = this.geometry;
    const position = geometry?.attributes.position;
    if (!geometry || !position) return 0;
    const index = geometry.index;
    if (index) {
      const array: ArrayLike<number> =
        (index as Mesh2DAttributeLike).array ?? (index as ArrayLike<number>);
      return Math.floor(array.length / 3);
    }
    const stride = Math.max(2, position.itemSize);
    const count = position.count ?? Math.floor(position.array.length / stride);
    return Math.floor(count / 3);
  }

  /**
   * Computes the local bounds of the geometry's `position` attribute.
   *
   * The bounds are expressed in the geometry's own coordinates, which is what a
   * renderer expects: the node's transform positions the geometry as authored.
   *
   * @returns The bounds; a zero-sized rectangle when there is no position data.
   */
  public computeGeometryBounds(): Rect {
    const position = this.geometry?.attributes.position;
    if (!position) return new Rect(0, 0, 0, 0);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const stride = Math.max(2, position.itemSize);
    const count = position.count ?? Math.floor(position.array.length / stride);
    for (let i = 0; i < count; i++) {
      const x = position.array[i * stride] ?? 0;
      const y = position.array[i * stride + 1] ?? 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return new Rect(0, 0, 0, 0);
    return new Rect(minX, minY, maxX - minX, maxY - minY);
  }

  /** Copies the geometry reference and material of `source`. */
  public override copy(source: Node2D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof Mesh2D) {
      this.geometry = source.geometry;
      this.material = source.material;
      this.needsUpdate = true;
    }
    return this;
  }

  /** Serialises the mesh alongside the node data. */
  public override toJSON(recursive = true): ReturnType<Node2D['toJSON']> {
    const json = super.toJSON(recursive);
    json.triangleCount = this.getTriangleCount();
    return json;
  }

  /** Returns a new mesh node sharing the same geometry. */
  public override clone(recursive = true): Mesh2D {
    const clone = new Mesh2D();
    clone.geometry = this.geometry;
    clone.material = this.material;
    clone.copy(this, recursive);
    return clone;
  }

  /** Creates an empty `Mesh2D`, used by `clone()`. */
  protected override createInstance(): Node2D {
    return new Mesh2D();
  }
}
