/**
 * Renderer interfaces: the backend-agnostic contracts every implementation and
 * every consumer agrees on.
 *
 * Nothing in this folder imports a concrete backend, so it can be consumed by
 * the scene layer, the WebGL/WebGPU backends and third-party code alike.
 *
 * @packageDocumentation
 */

export * from './types';

export * from './IRenderer';
export * from './IRenderTarget';
export * from './ITexture';
export * from './IBuffer';
export * from './IShader';
export * from './IRenderPass';
export * from './IPipeline';
export * from './ICommandEncoder';
