/**
 * The `DXYL` namespace object.
 *
 * Every module is re-exported under a stable name so that consumers can reach the
 * whole library through one import without polluting the global scope:
 *
 * ```ts
 * import { DXYL } from '@dxyl/graphics';
 * const mesh = new DXYL.scene.Mesh();
 * ```
 *
 * This module is deliberately **separate** from `src/index.ts`: importing it
 * eagerly pulls in every layer, so application code should prefer named imports
 * and let the bundler tree-shake. It exists for the playground, for interactive
 * consoles and for consumers that genuinely want the whole library at once.
 *
 * @packageDocumentation
 */

export * as animation from './animation';
export * as assets from './assets';
export * as constants from './constants';
export * as controls from './controls';
export * as core from './core';
export * as effects from './effects';
export * as geometry from './geometry';
export * as materials from './materials';
export * as math from './math';
export * as picking from './picking';
export * as renderer from './renderer';
export * as scene from './scene';
export * as shaders from './shaders';
export * as text from './text';
export * as textures from './textures';
export * as types from './types';
export * as utils from './utils';
export * as wasm from './wasm';
export * as version from './version';
