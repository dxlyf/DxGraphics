/**
 * Shared helpers for the `scripts/` entry points.
 *
 * The scripts are TypeScript so they get the same type-checking as the library;
 * they are executed with `node --experimental-strip-types` (Node ≥ 22.6), which
 * removes the type annotations without a build step. Node 20 users can run them
 * through `pnpm exec tsx <script>` instead.
 *
 * @packageDocumentation
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Absolute path to the package root (the parent of `scripts/`). */
export const ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path to `src/`. */
export const SRC: string = join(ROOT, 'src');

/** Absolute path to `dist/`. */
export const DIST: string = join(ROOT, 'dist');

/** Console helpers with a consistent prefix so build output is greppable. */
export const log = {
  /** Prints a step. */
  step(message: string): void {
    console.log(`\u001b[36m▸\u001b[0m ${message}`);
  },
  /** Prints a success line. */
  ok(message: string): void {
    console.log(`\u001b[32m✓\u001b[0m ${message}`);
  },
  /** Prints a warning. */
  warn(message: string): void {
    console.log(`\u001b[33m!\u001b[0m ${message}`);
  },
  /** Prints a failure. */
  error(message: string): void {
    console.error(`\u001b[31m✗\u001b[0m ${message}`);
  },
  /** Prints an indented detail line. */
  detail(message: string): void {
    console.log(`  ${message}`);
  },
};

/**
 * Reads and parses `package.json`.
 *
 * @returns The parsed manifest.
 */
export function readPackageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
}

/**
 * Recursively collects files under `directory` whose name matches `filter`.
 *
 * @param directory Directory to walk.
 * @param filter Predicate applied to each file's absolute path.
 * @param results Accumulator (used by the recursion).
 * @returns The matching absolute paths, sorted for determinism.
 */
export function walk(
  directory: string,
  filter: (path: string) => boolean,
  results: string[] = [],
): string[] {
  if (!existsSync(directory)) return results;
  for (const entry of readdirSync(directory).sort()) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) walk(full, filter, results);
    else if (filter(full)) results.push(full);
  }
  return results;
}

/** Collects every `.ts` file under `src/`, excluding tests and declarations. */
export function sourceFiles(): string[] {
  return walk(SRC, (path) => path.endsWith('.ts') && !path.endsWith('.d.ts') && !path.includes('.test.'));
}

/** Collects every `.ts` file under `src/` that is not an `index.ts` barrel. */
export function nonBarrelSourceFiles(): string[] {
  return sourceFiles().filter((path) => !path.endsWith(`${join('', 'index.ts')}`));
}

/**
 * Returns the path relative to the package root, with POSIX separators.
 *
 * @param absolute An absolute path.
 */
export function toRelative(absolute: string): string {
  return relative(ROOT, absolute).split('\\').join('/');
}

/**
 * Ensures a directory exists.
 *
 * @param directory Directory to create (recursively).
 */
export function ensureDir(directory: string): void {
  mkdirSync(directory, { recursive: true });
}

/**
 * Writes a file, creating parent directories and skipping identical content.
 *
 * Skipping identical writes keeps file watchers (and incremental builds) quiet.
 *
 * @param path Absolute destination path.
 * @param content File contents.
 * @returns `true` when the file was written, `false` when it was already current.
 */
export function writeIfChanged(path: string, content: string): boolean {
  ensureDir(dirname(path));
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  writeFileSync(path, content);
  return true;
}

/**
 * Runs a command and returns its stdout.
 *
 * @param command Executable name.
 * @param args Arguments.
 * @param options Optional working directory and environment overrides.
 */
export async function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<string> {
  const { stdout } = await execFileAsync(command, [...args], {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  return stdout;
}

/**
 * Formats a byte count for build output.
 *
 * @param bytes The size in bytes.
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/**
 * Measures the total size of every file under a directory.
 *
 * @param directory Directory to measure.
 * @returns Total bytes and the file count.
 */
export function directorySize(directory: string): { bytes: number; files: number } {
  const files = walk(directory, () => true);
  let bytes = 0;
  for (const file of files) bytes += statSync(file).size;
  return { bytes, files: files.length };
}

/**
 * Extracts the leading block comment of a TypeScript source file.
 *
 * Used by the API/asset generators to read module documentation without pulling
 * in the TypeScript compiler.
 *
 * @param source Full file contents.
 * @returns The comment body, or an empty string.
 */
export function leadingDocComment(source: string): string {
  const trimmed = source.replace(/^\uFEFF/, '').trimStart();
  if (!trimmed.startsWith('/**')) return '';
  const end = trimmed.indexOf('*/');
  return end < 0 ? '' : trimmed.slice(3, end).replace(/^\s*\* ?/gm, '').trim();
}

/**
 * Returns the first `# ` heading of a Markdown document.
 *
 * @param markdown Document text.
 */
export function markdownTitle(markdown: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match ? match[1].trim() : '';
}
