/**
 * `Points` - a `BufferGeometry` rendered as point sprites.
 *
 * Picking uses the same local-space ray trick as `Mesh`: each vertex is tested
 * against the ray and is reported when it comes within `threshold` world units.
 *
 * @packageDocumentation
 */

import { DEFAULT_POINT_SIZE } from '../../constants';
import { Vec3 } from '../../math/Vec3';
import { Mesh } from './Mesh';
import { pointThreshold, readVertex } from '../internal/raycast';
import type { MeshOptions } from './Mesh';
import type { AttributeLike, Intersects } from './types';
import type { RaycasterLike } from './types';

/** Vertex under test, in local space. */
const vertex = new Vec3();

/** Closest point on the ray to the vertex under test. */
const closest = new Vec3();

/** Options accepted by the {@link Points} constructor. */
export interface PointsOptions extends MeshOptions {
  /** Hit radius, in world units; defaults to `1`. */
  threshold?: number;
}

/** A geometry whose vertices are drawn as individual points. */
export class Points extends Mesh {
  /** Allows consumers to detect a point cloud without an `instanceof` check. */
  public readonly isPoints: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'Points';

  /** Hit radius applied by {@link Points.raycast}, in world units. */
  public threshold: number;

  /** Point size requested from the backend, in device pixels. */
  public size: number = DEFAULT_POINT_SIZE;

  /** Creates a point cloud. */
  constructor(options: PointsOptions = {}) {
    super(options);
    this.threshold = options.threshold ?? 1;
  }

  /** Returns a clone of this point cloud; geometry and material are shared. */
  public override clone(recursive = true): Points {
    const clone = new Points().copy(this, recursive) as Points;
    clone.threshold = this.threshold;
    clone.size = this.size;
    return clone;
  }

  /**
   * Intersects `raycaster` with every vertex of {@link Mesh.geometry}.
   *
   * The raycaster's `params.Points.threshold` takes precedence over
   * {@link Points.threshold} when it is set to a positive number.
   */
  public override raycast(raycaster: RaycasterLike, intersects: Intersects): void {
    const geometry = this.geometryData;
    const position: AttributeLike | null =
      geometry?.position ?? geometry?.attributes.position ?? null;
    if (!geometry || !position) return;
    if (!this.prepareRaycast(raycaster)) return;

    const threshold = pointThreshold(raycaster) || this.threshold;
    const radius = threshold > 0 ? threshold : 1;
    const radiusSquared = radius * radius;
    const direction = this.localRayDirection;
    const origin = this.localRayOrigin;
    const vertexCount = position.count ?? Math.floor(position.array.length / position.itemSize);

    for (let i = 0; i < vertexCount; i++) {
      readVertex(position, i, vertex);
      const alongRay = vertex.clone().sub(origin).dot(direction);
      closest.copy(direction).multiplyScalar(alongRay).add(origin);
      if (vertex.distanceToSquared(closest) > radiusSquared) continue;

      const worldPoint = vertex.clone().applyMat4(this.matrixWorld);
      intersects.push({
        distance: worldPoint.distanceTo(raycaster.ray.origin),
        point: worldPoint,
        object: this,
        index: i,
      });
    }
  }
}
