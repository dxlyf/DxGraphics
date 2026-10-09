/**
 * `SpritePicker` — billboard-aware picking for camera-facing quads.
 *
 * A sprite has no meaningful geometry to raycast: it is a screen-aligned rectangle
 * whose world-space extents depend on the camera. Testing its bounding box would be
 * wrong at grazing angles, and testing a fixed quad would be wrong after any camera
 * move.
 *
 * This picker reconstructs the billboard: it reads the camera's world basis, spans
 * the quad along the camera's right and up axes (optionally rolled by the sprite's
 * own rotation), intersects the ray with that plane, and reports a hit only when it
 * lands inside the quad and inside `[near, far]`.
 *
 * ```ts
 * const hit = new SpritePicker().pick(sprite, ray, camera);
 * hit?.uv;   // (0,0) bottom-left to (1,1) top-right of the sprite
 * ```
 *
 * ## Size model
 *
 * The quad's half extents are `size * scale * 0.5` (or an explicit `width`/`height`).
 * With `sizeAttenuation !== false` the quad is divided by the camera distance, so a
 * sprite keeps a roughly constant screen size; with `sizeAttenuation: false` the
 * authored size is used verbatim, which is what a UI sprite wants.
 *
 * @packageDocumentation
 */

import { Vec2 } from '../math/Vec2';
import { Vec3 } from '../math/Vec3';
import type { CameraLike, Object3DLike, PickRay, SpritePickOptions } from './types';

/** A sprite-shaped object. */
export interface SpriteLike extends Object3DLike {
  /** Billboard centre offset, in half-extent units. */
  center?: { x: number; y: number };
  /** Size in world units; width and height default to it. */
  size?: number;
  /** Sprite width; defaults to `size`. */
  width?: number;
  /** Sprite height; defaults to `size`. */
  height?: number;
  /** `false` keeps the authored size regardless of camera distance. */
  sizeAttenuation?: boolean;
  /** Uniform scale applied to both axes. */
  scale?: { x: number; y: number; z: number };
  /** Local rotation about the view axis, in radians. */
  rotation?: number;
  /** Extra hit radius in world units. */
  threshold?: number;
}

/** One sprite hit. */
export interface SpriteHit {
  /** The sprite that was hit. */
  sprite: SpriteLike;
  /** Distance along the ray to the quad. */
  distance: number;
  /** World-space hit point. */
  point: Vec3;
  /** Quad-local coordinate: `(0, 0)` bottom-left, `(1, 1)` top-right. */
  uv: Vec2;
  /** Signed offset from the quad centre, in world units. */
  offset: Vec2;
}

/**
 * Billboard-aware sprite picking.
 */
export class SpritePicker {
  /** Reused right-axis scratch. */
  private readonly right = new Vec3();

  /** Reused up-axis scratch. */
  private readonly up = new Vec3();

  /** Reused forward-axis scratch. */
  private readonly forward = new Vec3();

  /**
   * Tests a sprite against a world-space ray.
   *
   * @param sprite Sprite to test.
   * @param ray World-space ray.
   * @param camera Camera defining the billboard orientation.
   * @param options Threshold and rotation handling.
   * @returns The hit, or `null`.
   */
  public pick(
    sprite: SpriteLike,
    ray: PickRay,
    camera: CameraLike,
    options: SpritePickOptions = {},
  ): SpriteHit | null {
    if (sprite == null || sprite.visible === false) return null;

    this.computeBasis(camera, sprite, options.ignoreRotation === true);

    const origin = this.worldOrigin(sprite);
    const halfWidth = this.halfExtent(sprite, 'width', camera, origin);
    const halfHeight = this.halfExtent(sprite, 'height', camera, origin);

    const center = sprite.center;
    const centrePoint = origin.clone();
    if (center !== undefined && (center.x !== 0 || center.y !== 0)) {
      centrePoint
        .addScaledVector(this.right, center.x * halfWidth * 2)
        .addScaledVector(this.up, center.y * halfHeight * 2);
    }

    // Plane normal is the camera's forward axis (right x up).
    const denominator = this.forward.dot(ray.direction);
    if (Math.abs(denominator) < 1e-9) return null; // Parallel to the billboard.

    const toCentre = new Vec3().subVectors(centrePoint, ray.origin);
    const distance = toCentre.dot(this.forward) / denominator;
    const near = ray.near ?? 0;
    const far = ray.far ?? Infinity;
    if (distance < near || distance > far) return null;

    const point = new Vec3(
      ray.origin.x + ray.direction.x * distance,
      ray.origin.y + ray.direction.y * distance,
      ray.origin.z + ray.direction.z * distance,
    );

    const offsetVector = new Vec3().subVectors(point, centrePoint);
    const offset = new Vec2(offsetVector.dot(this.right), offsetVector.dot(this.up));

    const threshold = options.threshold ?? sprite.threshold ?? 0;
    if (Math.abs(offset.x) > halfWidth + threshold || Math.abs(offset.y) > halfHeight + threshold) {
      return null;
    }

    const uv = new Vec2(
      halfWidth > 0 ? offset.x / (halfWidth * 2) + 0.5 : 0.5,
      halfHeight > 0 ? offset.y / (halfHeight * 2) + 0.5 : 0.5,
    );

    return { sprite, distance, point, uv, offset };
  }

  /**
   * Tests many sprites and returns the nearest hit.
   *
   * @param sprites Sprites to test.
   * @param ray World-space ray.
   * @param camera Camera defining the billboard orientation.
   * @param options Threshold and rotation handling.
   * @returns The nearest hit, or `null`.
   */
  public pickNearest(
    sprites: readonly SpriteLike[],
    ray: PickRay,
    camera: CameraLike,
    options: SpritePickOptions = {},
  ): SpriteHit | null {
    let best: SpriteHit | null = null;
    for (const sprite of sprites) {
      const hit = this.pick(sprite, ray, camera, options);
      if (hit === null) continue;
      if (best === null || hit.distance < best.distance) best = hit;
    }
    return best;
  }

  /**
   * Recursively tests a tree and appends every sprite hit.
   *
   * @param root Root object.
   * @param ray World-space ray.
   * @param camera Camera defining the billboard orientation.
   * @param intersects Destination array; records are `IntersectionLike`-shaped.
   * @param options Threshold and rotation handling.
   * @returns The number of hits appended.
   */
  public intersectRecursive(
    root: Object3DLike,
    ray: PickRay,
    camera: CameraLike,
    intersects: unknown[],
    options: SpritePickOptions = {},
  ): number {
    const stack: Object3DLike[] = [root];
    let count = 0;

    while (stack.length > 0) {
      const object = stack.pop() as Object3DLike;
      if (object === null || object === undefined) continue;

      if (object.isSprite3D === true) {
        const hit = this.pick(object as SpriteLike, ray, camera, options);
        if (hit !== null) {
          intersects.push({
            distance: hit.distance,
            point: hit.point,
            object,
            uv: hit.uv,
            type: 'sprite',
          });
          count++;
        }
      }

      const children = object.children;
      if (Array.isArray(children)) {
        for (const child of children) stack.push(child);
      }
    }
    return count;
  }

  /* ---------------------------------------------------------------- basis */

  /** Fills {@link SpritePicker.right}, {@link SpritePicker.up} and `forward`. */
  private computeBasis(camera: CameraLike, sprite: SpriteLike, ignoreRotation: boolean): void {
    const inverse = camera.matrixWorldInverse?.elements;
    const world = camera.matrixWorld?.elements;

    if (inverse !== undefined && inverse.length >= 16) {
      // Rows of the view matrix are the camera's world-space basis vectors.
      this.right.set(inverse[0], inverse[4], inverse[8]).normalize();
      this.up.set(inverse[1], inverse[5], inverse[9]).normalize();
      this.forward.set(-inverse[2], -inverse[6], -inverse[10]).normalize();
    } else if (world !== undefined && world.length >= 16) {
      this.right.set(world[0], world[4], world[8]).normalize();
      this.up.set(world[1], world[5], world[9]).normalize();
      this.forward.set(-world[2], -world[6], -world[10]).normalize();
    } else {
      this.right.set(1, 0, 0);
      this.up.set(0, 1, 0);
      this.forward.set(0, 0, -1);
    }

    const roll = ignoreRotation ? 0 : (sprite.rotation ?? 0);
    if (roll === 0) return;

    const cos = Math.cos(roll);
    const sin = Math.sin(roll);
    const rotatedRight = this.right.clone().multiplyScalar(cos).addScaledVector(this.up, sin);
    const rotatedUp = this.up.clone().multiplyScalar(cos).addScaledVector(this.right, -sin);

    this.right.copy(rotatedRight).normalize();
    this.up.copy(rotatedUp).normalize();
  }

  /** The sprite's world position. */
  private worldOrigin(sprite: SpriteLike): Vec3 {
    const matrix = sprite.matrixWorld;
    if (matrix !== undefined && matrix.elements.length >= 16) {
      const e = matrix.elements;
      return new Vec3(e[12], e[13], e[14]);
    }
    const position = (sprite as { position?: { x: number; y: number; z: number } }).position;
    return new Vec3(position?.x ?? 0, position?.y ?? 0, position?.z ?? 0);
  }

  /** The camera's world position. */
  private cameraPosition(camera: CameraLike): Vec3 {
    const world = camera.matrixWorld?.elements;
    if (world !== undefined && world.length >= 16) {
      return new Vec3(world[12], world[13], world[14]);
    }
    const position = (camera as { position?: { x: number; y: number; z: number } }).position;
    return new Vec3(position?.x ?? 0, position?.y ?? 0, position?.z ?? 0);
  }

  /* ---------------------------------------------------------------- size */

  /** Authored half extent for one axis, before attenuation. */
  private rawExtent(sprite: SpriteLike, axis: 'width' | 'height'): number {
    const scale = sprite.scale;
    const scaleFactor = axis === 'width' ? (scale?.x ?? 1) : (scale?.y ?? 1);
    const size = sprite.size ?? 1;
    const explicit = axis === 'width' ? sprite.width : sprite.height;
    return (explicit ?? size) * scaleFactor * 0.5;
  }

  /** Half extent in world units, applying size attenuation when requested. */
  private halfExtent(sprite: SpriteLike, axis: 'width' | 'height', camera: CameraLike, origin: Vec3): number {
    const half = this.rawExtent(sprite, axis);
    if (sprite.sizeAttenuation === false) return half;

    const distance = this.cameraPosition(camera).distanceTo(origin);
    if (distance <= 1e-6) return half;
    return half / distance;
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return 'SpritePicker()';
  }
}

/**
 * Convenience factory mirroring `new SpritePicker()`.
 *
 * @returns A new sprite picker.
 */
export function spritePicker(): SpritePicker {
  return new SpritePicker();
}
