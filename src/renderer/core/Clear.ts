/**
 * Clear-bit masks and clear helpers.
 *
 * The numeric mask values come from the shared {@link ClearFlags} enum so that a
 * scene can build a mask once and hand it to any backend. The helpers convert
 * colours into the shapes each backend wants and resolve "effective" clear values
 * from partial overrides.
 *
 * @packageDocumentation
 */

import { ClearFlags, type ClearOptions, type ClearColorInput } from '../interfaces/types';
import { normalizeColor, toClearColor, toCss, type RGBA } from '../utils/colorUtils';

export { ClearFlags };
export type { ClearOptions };

/** Default depth value written by {@link resolveClearOptions}. */
export const DEFAULT_CLEAR_DEPTH = 1;

/** Default stencil value written by {@link resolveClearOptions}. */
export const DEFAULT_CLEAR_STENCIL = 0;

/** Fully resolved clear description, ready for a backend. */
export interface ResolvedClearOptions {
  /** Colour to fill with, as 0..1 RGBA channels. */
  color: RGBA;
  /** Depth value; only meaningful when the depth bit is set. */
  depth: number;
  /** Stencil value; only meaningful when the stencil bit is set. */
  stencil: number;
  /** Bit mask selecting which buffers to clear. */
  flags: ClearFlags;
}

/** `true` when `flags` contains the colour bit. */
export function clearsColor(flags: ClearFlags): boolean {
  return (flags & ClearFlags.Color) !== 0;
}

/** `true` when `flags` contains the depth bit. */
export function clearsDepth(flags: ClearFlags): boolean {
  return (flags & ClearFlags.Depth) !== 0;
}

/** `true` when `flags` contains the stencil bit. */
export function clearsStencil(flags: ClearFlags): boolean {
  return (flags & ClearFlags.Stencil) !== 0;
}

/** `true` when no bit is set (a no-op clear). */
export function isClearEmpty(flags: ClearFlags): boolean {
  return flags === ClearFlags.None;
}

/** Combines two masks. */
export function combineClearFlags(a: ClearFlags, b: ClearFlags): ClearFlags {
  return (a | b) as ClearFlags;
}

/** Removes the bits of `b` from `a`. */
export function removeClearFlags(a: ClearFlags, b: ClearFlags): ClearFlags {
  return (a & ~b) as ClearFlags;
}

/** @returns A comma-separated list of the set bit names (`'color+depth'`). */
export function clearFlagsToString(flags: ClearFlags): string {
  const names: string[] = [];
  if (clearsColor(flags)) names.push('color');
  if (clearsDepth(flags)) names.push('depth');
  if (clearsStencil(flags)) names.push('stencil');
  return names.length > 0 ? names.join('+') : 'none';
}

/**
 * Resolves a partial {@link ClearOptions} against a renderer's current defaults.
 *
 * @param options Call-site overrides; `color: null` keeps the default colour.
 * @param defaultColor Renderer's configured clear colour.
 * @param defaultFlags Mask used when `options.flags` is omitted.
 * @param target Optional object to write into.
 * @returns The fully resolved clear description.
 */
export function resolveClearOptions(
  options: ClearOptions | null | undefined,
  defaultColor: Readonly<RGBA>,
  defaultFlags: ClearFlags = ClearFlags.All,
  target: ResolvedClearOptions = {
    color: { r: 0, g: 0, b: 0, a: 1 },
    depth: DEFAULT_CLEAR_DEPTH,
    stencil: DEFAULT_CLEAR_STENCIL,
    flags: ClearFlags.All,
  },
): ResolvedClearOptions {
  if (options?.color == null) {
    target.color.r = defaultColor.r;
    target.color.g = defaultColor.g;
    target.color.b = defaultColor.b;
    target.color.a = defaultColor.a;
  } else {
    normalizeColor(options.color, undefined, target.color);
  }

  target.depth = options?.depth ?? DEFAULT_CLEAR_DEPTH;
  target.stencil = options?.stencil ?? DEFAULT_CLEAR_STENCIL;
  target.flags = options?.flags ?? defaultFlags;
  return target;
}

/**
 * Converts a colour to a CSS string suitable for `fillStyle`/`fill`.
 *
 * Unlike `clearColorToArray` this keeps the alpha channel, so the Canvas2D
 * backend can clear to a translucent background.
 *
 * @param input Colour input.
 * @param alpha Optional alpha override in 0..1.
 */
export function clearColorToCss(input: unknown, alpha?: number): string {
  return toCss(normalizeColor(input, alpha));
}

/**
 * Converts a colour into the four-element array the GPU backends pass to
 * `clearColor`.
 *
 * @param input Colour input.
 * @param alpha Optional alpha override in 0..1.
 * @param premultiplied Premultiply the RGB channels.
 */
export function clearColorToArray(
  input: unknown,
  alpha?: number,
  premultiplied: boolean = false,
): [number, number, number, number] {
  return toClearColor(input, alpha, premultiplied);
}

/**
 * Blends a colour towards the renderer's clear colour.
 *
 * Convenience for the smoke-test pattern "fade the background out over time".
 *
 * @param base Renderer's clear colour.
 * @param color Target colour.
 * @param t Blend factor in 0..1.
 */
export function mixClearColor(base: Readonly<RGBA>, color: ClearColorInput, t: number): RGBA {
  const target = normalizeColor(color);
  const amount = Math.max(0, Math.min(1, t));
  return {
    r: base.r + (target.r - base.r) * amount,
    g: base.g + (target.g - base.g) * amount,
    b: base.b + (target.b - base.b) * amount,
    a: base.a + (target.a - base.a) * amount,
  };
}

/**
 * Mutable clear configuration owned by a renderer.
 *
 * Keeps the colour, alpha override and default mask together so
 * `setClearColor`/`setClearAlpha` are one-liners.
 */
export class ClearState {
  /** Base colour. */
  public readonly color: RGBA = { r: 0, g: 0, b: 0, a: 1 };

  /** Explicit alpha override, or `null` to use {@link ClearState.color}'s. */
  public alpha: number | null = null;

  /** Mask applied when a caller does not supply one. */
  public flags: ClearFlags = ClearFlags.All;

  /** Depth value used when the depth bit is set. */
  public depth: number = DEFAULT_CLEAR_DEPTH;

  /** Stencil value used when the stencil bit is set. */
  public stencil: number = DEFAULT_CLEAR_STENCIL;

  /**
   * Sets the colour, optionally overriding its alpha.
   *
   * @param color Colour input.
   * @param alpha Optional alpha override in 0..1.
   */
  public setColor(color: ClearColorInput, alpha?: number): this {
    normalizeColor(color, alpha, this.color);
    this.alpha = alpha ?? null;
    return this;
  }

  /**
   * Overrides the alpha while keeping the RGB colour.
   *
   * @param alpha Alpha in 0..1.
   */
  public setAlpha(alpha: number): this {
    const clamped = Math.max(0, Math.min(1, alpha));
    this.alpha = clamped;
    this.color.a = clamped;
    return this;
  }

  /** @returns The effective colour, with {@link ClearState.alpha} applied. */
  public getEffectiveColor(): RGBA {
    return this.alpha === null ? { ...this.color } : { ...this.color, a: this.alpha };
  }

  /**
   * Resolves a partial clear description against this state.
   *
   * @param options Call-site overrides.
   */
  public resolve(options: ClearOptions | null | undefined): ResolvedClearOptions {
    return resolveClearOptions(options, this.getEffectiveColor(), this.flags);
  }

  /** @returns `true` when the effective colour is fully transparent. */
  public isTransparent(): boolean {
    return this.getEffectiveColor().a <= 0;
  }
}
