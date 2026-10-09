/**
 * GLSL sprite program.
 *
 * Draws a camera-facing quad. Declares `uModelViewMatrix`, `uProjectionMatrix`,
 * `uColor`, `uOpacity`, `uMap`, `uRotation`, `uSize`, `uSizeAttenuation`,
 * `uAlphaTest` and the fog uniforms.
 *
 * Gated by `USE_MAP`, `USE_ALPHAMAP`, `USE_UV`, `USE_UV_TRANSFORM`, `USE_FOG`,
 * `USE_VERTEX_COLORS`, `USE_INSTANCING` and `ALPHATEST`.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Camera-facing quad program with rotation and size attenuation. */
/* glsl */
export const spriteShader: ShaderDescriptor = {
  name: 'glsl/sprite',
  language: 'glsl',
  defines: { USE_SPRITE: true },
  uniforms: {
    uProjectionMatrix: 'mat4',
    uModelViewMatrix: 'mat4',
    uResolution: 'vec2',
    uColor: 'color',
    uOpacity: 'float',
    uMap: 'texture',
    uAlphaMap: 'texture',
    uRotation: 'float',
    uSize: 'float',
    uSizeAttenuation: 'bool',
    uAlphaTest: 'float',
    uUvTransform: 'mat3',
    uFogColor: 'color',
    uFogNear: 'float',
    uFogFar: 'float',
    uFogDensity: 'float',
  },
  attributes: {
    position: 'vec3',
    uv: 'vec2',
    color: 'vec3',
    instanceMatrix: 'mat4',
  },
  vertex: `
#include <common>
#include <uv>

#define USE_SPRITE

layout(location = 0) in vec3 position;
layout(location = 2) in vec2 uv;
#ifdef USE_VERTEX_COLORS
layout(location = 3) in vec3 color;
#endif
#ifdef USE_INSTANCING
layout(location = 6) in mat4 instanceMatrix;
#endif

uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;
uniform vec2 uResolution;
uniform float uRotation;
uniform float uSize;
uniform bool uSizeAttenuation;

out vec2 vUv;
#ifdef USE_VERTEX_COLORS
out vec3 vColor;
#endif
#ifdef USE_FOG
out float vFogDepth;
#endif

void main() {
  vec2 alignedPosition = rotate2d(position.xy, uRotation) * uSize;

#ifdef USE_INSTANCING
  vec4 mvPosition = uModelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
#else
  vec4 mvPosition = uModelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
#endif

  if (uSizeAttenuation) {
    // Applied in view space: the projection divides by depth, so the sprite
    // shrinks with distance exactly like world-space geometry.
    mvPosition.xy += alignedPosition;
    gl_Position = uProjectionMatrix * mvPosition;
  } else {
    // Applied in clip space so the sprite keeps a constant pixel size.
    gl_Position = uProjectionMatrix * mvPosition;
    gl_Position.xy += alignedPosition / max(uResolution, vec2(1.0)) * 2.0 * gl_Position.w;
  }

  vUv = transformUv(uv);

#ifdef USE_VERTEX_COLORS
  vColor = color;
#endif
#ifdef USE_FOG
  vFogDepth = -mvPosition.z;
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

in vec2 vUv;
#ifdef USE_VERTEX_COLORS
in vec3 vColor;
#endif
#ifdef USE_FOG
in float vFogDepth;
#endif

out vec4 fragColor;

void main() {
  vec4 diffuseColor = vec4(uColor, uOpacity);

#ifdef USE_VERTEX_COLORS
  diffuseColor.rgb *= vColor;
#endif
#ifdef USE_MAP
  diffuseColor *= texture(uMap, vUv);
#endif

  float alpha = diffuseColor.a;
#ifdef USE_ALPHAMAP
  alpha *= texture(uAlphaMap, vUv).r;
#endif
#ifdef ALPHATEST
  if (alpha < uAlphaTest) discard;
#endif

  vec3 outgoing = applyColorSpace(diffuseColor.rgb);
#ifdef USE_FOG
  outgoing = applyFog(outgoing, vFogDepth);
#endif

  fragColor = vec4(outgoing, alpha);
}
`,
};
