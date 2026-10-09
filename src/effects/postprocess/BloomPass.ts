/**
 * `BloomPass` — threshold, blur and combine.
 *
 * Bloom is what makes a bright emissive surface read as a light source rather than a
 * bright patch of paint. Three stages, in this order:
 *
 * ```
 *   1. THRESHOLD          2. BLUR              3. COMBINE
 *   ┌──────────┐          ┌──────────┐         ┌──────────────────┐
 *   │ lit      │  keep    │ soft     │  add    │ lit              │
 *   │ scene ───┼─> bright ┼─> halo ──┼────────>│ scene + halo     │
 *   └──────────┘  pixels  └──────────┘  scaled └──────────────────┘
 * ```
 *
 * ## Threshold with a knee
 *
 * A hard threshold (`luma > t`) produces a visible rim on every gradient that crosses it.
 * The **soft knee** fixes that by ramping the contribution in over `[t - knee, t + knee]`:
 *
 * ```
 *                   contribution
 *                        ^
 *                      1 |            ┌────────────
 *                        |          /
 *                        |        /     <- the knee
 *                      0 |______/________________>  luma
 *                        t-knee   t   t+knee
 * ```
 *
 * The exact curve used is the standard one:
 *
 * ```
 * contribution = clamp(luma - threshold + knee, 0, 2 * knee)
 * contribution = contribution * contribution / (4 * knee + epsilon)
 * contribution = max(contribution, luma - threshold) / max(luma, epsilon)
 * ```
 *
 * with `knee = 0` degenerating to a hard `luma > threshold` cut. This is the formulation
 * Unity and Unreal both document, chosen because it is `C¹` continuous at `t ± knee` —
 * which is what actually removes the rim.
 *
 * ## Resolution
 *
 * `resolutionScale` (default `0.5`) sizes the blur targets. Half resolution is the standard
 * choice: a halo is a low-frequency signal, so blurring it at full resolution costs four
 * times the fill rate for no visible improvement.
 *
 * ```ts
 * const bloom = new BloomPass({ threshold: 0.8, knee: 0.15, strength: 1.2, iterations: 6 });
 * bloom.getThresholdCurve();     // named constants for a custom shader
 * bloom.getContribution(1.0);    // the threshold response at a given luma
 * ```
 *
 * @packageDocumentation
 */

import { clamp, clamp01 } from '../../utils/MathUtils';
import type { RenderContext } from '../../renderer/core/RenderContext';
import { BlurPass } from './BlurPass';
import { Pass } from './Pass';
import { ShaderPass } from './ShaderPass';
import type { BloomOptions } from '../types';

/**
 * The GLSL body of the soft-knee threshold stage.
 *
 * Exposed as a string constant so a consumer can compose it into its own shader.
 */
export const BLOOM_THRESHOLD_CHUNK = `
uniform sampler2D tDiffuse;
uniform float threshold;
uniform float knee;
uniform float strength;
varying vec2 vUv;

void main() {
  vec4 texel = texture2D(tDiffuse, vUv);
  float luma = dot(texel.rgb, vec3(0.2126, 0.7152, 0.0722));
  float contribution = clamp(luma - threshold + knee, 0.0, 2.0 * knee);
  contribution = contribution * contribution / (4.0 * knee + 0.00001);
  contribution = max(contribution, luma - threshold) / max(luma, 0.00001);
  gl_FragColor = vec4(texel.rgb * contribution * strength, texel.a);
}
`;

/**
 * The GLSL body of the additive combine stage.
 *
 * Exposed as a string constant for the same reason as {@link BLOOM_THRESHOLD_CHUNK}.
 */
export const BLOOM_COMBINE_CHUNK = `
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float strength;
varying vec2 vUv;

void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  vec4 bloom = texture2D(tBloom, vUv);
  gl_FragColor = vec4(base.rgb + bloom.rgb * strength, base.a);
}
`;

/** The luminance coefficients the threshold stage uses (Rec. 709). */
export const LUMA_COEFFICIENTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/**
 * A threshold/blur/combine bloom pass.
 */
export class BloomPass extends Pass {
  /** Multiplier applied to the blurred result. */
  public strength: number;

  /** Blur radius in texels. */
  public radius: number;

  /** Luminance above which a pixel contributes. */
  public threshold: number;

  /** Soft-knee half-width. */
  public knee: number;

  /** Blur iterations. */
  public iterations: number;

  /** Threshold sub-pass. */
  public readonly thresholdPass: ShaderPass;

  /** Combine sub-pass. */
  public readonly combinePass: ShaderPass;

  /** Blur sub-pass. */
  public readonly blurPass: BlurPass;

  /** Frames this pass has executed. */
  public renderCount = 0;

  /**
   * Creates a bloom pass.
   *
   * @param options Threshold, knee, strength and resolution configuration.
   */
  constructor(options: BloomOptions = {}) {
    super({
      name: options.name ?? 'BloomPass',
      resolutionScale: options.resolutionScale ?? 0.5,
      ...options,
    });

    this.strength = options.strength ?? 1;
    this.radius = options.radius ?? 1;
    this.threshold = options.threshold ?? 0.85;
    this.knee = Math.max(0, options.knee ?? 0.1);
    this.iterations = Math.max(1, Math.floor(options.iterations ?? 5));

    this.thresholdPass = new ShaderPass(
      { id: 'bloom-threshold', fragment: BLOOM_THRESHOLD_CHUNK },
      { name: `${this.name}:threshold` },
    );
    this.blurPass = new BlurPass({
      name: `${this.name}:blur`,
      kernelSize: 9,
      sigma: Math.max(0.5, this.radius * 2),
    });
    this.combinePass = new ShaderPass(
      { id: 'bloom-combine', fragment: BLOOM_COMBINE_CHUNK },
      { name: `${this.name}:combine` },
    );

    // Reads the lit scene, writes the composited result.
    this.needsSwap = true;
    this.syncUniforms();
  }

  /* ---------------------------------------------------------------- setters */

  /**
   * Sets the strength.
   *
   * @param strength New multiplier.
   * @returns This pass, for chaining.
   */
  public setStrength(strength: number): this {
    this.strength = Math.max(0, strength);
    this.syncUniforms();
    return this;
  }

  /**
   * Sets the luminance threshold and the knee width.
   *
   * @param threshold New threshold.
   * @param knee New knee half-width.
   * @returns This pass, for chaining.
   */
  public setThreshold(threshold: number, knee: number = this.knee): this {
    this.threshold = clamp01(threshold);
    this.knee = Math.max(0, knee);
    this.syncUniforms();
    return this;
  }

  /**
   * Sets the blur radius.
   *
   * @param radius New radius in texels.
   * @returns This pass, for chaining.
   */
  public setRadius(radius: number): this {
    this.radius = Math.max(0, radius);
    this.blurPass.setSigma(Math.max(0.5, this.radius * 2));
    return this;
  }

  /**
   * Sets the blur iteration count.
   *
   * @param iterations New count; clamped to at least `1`.
   * @returns This pass, for chaining.
   */
  public setIterations(iterations: number): this {
    this.iterations = Math.max(1, Math.floor(iterations));
    return this;
  }

  /** Pushes the current parameters into the sub-passes. */
  private syncUniforms(): void {
    this.thresholdPass.setUniform('threshold', this.threshold);
    this.thresholdPass.setUniform('knee', this.knee);
    this.thresholdPass.setUniform('strength', 1);
    this.combinePass.setUniform('strength', this.strength);
  }

  /* --------------------------------------------------------------- analysis */

  /**
   * The threshold response for a given luminance.
   *
   * Exposed so a caller can plot the curve, or reproduce it in a custom shader without
   * reverse-engineering the constants.
   *
   * @param luma Luminance in `[0, 1]`-ish.
   * @returns The contribution multiplier in `[0, 1]`.
   */
  public getContribution(luma: number): number {
    const { threshold, knee } = this;

    if (knee <= 0) return luma > threshold ? 1 : 0;

    let contribution = clamp(luma - threshold + knee, 0, 2 * knee);
    contribution = (contribution * contribution) / (4 * knee + 1e-5);
    contribution = Math.max(contribution, luma - threshold) / Math.max(luma, 1e-5);
    return clamp01(contribution);
  }

  /**
   * The named constants the threshold stage uses.
   *
   * @returns The uniform names, luma coefficients and the interpolation mode.
   */
  public getThresholdCurve(): {
    coefficients: readonly [number, number, number];
    uniforms: { threshold: string; knee: string; strength: string };
    kneeMode: 'soft' | 'hard';
  } {
    return {
      coefficients: LUMA_COEFFICIENTS,
      uniforms: { threshold: 'threshold', knee: 'knee', strength: 'strength' },
      kneeMode: this.knee > 0 ? 'soft' : 'hard',
    };
  }

  /**
   * The blur target's size at the active resolution scale.
   *
   * @returns Width and height in device pixels.
   */
  public getBlurSize(): { width: number; height: number } {
    return {
      width: Math.max(1, Math.floor(this.width * this.resolutionScale)),
      height: Math.max(1, Math.floor(this.height * this.resolutionScale)),
    };
  }

  /* ------------------------------------------------------------------ draw */

  /** @inheritdoc */
  public override setSize(width: number, height: number): void {
    super.setSize(width, height);
    const blur = this.getBlurSize();
    this.thresholdPass.setSize(blur.width, blur.height);
    this.blurPass.setSize(blur.width, blur.height);
    this.combinePass.setSize(this.width, this.height);
  }

  /** @inheritdoc */
  protected override draw(context: RenderContext): void {
    // 1. threshold
    this.thresholdPass.execute(context);

    // 2. blur, `iterations` times. Repeated blurring is what turns a small kernel into a
    // wide halo without paying for a wide kernel: the variances add.
    for (let i = 0; i < this.iterations; i++) {
      this.blurPass.execute(context);
    }

    // 3. combine
    this.combinePass.execute(context);
    this.renderCount++;
  }

  /** @inheritdoc */
  public override reset(): void {
    this.renderCount = 0;
    this.thresholdPass.reset();
    this.blurPass.reset();
    this.combinePass.reset();
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `BloomPass("${this.name}", threshold=${this.threshold}, knee=${this.knee}, ` +
      `strength=${this.strength}, iterations=${this.iterations}, ` +
      `blurScale=${this.resolutionScale})`
    );
  }
}

/**
 * Convenience factory mirroring `new BloomPass(options)`.
 *
 * @param options Threshold, knee, strength and resolution configuration.
 * @returns A new bloom pass.
 */
export function bloomPass(options: BloomOptions = {}): BloomPass {
  return new BloomPass(options);
}
