/**
 * Renderer layer.
 *
 * The backend-agnostic contracts (`interfaces`), the shared implementation every
 * backend builds on (`core`), the CPU backends (`canvas2d`, `svg`), the GPU backends
 * (`webgl`, `webgpu`) and the plumbing shared by all of them (`utils`).
 *
 * ## Name resolution
 *
 * `Viewport` exists twice: `core` exports a mutable value class, `interfaces`
 * exports a structural interface. `export *` treats that as an ambiguity, so the
 * structural form is re-exported under the alias `ViewportLike` and the class
 * keeps the plain name. Everything else in `interfaces` is structural-only (or an
 * enum the class does not shadow) and is re-exported verbatim.
 *
 * `ColorInput` (from `utils/colorUtils`) and `ClearColorInput` (the alias in
 * `interfaces/types`) are distinct names and both survive.
 *
 * Every WebGL/WebGPU export is prefixed with its backend name, so the two GPU
 * backends contribute no ambiguous names to this barrel.
 *
 * @packageDocumentation
 */

export * from './interfaces/types';
export * from './interfaces/IRenderer';
export * from './interfaces/IRenderTarget';
export * from './interfaces/ITexture';
export * from './interfaces/IBuffer';
export * from './interfaces/IShader';
export * from './interfaces/IRenderPass';
export * from './interfaces/IPipeline';
export * from './interfaces/ICommandEncoder';

export * from './core';
export * from './utils';
export * from './canvas2d';
export * from './svg';
export * from './webgl';
export * from './webgpu';
