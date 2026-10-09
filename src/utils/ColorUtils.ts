/**
 * Colour utilities: parsing, conversion and perceptual helpers.
 *
 * The math-level `Color` class lives in `src/math/Color.ts`; this module holds
 * the string/format plumbing that both the math class and the renderers need.
 *
 * @packageDocumentation
 */

import type { ColorLike } from '../types';
import { clamp01 } from './MathUtils';

/** CSS colour name table for the 148 keywords plus `transparent`. */
export const COLOR_KEYWORDS: Readonly<Record<string, string>> = {
  aliceblue: '#f0f8ff',
  antiquewhite: '#faebd7',
  aqua: '#00ffff',
  aquamarine: '#7fffd4',
  azure: '#f0ffff',
  beige: '#f5f5dc',
  bisque: '#ffe4c4',
  black: '#000000',
  blanchedalmond: '#ffebcd',
  blue: '#0000ff',
  blueviolet: '#8a2be2',
  brown: '#a52a2a',
  burlywood: '#deb887',
  cadetblue: '#5f9ea0',
  chartreuse: '#7fff00',
  chocolate: '#d2691e',
  coral: '#ff7f50',
  cornflowerblue: '#6495ed',
  cornsilk: '#fff8dc',
  crimson: '#dc143c',
  cyan: '#00ffff',
  darkblue: '#00008b',
  darkcyan: '#008b8b',
  darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9',
  darkgreen: '#006400',
  darkgrey: '#a9a9a9',
  darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b',
  darkolivegreen: '#556b2f',
  darkorange: '#ff8c00',
  darkorchid: '#9932cc',
  darkred: '#8b0000',
  darksalmon: '#e9967a',
  darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f',
  darkslategrey: '#2f4f4f',
  darkturquoise: '#00ced1',
  darkviolet: '#9400d3',
  deeppink: '#ff1493',
  deepskyblue: '#00bfff',
  dimgray: '#696969',
  dimgrey: '#696969',
  dodgerblue: '#1e90ff',
  firebrick: '#b22222',
  floralwhite: '#fffaf0',
  forestgreen: '#228b22',
  fuchsia: '#ff00ff',
  gainsboro: '#dcdcdc',
  ghostwhite: '#f8f8ff',
  gold: '#ffd700',
  goldenrod: '#daa520',
  gray: '#808080',
  green: '#008000',
  greenyellow: '#adff2f',
  grey: '#808080',
  honeydew: '#f0fff0',
  hotpink: '#ff69b4',
  indianred: '#cd5c5c',
  indigo: '#4b0082',
  ivory: '#fffff0',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00',
  lemonchiffon: '#fffacd',
  lightblue: '#add8e6',
  lightcoral: '#f08080',
  lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2',
  lightgray: '#d3d3d3',
  lightgreen: '#90ee90',
  lightgrey: '#d3d3d3',
  lightpink: '#ffb6c1',
  lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa',
  lightskyblue: '#87cefa',
  lightslategray: '#778899',
  lightslategrey: '#778899',
  lightsteelblue: '#b0c4de',
  lightyellow: '#ffffe0',
  lime: '#00ff00',
  limegreen: '#32cd32',
  linen: '#faf0e6',
  magenta: '#ff00ff',
  maroon: '#800000',
  mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd',
  mediumorchid: '#ba55d3',
  mediumpurple: '#9370db',
  mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee',
  mediumspringgreen: '#00fa9a',
  mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585',
  midnightblue: '#191970',
  mintcream: '#f5fffa',
  mistyrose: '#ffe4e1',
  moccasin: '#ffe4b5',
  navajowhite: '#ffdead',
  navy: '#000080',
  oldlace: '#fdf5e6',
  olive: '#808000',
  olivedrab: '#6b8e23',
  orange: '#ffa500',
  orangered: '#ff4500',
  orchid: '#da70d6',
  palegoldenrod: '#eee8aa',
  palegreen: '#98fb98',
  paleturquoise: '#afeeee',
  palevioletred: '#db7093',
  papayawhip: '#ffefd5',
  peachpuff: '#ffdab9',
  peru: '#cd853f',
  pink: '#ffc0cb',
  plum: '#dda0dd',
  powderblue: '#b0e0e6',
  purple: '#800080',
  rebeccapurple: '#663399',
  red: '#ff0000',
  rosybrown: '#bc8f8f',
  royalblue: '#4169e1',
  saddlebrown: '#8b4513',
  salmon: '#fa8072',
  sandybrown: '#f4a460',
  seagreen: '#2e8b57',
  seashell: '#fff5ee',
  sienna: '#a0522d',
  silver: '#c0c0c0',
  skyblue: '#87ceeb',
  slateblue: '#6a5acd',
  slategray: '#708090',
  slategrey: '#708090',
  snow: '#fffafa',
  springgreen: '#00ff7f',
  steelblue: '#4682b4',
  tan: '#d2b48c',
  teal: '#008080',
  thistle: '#d8bfd8',
  tomato: '#ff6347',
  turquoise: '#40e0d0',
  violet: '#ee82ee',
  wheat: '#f5deb3',
  white: '#ffffff',
  whitesmoke: '#f5f5f5',
  yellow: '#ffff00',
  yellowgreen: '#9acd32',
  transparent: '#00000000',
};

/** The three supported CSS colour function names. */
const RGB_PATTERN = /^rgba?\(\s*([^)]+)\)$/i;
const HSL_PATTERN = /^hsla?\(\s*([^)]+)\)$/i;
const HEX_PATTERN = /^#?([0-9a-f]{3,8})$/i;

/**
 * Normalises an arbitrary colour input to a lowercase `#rrggbb` string.
 *
 * Accepted inputs: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(...)`,
 * `rgba(...)`, `hsl(...)`, `hsla(...)`, CSS keywords, numbers (0..0xffffff) and
 * `{ r, g, b }` object literals with channels in the 0..1 range.
 *
 * @returns A `#rrggbb` string, or `null` when the input cannot be understood.
 */
export function normalizeColorString(input: unknown): string | null {
  if (input == null) return null;

  if (typeof input === 'number') {
    return intToHex(Math.max(0, Math.min(0xffffff, Math.round(input))));
  }

  if (typeof input === 'object') {
    const c = input as ColorLike;
    if (typeof c.r === 'number' && typeof c.g === 'number' && typeof c.b === 'number') {
      return rgbToHex(c.r, c.g, c.b, c.a ?? 1);
    }
    return null;
  }

  if (typeof input !== 'string') return null;

  const text = input.trim().toLowerCase();
  if (text.length === 0) return null;

  if (text in COLOR_KEYWORDS) {
    const hex = COLOR_KEYWORDS[text];
    return hex.length === 9 ? hex.slice(0, 7) : hex;
  }

  const hexMatch = HEX_PATTERN.exec(text);
  if (hexMatch) return expandHex(hexMatch[1]);

  const rgbMatch = RGB_PATTERN.exec(text);
  if (rgbMatch) {
    const parts = splitColorArguments(rgbMatch[1]);
    if (parts.length < 3) return null;
    return rgbToHex(parseChannel(parts[0]), parseChannel(parts[1]), parseChannel(parts[2]), 1);
  }

  const hslMatch = HSL_PATTERN.exec(text);
  if (hslMatch) {
    const parts = splitColorArguments(hslMatch[1]);
    if (parts.length < 3) return null;
    const h = parseHue(parts[0]);
    const s = clamp01(parsePercent(parts[1]));
    const l = clamp01(parsePercent(parts[2]));
    const { r, g, b } = hslToRgbChannels(h, s, l);
    return rgbToHex(r, g, b, 1);
  }

  return null;
}

/** Splits `rgb()`/`hsl()` argument lists, tolerating commas, spaces and `/`. */
function splitColorArguments(source: string): string[] {
  return source
    .replace(/\//g, ' ')
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Parses a single RGB channel: `0..255`, `0..1` floats or percentages. */
function parseChannel(value: string): number {
  if (value.endsWith('%')) return clamp01(Number.parseFloat(value) / 100);
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return 0;
  return clamp01(numeric > 1 ? numeric / 255 : numeric);
}

/** Parses a hue value expressed in degrees. */
function parseHue(value: string): number {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return 0;
  const degrees = value.endsWith('rad') ? (numeric * 180) / Math.PI : numeric;
  const wrapped = degrees % 360;
  return (wrapped < 0 ? wrapped + 360 : wrapped) / 360;
}

/** Parses a saturation/lightness value: `0..1` or a percentage. */
function parsePercent(value: string): number {
  if (value.endsWith('%')) return Number.parseFloat(value) / 100;
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric > 1 ? numeric / 100 : numeric;
}

/** Expands `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` into `#rrggbb`. */
function expandHex(hex: string): string {
  if (hex.length === 3 || hex.length === 4) {
    let out = '#';
    for (let i = 0; i < 3; i++) out += hex[i] + hex[i];
    return out;
  }
  if (hex.length === 6) return `#${hex}`;
  if (hex.length === 8) return `#${hex.slice(0, 6)}`;
  return null as unknown as string;
}

/** Formats a 24-bit integer as `#rrggbb`. */
export function intToHex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

/** Parses `#rrggbb` into a 24-bit integer. */
export function hexToInt(hex: string): number {
  const normalized = normalizeColorString(hex);
  if (normalized === null && !normalized) return 0;
  return Number.parseInt((normalized ?? '#000000').slice(1), 16);
}

/** Alias of {@link intToHex} using the conventional `0x` form. */
export function intToHexString(value: number): string {
  return `0x${value.toString(16).padStart(6, '0')}`;
}

/**
 * Packs 0..1 RGB channels into a `#rrggbb` string.
 */
export function rgbToHex(r: number, g: number, b: number, _a: number = 1): string {
  const ri = Math.round(clamp01(r) * 255);
  const gi = Math.round(clamp01(g) * 255);
  const bi = Math.round(clamp01(b) * 255);
  return intToHex((ri << 16) | (gi << 8) | bi);
}

/** Converts HSL (`h` in 0..1, `s`/`l` in 0..1) to 0..1 RGB channels. */
export function hslToRgbChannels(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = ((h % 1) + 1) % 1;
  if (s === 0) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue2rgb(p, q, hue + 1 / 3),
    g: hue2rgb(p, q, hue),
    b: hue2rgb(p, q, hue - 1 / 3),
  };
}

/** Helper for {@link hslToRgbChannels}. */
function hue2rgb(p: number, q: number, t: number): number {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

/** Converts 0..1 RGB channels to HSL (`h` in 0..1, `s`/`l` in 0..1). */
export function rgbToHslChannels(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const maxChannel = Math.max(r, g, b);
  const minChannel = Math.min(r, g, b);
  const l = (maxChannel + minChannel) * 0.5;
  if (maxChannel === minChannel) return { h: 0, s: 0, l };

  const d = maxChannel - minChannel;
  const s = l > 0.5 ? d / (2 - maxChannel - minChannel) : d / (maxChannel + minChannel);
  let h: number;
  if (maxChannel === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (maxChannel === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s, l };
}

/** Converts an HSV triple (`h` in 0..1) to 0..1 RGB channels. */
export function hsvToRgbChannels(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const hue = (((h % 1) + 1) % 1) * 6;
  const i = Math.floor(hue);
  const f = hue - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      return { r: v, g: t, b: p };
    case 1:
      return { r: q, g: v, b: p };
    case 2:
      return { r: p, g: v, b: t };
    case 3:
      return { r: p, g: q, b: v };
    case 4:
      return { r: t, g: p, b: v };
    default:
      return { r: v, g: p, b: q };
  }
}

/** Converts 0..1 RGB channels to HSV (`h` in 0..1). */
export function rgbToHsvChannels(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const maxChannel = Math.max(r, g, b);
  const minChannel = Math.min(r, g, b);
  const d = maxChannel - minChannel;
  let h = 0;
  if (d !== 0) {
    if (maxChannel === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (maxChannel === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h, s: maxChannel === 0 ? 0 : d / maxChannel, v: maxChannel };
}

/** Converts a single sRGB-encoded channel (0..1) to linear space. */
export function srgbToLinearComponent(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** Converts a single linear channel (0..1) to sRGB encoding. */
export function linearToSrgbComponent(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

/** Relative luminance (WCAG) of 0..1 sRGB channels. */
export function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * srgbToLinearComponent(clamp01(r)) +
    0.7152 * srgbToLinearComponent(clamp01(g)) +
    0.0722 * srgbToLinearComponent(clamp01(b))
  );
}

/** WCAG contrast ratio between two 0..1 RGB triples (1..21). */
export function contrastRatio(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const la = relativeLuminance(a[0], a[1], a[2]);
  const lb = relativeLuminance(b[0], b[1], b[2]);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Chooses black or white text for maximum contrast against a background. */
export function idealTextColor(r: number, g: number, b: number): '#000000' | '#ffffff' {
  return relativeLuminance(r, g, b) > 0.1791 ? '#000000' : '#ffffff';
}

/** Linear interpolation between two 24-bit integers. */
export function lerpHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const mix = (x: number, y: number) => Math.round(x + (y - x) * clamp01(t));
  return (mix(ar, br) << 16) | (mix(ag, bg) << 8) | mix(ab, bb);
}

/** Describes a colour as `rgba(r, g, b, a)` for Canvas2D/SVG output. */
export function toCssRgba(r: number, g: number, b: number, a: number): string {
  const ri = Math.round(clamp01(r) * 255);
  const gi = Math.round(clamp01(g) * 255);
  const bi = Math.round(clamp01(b) * 255);
  return `rgba(${ri}, ${gi}, ${bi}, ${Number(clamp01(a).toFixed(4))})`;
}

/** Describes 0..1 channels as a CSS `hsl()` string. */
export function toCssHsl(r: number, g: number, b: number, a: number = 1): string {
  const { h, s, l } = rgbToHslChannels(r, g, b);
  const hue = Math.round(h * 360);
  const sat = Math.round(s * 100);
  const light = Math.round(l * 100);
  return a >= 1 ? `hsl(${hue}, ${sat}%, ${light}%)` : `hsla(${hue}, ${sat}%, ${light}%, ${a})`;
}

/** Parses a CSS colour into 0..1 RGBA channels. */
export function parseToChannels(
  input: unknown,
  target: { r: number; g: number; b: number; a: number } = { r: 0, g: 0, b: 0, a: 1 },
  alphaOverride?: number,
): { r: number; g: number; b: number; a: number } {
  const hex = normalizeColorString(input) ?? '#000000';
  const value = Number.parseInt(hex.slice(1), 16);
  target.r = ((value >> 16) & 0xff) / 255;
  target.g = ((value >> 8) & 0xff) / 255;
  target.b = (value & 0xff) / 255;
  target.a = alphaOverride ?? 1;
  return target;
}

/** `true` when the string can be parsed as a CSS colour. */
export function isColorString(input: unknown): boolean {
  return normalizeColorString(input) !== null;
}
