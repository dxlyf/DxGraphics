/**
 * `pnpm generate:shaders` — turns the GLSL/WGSL sources into typed TypeScript
 * string constants.
 *
 * **Why not import `.glsl` files directly?** A `.glsl` import needs a bundler
 * plugin (`vite-plugin-glsl`, `glslify-loader`, ...). Shipping the sources as
 * TypeScript string constants instead means the library works with Vite, Rollup,
 * webpack, esbuild and plain `tsc` with **no** plugin, and the strings are typed,
 * greppable and tree-shakeable.
 *
 * The generator scans `assets/shaders/` for `.glsl`, `.vert`, `.frag`, `.wgsl`
 * and `.compute.wgsl` files and writes one `.generated.ts` module per directory,
 * exporting each shader as a named constant plus an index map. It is a no-op when
 * the directory is empty, so a fresh checkout builds without it.
 *
 * Usage:
 * ```text
 * node --experimental-strip-types scripts/generate-shaders.ts [--check]
 * ```
 *
 * @packageDocumentation
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

import { ROOT, log, toRelative, walk, writeIfChanged } from './_shared.ts';

/** Shader file extensions this generator understands. */
const SHADER_EXTENSIONS = ['.glsl', '.vert', '.frag', '.wgsl'] as const;

/** The directory scanned for shader sources. */
const SHADER_ROOT = join(ROOT, 'assets', 'shaders');

/**
 * Converts a file name into a valid, stable TypeScript identifier.
 *
 * @param fileName File name including extension, e.g. `bloom-composite.frag`.
 * @returns A camelCase identifier, e.g. `bloomCompositeFrag`.
 */
function toIdentifier(fileName: string): string {
  const withoutExtension = fileName.replace(/\.(glsl|vert|frag|wgsl)$/i, '');
  const camel = withoutExtension
    .replace(/[^A-Za-z0-9]+(.)?/g, (_match, character: string | undefined) =>
      character ? character.toUpperCase() : '',
    )
    .replace(/^(.)/, (character) => character.toLowerCase());
  const safe = /^[A-Za-z_$]/.test(camel) ? camel : `shader_${camel}`;
  return safe.length > 0 ? safe : 'shader';
}

/**
 * Detects the shader language of a file.
 *
 * @param fileName File name including extension.
 * @returns `'glsl'` or `'wgsl'`.
 */
function languageOf(fileName: string): 'glsl' | 'wgsl' {
  return fileName.toLowerCase().endsWith('.wgsl') ? 'wgsl' : 'glsl';
}

/**
 * Builds the TypeScript module for one directory of shaders.
 *
 * @param directory Absolute directory containing shader files.
 * @param files Absolute shader file paths in that directory.
 * @returns The module source, and the constants it declares.
 */
function buildModule(
  directory: string,
  files: readonly string[],
): { source: string; constants: { name: string; language: 'glsl' | 'wgsl'; file: string }[] } {
  const relativeDirectory = toRelative(directory);
  const constants: { name: string; language: 'glsl' | 'wgsl'; file: string }[] = [];
  const body: string[] = [];

  for (const file of [...files].sort()) {
    const fileName = basename(file);
    const identifier = toIdentifier(fileName);
    const language = languageOf(fileName);
    const contents = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

    constants.push({ name: identifier, language, file: toRelative(file) });
    body.push(
      `/**`,
      ` * \`${fileName}\` (${language.toUpperCase()}) — generated from \`${toRelative(file)}\`.`,
      ` *`,
      ` * Edit the shader source, then run \`pnpm generate:shaders\` to refresh this constant.`,
      ` */`,
      `export const ${identifier} = \`${contents}\`;`,
      '',
      `/** Language of {@link ${identifier}}. */`,
      `export const ${identifier}Language = '${language}' as const;`,
      '',
    );
  }

  const source = [
    '/**',
    ` * Generated shader sources for \`${relativeDirectory}\`.`,
    ' *',
    ' * **Do not edit.** Run `pnpm generate:shaders` after changing anything under',
    ' * `assets/shaders/`. See `scripts/generate-shaders.ts` for why the library ships',
    ' * shader sources as TypeScript strings rather than `.glsl` imports.',
    ' *',
    ' * @packageDocumentation',
    ' */',
    '',
    ...body,
    '/**',
    ' * Name-to-source index for every shader in this directory.',
    ' *',
    ' * Keyed by the identifier exported above, so `SHADERS[identifier]` is the same',
    ' * string and `SHADER_LANGUAGES[identifier]` its language.',
    ' */',
    'export const SHADERS = {',
    ...constants.map((constant) => `  ${constant.name},`),
    '} as const;',
    '',
    '/** Language of each entry in {@link SHADERS}. */',
    'export const SHADER_LANGUAGES = {',
    ...constants.map((constant) => `  ${constant.name}: '${constant.language}',`),
    '} as const;',
    '',
    '/** Identifiers of every shader generated in this directory. */',
    'export const SHADER_NAMES = [',
    ...constants.map((constant) => `  '${constant.name}',`),
    '] as const;',
    '',
    '/** Union of the identifiers in {@link SHADER_NAMES}. */',
    'export type ShaderName = (typeof SHADER_NAMES)[number];',
    '',
  ].join('\n');

  return { source, constants };
}

/**
 * Runs the generator.
 */
function main(): void {
  const check = process.argv.slice(2).includes('--check');

  if (!existsSync(SHADER_ROOT)) {
    log.warn(`no shader source directory at ${toRelative(SHADER_ROOT)}; nothing to generate`);
    return;
  }

  const files = walk(SHADER_ROOT, (path) =>
    SHADER_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension)),
  );

  if (files.length === 0) {
    log.warn('no shader sources found; nothing to generate');
    return;
  }

  // Group by directory so each directory gets exactly one generated module.
  const byDirectory = new Map<string, string[]>();
  for (const file of files) {
    const directory = dirname(file);
    const bucket = byDirectory.get(directory);
    if (bucket) bucket.push(file);
    else byDirectory.set(directory, [file]);
  }

  let written = 0;
  let unchanged = 0;
  let stale = 0;
  const allConstants: { name: string; language: 'glsl' | 'wgsl'; file: string }[] = [];

  for (const [directory, shaderFiles] of [...byDirectory.entries()].sort()) {
    const { source, constants } = buildModule(directory, shaderFiles);
    allConstants.push(...constants);

    const target = join(directory, 'index.generated.ts');
    if (check) {
      const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
      if (current !== source) {
        stale++;
        log.error(`${toRelative(target)} is out of date`);
      }
      continue;
    }
    if (writeIfChanged(target, source)) written++;
    else unchanged++;
  }

  if (check) {
    if (stale > 0) {
      process.exitCode = 1;
      log.error(`${stale} generated shader module(s) are stale; run pnpm generate:shaders`);
    } else {
      log.ok('generated shader modules are up to date');
    }
    return;
  }

  log.ok(
    `generated ${allConstants.length} shader constant(s) in ${byDirectory.size} module(s) ` +
      `(${written} written, ${unchanged} unchanged)`,
  );
  for (const constant of allConstants) {
    log.detail(`${constant.name} (${constant.language}) <- ${constant.file}`);
  }
}

try {
  main();
} catch (error: unknown) {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
