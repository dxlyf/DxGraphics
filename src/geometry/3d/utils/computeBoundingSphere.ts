/**
 * `computeBoundingSphere` — bounding sphere from a geometry's `position`
 * attribute, plus the point-cloud variant the generators use.
 *
 * @packageDocumentation
 */

import { Sphere } from '../../../math/Sphere';
import {
  computeBoundingSphere as compute,
  computeBoundingSphereFromPoints,
} from './computeBoundingVolume';
import type { BoundsGeometryLike } from './computeBoundingVolume';
import type { Vec3 } from '../../../math/Vec3';

export type { BoundsGeometryLike };
export { computeBoundingSphereFromPoints };

/**
 * Computes a geometry's local-space bounding sphere.
 *
 * The sphere is centred on the bounding box and sized to the farthest vertex, so
 * it **contains** every vertex without being the minimal enclosing sphere.
 * Containment is the property culling and picking rely on, and it costs one pass
 * instead of the minimal sphere's iterative solve.
 *
 * @param geometry Geometry-like source.
 * @param target Sphere to write into.
 * @returns The populated sphere.
 */
export function computeBoundingSphere(
  geometry: BoundsGeometryLike,
  target: Sphere = new Sphere(),
): Sphere {
  return compute(geometry, target);
}

/**
 * Fits a sphere around a list of points.
 *
 * @param points Vertex positions.
 * @param target Sphere to write into.
 * @returns The populated sphere; empty for an empty input.
 */
export function boundingSphereFromPoints(
  points: readonly Vec3[],
  target: Sphere = new Sphere(),
): Sphere {
  return computeBoundingSphereFromPoints(points, target);
}
