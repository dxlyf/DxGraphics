/**
 * `PolyhedronGeometry` — the shared generator behind the Platonic solids.
 *
 * A Platonic solid is fully described by a vertex list and a triangle list, so all
 * five generators (`TetrahedronGeometry`, `OctahedronGeometry`,
 * `DodecahedronGeometry`, `IcosahedronGeometry` and anything user-defined) reduce
 * to calling {@link createPolyhedronGeometry} with that table.
 *
 * ## Detail levels
 *
 * `detail` subdivides each triangle by splitting its edges at their midpoints —
 * every triangle becomes four — and then projects the new vertices onto the
 * circumscribed sphere. That is what turns an icosahedron into an increasingly
 * smooth geodesic ball without changing the topology. `detail: 0` keeps the base
 * solid, whose facets are flat.
 *
 * The projection is deliberately "midpoint then normalise" rather than a geodesic
 * subdivision: the two agree in the limit, and this is the cheaper, more
 * predictable operation.
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../../math/Vec3';
import { BufferGeometry } from '../../core/BufferGeometry';
import { GeometryBuilder } from './GeometryBuilder';
import type { GeometryGeneratorOptions, PolyhedronDefinition } from '../types';

/** Options accepted by {@link createPolyhedronGeometry}. */
export interface PolyhedronGeometryOptions extends GeometryGeneratorOptions {
  /**
   * Subdivision passes. `0` keeps the base solid; each pass quadruples the
   * triangle count.
   *
   * @default 0
   */
  detail?: number;
  /**
   * Radius of the circumscribed sphere. When omitted the definition's natural
   * size is kept.
   */
  radius?: number;
}

/**
 * Builds a polyhedron from a definition.
 *
 * @param definition Vertices and triangular faces.
 * @param options See {@link PolyhedronGeometryOptions}.
 * @returns A new geometry with `position`, `normal` and `uv` attributes.
 */
export function createPolyhedronGeometry(
  definition: PolyhedronDefinition,
  options: PolyhedronGeometryOptions = {},
): BufferGeometry {
  const detail = Math.max(0, Math.floor(options.detail ?? 0));
  const builder = new GeometryBuilder({
    normals: options.normals ?? true,
    uv: options.uv ?? true,
    indexed: options.indexed ?? true,
    name: options.name ?? `${definition.name}Geometry`.replace(/^./, (c) => c.toUpperCase()),
    initialCapacity: definition.faces.length * 3 * 4 ** detail,
  });

  /** Current vertex positions, as raw triples. */
  let vertices: number[] = [];
  for (const vertex of definition.vertices) vertices.push(vertex.x, vertex.y, vertex.z);

  /** A normalised copy of a vertex triple. */
  const normalizeVertex = (values: number[], index: number): [number, number, number] => {
    const x = values[index * 3];
    const y = values[index * 3 + 1];
    const z = values[index * 3 + 2];
    const length = Math.hypot(x, y, z) || 1;
    return [x / length, y / length, z / length];
  };

  // Subdivision. Faces are always triangles; each pass replaces one face by four.
  let faces: number[] = [];
  for (const face of definition.faces) faces.push(face[0], face[1], face[2]);

  /**
   * Scales a vertex list so its farthest vertex sits at `radius`, in place.
   *
   * Applied once, after all subdivision, so the projection and the final scale do
   * not compound: normalising a superset-scaled mesh would land the new vertices
   * inside the sphere (their norm is smaller than the original vertices').
   */
  const applyRadius = (values: number[]): void => {
    if (options.radius === undefined) return;
    let maxSquared = 0;
    for (let i = 0; i < values.length; i += 3) {
      maxSquared = Math.max(maxSquared, values[i] ** 2 + values[i + 1] ** 2 + values[i + 2] ** 2);
    }
    const current = Math.sqrt(maxSquared);
    if (current <= 0) return;
    const factor = options.radius / current;
    for (let i = 0; i < values.length; i++) values[i] *= factor;
  };

  let currentDetail = detail;

  /*
   * Normalise the definition onto the unit sphere before subdividing.
   *
   * A Platonic definition is authored at a convenient natural size, so its vertices
   * are *not* all the same distance from the origin. Subdividing without
   * normalising first is a real bug: the midpoint projection below computes
   * `normalize(a) + normalize(b)`, and if `a` and `b` were not already unit length
   * the sum can be near zero, which sends the new vertex to the origin and produces
   * a radius of `0`.
   */
  for (let i = 0; i < vertices.length; i += 3) {
    const length = Math.hypot(vertices[i], vertices[i + 1], vertices[i + 2]) || 1;
    vertices[i] /= length;
    vertices[i + 1] /= length;
    vertices[i + 2] /= length;
  }

  while (currentDetail > 0) {
    const midpointCache = new Map<string, number>();
    const nextFaces: number[] = [];
    const nextVertices = vertices.slice();

    /**
     * Returns (creating if needed) the index of the midpoint of `a`-`b`, pushed out
     * to the unit sphere.
     */
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const cached = midpointCache.get(key);
      if (cached !== undefined) return cached;

      const [nx, ny, nz] = normalizeVertex(nextVertices, a);
      const [mx, my, mz] = normalizeVertex(nextVertices, b);
      const x = nx + mx;
      const y = ny + my;
      const z = nz + mz;
      const length = Math.hypot(x, y, z) || 1;

      const index = nextVertices.length / 3;
      nextVertices.push(x / length, y / length, z / length);
      midpointCache.set(key, index);
      return index;
    };

    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f];
      const b = faces[f + 1];
      const c = faces[f + 2];

      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);

      nextFaces.push(a, ab, ca);
      nextFaces.push(b, bc, ab);
      nextFaces.push(c, ca, bc);
      nextFaces.push(ab, bc, ca);
    }

    vertices = nextVertices;
    faces = nextFaces;
    currentDetail--;
  }

  applyRadius(vertices);

  // Emit unique vertices, then the index buffer.
  const vertexCount = vertices.length / 3;
  const indexOf = new Map<string, number>();
  const emitted: number[] = new Array(vertexCount);

  /** Maps a generated vertex to an emitted one, deduplicating by exact position. */
  const emit = (index: number): number => {
    const known = emitted[index];
    if (known !== undefined && known >= 0) return known;

    const x = vertices[index * 3];
    const y = vertices[index * 3 + 1];
    const z = vertices[index * 3 + 2];
    const length = Math.hypot(x, y, z) || 1;
    const nx = x / length;
    const ny = y / length;
    const nz = z / length;

    // Spherical UVs; the seam at u = 0 / 1 is duplicated through the key so the
    // texture does not wrap backwards across it.
    const u = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
    const v = Math.asin(Math.max(-1, Math.min(1, ny))) / Math.PI + 0.5;

    const key = `${x.toFixed(6)}_${y.toFixed(6)}_${z.toFixed(6)}`;
    const existing = indexOf.get(key);
    if (existing !== undefined) {
      emitted[index] = existing;
      return existing;
    }

    const created = builder.pushVertex(x, y, z, nx, ny, nz, u, v);
    indexOf.set(key, created);
    emitted[index] = created;
    return created;
  };

  for (let f = 0; f < faces.length; f += 3) {
    builder.pushTriangle(emit(faces[f]), emit(faces[f + 1]), emit(faces[f + 2]));
  }

  return builder.build();
}

/**
 * Applies a uniform scale to a vertex list.
 *
 * Exported because the Platonic definitions need to be authored at a natural size
 * and scaled to the caller's radius.
 *
 * @param vertices Vertex triples.
 * @param scale Factor.
 * @returns A new scaled list.
 */
export function scaleVertices(vertices: readonly Vec3[], scale: number): Vec3[] {
  return vertices.map((vertex) => vertex.clone().multiplyScalar(scale));
}

/**
 * `PolyhedronGeometry` — the class form of {@link createPolyhedronGeometry}.
 */
export class PolyhedronGeometry extends BufferGeometry {
  /** Creates a polyhedron from a definition. */
  constructor(definition: PolyhedronDefinition, options: PolyhedronGeometryOptions = {}) {
    super();
    const built = createPolyhedronGeometry(definition, options);
    this.copy(built);
    built.dispose();
  }
}
