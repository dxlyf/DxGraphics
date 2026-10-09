/**
 * GLSL background program.
 *
 * Draws a full-screen triangle: a vertical gradient (or a flat colour) with an
 * optional environment sample, plus a dithering term that hides banding in the
 * gradient. Declares `uBackgroundColor`, `uBackgroundTop`, `uBackgroundBottom`,
 * `uBackgroundIntensity`, `uResolution` and `uEnvMap`. Gated by `USE_ENVMAP` and
 * `USE_BACKGROUND_GRADIENT`.
 *
 * @packageDocumentation
 */

import type { ShaderDescriptor } from '../../types';

/** Full-screen background/skybox program. */
/* glsl */
export const backgroundShader: ShaderDescriptor = {
  name: 'glsl/background',
  language: 'glsl',
  uniforms: {
    uBackgroundColor: 'color',
    uBackgroundTop: 'color',
    uBackgroundBottom: 'color',
    uBackgroundIntensity: 'float',
    uResolution: 'vec2',
    uEnvMap: 'texture',
  },
  attributes: { position: 'vec3', uv: 'vec2' },
  vertex: `
#include <common>

layout(location = 0) in vec3 position;
layout(location = 2) in vec2 uv;

out vec2 vUv;

void main() {
  // The caller supplies a full-screen triangle whose positions are already in
  // clip space, so no matrix is needed here.
  vUv = uv;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`,
  fragment: `
#include <common>
#include <math>

uniform vec3 uBackgroundColor;
uniform vec3 uBackgroundTop;
uniform vec3 uBackgroundBottom;
uniform float uBackgroundIntensity;
uniform vec2 uResolution;
#ifdef USE_ENVMAP
uniform sampler2D uEnvMap;
#endif

in vec2 vUv;

out vec4 fragColor;

void main() {
  vec3 background = uBackgroundColor;

#ifdef USE_BACKGROUND_GRADIENT
  background = mix(uBackgroundBottom, uBackgroundTop, saturate(vUv.y));
#endif
#ifdef USE_ENVMAP
  background *= texture(uEnvMap, vUv).rgb;
#endif

  // Ordered dithering: a triangle-wave offset of half a 1/255 step removes the
  // visible banding of a smooth vertical gradient on 8-bit targets.
  float dither = (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
  background = background * uBackgroundIntensity + dither;

  fragColor = vec4(background, 1.0);
}
`,
};
