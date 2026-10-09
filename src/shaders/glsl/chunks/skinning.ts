/**
 * GLSL skeletal skinning.
 *
 * `MAX_BONES` is defined by the injected defines when a material uses skinning;
 * the chunk falls back to 32 so it stays self-contained.
 *
 * @packageDocumentation
 */

/** Bone-matrix uniforms and the skinning helpers. */
/* glsl */
export const skinning = `
#ifndef MAX_BONES
#define MAX_BONES 32
#endif

#ifdef USE_SKINNING
uniform mat4 uBoneMatrices[MAX_BONES];

mat4 getBoneMatrix(int index) {
  int clamped = clamp(index, 0, MAX_BONES - 1);
  mat4 bone = mat4(1.0);
  for (int i = 0; i < MAX_BONES; i++) {
    bone = (i == clamped) ? uBoneMatrices[i] : bone;
  }
  return bone;
}

vec3 skinnedPosition(vec3 position, vec4 skinIndex, vec4 skinWeight) {
  vec4 skinVertex = vec4(position, 1.0);
  vec4 result = vec4(0.0);
  result += getBoneMatrix(int(skinIndex.x)) * skinVertex * skinWeight.x;
  result += getBoneMatrix(int(skinIndex.y)) * skinVertex * skinWeight.y;
  result += getBoneMatrix(int(skinIndex.z)) * skinVertex * skinWeight.z;
  result += getBoneMatrix(int(skinIndex.w)) * skinVertex * skinWeight.w;
  return result.xyz;
}

vec3 skinnedNormal(vec3 normal, vec4 skinIndex, vec4 skinWeight) {
  vec4 skinVertex = vec4(normal, 0.0);
  vec4 result = vec4(0.0);
  result += getBoneMatrix(int(skinIndex.x)) * skinVertex * skinWeight.x;
  result += getBoneMatrix(int(skinIndex.y)) * skinVertex * skinWeight.y;
  result += getBoneMatrix(int(skinIndex.z)) * skinVertex * skinWeight.z;
  result += getBoneMatrix(int(skinIndex.w)) * skinVertex * skinWeight.w;
  return result.xyz;
}
#endif
`;
