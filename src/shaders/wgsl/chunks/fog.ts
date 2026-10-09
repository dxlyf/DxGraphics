/**
 * WGSL fog helpers.
 *
 * WGSL has no preprocessor, so the exponential form is selected by the
 * `exponential` argument instead of a `FOG_EXP2` define.
 *
 * @packageDocumentation
 */

/** Fog uniforms plus the `applyFog` helper. */
/* wgsl */
export const fog = `
//!include common

fn applyFog(
  color: vec3<f32>,
  fogDepth: f32,
  fogColor: vec3<f32>,
  fogNear: f32,
  fogFar: f32,
  fogDensity: f32,
  exponential: bool
) -> vec3<f32> {
  var fogFactor: f32;
  if (exponential) {
    fogFactor = 1.0 - exp(-fogDensity * fogDensity * fogDepth * fogDepth);
  } else {
    fogFactor = smoothstep(fogNear, fogFar, fogDepth);
  }
  return mix(color, fogColor, saturate(fogFactor));
}
`;
