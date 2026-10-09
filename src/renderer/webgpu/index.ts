/**
 * WebGPU backend.
 *
 * A complete WebGPU implementation of the renderer contracts:
 *
 * - {@link WebGPURenderer} — the `AbstractRenderer` implementation;
 * - {@link WebGPUAdapter}/{@link WebGPUDevice} — adapter and device acquisition with a
 *   `requestDeviceSafe` fallback, staging buffers and deferred destruction;
 * - {@link WebGPUSwapChain} — canvas configuration with the format probe;
 * - {@link WebGPUShader}/{@link WebGPUPipeline} — WGSL modules with validation-error
 *   surfacing, and cached pipelines with cached layouts;
 * - {@link WebGPUBuffer}/{@link WebGPUTexture}/{@link WebGPURenderTarget} — resources,
 *   including alignment handling and MSAA resolve targets;
 * - {@link WebGPUCompute} — compute pipelines, validated dispatch and timestamps;
 * - {@link WebGPUState}/{@link WebGPUUtils} — the state deduplicator and the
 *   enumeration/alignment helpers.
 *
 * Nothing here imports `src/materials`, `src/textures`, `src/shaders` or `src/scene`;
 * everything those layers provide is consumed through structural interfaces, and the
 * WebGPU handles are described structurally because the project ships no
 * `@webgpu/types` dependency.
 *
 * @packageDocumentation
 */

export * from './WebGPUUtils';
export * from './WebGPUAdapter';
export * from './WebGPUDevice';
export * from './WebGPUSwapChain';
export * from './WebGPUShader';
export * from './WebGPUPipeline';
export * from './WebGPUBuffer';
export * from './WebGPUTexture';
export * from './WebGPURenderTarget';
export * from './WebGPUCompute';
export * from './WebGPUState';
export * from './WebGPURenderer';
