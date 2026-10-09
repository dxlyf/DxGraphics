/**
 * `DirectionalLight` - a parallel light with a direction but no position.
 *
 * The direction is `position -> target`; the renderer only cares about that
 * vector, so moving the light far away does not change the shading. The target
 * is a real node, which makes parenting it to the light or to the scene both
 * work, matching the usual authoring patterns.
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../math/Vec3';
import { Object3D } from './Object3D';
import { Light } from './Light';
import type { DirectionalLightOptions } from './types';

/** A light whose rays are parallel. */
export class DirectionalLight extends Light {
  /** Allows consumers to detect the class without an `instanceof` check. */
  public readonly isDirectionalLight: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'DirectionalLight';

  /** Node the light points at; defaults to a child of the light. */
  public readonly target: Object3D;

  /** Creates a directional light. */
  constructor(options: DirectionalLightOptions = {}) {
    super(options);
    this.target = options.target ?? new Object3D({ name: `${this.name || 'directional'}-target` });
    if (options.shadow) this.shadow = { ...this.shadow, ...options.shadow };
  }

  /** Lights look down their `-Z` axis, like cameras. */
  protected override isCameraLike(): boolean {
    return true;
  }

  /** Copies the light and points the copy at the same target position. */
  public override copy(source: Object3D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof DirectionalLight) {
      source.target.getWorldPosition(scratchTarget);
      this.target.position.copy(scratchTarget);
    }
    return this;
  }

  /** Returns a clone of this light, sharing nothing but its parameters. */
  public override clone(recursive = true): DirectionalLight {
    return new DirectionalLight().copy(this, recursive) as DirectionalLight;
  }
}

/** Scratch vector used when copying the target. */
const scratchTarget = new Vec3();
