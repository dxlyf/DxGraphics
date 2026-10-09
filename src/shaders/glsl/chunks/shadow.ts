/**
 * GLSL shadow sampling with a 3x3 PCF kernel.
 *
 * A regular `sampler2D` is used instead of `sampler2DShadow` so the same chunk
 * works whether the backend allocates a depth texture (`DEPTH_COMPONENT`) or a
 * colour-encoded depth target.
 *
 * @packageDocumentation
 */

/** Percentage-closer-filtered shadow lookup. */
/* glsl */
export const shadow = `
#include <common>
#include <math>

float sampleShadowMap(sampler2D shadowMap, vec2 uv, float compare) {
  float depth = texture(shadowMap, uv).r;
  return step(compare, depth);
}

float getShadow(sampler2D shadowMap, vec2 shadowCoord, float bias, vec2 texelSize) {
  float sum = 0.0;
  sum += sampleShadowMap(shadowMap, shadowCoord + texelSize * vec2(-1.0, -1.0), bias);
  sum += sampleShadowMap(shadowMap, shadowCoord + texelSize * vec2(0.0, -1.0), bias);
  sum += sampleShadowMap(shadowMap, shadowCoord + texelSize * vec2(1.0, -1.0), bias);
  sum += sampleShadowMap(shadowMap, shadowCoord + texelSize * vec2(-1.0, 0.0), bias);
  sum += sampleShadowMap(shadowMap, shadowCoord, bias);
  sum += sampleShadowMap(shadowMap, shadowCoord + texelSize * vec2(1.0, 0.0), bias);
  sum += sampleShadowMap(shadowMap, shadowCoord + texelSize * vec2(-1.0, 1.0), bias);
  sum += sampleShadowMap(shadowMap, shadowCoord + texelSize * vec2(0.0, 1.0), bias);
  sum += sampleShadowMap(shadowMap, shadowCoord + texelSize * vec2(1.0, 1.0), bias);
  return sum / 9.0;
}
`;
