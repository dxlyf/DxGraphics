/**
 * WGSL math helpers used by procedural effects and the normal/shadow chunks.
 *
 * @packageDocumentation
 */

/** Rotations, hashes and remapping helpers. */
/* wgsl */
export const math = `
//!include common

fn rotate2d(p: vec2<f32>, angle: f32) -> vec2<f32> {
  let s = sin(angle);
  let c = cos(angle);
  return vec2<f32>(c * p.x - s * p.y, s * p.x + c * p.y);
}

fn hash11(p: f32) -> f32 {
  var value = fract(p * 0.1031);
  value = value * (value + 33.33);
  value = value * (value + value);
  return fract(value);
}

fn hash21(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, vec3<f32>(p3.y, p3.z, p3.x) + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn remap(v: f32, inMin: f32, inMax: f32, outMin: f32, outMax: f32) -> f32 {
  return outMin + (v - inMin) * (outMax - outMin) / max(inMax - inMin, EPSILON);
}

fn safeNormalize3(v: vec3<f32>) -> vec3<f32> {
  let len = length(v);
  if (len > EPSILON) {
    return v / len;
  }
  return vec3<f32>(0.0, 0.0, 1.0);
}

fn pow5(v: f32) -> f32 {
  let v2 = v * v;
  return v2 * v2 * v;
}

fn smootherstep(edge0: f32, edge1: f32, x: f32) -> f32 {
  let t = saturate((x - edge0) / max(edge1 - edge0, EPSILON));
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}
`;
