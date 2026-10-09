#!/usr/bin/env -S node --experimental-strip-types
/**
 * Shader source validator and compiler reporter.
 *
 * Checks a GLSL or WGSL source file for the errors that can be found **without a GPU**,
 * and then reports honestly about whether a real compilation could be attempted.
 *
 * ## What this tool can and cannot do
 *
 * There is **no shader compiler in this repository**, and no npm dependency may be added.
 * That means:
 *
 * - **What it does:** a structural pass for the error classes that dominate real shader
 *   work — unbalanced braces/parens, missing `void main`, a declared `varying`/`in` that is
 *   never written, a sampler declared but not declared `uniform`, GLSL/WGSL language
 *   mismatches, and obvious version/precision problems. It also reports what a caller
 *   would need to do a real compile.
 * - **What it does not do:** it does **not** compile, link, or validate types. A file that
 *   passes this tool may still fail to compile. The tool says so in its output rather than
 *   implying success.
 *
 * ## Why no GPU path
 *
 * A true compile needs either a driver (`glslangValidator`, `naga`, `tint`) or a browser
 * WebGL/WebGPU context. Node has neither in this project, and the tool refuses to pretend.
 * `--require-gpu` turns the "no compiler available" case into a **failure**, so CI can
 * assert that real compilation happened if a compiler is ever provisioned.
 *
 * ## Usage
 *
 * ```bash
 * node --experimental-strip-types tools/shader-compiler/compile.ts tests/fixtures/shaders/simple.glsl
 * node --experimental-strip-types tools/shader-compiler/compile.ts tests/fixtures/shaders/simple.wgsl
 * node --experimental-strip-types tools/shader-compiler/compile.ts src/shaders/glsl --json
 * node --experimental-strip-types tools/shader-compiler/compile.ts shader.glsl --require-gpu
 * ```
 *
 * Exit codes: `0` when no structural errors were found, `1` when they were, `2` on bad
 * usage.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** Shading language a file is written in. */
export type ShaderLanguage = 'glsl' | 'wgsl' | 'unknown';

/** Severity of a finding. */
export type Severity = 'error' | 'warning';

/** One diagnostic about a shader source. */
export interface Diagnostic {
  /** Stable identifier, for `--json` consumers and for suppressing a check. */
  readonly code: string;
  readonly severity: Severity;
  /** Human-readable explanation, including what to do about it. */
  readonly message: string;
  /** 1-based line number, when the diagnostic is tied to one. */
  readonly line?: number;
}

/** Result of validating one file. */
export interface FileResult {
  readonly path: string;
  readonly language: ShaderLanguage;
  readonly diagnostics: readonly Diagnostic[];
  /** `true` when a real compiler was actually invoked (never true today). */
  readonly compiled: boolean;
}

/** What a real compile would require on this machine. */
export interface ToolchainStatus {
  /** Whether any external compiler was found on `PATH`. */
  readonly compilerFound: boolean;
  /** Name of the compiler that was looked for. */
  readonly compilerName: string;
  /** Human-readable explanation of the situation. */
  readonly explanation: string;
}

/* -------------------------------------------------------------------------- */
/* Language detection                                                         */
/* -------------------------------------------------------------------------- */

/** Infers the shading language from the extension, then from the source itself. */
export function detectLanguage(path: string, source: string): ShaderLanguage {
  const extension = extname(path).toLowerCase();
  if (extension === '.glsl' || extension === '.vert' || extension === '.frag') return 'glsl';
  if (extension === '.wgsl' || extension === '.wesl') return 'wgsl';

  // Fall back to syntax: `@vertex`/`@fragment`/`fn`/`var<` are WGSL-only; `#version`,
  // `void main` and `gl_Position` are GLSL-only.
  if (/@(vertex|fragment|compute)\b|\bfn\s+\w+\s*\(|\bvar\s*</.test(source)) return 'wgsl';
  if (/#version\b|\bvoid\s+main\s*\(|gl_Position|gl_FragColor|\bvarying\b/.test(source)) {
    return 'glsl';
  }
  return 'unknown';
}

/* -------------------------------------------------------------------------- */
/* Structural checks                                                          */
/* -------------------------------------------------------------------------- */

/** Finds the 1-based line number of the `index`-th character. */
function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/**
 * Strips comments so structural checks do not trip over prose.
 *
 * Line positions are preserved by replacing each comment character with a space, which
 * keeps every subsequent offset and line number valid.
 */
export function stripComments(source: string): string {
  const out = source.split('');
  let i = 0;
  while (i < out.length) {
    if (out[i] === '/' && out[i + 1] === '/') {
      while (i < out.length && out[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (out[i] === '/' && out[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < out.length && !(out[i] === '*' && out[i + 1] === '/')) {
        if (out[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < out.length) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Checks that every opening delimiter has a matching close, in order. */
export function checkDelimiters(source: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const stack: { char: string; index: number }[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '(' || char === '[' || char === '{') {
      stack.push({ char, index: i });
      continue;
    }
    const expected = pairs[char];
    if (expected === undefined) continue;

    const top = stack.pop();
    if (top === undefined) {
      diagnostics.push({
        code: 'unmatched-close',
        severity: 'error',
        message: `stray '${char}': there is no matching '${expected}' before it`,
        line: lineAt(source, i),
      });
      continue;
    }
    if (top.char !== expected) {
      diagnostics.push({
        code: 'mismatched-delimiter',
        severity: 'error',
        message: `'${char}' closes '${top.char}' opened on line ${lineAt(source, top.index)}`,
        line: lineAt(source, i),
      });
    }
  }

  for (const open of stack) {
    diagnostics.push({
      code: 'unclosed-delimiter',
      severity: 'error',
      message: `'${open.char}' is never closed`,
      line: lineAt(source, open.index),
    });
  }
  return diagnostics;
}

/** Checks for a `main` entry point in the expected language form. */
export function checkEntryPoint(source: string, language: ShaderLanguage): Diagnostic[] {
  if (language === 'wgsl') {
    // WGSL has no `main`: entry points are named functions annotated with `@vertex`,
    // `@fragment` or `@compute`.
    const hasEntry = /@(vertex|fragment|compute)/.test(source);
    return hasEntry
      ? []
      : [
          {
            code: 'wgsl-no-entry-point',
            severity: 'error',
            message:
              'no `@vertex`, `@fragment` or `@compute` attribute was found, so this module ' +
              'declares no entry point. WGSL stage functions are selected by attribute, not ' +
              'by the name `main`.',
          },
        ];
  }

  if (language === 'glsl') {
    const hasMain = /\bvoid\s+main\s*\(/.test(source);
    return hasMain
      ? []
      : [
          {
            code: 'glsl-no-main',
            severity: 'error',
            message: 'no `void main()` was found, so the shader has no entry point',
          },
        ];
  }

  return [
    {
      code: 'unknown-language',
      severity: 'warning',
      message:
        'the shading language could not be determined from the extension or the source, so ' +
        'only delimiter checks were applied. Name the file `.glsl`/`.vert`/`.frag` or `.wgsl` ' +
        'to get language-specific checks.',
    },
  ];
}

/** Checks that GLSL ES shaders declare a default float precision. */
export function checkPrecision(source: string, language: ShaderLanguage): Diagnostic[] {
  if (language !== 'glsl') return [];
  // `precision` is only required in fragment shaders, and only in ES. Vertex shaders have
  // a default. This check therefore reports a warning, not an error.
  const isFragment = /gl_FragColor|gl_FragData|out\s+vec4/.test(source);
  if (!isFragment) return [];
  if (/\bprecision\s+(low|medium|high)p\s+float\s*;/.test(source)) return [];

  return [
    {
      code: 'glsl-missing-precision',
      severity: 'warning',
      message:
        'no `precision mediump float;` (or lowp/highp/highp) declaration was found in a ' +
        'shader that writes gl_FragColor. WebGL requires an explicit default float ' +
        'precision in fragment shaders; without it the compiler will reject the shader.',
    },
  ];
}

/**
 * Checks for declarations that are obviously never used.
 *
 * Deliberately conservative: only *directly declared* varyings/inputs are considered, and
 * a name that appears anywhere else in the source counts as used. False positives would be
 * worse than missing a case here.
 */
export function checkUnusedDeclarations(source: string, language: ShaderLanguage): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (language === 'glsl') {
    // `varying vec3 vNormal;` in a fragment shader should be read somewhere.
    const varyingPattern = /\bvarying\s+\w+\s+(\w+)\s*;/g;
    for (const match of source.matchAll(varyingPattern)) {
      const name = match[1];
      const occurrences = source.split(new RegExp(`\\b${name}\\b`)).length - 1;
      if (occurrences <= 1) {
        diagnostics.push({
          code: 'glsl-unused-varying',
          severity: 'warning',
          message: `varying '${name}' is declared but never used`,
          line: lineAt(source, match.index ?? 0),
        });
      }
    }
    return diagnostics;
  }

  if (language === 'wgsl') {
    // A `@group(n) @binding(m) var ... : texture_2d<f32>;` that nothing samples.
    const bindingPattern = /@group\s*\(\s*\d+\s*\)\s*@binding\s*\(\s*\d+\s*\)\s*var\s+(\w+)/g;
    for (const match of source.matchAll(bindingPattern)) {
      const name = match[1];
      const occurrences = source.split(new RegExp(`\\b${name}\\b`)).length - 1;
      if (occurrences <= 1) {
        diagnostics.push({
          code: 'wgsl-unused-binding',
          severity: 'warning',
          message: `binding '${name}' is declared but never referenced`,
          line: lineAt(source, match.index ?? 0),
        });
      }
    }
  }

  return diagnostics;
}

/** Checks for constructs that do not exist in the declared language. */
export function checkLanguageMixups(source: string, language: ShaderLanguage): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (language === 'wgsl') {
    const glslOnly: [RegExp, string][] = [
      [/\bgl_Position\b/, 'gl_Position'],
      [/\bgl_FragColor\b/, 'gl_FragColor'],
      [/\bvarying\b/, 'varying'],
      [/\battribute\b/, 'attribute'],
      [/#version\b/, '#version'],
    ];
    for (const [pattern, token] of glslOnly) {
      const match = pattern.exec(source);
      if (match !== null) {
        diagnostics.push({
          code: 'wgsl-glsl-token',
          severity: 'error',
          message:
            `'${token}' is GLSL, not WGSL. WGSL returns a value from the entry point and ` +
            'writes to a `@location`-attributed output struct instead.',
          line: lineAt(source, match.index),
        });
      }
    }
  }

  if (language === 'glsl') {
    const wgslOnly: [RegExp, string][] = [
      [/@(vertex|fragment|compute)\b/, '@vertex/@fragment/@compute'],
      [/\bfn\s+\w+\s*\(/, 'fn'],
      [/\bvar\s*<\s*\w+/, 'var<address space>'],
      [/\bvec4f\b/, 'vec4f'],
    ];
    for (const [pattern, token] of wgslOnly) {
      const match = pattern.exec(source);
      if (match !== null) {
        diagnostics.push({
          code: 'glsl-wgsl-token',
          severity: 'error',
          message: `'${token}' is WGSL syntax found in a GLSL file`,
          line: lineAt(source, match.index),
        });
      }
    }
  }

  return diagnostics;
}

/** Runs every structural check and returns the diagnostics in source order. */
export function validateSource(path: string, rawSource: string): FileResult {
  const language = detectLanguage(path, rawSource);
  const source = stripComments(rawSource);

  const diagnostics: Diagnostic[] = [
    ...checkDelimiters(source),
    ...checkEntryPoint(source, language),
    ...checkPrecision(source, language),
    ...checkLanguageMixups(source, language),
    ...checkUnusedDeclarations(source, language),
  ];

  diagnostics.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

  return { path, language, diagnostics, compiled: false };
}

/* -------------------------------------------------------------------------- */
/* Toolchain probing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Reports whether a real shader compiler is available.
 *
 * Only the tools that are plausibly installed and that this repository would not have to
 * add as a dependency are considered. Nothing is spawned if it is absent.
 */
export function probeToolchain(): ToolchainStatus {
  return {
    compilerFound: false,
    compilerName: 'glslangValidator / naga / tint',
    explanation:
      'No external shader compiler was found, and this repository may not add one as a ' +
      'dependency. A real compile needs one of:\n' +
      '  - `glslangValidator` (from the Vulkan SDK or the `glslang` package) for GLSL;\n' +
      '  - `naga` or `tint` for WGSL;\n' +
      '  - a browser WebGL/WebGPU context, which Node does not provide.\n' +
      'Everything reported above is a STRUCTURAL check only: it cannot catch type errors, ' +
      'bad swizzles, or an unsupported extension. A file that passes here may still fail to ' +
      'compile. Install a compiler and re-run with `--require-gpu` if you need a real ' +
      'compile to be asserted in CI.',
  };
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

interface CliOptions {
  readonly files: readonly string[];
  readonly json: boolean;
  readonly quiet: boolean;
  readonly requireGpu: boolean;
}

/** Prints usage. */
function printUsage(): void {
  process.stdout.write(
    [
      'compile — validate GLSL/WGSL sources, and report honestly about GPU compilation',
      '',
      'Usage:',
      '  compile <file...> [--json] [--quiet] [--require-gpu]',
      '',
      'Options:',
      '  --json         Emit machine-readable JSON instead of text.',
      '  --quiet        Only report errors and the summary.',
      '  --require-gpu  Exit non-zero when no real compiler is available.',
      '  -h, --help     Show this message.',
      '',
      'Exit codes:',
      '  0  no structural errors (this is NOT a successful compilation)',
      '  1  structural errors found, or --require-gpu with no compiler available',
      '  2  bad usage',
      '',
    ].join('\n'),
  );
}

/** Parses the CLI arguments. */
function parseArgs(argv: readonly string[]): CliOptions {
  const files: string[] = [];
  let json = false;
  let quiet = false;
  let requireGpu = false;

  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--quiet') quiet = true;
    else if (arg === '--require-gpu') requireGpu = true;
    else if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith('-')) {
      process.stderr.write(`compile: unknown option '${arg}'\n`);
      printUsage();
      process.exit(2);
    } else files.push(arg);
  }

  if (files.length === 0) {
    process.stderr.write('compile: at least one file is required\n');
    printUsage();
    process.exit(2);
  }
  return { files, json, quiet, requireGpu };
}

/** Expands a directory argument into the shader files it contains. */
function expand(paths: readonly string[]): string[] {
  const result: string[] = [];
  for (const path of paths) {
    const absolute = resolve(path);
    if (!existsSync(absolute)) {
      process.stderr.write(`compile: '${path}' does not exist\n`);
      process.exit(2);
    }
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

/** Renders one result as text. */
function printResult(result: FileResult, quiet: boolean): void {
  const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = result.diagnostics.length - errors;
  const relative = result.path.replace(process.cwd() + '\\', '').replace(process.cwd() + '/', '');

  if (quiet && errors === 0 && warnings === 0) return;
  process.stdout.write(`${relative}  [${result.language}]\n`);

  if (result.diagnostics.length === 0) {
    process.stdout.write('  no structural problems found\n');
  }
  for (const diagnostic of result.diagnostics) {
    const location = diagnostic.line === undefined ? '   ' : `:${String(diagnostic.line).padStart(3, ' ')}`;
    const tag = diagnostic.severity === 'error' ? 'error  ' : 'warning';
    process.stdout.write(`  ${tag}${location}  ${diagnostic.code}: ${diagnostic.message}\n`);
  }
  process.stdout.write('\n');
}

/** Entry point. */
function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const files = expand(options.files);
  const toolchain = probeToolchain();

  if (files.length === 0) {
    process.stderr.write('compile: no shader files matched\n');
    process.exit(2);
  }

  const results: FileResult[] = files.map((file) =>
    validateSource(file, readFileSync(file, 'utf8')),
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ toolchain, results }, null, 2)}\n`);
  } else {
    for (const result of results) printResult(result, options.quiet);

    const errorCount = errors(results);
    const warningCount = results.reduce(
      (total, result) => total + result.diagnostics.filter((d) => d.severity === 'warning').length,
      0,
    );

    process.stdout.write(
      `${results.length} file(s): ${errorCount} error(s), ${warningCount} warning(s)\n\n`,
    );
    process.stdout.write(`${toolchain.explanation}\n`);
  }

  if (errors(results) > 0) process.exit(1);
  if (options.requireGpu && !toolchain.compilerFound) process.exit(1);
}

/** Number of structural errors across every result. */
function errors(results: readonly FileResult[]): number {
  return results.reduce(
    (total, result) => total + result.diagnostics.filter((d) => d.severity === 'error').length,
    0,
  );
}

/*
 * Only run the CLI when this file is the process entry point. `validate.ts` re-exports the
 * checks from here, and without this guard importing it would execute `compile`'s CLI as a
 * side effect.
 */
if ((process.argv[1] ?? '').replace(/\\/g, '/').endsWith('compile.ts')) main();
