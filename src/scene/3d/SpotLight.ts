/**
 * `SpotLight` - a point light restricted to a cone.
 *
 * `angle` is the half-angle of the cone (in radians) and `penumbra` softens the
 * edge: `0` is a hard cut-off, `1` fades from the axis to the rim. The light
 * direction is `position -> target`, exactly like `DirectionalLight`.
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../math/Vec3';
import { Object3D } from './Object3D';
import { Light } from './Light';
import type { SpotLightOptions, TextureLike } from './types';

/** A cone-shaped light. */
export class SpotLight extends Light {
  /** Allows consumers to detect the class without an `instanceof` check. */
  public readonly isSpotLight: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'SpotLight';

  /** Half-angle of the cone, in radians (`0 < angle <= PI / 2`). */
  public angle: number;

  /** Soft-edge fraction of the cone, in `[0, 1]`. */
  public penumbra: number;

  /** Maximum reach of the light; `0` means "no limit". */
  public distance: number;

  /** Physical falloff exponent. */
  public decay: number;

  /** Node the light points at; defaults to a child of the light. */
  public readonly target: Object3D;

  /** Projected texture, or `null` for an untextured cone. */
  public map: TextureLike | null;

  /** Creates a spot light. */
  constructor(options: SpotLightOptions = {}) {
    super(options);
    this.angle = options.angle ?? Math.PI / 3;
    this.penumbra = options.penumbra ?? 0;
    this.distance = options.distance ?? 0;
    this.decay = options.decay ?? 2;
    this.map = options.map ?? null;
    this.target = options.target ?? new Object3D({ name: `${this.name || 'spot'}-target` });
    if (options.shadow) this.shadow = { ...this.shadow, ...options.shadow };
  }

  /** Lights look down their `-Z` axis, like cameras. */
  protected override isCameraLike(): boolean {
    return true;
  }

  /**
   * Luminous flux, in lumens.
   *
   * Derived from {@link Light.intensity} with the same `4 * PI` convention as
   * `PointLight.power`.
   */
  public get power(): number {
    return this.intensity * 4 * Math.PI;
  }

  public set power(lumens: number) {
    this.intensity = lumens / (4 * Math.PI);
  }

  /** Copies the cone parameters, projected texture and target of `source`. */
  public override copy(source: Object3D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof SpotLight) {
      this.angle = source.angle;
      this.penumbra = source.penumbra;
      this.distance = source.distance;
      this.decay = source.decay;
      this.map = source.map;
      source.target.getWorldPosition(scratchTarget);
      this.target.position.copy(scratchTarget);
    }
    return this;
  }

  /** Returns a clone of this light. */
  public override clone(recursive = true): SpotLight {
    return new SpotLight().copy(this, recursive) as SpotLight;
  }
}

/** Scratch vector used when copying the target. */
const scratchTarget = new Vec3();
