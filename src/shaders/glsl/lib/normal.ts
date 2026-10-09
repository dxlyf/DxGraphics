/**
 * GLSL debug-normal program.
 *
 * Writes the view-space normal into the colour buffer, optionally perturbed by a
 * normal map, so normal-mapping setups can be inspected visually. Declares
 * `uModelViewMatrix`, `uProjectionMatrix`, `uNormalMatrix`, `uBumpMap`,
 * `uBumpScale`, `uNormalMap`, `uNormalScale`, `uDisplacementMap` and the
 * displacement pair. Gated by `FLAT_SHADED`, `USE_BUMPMAP`, `USE_NORMALMAP` and
 * `USE_DISPLACEMENTMAP`.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** View-space normal visualisation program. */
/* glsl */
export const normalShader: ShaderDescriptor = {
  name: 'glsl/normal',
  language: 'glsl',
  defines: { MAX_BONES: 32 },
  uniforms: {
    uProjectionMatrix: 'mat4',
    uModelViewMatrix: 'mat4',
    uModelMatrix: 'mat4',
    uNormalMatrix: 'mat3',
    uBumpMap: 'texture',
    uBumpScale: 'float',
    uNormalMap: 'texture',
    uNormalScale: 'vec2',
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

out vec3 vViewPosition;
#ifdef FLAT_SHADED
out vec3 vNormalFlat;
#else
out vec3 vNormal;
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

  vec4 mvPosition = uModelViewMatrix * localPosition;
  vViewPosition = -mvPosition.xyz;
#ifdef FLAT_SHADED
  vNormalFlat = transformedNormal;
#else
  vNormal = transformedNormal;
#endif
  gl_Position = uProjectionMatrix * mvPosition;
}
`,
  fragment: `
#include <common>
#include <normal>

#ifdef USE_NORMALMAP
uniform sampler2D uNormalMap;
uniform vec2 uNormalScale;
#endif
#ifdef USE_BUMPMAP
uniform sampler2D uBumpMap;
uniform float uBumpScale;
#endif

in vec3 vViewPosition;
#ifdef FLAT_SHADED
in vec3 vNormalFlat;
#else
in vec3 vNormal;
#endif
#ifdef USE_UV
in vec2 vUv;
#endif

out vec4 fragColor;

void main() {
#ifdef FLAT_SHADED
  vec3 normal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
#else
  vec3 normal = normalize(vNormal);
#endif

#ifdef USE_NORMALMAP
  normal = perturbNormal2Arb(-vViewPosition, normal, vUv, uNormalScale, uNormalMap);
#endif
#ifdef USE_BUMPMAP
  // A bump map perturbs the normal along the screen-space derivatives of the
  // height field; the scale controls how pronounced the result looks.
  float height = texture(uBumpMap, vUv).r;
  vec2 gradient = vec2(dFdx(height), dFdy(height)) * uBumpScale;
  normal = normalize(normal - vec3(gradient, 0.0));
#endif

  normal = normalize((normal + 1.0) * 0.5);
  fragColor = vec4(normal, 1.0);
}
`,
};
