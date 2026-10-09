/**
 * GLSL texture-coordinate helpers.
 *
 * The chunk declares the `uUvTransform` uniform only when `USE_UV_TRANSFORM` is
 * defined, so a program that never transforms UVs does not carry a uniform the
 * renderer would have to initialise.
 *
 * Varying declarations stay in the individual programs: a chunk is included by
 * both the vertex and the fragment stage, and GLSL requires different storage
 * qualifiers for each.
 *
 * @packageDocumentation
 */

/** UV transform uniform plus the `transformUv` helper. */
/* glsl */
export const uv = `
#ifdef USE_UV_TRANSFORM
uniform mat3 uUvTransform;
#endif

vec2 transformUv(vec2 value) {
#ifdef USE_UV_TRANSFORM
  return (uUvTransform * vec3(value, 1.0)).xy;
#else
  return value;
#endif
}
`;
