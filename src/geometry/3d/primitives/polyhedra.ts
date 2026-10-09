/**
 * The Platonic solids, as vertex/face tables.
 *
 * Faces are listed **counter-clockwise when seen from outside**, so back-face
 * culling works without a per-solid winding fix. Each pentagonal dodecahedron face
 * is split into three triangles, keeping every solid a pure triangle mesh.
 *
 * ## Why the icosahedron's faces are derived rather than typed
 *
 * A twenty-face index table is only correct for the exact vertex ordering it was
 * written against. Swapping in a different (but equally valid) generation order
 * silently produces a "sphere" whose faces connect *antipodal* vertex pairs — the
 * mesh still has 20 faces and every edge still has two neighbours, so it passes a
 * casual look, but the midpoint subdivision collapses to the origin and half the
 * faces are inverted.
 *
 * So the icosahedron is generated from its true coordinates and its faces are
 * **derived from the connectivity**: the 30 edges are the vertex pairs at the
 * minimum distance, and each edge contributes the two triangles formed with the
 * common neighbours of its endpoints. Winding is fixed by requiring each face
 * normal to point away from the origin.
 *
 * The dodecahedron is then the **dual** of the icosahedron: its vertices are the
 * icosahedron's face centroids, and each of its faces corresponds to one
 * icosahedron vertex.
 *
 * `tests/unit/geometry-3d.test.ts` checks Euler's formula (`V - E + F = 2`), that
 * every edge is shared by exactly two faces, and that every face winds outward.
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../../math/Vec3';
import type { PolyhedronDefinition } from '../types';

/** Regular tetrahedron: four alternate cube corners. */
export const TETRAHEDRON: PolyhedronDefinition = {
  name: 'tetrahedron',
  vertices: [new Vec3(1, 1, 1), new Vec3(-1, -1, 1), new Vec3(-1, 1, -1), new Vec3(1, -1, -1)],
  faces: [
    [0, 2, 1],
    [0, 1, 3],
    [0, 3, 2],
    [1, 2, 3],
  ],
};

/** Regular octahedron: the six axis-aligned unit vertices. */
export const OCTAHEDRON: PolyhedronDefinition = {
  name: 'octahedron',
  vertices: [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 1, 0),
    new Vec3(0, -1, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ],
  faces: [
    [0, 2, 4],
    [0, 4, 3],
    [0, 3, 5],
    [0, 5, 2],
    [1, 4, 2],
    [1, 3, 4],
    [1, 5, 3],
    [1, 2, 5],
  ],
};

/**
 * Regular icosahedron.
 *
 * Twelve vertices, one per cyclic permutation of `(0, ±1, ±φ)`, with the twenty
 * faces derived from their connectivity — see the module documentation for why the
 * table is not hard-coded.
 */
export const ICOSAHEDRON: PolyhedronDefinition = (() => {
  const t = (1 + Math.sqrt(5)) / 2; // golden ratio
  const vertices: Vec3[] = [];
  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      vertices.push(new Vec3(0, s1, s2 * t));
      vertices.push(new Vec3(s1, s2 * t, 0));
      vertices.push(new Vec3(s1 * t, 0, s2));
    }
  }

  return { name: 'icosahedron', vertices, faces: deriveFaces(vertices) };
})();

/**
 * Regular dodecahedron, built as the dual of {@link ICOSAHEDRON}.
 *
 * The dual construction is exact and self-checking:
 *
 * 1. every icosahedron **face** produces a dodecahedron **vertex** — its centroid;
 * 2. every icosahedron **vertex** produces a dodecahedron **face** — the ring of
 *    centroids of the faces around it, ordered by angle in the plane perpendicular
 *    to the source vertex.
 */
export const DODECAHEDRON: PolyhedronDefinition = (() => {
  const source = ICOSAHEDRON;

  // Step 1: a dual vertex per source face.
  const vertices: Vec3[] = source.faces.map(([a, b, c]) => {
    const pa = source.vertices[a];
    const pb = source.vertices[b];
    const pc = source.vertices[c];
    return new Vec3(
      (pa.x + pb.x + pc.x) / 3,
      (pa.y + pb.y + pc.y) / 3,
      (pa.z + pb.z + pc.z) / 3,
    );
  });

  /** Faces of the source that touch a given source vertex. */
  const facesPerVertex: number[][] = source.vertices.map(() => []);
  for (let f = 0; f < source.faces.length; f++) {
    for (const vertex of source.faces[f]) facesPerVertex[vertex].push(f);
  }

  // Step 2: a dual face per source vertex, ordered around it.
  const faces: [number, number, number][] = [];

  for (let v = 0; v < source.vertices.length; v++) {
    const neighbours = facesPerVertex[v];
    if (neighbours.length !== 5) {
      throw new Error(`dodecahedron: icosahedron vertex ${v} has ${neighbours.length} faces, expected 5`);
    }

    const axis = source.vertices[v].clone().normalize();

    // A basis in the plane perpendicular to `axis`, built from the first neighbour
    // so the angles are measured consistently for every face.
    const first = vertices[neighbours[0]];
    const reference = first
      .clone()
      .sub(axis.clone().multiplyScalar(first.dot(axis)))
      .normalize();
    const bitangent = new Vec3().copy(axis).cross(reference).normalize();

    const ordered = neighbours
      .map((faceIndex) => {
        const point = vertices[faceIndex];
        const projected = point.clone().sub(axis.clone().multiplyScalar(point.dot(axis)));
        return { faceIndex, angle: Math.atan2(projected.dot(bitangent), projected.dot(reference)) };
      })
      .sort((a, b) => a.angle - b.angle)
      .map((entry) => entry.faceIndex);

    // The dual face's outward direction is the source vertex it corresponds to.
    // Winding is fixed from that rather than from the sign convention of the two
    // basis vectors, which is easy to get backwards and invisible on a symmetric
    // solid.
    const faceNormal = new Vec3()
      .copy(vertices[ordered[1]])
      .sub(vertices[ordered[0]])
      .cross(new Vec3().copy(vertices[ordered[2]]).sub(vertices[ordered[0]]));
    const outward = new Vec3();
    for (const index of ordered) outward.add(vertices[index]);
    outward.normalize();

    const winding = faceNormal.dot(outward) >= 0 ? ordered : ordered.slice().reverse();

    // Fan the pentagon into three triangles.
    for (let i = 1; i < 4; i++) {
      faces.push([winding[0], winding[i], winding[i + 1]]);
    }
  }

  return { name: 'dodecahedron', vertices: normalizeRadii(vertices), faces };
})();

/** Every Platonic solid, keyed by name. */
export const PLATONIC_SOLIDS: Readonly<Record<string, PolyhedronDefinition>> = {
  tetrahedron: TETRAHEDRON,
  octahedron: OCTAHEDRON,
  dodecahedron: DODECAHEDRON,
  icosahedron: ICOSAHEDRON,
};

/* -------------------------------------------------------------------------- */
/* Connectivity derivation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Derives the triangular faces of a convex, centrally symmetric point set.
 *
 * The edges are the vertex pairs at the minimum pairwise distance (for an
 * icosahedron, its 30 edges). Every edge is then shared by exactly two faces, each
 * formed with one of the edge's two *common neighbours* — the vertices adjacent to
 * both endpoints. That yields each face once per edge, so the result is
 * deduplicated by sorted vertex triple.
 *
 * @param vertices The point set, centred on the origin.
 * @returns Triangular faces wound counter-clockwise seen from outside.
 */
export function deriveFaces(vertices: readonly Vec3[]): [number, number, number][] {
  const count = vertices.length;

  /** Squared distance between two vertices. */
  const distanceSquared = (a: number, b: number): number =>
    vertices[a].distanceToSquared(vertices[b]);

  // The shortest pairwise distance is the edge length.
  let edgeLengthSquared = Infinity;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const distance = distanceSquared(i, j);
      if (distance > 1e-12 && distance < edgeLengthSquared) edgeLengthSquared = distance;
    }
  }
  if (!Number.isFinite(edgeLengthSquared)) return [];

  // Adjacency: pairs at the edge length.
  const neighbours: number[][] = Array.from({ length: count }, () => []);
  const edgeTolerance = edgeLengthSquared * 1e-6;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (Math.abs(distanceSquared(i, j) - edgeLengthSquared) <= edgeTolerance) {
        neighbours[i].push(j);
        neighbours[j].push(i);
      }
    }
  }

  const faces: [number, number, number][] = [];
  const seen = new Set<string>();

  /** Records a face once, with its winding fixed to face outward. */
  const addFace = (a: number, b: number, c: number): void => {
    const sorted = [a, b, c].slice().sort((x, y) => x - y);
    const key = sorted.join('_');
    if (seen.has(key)) return;
    seen.add(key);

    const pa = vertices[a];
    const pb = vertices[b];
    const pc = vertices[c];
    const normal = new Vec3()
      .copy(pb)
      .sub(pa)
      .cross(new Vec3().copy(pc).sub(pa));
    const centroid = new Vec3(
      (pa.x + pb.x + pc.x) / 3,
      (pa.y + pb.y + pc.y) / 3,
      (pa.z + pb.z + pc.z) / 3,
    );

    // Outward winding: the face normal must point away from the origin, which holds
    // for any convex body centred there.
    if (normal.dot(centroid) >= 0) faces.push([a, b, c]);
    else faces.push([a, c, b]);
  };

  for (let i = 0; i < count; i++) {
    for (const j of neighbours[i]) {
      if (j < i) continue; // each edge once

      // The two vertices adjacent to both `i` and `j`.
      for (const k of neighbours[i]) {
        if (k === j || !neighbours[j].includes(k)) continue;
        addFace(i, j, k);
      }
    }
  }

  return faces;
}

/**
 * Rescales a vertex list so every vertex is the same distance from the origin.
 *
 * The dual construction places each dodecahedron vertex at the centroid of an
 * icosahedron face, and those centroids are **not** equidistant for the
 * natural-size definition. Scaling all vertices to the mean radius restores the
 * regularity that makes the solid a *regular* dodecahedron and keeps
 * `PolyhedronGeometry`'s `radius` option meaningful.
 *
 * @param vertices Vertex list to normalise in place.
 * @returns The same array, for chaining.
 */
function normalizeRadii(vertices: Vec3[]): Vec3[] {
  let total = 0;
  for (const vertex of vertices) total += vertex.length();
  const mean = vertices.length > 0 ? total / vertices.length : 1;
  if (mean <= 0) return vertices;
  for (const vertex of vertices) vertex.multiplyScalar(1 / mean);
  return vertices;
}
