/**
 * WGSL point-sprite helpers.
 *
 * @packageDocumentation
 */

/** Size-attenuation maths for the point-size builtin. */
/* wgsl */
export const points = `
//!include common

fn pointSizeForDepth(size: f32, attenuated: bool, depth: f32) -> f32 {
  if (!attenuated) {
    return size;
  }
  return size / max(depth, EPSILON);
}
`;
