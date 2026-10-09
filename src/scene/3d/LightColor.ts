/**
 * Light colours and the shared shadow configuration.
 *
 * `src/materials/Color.ts` did not exist while this layer was written, so a
 * light stores its colour as a small {@link LightColor} record (linear `r`, `g`,
 * `b` in `[0, 1]`) instead of importing a `Color` class. Parsing accepts the two
 * forms every renderer front-end uses: a hex integer (`0xff8800`) and a CSS
 * `#rgb` / `#rrggbb` string.
 *
 * @packageDocumentation
 */

import { DEFAULT_BACKGROUND_COLOR } from '../../constants';
import { clamp01 } from '../../utils/MathUtils';
import type { LightShadowLike } from './types';

/** A plain linear RGB colour. */
export interface LightColor {
  /** Red channel in `[0, 1]`. */
  r: number;
  /** Green channel in `[0, 1]`. */
  g: number;
  /** Blue channel in `[0, 1]`. */
  b: number;
}

/** `true` when `value` looks like a `LightColor`. */
export function isLightColor(value: unknown): value is LightColor {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<LightColor>;
  return (
    typeof candidate.r === 'number' &&
    typeof candidate.g === 'number' &&
    typeof candidate.b === 'number'
  );
}

/**
 * Coerces a hex integer, CSS string or ready-made colour into a
 * {@link LightColor}.
 *
 * @param value Colour source; anything unparseable falls back to white.
 * @param target Optional record to write into, so hot paths stay allocation-free.
 */
export function parseColor(
  value: number | string | LightColor | null | undefined,
  target: LightColor = { r: 1, g: 1, b: 1 },
): LightColor {
  if (isLightColor(value)) {
    target.r = clamp01(value.r);
    target.g = clamp01(value.g);
    target.b = clamp01(value.b);
    return target;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const hex = Math.round(value) & 0xffffff;
    target.r = ((hex >> 16) & 0xff) / 255;
    target.g = ((hex >> 8) & 0xff) / 255;
    target.b = (hex & 0xff) / 255;
    return target;
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (text.startsWith('#')) {
      const digits = text.slice(1);
      if (digits.length === 3 || digits.length === 4) {
        const r = Number.parseInt(digits[0] + digits[0], 16);
        const g = Number.parseInt(digits[1] + digits[1], 16);
        const b = Number.parseInt(digits[2] + digits[2], 16);
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
          target.r = r / 255;
          target.g = g / 255;
          target.b = b / 255;
          return target;
        }
      } else if (digits.length === 6 || digits.length === 8) {
        const r = Number.parseInt(digits.slice(0, 2), 16);
        const g = Number.parseInt(digits.slice(2, 4), 16);
        const b = Number.parseInt(digits.slice(4, 6), 16);
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
          target.r = r / 255;
          target.g = g / 255;
          target.b = b / 255;
          return target;
        }
      }
    }
  }

  return parseColor(DEFAULT_BACKGROUND_COLOR, target);
}

/** Writes `color` into `target`, returning `target`. */
export function copyColor(source: LightColor, target: LightColor): LightColor {
  target.r = source.r;
  target.g = source.g;
  target.b = source.b;
  return target;
}

/** `true` when both colours match within `tolerance`. */
export function colorEquals(a: LightColor, b: LightColor, tolerance = 1e-6): boolean {
  return (
    Math.abs(a.r - b.r) <= tolerance &&
    Math.abs(a.g - b.g) <= tolerance &&
    Math.abs(a.b - b.b) <= tolerance
  );
}

/** Mutable default used only to seed new colours; never handed out directly. */
export const WHITE: LightColor = { r: 1, g: 1, b: 1 };

/** Placeholder shadow state shared by every light until the shadow module lands. */
export function createShadowState(): LightShadowLike {
  return {
    enabled: false,
    mapSize: { width: 512, height: 512 },
    bias: 0,
    normalBias: 0,
    near: 0.5,
    far: 500,
  };
}
