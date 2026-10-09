/**
 * `Skeleton` - the skinning palette shared by one or more `SkinnedMesh` nodes.
 *
 * For every bone the skeleton stores the inverse of the bone's world matrix in
 * the bind pose (`boneInverses`) and produces, per frame, the flat
 * `boneMatrices` buffer
 *
 * ```text
 * boneMatrix[i] = bone[i].matrixWorld * boneInverses[i]
 * ```
 *
 * which is exactly the palette a vertex shader blends with. `boneMatrices` is a
 * `Float32Array` in column-major order, so it can be uploaded directly with
 * `uniformMatrix4fv` or copied into the texture produced by
 * {@link Skeleton.computeBoneTexture}.
 *
 * @packageDocumentation
 */

import { Mat4 } from '../../math/Mat4';
import { Bone } from './Bone';

/** Texture payload produced by {@link Skeleton.computeBoneTexture}. */
export interface BoneTextureData {
  /** Matrix data, four texels per bone. */
  data: Float32Array;
  /** Edge length of the square RGBA float texture. */
  size: number;
  /** Number of bones actually written. */
  boneCount: number;
}

/** Scratch matrix reused by {@link Skeleton.update}. */
const scratch = new Mat4();

/** A set of bones plus the matrices needed to skin geometry with them. */
export class Skeleton {
  /** Allows consumers to detect a skeleton without an `instanceof` check. */
  public readonly isSkeleton = true;

  /** Bones in skinning order; index `i` matches the `skinIndex` attribute. */
  public readonly bones: Bone[];

  /** Inverse bind matrices, one per bone. */
  public readonly boneInverses: Mat4[];

  /**
   * Flat palette consumed by the renderer (`16 * bones.length` floats).
   *
   * Reused between frames; {@link Skeleton.update} writes into it in place. The
   * buffer is replaced when bones are added after construction, so the renderer
   * must re-read the reference whenever {@link Skeleton.init} runs.
   */
  public boneMatrices: Float32Array;

  /** Bind matrix applied to every palette entry. */
  public readonly bindMatrix: Mat4;

  /** `true` once {@link Skeleton.init} has run. */
  public initialized = false;

  /**
   * Creates a skeleton.
   *
   * @param bones Bones in skinning order.
   * @param boneInverses Optional explicit inverse bind matrices; when omitted
   *   they are derived from the bones' current world matrices by
   *   {@link Skeleton.calculateInverses}.
   */
  constructor(bones: Bone[] = [], boneInverses: Mat4[] = []) {
    this.bones = bones;
    this.boneInverses = boneInverses;
    this.boneMatrices = new Float32Array(bones.length * 16);
    this.bindMatrix = new Mat4();
    this.init();
  }

  /** Number of bones in the palette. */
  public get boneCount(): number {
    return this.bones.length;
  }

  /**
   * Fills in missing inverse bind matrices and makes sure the palette buffer is
   * large enough.
   *
   * Safe to call repeatedly; only missing entries are computed.
   */
  public init(): void {
    if (this.boneInverses.length === 0 && this.bones.length > 0) {
      this.calculateInverses();
    }
    while (this.boneInverses.length < this.bones.length) this.boneInverses.push(new Mat4());
    if (this.boneMatrices.length !== this.bones.length * 16) {
      // Only reachable when bones were pushed onto `bones` after construction.
      const resized = new Float32Array(this.bones.length * 16);
      resized.set(this.boneMatrices.subarray(0, Math.min(resized.length, this.boneMatrices.length)));
      this.boneMatrices = resized;
    }
    this.initialized = true;
  }

  /** Recomputes every inverse bind matrix from the bones' current world pose. */
  public calculateInverses(): void {
    this.boneInverses.length = 0;
    for (let i = 0; i < this.bones.length; i++) {
      const bone = this.bones[i];
      const inverse = new Mat4();
      if (bone) {
        bone.updateWorldMatrix(true, false);
        inverse.copy(bone.matrixWorld).invert();
      }
      this.boneInverses.push(inverse);
    }
    this.initialized = true;
  }

  /**
   * Rebinds the skeleton to the bones' current pose.
   *
   * Update the world matrices first (`scene.updateMatrixWorld()`); this method
   * does not traverse the graph.
   */
  public pose(): void {
    for (let i = 0; i < this.bones.length; i++) {
      const bone = this.bones[i];
      const inverse = this.boneInverses[i];
      if (!bone || !inverse) continue;
      inverse.copy(bone.matrixWorld).invert().multiply(this.bindMatrix);
    }
  }

  /**
   * Writes every bone matrix into {@link Skeleton.boneMatrices}.
   *
   * The bones' world matrices must be current; call `scene.updateMatrixWorld()`
   * (or `bone.updateWorldMatrix(true, false)`) before this.
   */
  public update(): void {
    for (let i = 0; i < this.bones.length; i++) {
      const bone = this.bones[i];
      const inverse = this.boneInverses[i];
      if (!bone || !inverse) continue;
      scratch.copy(bone.matrixWorld).multiply(inverse);
      this.boneMatrices.set(scratch.elements, i * 16);
    }
  }

  /** Returns the bone with the given name, or `undefined`. */
  public getBoneByName(name: string): Bone | undefined {
    for (let i = 0; i < this.bones.length; i++) {
      if (this.bones[i].name === name) return this.bones[i];
    }
    return undefined;
  }

  /**
   * Packs {@link Skeleton.boneMatrices} into a square RGBA float texture.
   *
   * Each bone occupies four consecutive texels (a 4x4 matrix, column-major),
   * which is the layout the standard GPU skinning shader expects:
   *
   * ```glsl
   * vec4 row1 = texture(boneTexture, vec2((4.0 * float(boneIndex) + 0.5) / size, y));
   * ```
   *
   * @returns The texture payload; `size` grows with the bone count.
   */
  public computeBoneTexture(): BoneTextureData {
    const size = Math.max(4, Math.ceil(Math.sqrt(this.bones.length * 4)));
    const data = new Float32Array(size * size * 4);
    const count = Math.min(this.bones.length, (size * size) / 4);
    for (let i = 0; i < count; i++) {
      const offset = i * 16;
      for (let j = 0; j < 16; j++) data[i * 16 + j] = this.boneMatrices[offset + j] ?? 0;
    }
    return { data, size, boneCount: count };
  }

  /** Releases the palette references; the bones themselves are untouched. */
  public dispose(): void {
    this.boneInverses.length = 0;
    this.bones.length = 0;
    this.initialized = false;
  }

  /** JSON-friendly summary, used by the debug overlay. */
  public toJSON(): { boneCount: number; bones: string[] } {
    return {
      boneCount: this.bones.length,
      bones: this.bones.map((bone, index) => bone.name || `bone${index}`),
    };
  }
}
