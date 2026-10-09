/**
 * Renderer-facing colour helpers.
 *
 * Everything here works on plain 0..1 channel values so that the renderer layer
 * never needs the math `Color` class at runtime. `Color`-like objects (anything
 * with `r`/`g`/`b` and an optional `a`) are accepted structurally.
 *
 * @packageDocumentation
 */

import type { ColorLike } from '../../types';
import { normalizeColorString, toCssRgba } from '../../utils/ColorUtils';
import { clamp01 } from '../../utils/MathUtils';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** Four 0..1 colour channels. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Four 0..255 integer colour channels. */
export interface RGBA8 {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Anything the renderers accept wherever a colour is expected. */
export type ColorInput = string | number | ColorLike | RGBA;

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Normalises any accepted colour input to 0..1 RGBA channels.
 *
 * `alpha` always overrides the input's own alpha channel; pass `undefined` to
 * keep it. Unparseable inputs resolve to opaque black, matching the behaviour of
 * `normalizeColorString`.
 *
 * @param input Colour string (`#rgb`, `#rrggbbaa`, `rgb()`, `hsl()`, keyword),
 *   a 24-bit integer, or an object with 0..1 `r`/`g`/`b` (and optional `a`).
 * @param alpha Optional alpha override in 0..1.
 * @param target Optional object to write into (allocation-free hot paths).
 * @returns The normalised channels.
 */
export function normalizeColor(input: unknown, alpha?: number, target: RGBA = { r: 0, g: 0, b: 0, a: 1 }): RGBA {
  if (typeof input === 'object' && input !== null) {
    const like = input as Partial<RGBA>;
    if (
      typeof like.r === 'number' &&
      typeof like.g === 'number' &&
      typeof like.b === 'number' &&
      typeof like.a === 'number' &&
      !('length' in like)
    ) {
      target.r = clamp01(like.r);
      target.g = clamp01(like.g);
      target.b = clamp01(like.b);
      target.a = alpha == null ? clamp01(like.a) : clamp01(alpha);
      return target;
    }
  }

  const hex = normalizeColorString(input) ?? '#000000';
  const value = Number.parseInt(hex.slice(1), 16);
  target.r = ((value >> 16) & 0xff) / 255;
  target.g = ((value >> 8) & 0xff) / 255;
  target.b = (value & 0xff) / 255;
  target.a = alpha == null ? 1 : clamp01(alpha);
  return target;
}

/**
 * Converts 0..1 channels to 0..255 integers.
 *
 * @param rgba Source channels.
 * @param target Optional object to write into.
 */
export function toRGBA8(rgba: Readonly<RGBA>, target: RGBA8 = { r: 0, g: 0, b: 0, a: 255 }): RGBA8 {
  target.r = Math.round(clamp01(rgba.r) * 255);
  target.g = Math.round(clamp01(rgba.g) * 255);
  target.b = Math.round(clamp01(rgba.b) * 255);
  target.a = Math.round(clamp01(rgba.a) * 255);
  return target;
}

/** Formats 0..1 channels as `#rrggbb`. */
export function toHexString(rgba: Readonly<RGBA>): string {
  const channels = toRGBA8(rgba);
  const hex = ((channels.r << 16) | (channels.g << 8) | channels.b).toString(16).padStart(6, '0');
  return `#${hex}`;
}

/** Formats 0..1 channels as `rgba(r, g, b, a)`. */
export function toCss(rgba: Readonly<RGBA>): string {
  return toCssRgba(rgba.r, rgba.g, rgba.b, rgba.a);
}

/** Packs 0..1 channels into a 24-bit integer, discarding alpha. */
export function packColorToInt(rgba: Readonly<RGBA>): number {
  const channels = toRGBA8(rgba);
  return (channels.r << 16) | (channels.g << 8) | channels.b;
}

/** Unpacks a 24-bit integer into 0..1 channels. */
export function unpackColorFromInt(value: number, alpha: number = 1, target: RGBA = { r: 0, g: 0, b: 0, a: 1 }): RGBA {
  const int = Math.max(0, Math.min(0xffffff, Math.round(value)));
  target.r = ((int >> 16) & 0xff) / 255;
  target.g = ((int >> 8) & 0xff) / 255;
  target.b = (int & 0xff) / 255;
  target.a = clamp01(alpha);
  return target;
}

/* -------------------------------------------------------------------------- */
/* Premultiplication                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Multiplies the RGB channels by alpha, in place.
 *
 * Canvas2D stores colours premultiplied; blitting `ImageData` back into a canvas
 * therefore requires premultiplied data.
 */
export function premultiply(target: RGBA): RGBA {
  target.r *= target.a;
  target.g *= target.a;
  target.b *= target.a;
  return target;
}

/** Reverses {@link premultiply}; a fully transparent colour yields black. */
export function unpremultiply(target: RGBA): RGBA {
  if (target.a <= 0) {
    target.r = 0;
    target.g = 0;
    target.b = 0;
    return target;
  }
  target.r /= target.a;
  target.g /= target.a;
  target.b /= target.a;
  return target;
}

/**
 * Premultiplies an `RGBA8` pixel buffer in place.
 *
 * @param data Buffer of `r, g, b, a` bytes.
 * @returns The same buffer, for chaining.
 */
export function premultiplyUint8ClampedArray(data: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    data[i] = Math.round(data[i] * alpha);
    data[i + 1] = Math.round(data[i + 1] * alpha);
    data[i + 2] = Math.round(data[i + 2] * alpha);
  }
  return data;
}

/**
 * Reverses {@link premultiplyUint8ClampedArray} in place.
 *
 * @param data Buffer of `r, g, b, a` bytes.
 * @returns The same buffer, for chaining.
 */
export function unpremultiplyUint8ClampedArray(data: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 0) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      continue;
    }
    const inverse = 255 / alpha;
    data[i] = Math.min(255, Math.round(data[i] * inverse));
    data[i + 1] = Math.min(255, Math.round(data[i + 1] * inverse));
    data[i + 2] = Math.min(255, Math.round(data[i + 2] * inverse));
  }
  return data;
}

/* -------------------------------------------------------------------------- */
/* Pixel packing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Writes 0..1 channels into four consecutive slots of a byte buffer.
 *
 * @param data Destination buffer.
 * @param offset Byte offset of the pixel.
 * @param rgba Source channels (0..1).
 * @param premultiplied Store premultiplied values when `true`.
 */
export function packColorIntoUint8ClampedArray(
  data: Uint8ClampedArray,
  offset: number,
  rgba: Readonly<RGBA>,
  premultiplied: boolean = false,
): void {
  const alpha = clamp01(rgba.a);
  const scale = premultiplied ? alpha : 1;
  data[offset] = Math.round(clamp01(rgba.r) * 255 * scale);
  data[offset + 1] = Math.round(clamp01(rgba.g) * 255 * scale);
  data[offset + 2] = Math.round(clamp01(rgba.b) * 255 * scale);
  data[offset + 3] = Math.round(alpha * 255);
}

/**
 * Writes 0..1 channels into four consecutive slots of a float buffer.
 *
 * @param data Destination buffer.
 * @param offset Float offset of the pixel.
 * @param rgba Source channels (0..1).
 * @param premultiplied Store premultiplied values when `true`.
 */
export function packColorIntoFloat32Array(
  data: Float32Array,
  offset: number,
  rgba: Readonly<RGBA>,
  premultiplied: boolean = false,
): void {
  const alpha = clamp01(rgba.a);
  const scale = premultiplied ? alpha : 1;
  data[offset] = clamp01(rgba.r) * scale;
  data[offset + 1] = clamp01(rgba.g) * scale;
  data[offset + 2] = clamp01(rgba.b) * scale;
  data[offset + 3] = alpha;
}

/**
 * Reads a colour out of a byte buffer.
 *
 * @param data Source buffer.
 * @param offset Byte offset of the pixel.
 * @param premultiplied Undo premultiplication when `true`.
 * @param target Optional object to write into.
 */
export function unpackColorFromUint8ClampedArray(
  data: ArrayLike<number>,
  offset: number,
  premultiplied: boolean = false,
  target: RGBA = { r: 0, g: 0, b: 0, a: 1 },
): RGBA {
  target.r = data[offset] / 255;
  target.g = data[offset + 1] / 255;
  target.b = data[offset + 2] / 255;
  target.a = data[offset + 3] / 255;
  return premultiplied ? unpremultiply(target) : target;
}

/* -------------------------------------------------------------------------- */
/* Clear colours                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Converts any colour input into the `[r, g, b, a]` array expected by
 * `clearColor` on the GPU backends.
 *
 * @param input Colour input.
 * @param alpha Optional alpha override in 0..1.
 * @param premultiplied Premultiply the RGB channels when `true`.
 * @returns A fresh four-element array.
 */
export function toClearColor(input: unknown, alpha?: number, premultiplied: boolean = false): [number, number, number, number] {
  const rgba = normalizeColor(input, alpha);
  if (premultiplied) premultiply(rgba);
  return [rgba.r, rgba.g, rgba.b, rgba.a];
}

/**
 * Converts a `Color`-like object into a clear colour.
 *
 * @param color Object exposing 0..1 `r`/`g`/`b` (and optional `a`).
 * @param alpha Optional alpha override in 0..1.
 */
export function colorLikeToClearColor(color: ColorLike, alpha?: number): [number, number, number, number] {
  return toClearColor(color, alpha);
}

/** `true` when the colour is fully transparent (and therefore a visual no-op). */
export function isTransparent(input: unknown): boolean {
  return normalizeColor(input).a <= 0;
}

/** Linear interpolation between two 0..1 colours. */
export function lerpColor(
  a: Readonly<RGBA>,
  b: Readonly<RGBA>,
  t: number,
  target: RGBA = { r: 0, g: 0, b: 0, a: 1 },
): RGBA {
  const amount = clamp01(t);
  target.r = a.r + (b.r - a.r) * amount;
  target.g = a.g + (b.g - a.g) * amount;
  target.b = a.b + (b.b - a.b) * amount;
  target.a = a.a + (b.a - a.a) * amount;
  return target;
}
