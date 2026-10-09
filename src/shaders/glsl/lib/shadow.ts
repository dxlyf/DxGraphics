/**
 * GLSL shadow-caster program.
 *
 * A depth-only pass with alpha testing, used when a `MeshDepthMaterial`-style
 * program renders the shadow map. Declares `uModelViewMatrix`,
 * `uProjectionMatrix`, `uModelMatrix`, `uNormalMatrix`, `uAlphaMap`,
 * `uAlphaTest`, `uDisplacementMap` and `uUvTransform`. Gated by `USE_ALPHAMAP`,
 * `USE_UV`, `USE_UV_TRANSFORM`, `USE_DISPLACEMENTMAP`, `USE_SKINNING`,
 * `USE_INSTANCING` and `ALPHATEST`.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Shadow-map casting program. */
/* glsl */
export const shadowShader: ShaderDescriptor = {
  name: 'glsl/shadow',
  language: 'glsl',
  defines: { MAX_BONES: 32 },
  uniforms: {
    uProjectionMatrix: 'mat4',
    uModelViewMatrix: 'mat4',
    uModelMatrix: 'mat4',
    uNormalMatrix: 'mat3',
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

void main() {
  float alpha = 1.0;
#ifdef USE_ALPHAMAP
  alpha = texture(uAlphaMap, vUv).r;
#endif
#ifdef ALPHATEST
  if (alpha < uAlphaTest) discard;
#endif

  // Shadow maps only read the depth channel, so the colour write is cheap but
  // still needed for backends that sample the target as a colour texture.
  fragColor = vec4(gl_FragCoord.z, gl_FragCoord.z, gl_FragCoord.z, alpha);
}
`,
};
