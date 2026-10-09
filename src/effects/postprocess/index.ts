/**
 * `effects/postprocess` — the pass chain and every pass that ships with it.
 *
 * | Pass | Effect |
 * | --- | --- |
 * | {@link RenderPass} | draws the scene; the first pass in a chain |
 * | {@link ShaderPass} | any full-screen fragment shader |
 * | {@link BloomPass} | soft-knee threshold, blur, additive combine |
 * | {@link BlurPass} | separable Gaussian, or dual-filter Kawase |
 * | {@link FXAAPass} | luma-based edge antialiasing |
 * | {@link SSAOPass} | hemisphere-sampled ambient occlusion |
 * | {@link OutlinePass} | mask dilation and subtraction |
 * | {@link FunctionPass} | a pass from a callback |
 *
 * Every pass extends {@link Pass} and implements the real `IRenderPass`, so a chain can be
 * driven by `EffectComposer` or by the core `RenderPipeline`.
 *
 * @packageDocumentation
 */

export * from './Pass';
export * from './EffectComposer';
export * from './RenderPass';
export * from './ShaderPass';
export * from './BlurPass';
export * from './BloomPass';
export * from './FXAAPass';
export * from './SSAOPass';
export * from './OutlinePass';
