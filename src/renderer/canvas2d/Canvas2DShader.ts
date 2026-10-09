/**
 * Canvas2D *emulation* shader.
 *
 * The Canvas2D backend has no programmable pipeline: there is no vertex stage and
 * no fragment stage. Everything a material can express has to map onto the
 * immediate-mode drawing API. What the backend *can* offer is a per-pixel
 * **kernel**: a JavaScript function applied to an `ImageData` buffer and written
 * back with `putImageData`. That is what this module provides.
 *
 * ## Built-in pixel programs
 *
 * | Name | Options | Effect |
 * | --- | --- | --- |
 * | `grayscale` | — | Rec. 601 luminance |
 * | `sepia` | — | Classic warm tone matrix |
 * | `invert` | — | Channel inversion |
 * | `brightness` | `amount` (−1..1) | Additive brightness |
 * | `contrast` | `amount` (−1..1) | Contrast around mid-grey |
 * | `saturate` | `amount` (0..∞) | Saturation multiplier |
 * | `threshold` | `threshold` (0..255) | Hard black/white cut |
 * | `blur` | `radius` (pixels) | Separable box blur |
 * | `tint` | `color`, `strength` | Blend towards a colour |
 *
 * `compile(fragmentSource)` deliberately **rejects** GLSL and WGSL sources and
 * returns a failed {@link ShaderCompileResult} explaining the situation, rather
 * than silently pretending to work.
 *
 * ## Domain note
 *
 * The pixel functions operate on the `ImageData` returned by
 * `ctx.getImageData()`, which is **not** premultiplied. Pass
 * `premultiplied: true` to {@link applyPixelProgram} only if you obtained the
 * buffer from somewhere that premultiplies (for example a WebGL readback).
 *
 * @packageDocumentation
 */

import { createId } from '../../utils/Id';
import { createLogger } from '../../utils/Logger';
import type { IShader, ShaderCompileResult, ShaderMember, UniformValue } from '../interfaces/IShader';
import { ShaderStage, ShaderValueType } from '../interfaces/IShader';

/** Logger for shader diagnostics. */
const log = createLogger('renderer:canvas2d');

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** RGBA channels accepted by colour-driven programs. */
export interface PixelProgramColor {
  /** Red channel in 0..1. */
  r: number;
  /** Green channel in 0..1. */
  g: number;
  /** Blue channel in 0..1. */
  b: number;
  /** Optional alpha in 0..1; ignored by most programs. */
  a?: number;
}

/** Options accepted by the built-in pixel programs. */
export interface PixelProgramOptions {
  /** Generic amount used by `brightness`, `contrast` and `saturate`. */
  amount?: number;
  /** Cut-off used by `threshold`, in 0..255. */
  threshold?: number;
  /** Blur radius in pixels. */
  radius?: number;
  /** Tint colour used by `tint`. */
  color?: PixelProgramColor | string;
  /** Blend strength used by `tint`, in 0..1. */
  strength?: number;
}

/**
 * A per-pixel program.
 *
 * Implementations receive a mutable RGBA byte buffer and must edit it in place.
 * The buffer is **not** premultiplied.
 */
export type PixelProgram = (data: Uint8ClampedArray, width: number, height: number, options: PixelProgramOptions) => void;

/** Options accepted by {@link applyPixelProgram}. */
export interface ApplyPixelProgramOptions extends PixelProgramOptions {
  /** `true` when the buffer holds premultiplied alpha. */
  premultiplied?: boolean;
  /**
   * Clamp out-of-range results instead of wrapping.
   *
   * All built-in programs clamp; the flag exists for custom programs that inspect
   * it through {@link PixelProgramContext}.
   */
  clamp?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Built-in programs                                                          */
/* -------------------------------------------------------------------------- */

/** Rec. 601 luminance weights, matching the CSS `grayscale()` filter. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/**
 * `grayscale` — replaces every pixel with its Rec. 709 luminance.
 *
 * @param data RGBA buffer, edited in place.
 */
export const grayscaleProgram: PixelProgram = (data) => {
  for (let i = 0; i < data.length; i += 4) {
    const value = LUMA_R * data[i] + LUMA_G * data[i + 1] + LUMA_B * data[i + 2];
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }
};

/**
 * `sepia` — applies the conventional sepia matrix.
 *
 * @param data RGBA buffer, edited in place.
 */
export const sepiaProgram: PixelProgram = (data) => {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    data[i] = 0.393 * r + 0.769 * g + 0.189 * b;
    data[i + 1] = 0.349 * r + 0.686 * g + 0.168 * b;
    data[i + 2] = 0.272 * r + 0.534 * g + 0.131 * b;
  }
};

/**
 * `invert` — inverts every colour channel, leaving alpha untouched.
 *
 * @param data RGBA buffer, edited in place.
 */
export const invertProgram: PixelProgram = (data) => {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i];
    data[i + 1] = 255 - data[i + 1];
    data[i + 2] = 255 - data[i + 2];
  }
};

/**
 * `brightness` — adds `options.amount * 255` to every colour channel.
 *
 * @param data RGBA buffer, edited in place.
 * @param width Unused; present for signature uniformity.
 * @param height Unused; present for signature uniformity.
 * @param options `amount` in −1..1 (default `0`).
 */
export const brightnessProgram: PixelProgram = (data, width, height, options) => {
  void width;
  void height;
  const offset = (options.amount ?? 0) * 255;
  if (offset === 0) return;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i] + offset;
    data[i + 1] = data[i + 1] + offset;
    data[i + 2] = data[i + 2] + offset;
  }
};

/**
 * `contrast` — scales channels around mid-grey (128).
 *
 * @param data RGBA buffer, edited in place.
 * @param width Unused.
 * @param height Unused.
 * @param options `amount` in −1..1 (default `0`); `1` is fully thresholded.
 */
export const contrastProgram: PixelProgram = (data, width, height, options) => {
  void width;
  void height;
  const amount = Math.max(-1, Math.min(1, options.amount ?? 0));
  if (amount === 0) return;
  // CSS contrast(): factor is 1 + amount, but never negative.
  const factor = Math.max(0, 1 + amount);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (data[i] - 128) * factor + 128;
    data[i + 1] = (data[i + 1] - 128) * factor + 128;
    data[i + 2] = (data[i + 2] - 128) * factor + 128;
  }
};

/**
 * `saturate` — scales the distance from the pixel's luminance.
 *
 * @param data RGBA buffer, edited in place.
 * @param width Unused.
 * @param height Unused.
 * @param options `amount` (default `1`); `0` is grayscale.
 */
export const saturateProgram: PixelProgram = (data, width, height, options) => {
  void width;
  void height;
  const amount = Math.max(0, options.amount ?? 1);
  if (amount === 1) return;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = LUMA_R * r + LUMA_G * g + LUMA_B * b;
    data[i] = luma + (r - luma) * amount;
    data[i + 1] = luma + (g - luma) * amount;
    data[i + 2] = luma + (b - luma) * amount;
  }
};

/**
 * `threshold` — maps every pixel to black or white around a cut-off.
 *
 * @param data RGBA buffer, edited in place.
 * @param width Unused.
 * @param height Unused.
 * @param options `threshold` in 0..255 (default `128`).
 */
export const thresholdProgram: PixelProgram = (data, width, height, options) => {
  void width;
  void height;
  const cut = Math.max(0, Math.min(255, options.threshold ?? 128));
  for (let i = 0; i < data.length; i += 4) {
    const luma = LUMA_R * data[i] + LUMA_G * data[i + 1] + LUMA_B * data[i + 2];
    const value = luma >= cut ? 255 : 0;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }
};

/**
 * `blur` — separable box blur with a radius of `options.radius` pixels.
 *
 * A box blur is used rather than a Gaussian because it is O(width × height)
 * regardless of radius in this implementation and needs no scratch buffer per
 * pixel. Edge pixels clamp to the nearest in-bounds sample.
 *
 * @param data RGBA buffer, edited in place.
 * @param width Buffer width in pixels.
 * @param height Buffer height in pixels.
 * @param options `radius` in pixels (default `1`).
 */
export const blurProgram: PixelProgram = (data, width, height, options) => {
  const radius = Math.max(0, Math.floor(options.radius ?? 1));
  if (radius === 0 || width <= 0 || height <= 0) return;

  const copy = new Uint8ClampedArray(data);
  const window = radius * 2 + 1;

  // Horizontal pass.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.max(0, Math.min(width - 1, x + k));
        const index = (row + sx) * 4;
        r += copy[index];
        g += copy[index + 1];
        b += copy[index + 2];
        a += copy[index + 3];
      }
      const target = (row + x) * 4;
      data[target] = r / window;
      data[target + 1] = g / window;
      data[target + 2] = b / window;
      data[target + 3] = a / window;
    }
  }

  // Vertical pass, reading from the horizontally blurred result.
  copy.set(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.max(0, Math.min(height - 1, y + k));
        const index = (sy * width + x) * 4;
        r += copy[index];
        g += copy[index + 1];
        b += copy[index + 2];
        a += copy[index + 3];
      }
      const target = (y * width + x) * 4;
      data[target] = r / window;
      data[target + 1] = g / window;
      data[target + 2] = b / window;
      data[target + 3] = a / window;
    }
  }
};

/**
 * `tint` — blends every pixel towards a colour.
 *
 * @param data RGBA buffer, edited in place.
 * @param width Unused.
 * @param height Unused.
 * @param options `color` (object or CSS string) and `strength` in 0..1.
 */
export const tintProgram: PixelProgram = (data, width, height, options) => {
  void width;
  void height;
  const strength = Math.max(0, Math.min(1, options.strength ?? 0.5));
  if (strength <= 0) return;
  const tint = resolveProgramColor(options.color);
  if (tint === null) return;

  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i] + (tint[0] - data[i]) * strength;
    data[i + 1] = data[i + 1] + (tint[1] - data[i + 1]) * strength;
    data[i + 2] = data[i + 2] + (tint[2] - data[i + 2]) * strength;
  }
};

/** The nine built-in programs, keyed by the name accepted by `compile`. */
export const BUILT_IN_PIXEL_PROGRAMS: Readonly<Record<string, PixelProgram>> = {
  grayscale: grayscaleProgram,
  sepia: sepiaProgram,
  invert: invertProgram,
  brightness: brightnessProgram,
  contrast: contrastProgram,
  saturate: saturateProgram,
  threshold: thresholdProgram,
  blur: blurProgram,
  tint: tintProgram,
};

/** Names of the built-in programs, in documentation order. */
export const BUILT_IN_PIXEL_PROGRAM_NAMES: readonly string[] = [
  'grayscale',
  'sepia',
  'invert',
  'brightness',
  'contrast',
  'saturate',
  'threshold',
  'blur',
  'tint',
];

/* -------------------------------------------------------------------------- */
/* Application helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Applies a pixel program to an `ImageData` instance in place.
 *
 * @param imageData Buffer to transform.
 * @param program Program to apply.
 * @param options Program options.
 * @returns The same `ImageData`, for chaining.
 */
export function applyPixelProgramToImageData(
  imageData: ImageData,
  program: PixelProgram,
  options: ApplyPixelProgramOptions = {},
): ImageData {
  if (options.premultiplied) unpremultiply(imageData.data);
  program(imageData.data, imageData.width, imageData.height, options);
  if (options.premultiplied) premultiply(imageData.data);
  return imageData;
}

/**
 * Applies a pixel program to a raw RGBA byte buffer in place.
 *
 * @param data RGBA bytes.
 * @param width Buffer width in pixels.
 * @param height Buffer height in pixels.
 * @param program Program to apply.
 * @param options Program options.
 * @returns The same buffer, for chaining.
 */
export function applyPixelProgram(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  program: PixelProgram,
  options: ApplyPixelProgramOptions = {},
): Uint8ClampedArray {
  if (options.premultiplied) unpremultiply(data);
  program(data, width, height, options);
  if (options.premultiplied) premultiply(data);
  return data;
}

/**
 * Reads a region of a canvas, applies a program and writes it back.
 *
 * This is the whole "shader" story on the 2D backend: one readback, one kernel,
 * one blit. It is O(pixels) and therefore intended for post-processing passes
 * rather than per-draw work.
 *
 * @param context Context to read from and write to.
 * @param program Program to apply.
 * @param options Program options plus an optional region.
 * @returns The transformed `ImageData`, or `null` when readback failed.
 */
export function renderPixelProgram(
  context: CanvasRenderingContext2D | null,
  program: PixelProgram,
  options: ApplyPixelProgramOptions & { x?: number; y?: number; width?: number; height?: number } = {},
): ImageData | null {
  if (context === null) return null;
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  const width = options.width ?? (typeof context.canvas?.width === 'number' ? context.canvas.width - x : 0);
  const height = options.height ?? (typeof context.canvas?.height === 'number' ? context.canvas.height - y : 0);
  if (width <= 0 || height <= 0) return null;

  let imageData: ImageData;
  try {
    imageData = context.getImageData(x, y, width, height);
  } catch (error) {
    log.warnOnce(`renderPixelProgram(): getImageData() failed (${(error as Error).message})`);
    return null;
  }

  applyPixelProgramToImageData(imageData, program, options);
  context.putImageData(imageData, x, y);
  return imageData;
}

/** Premultiplies an RGBA buffer in place. */
function premultiply(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    data[i] *= alpha;
    data[i + 1] *= alpha;
    data[i + 2] *= alpha;
  }
}

/** Reverses {@link premultiply}. */
function unpremultiply(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 0) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      continue;
    }
    const inverse = 255 / alpha;
    data[i] *= inverse;
    data[i + 1] *= inverse;
    data[i + 2] *= inverse;
  }
}

/** Resolves a program colour into 0..255 channels. */
function resolveProgramColor(color: PixelProgramColor | string | undefined): [number, number, number] | null {
  if (color == null) return null;
  if (typeof color === 'string') {
    const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
    if (match === null) return null;
    const value = Number.parseInt(match[1], 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  }
  return [Math.round(color.r * 255), Math.round(color.g * 255), Math.round(color.b * 255)];
}

/* -------------------------------------------------------------------------- */
/* Canvas2DShader                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A `IShader` implementation for the 2D backend.
 *
 * It never compiles real shader source. Instead it wraps a
 * {@link PixelProgram} and exposes it through the shared `IShader` contract, so a
 * material that only needs a colour transform can run on every backend.
 *
 * ```ts
 * const shader = new Canvas2DShader('grayscale');
 * shader.compile(null, 'grayscale');           // success
 * shader.compile(null, 'void main() {}');      // failure, with an explanation
 * shader.pixelProgram;                          // the bound kernel
 * ```
 */
export class Canvas2DShader implements IShader {
  /** @inheritdoc */
  public readonly id: string;

  /** @inheritdoc */
  public readonly backend: string = 'canvas2d';

  /** @inheritdoc */
  public readonly vertexSource: string | null = null;

  /** The fragment "source" is a program name, never GLSL/WGSL. */
  public readonly fragmentSource: string | null;

  /** The bound per-pixel kernel, or `null` before a successful compile. */
  public pixelProgram: PixelProgram | null = null;

  /** Options applied when the program runs. */
  public readonly programOptions: PixelProgramOptions = {};

  /** Uniforms recorded through {@link Canvas2DShader.setUniform}. */
  private readonly uniformValues = new Map<string, unknown>();

  /** `true` once {@link Canvas2DShader.compile} has succeeded. */
  private compiled: boolean = false;

  /** `true` once {@link Canvas2DShader.dispose} has run. */
  private disposed: boolean = false;

  /**
   * Creates an emulation shader.
   *
   * @param programName Name of a built-in program, or a custom one supplied
   *   through `options.programs`. Omit it to create an uncompiled shader.
   * @param options Program options and custom program registry.
   */
  constructor(
    programName?: string,
    options: PixelProgramOptions & { id?: string; programs?: Record<string, PixelProgram> } = {},
  ) {
    this.id = options.id ?? `canvas2d-shader-${createId()}`;
    const { id: _id, programs, ...programOptions } = options;
    void _id;
    this.customPrograms = programs ?? {};
    Object.assign(this.programOptions, programOptions);
    this.fragmentSource = programName ?? null;
    if (programName !== undefined) this.compile(null, programName);
  }

  /** Custom programs registered for this instance. */
  private readonly customPrograms: Record<string, PixelProgram>;

  /** Emulated attribute list (always empty; the 2D backend has no attributes). */
  private readonly attributeMembers: ShaderMember[] = [];

  /** Emulated uniform list, populated once a program is bound. */
  private readonly uniformMembers: ShaderMember[] = [];

  /**
   * "Compiles" a program.
   *
   * GLSL, WGSL and any other real shader source is **rejected**: the returned
   * result has `success: false` and a log that lists the built-in programs. A
   * recognised program name succeeds and binds {@link Canvas2DShader.pixelProgram}.
   *
   * @param vertexSource Ignored; the 2D backend has no vertex stage.
   * @param fragmentSource A built-in program name (`'grayscale'`, `'blur'`, ...)
   *   or a registered custom name.
   * @returns The compilation result.
   */
  public compile(vertexSource: string | null, fragmentSource: string): ShaderCompileResult {
    void vertexSource;

    if (this.disposed) {
      return this.failure('the shader has been disposed');
    }

    const name = fragmentSource.trim();

    if (looksLikeRealShaderSource(name)) {
      const message =
        `[canvas2d] Cannot compile '${this.summarise(name)}'. The Canvas2D backend has no ` +
        'programmable pipeline: there is no vertex or fragment stage, and GLSL/WGSL cannot be ' +
        'executed. Use a WebGL/WebGPU backend for real shader source, or select one of the ' +
        `built-in pixel programs: ${BUILT_IN_PIXEL_PROGRAM_NAMES.join(', ')}.`;
      log.warn(message);
      return this.failure(message);
    }

    const program = this.customPrograms[name] ?? BUILT_IN_PIXEL_PROGRAMS[name];
    if (program === undefined) {
      return this.failure(
        `[canvas2d] Unknown pixel program '${name}'. Available built-ins: ` +
          `${BUILT_IN_PIXEL_PROGRAM_NAMES.join(', ')}. Custom programs can be registered through ` +
          "`new Canvas2DShader(name, { programs: { myProgram } })`.",
      );
    }

    this.pixelProgram = program;
    this.compiled = true;
    this.attributeMembers.length = 0;
    this.uniformMembers.length = 0;
    for (const member of EMULATED_UNIFORM_MEMBERS) this.uniformMembers.push(member);
    return {
      success: true,
      attributes: this.attributeMembers,
      uniforms: this.uniformMembers,
      log: `[canvas2d] bound the built-in pixel program '${name}'.`,
    };
  }

  /**
   * Reports that the program is usable.
   *
   * There is nothing to bind on the 2D backend, so this only checks the program.
   *
   * @returns `true` when a pixel program is bound and the shader is not disposed.
   */
  public use(): boolean {
    return this.compiled && this.pixelProgram !== null && !this.disposed;
  }

  /**
   * Records a value the program reads.
   *
   * `amount`, `threshold`, `radius`, `color` and `strength` are mapped onto
   * {@link Canvas2DShader.programOptions}; anything else is stored and ignored.
   *
   * @param name Uniform name.
   * @param value Value to assign.
   */
  public setUniform(name: string, value: UniformValue): void {
    this.uniformValues.set(name, value);
    if (value == null) return;

    switch (name) {
      case 'amount':
        if (typeof value === 'number') this.programOptions.amount = value;
        break;
      case 'threshold':
        if (typeof value === 'number') this.programOptions.threshold = value;
        break;
      case 'radius':
        if (typeof value === 'number') this.programOptions.radius = value;
        break;
      case 'strength':
        if (typeof value === 'number') this.programOptions.strength = value;
        break;
      case 'color':
        if (typeof value === 'object') this.programOptions.color = value as PixelProgramColor;
        break;
      default:
        break;
    }
  }

  /**
   * Records several values at once.
   *
   * @param values Name → value map.
   */
  public setUniforms(values: Readonly<Record<string, UniformValue>>): void {
    for (const [name, value] of Object.entries(values)) this.setUniform(name, value);
  }

  /** @returns The uniform values recorded so far. */
  public getUniforms(): ReadonlyMap<string, unknown> {
    return this.uniformValues;
  }

  /**
   * Returns the (fictional) attribute location for a name.
   *
   * The 2D backend has no attributes, so this always reports `-1` and logs once.
   *
   * @param name Attribute name.
   * @returns `-1`.
   */
  public getAttributeLocation(name: string): number {
    log.warnOnce('[canvas2d] getAttributeLocation() is not meaningful on the Canvas2D backend (-1 returned)');
    void name;
    return -1;
  }

  /**
   * Returns the (fictional) uniform location for a name.
   *
   * @param name Uniform name.
   * @returns The name itself, so callers can use it as a stable key, or `null`
   *   for an unknown uniform.
   */
  public getUniformLocation(name: string): unknown {
    if (!this.uniformValues.has(name) && !KNOWN_UNIFORM_NAMES.includes(name)) return null;
    return name;
  }

  /**
   * Applies the bound program to an `ImageData` buffer.
   *
   * @param imageData Buffer to transform in place.
   * @returns `true` when a program ran.
   */
  public applyTo(imageData: ImageData): boolean {
    if (this.pixelProgram === null || this.disposed) return false;
    applyPixelProgramToImageData(imageData, this.pixelProgram, this.programOptions);
    return true;
  }

  /**
   * Applies the bound program to a live context region.
   *
   * @param context Context to read from and write to.
   * @param region Optional readback region.
   * @returns The transformed buffer, or `null` when nothing ran.
   */
  public applyToContext(
    context: CanvasRenderingContext2D | null,
    region: { x?: number; y?: number; width?: number; height?: number } = {},
  ): ImageData | null {
    if (this.pixelProgram === null || this.disposed) return null;
    return renderPixelProgram(context, this.pixelProgram, { ...region, ...this.programOptions });
  }

  /** @inheritdoc */
  public get attributes(): readonly ShaderMember[] {
    return this.attributeMembers;
  }

  /** @inheritdoc */
  public get uniforms(): readonly ShaderMember[] {
    return this.uniformMembers;
  }

  /** @inheritdoc */
  public get isCompiled(): boolean {
    return this.compiled;
  }

  /** @inheritdoc */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /** Releases the bound program. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.compiled = false;
    this.pixelProgram = null;
    this.uniformValues.clear();
  }

  /** @returns A human-readable description of the shader. */
  public toString(): string {
    return `Canvas2DShader(${this.id}, program=${this.fragmentSource ?? 'none'}, compiled=${this.compiled})`;
  }

  /** Builds a failed {@link ShaderCompileResult} and clears the binding. */
  private failure(message: string): ShaderCompileResult {
    this.compiled = false;
    this.pixelProgram = null;
    return { success: false, attributes: [], uniforms: [], log: message };
  }

  /** Truncates a source string for inclusion in a log message. */
  private summarise(source: string): string {
    const flat = source.replace(/\s+/g, ' ').trim();
    return flat.length <= 60 ? flat : `${flat.slice(0, 57)}...`;
  }
}

/** Uniform names the emulation shader understands. */
const KNOWN_UNIFORM_NAMES: readonly string[] = ['amount', 'threshold', 'radius', 'color', 'strength'];

/** Reflected uniform descriptions reported after a successful bind. */
const EMULATED_UNIFORM_MEMBERS: readonly ShaderMember[] = [
  { name: 'amount', type: ShaderValueType.Float },
  { name: 'threshold', type: ShaderValueType.Float },
  { name: 'radius', type: ShaderValueType.Float },
  { name: 'color', type: ShaderValueType.Vec4 },
  { name: 'strength', type: ShaderValueType.Float },
];

/**
 * Heuristically decides whether a string is real shader source.
 *
 * @param source Candidate source.
 * @returns `true` for GLSL/WGSL-looking input.
 */
export function looksLikeRealShaderSource(source: string): boolean {
  if (source.includes('\n')) return true;
  return /(#version|@(vertex|fragment|compute|group|binding|location|builtin)\b|fn\s+\w+\s*\(|void\s+main\s*\(|precision\s+\w+\s+float|vec[234]\b|mat[234]\b|gl_Position|gl_FragColor|struct\s+\w+\s*\{)/.test(
    source,
  );
}

/** Shader stages the 2D backend can emulate (none, documented for symmetry). */
export const CANVAS2D_SUPPORTED_STAGES: readonly ShaderStage[] = [];
