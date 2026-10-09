/**
 * WGSL colour-space conversion helpers.
 *
 * @packageDocumentation
 */

/** sRGB/linear conversion, used by the texture and background programs. */
/* wgsl */
export const color = `
//!include common

fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
  let low = c / 12.92;
  let high = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return mix(low, high, step(vec3<f32>(0.04045), c));
}

fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  let low = c * 12.92;
  let high = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3<f32>(0.0031308), c));
}

fn sRGBTransferOETF(c: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(linearToSrgb(c.rgb), c.a);
}

fn applyColorSpace(c: vec3<f32>, linearToSrgbOutput: bool) -> vec3<f32> {
  if (linearToSrgbOutput) {
    return linearToSrgb(c);
  }
  return c;
}
`;
