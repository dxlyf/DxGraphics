/**
 * GLSL physically based program with the extended parameter set.
 *
 * Adds `uClearcoat`, `uClearcoatRoughness`, `uClearcoatMap`,
 * `uClearcoatNormalMap`, `uTransmission`, `uTransmissionMap`, `uThickness`,
 * `uThicknessMap`, `uAttenuationDistance`, `uAttenuationColor`, `uIridescence`,
 * `uSheen`, `uSheenColor`, `uSheenRoughness`, `uSpecularIntensity`,
 * `uSpecularColor` and `uIor` on top of the standard uniform set.
 *
 * This is the only built-in family without a WGSL variant; see `ShaderLib`'s
 * `WGSL_UNSUPPORTED` table for the documented reason.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Extended (clearcoat/transmission/sheen) physically based program. */
/* glsl */
export const physicalShader: ShaderDescriptor = {
  name: 'glsl/physical',
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
    uRoughness: 'float',
    uMetalness: 'float',
    uMap: 'texture',
    uAlphaMap: 'texture',
    uAoMap: 'texture',
    uRoughnessMap: 'texture',
    uMetalnessMap: 'texture',
    uEmissive: 'color',
    uEmissiveMap: 'texture',
    uEmissiveIntensity: 'float',
    uNormalMap: 'texture',
    uNormalScale: 'vec2',
    uDisplacementMap: 'texture',
    uDisplacementScale: 'float',
    uDisplacementBias: 'float',
    uEnvMap: 'texture',
    uEnvMapIntensity: 'float',
    uClearcoat: 'float',
    uClearcoatRoughness: 'float',
    uClearcoatMap: 'texture',
    uClearcoatNormalMap: 'texture',
    uTransmission: 'float',
    uTransmissionMap: 'texture',
    uThickness: 'float',
    uThicknessMap: 'texture',
    uAttenuationDistance: 'float',
    uAttenuationColor: 'color',
    uIridescence: 'float',
    uSheen: 'float',
    uSheenColor: 'color',
    uSheenRoughness: 'float',
    uSpecularIntensity: 'float',
    uSpecularColor: 'color',
    uIor: 'float',
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
#ifdef USE_DISPLACEMENTMAP
uniform sampler2D uDisplacementMap;
uniform float uDisplacementScale;
uniform float uDisplacementBias;
#endif

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
  vNormal = transformedNormal;
  gl_Position = uProjectionMatrix * mvPosition;

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
#include <normal>
#include <fog>

#ifndef MAX_DIRECTIONAL_LIGHTS
#define MAX_DIRECTIONAL_LIGHTS 4
#endif

uniform vec3 uColor;
uniform float uOpacity;
uniform float uRoughness;
uniform float uMetalness;
uniform float uEnvMapIntensity;
uniform vec3 uEmissive;
uniform float uEmissiveIntensity;
uniform float uClearcoat;
uniform float uClearcoatRoughness;
uniform float uTransmission;
uniform float uThickness;
uniform float uAttenuationDistance;
uniform vec3 uAttenuationColor;
uniform float uIridescence;
uniform float uSheen;
uniform vec3 uSheenColor;
uniform float uSheenRoughness;
uniform float uSpecularIntensity;
uniform vec3 uSpecularColor;
uniform float uIor;
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
#ifdef USE_ROUGHNESSMAP
uniform sampler2D uRoughnessMap;
#endif
#ifdef USE_METALNESSMAP
uniform sampler2D uMetalnessMap;
#endif
#ifdef USE_EMISSIVEMAP
uniform sampler2D uEmissiveMap;
#endif
#ifdef USE_NORMALMAP
uniform sampler2D uNormalMap;
uniform vec2 uNormalScale;
#endif
#ifdef USE_CLEARCOATMAP
uniform sampler2D uClearcoatMap;
#endif
#ifdef USE_CLEARCOATNORMALMAP
uniform sampler2D uClearcoatNormalMap;
#endif
#ifdef USE_TRANSMISSIONMAP
uniform sampler2D uTransmissionMap;
#endif
#ifdef USE_THICKNESSMAP
uniform sampler2D uThicknessMap;
#endif
#ifdef USE_ENVMAP
uniform sampler2D uEnvMap;
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

/** Beer-Lambert absorption of light travelling through the volume. */
vec3 volumeAttenuation(float thickness, vec3 attenuationColor) {
  if (thickness <= 0.0) return vec3(1.0);
  return exp(-thickness * (vec3(1.0) - saturate(attenuationColor)));
}

/** Iridescence as a thin-film hue shift driven by the view angle. */
vec3 iridescenceTint(float cosTheta, float amount) {
  float phase = saturate(1.0 - cosTheta);
  vec3 tint = vec3(
    0.5 + 0.5 * cos(PI2 * (phase + 0.00)),
    0.5 + 0.5 * cos(PI2 * (phase + 0.33)),
    0.5 + 0.5 * cos(PI2 * (phase + 0.67))
  );
  return mix(vec3(1.0), tint, saturate(amount));
}

/** Sheen: a rough retroreflective lobe added on top of the base BRDF. */
vec3 sheenLobe(vec3 normal, vec3 viewDir, vec3 lightDir, vec3 sheenColor, float sheenRoughness) {
  float ndotl = max(dot(normal, lightDir), 0.0);
  float ndotv = max(dot(normal, viewDir), 0.0);
  float sheenPower = mix(8.0, 1.0, saturate(sheenRoughness));
  return sheenColor * pow(max(1.0 - max(ndotl, ndotv), 0.0), sheenPower);
}

void main() {
  vec4 diffuseColor = vec4(uColor, uOpacity);
  vec3 normal = normalize(vNormal);
  vec3 viewDir = normalize(vViewPosition);
  float roughness = uRoughness;
  float metalness = uMetalness;
  float clearcoat = uClearcoat;
  float transmission = uTransmission;

#ifdef USE_VERTEX_COLORS
  diffuseColor.rgb *= vColor;
#endif
#ifdef USE_MAP
  diffuseColor *= texture(uMap, vUv);
#endif
#ifdef USE_ROUGHNESSMAP
  roughness *= texture(uRoughnessMap, vUv).g;
#endif
#ifdef USE_METALNESSMAP
  metalness *= texture(uMetalnessMap, vUv).b;
#endif
#ifdef USE_TRANSMISSIONMAP
  transmission *= texture(uTransmissionMap, vUv).r;
#endif
#ifdef USE_CLEARCOATMAP
  clearcoat *= texture(uClearcoatMap, vUv).r;
#endif
#ifdef USE_NORMALMAP
  normal = perturbNormal2Arb(-vViewPosition, normal, vUv, uNormalScale, uNormalMap);
#endif

  float alpha = diffuseColor.a;
#ifdef USE_ALPHAMAP
  alpha *= texture(uAlphaMap, vUv).r;
#endif
#ifdef ALPHATEST
  if (alpha < uAlphaTest) discard;
#endif

  float f0Scalar = pow((uIor - 1.0) / (uIor + 1.0), 2.0);
  vec3 baseSpecular = mix(vec3(f0Scalar), diffuseColor.rgb, saturate(metalness)) * uSpecularIntensity * uSpecularColor;

  vec3 ambient = uAmbientLightColor * diffuseColor.rgb * uSpecularIntensity;
  vec3 outgoing = vec3(0.0);
  for (int i = 0; i < MAX_DIRECTIONAL_LIGHTS; i++) {
    if (i >= uDirectionalLightCount) break;
    vec3 lightDir = normalize(uDirectionalLightDirections[i]);
    vec3 lightColor = uDirectionalLightColors[i];
    vec3 contribution = physicalShading(
      diffuseColor.rgb * uSpecularColor,
      saturate(metalness),
      saturate(roughness),
      normal,
      viewDir,
      lightDir,
      lightColor,
      ambient
    );

    if (clearcoat > 0.0) {
      vec3 clearcoatNormal = normal;
#ifdef USE_CLEARCOATNORMALMAP
      clearcoatNormal = perturbNormal2Arb(-vViewPosition, normal, vUv, vec2(1.0), uClearcoatNormalMap);
#endif
      vec3 H = safeNormalize(lightDir + viewDir);
      float ndoth = max(dot(clearcoatNormal, H), 0.0);
      float ndotl = max(dot(clearcoatNormal, lightDir), 0.0);
      float gloss = mix(0.04, 1.0, 1.0 - saturate(uClearcoatRoughness));
      contribution += lightColor * ndotl * clearcoat * gloss *
        pow(ndoth, mix(4.0, 256.0, 1.0 - saturate(uClearcoatRoughness)));
    }

    if (uSheen > 0.0) {
      contribution += sheenLobe(normal, viewDir, lightDir, uSheenColor, uSheenRoughness) * uSheen * lightColor;
    }

    outgoing += contribution;
  }
  if (uDirectionalLightCount <= 0) outgoing = ambient;

  if (uIridescence > 0.0) {
    outgoing *= iridescenceTint(max(dot(normal, viewDir), 0.0), uIridescence);
  }

  if (transmission > 0.0) {
    float thickness = uThickness;
#ifdef USE_THICKNESSMAP
    thickness *= texture(uThicknessMap, vUv).g;
#endif
    vec3 transmitted = volumeAttenuation(thickness, uAttenuationColor) * diffuseColor.rgb;
#ifdef USE_ENVMAP
    transmitted *= texture(uEnvMap, reflect(-viewDir, normal).xy * 0.5 + 0.5).rgb * uEnvMapIntensity;
#endif
    if (uAttenuationDistance > 0.0) {
      transmitted = mix(transmitted, uAttenuationColor, saturate(thickness / uAttenuationDistance));
    }
    outgoing = mix(outgoing, transmitted, saturate(transmission));
  }

  vec3 emissive = uEmissive * uEmissiveIntensity;
#ifdef USE_EMISSIVEMAP
  emissive *= texture(uEmissiveMap, vUv).rgb;
#endif
  outgoing += emissive;

#ifdef USE_AOMAP
  outgoing *= texture(uAoMap, vUv).r;
#endif

  outgoing = applyColorSpace(outgoing);
#ifdef USE_FOG
  outgoing = applyFog(outgoing, vFogDepth);
#endif

  fragColor = vec4(outgoing, alpha * mix(1.0, 0.35, saturate(transmission)));
}
`,
};
