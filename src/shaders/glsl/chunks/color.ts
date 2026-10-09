/**
 * GLSL colour-space conversion helpers.
 *
 * @packageDocumentation
 */

/** sRGB/linear conversion, used by the texture and background programs. */
/* glsl */
export const color = `
#include <common>

vec3 srgbToLinear(vec3 c) {
  vec3 low = c / 12.92;
  vec3 high = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(low, high, step(vec3(0.04045), c));
}

vec3 linearToSrgb(vec3 c) {
  vec3 low = c * 12.92;
  vec3 high = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), c));
}

vec4 sRGBTransferOETF(vec4 c) {
  return vec4(linearToSrgb(c.rgb), c.a);
}

vec3 applyColorSpace(vec3 c) {
#ifdef LINEAR_TO_SRGB
  return linearToSrgb(c);
#else
  return c;
#endif
}
`;
