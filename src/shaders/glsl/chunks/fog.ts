/**
 * GLSL fog helpers.
 *
 * `FOG_EXP2` selects the squared-exponential falloff; otherwise the near/far
 * range selects a smooth linear ramp. The `vFogDepth` varying is declared by the
 * programs, because the vertex stage writes it and the fragment stage reads it.
 *
 * @packageDocumentation
 */

/** Fog uniforms and the `applyFog` helper. */
/* glsl */
export const fog = `
#include <common>

#ifdef USE_FOG
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogDensity;

vec3 applyFog(vec3 color, float fogDepth) {
#ifdef FOG_EXP2
  float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * fogDepth * fogDepth);
#else
  float fogFactor = smoothstep(uFogNear, uFogFar, fogDepth);
#endif
  return mix(color, uFogColor, saturate(fogFactor));
}
#endif
`;
