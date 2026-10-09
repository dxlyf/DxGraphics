/**
 * GLSL shader sources.
 *
 * ## Why the sources are TypeScript modules
 *
 * The conventional layout stores GLSL in `*.glsl` files and imports them through
 * a bundler plugin (`vite-plugin-glsl`, `raw-loader`, `@rollup/plugin-string`).
 * That works, but it makes the library *only* consumable through a bundler:
 * `tsc` alone cannot resolve `import source from './x.glsl'`, and every consumer
 * has to install and configure the same plugin.
 *
 * This library ships `.ts` modules that export template-literal source strings
 * instead:
 *
 * ```ts
 * // src/shaders/glsl/chunks/common.ts
 * export const common = `
 * #define PI 3.141592653589793
 * `;
 * ```
 *
 * The trade-offs are deliberate:
 *  - **pro**: works with Vite, Rollup, webpack, esbuild and plain `tsc`, with
 *    zero configuration and zero plugins;
 *  - **pro**: sources are typed, tree-shakeable and can be unit-tested (they are
 *    registered in the `ShaderChunk` registry at import time);
 *  - **con**: editors do not syntax-highlight the strings as shader code. Each
 *    literal is therefore preceded by a block comment containing only the word
 *    `glsl`, which the common shader editor extensions use as a language hint.
 *
 * `#include <name>` directives inside the sources are resolved by `ShaderChunk`
 * (see `src/shaders/ShaderChunk.ts`), which is why the sources still read like
 * ordinary shader code.
 *
 * @packageDocumentation
 */

import { defineChunk } from '../ShaderChunk';
import type { ShaderDescriptor, ShaderLanguage } from '../types';
import { common } from './chunks/common';
import { math } from './chunks/math';
import { color } from './chunks/color';
import { uv } from './chunks/uv';
import { fog } from './chunks/fog';
import { normal } from './chunks/normal';
import { lighting } from './chunks/lighting';
import { shadow } from './chunks/shadow';
import { skinning } from './chunks/skinning';
import { points } from './chunks/points';
import { basicShader } from './lib/basic';
import { lambertShader } from './lib/lambert';
import { phongShader } from './lib/phong';
import { standardShader } from './lib/standard';
import { physicalShader } from './lib/physical';
import { pointsShader } from './lib/points';
import { dashedShader } from './lib/dashed';
import { spriteShader } from './lib/sprite';
import { depthShader } from './lib/depth';
import { normalShader } from './lib/normal';
import { shadowShader } from './lib/shadow';
import { backgroundShader } from './lib/background';

/** Language every module in this folder is written in. */
const LANGUAGE: ShaderLanguage = 'glsl';

/**
 * Every built-in GLSL chunk, keyed by bare name.
 *
 * Registration qualifies each name with the language (`glsl/common`), so
 * `#include <common>` inside a GLSL source resolves here while the WGSL barrel
 * keeps its own `wgsl/common`.
 */
export const glslChunks: Readonly<Record<string, string>> = {
  common,
  math,
  color,
  uv,
  fog,
  normal,
  lighting,
  shadow,
  skinning,
  points,
};

/**
 * Registers every built-in GLSL chunk.
 *
 * @param overwrite Replace chunks that are already registered. Defaults to
 *   `true`, so re-importing the barrel (for example from two bundles) is safe.
 * @returns The number of chunks registered.
 */
export function registerGlslChunks(overwrite: boolean = true): number {
  let registered = 0;
  for (const [name, source] of Object.entries(glslChunks)) {
    const qualified = `${LANGUAGE}/${name}`;
    if (!overwrite && registeredChunks.has(qualified)) continue;
    defineChunk(qualified, source, { language: LANGUAGE, builtin: true });
    registeredChunks.add(qualified);
    registered++;
  }
  return registered;
}

/** Names this barrel has already written into the registry. */
const registeredChunks = new Set<string>();

/**
 * The built-in GLSL programs, keyed by family name.
 *
 * Keys match `wgslShaderLib`, which is what lets `ShaderLib` pair the two
 * variants without a hand-maintained table.
 */
export const glslShaderLib: Readonly<Record<string, ShaderDescriptor>> = {
  basic: basicShader,
  lambert: lambertShader,
  phong: phongShader,
  standard: standardShader,
  physical: physicalShader,
  points: pointsShader,
  dashed: dashedShader,
  sprite: spriteShader,
  depth: depthShader,
  normal: normalShader,
  shadow: shadowShader,
  background: backgroundShader,
};

/** Family names provided by this barrel. */
export const glslShaderNames: readonly string[] = Object.keys(glslShaderLib);

registerGlslChunks();
