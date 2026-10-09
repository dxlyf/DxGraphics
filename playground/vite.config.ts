/**
 * Playground Vite configuration.
 *
 * Deliberately separate from the library's own root `vite.config.ts`: the library
 * config builds the `dist/` bundles with library mode and the GLSL plugin, whereas
 * this one only has to serve a single-page app whose imports reach straight into
 * `../src/`.
 *
 * `root` is the playground directory, so `pnpm playground` (which is
 * `vite --config playground/vite.config.ts`) serves `playground/index.html` and Vite
 * resolves the `../../src/index` imports in `src/*.ts` as ordinary source, with no
 * build step and no `dist/` requirement.
 */

import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

/** Absolute path to `playground/`. */
const playgroundRoot = fileURLToPath(new URL('.', import.meta.url));

/** Absolute path to the library's `src/`. */
const librarySource = fileURLToPath(new URL('../src', import.meta.url));

export default defineConfig({
  root: playgroundRoot,

  resolve: {
    alias: {
      // The documented playground alias. Deep imports into the library source remain
      // available relative to `root` and are used where the root barrel does not
      // re-export a symbol (for example `WebGLRenderer`).
      '@': librarySource,
    },
  },

  server: {
    open: true,
    port: 5174,
    strictPort: false,
  },

  // Keep the library build untouched: this config must never emit into `dist/`.
  build: {
    outDir: 'dist-playground',
    emptyOutDir: true,
  },
});
