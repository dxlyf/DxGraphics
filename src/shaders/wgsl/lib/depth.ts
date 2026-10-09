/**
 * WGSL depth-only program.
 *
 * Binding table: `0` projection, `1` model-view, `2` model, `3` normal matrix,
 * `6` UV transform, `9` alpha test, `21`/`22` displacement scale/bias, `41` depth
 * packing mode, `42` flag word, `50/51` alpha map, `62/63` displacement map, `80`
 * instance-matrix storage buffer.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Depth-only program with four-channel packing. */
/* wgsl */
export const depthShader: ShaderDescriptor = {
  name: 'wgsl/depth',
  language: 'wgsl',
  defines: { MAX_BONES: 32, DEPTH_PACKING: 0 },
  uniforms: {
    uProjectionMatrix: { type: 'mat4', group: 0, binding: 0 },
    uModelViewMatrix: { type: 'mat4', group: 0, binding: 1 },
    uModelMatrix: { type: 'mat4', group: 0, binding: 2 },
    uNormalMatrix: { type: 'mat3', group: 0, binding: 3 },
    uUvTransform: { type: 'mat3', group: 0, binding: 6 },
    uAlphaTest: { type: 'float', group: 0, binding: 9 },
    uDisplacementScale: { type: 'float', group: 0, binding: 21 },
    uDisplacementBias: { type: 'float', group: 0, binding: 22 },
    uDepthPacking: { type: 'int', group: 0, binding: 41 },
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
@group(0) @binding(41) var<uniform> uDepthPacking: i32;
@group(0) @binding(42) var<uniform> uFlags: u32;
@group(0) @binding(50) var uAlphaMap: texture_2d<f32>;
@group(0) @binding(51) var uAlphaMapSampler: sampler;

/** Packs depth in the 0..1 range into four channels (RGBADepthPacking). */
fn packDepthToRGBA(depth: f32) -> vec4<f32> {
  let bitShifts = vec4<f32>(1.0, 255.0, 65025.0, 16581375.0);
  let bitMask = vec4<f32>(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  var color = fract(vec4<f32>(depth) * bitShifts);
  color = color - color.xxyz * bitMask;
  return color;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  if (flagSet(uFlags, FLAG_ALPHA_TEST)) {
    var alpha = 1.0;
    if (flagSet(uFlags, FLAG_USE_ALPHA_MAP)) {
      alpha = textureSample(uAlphaMap, uAlphaMapSampler, in.vUv).r;
    }
    if (alpha < uAlphaTest) {
      discard;
    }
  }

  let depth = in.position.z / in.position.w;

  if (uDepthPacking == 1) {
    return vec4<f32>(depth, depth, depth, 1.0);
  }
  if (uDepthPacking == 2) {
    return packDepthToRGBA(depth);
  }
  return vec4<f32>(depth, depth, depth, 1.0);
}
`,
};
