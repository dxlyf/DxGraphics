/**
 * `InstancedMesh` - one geometry drawn many times with per-instance transforms.
 *
 * Instance data lives in flat typed buffers: `instanceMatrix` is a column-major
 * `Float32Array` of `16 * capacity` entries and `instanceColor` is an RGB
 * `Float32Array` of `3 * capacity` entries. The renderer uploads them as
 * instanced attributes; {@link InstancedMesh.raycast} walks the same buffers so
 * picking agrees with what is drawn.
 *
 * @packageDocumentation
 */

import { DEFAULT_INSTANCE_CAPACITY } from '../../constants';
import { Mat4 } from '../../math/Mat4';
import { Vec3 } from '../../math/Vec3';
import { Mesh } from './Mesh';
import {
  getUvAttribute,
  indexItemCount,
  indexValueAt,
  rayIntersectsTriangle,
  readUv,
  readVertex,
  withinRayRange,
} from '../internal/raycast';
import type { Object3D } from './Object3D';
import type { MeshOptions } from './Mesh';
import type { AttributeLike, Intersects, Vector2Like } from './types';
import type { RaycasterLike } from './types';

/** Ray origin in instance-local space. */
const localOrigin = new Vec3();

/** Ray direction in instance-local space. */
const localDirection = new Vec3();

/** Matrix of the instance currently under test. */
const instanceMatrix = new Mat4();

/** World matrix of the instance currently under test. */
const instanceWorld = new Mat4();

/** Inverse world matrix of the instance currently under test. */
const instanceInverse = new Mat4();

/** Scratch vector used by the bounding-volume helpers. */
const scratchVector = new Vec3();

/** Second scratch vector used by the bounding-volume helpers. */
const scratchThird = new Vec3();

/** First triangle vertex. */
const vertexA = new Vec3();

/** Second triangle vertex. */
const vertexB = new Vec3();

/** Third triangle vertex. */
const vertexC = new Vec3();

/** Local-space hit point. */
const localHit = new Vec3();

/** Interpolated UV storage. */
const uvOut: Vector2Like = { x: 0, y: 0 };

/** A local-space axis-aligned box, used by `computeBoundingBox`. */
export interface LocalBox {
  /** Minimum corner. */
  min: Vec3;
  /** Maximum corner. */
  max: Vec3;
}

/** Options accepted by the {@link InstancedMesh} constructor. */
export interface InstancedMeshOptions extends MeshOptions {
  /** Number of instances; defaults to the capacity, or `128`. */
  count?: number;
  /** Pre-allocated capacity in instances; defaults to `count`. */
  capacity?: number;
}

/**
 * A mesh drawn once per instance.
 *
 * Raycasting is `O(count * triangles)`: each instance gets its own local-space
 * ray. Call {@link InstancedMesh.computeBoundingSphere} and reject the whole
 * mesh first when the instance count is large.
 */
export class InstancedMesh extends Mesh {
  /** Allows consumers to detect an instanced mesh without an `instanceof` check. */
  public readonly isInstancedMesh: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'InstancedMesh';

  /** Number of instances currently drawn. */
  public count: number;

  /** Allocated instance slots; `count` may be lower than this. */
  public readonly capacity: number;

  /** Column-major per-instance local matrices (`16 * capacity` floats). */
  public instanceMatrix: Float32Array;

  /** Optional per-instance RGB tint (`3 * capacity` floats), or `null`. */
  public instanceColor: Float32Array | null = null;

  /** Number of instances stored in {@link InstancedMesh.instanceColor}. */
  public instanceColorCount = 0;

  /** Creates an instanced mesh. */
  constructor(options: InstancedMeshOptions = {}) {
    super(options);
    const capacity = Math.max(1, options.capacity ?? options.count ?? DEFAULT_INSTANCE_CAPACITY);
    this.capacity = capacity;
    this.count = Math.max(0, Math.min(options.count ?? capacity, capacity));
    this.instanceMatrix = new Float32Array(capacity * 16);
    for (let i = 0; i < capacity; i++) {
      const offset = i * 16;
      this.instanceMatrix[offset] = 1;
      this.instanceMatrix[offset + 5] = 1;
      this.instanceMatrix[offset + 10] = 1;
      this.instanceMatrix[offset + 15] = 1;
    }
  }

  /* ------------------------------------------------------------- accessors */

  /**
   * Writes the local matrix of instance `index`.
   *
   * @throws RangeError when `index` is outside `[0, count)`.
   */
  public setMatrixAt(index: number, matrix: Mat4): this {
    this.assertInstanceIndex(index);
    this.instanceMatrix.set(matrix.elements, index * 16);
    return this;
  }

  /**
   * Reads the local matrix of instance `index` into `target`.
   *
   * @throws RangeError when `index` is outside `[0, count)`.
   */
  public getMatrixAt(index: number, target: Mat4 = new Mat4()): Mat4 {
    this.assertInstanceIndex(index);
    return target.fromArray(this.instanceMatrix, index * 16);
  }

  /**
   * Ensures the per-instance colour buffer exists and stores one RGB triple.
   *
   * @param index Instance slot.
   * @param color Any object exposing `r`, `g` and `b` in `[0, 1]`.
   * @throws RangeError when `index` is outside `[0, count)`.
   */
  public setColorAt(index: number, color: { r: number; g: number; b: number }): this {
    this.assertInstanceIndex(index);
    if (this.instanceColor === null) this.instanceColor = new Float32Array(this.capacity * 3);
    this.instanceColor[index * 3] = color.r;
    this.instanceColor[index * 3 + 1] = color.g;
    this.instanceColor[index * 3 + 2] = color.b;
    if (index + 1 > this.instanceColorCount) this.instanceColorCount = index + 1;
    return this;
  }

  /** Reads the RGB triple of instance `index`, or `null` when unset. */
  public getColorAt(
    index: number,
    target: { r: number; g: number; b: number },
  ): { r: number; g: number; b: number } | null {
    const color = this.instanceColor;
    if (!color || index < 0 || index * 3 + 2 >= color.length) return null;
    target.r = color[index * 3];
    target.g = color[index * 3 + 1];
    target.b = color[index * 3 + 2];
    return target;
  }

  /* --------------------------------------------------------------- volumes */

  /**
   * Fills `target` with the local bounding box covering every instance origin.
   *
   * @param target Receives the result; both vectors are written in place.
   */
  public computeBoundingBox(target: LocalBox): LocalBox {
    if (this.count === 0) {
      target.min.set(0, 0, 0);
      target.max.set(0, 0, 0);
      return target;
    }

    const min = scratchVector.set(Infinity, Infinity, Infinity);
    const max = scratchThird.set(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < this.count; i++) {
      const offset = i * 16;
      const x = this.instanceMatrix[offset + 12];
      const y = this.instanceMatrix[offset + 13];
      const z = this.instanceMatrix[offset + 14];
      min.x = Math.min(min.x, x);
      min.y = Math.min(min.y, y);
      min.z = Math.min(min.z, z);
      max.x = Math.max(max.x, x);
      max.y = Math.max(max.y, y);
      max.z = Math.max(max.z, z);
    }
    target.min.set(min.x, min.y, min.z);
    target.max.set(max.x, max.y, max.z);
    return target;
  }

  /**
   * Computes a world-space bounding sphere around every instance origin.
   *
   * The radius is padded by the largest per-instance scale so the instance
   * geometry is enclosed as well.
   *
   * @returns The sphere, or `null` when there is nothing to bound.
   */
  public computeBoundingSphere(): { center: Vec3; radius: number } | null {
    if (this.count === 0) return null;
    this.updateWorldMatrix(true, false);

    const box: LocalBox = { min: new Vec3(), max: new Vec3() };
    this.computeBoundingBox(box);

    const localCenter = new Vec3(
      (box.min.x + box.max.x) * 0.5,
      (box.min.y + box.max.y) * 0.5,
      (box.min.z + box.max.z) * 0.5,
    );
    const worldCenter = localCenter.clone().applyMat4(this.matrixWorld);

    let maxRadiusSquared = 0;
    for (let i = 0; i < this.count; i++) {
      const offset = i * 16;
      scratchVector.set(
        this.instanceMatrix[offset + 12],
        this.instanceMatrix[offset + 13],
        this.instanceMatrix[offset + 14],
      );
      scratchThird.copy(scratchVector).applyMat4(this.matrixWorld);
      maxRadiusSquared = Math.max(maxRadiusSquared, scratchThird.distanceToSquared(worldCenter));
    }

    const padding = 1 + this.maxInstanceScale();
    return { center: worldCenter, radius: Math.sqrt(maxRadiusSquared) * padding };
  }

  /** Largest per-instance axis scale, used to pad the bounding sphere. */
  public maxInstanceScale(): number {
    let largest = 0;
    for (let i = 0; i < this.count; i++) {
      const offset = i * 16;
      const sx = Math.hypot(
        this.instanceMatrix[offset],
        this.instanceMatrix[offset + 1],
        this.instanceMatrix[offset + 2],
      );
      const sy = Math.hypot(
        this.instanceMatrix[offset + 4],
        this.instanceMatrix[offset + 5],
        this.instanceMatrix[offset + 6],
      );
      const sz = Math.hypot(
        this.instanceMatrix[offset + 8],
        this.instanceMatrix[offset + 9],
        this.instanceMatrix[offset + 10],
      );
      largest = Math.max(largest, sx, sy, sz);
    }
    return largest;
  }

  /* --------------------------------------------------------------- picking */

  /**
   * Intersects `raycaster` with every instance of the geometry.
   *
   * Reports `instanceId` on each hit so the caller knows which instance was
   * picked.
   */
  public override raycast(raycaster: RaycasterLike, intersects: Intersects): void {
    const geometry = this.geometryData;
    const position: AttributeLike | null =
      geometry?.position ?? geometry?.attributes.position ?? null;
    if (!geometry || !position) return;
    if (!this.prepareRaycast(raycaster)) return;

    const backface = raycaster.params?.backfaceCulling === true;
    const uv = getUvAttribute(geometry);
    const index = geometry.index;
    const vertexCount = position.count ?? Math.floor(position.array.length / position.itemSize);
    const triangleCount = index
      ? Math.floor(indexItemCount(index) / 3)
      : Math.floor(vertexCount / 3);

    for (let instance = 0; instance < this.count; instance++) {
      instanceMatrix.fromArray(this.instanceMatrix, instance * 16);
      instanceWorld.multiplyMatrices(this.matrixWorld, instanceMatrix);
      instanceInverse.copy(instanceWorld).invert();
      if (!instanceInverse.isInvertible()) continue;

      localOrigin.copy(raycaster.ray.origin).applyMat4(instanceInverse);
      localDirection.copy(raycaster.ray.direction).applyMat4(instanceInverse).normalize();

      for (let triangle = 0; triangle < triangleCount; triangle++) {
        if (index) {
          readVertex(position, indexValueAt(index, triangle * 3), vertexA);
          readVertex(position, indexValueAt(index, triangle * 3 + 1), vertexB);
          readVertex(position, indexValueAt(index, triangle * 3 + 2), vertexC);
        } else {
          readVertex(position, triangle * 3, vertexA);
          readVertex(position, triangle * 3 + 1, vertexB);
          readVertex(position, triangle * 3 + 2, vertexC);
        }

        const hit = rayIntersectsTriangle(
          localOrigin,
          localDirection,
          vertexA,
          vertexB,
          vertexC,
          backface,
          localHit,
        );
        if (!hit) continue;

        const worldPoint = localHit.clone().applyMat4(instanceWorld);
        const distance = worldPoint.distanceTo(raycaster.ray.origin);
        if (!withinRayRange(raycaster, distance)) continue;

        const intersection: Intersects[number] = {
          distance,
          point: worldPoint,
          object: this,
          faceIndex: triangle,
          instanceId: instance,
        };
        if (uv) {
          const ia = index ? indexValueAt(index, triangle * 3) : triangle * 3;
          readUv(uv, ia, uvOut);
          intersection.uv = { x: uvOut.x, y: uvOut.y };
        }
        intersects.push(intersection);
      }
    }
  }

  /* ------------------------------------------------- copy / clone / helpers */

  /**
   * Copies the transform plus the instance buffers of `source`.
   *
   * The buffers are copied rather than shared, so two instanced meshes never
   * fight over one GPU allocation.
   */
  public override copy(source: Object3D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof InstancedMesh) {
      this.count = source.count;
      this.instanceMatrix = source.instanceMatrix.slice();
      this.instanceColor = source.instanceColor ? source.instanceColor.slice() : null;
      this.instanceColorCount = source.instanceColorCount;
    }
    return this;
  }

  /** Returns a clone of this instanced mesh; geometry and material are shared. */
  public override clone(recursive = true): InstancedMesh {
    const clone = new InstancedMesh({ count: this.count, capacity: this.capacity });
    clone.copy(this, recursive);
    return clone;
  }

  /** Throws unless `index` addresses a live instance. */
  private assertInstanceIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      throw new RangeError(
        `InstancedMesh index ${index} is outside [0, ${this.count}); set \`count\` first`,
      );
    }
  }
}
