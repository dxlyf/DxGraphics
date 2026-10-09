/**
 * WGSL Blinn-Phong program.
 *
 * Binding table: the Lambert set plus `12` specular, `13` shininess, `17`
 * reflectivity, `18` refraction ratio, `19` normal scale, `20` bump scale,
 * `58/59` normal map, `60/61` bump map, `82/83` specular map.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Blinn-Phong specular program. */
/* wgsl */
export const phongShader: ShaderDescriptor = {
  name: 'wgsl/phong',
  language: 'wgsl',
  defines: { MAX_DIRECTIONAL_LIGHTS: 4, MAX_BONES: 32 },
  uniforms: {
    uProjectionMatrix: { type: 'mat4', group: 0, binding: 0 },
    uModelViewMatrix: { type: 'mat4', group: 0, binding: 1 },
    uModelMatrix: { type: 'mat4', group: 0, binding: 2 },
    uNormalMatrix: { type: 'mat3', group: 0, binding: 3 },
    uUvTransform: { type: 'mat3', group: 0, binding: 6 },
    uColor: { type: 'color', group: 0, binding: 7 },
    uOpacity: { type: 'float', group: 0, binding: 8 },
    uAlphaTest: { type: 'float', group: 0, binding: 9 },
    uEmissive: { type: 'color', group: 0, binding: 10 },
    uEmissiveIntensity: { type: 'float', group: 0, binding: 11 },
    uSpecular: { type: 'color', group: 0, binding: 12 },
    uShininess: { type: 'float', group: 0, binding: 13 },
    uReflectivity: { type: 'float', group: 0, binding: 17 },
    uRefractionRatio: { type: 'float', group: 0, binding: 18 },
    uNormalScale: { type: 'vec2', group: 0, binding: 19 },
    uBumpScale: { type: 'float', group: 0, binding: 20 },
    uFogColor: { type: 'color', group: 0, binding: 29 },
    uFogNear: { type: 'float', group: 0, binding: 30 },
    uFogFar: { type: 'float', group: 0, binding: 31 },
    uFogDensity: { type: 'float', group: 0, binding: 32 },
    uAmbientLightColor: { type: 'color', group: 0, binding: 33 },
    uDirectionalLightCount: { type: 'int', group: 0, binding: 34 },
    uDirectionalLightDirections: { type: 'array', elementType: 'vec4', count: 4, group: 0, binding: 35 },
    uDirectionalLightColors: { type: 'array', elementType: 'vec4', count: 4, group: 0, binding: 36 },
    uFlags: { type: 'uint', group: 0, binding: 42 },
    uMap: { type: 'texture', group: 0, binding: 48 },
    uAlphaMap: { type: 'texture', group: 0, binding: 50 },
    uAoMap: { type: 'texture', group: 0, binding: 52 },
    uEmissiveMap: { type: 'texture', group: 0, binding: 56 },
    uNormalMap: { type: 'texture', group: 0, binding: 58 },
    uBumpMap: { type: 'texture', group: 0, binding: 60 },
    uEnvMap: { type: 'texture', group: 0, binding: 68 },
    uSpecularMap: { type: 'texture', group: 0, binding: 82 },
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
//!include lighting
//!include normal
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
@group(0) @binding(10) var<uniform> uEmissive: vec3<f32>;
@group(0) @binding(11) var<uniform> uEmissiveIntensity: f32;
@group(0) @binding(12) var<uniform> uSpecular: vec3<f32>;
@group(0) @binding(13) var<uniform> uShininess: f32;
@group(0) @binding(17) var<uniform> uReflectivity: f32;
@group(0) @binding(18) var<uniform> uRefractionRatio: f32;
@group(0) @binding(19) var<uniform> uNormalScale: vec2<f32>;
@group(0) @binding(20) var<uniform> uBumpScale: f32;
@group(0) @binding(29) var<uniform> uFogColor: vec3<f32>;
@group(0) @binding(30) var<uniform> uFogNear: f32;
@group(0) @binding(31) var<uniform> uFogFar: f32;
@group(0) @binding(32) var<uniform> uFogDensity: f32;
@group(0) @binding(33) var<uniform> uAmbientLightColor: vec3<f32>;
@group(0) @binding(34) var<uniform> uDirectionalLightCount: i32;
@group(0) @binding(35) var<uniform> uDirectionalLightDirections: array<vec4<f32>, 4>;
@group(0) @binding(36) var<uniform> uDirectionalLightColors: array<vec4<f32>, 4>;
@group(0) @binding(42) var<uniform> uFlags: u32;
@group(0) @binding(48) var uMap: texture_2d<f32>;
@group(0) @binding(49) var uMapSampler: sampler;
@group(0) @binding(50) var uAlphaMap: texture_2d<f32>;
@group(0) @binding(51) var uAlphaMapSampler: sampler;
@group(0) @binding(52) var uAoMap: texture_2d<f32>;
@group(0) @binding(53) var uAoMapSampler: sampler;
@group(0) @binding(56) var uEmissiveMap: texture_2d<f32>;
@group(0) @binding(57) var uEmissiveMapSampler: sampler;
@group(0) @binding(58) var uNormalMap: texture_2d<f32>;
@group(0) @binding(59) var uNormalMapSampler: sampler;
@group(0) @binding(60) var uBumpMap: texture_2d<f32>;
@group(0) @binding(61) var uBumpMapSampler: sampler;
@group(0) @binding(68) var uEnvMap: texture_2d<f32>;
@group(0) @binding(69) var uEnvMapSampler: sampler;
@group(0) @binding(82) var uSpecularMap: texture_2d<f32>;
@group(0) @binding(83) var uSpecularMapSampler: sampler;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  var diffuseColor = vec4<f32>(uColor, uOpacity);
  var specularColor = uSpecular;
  var normal = normalize(in.vNormal);
  let viewDir = normalize(in.vViewPosition);

  if (flagSet(uFlags, FLAG_VERTEX_COLORS)) {
    diffuseColor = vec4<f32>(diffuseColor.rgb * in.vColor, diffuseColor.a);
  }
  if (flagSet(uFlags, FLAG_USE_MAP)) {
    diffuseColor = diffuseColor * textureSample(uMap, uMapSampler, in.vUv);
  }
  if (flagSet(uFlags, FLAG_SPECULAR_MAP)) {
    specularColor = specularColor * textureSample(uSpecularMap, uSpecularMapSampler, in.vUv).rgb;
  }
  if (flagSet(uFlags, FLAG_NORMAL_MAP)) {
    let tangentNormal = textureSample(uNormalMap, uNormalMapSampler, in.vUv).xyz;
    normal = perturbNormal2Arb(-in.vViewPosition, normal, in.vUv, uNormalScale, tangentNormal);
  }
  if (flagSet(uFlags, FLAG_BUMP_MAP)) {
    let height = textureSample(uBumpMap, uBumpMapSampler, in.vUv).r;
    let gradient = vec2<f32>(dpdx(height), dpdy(height)) * uBumpScale;
    normal = normalize(normal - vec3<f32>(gradient, 0.0));
  }

  var alpha = diffuseColor.a;
  if (flagSet(uFlags, FLAG_USE_ALPHA_MAP)) {
    alpha = alpha * textureSample(uAlphaMap, uAlphaMapSampler, in.vUv).r;
  }
  if (flagSet(uFlags, FLAG_ALPHA_TEST) && alpha < uAlphaTest) {
    discard;
  }

  var outgoing = (diffuseColor.rgb + specularColor) * uAmbientLightColor;
  let lightCount = min(uDirectionalLightCount, 4);
  for (var i = 0; i < lightCount; i = i + 1) {
    let lightDir = normalize(uDirectionalLightDirections[i].xyz);
    outgoing += blinnPhong(
      diffuseColor.rgb,
      specularColor,
      uShininess,
      normal,
      lightDir,
      viewDir
    ) * uDirectionalLightColors[i].xyz;
  }

  var emissive = uEmissive * uEmissiveIntensity;
  if (flagSet(uFlags, FLAG_EMISSIVE_MAP)) {
    emissive = emissive * textureSample(uEmissiveMap, uEmissiveMapSampler, in.vUv).rgb;
  }
  outgoing = outgoing + emissive;

  if (flagSet(uFlags, FLAG_AO_MAP)) {
    outgoing = outgoing * textureSample(uAoMap, uAoMapSampler, in.vUv).r;
  }
  if (flagSet(uFlags, FLAG_ENV_MAP)) {
    let reflectUv = reflect(-viewDir, normal).xy * 0.5 + vec2<f32>(0.5);
    let refractUv = refract(-viewDir, normal, uRefractionRatio).xy * 0.5 + vec2<f32>(0.5);
    let environment = mix(
      textureSample(uEnvMap, uEnvMapSampler, refractUv).rgb,
      textureSample(uEnvMap, uEnvMapSampler, reflectUv).rgb,
      saturate(uReflectivity)
    );
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
