/**
 * GLSL math helpers used by procedural effects and by the normal/shadow chunks.
 *
 * @packageDocumentation
 */

/** Rotations, hashes and remapping helpers. */
/* glsl */
export const math = `
#include <common>

vec2 rotate2d(vec2 p, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float remap(float v, float inMin, float inMax, float outMin, float outMax) {
  return outMin + (v - inMin) * (outMax - outMin) / max(inMax - inMin, EPSILON);
}

vec3 safeNormalize(vec3 v) {
  float len = length(v);
  return len > EPSILON ? v / len : vec3(0.0, 0.0, 1.0);
}

float pow5(float v) {
  float v2 = v * v;
  return v2 * v2 * v;
}

float smootherstep(float edge0, float edge1, float x) {
  float t = saturate((x - edge0) / max(edge1 - edge0, EPSILON));
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}
`;
