/**
 * `ShaderMaterial` — a material whose program the caller supplies.
 *
 * ```ts
 * const material = new ShaderMaterial({
 *   vertexShader,
 *   fragmentShader,
 *   uniforms: { uTime: 0, uColor: new Color(1, 0.5, 0) },
 *   defines: { USE_WAVES: true },
 *   glslVersion: '300 es',
 * });
 * ```
 *
 * The backend still injects its version header, precision block and the standard
 * attribute/uniform declarations; `RawShaderMaterial` is the variant that gets
 * none of that.
 *
 * @packageDocumentation
 */

import { Material } from './Material';
import type { MaterialParameters } from './types';

/** GLSL version the program is written against; `null` uses the backend default. */
export type GlslVersion = '100' | '300 es' | null;

/**
 * Optional WebGL extension requirements.
 *
 * The WebGPU backend ignores this bag: every feature it lists is either core
 * there or unavailable.
 */
export interface ShaderExtensions {
  /** `GL_OES_standard_derivatives` (`dFdx`/`dFdy`/`fwidth`). */
  derivatives?: boolean;
  /** `EXT_frag_depth`. */
  fragDepth?: boolean;
  /** `WEBGL_draw_buffers`. */
  drawBuffers?: boolean;
  /** `EXT_shader_texture_lod`. */
  shaderTextureLOD?: boolean;
  /** `WEBGL_clip_cull_distance`. */
  clipCullDistance?: boolean;
  /** `WEBGL_multi_draw`. */
  multiDraw?: boolean;
}

/**
 * A material with caller-provided stage sources.
 */
export class ShaderMaterial extends Material {
  /** Human-readable label used in diagnostics. */
  public override readonly label: string = 'ShaderMaterial';

  /** Registered type name. */
  public override readonly type: string = 'ShaderMaterial';

  /** Vertex-stage source. */
  public vertexShader: string = '';

  /** Fragment-stage source. */
  public fragmentShader: string = '';

  /** GLSL version the sources are written against. */
  public glslVersion: GlslVersion = null;

  /**
   * Values used for attributes the geometry does not supply.
   *
   * The browser supplies `(0, 0, 0, 1)` for a missing attribute, which is rarely
   * what a shader wants for a normal; listing it here makes the renderer emit a
   * constant instead.
   */
  public defaultAttributeValues: Record<string, number[]> = {};

  /** `true` when the shader needs the scene's lights uploaded. */
  public lights: boolean = false;

  /** `true` when the shader implements the clipping-plane uniforms. */
  public clipping: boolean = false;

  /** Optional GLSL extension requirements. */
  public extensions: ShaderExtensions = {};

  /**
   * @param parameters Optional parameter bag.
   */
  constructor(parameters?: MaterialParameters) {
    super();
    // A custom program decides for itself whether fog applies, so the default is
    // off: silently injecting fog code into user source would break it.
    this.fog = false;
    if (parameters) this.setValues(parameters);
  }

  /** `true` when both stages carry source. */
  public get isComplete(): boolean {
    return this.vertexShader.trim().length > 0 && this.fragmentShader.trim().length > 0;
  }

  /** Copies the program and its plumbing from another shader material. */
  public override copy(source: Material): this {
    super.copy(source);
    if (source instanceof ShaderMaterial) {
      this.vertexShader = source.vertexShader;
      this.fragmentShader = source.fragmentShader;
      this.glslVersion = source.glslVersion;
      this.defaultAttributeValues = { ...source.defaultAttributeValues };
      this.lights = source.lights;
      this.clipping = source.clipping;
      this.extensions = { ...source.extensions };
    }
    return this;
  }

  /** Independent copy of this material. */
  public override clone(): this {
    return new (this.constructor as new () => this)().copy(this);
  }
}
