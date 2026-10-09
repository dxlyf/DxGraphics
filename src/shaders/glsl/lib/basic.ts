/**
 * GLSL unlit program.
 *
 * Declares `uModelViewMatrix`, `uProjectionMatrix`, `uNormalMatrix`, `uColor`,
 * `uOpacity`, `uMap`, `uAlphaMap`, `uAoMap`, `uLightMap`, `uEnvMap`,
 * `uReflectivity`, `uRefractionRatio`, `uAlphaTest`, `uUvTransform` and the fog
 * uniforms. Feature branches are gated by `USE_MAP`, `USE_ALPHAMAP`, `USE_AOMAP`,
 * `USE_LIGHTMAP`, `USE_ENVMAP`, `USE_UV`, `USE_UV_TRANSFORM`, `USE_FOG`,
 * `USE_VERTEX_COLORS`, `USE_INSTANCING`, `USE_SKINNING` and `ALPHATEST`.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Unlit colour/diffuse-map program. */
/* glsl */
export const basicShader: ShaderDescriptor = {
  name: 'glsl/basic',
  language: 'glsl',
  defines: { MAX_DIRECTIONAL_LIGHTS: 4, MAX_BONES: 32 },
  uniforms: {
    uProjectionMatrix: 'mat4',
    uModelMatrix: 'mat4',
    uModelViewMatrix: 'mat4',
    uNormalMatrix: 'mat3',
    uColor: 'color',
    uOpacity: 'float',
    uMap: 'texture',
    uAlphaMap: 'texture',
    uAoMap: 'texture',
    uLightMap: 'texture',
    uEnvMap: 'texture',
    uReflectivity: 'float',
    uRefractionRatio: 'float',
    uAlphaTest: 'float',
    uUvTransform: 'mat3',
    uFogColor: 'color',
    uFogNear: 'float',
    uFogFar: 'float',
    uFogDensity: 'float',
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
#ifdef USE_ENVMAP
out vec3 vNormal;
#endif
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

#ifdef USE_ENVMAP
  vNormal = normalize(uNormalMatrix * mat3(modelMatrix) * objectNormal);
#endif

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
#include <fog>

uniform vec3 uColor;
uniform float uOpacity;
#ifdef USE_MAP
uniform sampler2D uMap;
#endif
#ifdef USE_ALPHAMAP
uniform sampler2D uAlphaMap;
#endif
#ifdef USE_AOMAP
uniform sampler2D uAoMap;
#endif
#ifdef USE_LIGHTMAP
uniform sampler2D uLightMap;
#endif
#ifdef USE_ENVMAP
uniform sampler2D uEnvMap;
uniform float uReflectivity;
uniform float uRefractionRatio;
#endif
#ifdef ALPHATEST
uniform float uAlphaTest;
#endif

in vec3 vViewPosition;
#ifdef USE_ENVMAP
in vec3 vNormal;
#endif
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

#ifdef USE_VERTEX_COLORS
  diffuseColor.rgb *= vColor;
#endif
#ifdef USE_MAP
  vec4 sampledDiffuse = texture(uMap, vUv);
  diffuseColor *= sampledDiffuse;
#endif
#ifdef USE_LIGHTMAP
  diffuseColor.rgb += texture(uLightMap, vUv).rgb;
#endif
#ifdef USE_AOMAP
  diffuseColor.rgb *= texture(uAoMap, vUv).r;
#endif

  float alpha = diffuseColor.a;
#ifdef USE_ALPHAMAP
  alpha *= texture(uAlphaMap, vUv).r;
#endif
#ifdef ALPHATEST
  if (alpha < uAlphaTest) discard;
#endif

  vec3 outgoing = diffuseColor.rgb;
#ifdef USE_ENVMAP
  vec3 viewDir = normalize(vViewPosition);
  vec3 normal = normalize(vNormal);
  vec2 reflectUv = reflect(-viewDir, normal).xy * 0.5 + 0.5;
  vec2 refractUv = refract(-viewDir, normal, uRefractionRatio).xy * 0.5 + 0.5;
  vec3 environment = mix(texture(uEnvMap, refractUv).rgb, texture(uEnvMap, reflectUv).rgb, uReflectivity);
  outgoing = mix(outgoing, environment, uReflectivity);
#endif

  outgoing = applyColorSpace(outgoing);
#ifdef USE_FOG
  outgoing = applyFog(outgoing, vFogDepth);
#endif

  fragColor = vec4(outgoing, alpha);
}
`,
};
