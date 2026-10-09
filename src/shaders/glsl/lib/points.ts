/**
 * GLSL point-sprite program.
 *
 * Declares `uModelViewMatrix`, `uProjectionMatrix`, `uColor`, `uOpacity`, `uMap`,
 * `uAlphaMap`, `uSize`, `uSizeAttenuation`, `uAlphaTest` and the fog uniforms.
 * Gated by `USE_MAP`, `USE_ALPHAMAP`, `USE_UV`, `USE_UV_TRANSFORM`, `USE_FOG`,
 * `USE_VERTEX_COLORS` and `ALPHATEST`.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Screen-space point program with optional size attenuation. */
/* glsl */
export const pointsShader: ShaderDescriptor = {
  name: 'glsl/points',
  language: 'glsl',
  defines: { USE_POINTS: true },
  uniforms: {
    uProjectionMatrix: 'mat4',
    uModelViewMatrix: 'mat4',
    uColor: 'color',
    uOpacity: 'float',
    uMap: 'texture',
    uAlphaMap: 'texture',
    uSize: 'float',
    uSizeAttenuation: 'bool',
    uAlphaTest: 'float',
    uUvTransform: 'mat3',
    uFogColor: 'color',
    uFogNear: 'float',
    uFogFar: 'float',
    uFogDensity: 'float',
  },
  attributes: { position: 'vec3', color: 'vec3' },
  vertex: `
#include <common>
#include <points>

#define USE_POINTS

layout(location = 0) in vec3 position;
#ifdef USE_VERTEX_COLORS
layout(location = 3) in vec3 color;
#endif

uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;
uniform float uSize;
uniform bool uSizeAttenuation;

out vec3 vColor;
#ifdef USE_FOG
out float vFogDepth;
#endif

void main() {
  vec4 mvPosition = uModelViewMatrix * vec4(position, 1.0);
  gl_Position = uProjectionMatrix * mvPosition;

  float depth = -mvPosition.z;
  gl_PointSize = max(pointSizeForDepth(uSize, uSizeAttenuation, depth), 1.0);

#ifdef USE_VERTEX_COLORS
  vColor = color;
#else
  vColor = vec3(1.0);
#endif
#ifdef USE_FOG
  vFogDepth = depth;
#endif
}
`,
  fragment: `
#include <common>
#include <color>
#include <fog>

uniform vec3 uColor;
uniform float uOpacity;
#ifdef USE_MAP
uniform sampler2D uMap;
#endif
#ifdef USE_ALPHAMAP
uniform sampler2D uAlphaMap;
#endif
#ifdef ALPHATEST
uniform float uAlphaTest;
#endif

in vec3 vColor;
#ifdef USE_FOG
in float vFogDepth;
#endif

out vec4 fragColor;

void main() {
  vec2 pointCoord = gl_PointCoord;

  vec3 outgoing = uColor * vColor;
  float alpha = uOpacity;

#ifdef USE_MAP
  vec4 sampled = texture(uMap, pointCoord);
  outgoing *= sampled.rgb;
  alpha *= sampled.a;
#else
  // Without a sprite map the point is drawn as a soft round dot.
  float distanceToCenter = length(pointCoord - vec2(0.5));
  if (distanceToCenter > 0.5) discard;
  alpha *= 1.0 - smoothstep(0.4, 0.5, distanceToCenter);
#endif
#ifdef USE_ALPHAMAP
  alpha *= texture(uAlphaMap, pointCoord).r;
#endif
#ifdef ALPHATEST
  if (alpha < uAlphaTest) discard;
#endif

  outgoing = applyColorSpace(outgoing);
#ifdef USE_FOG
  outgoing = applyFog(outgoing, vFogDepth);
#endif

  fragColor = vec4(outgoing, alpha);
}
`,
};
