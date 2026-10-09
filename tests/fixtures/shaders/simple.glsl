#version 300 es

/*
 * A minimal GLSL ES 3.00 vertex + fallback fragment pair used by the fixture tests and
 * by tools/shader-compiler. Kept deliberately tiny: it has one attribute, one uniform
 * and one varying, which is the smallest shader that still exercises every structural
 * check the validator performs.
 *
 * This file is a vertex shader, so it has no `precision` declaration and no
 * `gl_FragColor`; the validator must not ask for either.
 */

in vec3 position;
in vec3 normal;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;

out vec3 vNormal;

void main() {
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
