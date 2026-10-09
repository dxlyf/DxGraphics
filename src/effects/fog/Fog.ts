/**
 * `Fog` — distance-based colour attenuation, and the GLSL/WGSL to implement it.
 *
 * Three models, matching the three a GPU can evaluate in one instruction each:
 *
 * | Model | Factor | Character |
 * | --- | --- | --- |
 * | `linear` | `(far - d) / (far - near)` | predictable, art-directable, has a visible start |
 * | `exp` | `e^(-density * d)` | smooth, no start, never fully saturates |
 * | `exp2` | `e^(-(density * d)²)` | smooth start, hard saturation; the classic "distance haze" |
 *
 * The shading terms live in {@link FOG_LINEAR_CHUNK}, {@link FOG_EXP2_CHUNK},
 * {@link FOG_VERTEX_CHUNK} and {@link WGSL_FOG_CHUNK} as **string constants**, not `.glsl`
 * files: this package imports no shader assets, so a consumer on either backend can
 * compose the chunk it needs.
 *
 * ## Why the depth is linearised in the vertex stage
 *
 * `gl_FragCoord.z` is a non-linear hyperbolic function of distance, so applying an
 * exponential model to it directly produces fog that is wrong by an order of magnitude
 * across the frustum. `FOG_VERTEX_CHUNK` computes a *linear* view depth instead, which is
 * the quantity every model above is defined against.
 *
 * ```ts
 * const fog = new Fog({ type: 'exp2', color: 0x8899aa, density: 0.0025 });
 * fog.getFogFactor(100);       // e^(-(0.0025 * 100)^2)
 * fog.getShaderChunk('glsl');  // the fragment chunk with the right uniforms
 * fog.toJSON();
 * ```
 *
 * @packageDocumentation
 */

import { Color } from '../../math/Color';
import { Disposable } from '../../core/Disposable';
import { clamp01 } from '../../utils/MathUtils';
import { createLogger } from '../../utils/Logger';
import type { FogOptions, FogType } from '../types';

/** Logger shared by the fog model. */
const log = createLogger('effects:fog');

/**
 * Vertex-stage GLSL computing a linear view depth.
 *
 * The uniform names are `fogNear`/`fogFar` for consistency with the fragment chunks, even
 * though the vertex stage only needs the camera's near/far planes to linearise depth.
 */
export const FOG_VERTEX_CHUNK = `
uniform float fogNear;
uniform float fogFar;
varying float vFogDepth;

// Linearised view depth. Apply after the model-view transform, before projection.
float computeFogDepth(vec4 viewPosition) {
  return -viewPosition.z;
}
`;

/** Fragment-stage GLSL for linear fog. */
export const FOG_LINEAR_CHUNK = `
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
varying float vFogDepth;

vec3 applyFog(vec3 color) {
  float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  return mix(color, fogColor, fogFactor);
}
`;

/** Fragment-stage GLSL for exponential-squared fog. */
export const FOG_EXP2_CHUNK = `
uniform vec3 fogColor;
uniform float fogDensity;
varying float vFogDepth;

vec3 applyFog(vec3 color) {
  float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  return mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));
}
`;

/** Fragment-stage GLSL for plain exponential fog. */
export const FOG_EXP_CHUNK = `
uniform vec3 fogColor;
uniform float fogDensity;
varying float vFogDepth;

vec3 applyFog(vec3 color) {
  float fogFactor = 1.0 - exp(-fogDensity * vFogDepth);
  return mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));
}
`;

/** WGSL equivalent of the linear and exponential models. */
export const WGSL_FOG_CHUNK = `
struct FogUniforms {
  fogColor : vec3<f32>,
  fogNear : f32,
  fogFar : f32,
  fogDensity : f32,
  fogType : f32,
};
@group(0) @binding(3) var<uniform> fog : FogUniforms;

fn applyFog(color : vec3<f32>, viewDepth : f32) -> vec3<f32> {
  var fogFactor : f32;
  if (fog.fogType < 1.5) {
    fogFactor = smoothstep(fog.fogNear, fog.fogFar, viewDepth);
  } else if (fog.fogType < 2.5) {
    fogFactor = 1.0 - exp(-fog.fogDensity * viewDepth);
  } else {
    let scaled = fog.fogDensity * viewDepth;
    fogFactor = 1.0 - exp(-scaled * scaled);
  }
  return mix(color, fog.fogColor, clamp(fogFactor, 0.0, 1.0));
}
`;

/**
 * A fog model.
 */
export class Fog extends Disposable<'Fog'> {
  /** @inheritdoc */
  public override readonly label = 'Fog' as const;

  /** Model in use. */
  public type: FogType;

  /** Fog colour. */
  public readonly color: Color;

  /** Near distance for linear fog. */
  public near: number;

  /** Far distance for linear fog. */
  public far: number;

  /** Density for exponential fog. */
  public density: number;

  /** `false` disables the fog without removing it. */
  public enabled: boolean;

  /**
   * Creates a fog model.
   *
   * @param options Model, colour and distances.
   */
  constructor(options: FogOptions = {}) {
    super();

    this.type = options.type ?? 'linear';
    this.color = options.color === undefined ? Color.from(0xcccccc) : Color.from(options.color);
    this.near = options.near ?? 1;
    this.far = options.far ?? 1000;
    this.density = options.density ?? 0.00025;
    this.enabled = options.enabled ?? true;
  }

  /**
   * Builds a linear fog model.
   *
   * @param color Fog colour.
   * @param near Near distance.
   * @param far Far distance.
   * @returns A new fog.
   */
  public static linear(color: number | string | Color = 0xcccccc, near = 1, far = 1000): Fog {
    return new Fog({ type: 'linear', color, near, far });
  }

  /**
   * Builds an exponential-squared fog model.
   *
   * @param color Fog colour.
   * @param density Density.
   * @returns A new fog.
   */
  public static exp2(color: number | string | Color = 0xcccccc, density = 0.00025): Fog {
    return new Fog({ type: 'exp2', color, density });
  }

  /**
   * Builds an exponential fog model.
   *
   * @param color Fog colour.
   * @param density Density.
   * @returns A new fog.
   */
  public static exp(color: number | string | Color = 0xcccccc, density = 0.00025): Fog {
    return new Fog({ type: 'exp', color, density });
  }

  /* ---------------------------------------------------------------- setters */

  /**
   * Sets the fog colour.
   *
   * @param color New colour.
   * @returns This fog, for chaining.
   */
  public setColor(color: number | string | Color): this {
    this.color.set(color);
    return this;
  }

  /**
   * Sets the linear distances.
   *
   * @param near New near distance.
   * @param far New far distance.
   * @returns This fog, for chaining.
   */
  public setRange(near: number, far: number): this {
    this.near = Math.max(0, near);
    this.far = Math.max(this.near, far);
    return this;
  }

  /**
   * Sets the exponential density.
   *
   * @param density New density.
   * @returns This fog, for chaining.
   */
  public setDensity(density: number): this {
    this.density = Math.max(0, density);
    return this;
  }

  /**
   * Sets the model.
   *
   * @param type New model.
   * @returns This fog, for chaining.
   */
  public setType(type: FogType): this {
    this.type = type;
    return this;
  }

  /* --------------------------------------------------------------- factors */

  /**
   * The fog blend factor at a distance.
   *
   * `0` means "no fog" and `1` means "fully fogged", matching the mix weight the shader
   * applies.
   *
   * @param distance View depth in world units.
   * @returns The factor in `[0, 1]`.
   */
  public getFogFactor(distance: number): number {
    if (!this.enabled || this.type === 'none') return 0;
    const d = Math.max(0, distance);

    switch (this.type) {
      case 'linear': {
        const span = this.far - this.near;
        if (span <= 0) return d >= this.far ? 1 : 0;
        return clamp01((d - this.near) / span);
      }
      case 'exp': {
        return clamp01(1 - Math.exp(-this.density * d));
      }
      case 'exp2': {
        const scaled = this.density * d;
        return clamp01(1 - Math.exp(-scaled * scaled));
      }
      default:
        return 0;
    }
  }

  /**
   * Blends a colour toward the fog colour at a distance.
   *
   * @param color Source colour; mutated in place.
   * @param distance View depth in world units.
   * @returns The mutated colour.
   */
  public applyTo(color: Color, distance: number): Color {
    return color.lerp(this.color, this.getFogFactor(distance));
  }

  /**
   * The distance at which the fog factor first reaches `target`.
   *
   * @param target Target factor in `(0, 1)`.
   * @returns The distance, or `Infinity` for a model that never reaches it.
   */
  public distanceForFactor(target: number): number {
    const t = clamp01(target);
    if (t <= 0) return 0;
    if (t >= 1) return this.far;

    switch (this.type) {
      case 'linear':
        return this.near + (this.far - this.near) * t;
      case 'exp':
        return -Math.log(1 - t) / Math.max(1e-9, this.density);
      case 'exp2':
        return Math.sqrt(-Math.log(1 - t)) / Math.max(1e-9, this.density);
      default:
        return Infinity;
    }
  }

  /* ---------------------------------------------------------------- shaders */

  /**
   * The shader chunk implementing this fog model.
   *
   * The returned string always contains `fogColor` and whichever distance/density uniforms
   * the model needs, so a consumer can splice it in without checking the model.
   *
   * @param language Shading language; defaults to `'glsl'`.
   * @returns The chunk source.
   */
  public getShaderChunk(language: 'glsl' | 'wgsl' = 'glsl'): string {
    if (language === 'wgsl') return WGSL_FOG_CHUNK;

    switch (this.type) {
      case 'exp':
        return FOG_EXP_CHUNK;
      case 'exp2':
        return FOG_EXP2_CHUNK;
      case 'linear':
      case 'none':
      default:
        return FOG_LINEAR_CHUNK;
    }
  }

  /**
   * The vertex-stage chunk that produces the fog depth varying.
   *
   * @param language Shading language; only `'glsl'` has a distinct vertex chunk.
   * @returns The chunk source.
   */
  public getVertexChunk(language: 'glsl' | 'wgsl' = 'glsl'): string {
    void language;
    return FOG_VERTEX_CHUNK;
  }

  /**
   * The uniform values this fog model needs.
   *
   * @returns A name → value map ready to upload.
   */
  public getUniforms(): Record<string, number | number[]> {
    const uniforms: Record<string, number | number[]> = {
      fogColor: [this.color.r, this.color.g, this.color.b],
    };

    if (this.type === 'linear') {
      uniforms.fogNear = this.near;
      uniforms.fogFar = this.far;
    } else if (this.type === 'exp' || this.type === 'exp2') {
      uniforms.fogDensity = this.density;
    }

    return uniforms;
  }

  /**
   * The numeric model identifier the WGSL chunk switches on.
   *
   * @returns `0` none, `1` linear, `2` exp, `3` exp2.
   */
  public getModelId(): number {
    switch (this.type) {
      case 'linear':
        return 1;
      case 'exp':
        return 2;
      case 'exp2':
        return 3;
      default:
        return 0;
    }
  }

  /* ------------------------------------------------------------- copying */

  /**
   * Copies another fog's values into this one.
   *
   * @param source Fog to copy.
   * @returns This fog, for chaining.
   */
  public copy(source: Fog): this {
    this.type = source.type;
    this.color.copy(source.color);
    this.near = source.near;
    this.far = source.far;
    this.density = source.density;
    this.enabled = source.enabled;
    return this;
  }

  /**
   * @returns A deep copy of this fog.
   */
  public clone(): Fog {
    return new Fog().copy(this);
  }

  /**
   * `true` when every field matches.
   *
   * @param other Fog to compare.
   * @returns The equality flag.
   */
  public equals(other: Fog): boolean {
    return (
      this.type === other.type &&
      this.color.equals(other.color) &&
      this.near === other.near &&
      this.far === other.far &&
      this.density === other.density &&
      this.enabled === other.enabled
    );
  }

  /**
   * @returns A JSON-friendly representation.
   */
  public toJSON(): {
    type: FogType;
    color: number;
    near: number;
    far: number;
    density: number;
    enabled: boolean;
  } {
    return {
      type: this.type,
      color: this.color.getHex(),
      near: this.near,
      far: this.far,
      density: this.density,
      enabled: this.enabled,
    };
  }

  /**
   * Restores a fog from {@link Fog.toJSON} output.
   *
   * @param json Serialised fog.
   * @returns A new fog.
   */
  public static fromJSON(json: {
    type?: string;
    color?: number | string;
    near?: number;
    far?: number;
    density?: number;
    enabled?: boolean;
  }): Fog {
    return new Fog({
      type: (json.type as FogType) ?? 'linear',
      color: json.color ?? 0xcccccc,
      near: json.near ?? 1,
      far: json.far ?? 1000,
      density: json.density ?? 0.00025,
      enabled: json.enabled ?? true,
    });
  }

  /** @inheritdoc */
  protected override onDispose(): void {
    this.enabled = false;
    log.debug('fog disposed');
  }

  /**
   * @returns A human-readable description.
   */
  public override toString(): string {
    if (this.type === 'linear') {
      return `Fog(linear, color=${this.color.toHexString()}, near=${this.near}, far=${this.far})`;
    }
    return `Fog(${this.type}, color=${this.color.toHexString()}, density=${this.density})`;
  }
}

/**
 * Convenience factory mirroring `new Fog(options)`.
 *
 * @param options Model, colour and distances.
 * @returns A new fog.
 */
export function fog(options: FogOptions = {}): Fog {
  return new Fog(options);
}
