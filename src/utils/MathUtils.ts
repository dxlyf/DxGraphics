/**
 * Scalar math helpers with no dependencies.
 *
 * Every function here is pure and allocation-free; the hot ones are marked
 * `@inline` in spirit and are used from `Vec3`, `Mat4`, `Quat` and geometry
 * generation where a tiny call overhead is acceptable in exchange for one
 * canonical implementation.
 *
 * @packageDocumentation
 */

import { DEG2RAD, EPSILON, HALF_PI, RAD2DEG } from '../constants';

/** Clamp `value` into the inclusive range `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Clamp `value` into `[0, 1]`. */
export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Saturate negative values to zero. */
export function saturate(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Linear interpolation between `a` and `b` by `t` (unclamped). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** `true` when `value` lies within the inclusive interval `[min, max]`. */
export function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/**
 * Restricts `value` to `[0, 1]` when `clampToRange` is set.
 *
 * A thin, self-documenting alias used by the segment/plane clipping code so the
 * call sites read as intended.
 */
export function clip(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Barycentric coordinates of `p` relative to the triangle `(a, b, c)` in 2D.
 *
 * Returned as `[u, v, w]` with `u + v + w === 1`; `u` weights `a`, `v` weights
 * `b` and `w` weights `c`. Degenerate (zero-area) triangles yield `[1, 0, 0]`.
 */
export function barycentric2D(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): [number, number, number] {
  const v0x = b.x - a.x;
  const v0y = b.y - a.y;
  const v1x = c.x - a.x;
  const v1y = c.y - a.y;
  const v2x = p.x - a.x;
  const v2y = p.y - a.y;

  const denominator = v0x * v1y - v1x * v0y;
  if (denominator === 0) return [1, 0, 0];

  const v = (v2x * v1y - v1x * v2y) / denominator;
  const w = (v0x * v2y - v2x * v0y) / denominator;
  return [1 - v - w, v, w];
}

/** Linear interpolation clamped to the `[a, b]` interval. */
export function lerpClamped(a: number, b: number, t: number): number {
  return lerp(a, b, clamp01(t));
}

/** Inverse of {@link lerp}: the `t` that produced `value` between `a` and `b`. */
export function inverseLerp(a: number, b: number, value: number): number {
  return a === b ? 0 : (value - a) / (b - a);
}

/** Remap `value` from `[inMin, inMax]` to `[outMin, outMax]` without clamping. */
export function mapLinear(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  return outMin + ((value - inMin) * (outMax - outMin)) / (inMax - inMin);
}

/** Remap and clamp in one step. */
export function remapClamped(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  return lerp(outMin, outMax, clamp01(inverseLerp(inMin, inMax, value)));
}

/** Smooth Hermite (GLSL `smoothstep`) interpolation between two edges. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || EPSILON));
  return t * t * (3 - 2 * t);
}

/** First derivative of {@link smoothstep}, useful for analytic normals. */
export function smoothstepDerivative(edge0: number, edge1: number, x: number): number {
  const denom = edge1 - edge0 || EPSILON;
  const t = clamp01((x - edge0) / denom);
  return (6 * t * (1 - t)) / denom;
}

/** Quintic (Ken Perlin) smoother step with zero first and second derivatives. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || EPSILON));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** `true` when `Math.abs(a - b) <= tolerance`. */
export function equals(a: number, b: number, tolerance: number = EPSILON): boolean {
  return Math.abs(a - b) <= tolerance;
}

/** Sign of `value`, returning `0` for zero (unlike `Math.sign(-0)`). */
export function sign(value: number): number {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

/** Largest integer less than or equal to `value`, safe for negatives. */
export function floor(value: number): number {
  return Math.floor(value);
}

/** Euclidean modulo: the result always carries the sign of `divisor`. */
export function mod(value: number, divisor: number): number {
  const r = value - Math.floor(value / divisor) * divisor;
  return r < 0 ? r + divisor : r;
}

/** Positive fractional part of `value`. */
export function fract(value: number): number {
  return value - Math.floor(value);
}

/** Rounds `value` to `step` (e.g. `quantize(1.234, 0.1) === 1.2`). */
export function quantize(value: number, step: number): number {
  return step === 0 ? value : Math.round(value / step) * step;
}

/** Rounds `value` to `digits` decimal places without string conversion. */
export function roundTo(value: number, digits: number = 6): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

/** Distance between two scalars. */
export function distance(a: number, b: number): number {
  return Math.abs(a - b);
}

/** Converts degrees to radians. */
export function degToRad(degrees: number): number {
  return degrees * DEG2RAD;
}

/** Converts radians to degrees. */
export function radToDeg(radians: number): number {
  return radians * RAD2DEG;
}

/** Wraps an angle in radians into `(-PI, PI]`. */
export function wrapAngle(angle: number): number {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/** Wraps an angle in radians into `[0, 2PI)`. */
export function wrapAngle360(angle: number): number {
  const a = angle % (Math.PI * 2);
  return a < 0 ? a + Math.PI * 2 : a;
}

/** Shortest signed angular difference `b - a`, in radians. */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** Interpolates between two angles along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t;
}

/** Power function preserving the sign of `value`. */
export function powSigned(value: number, exponent: number): number {
  return Math.sign(value) * Math.pow(Math.abs(value), exponent);
}

/** `a * (1 - t) + b * t` with `t` clamped, avoiding catastrophic cancellation. */
export function mix(a: number, b: number, t: number): number {
  return (1 - clamp01(t)) * a + clamp01(t) * b;
}

/** 1D cubic Bezier evaluated at `t` using de Casteljau. */
export function cubicBezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/** Derivative of {@link cubicBezier} with respect to `t`. */
export function cubicBezierDerivative(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const mt = 1 - t;
  return 3 * mt * mt * (p1 - p0) + 6 * mt * t * (p2 - p1) + 3 * t * t * (p3 - p2);
}

/** 1D quadratic Bezier evaluated at `t`. */
export function quadraticBezier(p0: number, p1: number, p2: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
}

/** Derivative of {@link quadraticBezier} with respect to `t`. */
export function quadraticBezierDerivative(p0: number, p1: number, p2: number, t: number): number {
  return 2 * (1 - t) * (p1 - p0) + 2 * t * (p2 - p1);
}

/**
 * Inverse of {@link cubicBezier} for a monotonic curve.
 *
 * Uses Newton-Raphson with a bisection fallback, which converges for every
 * control-point ordering a caller is likely to pass (the bezier easing helpers
 * in `animation/Easing.ts` depend on this).
 */
export function solveCubicBezier(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  value: number,
): number {
  if (value <= p0) return 0;
  if (value >= p3) return 1;

  let t = (value - p0) / (p3 - p0 || 1);
  for (let i = 0; i < 8; i++) {
    const error = cubicBezier(p0, p1, p2, p3, t) - value;
    if (Math.abs(error) < 1e-7) return t;
    const slope = cubicBezierDerivative(p0, p1, p2, p3, t);
    if (Math.abs(slope) < 1e-7) break;
    t -= error / slope;
  }

  let low = 0;
  let high = 1;
  t = (value - p0) / (p3 - p0 || 1);
  for (let i = 0; i < 24; i++) {
    const sample = cubicBezier(p0, p1, p2, p3, t);
    if (Math.abs(sample - value) < 1e-7) return t;
    if (sample < value) low = t;
    else high = t;
    t = (low + high) * 0.5;
  }
  return t;
}

/** Rounds `value` up to the next power of two (returns `1` for inputs `<= 1`). */
export function nextPowerOfTwo(value: number): number {
  return Math.pow(2, Math.ceil(Math.log2(Math.max(1, value))));
}

/** `true` when `value` is a power of two (including `1`). */
export function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

/** `true` when `value` is finite and not `NaN`. */
export function isFinite_Number(value: number): boolean {
  return Number.isFinite(value);
}

/** `true` when `value` is a real, finite number (rejects `NaN` and `Infinity`). */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Replaces every non-finite input with `fallback`. */
export function sanitize(value: number, fallback: number = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Sum of an array of numbers. */
export function sum(values: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  return total;
}

/** Arithmetic mean of an array; `0` for an empty array. */
export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

/** Smallest value in an array; `Infinity` for an empty array. */
export function min(values: readonly number[]): number {
  let result = Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] < result) result = values[i];
  return result;
}

/** Largest value in an array; `-Infinity` for an empty array. */
export function max(values: readonly number[]): number {
  let result = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] > result) result = values[i];
  return result;
}

/** Maps `value` from `[0, 1]` to `[-1, 1]`. */
export function toSigned(value: number): number {
  return value * 2 - 1;
}

/** Maps `value` from `[-1, 1]` to `[0, 1]`. */
export function toUnsigned(value: number): number {
  return value * 0.5 + 0.5;
}

/** Ping-pong wave in `[0, length]`; handy for oscillating animations. */
export function pingPong(value: number, length: number = 1): number {
  const t = mod(value, length * 2);
  return length - Math.abs(t - length);
}

/**
 * Deterministic 32-bit hash of a string (FNV-1a).
 *
 * Used to key the shader cache and to derive stable IDs from user-provided
 * names, so the same input always produces the same numeric hash.
 */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Seeded pseudo-random generator (mulberry32).
 *
 * Returns a function producing values in `[0, 1)`. Every geometry/particle
 * helper that needs randomness accepts one of these so results are reproducible
 * across runs, which is what the visual-regression suite relies on.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return function random(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random float in `[min, max)`. */
export function randomFloat(min: number = 0, max: number = 1, random: () => number = Math.random): number {
  return min + random() * (max - min);
}

/** Random integer in `[min, max]` (inclusive). */
export function randomInt(min: number, max: number, random: () => number = Math.random): number {
  return Math.floor(min + random() * (max - min + 1));
}

/** Constant `1 / Math.sqrt(value)` computed with a guard against division by zero. */
export function invSqrt(value: number): number {
  return value > 0 ? 1 / Math.sqrt(value) : 0;
}

/** Inverse of {@link smoothstep} for `y` in `[0, 1]`. */
export function inverseSmoothstep(y: number): number {
  return 0.5 - Math.sin(Math.asin(1 - 2 * clamp01(y)) / 3);
}

/** Area of a triangle from three side lengths (Heron's formula). */
export function triangleArea(a: number, b: number, c: number): number {
  const s = (a + b + c) * 0.5;
  return Math.sqrt(Math.max(0, s * (s - a) * (s - b) * (s - c)));
}

/** Smallest signed difference between two angles, in degrees. */
export function angleDeltaDeg(a: number, b: number): number {
  return radToDeg(angleDelta(degToRad(a), degToRad(b)));
}

/** `HALF_PI` re-exported for consumers building inline rotations. */
export const HALF_PI_CONSTANT = HALF_PI;
