/**
 * `Group2D` - a plain transform-only container.
 *
 * A group has no visual representation of its own: it exists so several nodes can
 * be moved, rotated, scaled and faded together, and so a single hit test can
 * cover a whole sub-assembly.
 *
 * @packageDocumentation
 */

import { Node2D } from './Node2D';
import type { Node2DOptions } from './types';

/** A container that transforms its children without drawing anything. */
export class Group2D extends Node2D {
  /** Allows consumers to detect a group without an `instanceof` check. */
  public readonly isGroup2D: true = true;

  /** Class name used by serialisation and the backend's dispatch. */
  public override readonly type: string = 'Group2D';

  /** Creates a group. */
  constructor(options: Node2DOptions = {}) {
    super(options);
  }

  /** Returns a new group with the same state. */
  public override clone(recursive = true): Group2D {
    return this.createInstance().copy(this, recursive) as Group2D;
  }

  /** Creates an empty `Group2D`, used by `clone()`. */
  protected override createInstance(): Node2D {
    return new Group2D();
  }
}
