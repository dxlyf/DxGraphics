/**
 * `MeshPicker` — precise, reusable ray/triangle tests.
 *
 * `Raycaster` covers *traversal*: which objects to test and in what order.
 * `MeshPicker` covers *precision*: given one geometry, one ray and one world
 * matrix, which triangles were hit, where exactly, and with what UV and barycentric
 * coordinates.
 *
 * It is the piece a tool wants when it needs more than "distance and object":
 * snapping to a surface, placing a decal, reading the UV under the cursor, or
 * measuring a bend angle from the interpolated normal. It is a plain function object
 * — no scene graph required — which is why the test suite builds a triangle by hand
 * and picks it directly.
 *
 * ```ts
 * const picker = new MeshPicker();
 * const hits = picker.pick(geometry, ray, { uv: true });
 * hits[0]?.barycoord;   // [w0, w1, w2]
 * hits[0]?.uv;          // interpolated texture coordinate
 * ```
 *
 * ## Algorithm
 *
 * Möller-Trumbore, in the object's local space: transform the ray once by the
 * inverse world matrix, test every triangle, then transform the winning point back.
 * That costs one matrix inversion per geometry rather than one per triangle.
 *
 * @packageDocumentation
 */

import { Mat4 } from '../math/Mat4';
import { Vec2 } from '../math/Vec2';
import { Vec3 } from '../math/Vec3';
import {
  forEachTriangle,
  intersectTriangle,
  readPositions,
  readUv,
  readVertex,
  type LocalRay,
} from './raycastData';
import type { GeometryLike, IntersectionLike, MeshPickOptions, PickRay } from './types';

/** A single triangle hit with its interpolated attributes. */
export interface MeshHit {
  /** Index of the hit triangle in the geometry's triangle order. */
  faceIndex: number;
  /** Distance along the ray. */
  distance: number;
  /** Hit point in the geometry's local space. */
  localPoint: Vec3;
  /** Hit point in world space (equal to `localPoint` when no matrix was supplied). */
  point: Vec3;
  /** Barycentric weights `(u, v, w)` for the triangle's first, second, third vertex. */
  barycoord: [number, number, number];
  /** Vertex indices of the hit triangle. */
  indices: [number, number, number];
  /** Interpolated UV, present when the geometry has UVs and `uv` was not disabled. */
  uv?: Vec2;
  /** Interpolated (or face) normal, present when `normals` was requested. */
  normal?: Vec3;
}

/**
 * Precise triangle-level picking for one geometry.
 */
export class MeshPicker {
  /** Reusable vertex buffers; the picker is intentionally not re-entrant. */
  private readonly vertexA = new Vec3();
  private readonly vertexB = new Vec3();
  private readonly vertexC = new Vec3();
  private readonly uvA = new Vec2();
  private readonly uvB = new Vec2();
  private readonly uvC = new Vec2();
  private readonly normalA = new Vec3();
  private readonly normalB = new Vec3();
  private readonly normalC = new Vec3();

  /**
   * Tests a geometry against a world-space ray.
   *
   * @param geometry Geometry to test; indexed or non-indexed.
   * @param ray World-space ray.
   * @param options UV/normal interpolation, culling and group filtering.
   * @param worldMatrix Transform from local to world space; identity by default.
   * @returns Every hit, sorted nearest-first.
   */
  public pick(
    geometry: GeometryLike,
    ray: PickRay,
    options: MeshPickOptions = {},
    worldMatrix?: { elements: ArrayLike<number> },
  ): MeshHit[] {
    const positions = readPositions(geometry);
    if (positions === null) return [];

    const localRay = this.toLocalRay(ray, worldMatrix);
    if (localRay === null) return [];

    const uvAttribute = options.uv === false ? null : (geometry.attributes?.uv ?? null);
    const normalAttribute = options.normals === true ? (geometry.attributes?.normal ?? null) : null;

    const hits: MeshHit[] = [];

    forEachTriangle(
      geometry,
      (i0, i1, i2, faceIndex) => {
        readVertex(positions, i0, this.vertexA);
        readVertex(positions, i1, this.vertexB);
        readVertex(positions, i2, this.vertexC);

        const hit = intersectTriangle(
          localRay,
          this.vertexA,
          this.vertexB,
          this.vertexC,
          options.backfaceCulling ?? false,
        );
        if (hit === null) return;

        const localPoint = new Vec3(
          localRay.origin.x + localRay.direction.x * hit.distance,
          localRay.origin.y + localRay.direction.y * hit.distance,
          localRay.origin.z + localRay.direction.z * hit.distance,
        );

        const point = localPoint.clone();
        if (worldMatrix !== undefined) point.applyMat4(worldMatrix);

        const record: MeshHit = {
          faceIndex,
          // The local ray is unit-length in local space, so its parameter is a local
          // distance. Reproducing the world distance needs the world scale; callers
          // that only compare hits within one object get the right ordering either
          // way, and `Raycaster` remains the authority for cross-object distances.
          distance: hit.distance,
          localPoint,
          point,
          barycoord: hit.barycoord,
          indices: [i0, i1, i2],
        };

        const [w0, w1, w2] = hit.barycoord;

        if (uvAttribute !== null) {
          readUv(uvAttribute, i0, this.uvA);
          readUv(uvAttribute, i1, this.uvB);
          readUv(uvAttribute, i2, this.uvC);
          record.uv = new Vec2(
            this.uvA.x * w0 + this.uvB.x * w1 + this.uvC.x * w2,
            this.uvA.y * w0 + this.uvB.y * w1 + this.uvC.y * w2,
          );
        }

        if (normalAttribute !== null) {
          readVertex(normalAttribute, i0, this.normalA);
          readVertex(normalAttribute, i1, this.normalB);
          readVertex(normalAttribute, i2, this.normalC);
          record.normal = new Vec3(
            this.normalA.x * w0 + this.normalB.x * w1 + this.normalC.x * w2,
            this.normalA.y * w0 + this.normalB.y * w1 + this.normalC.y * w2,
            this.normalA.z * w0 + this.normalB.z * w1 + this.normalC.z * w2,
          ).normalize();
        }

        hits.push(record);
      },
      options.materialIndex,
    );

    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  /**
   * Tests a geometry and records three.js-shaped intersection records.
   *
   * This is the bridge to `Raycaster`: the records carry `distance`, `point`,
   * `object`, `faceIndex`, `uv`, `barycoord` and `normal`, so they are accepted
   * anywhere an `IntersectionLike` is.
   *
   * @param geometry Geometry to test.
   * @param ray World-space ray.
   * @param object Object recorded on each hit.
   * @param intersects Destination array.
   * @param options UV/normal interpolation, culling and group filtering.
   * @param worldMatrix Transform from local to world space.
   * @returns The number of hits appended.
   */
  public intersect(
    geometry: GeometryLike,
    ray: PickRay,
    object: unknown,
    intersects: IntersectionLike[],
    options: MeshPickOptions = {},
    worldMatrix?: { elements: ArrayLike<number> },
  ): number {
    const hits = this.pick(geometry, ray, options, worldMatrix);
    for (const hit of hits) {
      intersects.push({
        distance: hit.distance,
        point: hit.point,
        object,
        faceIndex: hit.faceIndex,
        barycoord: hit.barycoord,
        uv: hit.uv,
        normal: hit.normal,
        type: 'mesh',
      });
    }
    return hits.length;
  }

  /**
   * Tests a single triangle.
   *
   * @param ray Ray in the triangle's own space.
   * @param a First vertex.
   * @param b Second vertex.
   * @param c Third vertex.
   * @param backfaceCulling Discard back-facing hits.
   * @returns The barycentric hit, or `null`.
   */
  public pickTriangle(
    ray: PickRay,
    a: Vec3,
    b: Vec3,
    c: Vec3,
    backfaceCulling = false,
  ): { distance: number; barycoord: [number, number, number] } | null {
    const localRay: LocalRay = {
      origin: ray.origin,
      direction: ray.direction,
      near: ray.near ?? 0,
      far: ray.far ?? Infinity,
    };
    return intersectTriangle(localRay, a, b, c, backfaceCulling);
  }

  /**
   * Interpolates a per-vertex UV with barycentric weights.
   *
   * @param uvA First vertex UV.
   * @param uvB Second vertex UV.
   * @param uvC Third vertex UV.
   * @param barycoord Barycentric weights.
   * @param target Vector to write.
   * @returns `target`.
   */
  public interpolateUv(
    uvA: Vec2,
    uvB: Vec2,
    uvC: Vec2,
    barycoord: readonly [number, number, number],
    target: Vec2 = new Vec2(),
  ): Vec2 {
    const [w0, w1, w2] = barycoord;
    return target.set(
      uvA.x * w0 + uvB.x * w1 + uvC.x * w2,
      uvA.y * w0 + uvB.y * w1 + uvC.y * w2,
    );
  }

  /**
   * Transforms a world-space ray into the geometry's local space.
   *
   * @param ray World-space ray.
   * @param worldMatrix Local-to-world matrix, or `undefined` for identity.
   * @returns The local ray, or `null` when the matrix is singular.
   */
  private toLocalRay(
    ray: PickRay,
    worldMatrix?: { elements: ArrayLike<number> },
  ): LocalRay | null {
    const near = ray.near ?? 0;
    const far = ray.far ?? Infinity;

    if (worldMatrix === undefined) {
      return { origin: ray.origin, direction: ray.direction, near, far };
    }

    const inverse = new Mat4();
    inverse.fromArray(worldMatrix.elements);
    inverse.invert();
    if (!inverse.isInvertible()) return null;

    const origin = ray.origin.clone().applyMat4(inverse);
    const tip = ray.origin.clone().add(ray.direction).applyMat4(inverse);
    const direction = tip.sub(origin).normalize();
    const scale = inverse.getMaxScaleOnAxis() || 1;

    return { origin, direction, near: near * scale, far: far * scale };
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return 'MeshPicker()';
  }
}

/**
 * Convenience factory mirroring `new MeshPicker()`.
 *
 * @returns A new mesh picker.
 */
export function meshPicker(): MeshPicker {
  return new MeshPicker();
}
