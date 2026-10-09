/**
 * WGSL background program.
 *
 * Binding table: `0` resolution, `29`-`32` fog, `37` background colour, `38`
 * gradient top, `39` gradient bottom, `40` intensity, `42` flag word.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Full-screen background/skybox program. */
/* wgsl */
export const backgroundShader: ShaderDescriptor = {
  name: 'wgsl/background',
  language: 'wgsl',
  uniforms: {
    uResolution: { type: 'vec2', group: 0, binding: 5 },
    uBackgroundColor: { type: 'color', group: 0, binding: 37 },
    uBackgroundTop: { type: 'color', group: 0, binding: 38 },
    uBackgroundBottom: { type: 'color', group: 0, binding: 39 },
    uBackgroundIntensity: { type: 'float', group: 0, binding: 40 },
    uFlags: { type: 'uint', group: 0, binding: 42 },
  },
  attributes: { position: 'vec3', uv: 'vec2' },
  entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
  vertex: `
//!include common

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUv: vec2<f32>,
}

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(2) uv: vec2<f32>
) -> VSOut {
  // The caller supplies a full-screen triangle whose positions are already in
  // clip space, so no matrix is needed here.
  var out: VSOut;
  out.position = vec4<f32>(position.xy, 1.0, 1.0);
  out.vUv = uv;
  return out;
}
`,
  fragment: `
//!include common
//!include math

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUv: vec2<f32>,
}

@group(0) @binding(37) var<uniform> uBackgroundColor: vec3<f32>;
@group(0) @binding(38) var<uniform> uBackgroundTop: vec3<f32>;
@group(0) @binding(39) var<uniform> uBackgroundBottom: vec3<f32>;
@group(0) @binding(40) var<uniform> uBackgroundIntensity: f32;
@group(0) @binding(42) var<uniform> uFlags: u32;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  var background = uBackgroundColor;
  if (flagSet(uFlags, FLAG_ENV_MAP)) {
    background = mix(uBackgroundBottom, uBackgroundTop, saturate(in.vUv.y));
  }

  // Ordered dithering: a half-step offset of 1/255 hides the banding a smooth
  // vertical gradient would otherwise show on an 8-bit target.
  let dither = (hash21(in.position.xy) - 0.5) / 255.0;
  return vec4<f32>(background * uBackgroundIntensity + vec3<f32>(dither), 1.0);
}
`,
};
