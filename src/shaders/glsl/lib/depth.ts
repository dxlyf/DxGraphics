/**
 * GLSL depth-only program.
 *
 * Used for shadow maps and for depth pre-passes. Declares `uModelViewMatrix`,
 * `uProjectionMatrix`, `uDepthPacking`, `uAlphaMap`, `uDisplacementMap` and
 * `uAlphaTest`. Gated by `USE_ALPHAMAP`, `USE_DISPLACEMENTMAP`, `USE_UV`,
 * `USE_UV_TRANSFORM`, `USE_SKINNING`, `USE_INSTANCING` and `ALPHATEST`.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Depth-only program with four-channel packings. */
/* glsl */
export const depthShader: ShaderDescriptor = {
  name: 'glsl/depth',
  language: 'glsl',
  defines: { MAX_BONES: 32, DEPTH_PACKING: 0 },
  uniforms: {
    uProjectionMatrix: 'mat4',
    uModelViewMatrix: 'mat4',
    uModelMatrix: 'mat4',
    uNormalMatrix: 'mat3',
    uDepthPacking: 'int',
    uAlphaMap: 'texture',
    uAlphaTest: 'float',
    uDisplacementMap: 'texture',
    uDisplacementScale: 'float',
    uDisplacementBias: 'float',
    uUvTransform: 'mat3',
  },
  attributes: {
    position: 'vec3',
    normal: 'vec3',
    uv: 'vec2',
    skinIndex: 'vec4',
    skinWeight: 'vec4',
    instanceMatrix: 'mat4',
  },
  vertex: `
#include <common>
#include <uv>
#include <skinning>

layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 uv;
#ifdef USE_SKINNING
layout(location = 4) in vec4 skinIndex;
layout(location = 5) in vec4 skinWeight;
#endif
#ifdef USE_INSTANCING
layout(location = 6) in mat4 instanceMatrix;
#endif

uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;
uniform mat4 uModelMatrix;
uniform mat3 uNormalMatrix;
#ifdef USE_DISPLACEMENTMAP
uniform sampler2D uDisplacementMap;
uniform float uDisplacementScale;
uniform float uDisplacementBias;
#endif

#ifdef USE_UV
out vec2 vUv;
#endif

void main() {
  vec3 objectNormal = normal;
  vec3 objectPosition = position;
#ifdef USE_SKINNING
  objectNormal = skinnedNormal(normal, skinIndex, skinWeight);
  objectPosition = skinnedPosition(position, skinIndex, skinWeight);
#endif

  vec4 localPosition = vec4(objectPosition, 1.0);
  mat4 modelMatrix = uModelMatrix;
#ifdef USE_INSTANCING
  localPosition = instanceMatrix * localPosition;
  modelMatrix = uModelMatrix * instanceMatrix;
#endif

  vec3 transformedNormal = normalize(uNormalMatrix * mat3(modelMatrix) * objectNormal);
#ifdef USE_UV
  vUv = transformUv(uv);
#endif
#ifdef USE_DISPLACEMENTMAP
  localPosition.xyz += transformedNormal *
    (texture(uDisplacementMap, vUv).x * uDisplacementScale + uDisplacementBias);
#endif

  gl_Position = uProjectionMatrix * uModelViewMatrix * localPosition;
}
`,
  fragment: `
#include <common>

uniform int uDepthPacking;
#ifdef USE_ALPHAMAP
uniform sampler2D uAlphaMap;
#endif
#ifdef ALPHATEST
uniform float uAlphaTest;
#endif

#ifdef USE_UV
in vec2 vUv;
#endif

out vec4 fragColor;

/** Packs depth in the 0..1 range into four channels (three.js RGBADepthPacking). */
vec4 packDepthToRGBA(float depth) {
  const vec4 bitShifts = vec4(1.0, 255.0, 65025.0, 16581375.0);
  const vec4 bitMask = vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  vec4 color = fract(depth * bitShifts);
  color -= color.xxyz * bitMask;
  return color;
}

void main() {
#ifdef ALPHATEST
  float alpha = 1.0;
#ifdef USE_ALPHAMAP
  alpha = texture(uAlphaMap, vUv).r;
#endif
  if (alpha < uAlphaTest) discard;
#endif

  float depth = gl_FragCoord.z;

  if (uDepthPacking == 1) {
    fragColor = vec4(depth, depth, depth, 1.0);
  } else if (uDepthPacking == 2) {
    fragColor = packDepthToRGBA(depth);
  } else {
    fragColor = vec4(vec3(depth), 1.0);
  }
}
`,
};
