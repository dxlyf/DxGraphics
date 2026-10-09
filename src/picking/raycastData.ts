/**
 * `raycastData` — the geometry walkers shared by every 3D picker.
 *
 * These are deliberately plain functions over structural geometry. The scene
 * graph's own `Mesh.raycast`, `Line.raycast` and `Points.raycast` implement the
 * same algorithms against the same interfaces, so a caller can pick with either
 * layer and get identical results:
 *
 * ```
 * Raycaster ──uses──> raycastObject ──uses──> raycastTriangles / raycastLine / raycastPoints
 *                            ▲
 * MeshPicker ────────────────┘
 * ```
 *
 * All work happens in the object's **local space**: the ray is transformed in once
 * by the caller, and the resulting hit point is transformed back out. That keeps
 * the per-triangle cost to a dot product and two cross products.
 *
 * @packageDocumentation
 */

import { Vec2 } from '../math/Vec2';
import { Vec3 } from '../math/Vec3';
import type { AttributeLike, GeometryLike, IntersectionLike } from './types';

/** A ray expressed in an object's local space. */
export interface LocalRay {
  /** Local-space origin. */
  origin: Vec3;
  /** Local-space unit direction. */
  direction: Vec3;
  /** Minimum distance along the ray. */
  near: number;
  /** Maximum distance along the ray. */
  far: number;
}

/** Scratch vectors reused by every walker; never handed out. */
const scratchA = new Vec3();
const scratchB = new Vec3();
const scratchC = new Vec3();
const scratchEdge1 = new Vec3();
const scratchEdge2 = new Vec3();
const scratchP = new Vec3();
const scratchT = new Vec3();
const scratchQ = new Vec3();
const scratchNormal = new Vec3();
const scratchUvA = new Vec2();
const scratchUvB = new Vec2();
const scratchUvC = new Vec2();

/**
 * Reads one vertex into `target`.
 *
 * Works with a `BufferAttribute` (`getX`/`getY`/`getZ`) or with a bare array plus
 * an `itemSize`.
 *
 * @param attribute Attribute to read.
 * @param index Vertex index.
 * @param target Vector to write; a new one is allocated when omitted.
 * @returns `target`.
 */
export function readVertex(attribute: AttributeLike, index: number, target: Vec3 = new Vec3()): Vec3 {
  const x = attribute.getX?.(index);
  const y = attribute.getY?.(index);
  const z = attribute.getZ?.(index);
  if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
    return target.set(x, y, z);
  }

  const array = attribute.array;
  const stride = attribute.itemSize > 0 ? attribute.itemSize : 3;
  const offset = index * stride;
  return target.set(array[offset] ?? 0, array[offset + 1] ?? 0, array[offset + 2] ?? 0);
}

/**
 * Reads one 2-component texel into `target`.
 *
 * @param attribute Attribute to read.
 * @param index Element index.
 * @param target Vector to write.
 * @returns `target`.
 */
export function readUv(attribute: AttributeLike, index: number, target: Vec2 = new Vec2()): Vec2 {
  const array = attribute.array;
  const stride = attribute.itemSize > 0 ? attribute.itemSize : 2;
  const offset = index * stride;
  return target.set(array[offset] ?? 0, array[offset + 1] ?? 0);
}

/**
 * Normalises a geometry's index buffer into a flat index view.
 *
 * @param geometry Geometry to inspect.
 * @returns The indices, or `null` for a non-indexed geometry.
 */
export function readIndices(geometry: GeometryLike): ArrayLike<number> | null {
  const index = geometry.index;
  if (index === undefined || index === null) return null;
  if (Array.isArray(index)) return index;
  if (ArrayBuffer.isView(index)) return index as unknown as ArrayLike<number>;
  const attribute = index as AttributeLike;
  return attribute.array ?? null;
}

/**
 * The geometry's position attribute, or `null` when it has none.
 *
 * @param geometry Geometry to inspect.
 * @returns The position attribute.
 */
export function readPositions(geometry: GeometryLike): AttributeLike | null {
  return geometry.position ?? geometry.attributes?.position ?? null;
}

/**
 * Möller-Trumbore ray/triangle intersection.
 *
 * @param ray Ray in the triangle's own space.
 * @param a First vertex.
 * @param b Second vertex.
 * @param c Third vertex.
 * @param backfaceCulling Discard triangles whose normal faces away from the ray.
 * @param epsilon Parallel-denominator tolerance.
 * @returns The hit, or `null`.
 */
export function intersectTriangle(
  ray: LocalRay,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  backfaceCulling = false,
  epsilon = 1e-12,
): { distance: number; barycoord: [number, number, number] } | null {
  scratchEdge1.subVectors(b, a);
  scratchEdge2.subVectors(c, a);
  scratchP.crossVectors(ray.direction, scratchEdge2);

  const determinant = scratchEdge1.dot(scratchP);
  if (backfaceCulling) {
    if (determinant <= epsilon) return null;
  } else if (Math.abs(determinant) <= epsilon) {
    // Ray is parallel to the triangle plane.
    return null;
  }

  const inverse = 1 / determinant;
  scratchT.subVectors(ray.origin, a);
  const u = scratchT.dot(scratchP) * inverse;
  if (u < 0 || u > 1) return null;

  scratchQ.crossVectors(scratchT, scratchEdge1);
  const v = ray.direction.dot(scratchQ) * inverse;
  if (v < 0 || u + v > 1) return null;

  const distance = scratchEdge2.dot(scratchQ) * inverse;
  if (distance < ray.near || distance > ray.far) return null;

  // Barycentric weights: `u` weights `b`, `v` weights `c`, the rest weights `a`.
  return { distance, barycoord: [1 - u - v, u, v] };
}

/**
 * Walks every triangle of a geometry, invoking `callback` per triangle.
 *
 * The draw range and the index buffer are both honoured, so a geometry that only
 * draws a slice of its buffer is tested on exactly that slice.
 *
 * @param geometry Geometry to walk.
 * @param callback Receives the three vertex indices and the face index.
 * @param materialIndex When set, only the matching groups are walked.
 * @returns The number of triangles tested.
 */
export function forEachTriangle(
  geometry: GeometryLike,
  callback: (i0: number, i1: number, i2: number, faceIndex: number) => void,
  materialIndex?: number,
): number {
  const positions = readPositions(geometry);
  if (positions === null) return 0;

  const indices = readIndices(geometry);
  const vertexCount = positions.count ?? Math.floor(positions.array.length / Math.max(1, positions.itemSize));
  const drawRange = geometry.drawRange;
  const groups = geometry.groups;

  let triStart = 0;
  let triEnd: number;

  if (indices !== null) {
    triEnd = Math.floor(indices.length / 3);
  } else {
    triEnd = Math.floor(vertexCount / 3);
  }

  if (drawRange !== undefined && drawRange.count > 0 && drawRange.count !== Infinity) {
    // Draw ranges are expressed in vertices for indexed geometry and in vertices
    // for non-indexed geometry alike; convert to a triangle window.
    const startVertex = Math.max(0, drawRange.start);
    const endVertex = Math.min(
      indices !== null ? indices.length : vertexCount,
      startVertex + drawRange.count,
    );
    triStart = Math.floor(startVertex / 3);
    triEnd = Math.floor(endVertex / 3);
  }

  let tested = 0;
  let faceIndex = triStart;

  for (let triangle = triStart; triangle < triEnd; triangle++) {
    const base = triangle * 3;
    let i0: number;
    let i1: number;
    let i2: number;

    if (indices !== null) {
      i0 = indices[base] ?? 0;
      i1 = indices[base + 1] ?? 0;
      i2 = indices[base + 2] ?? 0;
    } else {
      i0 = base;
      i1 = base + 1;
      i2 = base + 2;
    }

    if (
      materialIndex !== undefined &&
      groups !== undefined &&
      groups.length > 0 &&
      !groupMatches(groups, base, materialIndex)
    ) {
      faceIndex++;
      continue;
    }

    callback(i0, i1, i2, faceIndex);
    faceIndex++;
    tested++;
  }

  return tested;
}

/** `true` when `elementIndex` falls inside a group with the requested material. */
function groupMatches(
  groups: readonly { start: number; count: number; materialIndex?: number }[],
  elementIndex: number,
  materialIndex: number,
): boolean {
  for (const group of groups) {
    if ((group.materialIndex ?? 0) !== materialIndex) continue;
    if (elementIndex >= group.start && elementIndex < group.start + group.count) return true;
  }
  return false;
}

/**
 * Tests a geometry against a local ray, appending every hit.
 *
 * @param geometry Geometry to test.
 * @param ray Local-space ray.
 * @param object Object recorded on each hit.
 * @param intersects Destination array.
 * @param options UV/normal interpolation and culling flags.
 * @param worldMatrix Transform applied to local hit points before recording.
 * @returns The number of hits appended.
 */
export function raycastTriangles(
  geometry: GeometryLike,
  ray: LocalRay,
  object: unknown,
  intersects: IntersectionLike[],
  options: {
    uv?: boolean;
    normals?: boolean;
    backfaceCulling?: boolean;
    materialIndex?: number;
    worldMatrix?: { elements: ArrayLike<number> };
  } = {},
): number {
  const positions = readPositions(geometry);
  if (positions === null) return 0;

  const uvAttribute = options.uv === false ? null : (geometry.attributes?.uv ?? null);
  const normalAttribute = options.normals === false ? null : (geometry.attributes?.normal ?? null);
  const elementCount = intersects.length;

  const a = scratchA;
  const b = scratchB;
  const c = scratchC;
  const edge1 = scratchEdge1;
  const edge2 = scratchEdge2;
  const faceNormal = scratchNormal;

  forEachTriangle(
    geometry,
    (i0, i1, i2, faceIndex) => {
      readVertex(positions, i0, a);
      readVertex(positions, i1, b);
      readVertex(positions, i2, c);

      const hit = intersectTriangle(ray, a, b, c, options.backfaceCulling ?? false);
      if (hit === null) return;

      const point = new Vec3(
        ray.origin.x + ray.direction.x * hit.distance,
        ray.origin.y + ray.direction.y * hit.distance,
        ray.origin.z + ray.direction.z * hit.distance,
      );

      const record: IntersectionLike = {
        distance: hit.distance,
        point,
        object,
        faceIndex,
        barycoord: hit.barycoord,
        type: 'mesh',
      };

      const [w0, w1, w2] = hit.barycoord;

      if (uvAttribute !== null) {
        const uvA = readUv(uvAttribute, i0, scratchUvA);
        const uvB = readUv(uvAttribute, i1, scratchUvB);
        const uvC = readUv(uvAttribute, i2, scratchUvC);
        record.uv = new Vec2(
          uvA.x * w0 + uvB.x * w1 + uvC.x * w2,
          uvA.y * w0 + uvB.y * w1 + uvC.y * w2,
        );
      }

      if (normalAttribute !== null) {
        const nA = readVertex(normalAttribute, i0, scratchP);
        const nB = readVertex(normalAttribute, i1, scratchQ);
        const nC = readVertex(normalAttribute, i2, scratchT);
        record.normal = new Vec3(
          nA.x * w0 + nB.x * w1 + nC.x * w2,
          nA.y * w0 + nB.y * w1 + nC.y * w2,
          nA.z * w0 + nB.z * w1 + nC.z * w2,
        ).normalize();
      } else {
        edge1.subVectors(b, a);
        edge2.subVectors(c, a);
        faceNormal.crossVectors(edge1, edge2).normalize();
        record.normal = faceNormal.clone();
      }

      if (options.worldMatrix !== undefined) {
        point.applyMat4(options.worldMatrix);
      }

      intersects.push(record);
    },
    options.materialIndex,
  );

  return intersects.length - elementCount;
}

/**
 * Tests a line strip or segment list against a local ray.
 *
 * A hit is recorded when the ray's closest approach to a segment is within
 * `threshold`, which is the standard "fat line" picking model.
 *
 * @param geometry Geometry holding the vertex positions.
 * @param ray Local-space ray.
 * @param object Object recorded on each hit.
 * @param intersects Destination array.
 * @param threshold Hit radius in world units.
 * @param segments `true` for a segment list, `false` for a strip.
 * @param worldMatrix Transform applied to local hit points before recording.
 * @returns The number of hits appended.
 */
export function raycastLine(
  geometry: GeometryLike,
  ray: LocalRay,
  object: unknown,
  intersects: IntersectionLike[],
  threshold: number,
  segments: boolean,
  worldMatrix?: { elements: ArrayLike<number> },
): number {
  const positions = readPositions(geometry);
  if (positions === null) return 0;

  const indices = readIndices(geometry);
  const vertexCount = positions.count ?? Math.floor(positions.array.length / Math.max(1, positions.itemSize));
  const elementCount = indices !== null ? indices.length : vertexCount;
  const before = intersects.length;

  const start = scratchA;
  const end = scratchB;
  const delta = scratchEdge1;
  const toOrigin = scratchEdge2;
  const closest = scratchP;
  const hitPoint = scratchQ;

  const step = segments ? 2 : 1;
  for (let i = 0; i + 1 < elementCount; i += step) {
    const i0 = indices !== null ? (indices[i] ?? 0) : i;
    const i1 = indices !== null ? (indices[i + 1] ?? 0) : i + 1;

    readVertex(positions, i0, start);
    readVertex(positions, i1, end);

    delta.subVectors(end, start);
    toOrigin.subVectors(ray.origin, start);

    const lengthSq = delta.lengthSquared();
    if (lengthSq <= 1e-20) continue;

    // Closest approach between the segment and the ray. Solving
    //   (p + s*d - t*r) . d = 0,  (p + s*d - t*r) . r = 0
    // gives a determinant of `lengthSq - d.d` for a unit `r`.
    const directionDotDelta = ray.direction.dot(delta);
    const determinant = lengthSq - directionDotDelta * directionDotDelta;
    if (Math.abs(determinant) < 1e-12) continue;

    const deltaDotOrigin = delta.dot(toOrigin);
    const rayDotOrigin = ray.direction.dot(toOrigin);

    let segmentParam = (directionDotDelta * rayDotOrigin - deltaDotOrigin) / determinant;
    segmentParam = segmentParam < 0 ? 0 : segmentParam > 1 ? 1 : segmentParam;

    let rayParam = directionDotDelta * segmentParam - rayDotOrigin;
    rayParam = rayParam < ray.near ? ray.near : rayParam > ray.far ? ray.far : rayParam;

    closest.copy(delta).multiplyScalar(segmentParam).add(start);

    hitPoint.set(
      ray.origin.x + ray.direction.x * rayParam,
      ray.origin.y + ray.direction.y * rayParam,
      ray.origin.z + ray.direction.z * rayParam,
    );

    if (hitPoint.distanceTo(closest) > threshold) continue;

    const point = new Vec3(hitPoint.x, hitPoint.y, hitPoint.z);
    if (worldMatrix !== undefined) point.applyMat4(worldMatrix);

    intersects.push({
      distance: rayParam,
      point,
      object,
      type: 'line',
      faceIndex: segments ? Math.floor(i / 2) : i,
    });
  }

  return intersects.length - before;
}

/**
 * Tests a point cloud against a local ray.
 *
 * @param geometry Geometry holding the vertex positions.
 * @param ray Local-space ray.
 * @param object Object recorded on each hit.
 * @param intersects Destination array.
 * @param threshold Hit radius in world units.
 * @param worldMatrix Transform applied to local hit points before recording.
 * @returns The number of hits appended.
 */
export function raycastPoints(
  geometry: GeometryLike,
  ray: LocalRay,
  object: unknown,
  intersects: IntersectionLike[],
  threshold: number,
  worldMatrix?: { elements: ArrayLike<number> },
): number {
  const positions = readPositions(geometry);
  if (positions === null) return 0;

  const count = positions.count ?? Math.floor(positions.array.length / Math.max(1, positions.itemSize));
  const before = intersects.length;
  const point = scratchA;
  const toPoint = scratchB;

  for (let i = 0; i < count; i++) {
    readVertex(positions, i, point);
    toPoint.subVectors(point, ray.origin);
    const along = toPoint.dot(ray.direction);
    if (along < ray.near || along > ray.far) continue;

    const closestDistance = Math.sqrt(Math.max(0, toPoint.lengthSquared() - along * along));
    if (closestDistance > threshold) continue;

    const world = new Vec3(
      ray.origin.x + ray.direction.x * along,
      ray.origin.y + ray.direction.y * along,
      ray.origin.z + ray.direction.z * along,
    );
    if (worldMatrix !== undefined) world.applyMat4(worldMatrix);

    intersects.push({ distance: along, point: world, object, type: 'points', faceIndex: i });
  }

  return intersects.length - before;
}

/**
 * Computes a world-space hit point from a local hit point.
 *
 * @param point Local-space point; mutated in place.
 * @param worldMatrix World matrix, or `undefined` for an identity transform.
 * @returns The mutated point.
 */
export function toWorldPoint(point: Vec3, worldMatrix?: { elements: ArrayLike<number> }): Vec3 {
  if (worldMatrix !== undefined) point.applyMat4(worldMatrix);
  return point;
}
