/**
 * `MathUtils` — the math module's public namespace of scalar helpers.
 *
 * This is a *curated re-export* of `src/utils/MathUtils.ts` plus a handful of
 * geometry-specific additions (`randomPointInSphere`, `smootherstep`, ...) so
 * that consumers can `import { MathUtils } from '@dxyl/graphics'` and get one
 * object, while the rest of the library imports the flat functions directly.
 *
 * @packageDocumentation
 */

import { DEG2RAD, EPSILON, RAD2DEG } from '../constants';
import { clamp, clamp01, lerp } from '../utils/MathUtils';
import { Vec3 } from './Vec3';

export * from '../utils/MathUtils';

/* -------------------------------------------------------------------------- */
/* Geometry-specific additions                                                */
/* -------------------------------------------------------------------------- */

/** Interpolates between two angles along the shortest arc, in degrees. */
export function lerpAngleDegrees(a: number, b: number, t: number): number {
  let delta = ((b - a + 540) % 360) - 180;
  if (delta < -180) delta += 360;
  return a + delta * t;
}

/** Normalises an angle in degrees into `[0, 360)`. */
export function wrapDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** `true` when two angles (radians) are within `tolerance` of each other. */
export function anglesEqual(a: number, b: number, tolerance: number = EPSILON): boolean {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) <= tolerance;
}

/** Area of a 2D triangle given three points. */
export function triangleArea2D(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) * 0.5;
}

/** Signed area of a polygon (positive when counter-clockwise). */
export function signedPolygonArea(points: readonly { x: number; y: number }[]): number {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j].x - points[i].x) * (points[j].y + points[i].y);
  }
  return area * 0.5;
}

/** Area of a polygon; independent of winding order. */
export function polygonArea(points: readonly { x: number; y: number }[]): number {
  return Math.abs(signedPolygonArea(points));
}

/** Perimeter of a polygon. */
export function polygonPerimeter(points: readonly { x: number; y: number }[]): number {
  let total = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    total += Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
  }
  return total;
}

/** `true` when a polygon's vertices wind counter-clockwise. */
export function isPolygonCounterClockwise(points: readonly { x: number; y: number }[]): boolean {
  return signedPolygonArea(points) > 0;
}

/** Compass heading (0 = north, clockwise) of a 2D direction. */
export function headingFromDirection(x: number, y: number): number {
  return wrapDegrees(Math.atan2(x, y) * RAD2DEG);
}

/** 2D direction from a compass heading in degrees. */
export function directionFromHeading(degrees: number, target: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } {
  const radians = degrees * DEG2RAD;
  target.x = Math.sin(radians);
  target.y = Math.cos(radians);
  return target;
}

/** A uniformly distributed random point inside a sphere of `radius`. */
export function randomPointInSphere(
  radius: number = 1,
  random: () => number = Math.random,
  target: Vec3 = new Vec3(),
): Vec3 {
  // Rejection sampling keeps the distribution uniform; the loop terminates with
  // probability 1 and is bounded for safety.
  for (let attempt = 0; attempt < 32; attempt++) {
    const x = random() * 2 - 1;
    const y = random() * 2 - 1;
    const z = random() * 2 - 1;
    if (x * x + y * y + z * z <= 1) return target.set(x, y, z).multiplyScalar(radius);
  }
  return target.set(0, 0, 0);
}

/** A uniformly distributed random point on a sphere's surface. */
export function randomPointOnSphere(
  radius: number = 1,
  random: () => number = Math.random,
  target: Vec3 = new Vec3(),
): Vec3 {
  const u = random() * 2 - 1;
  const theta = random() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - u * u));
  return target.set(r * Math.cos(theta), u, r * Math.sin(theta)).multiplyScalar(radius);
}

/** A uniformly distributed random direction (unit vector). */
export function randomDirection(
  random: () => number = Math.random,
  target: Vec3 = new Vec3(),
): Vec3 {
  return randomPointOnSphere(1, random, target);
}

/** Gaussian sample via the Box-Muller transform. */
export function randomGaussian(
  mean: number = 0,
  standardDeviation: number = 1,
  random: () => number = Math.random,
): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return mean + standardDeviation * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Fits `value` from `[inMin, inMax]` into `[0, 1]`, clamped. */
export function unlerp(value: number, inMin: number, inMax: number): number {
  return inMax === inMin ? 0 : clamp01((value - inMin) / (inMax - inMin));
}

/** Rounds to the nearest multiple of `step`, preferring the smaller on ties. */
export function roundToStep(value: number, step: number): number {
  return step <= 0 ? value : Math.round(value / step) * step;
}

/** Largest multiple of `step` that is `<= value`. */
export function floorToStep(value: number, step: number): number {
  return step <= 0 ? value : Math.floor(value / step) * step;
}

/** Smallest multiple of `step` that is `>= value`. */
export function ceilToStep(value: number, step: number): number {
  return step <= 0 ? value : Math.ceil(value / step) * step;
}

/** Snaps `value` into the given range using the classic `mod` mapping. */
export function snapToRange(value: number, min: number, max: number): number {
  const span = max - min;
  if (span <= 0) return min;
  const offset = value - min;
  return min + (offset - Math.floor(offset / span) * span);
}

/** Smoothly damps `current` towards `target`; frame-rate independent. */
export function damp(current: number, target: number, lambda: number, delta: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * delta));
}

/** Same as {@link damp} but with an explicit clamp so it never overshoots. */
export function dampClamped(current: number, target: number, lambda: number, delta: number): number {
  return clamp(lerp(current, target, 1 - Math.exp(-lambda * delta)), Math.min(current, target), Math.max(current, target));
}

/** Smoothly damps each component of a vector towards a target vector. */
export function dampVec3(
  current: Vec3,
  target: Vec3,
  lambda: number,
  delta: number,
  out: Vec3 = current,
): Vec3 {
  const factor = 1 - Math.exp(-lambda * delta);
  return out.set(
    lerp(current.x, target.x, factor),
    lerp(current.y, target.y, factor),
    lerp(current.z, target.z, factor),
  );
}

/**
 * A namespace object bundling the scalar helpers.
 *
 * Provided for consumers that prefer `MathUtils.clamp(...)` over a named import;
 * tree-shaking works for both forms.
 */
export const MathUtils = {
  EPSILON,
  DEG2RAD,
  RAD2DEG,
  clamp,
  clamp01,
  lerp,
  lerpAngleDegrees,
  wrapDegrees,
  anglesEqual,
  triangleArea2D,
  signedPolygonArea,
  polygonArea,
  polygonPerimeter,
  isPolygonCounterClockwise,
  headingFromDirection,
  directionFromHeading,
  randomPointInSphere,
  randomPointOnSphere,
  randomDirection,
  randomGaussian,
  unlerp,
  roundToStep,
  floorToStep,
  ceilToStep,
  snapToRange,
  damp,
  dampClamped,
  dampVec3,
} as const;
