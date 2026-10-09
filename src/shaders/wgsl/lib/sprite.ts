/**
 * WGSL sprite program.
 *
 * Binding table: `0` projection, `1` model-view, `5` resolution, `6` UV
 * transform, `7` colour, `8` opacity, `9` alpha test, `23` size, `24` rotation,
 * `29`-`32` fog, `42` flag word (`FLAG_SIZE_ATTENUATION`, ...), `48/49` sprite
 * map, `50/51` alpha map, `80` instance-matrix storage buffer.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Camera-facing quad program with rotation and size attenuation. */
/* wgsl */
export const spriteShader: ShaderDescriptor = {
  name: 'wgsl/sprite',
  language: 'wgsl',
  defines: { USE_SPRITE: true },
  uniforms: {
    uProjectionMatrix: { type: 'mat4', group: 0, binding: 0 },
    uModelViewMatrix: { type: 'mat4', group: 0, binding: 1 },
    uResolution: { type: 'vec2', group: 0, binding: 5 },
    uUvTransform: { type: 'mat3', group: 0, binding: 6 },
    uColor: { type: 'color', group: 0, binding: 7 },
    uOpacity: { type: 'float', group: 0, binding: 8 },
    uAlphaTest: { type: 'float', group: 0, binding: 9 },
    uSize: { type: 'float', group: 0, binding: 23 },
    uRotation: { type: 'float', group: 0, binding: 24 },
    uFogColor: { type: 'color', group: 0, binding: 29 },
    uFogNear: { type: 'float', group: 0, binding: 30 },
    uFogFar: { type: 'float', group: 0, binding: 31 },
    uFogDensity: { type: 'float', group: 0, binding: 32 },
    uFlags: { type: 'uint', group: 0, binding: 42 },
    uMap: { type: 'texture', group: 0, binding: 48 },
    uAlphaMap: { type: 'texture', group: 0, binding: 50 },
  },
  attributes: { position: 'vec3', uv: 'vec2', color: 'vec3' },
  entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
  vertex: `
//!include common
//!include math
//!include uv

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUv: vec2<f32>,
  @location(1) vViewDepth: f32,
  @location(2) vColor: vec3<f32>,
}

@group(0) @binding(0) var<uniform> uProjectionMatrix: mat4x4<f32>;
@group(0) @binding(1) var<uniform> uModelViewMatrix: mat4x4<f32>;
@group(0) @binding(5) var<uniform> uResolution: vec2<f32>;
@group(0) @binding(6) var<uniform> uUvTransform: mat3x3<f32>;
@group(0) @binding(23) var<uniform> uSize: f32;
@group(0) @binding(24) var<uniform> uRotation: f32;
@group(0) @binding(42) var<uniform> uFlags: u32;
@group(0) @binding(80) var<storage, read> uInstanceMatrices: array<mat4x4<f32>>;

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec3<f32>,
  @builtin(instance_index) instanceIndex: u32
) -> VSOut {
  let aligned = rotate2d(position.xy, uRotation) * uSize;

  var mvPosition = uModelViewMatrix * vec4<f32>(0.0, 0.0, 0.0, 1.0);
  if (flagSet(uFlags, FLAG_INSTANCING)) {
    mvPosition = uModelViewMatrix * uInstanceMatrices[instanceIndex] * vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  var clipPosition: vec4<f32>;
  if (flagSet(uFlags, FLAG_SIZE_ATTENUATION)) {
    // Applied in view space, so the projection divides by depth and the sprite
    // shrinks with distance like world-space geometry.
    let scaled = vec4<f32>(mvPosition.xy + aligned, mvPosition.zw);
    clipPosition = uProjectionMatrix * scaled;
  } else {
    // Applied in clip space, so the sprite keeps a constant pixel size.
    let projected = uProjectionMatrix * mvPosition;
    clipPosition = projected;
    clipPosition = vec4<f32>(
      projected.xy + aligned / max(uResolution, vec2<f32>(1.0)) * 2.0 * projected.w,
      projected.zw
    );
  }

  var out: VSOut;
  out.position = clipPosition;
  out.vUv = select(uv, transformUv(uv, uUvTransform), flagSet(uFlags, FLAG_UV_TRANSFORM));
  out.vViewDepth = -mvPosition.z;
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
  @location(0) vUv: vec2<f32>,
  @location(1) vViewDepth: f32,
  @location(2) vColor: vec3<f32>,
}

@group(0) @binding(7) var<uniform> uColor: vec3<f32>;
@group(0) @binding(8) var<uniform> uOpacity: f32;
@group(0) @binding(9) var<uniform> uAlphaTest: f32;
@group(0) @binding(29) var<uniform> uFogColor: vec3<f32>;
@group(0) @binding(30) var<uniform> uFogNear: f32;
@group(0) @binding(31) var<uniform> uFogFar: f32;
@group(0) @binding(32) var<uniform> uFogDensity: f32;
@group(0) @binding(42) var<uniform> uFlags: u32;
@group(0) @binding(48) var uMap: texture_2d<f32>;
@group(0) @binding(49) var uMapSampler: sampler;
@group(0) @binding(50) var uAlphaMap: texture_2d<f32>;
@group(0) @binding(51) var uAlphaMapSampler: sampler;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  var diffuseColor = vec4<f32>(uColor, uOpacity);

  if (flagSet(uFlags, FLAG_VERTEX_COLORS)) {
    diffuseColor = vec4<f32>(diffuseColor.rgb * in.vColor, diffuseColor.a);
  }
  if (flagSet(uFlags, FLAG_USE_MAP)) {
    diffuseColor = diffuseColor * textureSample(uMap, uMapSampler, in.vUv);
  }

  var alpha = diffuseColor.a;
  if (flagSet(uFlags, FLAG_USE_ALPHA_MAP)) {
    alpha = alpha * textureSample(uAlphaMap, uAlphaMapSampler, in.vUv).r;
  }
  if (flagSet(uFlags, FLAG_ALPHA_TEST) && alpha < uAlphaTest) {
    discard;
  }

  var outgoing = applyColorSpace(diffuseColor.rgb, flagSet(uFlags, FLAG_LINEAR_TO_SRGB));
  if (flagSet(uFlags, FLAG_FOG)) {
    outgoing = applyFog(
      outgoing,
      in.vViewDepth,
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
