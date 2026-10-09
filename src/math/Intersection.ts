/**
 * `Intersection` — the result records produced by raycasting and picking.
 *
 * Shape is intentionally three.js-compatible (`distance`, `point`, plus the
 * object and arbitrary payload fields) with a few extra helpers the picking
 * layer needs (`faceIndex`, `uv`, `barycoord`, `instanceId`, `normal`, `layer`).
 *
 * @packageDocumentation
 */

import type { Vec2 } from './Vec2';
import type { Vec3 } from './Vec3';
import type { Line3 } from './Line3';
import type { Triangle } from './Triangle';

/** Which primitive kind produced an intersection. */
export type IntersectionType = 'mesh' | 'line' | 'points' | 'sprite' | 'bounds' | 'custom';

/** A ray/geometry intersection. */
export interface Intersection<TTarget = unknown> {
  /** Distance along the ray, in world units. */
  distance: number;
  /** Intersection point in world space. */
  point: Vec3;
  /** The object that was hit. */
  object: TTarget;
  /** Index of the hit triangle within the geometry, when applicable. */
  faceIndex?: number;
  /** Interpolated UV at the hit point, when the geometry has UVs. */
  uv?: Vec2;
  /** Barycentric coordinates within the hit triangle. */
  barycoord?: [number, number, number];
  /** Instance index for `InstancedMesh` hits. */
  instanceId?: number;
  /** Interpolated (or geometric) normal at the hit point. */
  normal?: Vec3;
  /** Which of the object's layer bits matched. */
  layer?: number;
  /** The primitive kind that produced this record. */
  type?: IntersectionType;
  /** Grouping key used to coalesce multi-hit objects (e.g. per sprite). */
  groupId?: string;
  /** Free-form payload for custom pickers. */
  userData?: Record<string, unknown>;
}

/** A 2D hit produced by {@link HitTest2D}-style node tests. */
export interface HitTest2D<TTarget = unknown> {
  /** The node that was hit. */
  target: TTarget;
  /** Local-space point inside the node. */
  localPoint: Vec2;
  /** World-space point. */
  worldPoint: Vec2;
  /** Accumulated alpha of the node chain, in `[0, 1]`. */
  alpha: number;
  /** Draw order (`zIndex` chain) of the hit node; higher draws on top. */
  order: number;
  /** Distance from the query point to the node's centre, for tie-breaking. */
  distance: number;
}

/** Result of a GPU pick pass. */
export interface GPUPickResult<TTarget = unknown> {
  /** Decoded object id, or `0` when the framebuffer pixel was empty. */
  id: number;
  /** The object the id maps to, when known. */
  object?: TTarget;
  /** Read-back coordinates of the sampled pixel. */
  x: number;
  y: number;
  /** Raw RGBA bytes read from the picking render target. */
  color: [number, number, number, number];
}

/** An intersection with a bounding volume rather than precise geometry. */
export interface BoundsIntersection<TTarget = unknown> extends Intersection<TTarget> {
  type: 'bounds';
}

/** Creates an intersection record with sensible defaults. */
export function createIntersection<TTarget = unknown>(
  object: TTarget,
  distance: number,
  point: Vec3,
  extra: Partial<Intersection<TTarget>> = {},
): Intersection<TTarget> {
  return { object, distance, point, type: 'mesh', ...extra };
}

/** Sorts intersections from nearest to farthest. */
export function sortIntersections<TTarget>(intersections: Intersection<TTarget>[]): Intersection<TTarget>[] {
  return intersections.sort((a, b) => a.distance - b.distance);
}

/** Discards intersections beyond `maxDistance` and keeps the nearest `limit`. */
export function filterIntersections<TTarget>(
  intersections: Intersection<TTarget>[],
  maxDistance: number = Infinity,
  limit: number = Infinity,
): Intersection<TTarget>[] {
  const result = intersections.filter((hit) => hit.distance <= maxDistance);
  result.sort((a, b) => a.distance - b.distance);
  return Number.isFinite(limit) ? result.slice(0, limit) : result;
}

/** An object that can be tested against a ray. */
export interface RaycastableObject<TTarget = unknown, TRay = unknown> {
  raycast(ray: TRay, intersects: Intersection<TTarget>[]): void;
}

/** A ray described by an origin and a direction. */
export interface RayLike {
  origin: Vec3;
  direction: Vec3;
}

/** Payload accepted by `MeshPicker` when probing triangles directly. */
export interface TriangleQuery {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  faceIndex?: number;
  uvA?: Vec2;
  uvB?: Vec2;
  uvC?: Vec2;
  target?: unknown;
}

/** Result of a segment/segment proximity query. */
export interface SegmentProximity {
  distance: number;
  parameterA: number;
  parameterB: number;
  pointA: Vec3;
  pointB: Vec3;
  lineA?: Line3;
  lineB?: Line3;
}

/** Result of a point/triangle query. */
export interface TriangleProximity {
  distance: number;
  closestPoint: Vec3;
  barycoord: [number, number, number];
  triangle?: Triangle;
}
