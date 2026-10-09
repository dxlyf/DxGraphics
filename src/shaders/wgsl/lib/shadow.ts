/**
 * WGSL shadow-caster program.
 *
 * Binding table: `0` projection, `1` model-view, `2` model, `3` normal matrix,
 * `6` UV transform, `9` alpha test, `21`/`22` displacement scale/bias, `42` flag
 * word, `50/51` alpha map, `62/63` displacement map, `80` instance-matrix storage
 * buffer.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Shadow-map casting program. */
/* wgsl */
export const shadowShader: ShaderDescriptor = {
  name: 'wgsl/shadow',
  language: 'wgsl',
  defines: { MAX_BONES: 32 },
  uniforms: {
    uProjectionMatrix: { type: 'mat4', group: 0, binding: 0 },
    uModelViewMatrix: { type: 'mat4', group: 0, binding: 1 },
    uModelMatrix: { type: 'mat4', group: 0, binding: 2 },
    uNormalMatrix: { type: 'mat3', group: 0, binding: 3 },
    uUvTransform: { type: 'mat3', group: 0, binding: 6 },
    uAlphaTest: { type: 'float', group: 0, binding: 9 },
    uDisplacementScale: { type: 'float', group: 0, binding: 21 },
    uDisplacementBias: { type: 'float', group: 0, binding: 22 },
    uFlags: { type: 'uint', group: 0, binding: 42 },
    uAlphaMap: { type: 'texture', group: 0, binding: 50 },
    uDisplacementMap: { type: 'texture', group: 0, binding: 62 },
  },
  attributes: { position: 'vec3', normal: 'vec3', uv: 'vec2' },
  entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
  vertex: `
//!include common
//!include uv

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUv: vec2<f32>,
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

  var out: VSOut;
  out.position = uProjectionMatrix * uModelViewMatrix * localPosition;
  out.vUv = transformedUv;
  return out;
}
`,
  fragment: `
//!include common

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUv: vec2<f32>,
}

@group(0) @binding(9) var<uniform> uAlphaTest: f32;
@group(0) @binding(42) var<uniform> uFlags: u32;
@group(0) @binding(50) var uAlphaMap: texture_2d<f32>;
@group(0) @binding(51) var uAlphaMapSampler: sampler;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  var alpha = 1.0;
  if (flagSet(uFlags, FLAG_USE_ALPHA_MAP)) {
    alpha = textureSample(uAlphaMap, uAlphaMapSampler, in.vUv).r;
  }
  if (flagSet(uFlags, FLAG_ALPHA_TEST) && alpha < uAlphaTest) {
    discard;
  }

  // Shadow maps only read depth, but the colour target still needs a value for
  // the backends that sample the attachment as a texture.
  let depth = in.position.z / in.position.w;
  return vec4<f32>(depth, depth, depth, alpha);
}
`,
};
