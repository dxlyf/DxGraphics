/**
 * GLSL point-sprite helpers.
 *
 * @packageDocumentation
 */

/** Size-attenuation maths for `gl_PointSize`. */
/* glsl */
export const points = `
#include <common>

float pointSizeForDepth(float size, bool attenuated, float depth) {
  if (!attenuated) return size;
  return size / max(depth, EPSILON);
}
`;
