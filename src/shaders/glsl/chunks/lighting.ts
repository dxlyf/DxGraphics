/**
 * GLSL lighting helpers, from Lambert diffuse to metallic-roughness PBR.
 *
 * Every helper is `#ifdef`-free: a program includes this chunk only when it
 * actually shades, and the unused functions are eliminated by the driver.
 *
 * @packageDocumentation
 */

/** Diffuse, Blinn-Phong and physically based shading helpers. */
/* glsl */
export const lighting = `
#include <common>
#include <math>

vec3 lambertDiffuse(vec3 albedo, vec3 normal, vec3 lightDir) {
  float ndotl = max(dot(normal, lightDir), 0.0);
  return albedo * ndotl;
}

vec3 blinnPhong(vec3 albedo, vec3 specular, float shininess, vec3 normal, vec3 lightDir, vec3 viewDir) {
  vec3 H = safeNormalize(lightDir + viewDir);
  float ndotl = max(dot(normal, lightDir), 0.0);
  float ndoth = max(dot(normal, H), 0.0);
  float spec = pow(ndoth, max(shininess, EPSILON));
  return albedo * ndotl + specular * spec * step(EPSILON, ndotl);
}

float fresnelSchlick(float cosTheta, float f0) {
  return f0 + (1.0 - f0) * pow5(saturate(1.0 - cosTheta));
}

vec3 fresnelSchlickVec(float cosTheta, vec3 f0) {
  return f0 + (vec3(1.0) - f0) * pow5(saturate(1.0 - cosTheta));
}

float distributionGGX(vec3 n, vec3 h, float roughness) {
  float a = roughness * roughness;
  float a2 = a * a;
  float ndoth = max(dot(n, h), 0.0);
  float d = ndoth * ndoth * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, EPSILON);
}

float geometrySchlickGGX(float ndotv, float roughness) {
  float r = roughness + 1.0;
  float k = (r * r) / 8.0;
  return ndotv / max(ndotv * (1.0 - k) + k, EPSILON);
}

float geometrySmith(vec3 n, vec3 v, vec3 l, float roughness) {
  return geometrySchlickGGX(max(dot(n, v), 0.0), roughness) *
         geometrySchlickGGX(max(dot(n, l), 0.0), roughness);
}

vec3 fresnelSchlickRoughness(float cosTheta, vec3 f0, float roughness) {
  vec3 fr = max(vec3(1.0 - roughness), f0);
  return f0 + (fr - f0) * pow5(saturate(1.0 - cosTheta));
}

vec3 physicalShading(
  vec3 albedo,
  float metalness,
  float roughness,
  vec3 normal,
  vec3 viewDir,
  vec3 lightDir,
  vec3 lightColor,
  vec3 ambient
) {
  float rough = max(roughness, 0.045);
  vec3 H = safeNormalize(lightDir + viewDir);
  float ndotl = max(dot(normal, lightDir), 0.0);
  float ndotv = max(dot(normal, viewDir), 0.0);

  vec3 f0 = mix(vec3(0.04), albedo, metalness);
  vec3 F = fresnelSchlickVec(max(dot(H, viewDir), 0.0), f0);
  float D = distributionGGX(normal, H, rough);
  float G = geometrySmith(normal, viewDir, lightDir, rough);

  vec3 specular = (D * G) * F / max(4.0 * ndotv * ndotl, EPSILON);
  vec3 diffuse = (vec3(1.0) - F) * (1.0 - metalness) * albedo / PI;
  vec3 direct = (diffuse + specular) * lightColor * ndotl;

  vec3 Fenv = fresnelSchlickRoughness(ndotv, f0, rough);
  vec3 envDiffuse = (vec3(1.0) - Fenv) * (1.0 - metalness) * albedo;
  vec3 envSpecular = Fenv * mix(vec3(0.04), albedo, metalness);
  return direct + ambient * (envDiffuse + envSpecular);
}
`;
