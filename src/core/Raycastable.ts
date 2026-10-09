/**
 * `Raycastable` — the mixin that teaches a node how to be hit by a ray.
 *
 * The library keeps picking *pull*-based: the `Raycaster` owns the traversal and
 * candidate list, and a node only has to answer "do I intersect this ray?".
 * That keeps the hot path cache-friendly and lets a node skip work when it is not
 * in the candidate list.
 *
 * ```ts
 * class MyMesh extends RaycastableNode {
 *   public override raycast(ray, intersects) {
 *     if (!this.boundingSphere.intersectsRay(ray)) return; // cheap reject
 *     // ... precise test ...
 *   }
 * }
 * ```
 *
 * @packageDocumentation
 */

import type { Box3 } from '../math/Box3';
import type { Sphere } from '../math/Sphere';
import type { Vec3 } from '../math/Vec3';

/** A ray with an origin, a unit direction and optional distance bounds. */
export interface RayDescriptor {
  /** Ray origin in world space. */
  origin: Vec3;
  /** Unit direction in world space. */
  direction: Vec3;
  /** Minimum distance along the ray; defaults to `0`. */
  near: number;
  /** Maximum distance along the ray; defaults to `Infinity`. */
  far: number;
}

/** One hit appended to the candidate list. */
export interface RayHit<TTarget = unknown> {
  /** Distance along the ray. */
  distance: number;
  /** World-space intersection point. */
  point: Vec3;
  /** The object that was hit. */
  object: TTarget;
  /** Triangle index within the geometry, when applicable. */
  faceIndex?: number;
  /** Instance index for instanced draws. */
  instanceId?: number;
  /** Interpolated UV at the hit point. */
  uv?: { x: number; y: number };
}

/** Objects that expose a raycast method. */
export interface IRaycastable<TTarget = unknown> {
  /** Appends every intersection with `ray` to `intersects`. */
  raycast(ray: RayDescriptor, intersects: RayHit<TTarget>[]): void;
}

/** Options controlling how precise a raycast is. */
export interface RaycastOptions {
  /** Skip the bounding-sphere pre-test (useful when bounds are stale). */
  skipBoundsTest?: boolean;
  /** Extra world-space slack added to bounds tests. */
  tolerance?: number;
  /** Test the back faces of triangles too. */
  doubleSided?: boolean;
  /** Recursively test children. */
  recursive?: boolean;
}

/**
 * Adds raycast plumbing to a node without forcing a base class.
 *
 * Subclasses implement {@link RaycastableBase.raycastGeometry}; this base takes
 * care of the bounding-volume pre-test and of recording hits consistently.
 */
export abstract class RaycastableBase<TTarget = unknown> implements IRaycastable<TTarget> {
  /** World-space bounding sphere used for the cheap reject. */
  public boundingSphere: Sphere | null = null;

  /** World-space bounding box, used by box-based pickers. */
  public boundingBox: Box3 | null = null;

  /** `true` when this object should be considered by raycasters at all. */
  public raycastEnabled = true;

  /** Number of hits recorded over this object's lifetime; a debugging aid. */
  public raycastHitCount = 0;

  /**
   * Implements the bounding-volume pre-test, then delegates to
   * {@link RaycastableBase.raycastGeometry}.
   *
   * Subclasses normally do not override this; override
   * {@link RaycastableBase.raycastGeometry} instead.
   */
  public raycast(ray: RayDescriptor, intersects: RayHit<TTarget>[]): void {
    if (!this.raycastEnabled) return;

    if (this.boundingSphere && !sphereIntersectsRay(this.boundingSphere, ray)) return;
    if (this.boundingBox && !boxIntersectsRay(this.boundingBox, ray)) return;

    const before = intersects.length;
    this.raycastGeometry(ray, intersects);
    this.raycastHitCount += intersects.length - before;
  }

  /** Precise geometry test; must append every hit to `intersects`. */
  protected abstract raycastGeometry(ray: RayDescriptor, intersects: RayHit<TTarget>[]): void;
}

/* -------------------------------------------------------------------------- */
/* Shared geometric predicates (module-level so mixins can reuse them)         */
/* -------------------------------------------------------------------------- */

/**
 * Analytic ray/sphere intersection.
 *
 * A hit is reported when the ray's *segment* `[near, far]` reaches the sphere,
 * which is what picking wants; a ray originating inside the sphere reports a hit
 * at the near bound.
 */
export function sphereIntersectsRay(sphere: Sphere, ray: RayDescriptor): boolean {
  const ox = ray.origin.x - sphere.center.x;
  const oy = ray.origin.y - sphere.center.y;
  const oz = ray.origin.z - sphere.center.z;
  const b = ox * ray.direction.x + oy * ray.direction.y + oz * ray.direction.z;
  const c = ox * ox + oy * oy + oz * oz - sphere.radius * sphere.radius;

  // `t` of the closest approach along the infinite line.
  const t = -b;
  if (t >= ray.near && t <= ray.far) {
    return t * t + c <= sphere.radius * sphere.radius + 1e-9;
  }
  // The closest approach lies outside the segment: test the segment endpoints.
  const tClamped = t < ray.near ? ray.near : ray.far;
  if (!Number.isFinite(tClamped)) return true; // Unbounded ray, closest point is inside.
  return squaredDistanceAt(ray, tClamped) <= sphere.radius * sphere.radius + 1e-9;
}

/** Squared distance from the ray point at parameter `t` to the sphere centre. */
function squaredDistanceAt(ray: RayDescriptor, t: number): number {
  const px = ray.origin.x + ray.direction.x * t;
  const py = ray.origin.y + ray.direction.y * t;
  const pz = ray.origin.z + ray.direction.z * t;
  const dx = px - ray.origin.x;
  const dy = py - ray.origin.y;
  const dz = pz - ray.origin.z;
  return dx * dx + dy * dy + dz * dz;
}

/** Slab test against an axis-aligned box, honouring `near`/`far`. */
export function boxIntersectsRay(box: Box3, ray: RayDescriptor): boolean {
  if (box.isEmpty()) return false;

  let tMin = ray.near;
  let tMax = Number.isFinite(ray.far) ? ray.far : Infinity;

  for (const axis of ['x', 'y', 'z'] as const) {
    const origin = ray.origin[axis];
    const direction = ray.direction[axis];
    const min = box.min[axis];
    const max = box.max[axis];

    if (Math.abs(direction) < 1e-12) {
      if (origin < min || origin > max) return false;
      continue;
    }
    const inverse = 1 / direction;
    let t1 = (min - origin) * inverse;
    let t2 = (max - origin) * inverse;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }
  return true;
}

/** `true` when the ray's segment reaches within `tolerance` of a world point. */
export function pointWithinRay(ray: RayDescriptor, point: Vec3, tolerance: number): boolean {
  const t =
    (point.x - ray.origin.x) * ray.direction.x +
    (point.y - ray.origin.y) * ray.direction.y +
    (point.z - ray.origin.z) * ray.direction.z;
  if (t < ray.near - tolerance || t > ray.far + tolerance) return false;
  const dx = ray.origin.x + ray.direction.x * t - point.x;
  const dy = ray.origin.y + ray.direction.y * t - point.y;
  const dz = ray.origin.z + ray.direction.z * t - point.z;
  return dx * dx + dy * dy + dz * dz <= tolerance * tolerance;
}

/** `true` when `value` implements {@link IRaycastable}. */
export function isRaycastable(value: unknown): value is IRaycastable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as IRaycastable).raycast === 'function'
  );
}

/**
 * Mixin that overlays the {@link RaycastableBase} members onto an existing class.
 *
 * The host must provide `raycastGeometry(ray, intersects)` (usually as a method);
 * the mixin adds the bounds pre-test and the public `raycast` entry point.
 */
export function withRaycast<TBase extends abstract new (...args: any[]) => object>(
  Base: TBase,
): TBase & (abstract new (...args: any[]) => IRaycastable) {
  abstract class WithRaycast extends (Base as abstract new (...args: any[]) => object) {
    /** World-space bounding sphere used for the cheap reject. */
    public boundingSphere: Sphere | null = null;

    /** World-space bounding box. */
    public boundingBox: Box3 | null = null;

    /** `true` when this object should be considered by raycasters. */
    public raycastEnabled = true;

    /** See {@link RaycastableBase.raycast}. */
    public raycast(ray: RayDescriptor, intersects: RayHit[]): void {
      if (!this.raycastEnabled) return;
      if (this.boundingSphere && !sphereIntersectsRay(this.boundingSphere, ray)) return;
      if (this.boundingBox && !boxIntersectsRay(this.boundingBox, ray)) return;
      const test = (this as unknown as { raycastGeometry?: (r: RayDescriptor, i: RayHit[]) => void })
        .raycastGeometry;
      test?.call(this, ray, intersects);
    }
  }
  return WithRaycast as unknown as TBase & (abstract new (...args: any[]) => IRaycastable);
}
