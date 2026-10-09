/**
 * Math-module types.
 *
 * @packageDocumentation
 */

export type { EulerOrder } from './Euler';
export type { Intersection, IntersectionType, HitTest2D, GPUPickResult, BoundsIntersection, RaycastableObject, RayLike, SegmentProximity, TriangleProximity, TriangleQuery } from './Intersection';
export type { BarycentricCoordinates } from './Triangle';
export type { Vec3Component } from './Vec3';

/** A rotation expressed as a quaternion, a matrix or Euler angles. */
export type RotationLike =
  | { x: number; y: number; z: number; w: number }
  | { x: number; y: number; z: number; order?: string }
  | { elements: ArrayLike<number> };

/** A position, rotation and scale triple. */
export interface TransformLike {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; order?: string };
  scale: { x: number; y: number; z: number };
}

/** Options shared by every bounding-volume constructor. */
export interface BoundingVolumeOptions {
  /** Skip the automatic recursion into children. */
  skipChildren?: boolean;
}

/** A ray origin/direction pair as plain numbers. */
export interface RayComponents {
  originX: number;
  originY: number;
  originZ: number;
  directionX: number;
  directionY: number;
  directionZ: number;
}

/** Axis identifier used by box/plane helpers. */
export type MathAxis = 'x' | 'y' | 'z';

/** An interval along one axis. */
export interface Interval {
  min: number;
  max: number;
}

/** Result of intersecting two intervals. */
export interface IntervalOverlap {
  overlap: boolean;
  min: number;
  max: number;
}

/** Configures the tolerance-aware comparison helpers. */
export interface ComparisonOptions {
  /** Absolute tolerance applied to every component. */
  tolerance?: number;
  /** Also compare using a relative tolerance scaled by magnitude. */
  relative?: boolean;
}

/**
 * A rectangular region in normalised device coordinates.
 *
 * `x`/`y` are the lower-left corner; values use the `[-1, 1]` NDC range.
 */
export interface NDCRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Decomposition of a matrix into its primitive parts. */
export interface MatrixDecomposition {
  translation: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  scale: { x: number; y: number; z: number };
  /** `true` when the basis is mirrored (negative determinant). */
  mirrored: boolean;
}

/** Defines the spherical coordinate convention used by the math helpers. */
export enum SphericalConvention {
  /** `theta` measured from `+Z` towards `+X` (three.js default). */
  ZUp = 'z-up',
  /** `theta` measured from `+X` towards `+Z`. */
  XUp = 'x-up',
}
