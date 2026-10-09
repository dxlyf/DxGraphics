/**
 * `Color` — an RGBA colour with float channels and a chainable API.
 *
 * ## Storage
 *
 * The `r`, `g` and `b` fields hold *working-space* channel values in `0..1`;
 * `a` holds a straight alpha in `0..1` that is **never** gamma-corrected.
 * Values outside `0..1` are permitted so high-dynamic-range colours survive a
 * round trip through the pipeline unchanged.
 *
 * ## Colour management
 *
 * {@link Color.managementEnabled} (static, default `false`) decides what the
 * working space is, and therefore whether the string/number/byte entry points
 * convert anything:
 *
 * - `false` — {@link Color.setHex}, {@link Color.setStyle} and
 *   {@link Color.setRgb} store the sRGB-encoded input verbatim, and
 *   {@link Color.getHex}, {@link Color.getStyle}, {@link Color.getRGB} and
 *   {@link Color.toCssString} emit it verbatim. Hex/CSS round-trips are exact.
 * - `true` — the fields become linear light: sRGB input is decoded with
 *   `srgbToLinearComponent` and output is encoded with
 *   `linearToSrgbComponent`. Hex/CSS round-trips stay exact to float precision.
 *
 * {@link Color.convertSRGBToLinear} and {@link Color.convertLinearToSRGB} are
 * explicit conversions that ignore the flag entirely, and the `colorSpace`
 * field is metadata only — it never changes the arithmetic.
 *
 * ```ts
 * const c = new Color('#336699');
 * c.getHexString();                    // '#336699'
 *
 * Color.managementEnabled = true;
 * new Color('#336699').getHexString(); // '#336699' (stored as linear light)
 * ```
 *
 * @packageDocumentation
 */

import { EPSILON } from '../constants';
import type { ColorLike } from '../types';
import {
  contrastRatio,
  hslToRgbChannels,
  hsvToRgbChannels,
  intToHex,
  linearToSrgbComponent,
  normalizeColorString,
  parseToChannels,
  relativeLuminance,
  rgbToHslChannels,
  rgbToHsvChannels,
  srgbToLinearComponent,
  toCssRgba,
} from '../utils/ColorUtils';
import { clamp01, lerp } from '../utils/MathUtils';

/**
 * Identifies the colour space a set of channels is meant to be interpreted in.
 *
 * The value is carried as metadata on {@link Color} only; it never triggers a
 * conversion. Conversions happen solely through
 * {@link Color.managementEnabled} or the explicit `convert*` methods.
 */
export type ColorSpace = 'srgb' | 'linear-srgb' | 'display-p3';

/** Anything the `Color` factories and colour-taking methods can coerce. */
export type ColorRepresentation = Color | number | string | ColorLike;

/** Hue (degrees), saturation and lightness, each in the usual HSL ranges. */
export interface ColorHSL {
  /** Hue in degrees, `0..360`. */
  h: number;

  /** Saturation, `0..1`. */
  s: number;

  /** Lightness, `0..1`. */
  l: number;
}

/** Hue (degrees), saturation and value, each in the usual HSV ranges. */
export interface ColorHSV {
  /** Hue in degrees, `0..360`. */
  h: number;

  /** Saturation, `0..1`. */
  s: number;

  /** Value (brightness), `0..1`. */
  v: number;
}

/** Red, green and blue as byte-scaled channel values in `0..255`. */
export interface ColorRGB {
  /** Red, `0..255`. */
  r: number;

  /** Green, `0..255`. */
  g: number;

  /** Blue, `0..255`. */
  b: number;
}

/** Internal scratch shape used to read a foreign colour without allocating. */
interface ColorChannels {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Scratch buffer reused by every single-operand coercion. */
const _channels: ColorChannels = { r: 0, g: 0, b: 0, a: 1 };

/** Second scratch buffer, needed by `lerpColors` and `contrastWith`. */
const _other: ColorChannels = { r: 0, g: 0, b: 0, a: 1 };

/** Scratch buffer for the HSL/HSV round trips inside `offsetHSL` and friends. */
const _hsl: ColorHSL = { h: 0, s: 0, l: 0 };

/** Scratch buffer for `getHSV`. */
const _hsv: ColorHSV = { h: 0, s: 0, v: 0 };

/** An RGBA colour with linear-light float channels. */
export class Color {
  /**
   * Switches automatic sRGB conversion at the string/number/byte boundary.
   *
   * When `true`, {@link setHex}, {@link setStyle} and {@link setRgb} decode
   * sRGB input into linear light, and {@link getHex}, {@link getStyle},
   * {@link getRGB} and {@link toCssString} encode it back. Defaults to
   * `false`, which stores and returns the numbers verbatim.
   */
  public static managementEnabled: boolean = false;

  /** Red channel in the working space, normally `0..1`. */
  public r: number;

  /** Green channel in the working space, normally `0..1`. */
  public g: number;

  /** Blue channel in the working space, normally `0..1`. */
  public b: number;

  /** Straight alpha in `0..1`; never gamma-corrected. */
  public a: number;

  /**
   * Metadata describing the space the channels are in.
   *
   * Purely informational: it is copied by {@link copy} and reported by
   * {@link toJSON}, but no method branches on it.
   */
  public colorSpace: ColorSpace;

  /** Creates an opaque black colour. */
  constructor();
  /** Creates a colour from a 24-bit `0xrrggbb` integer. */
  constructor(hex: number);
  /** Creates a colour from any CSS colour string. */
  constructor(style: string);
  /** Creates a colour from a `{ r, g, b, a? }` literal with `0..1` channels. */
  constructor(color: ColorLike);
  /** Creates a colour from `0..1` channel values. */
  constructor(r: number, g: number, b: number, a?: number);
  constructor(value?: number | string | ColorLike, g?: number, b?: number, a?: number) {
    this.r = 0;
    this.g = 0;
    this.b = 0;
    this.a = 1;
    this.colorSpace = 'srgb';
    if (value !== undefined) this.set(value, g, b, a);
  }

  /* ---------------------------------------------------------------- static */

  /** Coerces any {@link ColorRepresentation} into a new `Color`. */
  public static from(input: ColorRepresentation): Color {
    if (input instanceof Color) return input.clone();
    return new Color().set(input);
  }

  /** Builds a colour from a `0xrrggbb` integer or a CSS hex string. */
  public static fromHex(hex: number | string, target: Color = new Color()): Color {
    return target.setHex(hex);
  }

  /** Builds a colour from byte-scaled sRGB channels (`0..255`). */
  public static fromRgb(
    r: number,
    g: number,
    b: number,
    a: number = 1,
    target: Color = new Color(),
  ): Color {
    return target.setRgb(r, g, b, a);
  }

  /** Builds a colour from HSL, with `h` in degrees and `s`/`l` in `0..1`. */
  public static fromHsl(
    h: number,
    s: number,
    l: number,
    a: number = 1,
    target: Color = new Color(),
  ): Color {
    return target.setHsl(h, s, l, a);
  }

  /** Builds a colour from HSV, with `h` in degrees and `s`/`v` in `0..1`. */
  public static fromHsv(
    h: number,
    s: number,
    v: number,
    a: number = 1,
    target: Color = new Color(),
  ): Color {
    return target.setHsv(h, s, v, a);
  }

  /** Builds a colour from `[r, g, b, a?]` in the working space. */
  public static fromArray(
    array: ArrayLike<number>,
    offset: number = 0,
    target: Color = new Color(),
  ): Color {
    return target.set(
      array[offset] ?? 0,
      array[offset + 1] ?? 0,
      array[offset + 2] ?? 0,
      array[offset + 3] ?? 1,
    );
  }

  /** Returns an opaque colour with uniformly random `0..1` channels. */
  public static random(): Color {
    return new Color(Math.random(), Math.random(), Math.random(), 1);
  }

  /** Opaque black, `(0, 0, 0, 1)`. */
  public static black(): Color {
    return new Color(0, 0, 0, 1);
  }

  /** Opaque white, `(1, 1, 1, 1)`. */
  public static white(): Color {
    return new Color(1, 1, 1, 1);
  }

  /** Opaque red, `(1, 0, 0, 1)`. */
  public static red(): Color {
    return new Color(1, 0, 0, 1);
  }

  /** Opaque green, `(0, 1, 0, 1)`. */
  public static green(): Color {
    return new Color(0, 1, 0, 1);
  }

  /** Opaque blue, `(0, 0, 1, 1)`. */
  public static blue(): Color {
    return new Color(0, 0, 1, 1);
  }

  /** Fully transparent black, `(0, 0, 0, 0)`. */
  public static transparent(): Color {
    return new Color(0, 0, 0, 0);
  }

  /**
   * Coerces any representation into a new `Color`.
   *
   * Never throws: a string that cannot be understood resolves to opaque black,
   * exactly like {@link setStyle}.
   */
  public static parse(input: ColorRepresentation): Color {
    return Color.from(input);
  }

  /* ----------------------------------------------------------- management */

  /** Decodes one sRGB channel into the working space when management is on. */
  private static decode(value: number): number {
    return Color.managementEnabled ? srgbToLinearComponent(value) : value;
  }

  /** Encodes one working-space channel back to sRGB when management is on. */
  private static encode(value: number): number {
    return Color.managementEnabled ? linearToSrgbComponent(value) : value;
  }

  /** Reads the alpha carried by a CSS colour string (`1` when it has none). */
  private static parseAlpha(style: string): number {
    const text = style.trim().toLowerCase();

    const hexMatch = /^#(?:[0-9a-f]{4}|[0-9a-f]{8})$/.exec(text);
    if (hexMatch) {
      const digits = text.slice(1);
      const alphaHex = digits.length === 4 ? `${digits[3]}${digits[3]}` : digits.slice(6);
      return clamp01(Number.parseInt(alphaHex, 16) / 255);
    }

    const functionMatch = /^(?:rgb|rgba|hsl|hsla)\(([^)]*)\)$/.exec(text);
    if (functionMatch) {
      const parts = functionMatch[1]
        .replace(/\//g, ' ')
        .split(/[,\s]+/)
        .filter((part) => part.length > 0);
      if (parts.length >= 4) {
        const raw = parts[3];
        const value = raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
        return Number.isFinite(value) ? clamp01(value) : 1;
      }
    }

    return 1;
  }

  /**
   * Reads any colour representation into `target` without allocating.
   *
   * `Color` instances are read channel-for-channel; every other input is
   * interpreted as sRGB and decoded when {@link Color.managementEnabled}.
   */
  private static readChannels(
    input: ColorRepresentation,
    target: ColorChannels = _channels,
  ): ColorChannels {
    if (input instanceof Color) {
      target.r = input.r;
      target.g = input.g;
      target.b = input.b;
      target.a = input.a;
      return target;
    }

    if (typeof input === 'object' && input !== null) {
      target.r = Color.decode(input.r);
      target.g = Color.decode(input.g);
      target.b = Color.decode(input.b);
      target.a = input.a ?? 1;
      return target;
    }

    const alpha = typeof input === 'string' ? Color.parseAlpha(input) : 1;
    parseToChannels(input, target, alpha);
    target.r = Color.decode(target.r);
    target.g = Color.decode(target.g);
    target.b = Color.decode(target.b);
    return target;
  }

  /* ----------------------------------------------------------- accessors */

  /** Shorthand for {@link getHex}. */
  public get hex(): number {
    return this.getHex();
  }

  /** Shorthand for {@link setHex}. */
  public set hex(value: number) {
    this.setHex(value);
  }

  /** Shorthand for {@link getStyle}. */
  public get style(): string {
    return this.getStyle();
  }

  /** Shorthand for {@link setStyle}. */
  public set style(value: string) {
    this.setStyle(value);
  }

  /* ------------------------------------------------------------ mutators */

  /**
   * Assigns from any representation.
   *
   * A lone number is a `0xrrggbb` integer; `(r, g, b, a?)` numbers are `0..1`
   * channels; a string is a CSS colour; an object contributes its channels.
   * `Color` instances are copied channel-for-channel (see {@link copy}).
   */
  public set(value: ColorRepresentation, g?: number, b?: number, a?: number): this {
    if (value instanceof Color) return this.copy(value);
    if (typeof value === 'string') return this.setStyle(value);
    if (typeof value === 'number') {
      if (g === undefined) return this.setHex(value);
      return this.setChannels(value, g, b ?? g, a ?? 1);
    }
    return this.setColorLike(value, a);
  }

  /**
   * Sets the working-space channels from a `{ r, g, b, a? }` literal.
   *
   * The literal is treated as sRGB input and therefore decoded when
   * {@link Color.managementEnabled} is `true`; use {@link copy} to transfer
   * working-space channels verbatim.
   */
  public setColorLike(source: ColorLike, alpha?: number): this {
    return this.setChannels(source.r, source.g, source.b, source.a ?? alpha ?? 1);
  }

  /**
   * Sets the three colour channels plus alpha from `0..1` sRGB values.
   *
   * This is the raw path shared by the constructor and {@link fromArray}; it
   * decodes into the working space when {@link Color.managementEnabled}.
   */
  private setChannels(r: number, g: number, b: number, a: number): this {
    this.r = Color.decode(r);
    this.g = Color.decode(g);
    this.b = Color.decode(b);
    this.a = a;
    return this;
  }

  /**
   * Sets the colour from a `0xrrggbb` integer or a CSS hex string.
   *
   * Alpha becomes `1`, except for inputs that carry one explicitly (`#rgba`,
   * `#rrggbbaa`, `rgba(...)`, `hsla(...)`). An unparseable string yields
   * opaque black.
   */
  public setHex(hex: number | string): this {
    let value: number;
    let alpha = 1;

    if (typeof hex === 'string') {
      alpha = Color.parseAlpha(hex);
      const normalized = normalizeColorString(hex);
      if (normalized === null) {
        this.r = 0;
        this.g = 0;
        this.b = 0;
        this.a = 1;
        return this;
      }
      value = Number.parseInt(normalized.slice(1), 16);
    } else {
      value = Number.isFinite(hex) ? Math.max(0, Math.min(0xffffff, Math.floor(hex))) : 0;
    }

    this.r = Color.decode(((value >> 16) & 0xff) / 255);
    this.g = Color.decode(((value >> 8) & 0xff) / 255);
    this.b = Color.decode((value & 0xff) / 255);
    this.a = alpha;
    return this;
  }

  /**
   * Sets the colour from byte-scaled sRGB channels.
   *
   * Values are expected in `0..255`; they are **not** clamped, so byte values
   * above `255` behave like HDR input.
   */
  public setRgb(r: number, g: number, b: number, a: number = 1): this {
    return this.setChannels(r / 255, g / 255, b / 255, a);
  }

  /** Sets the colour from HSL, with `h` in degrees and `s`/`l` in `0..1`. */
  public setHsl(h: number, s: number, l: number, a: number = 1): this {
    const rgb = hslToRgbChannels(h / 360, s, l);
    return this.setChannels(rgb.r, rgb.g, rgb.b, a);
  }

  /** Sets the colour from HSV, with `h` in degrees and `s`/`v` in `0..1`. */
  public setHsv(h: number, s: number, v: number, a: number = 1): this {
    const rgb = hsvToRgbChannels(h / 360, s, v);
    return this.setChannels(rgb.r, rgb.g, rgb.b, a);
  }

  /**
   * Sets a CSS colour string, including `#rgb`, `#rrggbbaa`, `rgb()`,
   * `hsl()`, `color()`-free keywords and `transparent`.
   *
   * The input is sRGB and is decoded when {@link Color.managementEnabled}.
   * Alpha is honoured for `#rgba`/`#rrggbbaa` and four-argument functions;
   * everything else becomes opaque. An unrecognised string yields opaque
   * black.
   */
  public setStyle(style: string): this {
    return this.setHex(style);
  }

  /** Sets `r`, `g` and `b` to `scalar`, leaving alpha untouched. */
  public setScalar(scalar: number): this {
    this.r = scalar;
    this.g = scalar;
    this.b = scalar;
    return this;
  }

  /**
   * Copies working-space channels verbatim, with no sRGB decoding.
   *
   * Use this when transferring a colour between working spaces or when the
   * source already holds working-space values; use {@link set} or
   * {@link setColorLike} to interpret `{ r, g, b }` as sRGB input. The
   * `colorSpace` metadata is copied from `Color` sources only.
   */
  public copy(source: ColorLike): this {
    this.r = source.r;
    this.g = source.g;
    this.b = source.b;
    this.a = source.a ?? 1;
    if (source instanceof Color) this.colorSpace = source.colorSpace;
    return this;
  }

  /* ------------------------------------------------------------ products */

  /**
   * Linear interpolation towards `color` by `alpha`, all four channels
   * included.
   */
  public lerp(color: ColorRepresentation, alpha: number): this {
    const c = Color.readChannels(color);
    this.r = lerp(this.r, c.r, alpha);
    this.g = lerp(this.g, c.g, alpha);
    this.b = lerp(this.b, c.b, alpha);
    this.a = lerp(this.a, c.a, alpha);
    return this;
  }

  /** Sets this colour to `a` interpolated towards `b` by `t`. */
  public lerpColors(a: ColorRepresentation, b: ColorRepresentation, t: number): this {
    const ca = Color.readChannels(a, _channels);
    const cb = Color.readChannels(b, _other);
    this.r = lerp(ca.r, cb.r, t);
    this.g = lerp(ca.g, cb.g, t);
    this.b = lerp(ca.b, cb.b, t);
    this.a = lerp(ca.a, cb.a, t);
    return this;
  }

  /** Multiplies `r`, `g` and `b` component-wise by `color`. */
  public multiply(color: ColorRepresentation): this {
    const c = Color.readChannels(color);
    this.r *= c.r;
    this.g *= c.g;
    this.b *= c.b;
    return this;
  }

  /** Multiplies `r`, `g` and `b` by `scalar`, leaving alpha untouched. */
  public multiplyScalar(scalar: number): this {
    this.r *= scalar;
    this.g *= scalar;
    this.b *= scalar;
    return this;
  }

  /** Adds `color` component-wise to `r`, `g` and `b`. */
  public add(color: ColorRepresentation): this {
    const c = Color.readChannels(color);
    this.r += c.r;
    this.g += c.g;
    this.b += c.b;
    return this;
  }

  /** Subtracts `color` component-wise from `r`, `g` and `b`. */
  public sub(color: ColorRepresentation): this {
    const c = Color.readChannels(color);
    this.r -= c.r;
    this.g -= c.g;
    this.b -= c.b;
    return this;
  }

  /** Adds `scalar` to `r`, `g` and `b`, leaving alpha untouched. */
  public addScalar(scalar: number): this {
    this.r += scalar;
    this.g += scalar;
    this.b += scalar;
    return this;
  }

  /** Offsets hue by `h` degrees and saturation/lightness by `s`/`l`. */
  public offsetHSL(h: number, s: number, l: number): this {
    const hsl = this.getHSL(_hsl);
    return this.setHsl(hsl.h + h, clamp01(hsl.s + s), clamp01(hsl.l + l), this.a);
  }

  /**
   * Moves saturation towards `1` by `amount`.
   *
   * The hue comes from the current HSL decomposition, so saturating a neutral
   * colour (which reports hue `0`) tints it red.
   */
  public saturate(amount: number = 1): this {
    const hsl = this.getHSL(_hsl);
    return this.setHsl(hsl.h, clamp01(lerp(hsl.s, 1, amount)), hsl.l, this.a);
  }

  /** Moves saturation towards `0` by `amount`. */
  public desaturate(amount: number = 1): this {
    const hsl = this.getHSL(_hsl);
    return this.setHsl(hsl.h, clamp01(lerp(hsl.s, 0, amount)), hsl.l, this.a);
  }

  /** Removes all saturation, keeping lightness and alpha. */
  public grayscale(): this {
    return this.desaturate(1);
  }

  /** Photographic negative: replaces each of `r`, `g` and `b` with `1 - c`. */
  public invert(): this {
    this.r = 1 - this.r;
    this.g = 1 - this.g;
    this.b = 1 - this.b;
    return this;
  }

  /**
   * Flips the sign of `r`, `g` and `b`.
   *
   * Provided for symmetry with `Vec3.negate`; the result is generally not a
   * displayable colour and is only meaningful for intermediate maths.
   */
  public negate(): this {
    this.r = -this.r;
    this.g = -this.g;
    this.b = -this.b;
    return this;
  }

  /** Clamps every channel, alpha included, into `0..1`. */
  public clamp(): this {
    this.r = clamp01(this.r);
    this.g = clamp01(this.g);
    this.b = clamp01(this.b);
    this.a = clamp01(this.a);
    return this;
  }

  /* -------------------------------------------------------------- quieries */

  /** `true` when every channel matches `other` within `tolerance`. */
  public equals(other: ColorRepresentation, tolerance: number = EPSILON): boolean {
    const c = Color.readChannels(other);
    return (
      Math.abs(this.r - c.r) <= tolerance &&
      Math.abs(this.g - c.g) <= tolerance &&
      Math.abs(this.b - c.b) <= tolerance &&
      Math.abs(this.a - c.a) <= tolerance
    );
  }

  /**
   * `true` when the relative (WCAG) luminance is at or below `0.5`.
   *
   * Use it to choose light or dark overlays; {@link contrastWith} gives the
   * full ratio when a threshold is not enough.
   */
  public isDark(): boolean {
    return this.getRelativeLuminance() <= 0.5;
  }

  /**
   * WCAG contrast ratio against `other`, in `1..21`.
   *
   * Both colours are encoded to sRGB before measuring, so the result is
   * independent of {@link Color.managementEnabled}.
   */
  public contrastWith(other: ColorRepresentation): number {
    const c = Color.readChannels(other, _other);
    return contrastRatio(
      [
        clamp01(Color.encode(this.r)),
        clamp01(Color.encode(this.g)),
        clamp01(Color.encode(this.b)),
      ],
      [clamp01(Color.encode(c.r)), clamp01(Color.encode(c.g)), clamp01(Color.encode(c.b))],
    );
  }

  /* ------------------------------------------------------------ conversion */

  /** Converts the three colour channels from sRGB encoding to linear light. */
  public convertSRGBToLinear(): this {
    this.r = srgbToLinearComponent(this.r);
    this.g = srgbToLinearComponent(this.g);
    this.b = srgbToLinearComponent(this.b);
    return this;
  }

  /** Converts the three colour channels from linear light to sRGB encoding. */
  public convertLinearToSRGB(): this {
    this.r = linearToSrgbComponent(this.r);
    this.g = linearToSrgbComponent(this.g);
    this.b = linearToSrgbComponent(this.b);
    return this;
  }

  /* --------------------------------------------------------------- output */

  /** Packs the colour into a `0xrrggbb` integer. */
  public getHex(): number {
    const r = Math.round(clamp01(Color.encode(this.r)) * 255);
    const g = Math.round(clamp01(Color.encode(this.g)) * 255);
    const b = Math.round(clamp01(Color.encode(this.b)) * 255);
    return (r << 16) | (g << 8) | b;
  }

  /** Formats the colour as `#rrggbb`. */
  public getHexString(): string {
    return intToHex(this.getHex());
  }

  /** Alias of {@link getHexString}, matching the `Vec2`/`Vec3` `to*` style. */
  public toHexString(): string {
    return this.getHexString();
  }

  /** Copies the colour into `target` as a `#rrggbb` string. */
  public getStyle(): string {
    const r = clamp01(Color.encode(this.r));
    const g = clamp01(Color.encode(this.g));
    const b = clamp01(Color.encode(this.b));
    if (this.a >= 1) {
      return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
    }
    return toCssRgba(r, g, b, this.a);
  }

  /** Formats the colour as an `rgba(r, g, b, a)` string for Canvas2D/SVG. */
  public toCssString(): string {
    return toCssRgba(
      Color.encode(this.r),
      Color.encode(this.g),
      Color.encode(this.b),
      this.a,
    );
  }

  /** Decomposes the colour into HSL, with `h` in degrees and `s`/`l` in `0..1`. */
  public getHSL(target: ColorHSL = { h: 0, s: 0, l: 0 }): ColorHSL {
    const hsl = rgbToHslChannels(
      Color.encode(this.r),
      Color.encode(this.g),
      Color.encode(this.b),
    );
    target.h = hsl.h * 360;
    target.s = hsl.s;
    target.l = hsl.l;
    return target;
  }

  /** Decomposes the colour into HSV, with `h` in degrees and `s`/`v` in `0..1`. */
  public getHSV(target: ColorHSV = { h: 0, s: 0, v: 0 }): ColorHSV {
    const hsv = rgbToHsvChannels(
      Color.encode(this.r),
      Color.encode(this.g),
      Color.encode(this.b),
    );
    target.h = hsv.h * 360;
    target.s = hsv.s;
    target.v = hsv.v;
    return target;
  }

  /**
   * Returns the byte-scaled sRGB channels in `0..255`.
   *
   * The values are not rounded, so `setRgb(...getRGB())` round-trips exactly.
   */
  public getRGB(target: ColorRGB = { r: 0, g: 0, b: 0 }): ColorRGB {
    target.r = Color.encode(this.r) * 255;
    target.g = Color.encode(this.g) * 255;
    target.b = Color.encode(this.b) * 255;
    return target;
  }

  /**
   * Weighted sum `0.2126 r + 0.7152 g + 0.0722 b` of the stored channels.
   *
   * With {@link Color.managementEnabled} the stored channels are linear light,
   * so this is true relative luminance; with management disabled it is the
   * same weighting applied to sRGB-encoded values.
   */
  public getLuminance(): number {
    return 0.2126 * this.r + 0.7152 * this.g + 0.0722 * this.b;
  }

  /** WCAG relative luminance of the colour as sRGB (`0..1`). */
  public getRelativeLuminance(): number {
    return relativeLuminance(
      clamp01(Color.encode(this.r)),
      clamp01(Color.encode(this.g)),
      clamp01(Color.encode(this.b)),
    );
  }

  /* -------------------------------------------------------------- queries */

  /** `[r, g, b, a]`. */
  public toArray(target: number[] = [], offset: number = 0): number[] {
    target[offset] = this.r;
    target[offset + 1] = this.g;
    target[offset + 2] = this.b;
    target[offset + 3] = this.a;
    return target;
  }

  /** Writes `[r, g, b, a]` into a `Float32Array`. */
  public toFloat32Array(
    target: Float32Array = new Float32Array(4),
    offset: number = 0,
  ): Float32Array {
    target[offset] = this.r;
    target[offset + 1] = this.g;
    target[offset + 2] = this.b;
    target[offset + 3] = this.a;
    return target;
  }

  /** Returns a new colour with the same channels and metadata. */
  public clone(): Color {
    const color = new Color();
    color.r = this.r;
    color.g = this.g;
    color.b = this.b;
    color.a = this.a;
    color.colorSpace = this.colorSpace;
    return color;
  }

  /** JSON-friendly representation of the channels. */
  public toJSON(): { r: number; g: number; b: number; a: number } {
    return { r: this.r, g: this.g, b: this.b, a: this.a };
  }

  /** `"[r, g, b, a]"`, each channel rounded to `precision` digits. */
  public toString(precision: number = 4): string {
    return `[${this.r.toFixed(precision)}, ${this.g.toFixed(precision)}, ${this.b.toFixed(
      precision,
    )}, ${this.a.toFixed(precision)}]`;
  }

  /** Iterates over `r`, `g`, `b`, `a`. */
  public *[Symbol.iterator](): IterableIterator<number> {
    yield this.r;
    yield this.g;
    yield this.b;
    yield this.a;
  }
}

/**
 * Creates a `Color` from a hex integer, a CSS string or `0..1` channel values.
 *
 * ```ts
 * color('#ff0000');
 * color(0xff0000);
 * color(1, 0, 0, 0.5);
 * ```
 */
export function color(
  value?: number | string | ColorLike,
  g?: number,
  b?: number,
  a?: number,
): Color {
  const result = new Color();
  if (value !== undefined) result.set(value, g, b, a);
  return result;
}
