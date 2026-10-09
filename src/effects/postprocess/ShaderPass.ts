/**
 * `ShaderPass` — a pass driven by a full-screen shader.
 *
 * This is the workhorse of any post-processing chain: a fragment shader that reads the
 * previous pass's output and writes the next one. Nothing here imports a shader module —
 * the descriptor is a plain record — so the same pass works for GLSL and WGSL backends and
 * can be unit-tested with no renderer at all.
 *
 * ```
 *   readBuffer.texture ──> tDiffuse uniform ──> fragment shader ──> writeBuffer
 * ```
 *
 * ## Uniform handling
 *
 * `setUniform`/`getUniform` are the API; the map is uploaded through
 * `RendererLike.applyUniforms` when the renderer provides it, and recorded in
 * `context.values` when it does not. That makes the uniform state assertable in a test
 * without a GPU.
 *
 * ## Inputs
 *
 * Every `ShaderPass` automatically exposes the previous pass's colour attachment as
 * `tDiffuse`, and the framebuffer size as `resolution`. Both are refreshed on every
 * `setSize`, so a shader that samples `tDiffuse` needs no configuration.
 *
 * ```ts
 * const pass = new ShaderPass({
 *   fragment: `uniform sampler2D tDiffuse; uniform float amount;
 *              varying vec2 vUv;
 *              void main() { gl_FragColor = texture2D(tDiffuse, vUv) * amount; }`,
 *   uniforms: { amount: 0.5 },
 * });
 * pass.setUniform('amount', 1.5);
 * ```
 *
 * @packageDocumentation
 */

import type { RenderContext } from '../../renderer/core/RenderContext';
import { Pass } from './Pass';
import type { PostProcessOptions, ShaderDescriptorLike, UniformMap, UniformValue } from '../types';

/** Options accepted by {@link ShaderPass}. */
export interface ShaderPassOptions extends PostProcessOptions {
  /** Uniform values applied over the descriptor's own. */
  uniforms?: UniformMap;
  /** `true` samples the previous pass into `tDiffuse`. */
  useReadBuffer?: boolean;
  /** Time uniform name, refreshed every frame; `null` disables it. */
  timeUniform?: string | null;
}

/**
 * A full-screen shader pass.
 */
export class ShaderPass extends Pass {
  /** The shader descriptor. */
  public shader: ShaderDescriptorLike;

  /** Live uniform values. */
  public readonly uniforms: Map<string, UniformValue> = new Map();

  /** `true` binds the previous pass's colour attachment to `tDiffuse`. */
  public useReadBuffer: boolean;

  /** Name of the time uniform, or `null`. */
  public timeUniform: string | null;

  /** Compiled shader handle, when a renderer produced one. */
  public shaderHandle: unknown = null;

  /** Frames this pass has executed. */
  public renderCount = 0;

  /**
   * Creates a shader pass.
   *
   * @param shader Shader descriptor.
   * @param options Uniform overrides and time-uniform configuration.
   */
  constructor(shader: ShaderDescriptorLike, options: ShaderPassOptions = {}) {
    super({ name: options.name ?? shader.id ?? 'ShaderPass', ...options });

    this.shader = shader;
    this.useReadBuffer = options.useReadBuffer ?? true;
    this.timeUniform = options.timeUniform ?? null;

    for (const [name, value] of Object.entries(shader.uniforms ?? {})) {
      this.uniforms.set(name, value);
    }
    for (const [name, value] of Object.entries(options.uniforms ?? {})) {
      this.uniforms.set(name, value);
    }

    // Reads `tDiffuse`, writes the other buffer.
    this.needsSwap = true;
  }

  /* ---------------------------------------------------------------- uniforms */

  /**
   * Sets a uniform.
   *
   * @param name Uniform name.
   * @param value New value.
   * @returns This pass, for chaining.
   */
  public setUniform(name: string, value: UniformValue): this {
    this.uniforms.set(name, value);
    return this;
  }

  /**
   * Replaces every uniform.
   *
   * @param uniforms New uniform map.
   * @returns This pass, for chaining.
   */
  public setUniforms(uniforms: UniformMap): this {
    this.uniforms.clear();
    for (const [name, value] of Object.entries(uniforms)) this.uniforms.set(name, value);
    return this;
  }

  /**
   * Reads a uniform.
   *
   * @param name Uniform name.
   * @returns The value, or `undefined`.
   */
  public getUniform(name: string): UniformValue {
    return this.uniforms.get(name);
  }

  /**
   * `true` when a uniform is set.
   *
   * @param name Uniform name.
   * @returns The presence flag.
   */
  public hasUniform(name: string): boolean {
    return this.uniforms.has(name);
  }

  /**
   * Replaces the shader, keeping existing uniforms.
   *
   * @param shader New descriptor.
   * @param keepUniforms `true` (the default) keeps the current uniform values.
   * @returns This pass, for chaining.
   */
  public setShader(shader: ShaderDescriptorLike, keepUniforms = true): this {
    this.shader = shader;
    if (!keepUniforms) {
      this.uniforms.clear();
      for (const [name, value] of Object.entries(shader.uniforms ?? {})) {
        this.uniforms.set(name, value);
      }
    }
    // A different shader needs a different compiled program.
    this.shaderHandle = null;
    this.initialised = false;
    return this;
  }

  /**
   * Merges defines into the shader.
   *
   * @param defines Defines to merge.
   * @returns This pass, for chaining.
   */
  public setDefines(defines: Record<string, string | number | boolean>): this {
    this.shader = { ...this.shader, defines: { ...(this.shader.defines ?? {}), ...defines } };
    this.shaderHandle = null;
    this.initialised = false;
    return this;
  }

  /**
   * The uniform map as a plain record, for a renderer or a test.
   *
   * @returns A snapshot of the uniforms plus the automatic inputs.
   */
  public getUniformMap(): UniformMap {
    const map: UniformMap = {};
    for (const [name, value] of this.uniforms) map[name] = value;
    if (this.useReadBuffer) map.tDiffuse = map.tDiffuse ?? null;
    map.resolution = [this.width, this.height];
    return map;
  }

  /* --------------------------------------------------------------- lifecycle */

  /**
   * Compiles the shader when the renderer supports it.
   *
   * @param context Per-frame render context.
   */
  public override onAttach(context: RenderContext): void {
    super.onAttach(context);
    const renderer = context.renderer as unknown as {
      createShader?(descriptor: ShaderDescriptorLike): unknown;
    } | null;
    if (renderer !== null && renderer !== undefined && typeof renderer.createShader === 'function') {
      try {
        this.shaderHandle = renderer.createShader(this.shader);
      } catch {
        this.shaderHandle = null;
      }
    }
  }

  /** @inheritdoc */
  public override onDetach(): void {
    this.shaderHandle = null;
    super.onDetach();
  }

  /** @inheritdoc */
  protected override draw(context: RenderContext): void {
    const renderer = context.renderer as unknown as {
      applyUniforms?(shader: unknown, uniforms: UniformMap): void;
      drawFullscreenQuad?(): void;
    } | null;

    const map = this.getUniformMap();

    if (this.timeUniform !== null) map[this.timeUniform] = context.time;

    if (renderer !== null && renderer !== undefined && typeof renderer.applyUniforms === 'function') {
      renderer.applyUniforms(this.shaderHandle, map);
      renderer.drawFullscreenQuad?.();
      this.renderCount++;
      return;
    }

    // Headless: publish the shader state so a test can assert it.
    context.values.set('shaderPass', {
      id: this.id,
      name: this.name,
      shader: this.shader,
      uniforms: map,
      useReadBuffer: this.useReadBuffer,
    });
    this.renderCount++;
  }

  /** @inheritdoc */
  public override reset(): void {
    this.renderCount = 0;
    if (this.timeUniform !== null) this.uniforms.set(this.timeUniform, 0);
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    super.onDispose();
    const renderer = this.shaderHandle as { dispose?(): void } | null;
    renderer?.dispose?.();
    this.shaderHandle = null;
    this.uniforms.clear();
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    const language = this.shader.language ?? 'glsl';
    return (
      `ShaderPass("${this.name}", language=${language}, uniforms=${this.uniforms.size}, ` +
      `renders=${this.renderCount})`
    );
  }
}
