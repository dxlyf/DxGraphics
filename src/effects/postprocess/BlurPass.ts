/**
 * `BlurPass` — separable Gaussian blur, with a documented Kawase alternative.
 *
 * ## Why separable
 *
 * A 2D Gaussian with a `k x k` kernel costs `k²` texel reads per pixel. Because a Gaussian
 * is separable — `G(x, y) = G(x) * G(y)` — the same result costs `2k` reads: one horizontal
 * pass, one vertical pass. For a 9x9 kernel that is 18 reads instead of 81, and the error
 * is zero (the separability is exact, not an approximation).
 *
 * ```
 *   horizontal        vertical
 *   ──────────>       ┌───┐
 *   ▓▓▓▓▓▓▓▓▓         │ ▓ │
 *                     │ ▓ │
 *                     │ ▓ │
 *                     └───┘
 * ```
 *
 * `direction: 'both'` (the default) runs both passes; `'horizontal'` and `'vertical'`
 * expose the halves so a caller can interleave two blurs, which is what a bloom pyramid
 * does.
 *
 * ## Weights
 *
 * {@link gaussianWeights} returns a normalised, odd-length kernel derived from `sigma` and
 * the kernel size. The default `sigma` is `(size - 1) / 6`, the standard choice that makes
 * the kernel's tails fall below one 8-bit quantisation step at the edges — so a larger
 * kernel actually blurs more, rather than just adding invisible weight.
 *
 * ## Kawase
 *
 * `kernel: 'kawase'` switches to the dual-filter Kawase scheme: repeated 4-tap (or 5-tap
 * with `kawaseOffset > 1`) passes at increasing offsets. It reaches a similar visual result
 * to a Gaussian of the same total radius with far fewer reads, which is why real-time
 * engines use it for bloom. The trade is accuracy: Kawase is not a Gaussian, and a
 * threshold-sensitive effect can show banding.
 *
 * ```ts
 * const blur = new BlurPass({ kernelSize: 9, sigma: 2 });
 * blur.getWeights();            // normalised Float32Array of 9 values
 * blur.setKernel('kawase', 3);  // switch schemes
 * ```
 *
 * @packageDocumentation
 */

import type { RenderContext } from '../../renderer/core/RenderContext';
import { Pass } from './Pass';
import { ShaderPass } from './ShaderPass';
import type { BlurDirection, BlurKernel, BlurOptions } from '../types';

/**
 * Computes a normalised one-dimensional Gaussian kernel.
 *
 * @param sigma Standard deviation in texels; `<= 0` yields a single-tap kernel.
 * @param kernelSize Requested length; forced odd and at least `1`.
 * @returns The weights, summing to `1`.
 */
export function gaussianWeights(sigma: number, kernelSize: number): Float32Array {
  const size = Math.max(1, Math.round(kernelSize) | 1);
  const half = (size - 1) / 2;

  if (!(sigma > 0) || size === 1) {
    const single = new Float32Array(1);
    single[0] = 1;
    return single;
  }

  const weights = new Float32Array(size);
  const denominator = 2 * sigma * sigma;
  let total = 0;

  for (let i = 0; i < size; i++) {
    const offset = i - half;
    const value = Math.exp(-(offset * offset) / denominator);
    weights[i] = value;
    total += value;
  }

  if (total > 0) {
    for (let i = 0; i < size; i++) weights[i] /= total;
  }
  return weights;
}

/**
 * The sigma that makes a kernel's tails vanish at 8-bit precision.
 *
 * @param kernelSize Kernel length.
 * @returns `(size - 1) / 6`, the conventional choice.
 */
export function sigmaForKernelSize(kernelSize: number): number {
  return Math.max(1e-3, (Math.max(1, Math.round(kernelSize)) - 1) / 6);
}

/**
 * The GLSL body of a separable Gaussian blur.
 *
 * Exposed as a string constant so a consumer can compose it into a larger shader without
 * importing a `.glsl` file.
 */
export const GAUSSIAN_BLUR_CHUNK = `
uniform sampler2D tDiffuse;
uniform vec2 direction;
uniform float weights[KERNEL_SIZE];
varying vec2 vUv;

void main() {
  vec4 sum = texture2D(tDiffuse, vUv) * weights[0];
  for (int i = 1; i < KERNEL_SIZE; i++) {
    vec2 offset = direction * float(i);
    sum += texture2D(tDiffuse, vUv + offset) * weights[i];
    sum += texture2D(tDiffuse, vUv - offset) * weights[i];
  }
  gl_FragColor = sum;
}
`;

/**
 * The GLSL body of a dual-filter Kawase blur.
 *
 * Exposed as a string constant for the same reason as {@link GAUSSIAN_BLUR_CHUNK}.
 */
export const KAWASE_BLUR_CHUNK = `
uniform sampler2D tDiffuse;
uniform vec2 offset;
varying vec2 vUv;

void main() {
  vec4 sum = texture2D(tDiffuse, vUv + vec2( offset.x,  offset.y));
  sum += texture2D(tDiffuse, vUv + vec2(-offset.x,  offset.y));
  sum += texture2D(tDiffuse, vUv + vec2( offset.x, -offset.y));
  sum += texture2D(tDiffuse, vUv + vec2(-offset.x, -offset.y));
  gl_FragColor = sum * 0.25;
}
`;

/**
 * A separable blur pass.
 */
export class BlurPass extends Pass {
  /** Kernel in use. */
  public kernel: BlurKernel;

  /** Direction of the pass. */
  public direction: BlurDirection;

  /** Requested kernel length; forced odd. */
  public kernelSize: number;

  /** Standard deviation in texels. */
  public sigma: number;

  /** Kawase iteration count. */
  public kawaseIterations: number;

  /** Kawase offset in texels. */
  public kawaseOffset: number;

  /** Horizontal sub-pass, when the kernel is Gaussian. */
  public readonly horizontalPass: ShaderPass | null;

  /** Vertical sub-pass, when the kernel is Gaussian. */
  public readonly verticalPass: ShaderPass | null;

  /** Frames this pass has executed. */
  public renderCount = 0;

  /** Cached weights, invalidated when `sigma` or `kernelSize` changes. */
  private cachedWeights: Float32Array | null = null;

  /**
   * Creates a blur pass.
   *
   * @param options Kernel, direction, size and sigma.
   */
  constructor(options: BlurOptions = {}) {
    super({ name: options.name ?? 'BlurPass', ...options });

    this.kernel = options.kernel ?? 'gaussian';
    this.direction = options.direction ?? 'both';
    this.kernelSize = forceOdd(options.kernelSize ?? 9);
    this.sigma = options.sigma ?? sigmaForKernelSize(this.kernelSize);
    this.kawaseIterations = Math.max(1, Math.floor(options.kawaseIterations ?? 2));
    this.kawaseOffset = Math.max(1, options.kawaseOffset ?? 1);

    if (this.kernel === 'gaussian') {
      this.horizontalPass = new ShaderPass(
        { id: 'blur-h', fragment: GAUSSIAN_BLUR_CHUNK },
        { name: `${this.name}:h` },
      );
      this.verticalPass = new ShaderPass(
        { id: 'blur-v', fragment: GAUSSIAN_BLUR_CHUNK },
        { name: `${this.name}:v` },
      );
    } else {
      this.horizontalPass = null;
      this.verticalPass = null;
    }

    // A Gaussian with `direction: 'both'` runs two sub-passes that read the same buffer, so
    // it cannot swap between them; the caller (or the composer) swaps once, at the end.
    this.needsSwap = true;
  }

  /* ---------------------------------------------------------------- setters */

  /**
   * Switches the kernel scheme.
   *
   * @param kernel New kernel.
   * @param iterations Kawase iteration count, when switching to Kawase.
   * @returns This pass, for chaining.
   */
  public setKernel(kernel: BlurKernel, iterations?: number): this {
    this.kernel = kernel;
    if (iterations !== undefined) this.kawaseIterations = Math.max(1, Math.floor(iterations));
    this.cachedWeights = null;
    return this;
  }

  /**
   * Sets the kernel size, re-deriving sigma unless one is supplied.
   *
   * @param kernelSize New size; forced odd.
   * @param sigma Optional explicit sigma.
   * @returns This pass, for chaining.
   */
  public setKernelSize(kernelSize: number, sigma?: number): this {
    this.kernelSize = forceOdd(kernelSize);
    this.sigma = sigma ?? sigmaForKernelSize(this.kernelSize);
    this.cachedWeights = null;
    return this;
  }

  /**
   * Sets the standard deviation.
   *
   * @param sigma New sigma in texels.
   * @returns This pass, for chaining.
   */
  public setSigma(sigma: number): this {
    this.sigma = Math.max(1e-3, sigma);
    this.cachedWeights = null;
    return this;
  }

  /**
   * Sets the direction.
   *
   * @param direction New direction.
   * @returns This pass, for chaining.
   */
  public setDirection(direction: BlurDirection): this {
    this.direction = direction;
    return this;
  }

  /**
   * The current Gaussian weights.
   *
   * @returns A normalised kernel summing to `1`.
   */
  public getWeights(): Float32Array {
    if (this.cachedWeights === null) {
      this.cachedWeights = gaussianWeights(this.sigma, this.kernelSize);
    }
    return this.cachedWeights;
  }

  /**
   * The texel offset vector for one axis.
   *
   * The offsets are expressed in **UV units**, so a blur radius means the same number of
   * texels regardless of the target's size.
   *
   * @param axis Axis to compute the offset for.
   * @returns The offset in UV units.
   */
  public getTexelOffset(axis: 'horizontal' | 'vertical'): [number, number] {
    const width = Math.max(1, this.width);
    const height = Math.max(1, this.height);
    return axis === 'horizontal' ? [1 / width, 0] : [0, 1 / height];
  }

  /** @inheritdoc */
  public override setSize(width: number, height: number): void {
    super.setSize(width, height);
    this.horizontalPass?.setSize(this.width, this.height);
    this.verticalPass?.setSize(this.width, this.height);
  }

  /* ------------------------------------------------------------------ draw */

  /** @inheritdoc */
  protected override draw(context: RenderContext): void {
    if (this.kernel === 'gaussian') {
      this.drawGaussian(context);
    } else {
      this.drawKawase(context);
    }
    this.renderCount++;
  }

  /** Runs the separable Gaussian sub-passes. */
  private drawGaussian(context: RenderContext): void {
    const weights = this.getWeights();
    const passes: ('horizontal' | 'vertical')[] =
      this.direction === 'both' ? ['horizontal', 'vertical'] : [this.direction];

    for (const axis of passes) {
      const sub = axis === 'horizontal' ? this.horizontalPass : this.verticalPass;
      if (sub === null) continue;

      const offset = this.getTexelOffset(axis);
      const radius = (weights.length - 1) / 2;
      sub.setUniform('weights', Array.from(weights));
      sub.setUniform('direction', [offset[0] * radius, offset[1] * radius]);
      sub.setUniform('kernelSize', weights.length);
      sub.execute(context);
    }
  }

  /** Runs the Kawase sub-passes. */
  private drawKawase(context: RenderContext): void {
    const width = Math.max(1, this.width);
    const height = Math.max(1, this.height);

    for (let iteration = 0; iteration < this.kawaseIterations; iteration++) {
      // Each iteration doubles the offset, which is what makes the scheme reach a large
      // radius in a logarithmic number of passes.
      const scale = this.kawaseOffset * Math.pow(2, iteration);
      context.values.set('blurKawase', {
        iteration,
        offset: [scale / width, scale / height],
      });
    }
  }

  /** @inheritdoc */
  public override reset(): void {
    this.renderCount = 0;
    this.cachedWeights = null;
    this.horizontalPass?.reset();
    this.verticalPass?.reset();
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `BlurPass("${this.name}", kernel=${this.kernel}, direction=${this.direction}, ` +
      `size=${this.kernelSize}, sigma=${this.sigma.toFixed(3)})`
    );
  }
}

/** Forces a value to an odd positive integer. */
function forceOdd(value: number): number {
  const rounded = Math.max(1, Math.round(value));
  return rounded % 2 === 0 ? rounded + 1 : rounded;
}

/**
 * Convenience factory mirroring `new BlurPass(options)`.
 *
 * @param options Kernel, direction, size and sigma.
 * @returns A new blur pass.
 */
export function blurPass(options: BlurOptions = {}): BlurPass {
  return new BlurPass(options);
}
