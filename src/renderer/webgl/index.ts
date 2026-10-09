/**
 * WebGL backend.
 *
 * A complete WebGL2/WebGL1 implementation of the renderer contracts:
 *
 * - {@link WebGLRenderer} — the `AbstractRenderer` implementation;
 * - {@link WebGLContext} — context acquisition and the context-loss strategy;
 * - {@link WebGLState} — the redundant-state-change eliminator;
 * - {@link WebGLProgram}/{@link WebGLShader} — compilation, reflection and the LRU
 *   program cache;
 * - {@link WebGLBuffer}/{@link WebGLAttributes}/{@link WebGLVertexArray} — the
 *   vertex data path;
 * - {@link WebGLTexture}/{@link WebGLFramebuffer}/{@link WebGLRenderTarget} — the
 *   texture and render-to-texture path;
 * - {@link WebGLUniforms} — uniform reflection and upload;
 * - {@link WebGLCapabilities}/{@link WebGLExtensions}/{@link WebGLUtils} — the
 *   feature-detection and translation layer.
 *
 * Nothing here imports `src/materials`, `src/textures`, `src/shaders` or
 * `src/scene`; everything those layers provide is consumed through the structural
 * interfaces declared alongside the class that needs them.
 *
 * @packageDocumentation
 */

export * from './WebGLUtils';
export * from './WebGLCapabilities';
export * from './WebGLExtensions';
export * from './WebGLState';
export * from './WebGLShader';
export * from './WebGLUniforms';
export * from './WebGLProgram';
export * from './WebGLBuffer';
export * from './WebGLVertexArray';
export * from './WebGLAttributes';
export * from './WebGLTexture';
export * from './WebGLFramebuffer';
export * from './WebGLRenderTarget';
export * from './WebGLContext';
export * from './WebGLRenderer';
