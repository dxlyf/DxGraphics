/**
 * WGSL point-sprite program.
 *
 * Binding table: `0` projection, `1` model-view, `5` resolution, `7` colour,
 * `8` opacity, `9` alpha test, `23` point size, `29`-`32` fog, `42` flag word
 * (`FLAG_SIZE_ATTENUATION`, `FLAG_USE_MAP`, ...), `48/49` sprite map, `50/51`
 * alpha map.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Screen-space point program with optional size attenuation. */
/* wgsl */
export const pointsShader: ShaderDescriptor = {
  name: 'wgsl/points',
  language: 'wgsl',
  defines: { USE_POINTS: true },
  uniforms: {
    uProjectionMatrix: { type: 'mat4', group: 0, binding: 0 },
    uModelViewMatrix: { type: 'mat4', group: 0, binding: 1 },
    uResolution: { type: 'vec2', group: 0, binding: 5 },
    uColor: { type: 'color', group: 0, binding: 7 },
    uOpacity: { type: 'float', group: 0, binding: 8 },
    uAlphaTest: { type: 'float', group: 0, binding: 9 },
    uSize: { type: 'float', group: 0, binding: 23 },
    uFogColor: { type: 'color', group: 0, binding: 29 },
    uFogNear: { type: 'float', group: 0, binding: 30 },
    uFogFar: { type: 'float', group: 0, binding: 31 },
    uFogDensity: { type: 'float', group: 0, binding: 32 },
    uFlags: { type: 'uint', group: 0, binding: 42 },
    uMap: { type: 'texture', group: 0, binding: 48 },
    uAlphaMap: { type: 'texture', group: 0, binding: 50 },
  },
  attributes: { position: 'vec3', color: 'vec3' },
  entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
  vertex: `
//!include common
//!include points

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @builtin(point_size) pointSize: f32,
  @location(0) vColor: vec3<f32>,
  @location(1) vViewDepth: f32,
}

@group(0) @binding(0) var<uniform> uProjectionMatrix: mat4x4<f32>;
@group(0) @binding(1) var<uniform> uModelViewMatrix: mat4x4<f32>;
@group(0) @binding(23) var<uniform> uSize: f32;
@group(0) @binding(42) var<uniform> uFlags: u32;

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(3) color: vec3<f32>
) -> VSOut {
  let mvPosition = uModelViewMatrix * vec4<f32>(position, 1.0);
  let depth = -mvPosition.z;
  let clampedSize = max(pointSizeForDepth(uSize, flagSet(uFlags, FLAG_SIZE_ATTENUATION), depth), 1.0);

  var out: VSOut;
  out.position = uProjectionMatrix * mvPosition;
  out.pointSize = clampedSize;
  out.vColor = select(vec3<f32>(1.0), color, flagSet(uFlags, FLAG_VERTEX_COLORS));
  out.vViewDepth = depth;
  return out;
}
`,
  fragment: `
//!include common
//!include color
//!include fog

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vColor: vec3<f32>,
  @location(1) vViewDepth: f32,
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
  // WGSL samples the point sprite at its centre: the per-fragment point
  // coordinate is not exposed, so a sprite map is sampled with a 0.5/0.5 UV and
  // the round fallback below is generated analytically.
  let pointCoord = vec2<f32>(0.5, 0.5);
  var outgoing = uColor * in.vColor;
  var alpha = uOpacity;

  if (flagSet(uFlags, FLAG_USE_MAP)) {
    let sampled = textureSample(uMap, uMapSampler, pointCoord);
    outgoing = outgoing * sampled.rgb;
    alpha = alpha * sampled.a;
  } else {
    let distanceToCenter = length(pointCoord - vec2<f32>(0.5));
    if (distanceToCenter > 0.5) {
      discard;
    }
    alpha = alpha * (1.0 - smoothstep(0.4, 0.5, distanceToCenter));
  }
  if (flagSet(uFlags, FLAG_USE_ALPHA_MAP)) {
    alpha = alpha * textureSample(uAlphaMap, uAlphaMapSampler, pointCoord).r;
  }
  if (flagSet(uFlags, FLAG_ALPHA_TEST) && alpha < uAlphaTest) {
    discard;
  }

  outgoing = applyColorSpace(outgoing, flagSet(uFlags, FLAG_LINEAR_TO_SRGB));
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
