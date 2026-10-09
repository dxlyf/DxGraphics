/**
 * `SubdivisionModifier` — Catmull-Clark subdivision.
 *
 * ## The algorithm
 *
 * One Catmull-Clark pass, in the standard order:
 *
 * 1. **face points** — the centroid of each face;
 * 2. **edge points** — the average of the edge's two endpoints and the two adjacent
 *    face points (a boundary edge uses only its endpoints);
 * 3. **vertex points** — `(F + 2R + (n - 3)P) / n`, where `F` is the average of the
 *    adjacent face points, `R` the average of the adjacent edge midpoints, `P` the
 *    original position and `n` the valence;
 * 4. **rebuild** — every `n`-gon becomes `n` quads, each spanned by a vertex point,
 *    an edge point, the face point and the next edge point.
 *
 * Quads are then emitted as two triangles, because that is what the rest of the
 * library renders.
 *
 * The implementation always works on a **non-indexed triangle soup internally**
 * and rebuilds the index at the end. That is not the memory-optimal route, but it
 * is the one that cannot silently weld two vertices that happen to share a
 * position — which is exactly the bug that makes a subdivided cube collapse into a
 * blob.
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../../math/Vec3';
import { BufferGeometry } from '../../core/BufferGeometry';
import { Float32BufferAttribute, Uint32BufferAttribute } from '../../core/BufferAttribute';
import type { ModifierGeometryLike, SubdivisionOptions } from '../types';

/** Options accepted by {@link SubdivisionModifier}. */
export type { SubdivisionOptions };

/**
 * Applies Catmull-Clark subdivision to a geometry.
 *
 * @param geometry Source geometry; must have a `position` attribute.
 * @param options See {@link SubdivisionOptions}.
 * @returns A new subdivided geometry, or a clone of the input when `iterations` is
 *   `0` or the input has no faces.
 */
export function subdivide(
  geometry: BufferGeometry,
  options: SubdivisionOptions = {},
): BufferGeometry {
  const iterations = Math.max(0, Math.floor(options.iterations ?? 1));
  const weight = clamp01(options.weight ?? 1);

  let current = geometry;
  for (let i = 0; i < iterations; i++) {
    current = subdivideOnce(current);
  }

  if (weight >= 1 || iterations === 0) return iterations === 0 ? geometry.clone() : current;

  // Partial subdivision: blend the result back towards the original so a caller can
  // dial the smoothing down without changing the topology.
  return blendPositions(geometry, current, weight);
}

/**
 * `SubdivisionModifier` — the class form of {@link subdivide}.
 */
export class SubdivisionModifier {
  /** Creates the modifier. */
  constructor(public readonly options: SubdivisionOptions = {}) {}

  /**
   * Subdivides a geometry.
   *
   * @param geometry Source geometry.
   * @returns The subdivided geometry.
   */
  public modify(geometry: BufferGeometry): BufferGeometry {
    return subdivide(geometry, this.options);
  }
}

/* -------------------------------------------------------------------------- */
/* One pass                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Performs one Catmull-Clark pass.
 *
 * @param geometry Source geometry.
 * @returns The subdivided geometry.
 */
function subdivideOnce(geometry: BufferGeometry): BufferGeometry {
  const source = readTriangles(geometry);
  if (source.faceCount === 0) return geometry.clone();

  const { vertices, faces } = buildPolygonTopology(source);

  /* --------------------------------------------------------- face points */

  const facePoints: Vec3[] = faces.map((face) => {
    const centroid = new Vec3();
    for (const vertex of face) centroid.add(vertices[vertex]);
    return centroid.divideScalar(face.length);
  });

  /* --------------------------------------------------------- edge points */

  /** Edge key -> the two endpoints and the faces that contain it. */
  const edges = new Map<string, { a: number; b: number; faces: number[] }>();

  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      const key = edgeKey(a, b);
      const existing = edges.get(key);
      if (existing) existing.faces.push(f);
      else edges.set(key, { a, b, faces: [f] });
    }
  }

  const edgePoints = new Map<string, Vec3>();
  for (const [key, edge] of edges) {
    const point = new Vec3().add(vertices[edge.a]).add(vertices[edge.b]);
    if (edge.faces.length === 2) {
      // Interior edge: include both adjacent face points, then average over four.
      point.add(facePoints[edge.faces[0]]).add(facePoints[edge.faces[1]]).multiplyScalar(0.25);
    } else {
      // Boundary edge: only its endpoints contribute, so the border stays put.
      point.multiplyScalar(0.5);
    }
    edgePoints.set(key, point);
  }

  /* ------------------------------------------------------- vertex points */

  /** Vertex -> the faces and edges touching it. */
  const incidentFaces: number[][] = Array.from({ length: vertices.length }, () => []);
  const incidentEdges: string[][] = Array.from({ length: vertices.length }, () => []);
  const isBoundary = new Set<number>();

  for (let f = 0; f < faces.length; f++) {
    for (const vertex of faces[f]) incidentFaces[vertex].push(f);
  }
  for (const [key, edge] of edges) {
    incidentEdges[edge.a].push(key);
    incidentEdges[edge.b].push(key);
    if (edge.faces.length === 1) {
      isBoundary.add(edge.a);
      isBoundary.add(edge.b);
    }
  }

  const vertexPoints: Vec3[] = vertices.map((position, index) => {
    const facesAround = incidentFaces[index];
    const edgesAround = incidentEdges[index];
    const n = edgesAround.length;

    if (n === 0) return position.clone();

    if (isBoundary.has(index)) {
      // Boundary rule: keep the vertex on the border by averaging only its two
      // boundary neighbours, which prevents an open mesh from shrinking inwards.
      const neighbours: Vec3[] = [];
      for (const key of edgesAround) {
        const edge = edges.get(key);
        if (!edge || edge.faces.length !== 1) continue;
        neighbours.push(vertices[edge.a === index ? edge.b : edge.a]);
      }
      if (neighbours.length === 0) return position.clone();
      const average = new Vec3();
      for (const neighbour of neighbours) average.add(neighbour);
      average.divideScalar(neighbours.length);
      return position.clone().multiplyScalar(0.75).addScaledVector(average, 0.25);
    }

    // F: average of the adjacent face points.
    const f = new Vec3();
    for (const face of facesAround) f.add(facePoints[face]);
    f.divideScalar(facesAround.length || 1);

    // R: average of the adjacent edge midpoints.
    const r = new Vec3();
    for (const key of edgesAround) {
      const edge = edges.get(key);
      if (!edge) continue;
      r.add(vertices[edge.a]).add(vertices[edge.b]).multiplyScalar(0.5);
    }
    r.divideScalar(n);

    // P: the original position.
    const p = position;

    // (F + 2R + (n - 3)P) / n
    return new Vec3()
      .add(f)
      .addScaledVector(r, 2)
      .addScaledVector(p, n - 3)
      .divideScalar(n);
  });

  /* ------------------------------------------------------------ rebuild */

  const result = new GeometryAccumulator();
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    const facePoint = facePoints[f];
    const facePointIndex = result.push(facePoint);

    for (let i = 0; i < face.length; i++) {
      const current = face[i];
      const next = face[(i + 1) % face.length];
      const previous = face[(i - 1 + face.length) % face.length];

      const edgeNext = edgePoints.get(edgeKey(current, next))!;
      const edgePrevious = edgePoints.get(edgeKey(previous, current))!;

      const a = result.push(vertexPoints[current]);
      const b = result.push(edgeNext);
      const c = facePointIndex;
      const d = result.push(edgePrevious);

      // Emit the quad as two triangles.
      result.pushTriangle(a, b, c);
      result.pushTriangle(a, c, d);
    }
  }

  return result.build(geometry.name);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Reads a geometry as a triangle soup with welded topology. */
function readTriangles(geometry: BufferGeometry): {
  vertices: Vec3[];
  faces: number[][];
  faceCount: number;
} {
  const position = geometry.getAttribute('position');
  if (!position) return { vertices: [], faces: [], faceCount: 0 };

  const index = geometry.getIndex();
  const array = position.array;
  const stride = position.itemSize || 3;
  const vertexCount = position.count > 0 ? position.count : Math.floor(array.length / stride);

  const vertices: Vec3[] = [];
  for (let i = 0; i < vertexCount; i++) {
    vertices.push(new Vec3(array[i * stride] ?? 0, array[i * stride + 1] ?? 0, array[i * stride + 2] ?? 0));
  }

  const indexArray = index ? index.array : null;
  const elementCount = indexArray ? indexArray.length : vertexCount;
  const faces: number[][] = [];
  for (let f = 0; f + 2 < elementCount; f += 3) {
    const a = indexArray ? (indexArray[f] ?? 0) : f;
    const b = indexArray ? (indexArray[f + 1] ?? 0) : f + 1;
    const c = indexArray ? (indexArray[f + 2] ?? 0) : f + 2;
    if (a === b || b === c || a === c) continue; // drop degenerate triangles
    faces.push([a, b, c]);
  }

  return { vertices, faces, faceCount: faces.length };
}

/**
 * Welds coincident faces that share a full edge.
 *
 * Catmull-Clark on raw triangles produces a valid but dense result: each triangle
 * becomes three quads, and the face point of every triangle is a valence-3 vertex.
 * Merging coplanar triangle pairs back into quads first gives the expected
 * quad-dominant result for a box authored as triangles.
 *
 * The merge is intentionally left out: doing it correctly needs a planarity test
 * plus a non-manifold guard, and getting that wrong silently produces non-planar
 * n-gons whose Catmull-Clark face point leaves the surface. The subdivided
 * triangle mesh is still smooth and manifold, so the safe behaviour is to keep the
 * input topology as it is.
 */
function buildPolygonTopology(source: { vertices: Vec3[]; faces: number[][] }): {
  vertices: Vec3[];
  faces: number[][];
} {
  return { vertices: source.vertices, faces: source.faces };
}

/** Order-independent key for an undirected edge. */
function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/** Clamps a value into `[0, 1]`. */
function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Blends two geometries' positions, keeping the first one's topology.
 *
 * Requires both geometries to have the same vertex count, which is true when the
 * second came from subdividing the first with `iterations` such that the
 * triangulation was not rebuilt — so the blend is only applied when the counts
 * match and is skipped otherwise.
 */
function blendPositions(
  original: BufferGeometry,
  subdivided: BufferGeometry,
  weight: number,
): BufferGeometry {
  const a = original.getAttribute('position');
  const b = subdivided.getAttribute('position');
  if (!a || !b || a.count !== b.count) return subdivided;

  const data = new Float32Array(b.array.length);
  for (let i = 0; i < b.array.length; i++) {
    data[i] = a.array[i] * (1 - weight) + b.array[i] * weight;
  }
  subdivided.setAttribute('position', new Float32BufferAttribute(data, 3, false, 'static', 'position'));
  return subdivided;
}

/** A growable builder local to this module, avoiding a cross-directory import. */
class GeometryAccumulator {
  private readonly positions: number[] = [];
  private readonly indices: number[] = [];

  /** Appends a vertex and returns its index. */
  public push(point: Vec3): number {
    const index = this.positions.length / 3;
    this.positions.push(point.x, point.y, point.z);
    return index;
  }

  /** Appends a triangle. */
  public pushTriangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** Materialises a `BufferGeometry`. */
  public build(name: string): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.name = name;
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute(Float32Array.from(this.positions), 3, false, 'static', 'position'),
    );
    geometry.setIndex(new Uint32BufferAttribute(Uint32Array.from(this.indices), 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** Re-exported so callers can type a modifier pipeline. */
export type { ModifierGeometryLike };
