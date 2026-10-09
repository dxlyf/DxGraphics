/**
 * `Line` - a continuous polyline through consecutive vertex pairs.
 *
 * Picking follows three.js: the ray and the local-space segment are converted
 * into a segment/segment distance test, and a segment is reported when it comes
 * within `raycaster.params.Line.threshold` (default `0`, i.e. an exact hit).
 *
 * @packageDocumentation
 */

import { DEFAULT_LINE_WIDTH } from '../../constants';
import { Vec3 } from '../../math/Vec3';
import { Mesh } from './Mesh';
import { indexItemCount, indexValueAt, lineThreshold, readVertex } from '../internal/raycast';
import type { MeshOptions } from './Mesh';
import type { AttributeLike, Intersects } from './types';
import type { RaycasterLike } from './types';

/** Segment start, in local space. */
const segmentStart = new Vec3();

/** Segment end, in local space. */
const segmentEnd = new Vec3();

/** Scratch: direction of the segment. */
const delta = new Vec3();

/** Scratch: offset between the segment origin and the ray origin. */
const offset = new Vec3();

/** Scratch: closest point on the ray. */
const closestOnRay = new Vec3();

/** Scratch: closest point on the segment. */
const closestOnSegment = new Vec3();

/** Options accepted by the {@link Line} constructor. */
export interface LineOptions extends MeshOptions {
  /** Rendered line width in device pixels; WebGL core profiles clamp this to `1`. */
  linewidth?: number;
}

/** A polyline; `LineSegments` is the disconnected variant. */
export class Line extends Mesh {
  /** Allows consumers to detect a line without an `instanceof` check. */
  public readonly isLine: true = true;

  /** Class name used by serialisation and the renderer's dispatch. */
  public override readonly type: string = 'Line';

  /** Requested line width in device pixels. */
  public linewidth: number;

  /** Creates a line. */
  constructor(options: LineOptions = {}) {
    super(options);
    this.linewidth = options.linewidth ?? DEFAULT_LINE_WIDTH;
  }

  /** Returns a clone of this line; geometry and material are shared. */
  public override clone(recursive = true): Line {
    const clone = new Line().copy(this, recursive) as Line;
    clone.linewidth = this.linewidth;
    return clone;
  }

  /**
   * Reads the vertex attribute a line pick needs.
   *
   * @returns The position attribute, or `null` when there is nothing to test.
   */
  protected positionAttribute(): AttributeLike | null {
    const geometry = this.geometryData;
    return geometry?.position ?? geometry?.attributes.position ?? null;
  }

  /**
   * Intersects `raycaster` with every segment of {@link Mesh.geometry}.
   *
   * Non-indexed geometry is read as `(0,1)`, `(1,2)`, ... `(n-2,n-1)`; indexed
   * geometry is read as `(i0,i1)`, `(i2,i3)`, ...
   */
  public override raycast(raycaster: RaycasterLike, intersects: Intersects): void {
    const position = this.positionAttribute();
    if (!position || !this.prepareRaycast(raycaster)) return;

    const thresholdSquared = Math.pow(lineThreshold(raycaster), 2);
    const index = this.geometryData?.index;
    const vertexCount = position.count ?? Math.floor(position.array.length / position.itemSize);

    if (index) {
      const pairCount = Math.floor(indexItemCount(index) / 2);
      for (let pair = 0; pair < pairCount; pair++) {
        this.testSegment(
          raycaster,
          position,
          indexValueAt(index, pair * 2),
          indexValueAt(index, pair * 2 + 1),
          thresholdSquared,
          intersects,
        );
      }
      return;
    }

    for (let i = 0; i + 1 < vertexCount; i++) {
      this.testSegment(raycaster, position, i, i + 1, thresholdSquared, intersects);
    }
  }

  /** Tests one segment and appends a hit when it is within the threshold. */
  protected testSegment(
    raycaster: RaycasterLike,
    position: AttributeLike,
    ia: number,
    ib: number,
    thresholdSquared: number,
    intersects: Intersects,
  ): void {
    readVertex(position, ia, segmentStart);
    readVertex(position, ib, segmentEnd);

    closestPointsSegmentToRay(
      segmentStart,
      segmentEnd,
      this.localRayOrigin,
      this.localRayDirection,
      closestOnSegment,
      closestOnRay,
    );

    if (closestOnSegment.distanceToSquared(closestOnRay) > thresholdSquared) return;

    // The hit is reported on the segment, not on the ray: that is the point the
    // user sees when a line is picked with a non-zero threshold.
    const worldPoint = closestOnSegment.clone().applyMat4(this.matrixWorld);
    intersects.push({
      distance: worldPoint.distanceTo(raycaster.ray.origin),
      point: worldPoint,
      object: this,
      pointOnLine: closestOnSegment.clone(),
    });
  }
}

/**
 * Closest points between a segment and a ray.
 *
 * Ericson's `ClosestPtSegmentRay`, restricted to the segment on one side and
 * unbounded on the other.
 */
export function closestPointsSegmentToRay(
  start: Vec3,
  end: Vec3,
  rayOrigin: Vec3,
  rayDirection: Vec3,
  targetSegment: Vec3,
  targetRay: Vec3,
): void {
  delta.copy(end).sub(start);
  offset.copy(start).sub(rayOrigin);
  const a = delta.lengthSquared();
  const e = rayDirection.lengthSquared();
  const f = rayDirection.dot(offset);

  let s: number;
  let t: number;

  if (a <= 1e-12 && e <= 1e-12) {
    s = 0;
    t = 0;
  } else if (a <= 1e-12) {
    s = 0;
    t = f / e;
  } else {
    const c = delta.dot(offset);
    if (e <= 1e-12) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = delta.dot(rayDirection);
      const denominator = a * e - b * b;
      s = denominator !== 0 ? clamp01((b * f - c * e) / denominator) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      }
    }
  }

  targetSegment.copy(delta).multiplyScalar(s).add(start);
  targetRay.copy(rayDirection).multiplyScalar(t).add(rayOrigin);
}

/** Clamps `value` into `[0, 1]`. */
function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
