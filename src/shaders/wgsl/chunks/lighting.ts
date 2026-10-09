/**
 * WGSL lighting helpers, from Lambert diffuse to metallic-roughness PBR.
 *
 * @packageDocumentation
 */

/** Diffuse, Blinn-Phong and physically based shading helpers. */
/* wgsl */
export const lighting = `
//!include common
//!include math

fn lambertDiffuse(albedo: vec3<f32>, normal: vec3<f32>, lightDir: vec3<f32>) -> vec3<f32> {
  let ndotl = max(dot(normal, lightDir), 0.0);
  return albedo * ndotl;
}

fn blinnPhong(
  albedo: vec3<f32>,
  specular: vec3<f32>,
  shininess: f32,
  normal: vec3<f32>,
  lightDir: vec3<f32>,
  viewDir: vec3<f32>
) -> vec3<f32> {
  let H = safeNormalize3(lightDir + viewDir);
  let ndotl = max(dot(normal, lightDir), 0.0);
  let ndoth = max(dot(normal, H), 0.0);
  let spec = pow(ndoth, max(shininess, EPSILON));
  return albedo * ndotl + specular * spec * step(EPSILON, ndotl);
}

fn fresnelSchlick(cosTheta: f32, f0: f32) -> f32 {
  return f0 + (1.0 - f0) * pow5(saturate(1.0 - cosTheta));
}

fn fresnelSchlickVec(cosTheta: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow5(saturate(1.0 - cosTheta));
}

fn distributionGGX(n: vec3<f32>, h: vec3<f32>, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let ndoth = max(dot(n, h), 0.0);
  let d = ndoth * ndoth * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, EPSILON);
}

fn geometrySchlickGGX(ndotv: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return ndotv / max(ndotv * (1.0 - k) + k, EPSILON);
}

fn geometrySmith(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, roughness: f32) -> f32 {
  return geometrySchlickGGX(max(dot(n, v), 0.0), roughness) *
         geometrySchlickGGX(max(dot(n, l), 0.0), roughness);
}

fn fresnelSchlickRoughness(cosTheta: f32, f0: vec3<f32>, roughness: f32) -> vec3<f32> {
  let fr = max(vec3<f32>(1.0 - roughness), f0);
  return f0 + (fr - f0) * pow5(saturate(1.0 - cosTheta));
}

fn physicalShading(
  albedo: vec3<f32>,
  metalness: f32,
  roughness: f32,
  normal: vec3<f32>,
  viewDir: vec3<f32>,
  lightDir: vec3<f32>,
  lightColor: vec3<f32>,
  ambient: vec3<f32>
) -> vec3<f32> {
  let rough = max(roughness, 0.045);
  let H = safeNormalize3(lightDir + viewDir);
  let ndotl = max(dot(normal, lightDir), 0.0);
  let ndotv = max(dot(normal, viewDir), 0.0);

  let f0 = mix(vec3<f32>(0.04), albedo, metalness);
  let F = fresnelSchlickVec(max(dot(H, viewDir), 0.0), f0);
  let D = distributionGGX(normal, H, rough);
  let G = geometrySmith(normal, viewDir, lightDir, rough);

  let specular = (D * G) * F / max(4.0 * ndotv * ndotl, EPSILON);
  let diffuse = (vec3<f32>(1.0) - F) * (1.0 - metalness) * albedo / PI;
  let direct = (diffuse + specular) * lightColor * ndotl;

  let Fenv = fresnelSchlickRoughness(ndotv, f0, rough);
  let envDiffuse = (vec3<f32>(1.0) - Fenv) * (1.0 - metalness) * albedo;
  let envSpecular = Fenv * mix(vec3<f32>(0.04), albedo, metalness);
  return direct + ambient * (envDiffuse + envSpecular);
}
`;
