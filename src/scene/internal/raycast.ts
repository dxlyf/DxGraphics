/**
 * Shared raycasting primitives for the 3D scene nodes.
 *
 * `src/picking` (the real `Raycaster`) did not exist while this layer was
 * written, so the intersection kernels live here and operate on the structural
 * {@link RaycasterLike} contract. Every kernel is allocation-free and writes
 * into caller-supplied scratch vectors.
 *
 * @packageDocumentation
 */

import { EPSILON } from '../../constants';
import { Mat4 } from '../../math/Mat4';
import { Vec3 } from '../../math/Vec3';
import type { AttributeLike, GeometryLike, MaterialLike, RaycasterLike } from '../3d/types';

/** Scratch matrix shared by {@link toLocalRay}; the caller must not retain it. */
const inverseWorld = new Mat4();

/** Scratch end point used by {@link toLocalRay}. */
const localRayEnd = new Vec3();

/**
 * Moves `raycaster`'s ray into the local frame of `object`.
 *
 * The origin is transformed as a point and the direction by transforming a
 * second point one unit along the ray and subtracting, which keeps a unit
 * direction unit-length even when `object` is scaled.
 *
 * @param object Matrix source; `matrixWorld` defines the frame.
 * @param raycaster Source of the world-space ray.
 * @param origin Receives the local-space origin.
 * @param direction Receives the local-space direction (normalised).
 * @returns `true` when the frame is invertible.
 */
export function toLocalRay(
  object: {
    updateWorldMatrix(updateParents: boolean, updateChildren: boolean): void;
    matrixWorld: Mat4;
  },
  raycaster: RaycasterLike,
  origin: Vec3,
  direction: Vec3,
): boolean {
  object.updateWorldMatrix(true, false);
  inverseWorld.copy(object.matrixWorld).invert();
  if (!inverseWorld.isInvertible()) return false;

  const worldOrigin = raycaster.ray.origin;
  const worldDirection = raycaster.ray.direction;
  origin.copy(worldOrigin).applyMat4(inverseWorld);
  localRayEnd
    .set(
      worldOrigin.x + worldDirection.x,
      worldOrigin.y + worldDirection.y,
      worldOrigin.z + worldDirection.z,
    )
    .applyMat4(inverseWorld);
  direction.copy(localRayEnd).sub(origin).normalize();
  return true;
}

/**
 * Moeller-Trumbore ray/triangle intersection.
 *
 * @param origin Ray origin.
 * @param direction Ray direction; not required to be unit length, but the
 *   returned parameter is expressed in units of `direction`.
 * @param a,b,c Triangle vertices.
 * @param backfaceCulling When `true`, triangles facing away from the ray are
 *   rejected.
 * @param target Receives the hit point when the test succeeds.
 * @returns The hit point (`target`), or `null`.
 */
export function rayIntersectsTriangle(
  origin: Vec3,
  direction: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  backfaceCulling: boolean,
  target: Vec3,
): Vec3 | null {
  const edge1x = b.x - a.x;
  const edge1y = b.y - a.y;
  const edge1z = b.z - a.z;
  const edge2x = c.x - a.x;
  const edge2y = c.y - a.y;
  const edge2z = c.z - a.z;

  // pvec = direction x edge2
  const pvecX = direction.y * edge2z - direction.z * edge2y;
  const pvecY = direction.z * edge2x - direction.x * edge2z;
  const pvecZ = direction.x * edge2y - direction.y * edge2x;

  const det = edge1x * pvecX + edge1y * pvecY + edge1z * pvecZ;
  if (backfaceCulling) {
    if (det < EPSILON) return null;
  } else if (det > -EPSILON && det < EPSILON) {
    return null;
  }

  const invDet = 1 / det;
  const tvecX = origin.x - a.x;
  const tvecY = origin.y - a.y;
  const tvecZ = origin.z - a.z;

  const u = (tvecX * pvecX + tvecY * pvecY + tvecZ * pvecZ) * invDet;
  if (u < 0 || u > 1) return null;

  // qvec = tvec x edge1
  const qvecX = tvecY * edge1z - tvecZ * edge1y;
  const qvecY = tvecZ * edge1x - tvecX * edge1z;
  const qvecZ = tvecX * edge1y - tvecY * edge1x;

  const v = (direction.x * qvecX + direction.y * qvecY + direction.z * qvecZ) * invDet;
  if (v < 0 || u + v > 1) return null;

  const t = (edge2x * qvecX + edge2y * qvecY + edge2z * qvecZ) * invDet;
  if (t < 0) return null;

  return target.set(
    origin.x + direction.x * t,
    origin.y + direction.y * t,
    origin.z + direction.z * t,
  );
}

/** Reads the backing array of an index buffer (attribute or raw array). */
function indexArrayOf(index: AttributeLike | ArrayLike<number>): ArrayLike<number> {
  return (index as AttributeLike).array ?? (index as ArrayLike<number>);
}

/** Reads the number of elements in an index buffer (attribute or raw array). */
export function indexItemCount(index: AttributeLike | ArrayLike<number>): number {
  return indexArrayOf(index).length;
}

/** Reads index `i` from an index buffer (attribute or raw array). */
export function indexValueAt(index: AttributeLike | ArrayLike<number>, i: number): number {
  return indexArrayOf(index)[i] ?? 0;
}

/** Returns the `position` attribute of a geometry, or `null` when absent. */
export function getPositionAttribute(
  geometry: GeometryLike | null | undefined,
): AttributeLike | null {
  if (!geometry) return null;
  return geometry.position ?? geometry.attributes.position ?? null;
}

/** Returns the `uv` attribute of a geometry, or `null` when absent. */
export function getUvAttribute(geometry: GeometryLike | null | undefined): AttributeLike | null {
  if (!geometry) return null;
  return geometry.attributes.uv ?? null;
}

/** Reads vertex `i` from a 3-component attribute into `target`. */
export function readVertex(attribute: AttributeLike, i: number, target: Vec3): Vec3 {
  if (typeof attribute.getX === 'function') {
    target.set(attribute.getX(i), attribute.getY?.(i) ?? 0, attribute.getZ?.(i) ?? 0);
    return target;
  }
  const array = attribute.array;
  const offset = i * attribute.itemSize;
  return target.set(array[offset] ?? 0, array[offset + 1] ?? 0, array[offset + 2] ?? 0);
}

/** Reads UV pair `i` from a 2-component attribute into `target`. */
export function readUv(attribute: AttributeLike, i: number, target: { x: number; y: number }): void {
  const array = attribute.array;
  const offset = i * attribute.itemSize;
  target.x = array[offset] ?? 0;
  target.y = array[offset + 1] ?? 0;
}

/** `true` when a material hides its object from any picking pass. */
export function isMaterialVisible(material: MaterialLike | undefined): boolean {
  return material?.visible !== false;
}

/** Returns the single material of an object, or the first of an array. */
export function firstMaterial(
  material: MaterialLike | readonly MaterialLike[] | null | undefined,
): MaterialLike | undefined {
  if (!material) return undefined;
  return Array.isArray(material)
    ? (material as readonly MaterialLike[])[0]
    : (material as MaterialLike);
}

/** Point threshold used by `Points` and `Sprite3D`; defaults to `1`. */
export function pointThreshold(raycaster: RaycasterLike): number {
  const threshold = raycaster.params?.Points?.threshold;
  return typeof threshold === 'number' && threshold > 0 ? threshold : 1;
}

/** Threshold used by `Line` and `LineSegments`; defaults to `0`. */
export function lineThreshold(raycaster: RaycasterLike): number {
  const threshold = raycaster.params?.Line?.threshold;
  return typeof threshold === 'number' && threshold >= 0 ? threshold : 0;
}

/** `true` when the raycaster's layer mask intersects `layers`. */
export function passesLayerTest(raycaster: RaycasterLike, layers: number): boolean {
  const mask = raycaster.layers;
  if (mask === undefined) return true;
  return (mask & layers) !== 0;
}

/** `true` when `distance` falls inside the raycaster's near/far range, inclusive. */
export function withinRayRange(raycaster: RaycasterLike, distance: number): boolean {
  const near = raycaster.near ?? 0;
  const far = raycaster.far ?? Infinity;
  return distance >= near && distance <= far;
}
