/**
 * `computeNormals` — vertex normals for indexed and non-indexed triangle meshes.
 *
 * "The normal" of a shared vertex is genuinely ambiguous, so three modes are
 * offered:
 *
 * - **smooth** — average every incident face normal, area-weighted. Correct for
 *   curved surfaces and the default.
 * - **flat** — one normal per triangle corner. A shared vertex cannot hold two
 *   normals, so an indexed input is expanded to a triangle soup automatically and
 *   the caller is told through {@link ComputeNormalsResult.becameNonIndexed}.
 * - **angle** — average only the faces whose normal is within `smoothingAngle` of
 *   the reference face, which is the standard hard/soft edge split.
 *
 * Face normals are accumulated *unnormalised*, so each triangle contributes
 * proportional to its area — the usual convention, and the reason a large triangle
 * dominates a sliver at a shared vertex.
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../../math/Vec3';
import { Float32BufferAttribute } from '../../core/BufferAttribute';
import type { BufferGeometry } from '../../core/BufferGeometry';
import type { ComputeNormalsOptions, NormalMode } from '../types';
export type { ComputeNormalsOptions } from '../types';

/** What a normal computation did. */
export interface ComputeNormalsResult {
  /** Triangles that contributed. */
  faceCount: number;
  /** `true` when the geometry was expanded to satisfy `flat` shading. */
  becameNonIndexed: boolean;
  /** `true` when an existing `normal` attribute was replaced. */
  replacedExisting: boolean;
  /** `true` when the call was a no-op because normals already existed. */
  skipped: boolean;
}

/**
 * Computes and installs vertex normals.
 *
 * @param geometry Geometry to update, mutated in place.
 * @param options See {@link ComputeNormalsOptions}.
 * @returns A description of what happened.
 */
export function computeNormals(
  geometry: BufferGeometry,
  options: ComputeNormalsOptions = {},
): ComputeNormalsResult {
  const mode = options.mode ?? 'smooth';
  const smoothingAngle = options.smoothingAngle ?? Math.PI / 3;
  const overwrite = options.overwrite ?? true;

  const existing = geometry.getAttribute('normal');
  if (existing && !overwrite) {
    return { faceCount: 0, becameNonIndexed: false, replacedExisting: true, skipped: true };
  }

  if (mode === 'flat' && geometry.getIndex()) {
    const expanded = geometry.toNonIndexed();
    const result = computeFlatNormals(expanded);
    adoptGeometry(geometry, expanded);
    return { ...result, becameNonIndexed: true, replacedExisting: Boolean(existing), skipped: false };
  }

  const result =
    mode === 'flat'
      ? computeFlatNormals(geometry)
      : mode === 'angle'
        ? computeAngleWeightedNormals(geometry, smoothingAngle)
        : computeSmoothNormals(geometry);

  return { ...result, becameNonIndexed: false, replacedExisting: Boolean(existing), skipped: false };
}

/* -------------------------------------------------------------------------- */
/* Modes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Area-weighted smooth normals.
 *
 * @param geometry Geometry to read.
 * @returns The face count.
 */
function computeSmoothNormals(geometry: BufferGeometry): { faceCount: number } {
  const { position, index, vertexCount, faceCount } = readGeometry(geometry);
  if (vertexCount === 0) return { faceCount: 0 };

  const normals = new Float32Array(vertexCount * 3);
  const a = scratchA;
  const b = scratchB;
  const c = scratchC;
  const ab = scratchAB;
  const face = scratchFace;

  for (let f = 0; f < faceCount; f++) {
    const ia = index ? index[f * 3] : f * 3;
    const ib = index ? index[f * 3 + 1] : f * 3 + 1;
    const ic = index ? index[f * 3 + 2] : f * 3 + 2;

    readVertex(position, ia, a);
    readVertex(position, ib, b);
    readVertex(position, ic, c);
    // Face normal = (b - a) x (c - a), accumulated unnormalised so each triangle
    // is weighted by twice its area.
    face.copy(b).sub(a).cross(scratchAB.copy(c).sub(a));

    accumulate(normals, ia, face);
    accumulate(normals, ib, face);
    accumulate(normals, ic, face);
  }

  normalizeInPlace(normals, vertexCount);
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3, false, 'static', 'normal'));
  return { faceCount };
}

/**
 * One normal per triangle corner.
 *
 * The input must be non-indexed; every corner already owns its own vertex, so the
 * face normal is simply copied to all three.
 *
 * @param geometry Non-indexed geometry to read.
 * @returns The face count.
 */
function computeFlatNormals(geometry: BufferGeometry): { faceCount: number } {
  const { position, vertexCount, faceCount } = readGeometry(geometry);
  if (vertexCount === 0) return { faceCount: 0 };

  const normals = new Float32Array(vertexCount * 3);
  const a = scratchA;
  const b = scratchB;
  const c = scratchC;
  const face = scratchFace;

  for (let f = 0; f < faceCount; f++) {
    const ia = f * 3;
    const ib = f * 3 + 1;
    const ic = f * 3 + 2;

    readVertex(position, ia, a);
    readVertex(position, ib, b);
    readVertex(position, ic, c);
    face.copy(b).sub(a).cross(scratchAB.copy(c).sub(a));
    face.normalize();

    for (const vertex of [ia, ib, ic]) {
      normals[vertex * 3] = face.x;
      normals[vertex * 3 + 1] = face.y;
      normals[vertex * 3 + 2] = face.z;
    }
  }

  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3, false, 'static', 'normal'));
  return { faceCount };
}

/**
 * Smooth normals with a hard-edge threshold.
 *
 * Two passes: the first records every face normal, the second averages, for each
 * corner, only those incident faces within `smoothingAngle` of it. That is what
 * produces a hard edge along a cube's seam while keeping a sphere smooth, without
 * splitting any vertices.
 *
 * @param geometry Geometry to read.
 * @param smoothingAngle Threshold in radians.
 * @returns The face count.
 */
function computeAngleWeightedNormals(
  geometry: BufferGeometry,
  smoothingAngle: number,
): { faceCount: number } {
  const { position, index, vertexCount, faceCount } = readGeometry(geometry);
  if (vertexCount === 0) return { faceCount: 0 };

  const faceNormals = new Float32Array(faceCount * 3);
  const a = scratchA;
  const b = scratchB;
  const c = scratchC;
  const face = scratchFace;

  for (let f = 0; f < faceCount; f++) {
    const ia = index ? index[f * 3] : f * 3;
    const ib = index ? index[f * 3 + 1] : f * 3 + 1;
    const ic = index ? index[f * 3 + 2] : f * 3 + 2;

    readVertex(position, ia, a);
    readVertex(position, ib, b);
    readVertex(position, ic, c);
    face.copy(b).sub(a).cross(scratchAB.copy(c).sub(a));
    faceNormals[f * 3] = face.x;
    faceNormals[f * 3 + 1] = face.y;
    faceNormals[f * 3 + 2] = face.z;
  }

  // Vertex -> incident faces, so the second pass is linear rather than quadratic.
  const incident = buildVertexFaceTable(index, vertexCount, faceCount);
  const normals = new Float32Array(vertexCount * 3);
  const cosLimit = Math.cos(smoothingAngle);

  for (let f = 0; f < faceCount; f++) {
    const fx = faceNormals[f * 3];
    const fy = faceNormals[f * 3 + 1];
    const fz = faceNormals[f * 3 + 2];
    const fLength = Math.hypot(fx, fy, fz) || 1;
    const nx = fx / fLength;
    const ny = fy / fLength;
    const nz = fz / fLength;

    const ia = index ? index[f * 3] : f * 3;
    const ib = index ? index[f * 3 + 1] : f * 3 + 1;
    const ic = index ? index[f * 3 + 2] : f * 3 + 2;

    for (const vertex of [ia, ib, ic]) {
      let sumX = 0;
      let sumY = 0;
      let sumZ = 0;

      for (const g of incident[vertex]) {
        const gx = faceNormals[g * 3];
        const gy = faceNormals[g * 3 + 1];
        const gz = faceNormals[g * 3 + 2];
        const gLength = Math.hypot(gx, gy, gz) || 1;
        const dot = (gx / gLength) * nx + (gy / gLength) * ny + (gz / gLength) * nz;
        if (dot < cosLimit) continue;
        sumX += gx;
        sumY += gy;
        sumZ += gz;
      }

      // Several faces share this vertex, so write the same value each time; the
      // last write wins and they are all identical by construction.
      normals[vertex * 3] = sumX;
      normals[vertex * 3 + 1] = sumY;
      normals[vertex * 3 + 2] = sumZ;
    }
  }

  normalizeInPlace(normals, vertexCount);
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3, false, 'static', 'normal'));
  return { faceCount };
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Reads a geometry's position data and index into a convenient shape. */
function readGeometry(geometry: BufferGeometry): {
  position: ArrayLike<number>;
  index: ArrayLike<number> | null;
  stride: number;
  vertexCount: number;
  faceCount: number;
} {
  const positionAttribute = geometry.getAttribute('position');
  const indexAttribute = geometry.getIndex();
  const position = positionAttribute ? positionAttribute.array : new Float32Array(0);
  const stride = positionAttribute && positionAttribute.itemSize > 0 ? positionAttribute.itemSize : 3;
  const vertexCount = positionAttribute
    ? positionAttribute.count > 0
      ? positionAttribute.count
      : Math.floor(position.length / stride)
    : 0;
  const index = indexAttribute ? indexAttribute.array : null;
  const elementCount = index ? index.length : vertexCount;
  return { position, index, stride, vertexCount, faceCount: Math.floor(elementCount / 3) };
}

/** Reads vertex `i` into `target`. */
function readVertex(position: ArrayLike<number>, i: number, target: Vec3): Vec3 {
  const offset = i * 3;
  return target.set(position[offset] ?? 0, position[offset + 1] ?? 0, position[offset + 2] ?? 0);
}

/** Adds a face normal to one vertex's accumulator. */
function accumulate(normals: Float32Array, vertex: number, face: Vec3): void {
  normals[vertex * 3] += face.x;
  normals[vertex * 3 + 1] += face.y;
  normals[vertex * 3 + 2] += face.z;
}

/** Builds vertex -> incident face index table. */
function buildVertexFaceTable(
  index: ArrayLike<number> | null,
  vertexCount: number,
  faceCount: number,
): number[][] {
  const table: number[][] = Array.from({ length: vertexCount }, () => []);
  for (let f = 0; f < faceCount; f++) {
    const ia = index ? (index[f * 3] ?? 0) : f * 3;
    const ib = index ? (index[f * 3 + 1] ?? 0) : f * 3 + 1;
    const ic = index ? (index[f * 3 + 2] ?? 0) : f * 3 + 2;
    table[ia]?.push(f);
    table[ib]?.push(f);
    table[ic]?.push(f);
  }
  return table;
}

/**
 * Normalises flat `[x, y, z, ...]` data in place.
 *
 * A zero-length normal becomes `(0, 0, 1)` rather than `(0, 0, 0)`: a zero normal
 * makes lighting produce `NaN`, while a default one merely looks wrong, and a
 * degenerate triangle is a data bug the caller can find more easily this way.
 *
 * @param array Flat normal data.
 * @param count Number of normals.
 */
export function normalizeInPlace(array: Float32Array, count: number): void {
  for (let i = 0; i < count; i++) {
    const x = array[i * 3];
    const y = array[i * 3 + 1];
    const z = array[i * 3 + 2];
    const length = Math.hypot(x, y, z);
    if (length > 1e-12) {
      array[i * 3] = x / length;
      array[i * 3 + 1] = y / length;
      array[i * 3 + 2] = z / length;
    } else {
      array[i * 3] = 0;
      array[i * 3 + 1] = 0;
      array[i * 3 + 2] = 1;
    }
  }
}

/**
 * Copies an expanded geometry's buffers back onto the original object.
 *
 * The `normal` attribute is included even though the caller just computed it on the
 * expanded copy: skipping it leaves the original holding the normals it had *before*
 * the expansion, whose element count no longer matches the expanded positions. That
 * mismatch is a silent one — the attribute still exists and looks valid — and shows
 * up as garbage shading or a backend error rather than a throw.
 *
 * `setAttribute` disposes the attribute it replaces, so the swap does not leak.
 */
function adoptGeometry(original: BufferGeometry, expanded: BufferGeometry): void {
  // Every attribute the expansion produced, by name; the expansion is a superset of
  // the original's set because `toNonIndexed` copies them all.
  for (const name of expanded.getAttributeNames()) {
    const attribute = expanded.getAttribute(name);
    if (attribute) original.setAttribute(name, attribute);
  }
  original.setIndex(null);
}

/** Scratch vectors reused across faces; never exposed. */
const scratchA = new Vec3();
const scratchB = new Vec3();
const scratchC = new Vec3();
const scratchAB = new Vec3();
const scratchFace = new Vec3();
