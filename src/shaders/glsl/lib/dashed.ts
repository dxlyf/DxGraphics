/**
 * GLSL dashed-line program.
 *
 * Declares `uColor`, `uOpacity`, `uDashSize`, `uGapSize`, `uTotalSize`,
 * `uScale`, `uModelViewMatrix`, `uProjectionMatrix` and the fog uniforms. The
 * dash pattern is evaluated from an arc-length varying, so the dash length is
 * independent of the segment length. Gated by `USE_DASHED`, `USE_FOG` and
 * `USE_VERTEX_COLORS`.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Line program with a dash/gap pattern. */
/* glsl */
export const dashedShader: ShaderDescriptor = {
  name: 'glsl/dashed',
  language: 'glsl',
  defines: { USE_DASHED: true },
  uniforms: {
    uProjectionMatrix: 'mat4',
    uModelViewMatrix: 'mat4',
    uColor: 'color',
    uOpacity: 'float',
    uDashSize: 'float',
    uGapSize: 'float',
    uTotalSize: 'float',
    uScale: 'float',
    uFogColor: 'color',
    uFogNear: 'float',
    uFogFar: 'float',
    uFogDensity: 'float',
  },
  attributes: { position: 'vec3', lineDistance: 'float' },
  vertex: `
#include <common>

#define USE_DASHED

layout(location = 0) in vec3 position;
layout(location = 7) in float lineDistance;

uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;
uniform float uScale;

out float vLineDistance;
#ifdef USE_VERTEX_COLORS
out vec3 vColor;
#endif
#ifdef USE_FOG
out float vFogDepth;
#endif

void main() {
  vec4 mvPosition = uModelViewMatrix * vec4(position, 1.0);
  gl_Position = uProjectionMatrix * mvPosition;

  vLineDistance = uScale * lineDistance;

#ifdef USE_FOG
  vFogDepth = -mvPosition.z;
#endif
}
`,
  fragment: `
#include <common>
#include <fog>

uniform vec3 uColor;
uniform float uOpacity;
uniform float uDashSize;
uniform float uGapSize;
uniform float uTotalSize;

in float vLineDistance;
#ifdef USE_VERTEX_COLORS
in vec3 vColor;
#endif
#ifdef USE_FOG
in float vFogDepth;
#endif

out vec4 fragColor;

void main() {
  float period = max(uDashSize + uGapSize, EPSILON);
  float positionInPattern = mod(vLineDistance, period);

  // uTotalSize lets the renderer fade the pattern out at long distances,
  // which hides the aliasing a hairline dash pattern would otherwise show.
  float pattern = step(positionInPattern, min(uDashSize, uTotalSize));
  if (pattern < 0.5) discard;

  vec3 outgoing = uColor;
#ifdef USE_VERTEX_COLORS
  outgoing *= vColor;
#endif

  outgoing = applyColorSpace(outgoing);
#ifdef USE_FOG
  outgoing = applyFog(outgoing, vFogDepth);
#endif

  fragColor = vec4(outgoing, uOpacity);
}
`,
};
