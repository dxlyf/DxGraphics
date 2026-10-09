/**
 * WGSL dashed-line program.
 *
 * Binding table: `0` projection, `1` model-view, `7` colour, `8` opacity, `25`
 * pattern scale, `26` dash size, `27` gap size, `28` total size, `29`-`32` fog,
 * `42` flag word.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Line program with a dash/gap pattern. */
/* wgsl */
export const dashedShader: ShaderDescriptor = {
  name: 'wgsl/dashed',
  language: 'wgsl',
  defines: { USE_DASHED: true },
  uniforms: {
    uProjectionMatrix: { type: 'mat4', group: 0, binding: 0 },
    uModelViewMatrix: { type: 'mat4', group: 0, binding: 1 },
    uColor: { type: 'color', group: 0, binding: 7 },
    uOpacity: { type: 'float', group: 0, binding: 8 },
    uScale: { type: 'float', group: 0, binding: 25 },
    uDashSize: { type: 'float', group: 0, binding: 26 },
    uGapSize: { type: 'float', group: 0, binding: 27 },
    uTotalSize: { type: 'float', group: 0, binding: 28 },
    uFogColor: { type: 'color', group: 0, binding: 29 },
    uFogNear: { type: 'float', group: 0, binding: 30 },
    uFogFar: { type: 'float', group: 0, binding: 31 },
    uFogDensity: { type: 'float', group: 0, binding: 32 },
    uFlags: { type: 'uint', group: 0, binding: 42 },
  },
  attributes: { position: 'vec3', lineDistance: 'float' },
  entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
  vertex: `
//!include common

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vLineDistance: f32,
  @location(1) vViewDepth: f32,
  @location(2) vColor: vec3<f32>,
}

@group(0) @binding(0) var<uniform> uProjectionMatrix: mat4x4<f32>;
@group(0) @binding(1) var<uniform> uModelViewMatrix: mat4x4<f32>;
@group(0) @binding(25) var<uniform> uScale: f32;
@group(0) @binding(42) var<uniform> uFlags: u32;

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(7) lineDistance: f32,
  @location(3) color: vec3<f32>
) -> VSOut {
  let mvPosition = uModelViewMatrix * vec4<f32>(position, 1.0);

  var out: VSOut;
  out.position = uProjectionMatrix * mvPosition;
  out.vLineDistance = uScale * lineDistance;
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
  @location(0) vLineDistance: f32,
  @location(1) vViewDepth: f32,
  @location(2) vColor: vec3<f32>,
}

@group(0) @binding(7) var<uniform> uColor: vec3<f32>;
@group(0) @binding(8) var<uniform> uOpacity: f32;
@group(0) @binding(26) var<uniform> uDashSize: f32;
@group(0) @binding(27) var<uniform> uGapSize: f32;
@group(0) @binding(28) var<uniform> uTotalSize: f32;
@group(0) @binding(29) var<uniform> uFogColor: vec3<f32>;
@group(0) @binding(30) var<uniform> uFogNear: f32;
@group(0) @binding(31) var<uniform> uFogFar: f32;
@group(0) @binding(32) var<uniform> uFogDensity: f32;
@group(0) @binding(42) var<uniform> uFlags: u32;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let period = max(uDashSize + uGapSize, EPSILON);
  let positionInPattern = fract(in.vLineDistance / period) * period;

  // uTotalSize shortens the visible dash run at long distances, which hides
  // the aliasing a hairline pattern would otherwise show.
  if (positionInPattern > min(uDashSize, uTotalSize)) {
    discard;
  }

  var outgoing = uColor;
  if (flagSet(uFlags, FLAG_VERTEX_COLORS)) {
    outgoing = outgoing * in.vColor;
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

  return vec4<f32>(outgoing, uOpacity);
}
`,
};
