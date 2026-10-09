/**
 * `computeTangents` — per-vertex tangents for normal mapping.
 *
 * Uses the standard Lengyel formulation: accumulate each triangle's tangent and
 * bitangent from the UV derivative, then Gram-Schmidt orthogonalise against the
 * vertex normal and store the handedness in `w`. A shader rebuilds the bitangent
 * as `cross(normal, tangent.xyz) * tangent.w`, which is why the sign matters and
 * why it is worth computing rather than assuming.
 *
 * Requires `position`, `normal` and `uv`; a geometry missing any of them is left
 * untouched and reported through {@link ComputeTangentsResult.skipped}.
 *
 * @packageDocumentation
 */

import { Float32BufferAttribute } from '../../core/BufferAttribute';
import type { BufferGeometry } from '../../core/BufferGeometry';
import type { ComputeTangentsOptions } from '../types';
export type { ComputeTangentsOptions } from '../types';

/** What a tangent computation did. */
export interface ComputeTangentsResult {
  /** Triangles that contributed. */
  faceCount: number;
  /** Vertices whose tangent was degenerate and had to be filled in. */
  degenerateVertices: number;
  /** `true` when a required attribute was missing. */
  skipped: boolean;
  /** Attribute that was missing, when `skipped` is set. */
  missingAttribute?: string;
}

/**
 * Computes and installs per-vertex tangents.
 *
 * @param geometry Geometry to update, mutated in place.
 * @param options See {@link ComputeTangentsOptions}.
 * @returns A description of what happened.
 */
export function computeTangents(
  geometry: BufferGeometry,
  options: ComputeTangentsOptions = {},
): ComputeTangentsResult {
  const handedness = options.handedness ?? true;
  const uvName = options.uvAttribute ?? 'uv';
  const overwrite = options.overwrite ?? true;

  if (geometry.getAttribute('tangent') && !overwrite) {
    return { faceCount: 0, degenerateVertices: 0, skipped: true };
  }

  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = geometry.getAttribute(uvName);

  if (!position) return { faceCount: 0, degenerateVertices: 0, skipped: true, missingAttribute: 'position' };
  if (!normal) return { faceCount: 0, degenerateVertices: 0, skipped: true, missingAttribute: 'normal' };
  if (!uv) return { faceCount: 0, degenerateVertices: 0, skipped: true, missingAttribute: uvName };

  const pos = position.array;
  const nor = normal.array;
  const uvs = uv.array;
  const index = geometry.getIndex();
  const indexArray = index ? index.array : null;

  const vertexCount = position.count > 0 ? position.count : Math.floor(pos.length / 3);
  const elementCount = indexArray ? indexArray.length : vertexCount;
  const faceCount = Math.floor(elementCount / 3);

  const tan1 = new Float32Array(vertexCount * 3);
  const tan2 = new Float32Array(vertexCount * 3);

  for (let f = 0; f < faceCount; f++) {
    const i0 = indexArray ? (indexArray[f * 3] ?? 0) : f * 3;
    const i1 = indexArray ? (indexArray[f * 3 + 1] ?? 0) : f * 3 + 1;
    const i2 = indexArray ? (indexArray[f * 3 + 2] ?? 0) : f * 3 + 2;

    const x0 = pos[i0 * 3], y0 = pos[i0 * 3 + 1], z0 = pos[i0 * 3 + 2];
    const x1 = pos[i1 * 3], y1 = pos[i1 * 3 + 1], z1 = pos[i1 * 3 + 2];
    const x2 = pos[i2 * 3], y2 = pos[i2 * 3 + 1], z2 = pos[i2 * 3 + 2];

    const u0 = uvs[i0 * 2], v0 = uvs[i0 * 2 + 1];
    const u1 = uvs[i1 * 2], v1 = uvs[i1 * 2 + 1];
    const u2 = uvs[i2 * 2], v2 = uvs[i2 * 2 + 1];

    const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
    const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;

    const du1 = u1 - u0, dv1 = v1 - v0;
    const du2 = u2 - u0, dv2 = v2 - v0;

    const determinant = du1 * dv2 - du2 * dv1;
    if (Math.abs(determinant) < 1e-12) continue; // Degenerate UV triangle.
    const inverse = 1 / determinant;

    const tx = (dv2 * e1x - dv1 * e2x) * inverse;
    const ty = (dv2 * e1y - dv1 * e2y) * inverse;
    const tz = (dv2 * e1z - dv1 * e2z) * inverse;

    const bx = (du1 * e2x - du2 * e1x) * inverse;
    const by = (du1 * e2y - du2 * e1y) * inverse;
    const bz = (du1 * e2z - du2 * e1z) * inverse;

    for (const vertex of [i0, i1, i2]) {
      tan1[vertex * 3] += tx;
      tan1[vertex * 3 + 1] += ty;
      tan1[vertex * 3 + 2] += tz;
      tan2[vertex * 3] += bx;
      tan2[vertex * 3 + 1] += by;
      tan2[vertex * 3 + 2] += bz;
    }
  }

  const tangents = new Float32Array(vertexCount * 4);
  let degenerateVertices = 0;

  for (let i = 0; i < vertexCount; i++) {
    const nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
    let tx = tan1[i * 3], ty = tan1[i * 3 + 1], tz = tan1[i * 3 + 2];

    // Gram-Schmidt: remove the normal component from the tangent.
    const dot = nx * tx + ny * ty + nz * tz;
    tx -= nx * dot;
    ty -= ny * dot;
    tz -= nz * dot;

    let length = Math.hypot(tx, ty, tz);
    if (length < 1e-6) {
      // No usable UV gradient at this vertex (pole, cap, degenerate UV island).
      // Fall back to any vector perpendicular to the normal so the shader still
      // builds a valid tangent frame.
      degenerateVertices++;
      const [ox, oy, oz] = perpendicularTo(nx, ny, nz);
      tx = ox;
      ty = oy;
      tz = oz;
      length = 1;
    }

    tangents[i * 4] = tx / length;
    tangents[i * 4 + 1] = ty / length;
    tangents[i * 4 + 2] = tz / length;

    // Handedness: the sign of the bitangent's projection onto cross(n, t).
    if (handedness) {
      const cx = ny * (tz / length) - nz * (ty / length);
      const cy = nz * (tx / length) - nx * (tz / length);
      const cz = nx * (ty / length) - ny * (tx / length);
      const sign = cx * tan2[i * 3] + cy * tan2[i * 3 + 1] + cz * tan2[i * 3 + 2];
      tangents[i * 4 + 3] = sign < 0 ? -1 : 1;
    } else {
      tangents[i * 4 + 3] = 1;
    }
  }

  geometry.setAttribute('tangent', new Float32BufferAttribute(tangents, 4, false, 'static', 'tangent'));
  return { faceCount, degenerateVertices, skipped: false };
}

/**
 * Returns an arbitrary unit vector perpendicular to `(x, y, z)`.
 *
 * Crosses with whichever axis is least aligned with the input, which keeps the
 * result well conditioned for every input direction.
 *
 * @param x Normal x.
 * @param y Normal y.
 * @param z Normal z.
 * @returns A perpendicular unit vector.
 */
export function perpendicularTo(x: number, y: number, z: number): [number, number, number] {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);

  let px = 0;
  let py = 0;
  let pz = 0;
  if (ax <= ay && ax <= az) {
    px = 0;
    py = -z;
    pz = y;
  } else if (ay <= az) {
    px = -z;
    py = 0;
    pz = x;
  } else {
    px = -y;
    py = x;
    pz = 0;
  }

  const length = Math.hypot(px, py, pz) || 1;
  return [px / length, py / length, pz / length];
}

/** Re-exported for callers that build tangents by hand. */
export { Float32BufferAttribute };
