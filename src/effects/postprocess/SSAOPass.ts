/**
 * `SSAOPass` — screen-space ambient occlusion from a hemisphere kernel.
 *
 * SSAO approximates the occlusion a surface receives from nearby geometry by sampling the
 * depth (or normal-depth) buffer in a hemisphere around each fragment. Three parameters do
 * all the work:
 *
 * | Parameter | Effect |
 * | --- | --- |
 * | `kernelSize` | sample count; more is smoother, linearly more expensive |
 * | `radius` | how far the hemisphere reaches, in world units |
 * | `bias` | depth offset that stops a surface occluding itself |
 *
 * ## The kernel
 *
 * Samples are distributed in a hemisphere aligned to the surface normal, with the
 * distribution biased toward the origin (`scale = i / count`, then `scale²` interpolated)
 * so that near samples dominate. That is what makes a `kernelSize` of 16 look as good as a
 * uniform distribution of 32:
 *
 * ```
 *   uniform hemisphere            this kernel
 *        · · · ·                  ·  ·   ·    ·
 *       ·  ·  ·  ·                 ·    ·      ·
 *        · · · ·                    ·      ·
 *                                     ·
 * ```
 *
 * {@link SSAOPass.generateKernel} uses `seededRandom`, so the same seed always produces the
 * same kernel — which is what makes the output reproducible and the test able to assert it.
 *
 * ## Noise and blur
 *
 * A small random-rotation texture tiles the hemisphere per fragment, turning the
 * structured banding of a fixed kernel into high-frequency noise; a blur then removes the
 * noise. Both are generated deterministically from `seed`.
 *
 * ```ts
 * const ssao = new SSAOPass({ kernelSize: 32, radius: 0.75, seed: 7 });
 * ssao.generateKernel();          // deterministic Vec3[]
 * ssao.generateNoiseTexture();    // deterministic Float32Array
 * ```
 *
 * @packageDocumentation
 */

import { Vec3 } from '../../math/Vec3';
import { seededRandom } from '../../utils/MathUtils';
import type { RenderContext } from '../../renderer/core/RenderContext';
import { Pass } from './Pass';
import { ShaderPass } from './ShaderPass';
import type { SSAOOptions } from '../types';

/**
 * The GLSL body of the SSAO stage.
 *
 * Exposed as a string constant so a consumer can compose it into a larger shader.
 */
export const SSAO_CHUNK = `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tNoise;
uniform vec3 kernel[KERNEL_SIZE];
uniform vec2 resolution;
uniform float radius;
uniform float bias;
uniform float intensity;
uniform float minDistance;
uniform float maxDistance;
varying vec2 vUv;

void main() {
  vec4 origin = texture2D(tDiffuse, vUv);
  float originDepth = origin.a;
  vec3 originPos = vec3(vUv, originDepth);

  vec3 normal = normalize(origin.rgb * 2.0 - 1.0);
  vec3 randomVec = normalize(texture2D(tNoise, vUv * resolution / 4.0).xyz * 2.0 - 1.0);

  vec3 tangent = normalize(randomVec - normal * dot(randomVec, normal));
  vec3 bitangent = cross(normal, tangent);
  mat3 tbn = mat3(tangent, bitangent, normal);

  float occlusion = 0.0;
  for (int i = 0; i < KERNEL_SIZE; i++) {
    vec3 samplePos = originPos + tbn * kernel[i] * radius;
    vec4 offset = vec4(samplePos, 1.0);
    offset.xy = offset.xy * 2.0 - 1.0;

    vec4 projected = texture2D(tDepth, offset.xy);
    float sampleDepth = projected.a;
    float rangeCheck = smoothstep(0.0, 1.0, radius / abs(originDepth - sampleDepth));
    occlusion += (sampleDepth >= samplePos.z + bias ? 1.0 : 0.0) * rangeCheck;
  }

  occlusion = 1.0 - (occlusion / float(KERNEL_SIZE)) * intensity;
  gl_FragColor = vec4(vec3(occlusion), origin.a);
}
`;

/** The GLSL body of the SSAO blur stage. */
export const SSAO_BLUR_CHUNK = `
uniform sampler2D tDiffuse;
uniform vec2 resolution;
varying vec2 vUv;

void main() {
  vec2 texel = 1.0 / resolution;
  float sum = 0.0;
  for (int x = -2; x <= 2; x++) {
    for (int y = -2; y <= 2; y++) {
      vec2 offset = vec2(float(x), float(y)) * texel;
      sum += texture2D(tDiffuse, vUv + offset).r;
    }
  }
  gl_FragColor = vec4(vec3(sum / 25.0), 1.0);
}
`;

/**
 * A hemisphere-sampling SSAO pass.
 */
export class SSAOPass extends Pass {
  /** Hemisphere sample count. */
  public kernelSize: number;

  /** Sampling radius in world units. */
  public radius: number;

  /** Minimum sample distance. */
  public minDistance: number;

  /** Maximum sample distance. */
  public maxDistance: number;

  /** Occlusion multiplier. */
  public intensity: number;

  /** Depth bias. */
  public bias: number;

  /** Noise texture edge length. */
  public noiseSize: number;

  /** Seed for the deterministic kernel and noise. */
  public seed: number;

  /** Cached hemisphere kernel. */
  public kernel: Vec3[] = [];

  /** Cached noise texture data. */
  public noise: Float32Array | null = null;

  /** The SSAO shader pass. */
  public readonly ssaoPass: ShaderPass;

  /** The blur shader pass. */
  public readonly blurPass: ShaderPass;

  /** Frames this pass has executed. */
  public renderCount = 0;

  /**
   * Creates an SSAO pass.
   *
   * @param options Kernel size, radius, bias and seed.
   */
  constructor(options: SSAOOptions = {}) {
    super({ name: options.name ?? 'SSAOPass', ...options });

    this.kernelSize = Math.max(1, Math.floor(options.kernelSize ?? 16));
    this.radius = options.radius ?? 0.5;
    this.minDistance = options.minDistance ?? 0.005;
    this.maxDistance = options.maxDistance ?? 0.05;
    this.intensity = options.intensity ?? 1;
    this.bias = options.bias ?? 0.025;
    this.noiseSize = Math.max(2, Math.floor(options.noiseSize ?? 4));
    this.seed = options.seed ?? 1;

    this.ssaoPass = new ShaderPass(
      { id: 'ssao', fragment: SSAO_CHUNK },
      { name: `${this.name}:ssao` },
    );
    this.blurPass = new ShaderPass(
      { id: 'ssao-blur', fragment: SSAO_BLUR_CHUNK },
      { name: `${this.name}:blur` },
    );

    this.needsSwap = true;
    this.generateKernel();
    this.generateNoiseTexture();
    this.syncUniforms();
  }

  /* ---------------------------------------------------------------- kernels */

  /**
   * Generates the hemisphere kernel.
   *
   * Samples are distributed inside a hemisphere of radius `1` about `+Z`, with a squared
   * radial bias so the kernel is denser near the origin. The result depends only on
   * {@link SSAOPass.seed} and {@link SSAOPass.kernelSize}, so it is reproducible.
   *
   * @param count Optional override for the sample count.
   * @returns The kernel, as `count` unit-scale vectors.
   */
  public generateKernel(count: number = this.kernelSize): Vec3[] {
    const random = seededRandom(this.seed);
    const kernel: Vec3[] = [];

    for (let i = 0; i < count; i++) {
      const sample = new Vec3(
        random() * 2 - 1,
        random() * 2 - 1,
        // `+Z` only: a hemisphere, not a sphere.
        random(),
      );

      sample.normalize();

      // Squared interpolation from 0 to 1: `lerp(0.1, 1, (i/n)^2)`.
      const t = i / count;
      const scale = 0.1 + 0.9 * t * t;
      sample.multiplyScalar(scale);

      kernel.push(sample);
    }

    this.kernel = kernel;
    return kernel;
  }

  /**
   * Generates the tiled noise texture data.
   *
   * Four random tangent-plane vectors per texel, laid out `xy, z0` so the shader's 8-bit
   * decode (`xyz * 2 - 1`) recovers a unit vector.
   *
   * @param size Optional override for the edge length.
   * @returns `size * size * 4` floats in `[0, 1]`.
   */
  public generateNoiseTexture(size: number = this.noiseSize): Float32Array {
    // A different stream from the kernel, so changing one does not change the other.
    const random = seededRandom(this.seed * 2654435761 + 1);
    const data = new Float32Array(size * size * 4);

    for (let i = 0; i < size * size; i++) {
      // A random vector in the `xy` plane, remapped to `[0, 1]` for an 8-bit texture.
      const x = random() * 2 - 1;
      const y = random() * 2 - 1;
      const length = Math.hypot(x, y) || 1;

      data[i * 4] = (x / length) * 0.5 + 0.5;
      data[i * 4 + 1] = (y / length) * 0.5 + 0.5;
      data[i * 4 + 2] = 0.5;
      data[i * 4 + 3] = 1;
    }

    this.noise = data;
    return data;
  }

  /**
   * Changes the seed and regenerates the kernel and noise.
   *
   * @param seed New seed.
   * @returns This pass, for chaining.
   */
  public setSeed(seed: number): this {
    this.seed = seed;
    this.generateKernel();
    this.generateNoiseTexture();
    return this;
  }

  /**
   * Changes the kernel size and regenerates the kernel.
   *
   * @param kernelSize New sample count.
   * @returns This pass, for chaining.
   */
  public setKernelSize(kernelSize: number): this {
    this.kernelSize = Math.max(1, Math.floor(kernelSize));
    this.generateKernel();
    this.syncUniforms();
    return this;
  }

  /**
   * Sets the sampling radius.
   *
   * @param radius New radius in world units.
   * @returns This pass, for chaining.
   */
  public setRadius(radius: number): this {
    this.radius = Math.max(0, radius);
    this.syncUniforms();
    return this;
  }

  /** Pushes parameters into the shader pass. */
  private syncUniforms(): void {
    this.ssaoPass.setUniform('kernel', this.kernel.flatMap((v) => [v.x, v.y, v.z]));
    this.ssaoPass.setUniform('kernelSize', this.kernelSize);
    this.ssaoPass.setUniform('radius', this.radius);
    this.ssaoPass.setUniform('bias', this.bias);
    this.ssaoPass.setUniform('intensity', this.intensity);
    this.ssaoPass.setUniform('minDistance', this.minDistance);
    this.ssaoPass.setUniform('maxDistance', this.maxDistance);
    this.ssaoPass.setUniform('resolution', [this.width, this.height]);
    this.blurPass.setUniform('resolution', [this.width, this.height]);
  }

  /* ------------------------------------------------------------------ draw */

  /** @inheritdoc */
  public override setSize(width: number, height: number): void {
    super.setSize(width, height);
    this.ssaoPass.setSize(this.width, this.height);
    this.blurPass.setSize(this.width, this.height);
    this.syncUniforms();
  }

  /** @inheritdoc */
  protected override draw(context: RenderContext): void {
    this.ssaoPass.execute(context);
    this.blurPass.execute(context);
    this.renderCount++;
  }

  /** @inheritdoc */
  public override reset(): void {
    this.renderCount = 0;
    this.ssaoPass.reset();
    this.blurPass.reset();
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    return (
      `SSAOPass("${this.name}", kernel=${this.kernelSize}, radius=${this.radius}, ` +
      `bias=${this.bias}, intensity=${this.intensity}, seed=${this.seed})`
    );
  }
}

/**
 * Convenience factory mirroring `new SSAOPass(options)`.
 *
 * @param options Kernel size, radius, bias and seed.
 * @returns A new SSAO pass.
 */
export function ssaoPass(options: SSAOOptions = {}): SSAOPass {
  return new SSAOPass(options);
}
