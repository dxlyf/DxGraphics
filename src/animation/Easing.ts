/**
 * Easing functions and the interpolation curves that back them.
 *
 * Every function in {@link Easing} satisfies the **endpoint contract**
 *
 * ```
 * f(0) === 0 && f(1) === 1
 * ```
 *
 * *exactly*, not merely to within a floating-point epsilon. Reaching `1` by
 * evaluating something like `1 - Math.cos(Math.PI / 2)` leaves a residual of
 * `6.1e-17`, which is enough to make an animation end a hair away from its final
 * pose and to make `Tween.onComplete` guards compare unequal. The
 * `*In`/`*Out`/`*InOut` families therefore special-case their endpoints and
 * evaluate the analytic form only on the open interval `(0, 1)`.
 *
 * The `back`, `elastic` and `bounce` families **overshoot** (and `elastic` also
 * oscillates), so they are intentionally *not* monotonic; `Easing.isMonotonic`
 * reports which named easings are.
 *
 * ```ts
 * const ease = Easing.getEasing('cubicOut');
 * const t = ease(0.25);
 * const custom = Easing.cubicBezier(0.42, 0, 0.58, 1);
 * const quantised = Easing.steps(6);
 * ```
 *
 * @packageDocumentation
 */

import { clamp01 } from '../utils/MathUtils';

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/** `value ** power` guarded so `0 ** 0` reads as `0` rather than `1`. */
function pow(value: number, power: number): number {
  return value === 0 ? 0 : Math.pow(value, power);
}

/* -------------------------------------------------------------------------- */
/* Scalar curves                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Identity curve.
 *
 * @param t Normalised progress; values outside `[0, 1]` are clamped.
 * @returns `t` clamped to `[0, 1]`.
 */
export function linear(t: number): number {
  return clamp01(t);
}

/**
 * Quadratic ease-in: `t²`.
 *
 * @param t Normalised progress.
 */
export function quadIn(t: number): number {
  const x = clamp01(t);
  return x === 0 || x === 1 ? x : x * x;
}

/**
 * Quadratic ease-out: `1 - (1 - t)²`.
 *
 * @param t Normalised progress.
 */
export function quadOut(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  const inv = 1 - x;
  return 1 - inv * inv;
}

/**
 * Quadratic ease-in-out.
 *
 * @param t Normalised progress.
 */
export function quadInOut(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
}

/**
 * Cubic ease-in: `t³`.
 *
 * @param t Normalised progress.
 */
export function cubicIn(t: number): number {
  const x = clamp01(t);
  return x === 0 || x === 1 ? x : x * x * x;
}

/**
 * Cubic ease-out: `1 - (1 - t)³`.
 *
 * @param t Normalised progress.
 */
export function cubicOut(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  const inv = 1 - x;
  return 1 - inv * inv * inv;
}

/**
 * Cubic ease-in-out: the curve `cubicOut` uses by default.
 *
 * @param t Normalised progress.
 */
export function cubicInOut(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  return x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2;
}

/**
 * Quartic ease-in.
 *
 * @param t Normalised progress.
 */
export function quartIn(t: number): number {
  const x = clamp01(t);
  return x === 0 || x === 1 ? x : pow(x, 4);
}

/**
 * Quartic ease-out.
 *
 * @param t Normalised progress.
 */
export function quartOut(t: number): number {
  const x = clamp01(t);
  return x === 0 || x === 1 ? x : 1 - pow(1 - x, 4);
}

/**
 * Quartic ease-in-out.
 *
 * @param t Normalised progress.
 */
export function quartInOut(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  return x < 0.5 ? 8 * pow(x, 4) : 1 - pow(-2 * x + 2, 4) / 2;
}

/**
 * Quintic ease-in.
 *
 * @param t Normalised progress.
 */
export function quintIn(t: number): number {
  const x = clamp01(t);
  return x === 0 || x === 1 ? x : pow(x, 5);
}

/**
 * Quintic ease-out.
 *
 * @param t Normalised progress.
 */
export function quintOut(t: number): number {
  const x = clamp01(t);
  return x === 0 || x === 1 ? x : 1 - pow(1 - x, 5);
}

/**
 * Quintic ease-in-out.
 *
 * @param t Normalised progress.
 */
export function quintInOut(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  return x < 0.5 ? 16 * pow(x, 5) : 1 - pow(-2 * x + 2, 5) / 2;
}

/** Half pi, cached because the sine family uses it on every sample. */
const HALF_PI_LOCAL = Math.PI / 2;

/**
 * Sinusoidal ease-in: `1 - cos(t * PI/2)`.
 *
 * @param t Normalised progress.
 */
export function sineIn(t: number): number {
  const x = clamp01(t);
  return x === 0 || x === 1 ? x : 1 - Math.cos(x * HALF_PI_LOCAL);
}

/**
 * Sinusoidal ease-out: `sin(t * PI/2)`.
 *
 * @param t Normalised progress.
 */
export function sineOut(t: number): number {
  const x = clamp01(t);
  return x === 0 || x === 1 ? x : Math.sin(x * HALF_PI_LOCAL);
}

/**
 * Sinusoidal ease-in-out: `-(cos(PI*t) - 1) / 2`.
 *
 * @param t Normalised progress.
 */
export function sineInOut(t: number): number {
  const x = clamp01(t);
  return x === 0 || x === 1 ? x : -(Math.cos(Math.PI * x) - 1) / 2;
}

/**
 * Exponential ease-in: `2^(10t - 10)`.
 *
 * @param t Normalised progress.
 */
export function expoIn(t: number): number {
  const x = clamp01(t);
  return x === 0 || x === 1 ? x : Math.pow(2, 10 * x - 10);
}

/**
 * Exponential ease-out: `1 - 2^(-10t)`.
 *
 * @param t Normalised progress.
 */
export function expoOut(t: number): number {
  const x = clamp01(t);
  return x === 0 || x === 1 ? x : 1 - Math.pow(2, -10 * x);
}

/**
 * Exponential ease-in-out.
 *
 * @param t Normalised progress.
 */
export function expoInOut(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  return x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2;
}

/**
 * Circular ease-in: `1 - sqrt(1 - t²)`.
 *
 * @param t Normalised progress.
 */
export function circIn(t: number): number {
  const x = clamp01(t);
  return x === 0 || x === 1 ? x : 1 - Math.sqrt(1 - x * x);
}

/**
 * Circular ease-out: `sqrt(1 - (t - 1)²)`.
 *
 * @param t Normalised progress.
 */
export function circOut(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  const inv = x - 1;
  return Math.sqrt(1 - inv * inv);
}

/**
 * Circular ease-in-out.
 *
 * @param t Normalised progress.
 */
export function circInOut(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  return x < 0.5
    ? (1 - Math.sqrt(1 - 4 * x * x)) / 2
    : (Math.sqrt(1 - pow(-2 * x + 2, 2)) + 1) / 2;
}

/**
 * Elastic ease-in: an exponentially damped sine that grows out of `0`.
 *
 * Overshoots and oscillates below `0`; use `clamp01` on the output when the
 * consumer cannot accept values outside the unit interval.
 *
 * @param t Normalised progress.
 */
export function elasticIn(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  const c4 = (2 * Math.PI) / 3;
  return -Math.pow(2, 10 * x - 10) * Math.sin((x * 10 - 10.75) * c4);
}

/**
 * Elastic ease-out.
 *
 * @param t Normalised progress.
 */
export function elasticOut(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
}

/**
 * Elastic ease-in-out.
 *
 * @param t Normalised progress.
 */
export function elasticInOut(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  const c5 = (2 * Math.PI) / 4.5;
  return x < 0.5
    ? -(Math.pow(2, 20 * x - 10) * Math.sin((20 * x - 11.125) * c5)) / 2
    : (Math.pow(2, -20 * x + 10) * Math.sin((20 * x - 11.125) * c5)) / 2 + 1;
}

/** Overshoot constant shared by the `back` family (`c1 = 1.70158`). */
export const BACK_OVERSHOOT = 1.70158;

/**
 * Back ease-in: pulls back before accelerating.
 *
 * @param t Normalised progress.
 */
export function backIn(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  const c3 = BACK_OVERSHOOT + 1;
  return c3 * x * x * x - BACK_OVERSHOOT * x * x;
}

/**
 * Back ease-out: overshoots past `1` before settling.
 *
 * @param t Normalised progress.
 */
export function backOut(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  const c3 = BACK_OVERSHOOT + 1;
  const inv = x - 1;
  return 1 + c3 * inv * inv * inv + BACK_OVERSHOOT * inv * inv;
}

/**
 * Back ease-in-out.
 *
 * @param t Normalised progress.
 */
export function backInOut(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  const c2 = BACK_OVERSHOOT * 1.525;
  return x < 0.5
    ? (pow(2 * x, 2) * ((c2 + 1) * 2 * x - c2)) / 2
    : (pow(2 * x - 2, 2) * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2;
}

/** Bounce ramp shared by the `bounce` family. */
function bounceOutInternal(x: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;

  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) {
    const y = x - 1.5 / d1;
    return n1 * y * y + 0.75;
  }
  if (x < 2.5 / d1) {
    const y = x - 2.25 / d1;
    return n1 * y * y + 0.9375;
  }
  const y = x - 2.625 / d1;
  return n1 * y * y + 0.984375;
}

/**
 * Bounce ease-out: four decaying parabolic arcs.
 *
 * @param t Normalised progress.
 */
export function bounceOut(t: number): number {
  const x = clamp01(t);
  return x === 0 || x === 1 ? x : bounceOutInternal(x);
}

/**
 * Bounce ease-in: the mirror of {@link bounceOut}.
 *
 * @param t Normalised progress.
 */
export function bounceIn(t: number): number {
  const x = clamp01(t);
  return x === 0 || x === 1 ? x : 1 - bounceOutInternal(1 - x);
}

/**
 * Bounce ease-in-out.
 *
 * @param t Normalised progress.
 */
export function bounceInOut(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  return x < 0.5 ? (1 - bounceOutInternal(1 - 2 * x)) / 2 : (1 + bounceOutInternal(2 * x - 1)) / 2;
}

/**
 * GLSL-style smoothstep over `[0, 1]`: `t²(3 - 2t)`.
 *
 * @param t Normalised progress.
 */
export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * Quintic smootherstep over `[0, 1]`: `t³(t(6t - 15) + 10)`.
 *
 * The first *and* second derivatives vanish at both ends, which is what makes it
 * the right curve for camera moves the user must not perceive as a "kick".
 *
 * @param t Normalised progress.
 */
export function smootherstep(t: number): number {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * Builds a quantised curve that holds each step and jumps at the boundaries.
 *
 * `Easing.steps(4)` yields `0, 0.25, 0.5, 0.75` for `t` in
 * `[0, 0.25), [0.25, 0.5), [0.5, 0.75), [0.75, 1)` and `1` at exactly `t = 1`,
 * matching CSS `steps(n, end)`.
 *
 * @param count Number of steps; clamped to `>= 1`.
 * @param position `'end'` (default) jumps at the end of each step, `'start'`
 *   jumps at the beginning and holds `1` for the whole first step.
 * @returns The step curve.
 */
export function steps(count: number, position: 'start' | 'end' = 'end'): (t: number) => number {
  const n = Math.max(1, Math.floor(count));
  if (position === 'start') {
    return (t: number): number => {
      const x = clamp01(t);
      if (x === 0) return 0;
      return Math.min(1, Math.ceil(x * n) / n);
    };
  }
  return (t: number): number => {
    const x = clamp01(t);
    if (x === 1) return 1;
    return Math.floor(x * n) / n;
  };
}

/* -------------------------------------------------------------------------- */
/* Cubic Bezier                                                               */
/* -------------------------------------------------------------------------- */

/** Cached X samples per curve, used to seed the Newton solve. */
const BEZIER_NEWTON_ITERATIONS = 8;
/** Bisection iterations used when Newton fails to converge. */
const BEZIER_BISECTION_ITERATIONS = 24;
/** Convergence tolerance for the X solve. */
const BEZIER_EPSILON = 1e-7;

/** Evaluates a 1D cubic Bezier at `t`. */
function bezierAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/** Evaluates the derivative of a 1D cubic Bezier at `t`. */
function bezierSlopeAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * (p1 - p0) + 6 * mt * t * (p2 - p1) + 3 * t * t * (p3 - p2);
}

/**
 * Builds a CSS-style cubic Bezier easing curve through `(0,0)` and `(1,1)` with
 * the two control points `(x1, y1)` and `(x2, y2)`.
 *
 * The X control points are clamped to `[0, 1]` (as CSS requires) so the curve
 * stays a function of time; the Y control points are left free so overshoot
 * (`y1 > 1`) remains expressible.
 *
 * @param x1 First control point X, clamped to `[0, 1]`.
 * @param y1 First control point Y.
 * @param x2 Second control point X, clamped to `[0, 1]`.
 * @param y2 Second control point Y.
 * @returns A curve mapping `[0, 1]` to the eased value.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx1 = clamp01(x1);
  const cx2 = clamp01(x2);

  // A linear curve needs no solve at all; short-circuiting it also keeps
  // `cubicBezier(0, 0, 1, 1)` exactly monotonic and endpoint-exact.
  if (cx1 === y1 && cx2 === y2) {
    return (t: number): number => clamp01(t);
  }

  return (t: number): number => {
    const x = clamp01(t);
    if (x === 0 || x === 1) return x;

    // Newton-Raphson first: it converges in two or three steps for the smooth
    // curves designers actually author.
    let guess = x;
    for (let i = 0; i < BEZIER_NEWTON_ITERATIONS; i++) {
      const error = bezierAt(0, cx1, cx2, 1, guess) - x;
      if (Math.abs(error) < BEZIER_EPSILON) return bezierAt(0, y1, y2, 1, guess);
      const slope = bezierSlopeAt(0, cx1, cx2, 1, guess);
      if (Math.abs(slope) < 1e-9) break;
      guess -= error / slope;
    }

    // Fall back to bisection, which cannot diverge for a monotonic X curve.
    let low = 0;
    let high = 1;
    guess = x;
    for (let i = 0; i < BEZIER_BISECTION_ITERATIONS; i++) {
      const sample = bezierAt(0, cx1, cx2, 1, guess);
      if (Math.abs(sample - x) < BEZIER_EPSILON) break;
      if (sample < x) low = guess;
      else high = guess;
      guess = (low + high) * 0.5;
    }
    return bezierAt(0, y1, y2, 1, guess);
  };
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/** Signature of every named easing. */
export type EasingFunction = (t: number) => number;

/** Canonical easing names accepted by {@link getEasing}. */
export type EasingName =
  | 'linear'
  | 'quadIn'
  | 'quadOut'
  | 'quadInOut'
  | 'cubicIn'
  | 'cubicOut'
  | 'cubicInOut'
  | 'quartIn'
  | 'quartOut'
  | 'quartInOut'
  | 'quintIn'
  | 'quintOut'
  | 'quintInOut'
  | 'sineIn'
  | 'sineOut'
  | 'sineInOut'
  | 'expoIn'
  | 'expoOut'
  | 'expoInOut'
  | 'circIn'
  | 'circOut'
  | 'circInOut'
  | 'elasticIn'
  | 'elasticOut'
  | 'elasticInOut'
  | 'backIn'
  | 'backOut'
  | 'backInOut'
  | 'bounceIn'
  | 'bounceOut'
  | 'bounceInOut'
  | 'smoothstep'
  | 'smootherstep';

/**
 * Wrap a curve so it composes with {@link Easing} without a circular initialiser.
 *
 * `Easing.getEasing` is defined here, before the {@link Easing} object literal, so
 * that object can reference it while still being a single frozen namespace. Callers
 * only ever reach it through property access at call time, never during module
 * initialisation, so there is no temporal-dead-zone hazard in practice.
 *
 * @param name Easing name.
 * @param fallback Curve returned when the name is unknown; defaults to
 *   {@link linear}.
 * @returns The resolved curve.
 */
export function getEasing(name: string, fallback: EasingFunction = linear): EasingFunction {
  if (isEasingName(name)) return NAMED_EASINGS[name];

  const normalized = name.trim().replace(/[-_\s]/g, '').toLowerCase();
  for (const candidate of EASING_NAMES) {
    if (candidate.toLowerCase() === normalized) return NAMED_EASINGS[candidate];
  }

  // `inOutCubic` / `outCubic` -> `cubicInOut` / `cubicOut`.
  const suffixForm = /^(inout|in|out)([a-z]+)$/.exec(normalized);
  if (suffixForm !== null) {
    const direction = suffixForm[1];
    const family = suffixForm[2];
    const suffix = direction === 'inout' ? 'InOut' : direction === 'in' ? 'In' : 'Out';
    const spelled = `${family}${suffix}`;
    const match = EASING_NAMES.find((candidate) => candidate.toLowerCase() === spelled.toLowerCase());
    if (match !== undefined) return NAMED_EASINGS[match];
  }

  // `easeInOutCubic` / `ease-in-out-cubic` / `easeCubicOut`.
  const css = /^ease(inout|in|out)?([a-z]+)$/.exec(normalized);
  if (css !== null) {
    const direction = css[1] === undefined || css[1] === '' ? 'out' : css[1];
    const family = css[2] as string;
    const suffix = direction === 'inout' ? 'InOut' : direction === 'in' ? 'In' : 'Out';
    const spelled = `${family}${suffix}`;
    const match = EASING_NAMES.find((candidate) => candidate.toLowerCase() === spelled.toLowerCase());
    if (match !== undefined) return NAMED_EASINGS[match];
  }

  // Bare family name: `cubic` means the ease-out member, which is what every UI
  // toolkit picks when only one member of a family is exposed.
  const familyOnly = EASING_NAMES.find((candidate) => candidate.toLowerCase() === `${normalized}out`);
  if (familyOnly) return NAMED_EASINGS[familyOnly];

  return fallback;
}

/**
 * The named easing set.
 *
 * Every entry is a plain function, so `const f: EasingFunction = Easing.cubicOut`
 * works and so does `Easing.getEasing('cubicOut')`. The object is a namespace, not a
 * registry: {@link getEasing} is the lookup entry point.
 */
export const Easing = {
  /** Identity curve. */
  linear,
  /** Quadratic ease-in. */
  quadIn,
  /** Quadratic ease-out. */
  quadOut,
  /** Quadratic ease-in-out. */
  quadInOut,
  /** Cubic ease-in. */
  cubicIn,
  /** Cubic ease-out. */
  cubicOut,
  /** Cubic ease-in-out. */
  cubicInOut,
  /** Quartic ease-in. */
  quartIn,
  /** Quartic ease-out. */
  quartOut,
  /** Quartic ease-in-out. */
  quartInOut,
  /** Quintic ease-in. */
  quintIn,
  /** Quintic ease-out. */
  quintOut,
  /** Quintic ease-in-out. */
  quintInOut,
  /** Sinusoidal ease-in. */
  sineIn,
  /** Sinusoidal ease-out. */
  sineOut,
  /** Sinusoidal ease-in-out. */
  sineInOut,
  /** Exponential ease-in. */
  expoIn,
  /** Exponential ease-out. */
  expoOut,
  /** Exponential ease-in-out. */
  expoInOut,
  /** Circular ease-in. */
  circIn,
  /** Circular ease-out. */
  circOut,
  /** Circular ease-in-out. */
  circInOut,
  /** Damped-sine ease-in (overshoots below zero). */
  elasticIn,
  /** Damped-sine ease-out (overshoots above one). */
  elasticOut,
  /** Damped-sine ease-in-out. */
  elasticInOut,
  /** Anticipating ease-in. */
  backIn,
  /** Overshooting ease-out. */
  backOut,
  /** Anticipating/overshooting ease-in-out. */
  backInOut,
  /** Bouncing ease-in. */
  bounceIn,
  /** Bouncing ease-out. */
  bounceOut,
  /** Bouncing ease-in-out. */
  bounceInOut,
  /** `t²(3 - 2t)`. */
  smoothstep,
  /** `t³(t(6t - 15) + 10)`. */
  smootherstep,
  /** Builds a CSS-style cubic Bezier curve. */
  cubicBezier,
  /** Builds a quantised step curve. */
  steps,
  /** Resolves an easing by name, with a descriptive fallback. */
  getEasing,
  /** `true` when the named easing never decreases on `[0, 1]`. */
  isMonotonic,
  /** Wraps a curve so its output is clamped to `[0, 1]`. */
  clamped,
  /** Reverses a curve: `f'(t) = 1 - f(1 - t)`. */
  reverse,
  /** Mirrors a curve about `t = 0.5`. */
  mirror,
  /** Remaps a curve onto the interval `[a, b]`. */
  remap,
} as const;

/** Names that are strictly non-decreasing on `[0, 1]`. */
const MONOTONIC_NAMES: ReadonlySet<string> = new Set<string>([
  'linear',
  'quadIn',
  'quadOut',
  'quadInOut',
  'cubicIn',
  'cubicOut',
  'cubicInOut',
  'quartIn',
  'quartOut',
  'quartInOut',
  'quintIn',
  'quintOut',
  'quintInOut',
  'sineIn',
  'sineOut',
  'sineInOut',
  'expoIn',
  'expoOut',
  'expoInOut',
  'circIn',
  'circOut',
  'circInOut',
  'smoothstep',
  'smootherstep',
]);

/** Every canonical easing name, in declaration order. */
export const EASING_NAMES: readonly EasingName[] = [
  'linear',
  'quadIn',
  'quadOut',
  'quadInOut',
  'cubicIn',
  'cubicOut',
  'cubicInOut',
  'quartIn',
  'quartOut',
  'quartInOut',
  'quintIn',
  'quintOut',
  'quintInOut',
  'sineIn',
  'sineOut',
  'sineInOut',
  'expoIn',
  'expoOut',
  'expoInOut',
  'circIn',
  'circOut',
  'circInOut',
  'elasticIn',
  'elasticOut',
  'elasticInOut',
  'backIn',
  'backOut',
  'backInOut',
  'bounceIn',
  'bounceOut',
  'bounceInOut',
  'smoothstep',
  'smootherstep',
];

/** Named curves, indexed for O(1) lookup by {@link getEasing}. */
const NAMED_EASINGS: Readonly<Record<EasingName, EasingFunction>> = {
  linear,
  quadIn,
  quadOut,
  quadInOut,
  cubicIn,
  cubicOut,
  cubicInOut,
  quartIn,
  quartOut,
  quartInOut,
  quintIn,
  quintOut,
  quintInOut,
  sineIn,
  sineOut,
  sineInOut,
  expoIn,
  expoOut,
  expoInOut,
  circIn,
  circOut,
  circInOut,
  elasticIn,
  elasticOut,
  elasticInOut,
  backIn,
  backOut,
  backInOut,
  bounceIn,
  bounceOut,
  bounceInOut,
  smoothstep,
  smootherstep,
};

/** `true` when `name` is one of the canonical easing names. */
export function isEasingName(name: string): name is EasingName {
  return Object.prototype.hasOwnProperty.call(NAMED_EASINGS, name);
}

/**
 * `true` when the named easing is non-decreasing across `[0, 1]`.
 *
 * `back*`, `elastic*` and `bounce*` are excluded: they overshoot or oscillate by
 * design. The check is name-based rather than numerical because a sampled
 * monotonicity test cannot distinguish a genuine dip from floating-point noise.
 *
 * @param name Easing name.
 * @returns `true` when the curve never decreases.
 */
export function isMonotonic(name: string): boolean {
  if (MONOTONIC_NAMES.has(name)) return true;
  const normalized = name.trim().replace(/[-_\s]/g, '').toLowerCase();
  for (const candidate of MONOTONIC_NAMES) {
    if (candidate.toLowerCase() === normalized) return true;
  }
  return false;
}

/**
 * Wraps a curve so its output is clamped to `[0, 1]`.
 *
 * The safe way to use `back`/`elastic`/`bounce` output where a normalised weight
 * is required (blend weights, alpha values, texture coordinates).
 *
 * @param fn Curve to wrap; defaults to {@link Easing.linear}.
 * @returns The clamped curve.
 */
export function clamped(fn: EasingFunction = linear): EasingFunction {
  return (t: number): number => clamp01(fn(t));
}

/**
 * Reverses a curve: `f'(t) = 1 - f(1 - t)`.
 *
 * Turns an ease-in into the matching ease-out and keeps endpoints exact.
 *
 * @param fn Curve to reverse.
 * @returns The reversed curve.
 */
export function reverse(fn: EasingFunction): EasingFunction {
  return (t: number): number => {
    const x = clamp01(t);
    if (x === 0 || x === 1) return x;
    return 1 - fn(1 - x);
  };
}

/**
 * Mirrors a curve about `t = 0.5`, playing it forward then backward.
 *
 * Unlike `*InOut` members this composes two arbitrary curves rather than a single
 * analytic formula, and it is exact at both endpoints.
 *
 * @param forward Curve used for the first half.
 * @param backward Curve used for the second half; defaults to `forward`.
 * @returns The mirrored curve.
 */
export function mirror(fn: EasingFunction, backward: EasingFunction = fn): EasingFunction {
  return (t: number): number => {
    const x = clamp01(t);
    if (x === 0 || x === 1) return x;
    return x < 0.5 ? fn(x * 2) * 0.5 : 0.5 + backward((x - 0.5) * 2) * 0.5;
  };
}

/**
 * Applies a curve to the non-zero part of an `[a, b]` interval.
 *
 * @param fn Curve to remap.
 * @param a Lower bound.
 * @param b Upper bound.
 * @returns A curve that maps `0 → a` and `1 → b`.
 */
export function remap(fn: EasingFunction, a: number, b: number): EasingFunction {
  return (t: number): number => a + (b - a) * fn(clamp01(t));
}
