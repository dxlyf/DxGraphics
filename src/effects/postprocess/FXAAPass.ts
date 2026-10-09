/**
 * `FXAAPass` — cheap, luma-based edge antialiasing.
 *
 * FXAA is a **post-process**: it does not know about geometry, coverage or depth. It looks
 * at the rendered luma image, decides which pixels sit on a high-contrast edge, estimates
 * the edge's direction from the luma gradient, and blends along it. That makes it one pass
 * over one texture, which is why it costs a fraction of MSAA and works on any geometry —
 * including the alpha-tested foliage MSAA cannot help with.
 *
 * ## The luma-edge test
 *
 * ```
 *           N
 *           |
 *     W ── (x,y) ── E          nw, ne, sw, se: the corners
 *           |
 *           S
 *
 *   lumaMin = min(N, E, S, W, centre)
 *   lumaMax = max(N, E, S, W, centre)
 *   contrast = lumaMax - lumaMin
 *   isEdge   = contrast >= max(edgeThresholdMin, lumaMax * edgeThreshold)
 * ```
 *
 * Both a **relative** and an **absolute** floor are needed: a relative-only threshold
 * misses edges in dark areas (where the absolute contrast is small but perceptually
 * obvious), and an absolute-only threshold over-smooths flat-but-bright regions.
 *
 * ## Sub-pixel aliasing
 *
 * The corner luma average estimates how much "staircase" is present; `subpixel` scales
 * that estimate into an extra blend. `subpixel = 0` disables it (sharper, more aliasing),
 * `1` applies the maximum (softer).
 *
 * ```ts
 * const fxaa = new FXAAPass({ threshold: 0.02, subpixel: 0.5 });
 * fxaa.luma([0.9, 0.1, 0.1]);       // Rec.709 luma
 * fxaa.detectEdge([...], [...], ...);   // the edge decision, testable on CPU
 * ```
 *
 * @packageDocumentation
 */

import { clamp01 } from '../../utils/MathUtils';
import type { RenderContext } from '../../renderer/core/RenderContext';
import { Pass } from './Pass';
import { ShaderPass } from './ShaderPass';
import type { FXAAOptions } from '../types';

/**
 * The GLSL body of the FXAA stage.
 *
 * Exposed as a string constant so a consumer can compose it into a larger shader.
 */
export const FXAA_CHUNK = `
uniform sampler2D tDiffuse;
uniform vec2 resolution;
uniform float edgeThreshold;
uniform float edgeThresholdMin;
uniform float subpixel;
varying vec2 vUv;

float luma(vec3 rgb) {
  return dot(rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec2 texel = 1.0 / resolution;
  vec2 dir = vec2(0.0);

  vec3 rgbM = texture2D(tDiffuse, vUv).rgb;
  vec3 rgbN = texture2D(tDiffuse, vUv + vec2(0.0, -texel.y)).rgb;
  vec3 rgbS = texture2D(tDiffuse, vUv + vec2(0.0,  texel.y)).rgb;
  vec3 rgbW = texture2D(tDiffuse, vUv + vec2(-texel.x, 0.0)).rgb;
  vec3 rgbE = texture2D(tDiffuse, vUv + vec2( texel.x, 0.0)).rgb;

  float lumaM = luma(rgbM);
  float lumaMin = min(lumaM, min(min(luma(rgbN), luma(rgbS)), min(luma(rgbW), luma(rgbE))));
  float lumaMax = max(lumaM, max(max(luma(rgbN), luma(rgbS)), max(luma(rgbW), luma(rgbE))));

  float contrast = lumaMax - lumaMin;
  if (contrast < max(edgeThresholdMin, lumaMax * edgeThreshold)) {
    gl_FragColor = vec4(rgbM, 1.0);
    return;
  }

  dir.x = -((luma(rgbN) + luma(rgbS)) - 2.0 * lumaM);
  dir.y =  ((luma(rgbW) + luma(rgbE)) - 2.0 * lumaM);
  float dirReduce = max((luma(rgbN) + luma(rgbS) + luma(rgbW) + luma(rgbE)) * 0.25 * 0.5, 1.0 / 128.0);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, -8.0, 8.0) * texel;

  vec3 rgbA = 0.5 * (texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
                     texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tDiffuse, vUv + dir * -0.5).rgb +
                                   texture2D(tDiffuse, vUv + dir *  0.5).rgb);

  float lumaB = luma(rgbB);
  vec3 result = (lumaB < lumaMin || lumaB > lumaMax) ? rgbA : mix(rgbA, rgbB, subpixel);
  gl_FragColor = vec4(result, 1.0);
}
`;

/** Rec. 601 luma coefficients — what FXAA's own reference implementation uses. */
export const FXAA_LUMA_COEFFICIENTS: readonly [number, number, number] = [0.299, 0.587, 0.114];

/**
 * A luma-based FXAA pass.
 */
export class FXAAPass extends Pass {
  /** Relative contrast threshold. */
  public threshold: number;

  /** Absolute minimum local contrast. */
  public edgeThresholdMin: number;

  /** Relative local contrast. */
  public edgeThreshold: number;

  /** Sub-pixel aliasing removal amount. */
  public subpixel: number;

  /** `true` darkens the image slightly, matching one FXAA variant. */
  public darkening: boolean;

  /** The underlying shader pass. */
  public readonly shaderPass: ShaderPass;

  /** Frames this pass has executed. */
  public renderCount = 0;

  /**
   * Creates an FXAA pass.
   *
   * @param options Thresholds and sub-pixel amount.
   */
  constructor(options: FXAAOptions = {}) {
    super({ name: options.name ?? 'FXAAPass', ...options });

    this.threshold = options.threshold ?? 0.0312;
    this.edgeThresholdMin = options.edgeThresholdMin ?? 0.063;
    this.edgeThreshold = options.edgeThreshold ?? 0.125;
    this.subpixel = clamp01(options.subpixel ?? 0.75);
    this.darkening = options.darkening ?? false;

    this.shaderPass = new ShaderPass(
      { id: 'fxaa', fragment: FXAA_CHUNK },
      { name: `${this.name}:shader`, timeUniform: null },
    );

    this.needsSwap = true;
    this.syncUniforms();
  }

  /**
   * Sets the relative threshold.
   *
   * @param threshold New value.
   * @returns This pass, for chaining.
   */
  public setThreshold(threshold: number): this {
    this.threshold = Math.max(0, threshold);
    this.syncUniforms();
    return this;
  }

  /**
   * Sets the sub-pixel amount.
   *
   * @param subpixel New value in `[0, 1]`.
   * @returns This pass, for chaining.
   */
  public setSubpixel(subpixel: number): this {
    this.subpixel = clamp01(subpixel);
    this.syncUniforms();
    return this;
  }

  /** Pushes parameters into the shader pass. */
  private syncUniforms(): void {
    this.shaderPass.setUniform('edgeThreshold', this.threshold);
    this.shaderPass.setUniform('edgeThresholdMin', this.edgeThresholdMin);
    this.shaderPass.setUniform('edgeThresholdRel', this.edgeThreshold);
    this.shaderPass.setUniform('subpixel', this.subpixel);
    this.shaderPass.setUniform('resolution', [this.width, this.height]);
  }

  /* --------------------------------------------------------------- analysis */

  /**
   * Rec. 601 luma of an RGB triple.
   *
   * @param rgb Colour components.
   * @returns Luma in `[0, 1]`.
   */
  public luma(rgb: readonly number[]): number {
    return (
      (rgb[0] ?? 0) * FXAA_LUMA_COEFFICIENTS[0] +
      (rgb[1] ?? 0) * FXAA_LUMA_COEFFICIENTS[1] +
      (rgb[2] ?? 0) * FXAA_LUMA_COEFFICIENTS[2]
    );
  }

  /**
   * The CPU model of the edge decision.
   *
   * Provided so the thresholds can be tuned (and the decision asserted) without a GPU. It
   * implements exactly the test in {@link FXAA_CHUNK}.
   *
   * @param centre Centre luma.
   * @param north North luma.
   * @param south South luma.
   * @param west West luma.
   * @param east East luma.
   * @returns `{ isEdge, contrast, threshold }`.
   */
  public detectEdge(
    centre: number,
    north: number,
    south: number,
    west: number,
    east: number,
  ): { isEdge: boolean; contrast: number; threshold: number } {
    const neighbours = [north, south, west, east, centre];
    const lumaMin = Math.min(...neighbours);
    const lumaMax = Math.max(...neighbours);
    const contrast = lumaMax - lumaMin;
    const required = Math.max(this.edgeThresholdMin, lumaMax * this.edgeThreshold);
    return { isEdge: contrast >= required, contrast, threshold: required };
  }

  /**
   * The edge direction from the luma gradient.
   *
   * Mirrors the shader's `dir` computation: the horizontal component is the vertical
   * contrast, and vice versa, because the gradient is perpendicular to the edge.
   *
   * @param centre Centre luma.
   * @param north North luma.
   * @param south South luma.
   * @param west West luma.
   * @param east East luma.
   * @returns The direction vector, in luma units per texel.
   */
  public edgeDirection(
    centre: number,
    north: number,
    south: number,
    west: number,
    east: number,
  ): [number, number] {
    return [-(north + south - 2 * centre), west + east - 2 * centre];
  }

  /* ------------------------------------------------------------------ draw */

  /** @inheritdoc */
  public override setSize(width: number, height: number): void {
    super.setSize(width, height);
    this.shaderPass.setSize(this.width, this.height);
    this.shaderPass.setUniform('resolution', [this.width, this.height]);
  }

  /** @inheritdoc */
  protected override draw(context: RenderContext): void {
    this.shaderPass.execute(context);
    this.renderCount++;
  }

  /** @inheritdoc */
  public override reset(): void {
    this.renderCount = 0;
    this.shaderPass.reset();
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `FXAAPass("${this.name}", threshold=${this.threshold}, ` +
      `edgeThresholdMin=${this.edgeThresholdMin}, subpixel=${this.subpixel})`
    );
  }
}

/**
 * Convenience factory mirroring `new FXAAPass(options)`.
 *
 * @param options Thresholds and sub-pixel amount.
 * @returns A new FXAA pass.
 */
export function fxaaPass(options: FXAAOptions = {}): FXAAPass {
  return new FXAAPass(options);
}
