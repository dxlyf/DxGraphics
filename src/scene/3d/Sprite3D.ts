/**
 * `Sprite3D` - a camera-facing textured quad.
 *
 * The billboard orientation is resolved by the renderer (it needs the camera
 * basis); {@link Sprite3D.raycast} therefore tests a world-aligned quad centred
 * on the sprite, which is exact for an orthographic camera looking down `+Z`
 * and a close approximation otherwise.
 *
 * @packageDocumentation
 */

import { Vec2 } from '../../math/Vec2';
import { Vec3 } from '../../math/Vec3';
import { Object3D } from './Object3D';
import { passesLayerTest, toLocalRay } from './Mesh';
import { isMaterialVisible } from '../internal/raycast';
import type { Intersects, MaterialLike, Object3DOptions, RaycasterLike } from './types';

/** Ray origin in the sprite's local frame. */
const localOrigin = new Vec3();

/** Ray direction in the sprite's local frame. */
const localDirection = new Vec3();

/** Options accepted by the {@link Sprite3D} constructor. */
export interface Sprite3DOptions extends Object3DOptions {
  /** Shading material. */
  material?: MaterialLike | null;
  /** Normalised anchor of the quad, in `[0, 1]`; defaults to the centre. */
  center?: Vec2;
  /** Scales the sprite with distance when `true` (the default). */
  sizeAttenuation?: boolean;
  /** Hit radius used by {@link Sprite3D.raycast}, in world units. */
  threshold?: number;
}

/** A billboard quad that always faces the camera. */
export class Sprite3D extends Object3D {
  /** Allows consumers to detect a sprite without an `instanceof` check. */
  public readonly isSprite3D: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'Sprite3D';

  /** Normalised anchor of the quad; `(0, 0)` is its bottom-left corner. */
  public readonly center: Vec2;

  /** Shading material. */
  public material: MaterialLike | null;

  /** Scales the quad with distance when `true`. */
  public sizeAttenuation: boolean;

  /** Hit radius used by {@link Sprite3D.raycast}, in world units. */
  public threshold: number;

  /** Creates a sprite. */
  constructor(options: Sprite3DOptions = {}) {
    super(options);
    this.material = options.material ?? null;
    this.center = options.center ? options.center.clone() : new Vec2(0.5, 0.5);
    this.sizeAttenuation = options.sizeAttenuation ?? true;
    this.threshold = options.threshold ?? 1;
  }

  /** Returns a clone of this sprite; the material is shared. */
  public override clone(recursive = true): Sprite3D {
    const clone = new Sprite3D().copy(this, recursive) as Sprite3D;
    clone.material = this.material;
    clone.center.copy(this.center);
    clone.sizeAttenuation = this.sizeAttenuation;
    clone.threshold = this.threshold;
    return clone;
  }

  /** Copies the material and anchor of `source`. */
  public override copy(source: Object3D, recursive = true): this {
    super.copy(source, recursive);
    if (source instanceof Sprite3D) {
      this.material = source.material;
      this.center.copy(source.center);
      this.sizeAttenuation = source.sizeAttenuation;
      this.threshold = source.threshold;
    }
    return this;
  }

  /**
   * Tests the ray against the sprite's unrotated quad.
   *
   * The quad spans `center` (as a normalised anchor) over the sprite's `scale`
   * in the local unit square; the hit is reported in world space.
   */
  public override raycast(raycaster: RaycasterLike, intersects: Intersects): void {
    if (!passesLayerTest(raycaster, this.layers)) return;
    if (!isMaterialVisible(this.material ?? undefined) && this.material !== null) return;
    if (!toLocalRay(this, raycaster, localOrigin, localDirection)) return;

    // The billboard plane is approximated by z = 0 through the sprite origin.
    if (Math.abs(localDirection.z) < 1e-8) return;
    const t = -localOrigin.z / localDirection.z;
    if (t < 0) return;

    const hitX = localOrigin.x + localDirection.x * t;
    const hitY = localOrigin.y + localDirection.y * t;

    const width = Math.abs(this.scale.x);
    const height = Math.abs(this.scale.y);
    const minX = -this.center.x * width;
    const minY = -this.center.y * height;
    const maxX = minX + width;
    const maxY = minY + height;

    const tolerance = this.threshold;
    if (hitX < minX - tolerance || hitX > maxX + tolerance) return;
    if (hitY < minY - tolerance || hitY > maxY + tolerance) return;

    const worldPoint = new Vec3(hitX, hitY, 0).applyMat4(this.matrixWorld);
    intersects.push({
      distance: worldPoint.distanceTo(raycaster.ray.origin),
      point: worldPoint,
      object: this,
    });
  }
}
