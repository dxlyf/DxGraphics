/**
 * `correctWinding` — make a triangle mesh's winding agree with its vertex normals.
 *
 * Every closed primitive faces the same hazard: the parameterisation
 * `(u, v) -> position` may be right- or left-handed with respect to the outward
 * normal, and whether it is depends on incidental choices such as whether `v` runs
 * up or down. Getting it backwards is invisible with culling disabled (the surface
 * still shades, because the shading normal is a separate attribute) and produces an
 * inside-out object with culling enabled, which makes it one of the hardest bugs to
 * spot in a screenshot.
 *
 * Rather than reason about handedness in each of the sixteen generators, the
 * generators state their normals — which they compute analytically and which are
 * therefore reliable — and this pass flips any triangle whose geometric normal
 * opposes the average of its three vertex normals.
 *
 * ## Why the vertex normal is the right reference
 *
 * A vertex normal points into the "outside" half-space by definition, whatever the
 * surface looks like: a sphere's, a torus's inner wall, a cone's wall, a tube's
 * interior. So `dot(geometricNormal, averageVertexNormal) > 0` is the correct
 * criterion for **every** mesh, including non-convex and non-star-shaped ones. A
 * criterion based on the face centroid (as a "does the normal point away from the
 * origin" test) is wrong for a torus, whose inner wall legitimately faces the hole.
 *
 * The pass leaves a mesh alone when it has no `normal` attribute, or when any of a
 * triangle's vertex normals is degenerate — a zero normal carries no orientation
 * information, and guessing from a zero vector is how a normalizer makes things
 * worse.
 *
 * @packageDocumentation
 */

import type { BufferGeometry } from '../../core/BufferGeometry';

/** What a winding pass changed. */
export interface CorrectWindingResult {
  /** Triangles the pass inspected. */
  triangleCount: number;
  /** Triangles whose winding was reversed. */
  flippedCount: number;
  /** `true` when the pass did nothing (no usable normals, or no index buffer). */
  skipped: boolean;
  /** Why the pass was skipped. */
  reason?: string;
}

/**
 * Reverses any triangle whose winding disagrees with its vertex normals.
 *
 * Mutates the geometry's index buffer in place.
 *
 * @param geometry Geometry to correct; must be indexed and carry `normal`.
 * @returns A summary of what changed.
 */
export function correctWinding(geometry: BufferGeometry): CorrectWindingResult {
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');

  if (!index) return { triangleCount: 0, flippedCount: 0, skipped: true, reason: 'geometry is not indexed' };
  if (!position) return { triangleCount: 0, flippedCount: 0, skipped: true, reason: 'no position attribute' };
  if (!normal) return { triangleCount: 0, flippedCount: 0, skipped: true, reason: 'no normal attribute' };

  const indices = index.array;
  const positions = position.array;
  const normals = normal.array;
  const triangleCount = Math.floor(index.count / 3);
  let flippedCount = 0;

  /** Reads component `component` of the vertex normal at `vertex`. */
  const normalAt = (vertex: number, component: number): number => normals[vertex * 3 + component] ?? 0;

  for (let f = 0; f < triangleCount; f++) {
    const a = indices[f * 3];
    const b = indices[f * 3 + 1];
    const c = indices[f * 3 + 2];

    const ax = positions[a * 3] ?? 0;
    const ay = positions[a * 3 + 1] ?? 0;
    const az = positions[a * 3 + 2] ?? 0;
    const bx = positions[b * 3] ?? 0;
    const by = positions[b * 3 + 1] ?? 0;
    const bz = positions[b * 3 + 2] ?? 0;
    const cx = positions[c * 3] ?? 0;
    const cy = positions[c * 3 + 1] ?? 0;
    const cz = positions[c * 3 + 2] ?? 0;

    // Geometric normal = (b - a) x (c - a), left unnormalised: only its sign
    // matters and normalising per triangle would cost a square root each.
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;

    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    const lengthSquared = nx * nx + ny * ny + nz * nz;
    // A degenerate triangle has no orientation to correct.
    if (lengthSquared < 1e-20) continue;

    // Average of the three vertex normals, unnormalised for the same reason.
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let usable = true;
    for (const vertex of [a, b, c]) {
      const vx = normalAt(vertex, 0);
      const vy = normalAt(vertex, 1);
      const vz = normalAt(vertex, 2);
      if (vx === 0 && vy === 0 && vz === 0) {
        usable = false;
        break;
      }
      sx += vx;
      sy += vy;
      sz += vz;
    }
    if (!usable) continue;
    if (sx * sx + sy * sy + sz * sz < 1e-20) continue;

    if (nx * sx + ny * sy + nz * sz < 0) {
      // Swap the second and third corners to reverse the winding.
      indices[f * 3 + 1] = c;
      indices[f * 3 + 2] = b;
      flippedCount++;
    }
  }

  if (flippedCount > 0) index.needsUpdate = true;

  return { triangleCount, flippedCount, skipped: false };
}
