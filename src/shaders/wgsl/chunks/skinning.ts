/**
 * WGSL skeletal skinning.
 *
 * WGSL forbids dynamic indexing of a uniform array with a non-constant value in
 * several implementations, so the helpers gather the four weighted bone matrices
 * with explicit comparisons rather than `boneMatrices[index]`.
 *
 * @packageDocumentation
 */

/** Bone-matrix helpers driven by a uniform array. */
/* wgsl */
export const skinning = `
//!include common

fn boneMatrixAt(boneMatrices: array<mat4x4<f32>, 32>, index: i32) -> mat4x4<f32> {
  let clamped = clamp(index, 0, 31);
  var bone = mat4x4<f32>(
    vec4<f32>(1.0, 0.0, 0.0, 0.0),
    vec4<f32>(0.0, 1.0, 0.0, 0.0),
    vec4<f32>(0.0, 0.0, 1.0, 0.0),
    vec4<f32>(0.0, 0.0, 0.0, 1.0)
  );
  for (var i = 0; i < 32; i = i + 1) {
    if (i == clamped) {
      bone = boneMatrices[i];
    }
  }
  return bone;
}

fn skinnedPosition(
  position: vec3<f32>,
  skinIndex: vec4<f32>,
  skinWeight: vec4<f32>,
  boneMatrices: array<mat4x4<f32>, 32>
) -> vec3<f32> {
  let skinVertex = vec4<f32>(position, 1.0);
  var result = vec4<f32>(0.0);
  result += boneMatrixAt(boneMatrices, i32(skinIndex.x)) * skinVertex * skinWeight.x;
  result += boneMatrixAt(boneMatrices, i32(skinIndex.y)) * skinVertex * skinWeight.y;
  result += boneMatrixAt(boneMatrices, i32(skinIndex.z)) * skinVertex * skinWeight.z;
  result += boneMatrixAt(boneMatrices, i32(skinIndex.w)) * skinVertex * skinWeight.w;
  return result.xyz;
}

fn skinnedNormal(
  normal: vec3<f32>,
  skinIndex: vec4<f32>,
  skinWeight: vec4<f32>,
  boneMatrices: array<mat4x4<f32>, 32>
) -> vec3<f32> {
  let skinVertex = vec4<f32>(normal, 0.0);
  var result = vec4<f32>(0.0);
  result += boneMatrixAt(boneMatrices, i32(skinIndex.x)) * skinVertex * skinWeight.x;
  result += boneMatrixAt(boneMatrices, i32(skinIndex.y)) * skinVertex * skinWeight.y;
  result += boneMatrixAt(boneMatrices, i32(skinIndex.z)) * skinVertex * skinWeight.z;
  result += boneMatrixAt(boneMatrices, i32(skinIndex.w)) * skinVertex * skinWeight.w;
  return result.xyz;
}
`;
