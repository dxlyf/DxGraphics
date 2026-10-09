/**
 * `SkinnedMesh` - a mesh deformed by a `Skeleton`.
 *
 * Two skinning paths exist:
 *
 *  - **GPU** (production): the renderer uploads `skeleton.boneMatrices` (or the
 *    bone texture from `skeleton.computeBoneTexture()`) together with the
 *    `skinIndex`/`skinWeight` attributes and applies the standard four-bone
 *    blend in the vertex shader. Everything the renderer needs is exposed by
 *    this class, so it never has to reach into `Skeleton` internals.
 *  - **CPU reference** (fallback, tests, CPU-only backends): call
 *    {@link SkinnedMesh.boneTransform} per vertex with the `skinIndex` and
 *    `skinWeight` attributes. It is deliberately simple and allocation-free, but
 *    it is **not** wired into `raycast`, which tests the bind-pose geometry.
 *
 * @packageDocumentation
 */

import { Mat4 } from '../../math/Mat4';
import { Vec3 } from '../../math/Vec3';
import { Mesh } from './Mesh';
import { readVertex } from '../internal/raycast';
import type { Object3D } from './Object3D';
import type { MeshOptions } from './Mesh';
import type { AttributeLike, BindMode, GeometryLike } from './types';

/** Structural view of the skeleton this mesh is bound to. */
export interface SkeletonLike {
  /** Bones in skinning order. */
  bones: ReadonlyArray<{ matrixWorld: Mat4 }>;
  /** Per-bone inverse bind matrices. */
  boneInverses: Mat4[];
  /** Flat `16 * boneCount` palette uploaded by the renderer. */
  boneMatrices: Float32Array;
  /** Number of bones. */
  readonly boneCount: number;
  /** Recomputes {@link SkeletonLike.boneMatrices}. */
  update(): void;
}

/** Options accepted by the {@link SkinnedMesh} constructor. */
export interface SkinnedMeshOptions extends MeshOptions {
  /** Skeleton bound at construction time, when known. */
  skeleton?: SkeletonLike | null;
  /** Skinning mode; defaults to `'attached'`. */
  bindMode?: BindMode;
}

/** Accumulator used by the CPU reference skinning path. */
const transformed = new Vec3();

/** Temporary vertex read. */
const sourceVertex = new Vec3();

/** A mesh whose vertices are bound to the bones of a skeleton. */
export class SkinnedMesh extends Mesh {
  /** Allows consumers to detect a skinned mesh without an `instanceof` check. */
  public readonly isSkinnedMesh: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'SkinnedMesh';

  /** Skeleton driving the deformation, or `null` while unbound. */
  public skeleton: SkeletonLike | null;

  /** Matrix that maps the mesh's local space into the skeleton's bind space. */
  public readonly bindMatrix: Mat4;

  /** Inverse of {@link SkinnedMesh.bindMatrix}. */
  public readonly bindMatrixInverse: Mat4;

  /** `'attached'` follows the mesh's world matrix; `'detached'` uses the bind matrix. */
  public bindMode: BindMode;

  /** Creates a skinned mesh. */
  constructor(options: SkinnedMeshOptions = {}) {
    super(options);
    this.bindMode = options.bindMode ?? 'attached';
    this.bindMatrix = new Mat4();
    this.bindMatrixInverse = new Mat4();
    this.skeleton = null;
    if (options.skeleton) this.bind(options.skeleton);
  }

  /**
   * Binds the mesh to `skeleton`.
   *
   * @param skeleton Skeleton to bind.
   * @param bindMatrix Mesh-space -> skeleton-space matrix; defaults to this
   *   mesh's current world matrix, which is what an importer usually wants.
   */
  public bind(skeleton: SkeletonLike, bindMatrix?: Mat4): this {
    this.skeleton = skeleton;
    if (bindMatrix) this.bindMatrix.copy(bindMatrix);
    else this.bindMatrix.copy(this.matrixWorld);
    this.bindMatrixInverse.copy(this.bindMatrix).invert();
    return this;
  }

  /**
   * Recomputes the skeleton's inverse bind matrices from the current pose.
   *
   * Delegates to `skeleton.calculateInverses()` when the bound skeleton
   * implements it (the concrete `Skeleton` does) and falls back to recomputing
   * from this mesh's bind matrix otherwise.
   */
  public calculateInverses(): this {
    const skeleton = this.skeleton as (SkeletonLike & { calculateInverses?(): void }) | null;
    if (!skeleton) return this;
    if (typeof skeleton.calculateInverses === 'function') {
      skeleton.calculateInverses();
      return this;
    }
    for (let i = 0; i < skeleton.bones.length; i++) {
      const bone = skeleton.bones[i];
      const inverse = skeleton.boneInverses[i];
      if (!bone || !inverse) continue;
      inverse.copy(bone.matrixWorld).invert().multiply(this.bindMatrix);
    }
    return this;
  }

  /**
   * Rebinds the skeleton to the mesh's current pose.
   *
   * Mirrors three.js: the bind matrix is refreshed from the world matrix and
   * every inverse bind matrix is recomputed from the bones' current world
   * matrices.
   */
  public pose(): this {
    this.updateWorldMatrix(true, false);
    this.bindMatrix.copy(this.matrixWorld);
    this.bindMatrixInverse.copy(this.matrixWorld).invert();
    const skeleton = this.skeleton;
    if (skeleton) {
      for (let i = 0; i < skeleton.bones.length; i++) {
        const bone = skeleton.bones[i];
        const inverse = skeleton.boneInverses[i];
        if (!bone || !inverse) continue;
        inverse.copy(bone.matrixWorld).invert().multiply(this.bindMatrix);
      }
    }
    return this;
  }

  /**
   * Renormalises the `skinWeight` attribute so each vertex's weights sum to `1`.
   *
   * Unnormalised weights are the most common cause of a collapsed skin, and the
   * reference skinning path assumes unit sums.
   *
   * @returns `true` when a `skinWeight` attribute was found and rewritten.
   */
  public normalizeSkinWeights(): boolean {
    const geometry: GeometryLike | null = this.geometryData;
    const skinWeight: AttributeLike | undefined = geometry?.attributes.skinWeight;
    if (!skinWeight) return false;

    const array = skinWeight.array as Float32Array;
    const itemSize = Math.max(1, skinWeight.itemSize);
    const count = skinWeight.count ?? Math.floor(array.length / itemSize);
    for (let vertex = 0; vertex < count; vertex++) {
      const offset = vertex * itemSize;
      let total = 0;
      for (let i = 0; i < itemSize; i++) total += array[offset + i] ?? 0;
      if (total === 0) {
        array[offset] = 1;
        continue;
      }
      for (let i = 0; i < itemSize; i++) array[offset + i] = (array[offset + i] ?? 0) / total;
    }
    return true;
  }

  /**
   * CPU reference skinning for one vertex.
   *
   * ```ts
   * mesh.boneTransform(0, out);   // `out` now holds the deformed position
   * ```
   *
   * Reads `skinIndex`/`skinWeight` from the geometry and the current
   * `skeleton.boneMatrices`, then writes the deformed position, expressed in the
   * mesh's local space, into `target`.
   *
   * @param index Vertex index.
   * @param target Receives the deformed vertex.
   * @returns `target`.
   */
  public boneTransform(index: number, target: Vec3): Vec3 {
    const geometry = this.geometryData;
    const position: AttributeLike | null =
      geometry?.position ?? geometry?.attributes.position ?? null;
    const skinIndex: AttributeLike | undefined = geometry?.attributes.skinIndex;
    const skinWeight: AttributeLike | undefined = geometry?.attributes.skinWeight;
    if (!geometry || !position || !skinIndex || !skinWeight) return target;

    readVertex(position, index, sourceVertex);

    const boneMatrices = this.skeleton ? this.skeleton.boneMatrices : null;
    if (!boneMatrices) return target.copy(sourceVertex);

    target.set(0, 0, 0);
    const e = boneMatrices;
    const influences = Math.min(skinIndex.itemSize, skinWeight.itemSize);
    const x = sourceVertex.x;
    const y = sourceVertex.y;
    const z = sourceVertex.z;

    for (let i = 0; i < influences; i++) {
      const weight = skinWeight.array[index * skinWeight.itemSize + i] ?? 0;
      if (weight === 0) continue;
      const boneIndex = skinIndex.array[index * skinIndex.itemSize + i] ?? 0;
      const offset = boneIndex * 16;
      transformed.set(
        e[offset] * x + e[offset + 4] * y + e[offset + 8] * z + e[offset + 12],
        e[offset + 1] * x + e[offset + 5] * y + e[offset + 9] * z + e[offset + 13],
        e[offset + 2] * x + e[offset + 6] * y + e[offset + 10] * z + e[offset + 14],
      );
      target.addScaledVector(transformed, weight);
    }
    return target;
  }

  /** Copies the transform, bind state and skeleton reference of `source`. */
  public override copy(source: Object3D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof SkinnedMesh) {
      this.skeleton = source.skeleton;
      this.bindMode = source.bindMode;
      this.bindMatrix.copy(source.bindMatrix);
      this.bindMatrixInverse.copy(source.bindMatrixInverse);
    }
    return this;
  }

  /** Returns a clone of this skinned mesh; geometry, material and skeleton are shared. */
  public override clone(recursive = true): SkinnedMesh {
    const clone = new SkinnedMesh();
    clone.copy(this, recursive);
    return clone;
  }

  /** Recomputes the world matrix, then the bind matrix inverse, when attached. */
  public override updateMatrixWorld(force = false): void {
    super.updateMatrixWorld(force);
    if (this.bindMode === 'attached') {
      this.bindMatrixInverse.copy(this.matrixWorld).invert();
    } else {
      this.bindMatrixInverse.copy(this.bindMatrix).invert();
    }
  }
}
