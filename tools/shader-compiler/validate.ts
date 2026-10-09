#!/usr/bin/env -S node --experimental-strip-types
/**
 * Shader source validator (library entry point).
 *
 * This file exists so the checks in `compile.ts` can be used as a **library** from another
 * script or a test, rather than only as a CLI. `compile.ts` is the command-line front end;
 * this is the programmable one.
 *
 * The two entry points deliberately share one implementation, so a check cannot drift
 * between what the CLI reports and what a test asserts.
 *
 * ## Usage as a library
 *
 * ```ts
 * import { validateFile, validateSource, detectLanguage } from './validate';
 *
 * const result = validateFile('tests/fixtures/shaders/simple.glsl');
 * if (result.diagnostics.some((d) => d.severity === 'error')) {
 *   throw new Error(`${result.path} has structural errors`);
 * }
 * ```
 *
 * ## Usage as a CLI
 *
 * ```bash
 * node --experimental-strip-types tools/shader-compiler/validate.ts <file...> [--json] [--quiet]
 * ```
 *
 * `validate` behaves like `compile` but never exits non-zero for the missing GPU
 * toolchain: use it when you only want the structural verdict.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/*
 * The `.ts` extension is required: Node's ESM loader does not resolve extensions, and these
 * tools run directly through `node --experimental-strip-types`. This matches the convention
 * already used by `scripts/**` (e.g. `import … from './_shared.ts'`).
 */
export {
  checkDelimiters,
  checkEntryPoint,
  checkLanguageMixups,
  checkPrecision,
  checkUnusedDeclarations,
  detectLanguage,
  probeToolchain,
  stripComments,
  validateSource,
  type Diagnostic,
  type FileResult,
  type Severity,
  type ShaderLanguage,
  type ToolchainStatus,
} from './compile.ts';

import { validateSource, type Diagnostic, type FileResult } from './compile.ts';

/* -------------------------------------------------------------------------- */
/* Library helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Reads and validates one file. */
export function validateFile(path: string): FileResult {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new Error(`validateFile: '${path}' does not exist`);
  }
  return validateSource(absolute, readFileSync(absolute, 'utf8'));
}

/** `true` when a result has no error-severity diagnostics. */
export function isClean(result: FileResult): boolean {
  return !result.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

/** Only the diagnostics of a given severity. */
export function ofSeverity(result: FileResult, severity: Diagnostic['severity']): Diagnostic[] {
  return result.diagnostics.filter((diagnostic) => diagnostic.severity === severity);
}

/** Expands files and directories into a list of shader paths. */
export function collectShaderFiles(paths: readonly string[]): string[] {
  const result: string[] = [];
  for (const path of paths) {
    const absolute = resolve(path);
    if (!existsSync(absolute)) continue;
    if (statSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute)) {
        if (/\.(glsl|vert|frag|wgsl)$/i.test(entry)) result.push(join(absolute, entry));
      }
      continue;
    }
    result.push(absolute);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

/** Parses the arguments for the `validate` entry point. */
function parseArgs(argv: readonly string[]): { files: string[]; json: boolean; quiet: boolean } {
  const files: string[] = [];
  let json = false;
  let quiet = false;

  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--quiet') quiet = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'validate — structural shader checks without a GPU\n\n' +
          'Usage: validate <file...> [--json] [--quiet]\n\n' +
          'Unlike `compile`, this never fails because no GPU compiler is installed:\n' +
          'it reports only the structural verdict.\n',
      );
      process.exit(0);
    } else if (arg.startsWith('-')) {
      process.stderr.write(`validate: unknown option '${arg}'\n`);
      process.exit(2);
    } else files.push(arg);
  }
  return { files, json, quiet };
}

/** Entry point, only when this file is the process entry. */
function main(): void {
  const argv = process.argv.slice(2);
  // When `compile.ts` re-exports from this module, `process.argv[1]` is `compile.ts` and
  // this branch is skipped, so the two CLIs never run each other.
  const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
  if (!entry.endsWith('validate.ts')) return;

  const options = parseArgs(argv);
  const files = collectShaderFiles(options.files);
  if (files.length === 0) {
    process.stderr.write('validate: no shader files matched\n');
    process.exit(2);
  }

  const results = files.map(validateFile);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          results: results.map((result) => ({
            path: result.path,
            language: result.language,
            clean: isClean(result),
            diagnostics: result.diagnostics,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const result of results) {
      const errors = ofSeverity(result, 'error').length;
      const warnings = ofSeverity(result, 'warning').length;
      if (options.quiet && errors === 0 && warnings === 0) continue;

      process.stdout.write(`${result.path}  [${result.language}]  ${isClean(result) ? 'ok' : 'FAILED'}\n`);
      for (const diagnostic of result.diagnostics) {
        process.stdout.write(
          `  ${diagnostic.severity === 'error' ? 'error' : 'warn '}` +
            `${diagnostic.line === undefined ? '' : `:${diagnostic.line}`}  ` +
            `${diagnostic.code}: ${diagnostic.message}\n`,
        );
      }
    }
    const failing = results.filter((result) => !isClean(result)).length;
    process.stdout.write(`\n${results.length} file(s), ${failing} with structural errors\n`);
  }

  process.exit(results.some((result) => !isClean(result)) ? 1 : 0);
}

main();
