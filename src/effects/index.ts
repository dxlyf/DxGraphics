/**
 * `effects` — post-processing, shadows, fog and particles.
 *
 * ```ts
 * import { EffectComposer, RenderPass, BloomPass, FXAAPass, ShadowMap, Fog, ParticleSystem } from '@dxyl/graphics';
 *
 * const composer = new EffectComposer(renderer);
 * composer.addPass(new RenderPass(scene, camera));
 * composer.addPass(new BloomPass({ threshold: 0.85 }));
 * composer.addPass(new FXAAPass());
 * composer.render(clock.getDelta());
 * ```
 *
 * ## Independence from the renderer, materials and textures
 *
 * Every interaction with those subsystems goes through a **structural interface** declared
 * in {@link types} — `RendererLike`, `MaterialLike`, `TextureLike`, `ShaderDescriptorLike`,
 * `LightLike`. That is what lets the whole effects layer compile and unit-test while
 * `src/renderer/webgl`, `src/renderer/webgpu`, `src/materials`, `src/textures` and
 * `src/shaders` are still being written by other agents. It also means no effect here can
 * break when one of those modules changes shape.
 *
 * ## Shader code is data
 *
 * Every GLSL and WGSL snippet is a **string constant** exported from the module that owns
 * it ({@link FOG_LINEAR_CHUNK}, {@link BLOOM_THRESHOLD_CHUNK}, {@link FXAA_CHUNK},
 * {@link SSAO_CHUNK}, {@link OUTLINE_MASK_CHUNK}, {@link KAWASE_BLUR_CHUNK},
 * {@link GAUSSIAN_BLUR_CHUNK}, {@link WGSL_FOG_CHUNK}). Nothing imports a `.glsl` or `.wgsl`
 * file, so the package has no shader asset dependency.
 *
 * ## Headless by construction
 *
 * Every renderer call is guarded, `EffectComposer.render` accepts a bare delta as well as a
 * `RenderContext`, and the passes publish their state into `context.values` when no renderer
 * is attached. Adding three fake passes, rendering, and asserting the order and the buffer
 * swaps works with no GPU at all — which is what the test suite does.
 *
 * @packageDocumentation
 */

export * from './postprocess/index';
export * from './shadows/index';
export * from './fog/index';
export * from './particles/index';
export type * from './types';
