/**
 * `Group3D` - a transform-only container.
 *
 * Groups exist so several nodes can be moved, rotated and scaled together
 * without duplicating the transform on each child, and so a renderer can apply
 * one frustum test to a whole sub-assembly.
 *
 * @packageDocumentation
 */

import { Object3D } from './Object3D';
import type { Object3DOptions } from './types';

/** An `Object3D` with no rendering payload of its own. */
export class Group3D extends Object3D {
  /** Allows consumers to detect a group without an `instanceof` check. */
  public readonly isGroup3D: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'Group3D';

  /** Creates a group. */
  constructor(options: Object3DOptions = {}) {
    super(options);
  }

  /** Returns a shallow copy; children are cloned only when `recursive` is set. */
  public override clone(recursive = true): Group3D {
    return new Group3D().copy(this, recursive) as Group3D;
  }
}
