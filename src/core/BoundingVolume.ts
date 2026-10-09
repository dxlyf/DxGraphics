/**
 * `BoundingVolume` — world-space bounds for culling, picking and shadow fitting.
 *
 * A single bounding sphere is enough for frustum culling, but shadow-map fitting,
 * 2D hit testing and editor gizmos need the box as well, so this class owns both
 * and keeps them in sync with the object's world matrix.
 *
 * ```ts
 * const bounds = new BoundingVolume();
 * bounds.setFromGeometry(geometry);
 * bounds.update(worldMatrix);
 * if (frustum.intersectsSphere(bounds.sphere)) { ... }
 * ```
 *
 * @packageDocumentation
 */

import { Box3 } from '../math/Box3';
import { Mat4 } from '../math/Mat4';
import { Plane } from '../math/Plane';
import { Sphere } from '../math/Sphere';
import { Vec3 } from '../math/Vec3';
import type { Ray } from '../math/Ray';

/** Structural description of a geometry, so this module needs no geometry import. */
export interface BoundsSource {
  /** Returns the attribute with the given name, if present. */
  getAttribute?(name: string): { array: ArrayLike<number>; itemSize: number; count: number } | undefined;
  /** Returns the index buffer, if present. */
  getIndex?(): { array: ArrayLike<number> } | undefined;
  /** Precomputed local-space bounding box, when the geometry exposes one. */
  boundingBox?: Box3 | null;
  /** Precomputed local-space bounding sphere, when the geometry exposes one. */
  boundingSphere?: Sphere | null;
  /** Draw range in vertices/elements. */
  drawRange?: { start: number; count: number };
  /** `true` for indexed geometry. */
  indexed?: boolean;
}

/** Which representation a query should use. */
export enum BoundsType {
  /** Use the bounding sphere (cheapest, most conservative). */
  Sphere = 'sphere',
  /** Use the bounding box (tighter for box-shaped objects). */
  Box = 'box',
  /** Choose automatically: box when available, otherwise sphere. */
  Auto = 'auto',
}

/** Options for {@link BoundingVolume}. */
export interface BoundingVolumeOptions {
  /** Also compute the local-space box from the geometry's positions. */
  computeBox?: boolean;
  /** Store a world-space radius cached for quick radius tests. */
  cacheRadius?: boolean;
}

/**
 * Local + world bounding volumes for one scene object.
 */
export class BoundingVolume {
  /** Local-space (object-space) box, before the world matrix is applied. */
  public readonly localBox: Box3 = new Box3();

  /** Local-space sphere, before the world matrix is applied. */
  public readonly localSphere: Sphere = new Sphere();

  /** World-space box. */
  public readonly box: Box3 = new Box3();

  /** World-space sphere. */
  public readonly sphere: Sphere = new Sphere();

  /** Largest world-space scale component, cached for radius scaling. */
  public worldScale = 1;

  /** `true` when the local volumes have been computed. */
  public hasLocalBounds = false;

  /** `true` when the world volumes are up to date with the world matrix. */
  public hasWorldBounds = false;

  /** Version counter bumped on every `update`, so owners can memoise derived data. */
  public version = 0;

  /* --------------------------------------------------------------- sources */

  /**
   * Computes the local box and sphere from a geometry-like object.
   *
   * Prefers the geometry's own precomputed volumes when present, and falls back
   * to scanning the `position` attribute.
   *
   * @returns `this`, so calls chain.
   */
  public setFromGeometry(geometry: BoundsSource | null | undefined): this {
    if (!geometry) {
      this.localBox.makeEmpty();
      this.localSphere.makeEmpty();
      this.hasLocalBounds = false;
      this.hasWorldBounds = false;
      return this;
    }

    if (geometry.boundingBox) {
      this.localBox.copy(geometry.boundingBox);
    } else {
      this.computeBoxFromGeometry(geometry);
    }

    if (geometry.boundingSphere) {
      this.localSphere.copy(geometry.boundingSphere);
    } else {
      this.localSphere.setFromPoints(this.samplePoints(this.localBox));
      // A tighter sphere than "centroid + max distance" is unnecessary for
      // culling; document the approximation rather than paying for Welzl's
      // algorithm on every geometry.
      this.localSphere.radius *= 1.0;
    }

    this.hasLocalBounds = true;
    this.hasWorldBounds = false;
    return this;
  }

  /** Scans the geometry's `position` attribute into {@link localBox}. */
  private computeBoxFromGeometry(geometry: BoundsSource): void {
    const position = geometry.getAttribute?.('position');
    this.localBox.makeEmpty();
    if (!position) return;

    const { array, itemSize } = position;
    const stride = itemSize > 0 ? itemSize : 3;
    const start = geometry.drawRange?.start ?? 0;
    const count = position.count > 0 ? position.count : Math.floor(array.length / stride);
    const end = geometry.drawRange ? Math.min(count, start + geometry.drawRange.count) : count;

    const point = BoundingVolume.scratchPoint;
    for (let i = start; i < end; i++) {
      const offset = i * stride;
      point.set(array[offset] ?? 0, array[offset + 1] ?? 0, array[offset + 2] ?? 0);
      this.localBox.expandByPoint(point);
    }
  }

  /** Returns the eight corners of a box as a new array of vectors. */
  private samplePoints(box: Box3): Vec3[] {
    if (box.isEmpty()) return [];
    const { min, max } = box;
    const points: Vec3[] = [];
    for (let i = 0; i < 8; i++) {
      points.push(
        new Vec3(
          (i & 1) === 0 ? min.x : max.x,
          (i & 2) === 0 ? min.y : max.y,
          (i & 4) === 0 ? min.z : max.z,
        ),
      );
    }
    return points;
  }

  /** Sets the local volumes from an explicit list of points. */
  public setFromPoints(points: readonly Vec3[]): this {
    this.localBox.setFromPoints(points as Vec3[]);
    this.localSphere.setFromPoints(points as Vec3[]);
    this.hasLocalBounds = true;
    this.hasWorldBounds = false;
    return this;
  }

  /** Sets the local volumes from an existing box. */
  public setFromBox(box: Box3): this {
    this.localBox.copy(box);
    this.localSphere.center.copy(box.getCenter());
    this.localSphere.radius = box.getSize().length() * 0.5;
    this.hasLocalBounds = true;
    this.hasWorldBounds = false;
    return this;
  }

  /** Sets the local volumes from an existing sphere. */
  public setFromSphere(sphere: Sphere): this {
    this.localSphere.copy(sphere);
    this.localBox.setFromCenterAndSize(
      sphere.center.clone(),
      new Vec3(sphere.radius * 2, sphere.radius * 2, sphere.radius * 2),
    );
    this.hasLocalBounds = true;
    this.hasWorldBounds = false;
    return this;
  }

  /* -------------------------------------------------------------- transforms */

  /**
   * Applies a world matrix, recomputing the world-space volumes.
   *
   * The world box is the transformed local box (all eight corners), and the world
   * sphere is the local sphere scaled by the largest axis of the world matrix,
   * which stays conservative under non-uniform scaling.
   *
   * ## Why `worldMatrix` is optional
   *
   * Omitting it applies the identity, which simply publishes the local volumes as the
   * world volumes. That matters because `box`/`sphere` are the *world-space* pair and
   * stay empty (`Sphere.makeEmpty()` sets `radius = -1`) until this method runs, while
   * `setFromBox`/`setFromPoints`/`setFromSphere` fill `localBox`/`localSphere` and the
   * geometry convenience fills both from a geometry's cached bounds.
   *
   * Reading `volume.sphere` after `setFromBox` without calling `update()` therefore
   * yields an empty sphere whose radius is `-1`: it silently rejects everything, and
   * `intersectsSphere` returns `false` for a volume that is plainly in view. An
   * identity transform is the correct reading of "the local bounds *are* the world
   * bounds" — an object at the origin with no transform — so defaulting to it removes
   * that trap.
   *
   * @param worldMatrix Object-to-world matrix; identity when omitted.
   */
  public update(worldMatrix: Mat4 = identityMatrix): this {
    if (!this.hasLocalBounds) {
      this.box.makeEmpty();
      this.sphere.makeEmpty();
      this.hasWorldBounds = false;
      return this;
    }

    this.worldScale = worldMatrix.getMaxScaleOnAxis();

    this.box.copy(this.localBox);
    this.box.applyMat4(worldMatrix);

    this.sphere.center.copy(this.localSphere.center).applyMat4(worldMatrix);
    this.sphere.radius = this.localSphere.radius * this.worldScale;

    this.hasWorldBounds = true;
    this.version++;
    return this;
  }

  /** Forces the world volumes to be recomputed on the next {@link update}. */
  public invalidate(): this {
    this.hasWorldBounds = false;
    return this;
  }

  /* --------------------------------------------------------------- queries */

  /** `true` when the local volumes are empty or were never computed. */
  public get isEmpty(): boolean {
    return !this.hasLocalBounds || this.localBox.isEmpty();
  }

  /** `true` when the given world-space point is inside the world box. */
  public containsPoint(point: Vec3): boolean {
    return this.box.containsPoint(point);
  }

  /** `true` when the world bounding sphere intersects `other`. */
  public intersectsVolume(other: BoundingVolume): boolean {
    return this.sphere.intersectsSphere(other.sphere) || this.box.intersectsBox(other.box);
  }

  /** `true` when the world bounding sphere intersects a plane. */
  public intersectsPlane(plane: Plane): boolean {
    return this.sphere.intersectsPlane(plane);
  }

  /** `true` when the given ray intersects the world bounding sphere. */
  public intersectsRay(ray: Ray): boolean {
    return ray.intersectsSphere(this.sphere);
  }

  /**
   * Conservative quick-reject: a cheap radius test against a view position.
   *
   * Returns `false` only when the object is definitely outside `distance` of
   * `viewPosition`, which is what the renderer uses for near/far rejection.
   */
  public isWithinDistance(viewPosition: Vec3, distance: number): boolean {
    const limit = distance + this.sphere.radius;
    return this.sphere.center.distanceToSquared(viewPosition) <= limit * limit;
  }

  /** Approximate volume of the world box; `0` when empty. */
  public getVolume(): number {
    return this.box.isEmpty() ? 0 : this.box.getSize().x * this.box.getSize().y * this.box.getSize().z;
  }

  /** Surface area of the world box; `0` when empty. */
  public getSurfaceArea(): number {
    if (this.box.isEmpty()) return 0;
    const size = this.box.getSize();
    return 2 * (size.x * size.y + size.y * size.z + size.z * size.x);
  }

  /* --------------------------------------------------------------- output */

  /** Copies every volume and flag from `source`. */
  public copy(source: BoundingVolume): this {
    this.localBox.copy(source.localBox);
    this.localSphere.copy(source.localSphere);
    this.box.copy(source.box);
    this.sphere.copy(source.sphere);
    this.worldScale = source.worldScale;
    this.hasLocalBounds = source.hasLocalBounds;
    this.hasWorldBounds = source.hasWorldBounds;
    this.version = source.version;
    return this;
  }

  /** Returns a new volume with the same values. */
  public clone(): BoundingVolume {
    return new BoundingVolume().copy(this);
  }

  /** JSON-friendly representation. */
  public toJSON(): {
    localBox: { min: number[]; max: number[] };
    localSphere: { center: number[]; radius: number };
    box: { min: number[]; max: number[] };
    sphere: { center: number[]; radius: number };
    worldScale: number;
  } {
    return {
      localBox: { min: this.localBox.min.toArray(), max: this.localBox.max.toArray() },
      localSphere: { center: this.localSphere.center.toArray(), radius: this.localSphere.radius },
      box: { min: this.box.min.toArray(), max: this.box.max.toArray() },
      sphere: { center: this.sphere.center.toArray(), radius: this.sphere.radius },
      worldScale: this.worldScale,
    };
  }

  /** Human-readable representation. */
  public toString(precision: number = 3): string {
    return `BoundingVolume(center=${this.sphere.center.toString(precision)}, radius=${this.sphere.radius.toFixed(precision)})`;
  }

  /** Scratch point reused while scanning positions. */
  private static readonly scratchPoint = new Vec3();
}

/**
 * Shared identity transform, used as {@link BoundingVolume.update}'s default.
 *
 * A module-level constant rather than a per-call allocation: `update()` runs once per
 * object per frame in a culling pass, and allocating a `Mat4` for the common
 * "no transform" case would be the only allocation in that path.
 */
const identityMatrix = new Mat4();

/**
 * Computes the local bounding sphere of a point cloud.
 *
 * Uses the bounding-box centre as the sphere centre and the farthest point as the
 * radius. This is **not** the minimal enclosing sphere, but it is within a factor
 * of √3 of optimal, costs a single pass, and never underestimates — which is the
 * property culling needs.
 */
export function computeBoundingSphereFromPoints(
  points: readonly Vec3[],
  target: Sphere = new Sphere(),
): Sphere {
  if (points.length === 0) return target.makeEmpty();

  const box = new Box3().setFromPoints(points as Vec3[]);
  const center = box.getCenter();
  let maxSquared = 0;
  for (const point of points) {
    const distance = point.distanceToSquared(center);
    if (distance > maxSquared) maxSquared = distance;
  }
  target.center.copy(center);
  target.radius = Math.sqrt(maxSquared);
  return target;
}

/** `true` when a bounding sphere fully contains a box. */
export function sphereContainsBox(sphere: Sphere, box: Box3): boolean {
  if (sphere.isEmpty() || box.isEmpty()) return false;
  // Distance from the sphere centre to the farthest box corner.
  const dx = Math.max(Math.abs(box.min.x - sphere.center.x), Math.abs(box.max.x - sphere.center.x));
  const dy = Math.max(Math.abs(box.min.y - sphere.center.y), Math.abs(box.max.y - sphere.center.y));
  const dz = Math.max(Math.abs(box.min.z - sphere.center.z), Math.abs(box.max.z - sphere.center.z));
  return Math.hypot(dx, dy, dz) <= sphere.radius;
}
