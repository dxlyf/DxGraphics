/**
 * WGSL texture-coordinate helpers.
 *
 * Unlike the GLSL chunk — which can rely on a `#define` — WGSL passes the
 * transform explicitly, so the caller can substitute an identity matrix when no
 * UV transform is in play.
 *
 * @packageDocumentation
 */

/** Varying block and the `transformUv` helper. */
/* wgsl */
export const uv = `
struct UvVaryings {
  vUv: vec2<f32>,
  vUv2: vec2<f32>,
}

fn transformUv(value: vec2<f32>, uvTransform: mat3x3<f32>) -> vec2<f32> {
  return (uvTransform * vec3<f32>(value, 1.0)).xy;
}
`;
