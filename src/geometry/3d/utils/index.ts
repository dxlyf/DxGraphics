/**
 * Geometry utilities: bounds, normals, tangents, merging and wireframes.
 *
 * Every helper takes a `BufferGeometry` (or a structural view of one) and either
 * mutates it in place or returns a new one. None allocate per vertex beyond the
 * buffer they produce.
 *
 * The barrel re-exports `computeBoundingBox` / `computeBoundingSphere` from their
 * dedicated modules rather than from `computeBoundingVolume`, so the public names
 * are unambiguous while the shared implementation stays in one place.
 *
 * @packageDocumentation
 */

export type { BoundsGeometryLike } from './computeBoundingVolume';
export {
  resolveDrawRange,
  getVertexCount,
  getTriangleCount,
} from './computeBoundingVolume';

export { computeBoundingBox, computeBoundingBoxFromPoints } from './computeBoundingBox';
export {
  computeBoundingSphere,
  computeBoundingSphereFromPoints,
  boundingSphereFromPoints,
} from './computeBoundingSphere';

export { computeNormals, normalizeInPlace } from './computeNormals';
export type { ComputeNormalsOptions, ComputeNormalsResult } from './computeNormals';

export { computeTangents, perpendicularTo } from './computeTangents';
export type { ComputeTangentsOptions, ComputeTangentsResult } from './computeTangents';

export {
  mergeGeometries,
  mergeGeometriesOrThrow,
  NEUTRAL_ATTRIBUTE_VALUES,
} from './mergeGeometries';
export type { MergeGeometriesOptions, MergeGeometriesResult } from './mergeGeometries';

export { toWireframe, toWireframeGeometry } from './toWireframe';
export type { WireframeOptions, WireframeResult } from './toWireframe';

export { correctWinding } from './correctWinding';
export type { CorrectWindingResult } from './correctWinding';
