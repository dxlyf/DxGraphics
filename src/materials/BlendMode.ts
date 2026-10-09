/**
 * `BlendMode` — the named blend presets and the factor lookups backends need.
 *
 * A material only has to name a preset; `getBlendFactors()` turns that name into
 * the concrete source/destination factors and equation for each channel. The
 * presets follow the conventions the library's other layers already assume (and
 * that the renderer's `isAlphaBlend`/`isAdditiveBlend` helpers recognise):
 *
 * | Mode | RGB | Alpha | Equation |
 * | --- | --- | --- | --- |
 * | `NoBlending` | `One`, `Zero` | `One`, `Zero` | `Add` |
 * | `NormalBlending` | `SrcAlpha`, `OneMinusSrcAlpha` | `One`, `OneMinusSrcAlpha` | `Add` |
 * | `AdditiveBlending` | `SrcAlpha`, `One` | `One`, `One` | `Add` |
 * | `SubtractiveBlending` | `Zero`, `OneMinusSrcColor` | `Zero`, `One` | `Add` |
 * | `MultiplyBlending` | `Zero`, `SrcColor` | `Zero`, `SrcAlpha` | `Add` |
 * | `CustomBlending` | material's own fields | material's own fields | material's own field |
 *
 * @packageDocumentation
 */

import { BlendEquation, Blending } from './types';

/** Named blend presets. */
export enum BlendMode {
  /** Blending is disabled; the fragment replaces the target. */
  NoBlending = 'none',
  /** Conventional source-over alpha blending. */
  NormalBlending = 'normal',
  /** Additive blending, for glows and particles. */
  AdditiveBlending = 'additive',
  /** Subtractive blending, for darkening overlays. */
  SubtractiveBlending = 'subtractive',
  /** Multiplicative blending, for shadows and light maps. */
  MultiplyBlending = 'multiply',
  /** Blending driven by the material's own factor fields. */
  CustomBlending = 'custom',
}

/** Concrete blend configuration for one channel pair. */
export interface BlendFactors {
  /** `true` when blending is enabled at all. */
  enabled: boolean;
  /** Source factor for the RGB channels. */
  src: Blending;
  /** Destination factor for the RGB channels. */
  dst: Blending;
  /** Equation applied to the RGB channels. */
  equation: BlendEquation;
  /** Source factor for the alpha channel. */
  srcAlpha: Blending;
  /** Destination factor for the alpha channel. */
  dstAlpha: Blending;
  /** Equation applied to the alpha channel. */
  alphaEquation: BlendEquation;
  /** `true` when the RGB and alpha configurations differ. */
  separateAlpha: boolean;
}

/** Per-mode presets, keyed by {@link BlendMode}. */
const PRESETS: Readonly<Record<BlendMode, BlendFactors>> = {
  [BlendMode.NoBlending]: {
    enabled: false,
    src: Blending.One,
    dst: Blending.Zero,
    equation: BlendEquation.Add,
    srcAlpha: Blending.One,
    dstAlpha: Blending.Zero,
    alphaEquation: BlendEquation.Add,
    separateAlpha: false,
  },
  [BlendMode.NormalBlending]: {
    enabled: true,
    src: Blending.SrcAlpha,
    dst: Blending.OneMinusSrcAlpha,
    equation: BlendEquation.Add,
    srcAlpha: Blending.One,
    dstAlpha: Blending.OneMinusSrcAlpha,
    alphaEquation: BlendEquation.Add,
    separateAlpha: true,
  },
  [BlendMode.AdditiveBlending]: {
    enabled: true,
    src: Blending.SrcAlpha,
    dst: Blending.One,
    equation: BlendEquation.Add,
    srcAlpha: Blending.One,
    dstAlpha: Blending.One,
    alphaEquation: BlendEquation.Add,
    separateAlpha: false,
  },
  [BlendMode.SubtractiveBlending]: {
    enabled: true,
    src: Blending.Zero,
    dst: Blending.OneMinusSrcColor,
    equation: BlendEquation.Add,
    srcAlpha: Blending.Zero,
    dstAlpha: Blending.One,
    alphaEquation: BlendEquation.Add,
    separateAlpha: true,
  },
  [BlendMode.MultiplyBlending]: {
    enabled: true,
    src: Blending.Zero,
    dst: Blending.SrcColor,
    equation: BlendEquation.Add,
    srcAlpha: Blending.Zero,
    dstAlpha: Blending.SrcAlpha,
    alphaEquation: BlendEquation.Add,
    separateAlpha: true,
  },
  // Custom blending has no fixed configuration: `getBlendFactors` returns the
  // `enabled`/`separateAlpha` envelope and the caller fills in the factors.
  [BlendMode.CustomBlending]: {
    enabled: true,
    src: Blending.One,
    dst: Blending.Zero,
    equation: BlendEquation.Add,
    srcAlpha: Blending.One,
    dstAlpha: Blending.Zero,
    alphaEquation: BlendEquation.Add,
    separateAlpha: true,
  },
};

/** Factors that read the destination *alpha* channel. */
const DESTINATION_ALPHA_FACTORS: ReadonlySet<Blending> = new Set([
  Blending.DstAlpha,
  Blending.OneMinusDstAlpha,
  Blending.ConstantAlpha,
  Blending.OneMinusConstantAlpha,
  Blending.SrcAlphaSaturate,
]);

/**
 * The blend configuration of a preset.
 *
 * @param mode Preset to resolve.
 * @returns A fresh {@link BlendFactors} record (never the internal preset, so a
 *   caller may mutate the result).
 */
export function getBlendFactors(mode: BlendMode): BlendFactors {
  const preset = PRESETS[mode] ?? PRESETS[BlendMode.NormalBlending];
  return { ...preset };
}

/**
 * `true` when the preset needs a destination alpha channel to be correct.
 *
 * Only meaningful for the fixed presets: {@link BlendMode.CustomBlending} always
 * returns `true`, because the material's own factors are not known here and the
 * conservative answer (allocate an alpha channel) is also the safe one.
 *
 * @param mode Preset to inspect.
 */
export function requiresDestinationAlpha(mode: BlendMode): boolean {
  if (mode === BlendMode.CustomBlending) return true;
  const preset = PRESETS[mode] ?? PRESETS[BlendMode.NormalBlending];
  return DESTINATION_ALPHA_FACTORS.has(preset.dst) || DESTINATION_ALPHA_FACTORS.has(preset.dstAlpha);
}

/**
 * `true` when the preset draws nothing into the colour buffer.
 *
 * @param mode Preset to inspect.
 */
export function isBlendingDisabled(mode: BlendMode): boolean {
  return mode === BlendMode.NoBlending;
}

/**
 * `true` when a preset's factors match another's.
 *
 * @param a First preset.
 * @param b Second preset.
 */
export function blendModesEqual(a: BlendMode, b: BlendMode): boolean {
  if (a === b) return true;
  const fa = getBlendFactors(a);
  const fb = getBlendFactors(b);
  return (
    fa.enabled === fb.enabled &&
    fa.src === fb.src &&
    fa.dst === fb.dst &&
    fa.equation === fb.equation &&
    fa.srcAlpha === fb.srcAlpha &&
    fa.dstAlpha === fb.dstAlpha &&
    fa.alphaEquation === fb.alphaEquation
  );
}

/** Every preset, for UI and diagnostics. */
export function listBlendModes(): BlendMode[] {
  return Object.values(BlendMode);
}
