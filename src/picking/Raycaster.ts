/**
 * `Raycaster` — world-space ray casting over a scene graph.
 *
 * ```ts
 * const raycaster = new Raycaster();
 * raycaster.setFromCamera(pointerNdc, camera);
 * const hits = raycaster.intersectObjects(scene.children, true);
 * hits[0]?.object;   // nearest object under the pointer
 * ```
 *
 * ## Design
 *
 * Picking is **pull**-based and the raycaster owns the traversal. Two code paths
 * produce hits:
 *
 * 1. **Delegation.** When an object exposes `raycast(raycaster, intersects)` — which
 *    `Mesh`, `Line`, `LineSegments`, `Points`, `Sprite3D` and `InstancedMesh` all
 *    do — that method is called with this raycaster. This is the path that keeps the
 *    scene graph's own material-aware, instance-aware tests authoritative.
 * 2. **Fallback.** For a bare structural object with only `geometry` and
 *    `matrixWorld`, the shared walkers in `raycastData.ts` run instead, so a
 *    hand-built test fixture picks correctly without needing the scene graph.
 *
 * Before either path, a **bounding-volume fast reject** runs whenever the object or
 * its geometry exposes a bounding sphere, which is what keeps a cast against a
 * 10 000-object scene cheap.
 *
 * @packageDocumentation
 */

import { DEFAULT_MAX_PICK_RESULTS } from '../constants';
import { Mat4 } from '../math/Mat4';
import { Vec2 } from '../math/Vec2';
import { Vec3 } from '../math/Vec3';
import {
  raycastLine,
  raycastPoints,
  raycastTriangles,
  readPositions,
  type LocalRay,
} from './raycastData';
import type {
  CameraLike,
  IntersectionLike,
  MaterialLike,
  Object3DLike,
  PickThresholds,
  RaycasterLike,
  RaycasterOptions,
} from './types';

/** A bounds-shaped value accepted by the fast reject. */
interface BoundsLike {
  center?: { x: number; y: number; z: number };
  radius?: number;
  min?: { x: number; y: number; z: number };
  max?: { x: number; y: number; z: number };
}

/**
 * Casts rays into a scene graph.
 *
 * Implements {@link RaycasterLike}, so it can be handed straight to
 * `Mesh.raycast` and friends.
 */
export class Raycaster implements RaycasterLike {
  /** The ray being cast; mutated in place by the setters. */
  public readonly ray = {
    origin: new Vec3(),
    direction: new Vec3(0, 0, -1),
  };

  /** Minimum distance along the ray. */
  public near: number;

  /** Maximum distance along the ray. */
  public far: number;

  /**
   * Layer bitmask.
   *
   * `undefined` accepts every layer; a number restricts the cast to objects that
   * share at least one bit with it (the test suite relies on this).
   */
  public layers: number | undefined;

  /** Per-primitive hit radii and culling flags, read by the objects' raycasts. */
  public readonly params: PickThresholds & { backfaceCulling?: boolean };

  /** Upper bound on the number of hits returned; `Infinity` disables the cap. */
  public maxResults: number;

  /**
   * Creates a raycaster.
   *
   * @param options Initial ray, bounds and thresholds.
   */
  constructor(options: RaycasterOptions = {}) {
    if (options.origin !== undefined) this.ray.origin.copy(options.origin);
    if (options.direction !== undefined) {
      this.ray.direction.copy(options.direction);
      this.ray.direction.normalize();
    }
    this.near = options.near ?? 0;
    this.far = options.far ?? Infinity;
    this.layers = options.layers;
    this.maxResults = options.maxResults ?? DEFAULT_MAX_PICK_RESULTS;
    this.params = {
      Mesh: { threshold: options.params?.Mesh?.threshold ?? 0 },
      Line: { threshold: options.params?.Line?.threshold ?? 1 },
      Points: { threshold: options.params?.Points?.threshold ?? 1 },
      Sprite: { threshold: options.params?.Sprite?.threshold ?? 0 },
      backfaceCulling: options.backfaceCulling ?? options.params?.backfaceCulling ?? false,
    };
  }

  /* ------------------------------------------------------------------ setup */

  /**
   * Sets the ray from an origin and a direction.
   *
   * @param origin Ray origin in world space.
   * @param direction Direction; normalised internally.
   * @returns This raycaster, for chaining.
   */
  public set(origin: Vec3, direction: Vec3): this {
    this.ray.origin.copy(origin);
    this.ray.direction.copy(direction);
    this.ray.direction.normalize();
    return this;
  }

  /**
   * Sets the ray from a camera and a normalised device coordinate.
   *
   * `ndc.x`/`ndc.y` are in `[-1, 1]` (the DOM convention: `y` grows upwards on
   * screen because NDC does), so a pointer's pixel position must be converted with
   * {@link Raycaster.ndcFromPointer} first.
   *
   * @param ndc Normalised device coordinates.
   * @param camera Camera to cast through.
   * @returns This raycaster, for chaining.
   * @throws Error When the camera exposes neither `unprojectPoint` nor an inverse
   *   projection matrix, so the cast cannot be constructed.
   */
  public setFromCamera(ndc: { x: number; y: number }, camera: CameraLike): this {
    // Preferred path: let the camera do the unprojection, because only it knows its
    // full viewport/frustum configuration.
    if (typeof camera.unprojectPoint === 'function') {
      const nearPoint = camera.unprojectPoint(new Vec3(ndc.x, ndc.y, -1), new Vec3());
      const farPoint = camera.unprojectPoint(new Vec3(ndc.x, ndc.y, 1), new Vec3());
      this.ray.origin.copy(nearPoint);

      if (this.isOrthographic(camera)) {
        // Orthographic: the ray direction is the view direction, not the
        // near-to-far vector, which is precise for every NDC z.
        const direction = new Vec3(0, 0, -1);
        const inverse = readMatrix(camera.matrixWorldInverse);
        if (inverse !== null) {
          direction.applyMat4(inverse);
          // `matrixWorldInverse` is a rigid transform, so direction needs no w-fix.
        }
        this.ray.direction.copy(direction).normalize();
      } else {
        this.ray.direction.subVectors(farPoint, nearPoint).normalize();
      }
      return this;
    }

    const projectionInverse = readMatrix(camera.projectionMatrixInverse);
    const world = readMatrix(camera.matrixWorld);
    if (projectionInverse === null || world === null) {
      throw new Error(
        'Raycaster.setFromCamera: the camera exposes neither `unprojectPoint` nor the ' +
          '`projectionMatrixInverse` + `matrixWorld` pair needed to build a ray.',
      );
    }

    const nearPoint = new Vec3(ndc.x, ndc.y, -1).applyMat4(projectionInverse).applyMat4(world);
    const farPoint = new Vec3(ndc.x, ndc.y, 1).applyMat4(projectionInverse).applyMat4(world);

    if (this.isOrthographic(camera)) {
      const direction = new Vec3(0, 0, -1).applyMat4(world).sub(world.getTranslation());
      this.ray.origin.copy(nearPoint);
      this.ray.direction.copy(direction).normalize();
    } else {
      this.ray.origin.copy(world.getTranslation());
      this.ray.direction.subVectors(farPoint, nearPoint).normalize();
    }
    return this;
  }

  /**
   * Converts a pointer position in element pixels to normalised device coordinates.
   *
   * @param x Pointer X, in CSS pixels from the element's left edge.
   * @param y Pointer Y, in CSS pixels from the element's **top** edge.
   * @param width Element width in CSS pixels.
   * @param height Element height in CSS pixels.
   * @param target Vector to write; a new one is allocated when omitted.
   * @returns The NDC pair, with `y` flipped into the GL convention.
   */
  public static ndcFromPointer(
    x: number,
    y: number,
    width: number,
    height: number,
    target: Vec2 = new Vec2(),
  ): Vec2 {
    const safeWidth = width > 0 ? width : 1;
    const safeHeight = height > 0 ? height : 1;
    return target.set((x / safeWidth) * 2 - 1, -(y / safeHeight) * 2 + 1);
  }

  /** Instance form of {@link Raycaster.ndcFromPointer}. */
  public ndcFromPointer(
    x: number,
    y: number,
    width: number,
    height: number,
    target: Vec2 = new Vec2(),
  ): Vec2 {
    return Raycaster.ndcFromPointer(x, y, width, height, target);
  }

  /** `true` when the camera reports itself (or its projection) as orthographic. */
  private isOrthographic(camera: CameraLike): boolean {
    if (camera.isOrthographic === true) return true;
    const inverse = readMatrix(camera.projectionMatrixInverse);
    if (inverse === null) return false;
    // An orthographic projection has a zero `m[3][3]` (elements[15] here).
    return Math.abs(inverse.elements[15]) < 1e-6;
  }

  /* --------------------------------------------------------------- casting */

  /**
   * Casts against one object, optionally recursing into its children.
   *
   * @param object Object to test.
   * @param recursive Recurse into `children`.
   * @param intersects Destination array; a new one is allocated when omitted.
   * @returns The destination array, sorted nearest-first and truncated to
   *   {@link Raycaster.maxResults}.
   */
  public intersectObject(
    object: Object3DLike,
    recursive = false,
    intersects: IntersectionLike[] = [],
  ): IntersectionLike[] {
    if (object == null) return intersects;

    if (object.visible !== false && this.testLayers(object)) {
      this.castAgainst(object, intersects);
    }

    if (recursive && Array.isArray(object.children)) {
      for (const child of object.children) this.intersectObject(child, true, intersects);
    }

    return this.finish(intersects);
  }

  /**
   * Casts against several objects.
   *
   * @param objects Objects to test.
   * @param recursive Recurse into each object's `children`.
   * @param intersects Destination array; a new one is allocated when omitted.
   * @returns The destination array, sorted nearest-first and truncated.
   */
  public intersectObjects(
    objects: readonly Object3DLike[],
    recursive = false,
    intersects: IntersectionLike[] = [],
  ): IntersectionLike[] {
    if (!Array.isArray(objects)) return intersects;

    for (const object of objects) {
      if (object == null) continue;
      if (object.visible !== false && this.testLayers(object)) {
        this.castAgainst(object, intersects);
      }
      if (recursive && Array.isArray(object.children)) {
        this.intersectObjects(object.children, true, intersects);
      }
    }

    return this.finish(intersects);
  }

  /**
   * `true` when the object's layer bitmask overlaps this raycaster's.
   *
   * @param object Object to test.
   * @returns `true` when the object should be considered.
   */
  public testLayers(object: Object3DLike): boolean {
    if (this.layers === undefined) return true;
    const objectLayers = typeof object.layers === 'number' ? object.layers : 1;
    return (objectLayers & this.layers) !== 0;
  }

  /** Dispatches one object to its raycast method, or to the fallback walkers. */
  private castAgainst(object: Object3DLike, intersects: IntersectionLike[]): void {
    if (!this.materialIsVisible(object.material)) return;

    if (!this.passesBoundsReject(object)) return;

    if (typeof object.raycast === 'function') {
      // The scene graph owns the authoritative test; hand it this raycaster and it
      // reads `near`, `far`, `layers` and `params` from here.
      object.raycast(this, intersects);
      return;
    }

    const geometry = object.geometry;
    if (geometry == null) return;

    const localRay = this.toLocalRay(object);
    if (localRay === null) return;

    const worldMatrix = object.matrixWorld;

    if (object.isPoints === true) {
      raycastPoints(geometry, localRay, object, intersects, this.pointThreshold, worldMatrix);
      return;
    }
    if (object.isLine === true || object.isLineSegments === true) {
      raycastLine(
        geometry,
        localRay,
        object,
        intersects,
        this.lineThreshold,
        object.isLineSegments === true,
        worldMatrix,
      );
      return;
    }
    if (object.isSprite3D === true) {
      // A sprite without its own raycast can only be tested against its origin.
      raycastPoints(geometry, localRay, object, intersects, this.spriteThreshold, worldMatrix);
      return;
    }

    raycastTriangles(geometry, localRay, object, intersects, {
      backfaceCulling: this.params.backfaceCulling ?? false,
      worldMatrix,
    });
  }

  /** Effective hit radius for line primitives. */
  private get lineThreshold(): number {
    return this.params.Line?.threshold ?? 1;
  }

  /** Effective hit radius for point clouds. */
  private get pointThreshold(): number {
    return this.params.Points?.threshold ?? 1;
  }

  /** Effective hit radius for sprites. */
  private get spriteThreshold(): number {
    return this.params.Sprite?.threshold ?? 0;
  }

  /** `true` when a material (or material array) permits a hit. */
  private materialIsVisible(material: MaterialLike | readonly MaterialLike[] | null | undefined): boolean {
    if (material == null) return true;
    const list: readonly MaterialLike[] = Array.isArray(material)
      ? (material as readonly MaterialLike[])
      : [material as MaterialLike];

    for (const entry of list) {
      if (entry == null) continue;
      if (entry.visible === false) continue;
      const opacity = entry.opacity ?? 1;
      if (entry.transparent === true && opacity <= 0) continue;
      return true;
    }
    return list.length === 0;
  }

  /**
   * Cheap bounding-volume reject.
   *
   * Uses the geometry's cached bounding sphere when present, then the object's own
   * `boundingSphere`/`boundingBox`. A missing bound means "cannot reject", never
   * "reject".
   *
   * @param object Object to test.
   * @returns `true` when the object may still be hit.
   */
  public passesBoundsReject(object: Object3DLike): boolean {
    const sphere =
      (object as { boundingSphere?: BoundsLike | null }).boundingSphere ??
      (object.geometry as { boundingSphere?: BoundsLike | null } | undefined)?.boundingSphere ??
      null;

    if (sphere != null && typeof sphere.radius === 'number' && sphere.center !== undefined) {
      return this.intersectsSphere(sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius);
    }
    return true;
  }

  /**
   * `true` when the ray's `[near, far]` window reaches a sphere.
   *
   * @param cx Sphere centre X.
   * @param cy Sphere centre Y.
   * @param cz Sphere centre Z.
   * @param radius Sphere radius.
   * @returns `true` on intersection.
   */
  public intersectsSphere(cx: number, cy: number, cz: number, radius: number): boolean {
    const ox = this.ray.origin.x - cx;
    const oy = this.ray.origin.y - cy;
    const oz = this.ray.origin.z - cz;

    const projected = ox * this.ray.direction.x + oy * this.ray.direction.y + oz * this.ray.direction.z;
    const distanceSq = ox * ox + oy * oy + oz * oz - projected * projected;
    if (distanceSq > radius * radius) return false;

    const halfChord = Math.sqrt(Math.max(0, radius * radius - distanceSq));
    const enter = projected - halfChord;
    const exit = projected + halfChord;
    return exit >= this.near && enter <= this.far;
  }

  /**
   * The ray transformed into an object's local space.
   *
   * @param object Object supplying `matrixWorld`.
   * @returns The local ray, or `null` when the world matrix is singular.
   */
  public toLocalRay(object: Object3DLike): LocalRay | null {
    const world = readMatrix(object.matrixWorld);
    if (world === null) {
      return { origin: this.ray.origin.clone(), direction: this.ray.direction.clone(), near: this.near, far: this.far };
    }

    const inverse = world.clone().invert();
    if (!inverse.isInvertible()) return null;

    const origin = this.ray.origin.clone().applyMat4(inverse);
    const target = this.ray.origin.clone().add(this.ray.direction).applyMat4(inverse);
    const direction = target.sub(origin).normalize();

    // The local n-direction is scaled by the inverse world scale, so the distance
    // window is expressed in the same units the walkers measure in. For the
    // uniform-scale case (everything a renderer produces) the factor is exactly
    // `1 / worldScale`.
    const scale = inverse.getMaxScaleOnAxis() || 1;

    return { origin, direction, near: this.near * scale, far: this.far * scale };
  }

  /** Sorts nearest-first and truncates to {@link Raycaster.maxResults}. */
  private finish(intersects: IntersectionLike[]): IntersectionLike[] {
    intersects.sort((a, b) => a.distance - b.distance);
    if (Number.isFinite(this.maxResults) && intersects.length > this.maxResults) {
      intersects.length = this.maxResults;
    }
    return intersects;
  }

  /**
   * Casts against a pre-flattened list, skipping traversal entirely.
   *
   * @param objects Objects to test, in any order.
   * @returns The hits, sorted nearest-first.
   */
  public intersectFlat(objects: readonly Object3DLike[]): IntersectionLike[] {
    const intersects: IntersectionLike[] = [];
    for (const object of objects) {
      if (object == null || object.visible === false) continue;
      if (!this.testLayers(object)) continue;
      this.castAgainst(object, intersects);
    }
    return this.finish(intersects);
  }

  /**
   * @returns A copy of this raycaster with the same ray and options.
   */
  public clone(): Raycaster {
    return new Raycaster({
      origin: this.ray.origin.clone(),
      direction: this.ray.direction.clone(),
      near: this.near,
      far: this.far,
      layers: this.layers,
      params: {
        Mesh: { threshold: this.params.Mesh?.threshold ?? 0 },
        Line: { threshold: this.lineThreshold },
        Points: { threshold: this.pointThreshold },
        Sprite: { threshold: this.spriteThreshold },
        backfaceCulling: this.params.backfaceCulling ?? false,
      },
      maxResults: this.maxResults,
    });
  }

  /**
   * @returns A human-readable description.
   */
  public toString(): string {
    return (
      `Raycaster(origin=${this.ray.origin.toString(3)}, direction=${this.ray.direction.toString(3)}, ` +
      `near=${this.near}, far=${this.far})`
    );
  }
}

/** Reads a `Mat4` out of any `{ elements }` object. */
function readMatrix(source: { elements: ArrayLike<number> } | undefined): Mat4 | null {
  if (source === undefined || source == null) return null;
  const elements = source.elements;
  if (elements === undefined || elements.length < 16) return null;
  return new Mat4(elements);
}

/**
 * Convenience factory mirroring `new Raycaster(options)`.
 *
 * @param options Initial ray, bounds and thresholds.
 * @returns A new raycaster.
 */
export function raycaster(options: RaycasterOptions = {}): Raycaster {
  return new Raycaster(options);
}
