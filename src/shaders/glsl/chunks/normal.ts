/**
 * GLSL tangent-space normal mapping.
 *
 * Both helpers derive the tangent frame from screen-space derivatives, so no
 * tangent attribute is required: `perturbNormal2Arb` builds the TBN matrix from
 * `dFdx`/`dFdy` of the view position and the UV set.
 *
 * @packageDocumentation
 */

/** Derivative-based TBN construction and normal-map perturbation. */
/* glsl */
export const normal = `
#include <math>

mat3 tbnFromDerivatives(vec3 normal, vec3 position, vec2 uv, vec3 dpdx, vec3 dpdy) {
  vec2 st0 = dFdx(uv);
  vec2 st1 = dFdy(uv);
  vec3 S = normalize(dpdx * st1.t - dpdy * st0.t);
  vec3 T = normalize(-dpdx * st1.s + dpdy * st0.s);
  vec3 N = safeNormalize(normal);
  return mat3(S, T, N);
}

vec3 perturbNormal2Arb(vec3 eyePos, vec3 surfNormal, vec2 uvCoord, vec2 normalScale, sampler2D normalMap) {
  vec3 q0 = dFdx(eyePos);
  vec3 q1 = dFdy(eyePos);
  vec2 st0 = dFdx(uvCoord);
  vec2 st1 = dFdy(uvCoord);

  vec3 S = normalize(q0 * st1.t - q1 * st0.t);
  vec3 T = normalize(-q0 * st1.s + q1 * st0.s);
  vec3 N = safeNormalize(surfNormal);
  mat3 tsn = mat3(S, T, N);

  vec3 mapN = texture(normalMap, uvCoord).xyz * 2.0 - 1.0;
  mapN.xy *= normalScale;
  return normalize(tsn * mapN);
}
`;
