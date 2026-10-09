/**
 * `computeBoundingBox` — bounding box from a geometry's `position` attribute.
 *
 * Split out from the shared helpers so it can be imported on its own (the
 * generators and the asset loaders want the box without the sphere, and this
 * keeps their import graph minimal).
 *
 * @packageDocumentation
 */

import { Box3 } from '../../../math/Box3';
import { computeBoundingBox as compute } from './computeBoundingVolume';
import type { BoundsGeometryLike } from './computeBoundingVolume';
import type { Vec3 } from '../../../math/Vec3';

export type { BoundsGeometryLike };

/**
 * Computes a geometry's local-space bounding box.
 *
 * Only the drawn range contributes, so a geometry that reuses a large buffer for
 * a small range reports the bounds of what is actually rendered. Missing position
 * data produces the empty box, which every downstream test treats as
 * "uncullable".
 *
 * @param geometry Geometry-like source.
 * @param target Box to write into.
 * @returns The populated box.
 */
export function computeBoundingBox(geometry: BoundsGeometryLike, target: Box3 = new Box3()): Box3 {
  return compute(geometry, target);
}

/**
 * Computes the bounding box of an explicit list of points.
 *
 * @param points Vertex positions.
 * @param target Box to write into.
 * @returns The populated box; empty for an empty input.
 */
export function computeBoundingBoxFromPoints(
  points: readonly Vec3[],
  target: Box3 = new Box3(),
): Box3 {
  target.makeEmpty();
  for (const point of points) {
    if (point.x < target.min.x) target.min.x = point.x;
    if (point.y < target.min.y) target.min.y = point.y;
    if (point.z < target.min.z) target.min.z = point.z;
    if (point.x > target.max.x) target.max.x = point.x;
    if (point.y > target.max.y) target.max.y = point.y;
    if (point.z > target.max.z) target.max.z = point.z;
  }
  return target;
}
