/**
 * Common GLSL helpers: constants, saturating math and component utilities.
 *
 * Included by nearly every other chunk, so it deliberately depends on nothing.
 *
 * @packageDocumentation
 */

/** Constants and scalar/vector helpers shared by every GLSL program. */
/* glsl */
export const common = `
const float PI = 3.141592653589793;
const float PI2 = 6.283185307179586;
const float HALF_PI = 1.5707963267948966;
const float EPSILON = 1e-6;

float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2 saturate(vec2 v) { return clamp(v, vec2(0.0), vec2(1.0)); }
vec3 saturate(vec3 v) { return clamp(v, vec3(0.0), vec3(1.0)); }
vec4 saturate(vec4 v) { return clamp(v, vec4(0.0), vec4(1.0)); }

float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float sq(float v) { return v * v; }
float pow2(float v) { return v * v; }
float pow3(float v) { return v * v * v; }
float maxComponent(vec3 v) { return max(v.x, max(v.y, v.z)); }
float minComponent(vec3 v) { return min(v.x, min(v.y, v.z)); }
vec3 whiteComplement(vec3 c) { return vec3(1.0) - saturate(c); }
`;
