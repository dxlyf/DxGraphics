/**
 * GLSL Lambert (diffuse-only) program.
 *
 * Declares the frame matrices, `uColor`, `uOpacity`, `uMap`, `uAlphaMap`,
 * `uAoMap`, `uEmissive`, `uEmissiveMap`, `uEmissiveIntensity`, `uReflectivity`,
 * `uEnvMap`, `uAlphaTest`, the fog and the ambient/directional light uniforms.
 *
 * Gated by `USE_MAP`, `USE_ALPHAMAP`, `USE_AOMAP`, `USE_EMISSIVEMAP`,
 * `USE_ENVMAP`, `USE_UV`, `USE_UV_TRANSFORM`, `USE_FOG`, `USE_VERTEX_COLORS`,
 * `USE_INSTANCING`, `USE_SKINNING` and `ALPHATEST`.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Diffuse-only lit program. */
/* glsl */
export const lambertShader: ShaderDescriptor = {
  name: 'glsl/lambert',
  language: 'glsl',
  defines: { MAX_DIRECTIONAL_LIGHTS: 4, MAX_BONES: 32 },
  uniforms: {
    uProjectionMatrix: 'mat4',
    uModelMatrix: 'mat4',
    uModelViewMatrix: 'mat4',
    uNormalMatrix: 'mat3',
    uCameraPosition: 'vec3',
    uColor: 'color',
    uOpacity: 'float',
    uMap: 'texture',
    uAlphaMap: 'texture',
    uAoMap: 'texture',
    uEmissive: 'color',
    uEmissiveMap: 'texture',
    uEmissiveIntensity: 'float',
    uEnvMap: 'texture',
    uReflectivity: 'float',
    uAlphaTest: 'float',
    uUvTransform: 'mat3',
    uFogColor: 'color',
    uFogNear: 'float',
    uFogFar: 'float',
    uFogDensity: 'float',
    uAmbientLightColor: 'color',
    uDirectionalLightCount: 'int',
    uDirectionalLightDirections: { type: 'array', elementType: 'vec3', count: 4 },
    uDirectionalLightColors: { type: 'array', elementType: 'vec3', count: 4 },
  },
  attributes: {
    position: 'vec3',
    normal: 'vec3',
    uv: 'vec2',
    color: 'vec3',
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
#ifdef USE_VERTEX_COLORS
layout(location = 3) in vec3 color;
#endif
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

out vec3 vViewPosition;
out vec3 vNormal;
#ifdef USE_VERTEX_COLORS
out vec3 vColor;
#endif
#ifdef USE_UV
out vec2 vUv;
#endif
#ifdef USE_FOG
out float vFogDepth;
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

  vec4 mvPosition = uModelViewMatrix * localPosition;
  vViewPosition = -mvPosition.xyz;
  vNormal = normalize(uNormalMatrix * mat3(modelMatrix) * objectNormal);
  gl_Position = uProjectionMatrix * mvPosition;

#ifdef USE_UV
  vUv = transformUv(uv);
#endif
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
#include <lighting>
#include <fog>

#ifndef MAX_DIRECTIONAL_LIGHTS
#define MAX_DIRECTIONAL_LIGHTS 4
#endif

uniform vec3 uColor;
uniform float uOpacity;
uniform vec3 uEmissive;
uniform float uEmissiveIntensity;
uniform vec3 uAmbientLightColor;
uniform int uDirectionalLightCount;
uniform vec3 uDirectionalLightDirections[MAX_DIRECTIONAL_LIGHTS];
uniform vec3 uDirectionalLightColors[MAX_DIRECTIONAL_LIGHTS];
#ifdef USE_MAP
uniform sampler2D uMap;
#endif
#ifdef USE_ALPHAMAP
uniform sampler2D uAlphaMap;
#endif
#ifdef USE_AOMAP
uniform sampler2D uAoMap;
#endif
#ifdef USE_EMISSIVEMAP
uniform sampler2D uEmissiveMap;
#endif
#ifdef USE_ENVMAP
uniform sampler2D uEnvMap;
uniform float uReflectivity;
#endif
#ifdef ALPHATEST
uniform float uAlphaTest;
#endif

in vec3 vViewPosition;
in vec3 vNormal;
#ifdef USE_VERTEX_COLORS
in vec3 vColor;
#endif
#ifdef USE_UV
in vec2 vUv;
#endif
#ifdef USE_FOG
in float vFogDepth;
#endif

out vec4 fragColor;

void main() {
  vec4 diffuseColor = vec4(uColor, uOpacity);
  vec3 normal = normalize(vNormal);
  vec3 viewDir = normalize(vViewPosition);

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

  vec3 outgoing = diffuseColor.rgb * uAmbientLightColor;
  for (int i = 0; i < MAX_DIRECTIONAL_LIGHTS; i++) {
    if (i >= uDirectionalLightCount) break;
    vec3 lightDir = normalize(uDirectionalLightDirections[i]);
    outgoing += lambertDiffuse(diffuseColor.rgb, normal, lightDir) * uDirectionalLightColors[i];
  }

  vec3 emissive = uEmissive * uEmissiveIntensity;
#ifdef USE_EMISSIVEMAP
  emissive *= texture(uEmissiveMap, vUv).rgb;
#endif
  outgoing += emissive;

#ifdef USE_AOMAP
  outgoing *= texture(uAoMap, vUv).r;
#endif
#ifdef USE_ENVMAP
  vec2 reflectUv = reflect(-viewDir, normal).xy * 0.5 + 0.5;
  outgoing = mix(outgoing, texture(uEnvMap, reflectUv).rgb, uReflectivity);
#endif

  outgoing = applyColorSpace(outgoing);
#ifdef USE_FOG
  outgoing = applyFog(outgoing, vFogDepth);
#endif

  fragColor = vec4(outgoing, alpha);
}
`,
};
