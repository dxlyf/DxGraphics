/**
 * `Shape` — a closed outline with optional holes.
 *
 * A shape is a {@link Path} that knows how to describe itself as a filled
 * surface: {@link Shape.extractPoints} flattens the outline and every hole, and
 * {@link Shape.triangulate} turns that into triangles, bridging each hole into
 * the outline.
 *
 * ## Limitation
 *
 * `triangulate()` is correct only for a **simple** outline — one that does not
 * cross itself. Holes *are* supported (`triangulateShape` bridges them), but a
 * self-intersecting outline is not repaired: run `BooleanOps.isSimplePolygon`
 * first when the input is untrusted, since ear clipping on a self-intersecting
 * contour produces overlapping triangles rather than an error.
 *
 * ```ts
 * const shape = new Shape();
 * shape.absarc(0, 0, 1, 0, Math.PI * 2, false);
 * shape.closePath();
 * const { vertices, indices, uvs } = shape.triangulate(64);
 * ```
 *
 * @packageDocumentation
 */

import { DEFAULT_CURVE_DIVISIONS } from '../../constants';
import { Vec2 } from '../../math/Vec2';
import { BufferGeometry } from '../core/BufferGeometry';
import { Float32BufferAttribute } from '../core/BufferAttribute';
import { Path, curveFromJSON } from './Path';
import { triangulateShape } from './Triangulate';
import type { CurveType, ShapeJSON, TriangulationResult } from './types';

/** Flattened outline plus its holes. */
export interface ShapePoints {
  /** Outline samples, closed by construction or by the sampling. */
  shape: Vec2[];
  /** One sample list per hole. */
  holes: Vec2[][];
}

/** A closed outline with optional holes. */
export class Shape extends Path {
  /** Discriminator. */
  public override readonly type: CurveType = 'Shape';

  /** Structural marker. */
  public readonly isShape = true;

  /** The hole outlines, each an independent closed path. */
  public holes: Path[];

  /**
   * Creates a shape, optionally from an outline point list.
   *
   * @param points When given, the outline becomes a polyline through them.
   */
  constructor(points?: Vec2[]) {
    super(points);
    this.holes = [];
  }

  /* -------------------------------------------------------------- sampling */

  /**
   * Flattens the outline and every hole.
   *
   * @param divisions Resolution hint passed to `getPoints`.
   */
  public extractPoints(divisions: number): ShapePoints {
    return {
      shape: this.getPoints(divisions),
      holes: this.getPointsHoles(divisions),
    };
  }

  /**
   * Flattens every hole.
   *
   * @param divisions Resolution hint.
   */
  public getPointsHoles(divisions: number): Vec2[][] {
    return this.holes.map((hole) => hole.getPoints(divisions));
  }

  /**
   * Flattens the shape into `[outline, ...holes]`.
   *
   * @param divisions Resolution hint.
   */
  public extractPointsAsVector2(divisions: number): Vec2[][] {
    const points = this.extractPoints(divisions);
    return [points.shape, ...points.holes];
  }

  /* --------------------------------------------------------- triangulation */

  /**
   * Triangulates the shape into flat vertex, index and uv arrays.
   *
   * **The outline must be simple** (non-self-intersecting); holes are handled by
   * bridging, but a self-intersecting outline is not repaired and will yield
   * overlapping triangles rather than an error. Validate untrusted input with
   * `BooleanOps.isSimplePolygon` first.
   *
   * @param divisions Resolution hint; higher values follow curves more closely.
   * @throws Error when a hole cannot be bridged into the outline.
   */
  public triangulate(divisions: number = DEFAULT_CURVE_DIVISIONS): TriangulationResult {
    const points = this.extractPoints(divisions);
    return triangulateShape(points.shape, points.holes);
  }

  /**
   * Builds a triangulated `BufferGeometry` with `position`, `uv` and an index.
   *
   * This overrides the line-list conversion inherited from {@link Path}: a shape
   * is a surface, so it triangulates rather than emitting a polyline. Normals
   * are computed only when the triangulation produced any triangle.
   *
   * @param divisions Resolution hint.
   */
  public override toBufferGeometry(divisions: number = DEFAULT_CURVE_DIVISIONS): BufferGeometry {
    const result = this.triangulate(divisions);
    const geometry = new BufferGeometry();
    geometry.name = this.type;

    const vertexCount = Math.floor(result.vertices.length / 2);
    const positions = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      positions[i * 3] = result.vertices[i * 2];
      positions[i * 3 + 1] = result.vertices[i * 2 + 1];
      positions[i * 3 + 2] = 0;
    }

    geometry.setAttribute(
      'position',
      new Float32BufferAttribute(positions, 3, false, 'static', 'position'),
    );
    geometry.setAttribute(
      'uv',
      new Float32BufferAttribute(result.uvs, 2, false, 'static', 'uv'),
    );
    geometry.setIndex(result.indices);

    if (result.indices.length > 0) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  /* ----------------------------------------------------------------- copies */

  /** Deep-copies the outline and every hole from `source`. */
  public override copy(source: Shape): this {
    super.copy(source);
    this.holes = source.holes.map((hole) => hole.clone());
    return this;
  }

  /** Returns an independent copy of this shape. */
  public override clone(): Shape {
    return new Shape().copy(this);
  }

  /* ---------------------------------------------------------------- output */

  /** Serialises the shape; round-trips through {@link Shape.fromJSON}. */
  public override toJSON(): ShapeJSON {
    return {
      type: 'Shape',
      arcLengthDivisions: this.arcLengthDivisions,
      curves: this.curves.map((curve) => curve.toJSON()),
      currentPoint: [this.currentPoint.x, this.currentPoint.y],
      autoClose: this.autoClose,
      holes: this.holes.map((hole) => hole.toJSON()),
    };
  }

  /** Rebuilds a shape from {@link Shape.toJSON} output. */
  public static override fromJSON(json: ShapeJSON): Shape {
    const shape = new Shape();
    shape.curves = (json.curves ?? []).map((curveJSON) => curveFromJSON(curveJSON));
    const current = json.currentPoint;
    shape.currentPoint.set(Number(current?.[0] ?? 0), Number(current?.[1] ?? 0));
    shape.autoClose = json.autoClose === true;
    if (typeof json.arcLengthDivisions === 'number') {
      shape.arcLengthDivisions = json.arcLengthDivisions;
    }
    shape.holes = (json.holes ?? []).map((holeJSON) => Path.fromJSON(holeJSON));
    shape.updateArcLengths();
    return shape;
  }
}
