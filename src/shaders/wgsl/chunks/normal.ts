/**
 * WGSL tangent-space normal mapping.
 *
 * Both helpers derive the tangent frame from screen-space derivatives, so no
 * tangent attribute is required: `perturbNormal2Arb` rebuilds the TBN matrix from
 * `dpdx`/`dpdy` of the view position and the UV set. The sampled tangent-space
 * normal is passed in rather than sampled here, because WGSL requires the texture
 * binding to be visible at the call site.
 *
 * @packageDocumentation
 */

/** Derivative-based TBN construction and normal-map perturbation. */
/* wgsl */
export const normal = `
//!include math

fn tbnFromDerivatives(
  normal: vec3<f32>,
  position: vec3<f32>,
  uv: vec2<f32>,
  dpdx: vec3<f32>,
  dpdy: vec3<f32>
) -> mat3x3<f32> {
  let st0 = vec2<f32>(dpdx(uv));
  let st1 = vec2<f32>(dpdy(uv));
  let S = normalize(dpdx * st1.y - dpdy * st0.y);
  let T = normalize(-dpdx * st1.x + dpdy * st0.x);
  let N = safeNormalize3(normal);
  return mat3x3<f32>(S, T, N);
}

fn perturbNormal2Arb(
  eyePos: vec3<f32>,
  surfNormal: vec3<f32>,
  uvCoord: vec2<f32>,
  normalScale: vec2<f32>,
  tangentNormal: vec3<f32>
) -> vec3<f32> {
  let q0 = vec3<f32>(dpdx(eyePos));
  let q1 = vec3<f32>(dpdy(eyePos));
  let st0 = vec2<f32>(dpdx(uvCoord));
  let st1 = vec2<f32>(dpdy(uvCoord));

  let S = normalize(q0 * st1.y - q1 * st0.y);
  let T = normalize(-q0 * st1.x + q1 * st0.x);
  let N = safeNormalize3(surfNormal);
  let tsn = mat3x3<f32>(S, T, N);

  var mapN = tangentNormal * 2.0 - vec3<f32>(1.0);
  mapN = vec3<f32>(mapN.xy * normalScale, mapN.z);
  return normalize(tsn * mapN);
}
`;
