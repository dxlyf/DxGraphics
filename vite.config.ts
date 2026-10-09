import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/**
 * Directory names under `src/` that are *layers* — each with its own barrel — and are
 * therefore also published as subpath entries.
 *
 * Listed explicitly rather than discovered, because discovery would silently publish a
 * subpath for any new directory (a scratch folder, say) and because the `exports` map
 * in `package.json` has to name each one anyway. `scripts/verify-build.mjs` checks the
 * two lists agree, so adding a layer here without adding the export fails the build.
 */
const LAYERS = [
  'animation',
  'assets',
  'controls',
  'core',
  'effects',
  'geometry',
  'materials',
  'math',
  'picking',
  'renderer',
  'scene',
  'shaders',
  'text',
  'textures',
  'types',
  'utils',
  'wasm',
];

/** The layer barrels that actually exist on disk. */
const layerEntries = Object.fromEntries(
  LAYERS.filter((layer) => existsSync(resolvePath(`./src/${layer}/index.ts`))).map((layer) => [
    layer,
    resolvePath(`./src/${layer}/index.ts`),
  ]),
);

/**
 * Which module format this run emits, taken from `LYF_BUILD_FORMAT`.
 *
 * The build runs Vite **twice**, once per format, rather than once with
 * `formats: ['es', 'cjs']`. With two formats in one pass Rollup hoists the modules
 * shared between entries to the output root, which puts CommonJS `.js` chunks inside
 * the *ESM* tree — and `"type": "module"` then makes Node parse them as ESM. One pass
 * per format keeps each tree self-contained and lets each use its own file
 * extensions.
 *
 * The default is `es`, so a bare `pnpm exec vite build` still does something sensible.
 */
const format = process.env.LYF_BUILD_FORMAT === 'cjs' ? 'cjs' : 'es';

/** Output root for this format. */
const outDir = format === 'es' ? 'dist/esm' : 'dist/cjs';

/** File extension for this format. `.cjs` is required: the package is `"type": "module"`. */
const extension = format === 'es' ? '.js' : '.cjs';

/**
 * Library build.
 *
 * Emits, into `dist/esm` or `dist/cjs`:
 *  - `index.*` — the umbrella entry;
 *  - `<layer>/index.*` — one entry per layer barrel, so the subpaths the documentation
 *    references (`@dxyl/graphics/materials`, `…/scene`, `…/renderer`) resolve.
 *
 * Vite keys the output off the entry name, which is the object key, so the mapping is
 * explicit rather than derived from a path prefix that would shift as layers are added.
 *
 * Type declarations come from `tsc -p tsconfig.build.json` into `dist/types`, keeping
 * the JS build fast and the `.d.ts` output exact.
 */
export default defineConfig({
  plugins: [glsl({ minify: false, watch: true })],
  resolve: {
    alias: {
      '@': resolvePath('./src'),
    },
  },
  build: {
    target: 'es2022',
    outDir,
    // Only this format's own directory is cleared; the other format's output and the
    // `dist/types` tree from `tsc` must survive.
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    cssCodeSplit: false,
    reportCompressedSize: false,
    lib: {
      entry: {
        index: resolvePath('./src/index.ts'),
        ...layerEntries,
      },
      name: 'DXYLGraphics',
      formats: [format],
      fileName: (_format, entryName) => (entryName === 'index' ? `index${extension}` : `${entryName}/index${extension}`),
    },
    rollupOptions: {
      output: {
        exports: 'named',
        preserveModules: false,
        // Shared code hoisted out of the entry graphs stays inside this format's
        // directory and keeps the format's extension.
        chunkFileNames: `chunks/[name]-[hash]${extension}`,
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
