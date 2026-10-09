/**
 * WGSL shadow sampling with a 3x3 PCF kernel.
 *
 * A plain `texture_2d<f32>` is sampled and compared by hand instead of using a
 * `texture_depth_2d`, so the same chunk works for backends that store depth as
 * colour.
 *
 * @packageDocumentation
 */

/** Percentage-closer-filtered shadow lookup. */
/* wgsl */
export const shadow = `
//!include common
//!include math

fn sampleShadowMap(shadowMap: texture_2d<f32>, shadowSampler: sampler, uv: vec2<f32>, compare: f32) -> f32 {
  let depth = textureSample(shadowMap, shadowSampler, uv).r;
  return step(compare, depth);
}

fn getShadow(
  shadowMap: texture_2d<f32>,
  shadowSampler: sampler,
  shadowCoord: vec2<f32>,
  bias: f32,
  texelSize: vec2<f32>
) -> f32 {
  var sum = 0.0;
  sum += sampleShadowMap(shadowMap, shadowSampler, shadowCoord + texelSize * vec2<f32>(-1.0, -1.0), bias);
  sum += sampleShadowMap(shadowMap, shadowSampler, shadowCoord + texelSize * vec2<f32>(0.0, -1.0), bias);
  sum += sampleShadowMap(shadowMap, shadowSampler, shadowCoord + texelSize * vec2<f32>(1.0, -1.0), bias);
  sum += sampleShadowMap(shadowMap, shadowSampler, shadowCoord + texelSize * vec2<f32>(-1.0, 0.0), bias);
  sum += sampleShadowMap(shadowMap, shadowSampler, shadowCoord, bias);
  sum += sampleShadowMap(shadowMap, shadowSampler, shadowCoord + texelSize * vec2<f32>(1.0, 0.0), bias);
  sum += sampleShadowMap(shadowMap, shadowSampler, shadowCoord + texelSize * vec2<f32>(-1.0, 1.0), bias);
  sum += sampleShadowMap(shadowMap, shadowSampler, shadowCoord + texelSize * vec2<f32>(0.0, 1.0), bias);
  sum += sampleShadowMap(shadowMap, shadowSampler, shadowCoord + texelSize * vec2<f32>(1.0, 1.0), bias);
  return sum / 9.0;
}
`;
