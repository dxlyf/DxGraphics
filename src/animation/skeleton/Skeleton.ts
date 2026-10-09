/**
 * `SkeletonUtils` — animation-side rig helpers.
 *
 * The class hierarchy a skeleton implies already exists in `src/scene/3d`
 * (`Bone`, `Skeleton`, `SkinnedMesh`); what is missing there is the *authoring* and
 * *retargeting* surface an animation system needs. That is what this module
 * provides, as stateless helpers over structural interfaces so it never has to
 * import the scene graph and therefore can never drift out of sync with it.
 *
 * ```ts
 * const rig = SkeletonUtils.fromHierarchy(root, 'Hips');
 * const finder = SkeletonUtils.createFinder(root);
 * finder('LeftHand');                      // the bone, or undefined
 * SkeletonUtils.calculateInverses(rig.bones);
 * SkeletonUtils.copyPose(source, target, { scale: false });
 * ```
 *
 * ## Why `Bone` is not redefined here
 *
 * See `animation/skeleton/Bone.ts`: the library keeps exactly one `Bone` class, in
 * `src/scene/3d/Bone.ts`, and this directory re-exports it. {@link BoneLike} exists
 * only so these helpers can be written without importing `src/scene`.
 *
 * @packageDocumentation
 */

import { Mat4 } from '../../math/Mat4';
import { Quat } from '../../math/Quat';
import { Vec3 } from '../../math/Vec3';

/* -------------------------------------------------------------------------- */
/* Structural views                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Structural view of a bone: a named node with a transform and children.
 *
 * Both `scene/3d/Bone` and `scene/3d/Object3D` satisfy this.
 */
export interface BoneLike {
  /** Bone name; the key every `bones[name]` track uses. */
  name: string;
  /** Optional stable identifier. */
  id?: string;
  /** Parent node, when the bone is part of a hierarchy. */
  parent?: BoneLike | null;
  /** Child nodes. */
  children?: BoneLike[];
  /** Local translation. */
  position?: { x: number; y: number; z: number };
  /** Local rotation as a quaternion. */
  quaternion?: { x: number; y: number; z: number; w: number };
  /** Local scale. */
  scale?: { x: number; y: number; z: number };
  /** World matrix, when the owner maintains one. */
  matrixWorld?: { elements: ArrayLike<number> };
  /** `true` for nodes explicitly flagged as bones. */
  isBone?: boolean;
}

/** Structural view of a skeleton. */
export interface SkeletonLike {
  /** Bones in skinning order. */
  bones: BoneLike[];
  /** Inverse bind matrices, one per bone. */
  boneInverses?: ArrayLike<number>[] | null;
}

/** A bone transform triple, as captured by {@link SkeletonUtils.savePose}. */
export interface BonePose {
  /** Bone name. */
  name: string;
  /** Local translation. */
  position: [number, number, number];
  /** Local rotation as `(x, y, z, w)`. */
  quaternion: [number, number, number, number];
  /** Local scale. */
  scale: [number, number, number];
}

/** Options accepted by {@link SkeletonUtils.copyPose}. */
export interface RetargetOptions {
  /** Copy local scale as well as rotation/translation; defaults to `true`. */
  scale?: boolean;
  /** Copy local translation; defaults to `true`. */
  translation?: boolean;
  /** Copy local rotation; defaults to `true`. */
  rotation?: boolean;
  /** Multiplier applied to copied translations. */
  translationScale?: number;
}

/* -------------------------------------------------------------------------- */
/* SkeletonUtils                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Stateless helpers over bone hierarchies.
 */
export class SkeletonUtils {
  /**
   * Tests whether a node looks like a bone.
   *
   * A node counts as a bone when it sets `isBone`, or when it is named and has no
   * non-bone children — the heuristic `AnimationMixer` uses when a rig was authored
   * without explicit `Bone` instances.
   *
   * @param node Candidate node.
   * @returns `true` when the node should be treated as a bone.
   */
  public static isBone(node: BoneLike | null | undefined): boolean {
    if (node == null) return false;
    return node.isBone === true;
  }

  /**
   * Flattens a hierarchy into skinning order.
   *
   * Order is **pre-order depth-first** from `root`, which is the order
   * `scene/3d/Skeleton` expects and the order GLTF/GLB exporters emit. Pass
   * `flatten` to include every descendant, or leave it off to collect only nodes
   * flagged as bones.
   *
   * @param root Hierarchy root.
   * @param all When `true`, every descendant is included regardless of `isBone`.
   * @returns Bones in pre-order.
   */
  public static fromHierarchy(root: BoneLike | null | undefined, all = true): BonePose[] {
    const bones: BoneLike[] = [];
    SkeletonUtils.traverse(root, (node) => {
      if (all || SkeletonUtils.isBone(node)) bones.push(node);
    });
    return bones.map((bone) => SkeletonUtils.saveBone(bone));
  }

  /**
   * Collects bone references (not poses) in pre-order.
   *
   * @param root Hierarchy root.
   * @param all Include every descendant, not only flagged bones.
   * @returns The bones found.
   */
  public static collect(root: BoneLike | null | undefined, all = true): BoneLike[] {
    const out: BoneLike[] = [];
    SkeletonUtils.traverse(root, (node) => {
      if (all || SkeletonUtils.isBone(node)) out.push(node);
    });
    return out;
  }

  /**
   * Depth-first traversal over a bone hierarchy, root included.
   *
   * @param root Node to start from.
   * @param callback Invoked once per node.
   */
  public static traverse(root: BoneLike | null | undefined, callback: (node: BoneLike) => void): void {
    if (root == null) return;
    callback(root);
    const children = root.children;
    if (!Array.isArray(children)) return;
    for (const child of children) SkeletonUtils.traverse(child, callback);
  }

  /**
   * Builds a name → bone lookup closure.
   *
   * The closure is what a `PropertyBinding` resolves `bones[hand]` against; building
   * it once per rig avoids a linear scan per track per frame.
   *
   * @param root Hierarchy root.
   * @returns A function from bone name to bone, or `undefined`.
   */
  public static createFinder(
    root: BoneLike | null | undefined,
  ): (name: string) => BoneLike | undefined {
    const index = new Map<string, BoneLike>();
    SkeletonUtils.traverse(root, (node) => {
      if (typeof node.name === 'string' && node.name.length > 0 && !index.has(node.name)) {
        index.set(node.name, node);
      }
    });
    return (name: string): BoneLike | undefined => index.get(name);
  }

  /**
   * Finds one bone by name.
   *
   * @param root Hierarchy root.
   * @param name Bone name.
   * @returns The bone, or `undefined`.
   */
  public static findByName(root: BoneLike | null | undefined, name: string): BoneLike | undefined {
    return SkeletonUtils.createFinder(root)(name);
  }

  /**
   * Finds a bone's index in skinning order.
   *
   * @param root Hierarchy root.
   * @param name Bone name.
   * @returns The zero-based index, or `-1`.
   */
  public static indexOf(root: BoneLike | null | undefined, name: string): number {
    const bones = SkeletonUtils.collect(root);
    return bones.findIndex((bone) => bone.name === name);
  }

  /* ---------------------------------------------------------------- posing */

  /**
   * Captures one bone's local transform.
   *
   * @param bone Bone to read.
   * @returns The captured pose.
   */
  public static saveBone(bone: BoneLike): BonePose {
    const position = bone.position ?? { x: 0, y: 0, z: 0 };
    const quaternion = bone.quaternion ?? { x: 0, y: 0, z: 0, w: 1 };
    const scale = bone.scale ?? { x: 1, y: 1, z: 1 };
    return {
      name: bone.name,
      position: [position.x, position.y, position.z],
      quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
      scale: [scale.x, scale.y, scale.z],
    };
  }

  /**
   * Captures every bone's local transform.
   *
   * @param root Hierarchy root.
   * @returns Poses in pre-order.
   */
  public static savePose(root: BoneLike | null | undefined): BonePose[] {
    return SkeletonUtils.collect(root).map((bone) => SkeletonUtils.saveBone(bone));
  }

  /**
   * Writes a captured pose back onto a hierarchy.
   *
   * @param root Hierarchy root.
   * @param pose Poses captured by {@link SkeletonUtils.savePose}.
   * @returns The number of bones that were written.
   */
  public static restorePose(root: BoneLike | null | undefined, pose: readonly BonePose[]): number {
    const finder = SkeletonUtils.createFinder(root);
    let written = 0;
    for (const entry of pose) {
      const bone = finder(entry.name);
      if (bone === undefined) continue;
      if (bone.position) {
        bone.position.x = entry.position[0];
        bone.position.y = entry.position[1];
        bone.position.z = entry.position[2];
      }
      if (bone.quaternion) {
        bone.quaternion.x = entry.quaternion[0];
        bone.quaternion.y = entry.quaternion[1];
        bone.quaternion.z = entry.quaternion[2];
        bone.quaternion.w = entry.quaternion[3];
      }
      if (bone.scale) {
        bone.scale.x = entry.scale[0];
        bone.scale.y = entry.scale[1];
        bone.scale.z = entry.scale[2];
      }
      written++;
    }
    return written;
  }

  /**
   * Copies a pose between two rigs by bone name.
   *
   * This is **name-based retargeting**: bones are matched by `name`, and only the
   * local transform channels selected by `options` are copied. Proportions are not
   * rescaled beyond `options.translationScale`, because doing so correctly requires
   * bind-pose data this helper deliberately does not assume.
   *
   * @param source Rig to read from.
   * @param target Rig to write to.
   * @param options Which channels to copy.
   * @returns The number of bones that were written.
   */
  public static copyPose(
    source: BoneLike | null | undefined,
    target: BoneLike | null | undefined,
    options: RetargetOptions = {},
  ): number {
    const copyTranslation = options.translation ?? true;
    const copyRotation = options.rotation ?? true;
    const copyScale = options.scale ?? true;
    const translationScale = options.translationScale ?? 1;

    const targetFinder = SkeletonUtils.createFinder(target);
    let written = 0;

    SkeletonUtils.traverse(source, (bone) => {
      const destination = targetFinder(bone.name);
      if (destination === undefined) return;

      if (copyTranslation && bone.position && destination.position) {
        destination.position.x = bone.position.x * translationScale;
        destination.position.y = bone.position.y * translationScale;
        destination.position.z = bone.position.z * translationScale;
      }
      if (copyRotation && bone.quaternion && destination.quaternion) {
        destination.quaternion.x = bone.quaternion.x;
        destination.quaternion.y = bone.quaternion.y;
        destination.quaternion.z = bone.quaternion.z;
        destination.quaternion.w = bone.quaternion.w;
      }
      if (copyScale && bone.scale && destination.scale) {
        destination.scale.x = bone.scale.x;
        destination.scale.y = bone.scale.y;
        destination.scale.z = bone.scale.z;
      }
      written++;
    });

    return written;
  }

  /* ------------------------------------------------------------- binding */

  /**
   * Computes inverse bind matrices from a hierarchy's current pose.
   *
   * The result is a column-major 16-float matrix per bone, in pre-order, ready to
   * hand to `scene/3d/Skeleton`. The hierarchy's world matrices must be current;
   * this helper does not traverse-and-update them itself because `Matrix4`
   * multiplication order is the owner's concern.
   *
   * @param bones Bones in skinning order, with up-to-date `matrixWorld` values.
   * @returns One inverted world matrix per bone.
   */
  public static calculateInverses(bones: readonly BoneLike[]): Mat4[] {
    return bones.map((bone) => {
      const inverse = new Mat4();
      const elements = bone.matrixWorld?.elements;
      if (elements === undefined) return inverse;
      inverse.fromArray(elements);
      // `Mat4.invert` returns the identity for a singular input, which is the
      // correct degenerate answer for a zero-scaled bone.
      return inverse.invert();
    });
  }

  /**
   * Builds a bind-pose snapshot from a hierarchy.
   *
   * @param root Hierarchy root.
   * @returns A pose array suitable for {@link SkeletonUtils.restorePose}.
   */
  public static bindPose(root: BoneLike | null | undefined): BonePose[] {
    return SkeletonUtils.savePose(root);
  }

  /**
   * Rebuilds every bone's world matrix from its local transform.
   *
   * The traversal is top-down, so a parent's world matrix is always current before
   * its children read it.
   *
   * @param root Hierarchy root.
   * @param parentMatrix World matrix of `root`'s parent; identity by default.
   * @returns The number of bones whose world matrix was written.
   */
  public static updateWorldMatrices(root: BoneLike | null | undefined, parentMatrix?: Mat4): number {
    const bones = SkeletonUtils.collect(root);
    if (bones.length === 0) return 0;

    const scratch = new Mat4();
    const local = new Mat4();
    const world = new Map<BoneLike, Mat4>();
    const inherited = parentMatrix ?? new Mat4().identity();
    let written = 0;

    for (const bone of bones) {
      const position = new Vec3(
        bone.position?.x ?? 0,
        bone.position?.y ?? 0,
        bone.position?.z ?? 0,
      );
      const quaternion = new Quat(
        bone.quaternion?.x ?? 0,
        bone.quaternion?.y ?? 0,
        bone.quaternion?.z ?? 0,
        bone.quaternion?.w ?? 1,
      );
      const scale = new Vec3(bone.scale?.x ?? 1, bone.scale?.y ?? 1, bone.scale?.z ?? 1);

      local.compose(position, quaternion, scale);

      const parent = bone.parent ?? null;
      const parentWorld = parent !== null ? world.get(parent) : undefined;
      scratch.multiplyMatrices(parentWorld ?? inherited, local);

      const stored = new Mat4().copy(scratch);
      world.set(bone, stored);

      const target = bone.matrixWorld as { elements: Float32Array } | undefined;
      if (target !== undefined && target.elements instanceof Float32Array) {
        target.elements.set(stored.elements);
        written++;
      }
    }

    return written;
  }
}

/**
 * Convenience alias so `skeletonUtils.findByName(root, 'Hips')` reads naturally.
 */
export const skeletonUtils = SkeletonUtils;
