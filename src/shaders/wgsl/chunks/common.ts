/**
 * Common WGSL helpers: constants, saturating math and component utilities.
 *
 * WGSL has no function overloading, so the vector forms are explicitly suffixed
 * (`saturate3`, `saturate4`, ...) instead of sharing the scalar name.
 *
 * @packageDocumentation
 */

/** Constants and scalar/vector helpers shared by every WGSL program. */
/* wgsl */
export const common = `
const PI: f32 = 3.141592653589793;
const PI2: f32 = 6.283185307179586;
const HALF_PI: f32 = 1.5707963267948966;
const EPSILON: f32 = 1e-6;

// ---------------------------------------------------------------------------
// Material flag word (uFlags, binding 42).
//
// WGSL cannot put a bool in a uniform buffer, so every boolean material
// switch travels as one bit of a u32. The bit assignment is the same in every
// built-in program:
//   0  use diffuse map          8  exponential fog
//   1  use alpha map            9  fog enabled
//   2  linear-to-sRGB output   10  size attenuation
//   3  instancing              11  flat shading
//   4  vertex colours          12  normal map
//   5  UV transform            13  roughness map
//   6  alpha test              14  metalness map
//   7  environment map         15  light map
//                              16  ambient-occlusion map
//                              17  specular map
//                              18  emissive map
//                              19  bump map
//                              20  displacement map
// ---------------------------------------------------------------------------
const FLAG_USE_MAP: u32 = 1u << 0u;
const FLAG_USE_ALPHA_MAP: u32 = 1u << 1u;
const FLAG_LINEAR_TO_SRGB: u32 = 1u << 2u;
const FLAG_INSTANCING: u32 = 1u << 3u;
const FLAG_VERTEX_COLORS: u32 = 1u << 4u;
const FLAG_UV_TRANSFORM: u32 = 1u << 5u;
const FLAG_ALPHA_TEST: u32 = 1u << 6u;
const FLAG_ENV_MAP: u32 = 1u << 7u;
const FLAG_FOG_EXP2: u32 = 1u << 8u;
const FLAG_FOG: u32 = 1u << 9u;
const FLAG_SIZE_ATTENUATION: u32 = 1u << 10u;
const FLAG_FLAT_SHADING: u32 = 1u << 11u;
const FLAG_NORMAL_MAP: u32 = 1u << 12u;
const FLAG_ROUGHNESS_MAP: u32 = 1u << 13u;
const FLAG_METALNESS_MAP: u32 = 1u << 14u;
const FLAG_LIGHT_MAP: u32 = 1u << 15u;
const FLAG_AO_MAP: u32 = 1u << 16u;
const FLAG_SPECULAR_MAP: u32 = 1u << 17u;
const FLAG_EMISSIVE_MAP: u32 = 1u << 18u;
const FLAG_BUMP_MAP: u32 = 1u << 19u;
const FLAG_DISPLACEMENT_MAP: u32 = 1u << 20u;

// True when every bit of mask is set in flags.
fn flagSet(flags: u32, mask: u32) -> bool {
  return (flags & mask) == mask;
}

fn saturate(x: f32) -> f32 {
  return clamp(x, 0.0, 1.0);
}

fn saturate3(v: vec3<f32>) -> vec3<f32> {
  return clamp(v, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn saturate4(v: vec4<f32>) -> vec4<f32> {
  return clamp(v, vec4<f32>(0.0), vec4<f32>(1.0));
}

fn luminance(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn sq(v: f32) -> f32 {
  return v * v;
}

fn pow2(v: f32) -> f32 {
  return v * v;
}

fn pow3(v: f32) -> f32 {
  return v * v * v;
}

fn maxComponent3(v: vec3<f32>) -> f32 {
  return max(v.x, max(v.y, v.z));
}

fn minComponent3(v: vec3<f32>) -> f32 {
  return min(v.x, min(v.y, v.z));
}

fn whiteComplement(c: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(1.0) - saturate3(c);
}
`;
