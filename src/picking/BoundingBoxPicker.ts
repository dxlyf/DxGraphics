/**
 * `BoundingBoxPicker` — broad-phase picking against bounding volumes.
 *
 * Sometimes a triangle-accurate answer is the wrong answer. A spatial index build, a
 * frustum-style click-drag selection, an editor marquee or a "which object did I
 * roughly grab?" test all want the cheap answer, and they want it fast.
 *
 * This picker tests a ray against an object's bounding sphere and/or axis-aligned
 * box, reports the *entry* distance, and never touches a triangle. It is the same
 * fast-reject `Raycaster` performs internally, exposed as a picker in its own right.
 *
 * ```ts
 * const picker = new BoundingBoxPicker();
 * const hits = picker.pickAll(scene.children, ray);   // broad phase
 * const narrow = new Raycaster(ray).intersectObjects(hits.map((h) => h.object));
 * ```
 *
 * @packageDocumentation
 */

import { Vec3 } from '../math/Vec3';
import type {
  BoundsIntersection,
  BoundingBoxPickOptions,
  Object3DLike,
  PickRay,
} from './types';

/** A bounds-shaped value accepted by this picker. */
export interface BoundsLike {
  /** Sphere centre. */
  center?: { x: number; y: number; z: number };
  /** Sphere radius. */
  radius?: number;
  /** Box minimum corner. */
  min?: { x: number; y: number; z: number };
  /** Box maximum corner. */
  max?: { x: number; y: number; z: number };
  /** `true` for an empty box. */
  isEmpty?(): boolean;
}

/** One bounding-volume hit. */
export interface BoundsHit<TTarget = unknown> {
  /** The object whose bounds were hit. */
  object: TTarget;
  /** Entry distance along the ray. */
  distance: number;
  /** Entry point in world space. */
  point: Vec3;
  /** Which volume produced the hit. */
  volume: 'sphere' | 'box';
  /** Which layer bit matched, when the object exposes `layers`. */
  layer?: number;
}

/**
 * Broad-phase ray picking against bounding volumes.
 */
export class BoundingBoxPicker {
  /**
   * Tests one object's bounding volume.
   *
   * The sphere is preferred when the object exposes both, because it is cheaper and
   * cannot produce a false negative for a convex hull.
   *
   * @param object Object to test.
   * @param ray World-space ray.
   * @param options Tolerance and volume selection.
   * @returns The hit, or `null`.
   */
  public pick(
    object: Object3DLike,
    ray: PickRay,
    options: BoundingBoxPickOptions = {},
  ): BoundsHit | null {
    if (object == null || object.visible === false) return null;

    const tolerance = options.tolerance ?? 0;
    const near = ray.near ?? 0;
    const far = ray.far ?? Infinity;
    const layer = (object as { layers?: number }).layers;

    if (options.useSphere !== false) {
      const sphere = this.volumeOf(object, 'sphere');
      if (sphere !== null && sphere.radius !== undefined && sphere.center !== undefined) {
        const distance = this.raySphere(ray, sphere.center, sphere.radius + tolerance, near, far);
        if (distance !== null) {
          return {
            object,
            distance,
            point: this.pointAt(ray, distance),
            volume: 'sphere',
            ...(layer === undefined ? {} : { layer }),
          };
        }
        if (options.useSphere === true || !options.useSphere) {
          // An explicit sphere-only request stops here.
          if (options.useSphere === true) return null;
        }
      }
    }

    const box = this.volumeOf(object, 'box');
    if (box !== null && box.min !== undefined && box.max !== undefined) {
      if (box.isEmpty?.() === true) return null;
      const distance = this.rayBox(ray, box.min, box.max, tolerance, near, far);
      if (distance !== null) {
        return {
          object,
          distance,
          point: this.pointAt(ray, distance),
          volume: 'box',
          ...(layer === undefined ? {} : { layer }),
        };
      }
    }

    return null;
  }

  /**
   * Tests a flat list of objects and returns the hits, nearest-first.
   *
   * @param objects Objects to test; traversal is **not** recursive.
   * @param ray World-space ray.
   * @param options Tolerance and volume selection.
   * @returns The hits.
   */
  public pickAll(
    objects: readonly Object3DLike[],
    ray: PickRay,
    options: BoundingBoxPickOptions = {},
  ): BoundsHit[] {
    const hits: BoundsHit[] = [];
    for (const object of objects) {
      const hit = this.pick(object, ray, options);
      if (hit !== null) hits.push(hit);
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  /**
   * Recursively tests an object tree.
   *
   * @param root Root object.
   * @param ray World-space ray.
   * @param options Tolerance and volume selection.
   * @returns The hits, nearest-first.
   */
  public pickRecursive(
    root: Object3DLike,
    ray: PickRay,
    options: BoundingBoxPickOptions = {},
  ): BoundsHit[] {
    const hits: BoundsHit[] = [];
    const stack: Object3DLike[] = [root];
    while (stack.length > 0) {
      const object = stack.pop() as Object3DLike;
      if (object === null || object === undefined) continue;
      const hit = this.pick(object, ray, options);
      if (hit !== null) hits.push(hit);
      const children = object.children;
      if (Array.isArray(children)) {
        for (const child of children) stack.push(child);
      }
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  /**
   * Tests objects and appends `BoundsIntersection` records.
   *
   * @param objects Objects to test.
   * @param ray World-space ray.
   * @param intersects Destination array.
   * @param options Tolerance and volume selection.
   * @returns The number of records appended.
   */
  public intersect(
    objects: readonly Object3DLike[],
    ray: PickRay,
    intersects: BoundsIntersection[],
    options: BoundingBoxPickOptions = {},
  ): number {
    const hits = this.pickAll(objects, ray, options);
    for (const hit of hits) {
      intersects.push({
        object: hit.object,
        distance: hit.distance,
        point: hit.point,
        type: 'bounds',
        ...(hit.layer === undefined ? {} : { layer: hit.layer }),
      });
    }
    return hits.length;
  }

  /* -------------------------------------------------------------- geometry */

  /**
   * Analytic ray/sphere entry distance.
   *
   * @param ray World-space ray.
   * @param center Sphere centre.
   * @param radius Sphere radius.
   * @param near Near bound.
   * @param far Far bound.
   * @returns The entry distance, or `null` for a miss.
   */
  public raySphere(
    ray: PickRay,
    center: { x: number; y: number; z: number },
    radius: number,
    near: number,
    far: number,
  ): number | null {
    const ox = ray.origin.x - center.x;
    const oy = ray.origin.y - center.y;
    const oz = ray.origin.z - center.z;

    const projected = ox * ray.direction.x + oy * ray.direction.y + oz * ray.direction.z;
    const constant = ox * ox + oy * oy + oz * oz - radius * radius;
    const discriminant = projected * projected - constant;
    if (discriminant < 0) return null;

    const root = Math.sqrt(discriminant);
    // Prefer the entry point; a ray that starts inside reports its near bound.
    const entry = -projected - root;
    const distance = entry >= near ? entry : near;
    if (distance > far) return null;
    return distance;
  }

  /**
   * Slab test against an axis-aligned box.
   *
   * @param ray World-space ray.
   * @param min Box minimum corner.
   * @param max Box maximum corner.
   * @param tolerance Extra slack added to every side.
   * @param near Near bound.
   * @param far Far bound.
   * @returns The entry distance, or `null` for a miss.
   */
  public rayBox(
    ray: PickRay,
    min: { x: number; y: number; z: number },
    max: { x: number; y: number; z: number },
    tolerance: number,
    near: number,
    far: number,
  ): number | null {
    let tMin = near;
    let tMax = far;

    const axes = ['x', 'y', 'z'] as const;

    for (const axis of axes) {
      const origin = ray.origin[axis];
      const direction = ray.direction[axis];
      const low = min[axis] - tolerance;
      const high = max[axis] + tolerance;

      if (Math.abs(direction) < 1e-12) {
        if (origin < low || origin > high) return null;
        continue;
      }

      const inverse = 1 / direction;
      let t1 = (low - origin) * inverse;
      let t2 = (high - origin) * inverse;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }

      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return null;
    }

    return tMin;
  }

  /** Reads a bounding volume off an object or its geometry. */
  private volumeOf(object: Object3DLike, kind: 'sphere' | 'box'): BoundsLike | null {
    const holder = object as {
      boundingSphere?: BoundsLike | null;
      boundingBox?: BoundsLike | null;
      geometry?: { boundingSphere?: BoundsLike | null; boundingBox?: BoundsLike | null } | null;
    };

    const direct = kind === 'sphere' ? holder.boundingSphere : holder.boundingBox;
    if (direct != null) return direct;

    const geometry = holder.geometry;
    if (geometry != null) {
      const fromGeometry = kind === 'sphere' ? geometry.boundingSphere : geometry.boundingBox;
      if (fromGeometry != null) return fromGeometry;
    }
    return null;
  }

  /** Point along the ray at `distance`. */
  private pointAt(ray: PickRay, distance: number): Vec3 {
    return new Vec3(
      ray.origin.x + ray.direction.x * distance,
      ray.origin.y + ray.direction.y * distance,
      ray.origin.z + ray.direction.z * distance,
    );
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return 'BoundingBoxPicker()';
  }
}

/**
 * Convenience factory mirroring `new BoundingBoxPicker()`.
 *
 * @returns A new bounds picker.
 */
export function boundingBoxPicker(): BoundingBoxPicker {
  return new BoundingBoxPicker();
}
