import { fileURLToPath, URL } from 'node:url';
import glsl from 'vite-plugin-glsl';

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/**
 * Rollup mirror of the Vite library build.
 *
 * Vite is the primary bundler (`pnpm build`), but keeping an explicit Rollup
 * config lets consumers reproduce the exact artifact graph without Vite when
 * they need to plug the library into an existing Rollup pipeline.
 *
 * Usage (Rollup is resolved through Vite's bundled copy, so no extra
 * devDependency is required):
 *
 *   pnpm exec rollup -c rollup.config.ts --configPlugin typescript
 */
export default {
  input: resolvePath('./src/index.ts'),
  plugins: [glsl({ minify: false })],
  output: [
    {
      file: resolvePath('./dist/esm/index.js'),
      format: 'es',
      sourcemap: true,
    },
    {
      file: resolvePath('./dist/cjs/index.cjs'),
      format: 'cjs',
      exports: 'named',
      sourcemap: true,
    },
  ],
};
