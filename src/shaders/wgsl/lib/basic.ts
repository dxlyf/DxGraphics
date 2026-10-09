/**
 * WGSL unlit program.
 *
 * Binding table (shared by both stages, which are independent modules):
 * `0` projection, `1` model-view, `2` model, `3` normal matrix, `5` resolution,
 * `6` UV transform, `7` colour, `8` opacity, `9` alpha test, `16` env-map
 * intensity, `17` reflectivity, `18` refraction ratio, `29`-`32` fog, `42` the
 * material flag word, `48/49` diffuse map, `50/51` alpha map, `52/53`
 * ambient-occlusion map, `54/55` light map, `68/69` environment map, `80`
 * instance-matrix storage buffer. The flag bits are declared by the `common`
 * chunk.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Unlit colour/diffuse-map program. */
/* wgsl */
export const basicShader: ShaderDescriptor = {
  name: 'wgsl/basic',
  language: 'wgsl',
  defines: { MAX_DIRECTIONAL_LIGHTS: 4, MAX_BONES: 32 },
  uniforms: {
    uProjectionMatrix: { type: 'mat4', group: 0, binding: 0 },
    uModelViewMatrix: { type: 'mat4', group: 0, binding: 1 },
    uModelMatrix: { type: 'mat4', group: 0, binding: 2 },
    uNormalMatrix: { type: 'mat3', group: 0, binding: 3 },
    uResolution: { type: 'vec2', group: 0, binding: 5 },
    uUvTransform: { type: 'mat3', group: 0, binding: 6 },
    uColor: { type: 'color', group: 0, binding: 7 },
    uOpacity: { type: 'float', group: 0, binding: 8 },
    uAlphaTest: { type: 'float', group: 0, binding: 9 },
    uEnvMapIntensity: { type: 'float', group: 0, binding: 16 },
    uReflectivity: { type: 'float', group: 0, binding: 17 },
    uRefractionRatio: { type: 'float', group: 0, binding: 18 },
    uFogColor: { type: 'color', group: 0, binding: 29 },
    uFogNear: { type: 'float', group: 0, binding: 30 },
    uFogFar: { type: 'float', group: 0, binding: 31 },
    uFogDensity: { type: 'float', group: 0, binding: 32 },
    uFlags: { type: 'uint', group: 0, binding: 42 },
    uMap: { type: 'texture', group: 0, binding: 48 },
    uAlphaMap: { type: 'texture', group: 0, binding: 50 },
    uAoMap: { type: 'texture', group: 0, binding: 52 },
    uLightMap: { type: 'texture', group: 0, binding: 54 },
    uEnvMap: { type: 'texture', group: 0, binding: 68 },
  },
  attributes: { position: 'vec3', normal: 'vec3', uv: 'vec2', color: 'vec3' },
  entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
  vertex: `
//!include common
//!include uv

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vViewPosition: vec3<f32>,
  @location(1) vNormal: vec3<f32>,
  @location(2) vUv: vec2<f32>,
  @location(3) vColor: vec3<f32>,
}

@group(0) @binding(0) var<uniform> uProjectionMatrix: mat4x4<f32>;
@group(0) @binding(1) var<uniform> uModelViewMatrix: mat4x4<f32>;
@group(0) @binding(2) var<uniform> uModelMatrix: mat4x4<f32>;
@group(0) @binding(3) var<uniform> uNormalMatrix: mat3x3<f32>;
@group(0) @binding(6) var<uniform> uUvTransform: mat3x3<f32>;
@group(0) @binding(42) var<uniform> uFlags: u32;
@group(0) @binding(80) var<storage, read> uInstanceMatrices: array<mat4x4<f32>>;

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec3<f32>,
  @builtin(instance_index) instanceIndex: u32
) -> VSOut {
  var localPosition = vec4<f32>(position, 1.0);
  var modelMatrix = uModelMatrix;
  if (flagSet(uFlags, FLAG_INSTANCING)) {
    let instanceMatrix = uInstanceMatrices[instanceIndex];
    localPosition = instanceMatrix * localPosition;
    modelMatrix = uModelMatrix * instanceMatrix;
  }

  let mvPosition = uModelViewMatrix * localPosition;
  let modelBasis = mat3x3<f32>(modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz);

  var out: VSOut;
  out.position = uProjectionMatrix * mvPosition;
  out.vViewPosition = -mvPosition.xyz;
  out.vNormal = normalize(uNormalMatrix * (modelBasis * normal));
  out.vUv = select(uv, transformUv(uv, uUvTransform), flagSet(uFlags, FLAG_UV_TRANSFORM));
  out.vColor = select(vec3<f32>(1.0), color, flagSet(uFlags, FLAG_VERTEX_COLORS));
  return out;
}
`,
  fragment: `
//!include common
//!include color
//!include fog

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vViewPosition: vec3<f32>,
  @location(1) vNormal: vec3<f32>,
  @location(2) vUv: vec2<f32>,
  @location(3) vColor: vec3<f32>,
}

@group(0) @binding(7) var<uniform> uColor: vec3<f32>;
@group(0) @binding(8) var<uniform> uOpacity: f32;
@group(0) @binding(9) var<uniform> uAlphaTest: f32;
@group(0) @binding(16) var<uniform> uEnvMapIntensity: f32;
@group(0) @binding(17) var<uniform> uReflectivity: f32;
@group(0) @binding(18) var<uniform> uRefractionRatio: f32;
@group(0) @binding(29) var<uniform> uFogColor: vec3<f32>;
@group(0) @binding(30) var<uniform> uFogNear: f32;
@group(0) @binding(31) var<uniform> uFogFar: f32;
@group(0) @binding(32) var<uniform> uFogDensity: f32;
@group(0) @binding(42) var<uniform> uFlags: u32;
@group(0) @binding(48) var uMap: texture_2d<f32>;
@group(0) @binding(49) var uMapSampler: sampler;
@group(0) @binding(50) var uAlphaMap: texture_2d<f32>;
@group(0) @binding(51) var uAlphaMapSampler: sampler;
@group(0) @binding(52) var uAoMap: texture_2d<f32>;
@group(0) @binding(53) var uAoMapSampler: sampler;
@group(0) @binding(54) var uLightMap: texture_2d<f32>;
@group(0) @binding(55) var uLightMapSampler: sampler;
@group(0) @binding(68) var uEnvMap: texture_2d<f32>;
@group(0) @binding(69) var uEnvMapSampler: sampler;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  var diffuseColor = vec4<f32>(uColor, uOpacity);
  if (flagSet(uFlags, FLAG_VERTEX_COLORS)) {
    diffuseColor = vec4<f32>(diffuseColor.rgb * in.vColor, diffuseColor.a);
  }
  if (flagSet(uFlags, FLAG_USE_MAP)) {
    diffuseColor = diffuseColor * textureSample(uMap, uMapSampler, in.vUv);
  }
  if (flagSet(uFlags, FLAG_AO_MAP)) {
    diffuseColor = vec4<f32>(diffuseColor.rgb * textureSample(uAoMap, uAoMapSampler, in.vUv).r, diffuseColor.a);
  }
  if (flagSet(uFlags, FLAG_LIGHT_MAP)) {
    diffuseColor = vec4<f32>(diffuseColor.rgb + textureSample(uLightMap, uLightMapSampler, in.vUv).rgb, diffuseColor.a);
  }

  var alpha = diffuseColor.a;
  if (flagSet(uFlags, FLAG_USE_ALPHA_MAP)) {
    alpha = alpha * textureSample(uAlphaMap, uAlphaMapSampler, in.vUv).r;
  }
  if (flagSet(uFlags, FLAG_ALPHA_TEST) && alpha < uAlphaTest) {
    discard;
  }

  var outgoing = diffuseColor.rgb;
  if (flagSet(uFlags, FLAG_ENV_MAP)) {
    let viewDir = normalize(in.vViewPosition);
    let normal = normalize(in.vNormal);
    let reflectUv = reflect(-viewDir, normal).xy * 0.5 + vec2<f32>(0.5);
    let refractUv = refract(-viewDir, normal, uRefractionRatio).xy * 0.5 + vec2<f32>(0.5);
    let environment = mix(
      textureSample(uEnvMap, uEnvMapSampler, refractUv).rgb,
      textureSample(uEnvMap, uEnvMapSampler, reflectUv).rgb,
      saturate(uReflectivity)
    ) * uEnvMapIntensity;
    outgoing = mix(outgoing, environment, saturate(uReflectivity));
  }

  outgoing = applyColorSpace(outgoing, flagSet(uFlags, FLAG_LINEAR_TO_SRGB));
  if (flagSet(uFlags, FLAG_FOG)) {
    outgoing = applyFog(
      outgoing,
      length(in.vViewPosition),
      uFogColor,
      uFogNear,
      uFogFar,
      uFogDensity,
      flagSet(uFlags, FLAG_FOG_EXP2)
    );
  }

  return vec4<f32>(outgoing, alpha);
}
`,
};
