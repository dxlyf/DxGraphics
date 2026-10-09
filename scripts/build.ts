/**
 * `pnpm build` — produces the complete distributable.
 *
 * Pipeline (each stage is also runnable on its own):
 *
 * 1. **clean**   remove `dist/` (unless `--no-clean`)
 * 2. **assets**  copy `assets/` and the Wasm modules into `dist/`
 * 3. **types**   `tsc -p tsconfig.build.json` → `dist/types/**`
 * 4. **bundle**  `vite build` → `dist/esm/index.js` + `dist/cjs/index.cjs`
 * 5. **verify**  `scripts/verify-build.mjs` asserts the artefacts really load
 *
 * Usage:
 * ```text
 * node --experimental-strip-types scripts/build.ts [--skip-bundle] [--skip-verify] [--no-clean]
 * ```
 *
 * @packageDocumentation
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { DIST, ROOT, directorySize, formatBytes, log, run, toRelative } from './_shared.ts';

/** Parsed command-line flags. */
export interface BuildOptions {
  /** Remove `dist/` before building. */
  clean: boolean;
  /** Skip the Vite bundle step (types and assets only). */
  skipBundle: boolean;
  /** Skip the post-build verification. */
  skipVerify: boolean;
}

/**
 * Parses the script's command line.
 *
 * @param argv Arguments following the script name.
 * @returns The resolved options.
 */
export function parseBuildArgs(argv: readonly string[]): BuildOptions {
  return {
    clean: !argv.includes('--no-clean'),
    skipBundle: argv.includes('--skip-bundle'),
    skipVerify: argv.includes('--skip-verify'),
  };
}

/**
 * Runs the build.
 */
async function main(): Promise<void> {
  const options = parseBuildArgs(process.argv.slice(2));
  const started = Date.now();

  log.step(`Building @dxyl/graphics from ${toRelative(ROOT)}`);

  if (options.clean) {
    rmSync(DIST, { recursive: true, force: true });
    log.detail('cleaned dist/');
  }

  log.step('Stage 1/4 — copying assets and Wasm modules');
  await run('node', ['--experimental-strip-types', join(ROOT, 'scripts', 'copy-assets.ts')]);
  log.ok('dist/assets/ written');

  log.step('Stage 2/4 — emitting type declarations');
  await run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json']);
  log.ok('dist/types/ written');

  if (options.skipBundle) {
    log.warn('Stage 3/4 — bundling skipped');
  } else {
    // Two passes, one per module format. A single pass with both formats hoists shared
    // modules to the output root, which puts CommonJS chunks inside the ESM tree where
    // `"type": "module"` makes Node parse them as ESM. `vite.config.ts` reads
    // `LYF_BUILD_FORMAT` and writes each format into its own directory.
    log.step('Stage 3/4 — bundling with Vite (esm, then cjs)');
    await run('pnpm', ['exec', 'vite', 'build'], { env: { ...process.env, LYF_BUILD_FORMAT: 'es' } });
    await run('pnpm', ['exec', 'vite', 'build'], { env: { ...process.env, LYF_BUILD_FORMAT: 'cjs' } });
    log.ok('dist/esm/ and dist/cjs/ written (index + one entry per layer)');
  }

  if (options.skipVerify) {
    log.warn('Stage 4/4 — verification skipped');
  } else {
    log.step('Stage 4/4 — verifying artefacts');
    await run('node', [join(ROOT, 'scripts', 'verify-build.mjs')]);
  }

  const { bytes, files } = directorySize(DIST);
  log.ok(`build finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  log.detail(`dist/ contains ${files} files, ${formatBytes(bytes)}`);
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
