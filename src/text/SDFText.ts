/**
 * `SDFText` — signed distance field generation from an alpha bitmap.
 *
 * A signed distance field stores, at every pixel, the distance to the nearest edge of the
 * glyph — negative inside, positive outside (or the reverse, see
 * {@link SDFOptions.insideIsPositive}). Rendering from a field rather than from the
 * bitmap is what lets one atlas serve every font size: the shader thresholds the
 * interpolated distance, and the interpolation stays smooth because the stored signal is
 * linear in *space* rather than in *coverage*.
 *
 * ## The transform is exact, not approximate
 *
 * There are three ways to compute a distance field, and only one of them is right:
 *
 * | Approach | Cost | Result |
 * | --- | --- | --- |
 * | `distanceTransform` (this file) | `O(w*h)`, two passes | **exact** Euclidean |
 * | Chamfer / 3-4-5 masks | `O(w*h)`, one pass | up to ~4 % wrong |
 * | JFA / jump flooding | `O(w*h*log n)` | approximate, GPU-friendly |
 *
 * This module uses the **Felzenszwalb-Huttenlocher** squared-distance transform: a
 * separable exact EDT that computes, for each row, the lower envelope of parabolas, then
 * repeats the pass down the columns. Two linear passes give the exact Euclidean distance —
 * no kernel, no error, and fast enough to run on a whole glyph atlas at load time.
 *
 * ## Normalisation and sampling
 *
 * The result is normalised into `[-1, 1]` by {@link SDFOptions.radius}:
 *
 * ```
 * signed = (distanceOutside - distanceInside) / radius      // insideIsPositive: false
 * signed = (distanceInside  - distanceOutside) / radius     // insideIsPositive: true  (default)
 * ```
 *
 * clamped to `[-1, 1]`. Distances are measured **to the pixel centre**, and the pixel
 * itself counts as part of the shape when it is inside, so the field crosses zero roughly
 * halfway between the last inside pixel and the first outside one — which is the subpixel
 * edge position.
 *
 * Sampling then thresholds around {@link SDFOptions.cutoff} with a width controlled by
 * {@link SDFText.smoothingFor}:
 *
 * ```
 * alpha = clamp((value - cutoff) / smoothing + 0.5, 0, 1)
 * ```
 *
 * ```ts
 * const sdf = SDFText.generateSDF(alphaBitmap, 32, 32, { radius: 4 });
 * sdf.data[5 * 32 + 5];                    // a distance in [-1, 1]
 * SDFText.sample(sdf, 5.5, 5.5);           // bilinear sample
 * ```
 *
 * @packageDocumentation
 */

import { DEFAULT_SDF_RADIUS } from '../constants';
import { clamp01 } from '../utils/MathUtils';
import type { SDFOptions, SDFResult } from './types';

/** Alpha sources the generator accepts. */
export type AlphaSource = Uint8Array | Uint8ClampedArray | Uint8Array | number[] | Float32Array;

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Generates a signed distance field from an 8-bit alpha bitmap.
 *
 * @param alpha Alpha values, row-major, one byte per pixel.
 * @param width Field width in pixels.
 * @param height Field height in pixels.
 * @param options Radius, cutoff, sign convention and threshold.
 * @returns The generated field.
 * @throws RangeError When the bitmap is smaller than `width * height`.
 */
export function generateSDF(
  alpha: AlphaSource,
  width: number,
  height: number,
  options: SDFOptions = {},
): SDFResult {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));

  if (alpha.length < w * h) {
    throw new RangeError(
      `SDFText.generateSDF: the alpha bitmap holds ${alpha.length} values but a ` +
        `${w}x${h} field needs ${w * h}.`,
    );
  }

  const radius = Math.max(1e-3, options.radius ?? DEFAULT_SDF_RADIUS);
  const cutoff = options.cutoff ?? 0.5;
  const insideIsPositive = options.insideIsPositive ?? true;
  const threshold = clamp01(options.threshold ?? 0.5);
  const invert = options.invert ?? false;

  const count = w * h;

  // Two binary masks, each fed to its own exact EDT. Computing the inside and outside
  // distances separately (rather than one signed image) is what avoids the sign errors a
  // single-pass approach makes at the image border.
  const inside = new Float64Array(count);
  const outside = new Float64Array(count);

  const INFINITE = 1e20;

  for (let i = 0; i < count; i++) {
    const value = Number(alpha[i]) / 255;
    const covered = invert ? value < threshold : value >= threshold;
    // The EDT operates on a cost image: 0 means "this is the set", INFINITY means "look
    // elsewhere". Distance *to* the set is then the transform's output.
    inside[i] = covered ? 0 : INFINITE;
    outside[i] = covered ? INFINITE : 0;
  }

  const insideDistances = exactEDT(inside, w, h);
  const outsideDistances = exactEDT(outside, w, h);

  const data = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const distanceOut = Math.sqrt(outsideDistances[i]);
    const distanceIn = Math.sqrt(insideDistances[i]);
    const signed = insideIsPositive ? distanceIn - distanceOut : distanceOut - distanceIn;
    data[i] = clamp(signed / radius, -1, 1);
  }

  return {
    data,
    width: w,
    height: h,
    radius,
    cutoff,
    insideIsPositive,
  };
}

/**
 * Computes the exact squared Euclidean distance from every pixel to the nearest zero.
 *
 * Felzenszwalb & Huttenlocher's algorithm: for each column independently, compute the
 * lower envelope of the parabolas `f(q) + (q - p)^2` in linear time, then repeat the pass
 * along the other axis. The composition of the two 1D transforms is the exact 2D
 * Euclidean distance, because the squared distance separates:
 *
 * ```
 * d(p, q)^2 = (px - qx)^2 + (py - qy)^2
 * ```
 *
 * @param cost Cost image; `0` marks a source pixel, `INFINITY` marks a background pixel.
 * @param width Image width.
 * @param height Image height.
 * @returns Squared distances, one per pixel.
 */
export function exactEDT(cost: Float64Array, width: number, height: number): Float64Array {
  const size = width * height;
  const result = new Float64Array(size);
  result.set(cost);

  const maxDimension = Math.max(width, height);
  const scratchF = new Float64Array(maxDimension);
  const scratchD = new Float64Array(maxDimension);
  const scratchV = new Int32Array(maxDimension);
  const scratchZ = new Float64Array(maxDimension + 1);

  const INFINITE = 1e20;

  // ---- pass 1: down each column -----------------------------------------------
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) scratchF[y] = result[y * width + x];
    transform1D(scratchF, scratchD, scratchV, scratchZ, height, INFINITE);
    for (let y = 0; y < height; y++) result[y * width + x] = scratchD[y];
  }

  // ---- pass 2: along each row -------------------------------------------------
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) scratchF[x] = result[rowOffset + x];
    transform1D(scratchF, scratchD, scratchV, scratchZ, width, INFINITE);
    for (let x = 0; x < width; x++) result[rowOffset + x] = scratchD[x];
  }

  return result;
}

/**
 * One-dimensional lower-envelope transform.
 *
 * @param f Input samples; `f[q]` is the parabola's apex height.
 * @param d Output samples.
 * @param v Scratch: indexes of the envelope's parabolas.
 * @param z Scratch: boundaries between consecutive parabolas.
 * @param n Number of samples.
 * @param infinite Value treated as "no source in this line".
 */
function transform1D(
  f: Float64Array,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
  n: number,
  infinite: number,
): void {
  if (n <= 0) return;

  let k = 0;
  v[0] = 0;
  z[0] = -infinite;

  // Build the envelope. Each iteration either extends the last parabola or pops it.
  for (let q = 1; q < n; q++) {
    let s = intersection(f, q, v[k]);
    while (s <= z[k]) {
      k--;
      if (k < 0) break;
      s = intersection(f, q, v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
  }

  // Evaluate the envelope at every position.
  k = 0;
  for (let q = 0; q < n; q++) {
    while (k < v.length - 1 && z[k + 1] < q) k++;
    const delta = q - v[k];
    d[q] = delta * delta + f[v[k]];
  }
}

/**
 * The x coordinate where the parabola from `q` overtakes the one from `v[k]`.
 *
 * @param f Sample heights.
 * @param q New parabola index.
 * @param vk Existing parabola index.
 * @returns The intersection coordinate.
 */
function intersection(f: Float64Array, q: number, vk: number): number {
  return (f[q] + q * q - (f[vk] + vk * vk)) / (2 * q - 2 * vk);
}

/* -------------------------------------------------------------------------- */
/* Sampling and conversion                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Bilinearly samples a field.
 *
 * Coordinates are in pixel centres: sample `i, j` sits at `(i + 0.5, j + 0.5)`, which is
 * the convention the generator uses when it assigns distances.
 *
 * @param sdf Field to sample.
 * @param x X coordinate in pixels.
 * @param y Y coordinate in pixels.
 * @returns The interpolated value, clamped to the field's edge.
 */
export function sample(sdf: SDFResult, x: number, y: number): number {
  const { data, width, height } = sdf;

  const fx = clamp(x - 0.5, 0, width - 1);
  const fy = clamp(y - 0.5, 0, height - 1);

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);

  const tx = fx - x0;
  const ty = fy - y0;

  const v00 = data[y0 * width + x0];
  const v10 = data[y0 * width + x1];
  const v01 = data[y1 * width + x0];
  const v11 = data[y1 * width + x1];

  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * ty;
}

/**
 * Converts a field sample into an alpha value.
 *
 * @param value Field value in `[-1, 1]`.
 * @param cutoff Iso-value; defaults to `0.5`.
 * @param smoothing Transition width in normalised units; defaults to `1`.
 * @returns Alpha in `[0, 1]`.
 */
export function sampleAlpha(value: number, cutoff = 0.5, smoothing = 1): number {
  const width = Math.max(1e-6, smoothing);
  return clamp01((value - cutoff) / width + 0.5);
}

/**
 * A sensible smoothing width for a given radius.
 *
 * A larger spread means the field changes more slowly, so the anti-aliasing transition can
 * be narrower in normalised units. `1 / radius` keeps roughly one pixel of transition
 * regardless of the spread, which is what a bitmap-derived field should reproduce.
 *
 * @param radius Spread used to generate the field.
 * @returns The smoothing width to pass to {@link sampleAlpha}.
 */
export function smoothingFor(radius: number): number {
  return 2 / Math.max(1, radius);
}

/**
 * Scales a field into 8-bit texture data.
 *
 * The mapping is `(value + 1) * 0.5 * 255`, so `-1` becomes `0`, `1` becomes `255` and the
 * zero crossing stays at `128`. That is the encoding a single-channel SDF texture wants;
 * shaders decode it with `value * 2 - 1`.
 *
 * @param sdf Field to encode.
 * @returns One byte per sample.
 */
export function toUint8(sdf: SDFResult): Uint8Array {
  const out = new Uint8Array(sdf.data.length);
  for (let i = 0; i < sdf.data.length; i++) {
    out[i] = Math.round(clamp01((sdf.data[i] + 1) * 0.5) * 255);
  }
  return out;
}

/**
 * Encodes a field as RGBA bytes, replicating the value into one channel.
 *
 * @param sdf Field to encode.
 * @param channel Channel to write; defaults to the alpha channel (`3`), which is what an
 *   alpha-only glyph atlas conventionally uses.
 * @returns Four bytes per sample.
 */
export function toRGBA(sdf: SDFResult, channel: 0 | 1 | 2 | 3 = 3): Uint8ClampedArray {
  const out = new Uint8ClampedArray(sdf.data.length * 4);
  for (let i = 0; i < sdf.data.length; i++) {
    const byte = Math.round(clamp01((sdf.data[i] + 1) * 0.5) * 255);
    const offset = i * 4;
    out[offset] = channel === 0 ? byte : 0;
    out[offset + 1] = channel === 1 ? byte : 0;
    out[offset + 2] = channel === 2 ? byte : 0;
    out[offset + 3] = channel === 3 ? byte : 255;
    if (channel !== 3) out[offset + 3] = 255;
  }
  return out;
}

/**
 * Generates a field and immediately encodes it as texture bytes.
 *
 * @param alpha Alpha values, row-major.
 * @param width Field width.
 * @param height Field height.
 * @param options Generation options.
 * @returns The field plus its 8-bit encoding.
 */
export function generateGlyphSDF(
  alpha: AlphaSource,
  width: number,
  height: number,
  options: SDFOptions = {},
): { sdf: SDFResult; bytes: Uint8Array } {
  const sdf = generateSDF(alpha, width, height, options);
  return { sdf, bytes: toUint8(sdf) };
}

/**
 * The `SDFText` namespace, mirroring the module's exports as a single object.
 *
 * Provided so a caller can write `SDFText.generateSDF(...)` as the API documentation
 * describes without a namespace import.
 */
export const SDFText = {
  /** Generates a field from an alpha bitmap. */
  generateSDF,
  /** Generates a field and its 8-bit encoding. */
  generateGlyphSDF,
  /** The exact two-pass Euclidean distance transform. */
  exactEDT,
  /** Bilinear field sampling. */
  sample,
  /** Thresholds a field value into an alpha. */
  sampleAlpha,
  /** A sensible smoothing width for a radius. */
  smoothingFor,
  /** Encodes a field as 8-bit bytes. */
  toUint8,
  /** Encodes a field as RGBA bytes. */
  toRGBA,
} as const;

/** Clamps a value into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
