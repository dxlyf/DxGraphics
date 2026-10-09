/**
 * Bounding-volume helpers for geometry.
 *
 * These are the single source of truth for "what are the local bounds of this
 * geometry". `BufferGeometry` calls them, and so do the generators and the
 * picking layer, so the definition of a bounding sphere lives in exactly one
 * place.
 *
 * @packageDocumentation
 */

import { Box3 } from '../../../math/Box3';
import { Sphere } from '../../../math/Sphere';
import { Vec3 } from '../../../math/Vec3';
import type { BufferGeometry } from '../../core/BufferGeometry';
import type { AnyBufferAttribute } from '../../core/types';

/** The minimal geometry view these helpers need. */
export interface BoundsGeometryLike {
  /** Attribute lookup by name. */
  getAttribute(name: string): AnyBufferAttribute | undefined;
  /** Index buffer lookup. */
  getIndex(): AnyBufferAttribute | undefined;
  /** Sub-range actually drawn. */
  drawRange?: { start: number; count: number };
}

/**
 * Computes the local-space bounding box from a geometry's `position` attribute.
 *
 * Only the vertices inside the draw range are considered, so a geometry that
 * reuses a large buffer but draws a small range reports the bounds of what is
 * actually rendered. An empty or missing position attribute yields the empty box
 * (`min = +Infinity`, `max = -Infinity`), which every downstream test treats as
 * "nothing to cull".
 *
 * @param geometry Geometry-like source.
 * @param target Box to write into; a new one is allocated when omitted.
 * @returns The populated box.
 */
export function computeBoundingBox(
  geometry: BoundsGeometryLike,
  target: Box3 = new Box3(),
): Box3 {
  const position = geometry.getAttribute('position');
  target.makeEmpty();
  if (!position) return target;

  const array = position.array;
  const stride = position.itemSize > 0 ? position.itemSize : 3;
  const total = position.count > 0 ? position.count : Math.floor(array.length / stride);
  const { start, count } = resolveDrawRange(geometry, total);
  const end = Math.min(total, start + count);

  for (let i = start; i < end; i++) {
    const offset = i * stride;
    const x = array[offset] ?? 0;
    const y = array[offset + 1] ?? 0;
    const z = array[offset + 2] ?? 0;

    if (x < target.min.x) target.min.x = x;
    if (y < target.min.y) target.min.y = y;
    if (z < target.min.z) target.min.z = z;
    if (x > target.max.x) target.max.x = x;
    if (y > target.max.y) target.max.y = y;
    if (z > target.max.z) target.max.z = z;
  }

  return target;
}

/**
 * Computes the local-space bounding sphere.
 *
 * The sphere is centred on the bounding box and sized to the farthest vertex, so
 * it **contains** every vertex but is not the minimal enclosing sphere. That is
 * deliberate: containment is the property culling and picking need, and the
 * minimal sphere costs an order of magnitude more to compute.
 *
 * @param geometry Geometry-like source.
 * @param target Sphere to write into; a new one is allocated when omitted.
 * @returns The populated sphere. Radius is `0` when there is no position data.
 */
export function computeBoundingSphere(
  geometry: BoundsGeometryLike,
  target: Sphere = new Sphere(),
): Sphere {
  const position = geometry.getAttribute('position');
  if (!position) return target.makeEmpty();

  const box = computeBoundingBox(geometry, scratchBox);
  const center = box.getCenter(scratchCenter);

  // A degenerate (single-point) geometry has a zero-size box; the sphere is then
  // that point with radius 0, which is correct and lets callers short-circuit.
  if (box.isEmpty()) return target.makeEmpty();

  const array = position.array;
  const stride = position.itemSize > 0 ? position.itemSize : 3;
  const total = position.count > 0 ? position.count : Math.floor(array.length / stride);
  const { start, count } = resolveDrawRange(geometry, total);
  const end = Math.min(total, start + count);

  let maxSquared = 0;
  for (let i = start; i < end; i++) {
    const offset = i * stride;
    const dx = (array[offset] ?? 0) - center.x;
    const dy = (array[offset + 1] ?? 0) - center.y;
    const dz = (array[offset + 2] ?? 0) - center.z;
    const distance = dx * dx + dy * dy + dz * dz;
    if (distance > maxSquared) maxSquared = distance;
  }

  target.center.copy(center);
  target.radius = Math.sqrt(maxSquared);
  return target;
}

/**
 * Computes the bounding sphere directly from a point cloud.
 *
 * Used by the generators, which know their vertices before the geometry exists.
 *
 * @param points Vertex positions.
 * @param target Sphere to write into.
 * @returns The populated sphere; empty for an empty input.
 */
export function computeBoundingSphereFromPoints(
  points: readonly Vec3[],
  target: Sphere = new Sphere(),
): Sphere {
  if (points.length === 0) return target.makeEmpty();

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.z < minZ) minZ = point.z;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
    if (point.z > maxZ) maxZ = point.z;
  }

  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;

  let maxSquared = 0;
  for (const point of points) {
    const dx = point.x - cx;
    const dy = point.y - cy;
    const dz = point.z - cz;
    const distance = dx * dx + dy * dy + dz * dz;
    if (distance > maxSquared) maxSquared = distance;
  }

  target.center.set(cx, cy, cz);
  target.radius = Math.sqrt(maxSquared);
  return target;
}

/**
 * Resolves a geometry's draw range into `{ start, count }`.
 *
 * `drawRange.count` is `Infinity` for "everything", which is the `BufferGeometry`
 * default; this turns that into the concrete vertex count so the loops above can
 * be bounded.
 *
 * @param geometry Geometry-like source.
 * @param total Total number of vertices available.
 * @returns A concrete, clamped range.
 */
export function resolveDrawRange(
  geometry: { drawRange?: { start: number; count: number } },
  total: number,
): { start: number; count: number } {
  const range = geometry.drawRange;
  if (!range) return { start: 0, count: total };
  const start = Math.max(0, Math.min(range.start, total));
  const available = total - start;
  const count = Number.isFinite(range.count) ? Math.max(0, Math.min(range.count, available)) : available;
  return { start, count };
}

/**
 * Returns the number of vertices in a geometry.
 *
 * Prefers `position.count` and falls back to the array length divided by the
 * item size, which matters for hand-built attributes where `count` was not set.
 *
 * @param geometry Geometry-like source.
 */
export function getVertexCount(geometry: BoundsGeometryLike): number {
  const position = geometry.getAttribute('position');
  if (!position) return 0;
  if (position.count > 0) return position.count;
  const stride = position.itemSize > 0 ? position.itemSize : 3;
  return Math.floor(position.array.length / stride);
}

/**
 * Returns the number of triangles the geometry draws.
 *
 * Indexed geometry reports `index.count / 3`, so a shared-vertex mesh reports the
 * same count as the equivalent triangle soup.
 *
 * @param geometry Geometry-like source.
 */
export function getTriangleCount(geometry: BoundsGeometryLike): number {
  const index = geometry.getIndex();
  if (index) return Math.floor(index.count / 3);
  return Math.floor(getVertexCount(geometry) / 3);
}

/** Scratch values reused by the helpers above; never exposed. */
const scratchBox = new Box3();
const scratchCenter = new Vec3();

/** Re-exported so callers can type their own `BoundsGeometryLike` producers. */
export type { BufferGeometry };
