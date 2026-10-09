/**
 * `Mesh` - a `BufferGeometry` drawn with a material.
 *
 * The mesh owns no vertex data of its own: `geometry` describes the shape and
 * `material` describes the shading. Both are stored behind accessors that flag
 * the renderer's cache, and both are typed structurally until `src/geometry`
 * and `src/materials` land (see `./types.ts`).
 *
 * `raycast` implements Moeller-Trumbore per triangle against the local-space ray
 * (`inverse(matrixWorld)`), so instancing, scaling and non-uniform parents all
 * pick correctly.
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../math/Vec3';
import { Object3D } from './Object3D';
import {
  getUvAttribute,
  indexItemCount,
  indexValueAt,
  isMaterialVisible,
  passesLayerTest,
  rayIntersectsTriangle,
  readUv,
  readVertex,
  toLocalRay,
  withinRayRange,
} from '../internal/raycast';
export { passesLayerTest, toLocalRay };

import type { AttributeLike, GeometryLike, Intersects, MaterialLike } from './types';
import type { Object3DOptions, RaycasterLike } from './types';

/** Ray origin in world space. */
const rayOrigin = new Vec3();

/** Ray direction in world space. */
const rayDirection = new Vec3();

/** Ray origin in local space. */
const localOrigin = new Vec3();

/** Ray direction in local space. */
const localDirection = new Vec3();

/** First triangle vertex, reused across tests. */
const vertexA = new Vec3();

/** Second triangle vertex, reused across tests. */
const vertexB = new Vec3();

/** Third triangle vertex, reused across tests. */
const vertexC = new Vec3();

/** Hit point in local space. */
const localHit = new Vec3();

/** Interpolated UV storage. */
const uvOut = { x: 0, y: 0 };

/** Options accepted by the {@link Mesh} constructor. */
export interface MeshOptions extends Object3DOptions {
  /** Vertex data drawn by the mesh. */
  geometry?: GeometryLike | null;
  /** Shading description. */
  material?: MaterialLike | readonly MaterialLike[] | null;
}

/**
 * `true` when the raycaster's layer mask matches `object.layers`.
 *
 * Re-exported from the internal picking helpers (see the import block above) so
 * `Sprite3D` and the `InstancedMesh` picking path share one implementation.
 */

/** A geometry-bearing node drawn with one material (or one material per group). */
export class Mesh extends Object3D {
  /** Allows consumers to detect a mesh without an `instanceof` check. */
  public readonly isMesh: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'Mesh';

  /**
   * Morph-target weights.
   *
   * Placeholder array: the geometry-side morph machinery is owned by
   * `src/geometry`, which was still being written when this class landed.
   */
  public morphTargetInfluences: number[] | undefined = undefined;

  /** Named morph-target weight dictionary, keyed by target name. */
  public morphTargetDictionary: Record<string, number> | undefined = undefined;

  /** Backing field of the `geometry` accessor. */
  protected geometryData: GeometryLike | null;

  /** Backing field of the `material` accessor. */
  protected materialData: MaterialLike | readonly MaterialLike[] | null;

  /** `true` while the geometry or material changed and the renderer must re-sync. */
  public needsUpdate = false;

  /** Creates a mesh; `options.geometry` and `options.material` are optional. */
  constructor(options: MeshOptions = {}) {
    super(options);
    this.geometryData = options.geometry ?? null;
    this.materialData = options.material ?? null;
  }

  /** Vertex data drawn by this mesh. */
  public get geometry(): GeometryLike | null {
    return this.geometryData;
  }

  public set geometry(value: GeometryLike | null) {
    this.geometryData = value;
    this.needsUpdate = true;
  }

  /** Shading description; an array selects one material per geometry group. */
  public get material(): MaterialLike | readonly MaterialLike[] | null {
    return this.materialData;
  }

  public set material(value: MaterialLike | readonly MaterialLike[] | null) {
    this.materialData = value;
    this.needsUpdate = true;
  }

  /** Replaces the geometry and flags the renderer cache. */
  public setGeometry(geometry: GeometryLike | null): this {
    this.geometry = geometry;
    return this;
  }

  /** Replaces the material(s) and flags the renderer cache. */
  public setMaterial(material: MaterialLike | readonly MaterialLike[] | null): this {
    this.material = material;
    return this;
  }

  /** Returns the material at `index` (`0` for a single-material mesh). */
  public getMaterialAt(index = 0): MaterialLike | undefined {
    const material = this.materialData;
    if (!material) return undefined;
    if (Array.isArray(material)) return (material as readonly MaterialLike[])[index];
    return index === 0 ? (material as MaterialLike) : undefined;
  }

  /** Returns a clone of this mesh; the geometry and material are shared. */
  public override clone(recursive = true): Mesh {
    return new Mesh().copy(this, recursive) as Mesh;
  }

  /** Copies the transform, geometry and material of `source`. */
  public override copy(source: Object3D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof Mesh) {
      this.geometryData = source.geometryData;
      this.materialData = source.materialData;
      this.morphTargetInfluences = source.morphTargetInfluences?.slice();
      this.morphTargetDictionary = source.morphTargetDictionary
        ? { ...source.morphTargetDictionary }
        : undefined;
    }
    return this;
  }

  /**
   * Shared prologue for every `Mesh`-derived picking routine.
   *
   * Applies the layer mask and material visibility, then moves the ray into
   * this mesh's local frame.
   *
   * @returns `true` when the caller may proceed with geometry tests.
   */
  protected prepareRaycast(raycaster: RaycasterLike): boolean {
    if (!passesLayerTest(raycaster, this.layers)) return false;
    if (!isMaterialVisible(this.getMaterialAt(0)) && this.materialData !== null) return false;
    return toLocalRay(this, raycaster, localOrigin, localDirection);
  }

  /** Ray origin in local space; valid after {@link Mesh.prepareRaycast}. */
  protected get localRayOrigin(): Vec3 {
    return localOrigin;
  }

  /** Ray direction in local space; valid after {@link Mesh.prepareRaycast}. */
  protected get localRayDirection(): Vec3 {
    return localDirection;
  }

  /**
   * Intersects `raycaster` with every triangle of {@link Mesh.geometry}.
   *
   * The ray is transformed into local space once, then each triangle is tested
   * with Moeller-Trumbore; hits are reported back in world space.
   */
  public override raycast(raycaster: RaycasterLike, intersects: Intersects): void {
    const geometry = this.geometryData;
    const position: AttributeLike | null =
      geometry?.position ?? geometry?.attributes.position ?? null;
    if (!geometry || !position) return;
    if (!this.prepareRaycast(raycaster)) return;

    rayOrigin.copy(raycaster.ray.origin);
    rayDirection.copy(raycaster.ray.direction).normalize();

    const sphere = geometry.boundingSphere;
    if (sphere && !sphereMayBeHit(sphere, rayOrigin, rayDirection)) return;

    const backface = raycaster.params?.backfaceCulling === true;
    const uv = getUvAttribute(geometry);
    const index = geometry.index;

    if (index) {
      const triangleCount = Math.floor(indexItemCount(index) / 3);
      for (let triangle = 0; triangle < triangleCount; triangle++) {
        this.testTriangle(
          raycaster,
          indexValueAt(index, triangle * 3),
          indexValueAt(index, triangle * 3 + 1),
          indexValueAt(index, triangle * 3 + 2),
          triangle,
          position,
          uv,
          backface,
          intersects,
        );
      }
      return;
    }

    const vertexCount = position.count ?? Math.floor(position.array.length / position.itemSize);
    const triangleCount = Math.floor(vertexCount / 3);
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      const base = triangle * 3;
      this.testTriangle(
        raycaster,
        base,
        base + 1,
        base + 2,
        triangle,
        position,
        uv,
        backface,
        intersects,
      );
    }
  }

  /** Tests one triangle and appends a world-space hit when it is crossed. */
  protected testTriangle(
    raycaster: RaycasterLike,
    ia: number,
    ib: number,
    ic: number,
    faceIndex: number,
    position: AttributeLike,
    uv: AttributeLike | null,
    backface: boolean,
    intersects: Intersects,
  ): void {
    readVertex(position, ia, vertexA);
    readVertex(position, ib, vertexB);
    readVertex(position, ic, vertexC);

    const hit = rayIntersectsTriangle(
      localOrigin,
      localDirection,
      vertexA,
      vertexB,
      vertexC,
      backface,
      localHit,
    );
    if (!hit) return;

    const worldPoint = localHit.clone().applyMat4(this.matrixWorld);
    const distance = worldPoint.distanceTo(raycaster.ray.origin);
    if (!withinRayRange(raycaster, distance)) return;

    const intersection: Intersects[number] = {
      distance,
      point: worldPoint,
      object: this,
      faceIndex,
    };
    if (uv) {
      readUv(uv, ia, uvOut);
      intersection.uv = { x: uvOut.x, y: uvOut.y };
    }
    intersects.push(intersection);
  }
}

/**
 * Conservative sphere/ray overlap test.
 *
 * Only used to skip work, so it reports `true` for every sphere the ray could
 * possibly touch.
 */
function sphereMayBeHit(
  sphere: { center: { x: number; y: number; z: number }; radius: number },
  origin: Vec3,
  direction: Vec3,
): boolean {
  const cx = sphere.center.x - origin.x;
  const cy = sphere.center.y - origin.y;
  const cz = sphere.center.z - origin.z;
  const projection = cx * direction.x + cy * direction.y + cz * direction.z;
  const distanceSquared = cx * cx + cy * cy + cz * cz - projection * projection;
  return distanceSquared <= sphere.radius * sphere.radius;
}
