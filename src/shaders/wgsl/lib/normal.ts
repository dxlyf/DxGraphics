/**
 * WGSL debug-normal program.
 *
 * Binding table: `0` projection, `1` model-view, `2` model, `3` normal matrix,
 * `6` UV transform, `19` normal scale, `20` bump scale, `21`/`22` displacement
 * scale/bias, `42` flag word (`FLAG_FLAT_SHADING`, `FLAG_NORMAL_MAP`,
 * `FLAG_BUMP_MAP`, `FLAG_DISPLACEMENT_MAP`), `58/59` normal map, `60/61` bump
 * map, `62/63` displacement map, `80` instance-matrix storage buffer.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** View-space normal visualisation program. */
/* wgsl */
export const normalShader: ShaderDescriptor = {
  name: 'wgsl/normal',
  language: 'wgsl',
  defines: { MAX_BONES: 32 },
  uniforms: {
    uProjectionMatrix: { type: 'mat4', group: 0, binding: 0 },
    uModelViewMatrix: { type: 'mat4', group: 0, binding: 1 },
    uModelMatrix: { type: 'mat4', group: 0, binding: 2 },
    uNormalMatrix: { type: 'mat3', group: 0, binding: 3 },
    uUvTransform: { type: 'mat3', group: 0, binding: 6 },
    uNormalScale: { type: 'vec2', group: 0, binding: 19 },
    uBumpScale: { type: 'float', group: 0, binding: 20 },
    uDisplacementScale: { type: 'float', group: 0, binding: 21 },
    uDisplacementBias: { type: 'float', group: 0, binding: 22 },
    uFlags: { type: 'uint', group: 0, binding: 42 },
    uNormalMap: { type: 'texture', group: 0, binding: 58 },
    uBumpMap: { type: 'texture', group: 0, binding: 60 },
    uDisplacementMap: { type: 'texture', group: 0, binding: 62 },
  },
  attributes: { position: 'vec3', normal: 'vec3', uv: 'vec2' },
  entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
  vertex: `
//!include common
//!include uv

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vViewPosition: vec3<f32>,
  @location(1) vNormal: vec3<f32>,
  @location(2) vUv: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uProjectionMatrix: mat4x4<f32>;
@group(0) @binding(1) var<uniform> uModelViewMatrix: mat4x4<f32>;
@group(0) @binding(2) var<uniform> uModelMatrix: mat4x4<f32>;
@group(0) @binding(3) var<uniform> uNormalMatrix: mat3x3<f32>;
@group(0) @binding(6) var<uniform> uUvTransform: mat3x3<f32>;
@group(0) @binding(21) var<uniform> uDisplacementScale: f32;
@group(0) @binding(22) var<uniform> uDisplacementBias: f32;
@group(0) @binding(42) var<uniform> uFlags: u32;
@group(0) @binding(62) var uDisplacementMap: texture_2d<f32>;
@group(0) @binding(63) var uDisplacementMapSampler: sampler;
@group(0) @binding(80) var<storage, read> uInstanceMatrices: array<mat4x4<f32>>;

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @builtin(instance_index) instanceIndex: u32
) -> VSOut {
  var localPosition = vec4<f32>(position, 1.0);
  var modelMatrix = uModelMatrix;
  if (flagSet(uFlags, FLAG_INSTANCING)) {
    let instanceMatrix = uInstanceMatrices[instanceIndex];
    localPosition = instanceMatrix * localPosition;
    modelMatrix = uModelMatrix * instanceMatrix;
  }

  let modelBasis = mat3x3<f32>(modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz);
  let transformedNormal = normalize(uNormalMatrix * (modelBasis * normal));
  let transformedUv = select(uv, transformUv(uv, uUvTransform), flagSet(uFlags, FLAG_UV_TRANSFORM));

  if (flagSet(uFlags, FLAG_DISPLACEMENT_MAP)) {
    let displacement = textureSample(uDisplacementMap, uDisplacementMapSampler, transformedUv).x *
      uDisplacementScale + uDisplacementBias;
    localPosition = vec4<f32>(localPosition.xyz + transformedNormal * displacement, localPosition.w);
  }

  let mvPosition = uModelViewMatrix * localPosition;

  var out: VSOut;
  out.position = uProjectionMatrix * mvPosition;
  out.vViewPosition = -mvPosition.xyz;
  out.vNormal = transformedNormal;
  out.vUv = transformedUv;
  return out;
}
`,
  fragment: `
//!include common
//!include normal

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vViewPosition: vec3<f32>,
  @location(1) vNormal: vec3<f32>,
  @location(2) vUv: vec2<f32>,
}

@group(0) @binding(19) var<uniform> uNormalScale: vec2<f32>;
@group(0) @binding(20) var<uniform> uBumpScale: f32;
@group(0) @binding(42) var<uniform> uFlags: u32;
@group(0) @binding(58) var uNormalMap: texture_2d<f32>;
@group(0) @binding(59) var uNormalMapSampler: sampler;
@group(0) @binding(60) var uBumpMap: texture_2d<f32>;
@group(0) @binding(61) var uBumpMapSampler: sampler;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  var normal = normalize(in.vNormal);
  if (flagSet(uFlags, FLAG_FLAT_SHADING)) {
    normal = normalize(cross(dpdx(in.vViewPosition), dpdy(in.vViewPosition)));
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

  return vec4<f32>(normalize((normal + vec3<f32>(1.0)) * 0.5), 1.0);
}
`,
};
