/**
 * `Bone` - a joint in a skeletal hierarchy.
 *
 * A bone is an ordinary `Object3D`; the only thing that makes it special is
 * that `Skeleton` reads its world matrix to build the skinning palette. Bones
 * are usually parented to one another, so rotating a shoulder moves the elbow
 * and the wrist with it.
 *
 * @packageDocumentation
 */

import { Object3D } from './Object3D';
import type { Object3DOptions } from './types';

/** A single joint of a `Skeleton`. */
export class Bone extends Object3D {
  /** Allows consumers to detect a bone without an `instanceof` check. */
  public readonly isBone: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'Bone';

  /** Creates a bone. */
  constructor(options: Object3DOptions = {}) {
    super(options);
  }

  /** Creates a bone with the given children already attached. */
  public static withChildren(...children: Object3D[]): Bone {
    const bone = new Bone();
    bone.add(...children);
    return bone;
  }

  /** Returns a clone of this bone, children included when `recursive` is set. */
  public override clone(recursive = true): Bone {
    return new Bone().copy(this, recursive) as Bone;
  }
}
