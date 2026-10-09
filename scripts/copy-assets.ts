/**
 * Copies static assets into `dist/`.
 *
 * The library itself ships no binary assets, but the Wasm acceleration modules
 * (`src/wasm/*.wasm`) and everything under `assets/` must be reachable at runtime
 * because `wasm/wasmLoader.ts` resolves them by URL. This script keeps a single,
 * explicit mapping from "where it lives in the repo" to "where a consumer finds
 * it in the package".
 *
 * It also writes `dist/assets/manifest.json` so tooling can enumerate what was
 * shipped without walking the tree.
 *
 * @packageDocumentation
 */

import { copyFileSync, existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';

import { DIST, ROOT, ensureDir, formatBytes, log, walk, writeIfChanged } from './_shared.ts';

/** One copy rule: a source directory and its destination inside `dist/`. */
interface CopyRule {
  /** Path relative to the package root. */
  from: string;
  /** Path relative to `dist/`. */
  to: string;
  /** Lowercase extensions to copy; `null` copies everything. */
  extensions: readonly string[] | null;
  /** Fail the build when the source directory is missing. */
  required: boolean;
}

/** Every static asset the package ships or consumes at runtime. */
const RULES: readonly CopyRule[] = [
  { from: 'src/wasm', to: 'wasm', extensions: ['.wasm'], required: false },
  { from: 'assets/textures', to: 'assets/textures', extensions: null, required: false },
  { from: 'assets/models', to: 'assets/models', extensions: null, required: false },
  { from: 'assets/fonts', to: 'assets/fonts', extensions: null, required: false },
  { from: 'assets/images', to: 'assets/images', extensions: null, required: false },
  { from: 'assets/shaders', to: 'assets/shaders', extensions: null, required: false },
  { from: 'public', to: 'public', extensions: null, required: false },
];

/** A record of one copied file, used for the manifest. */
interface ManifestEntry {
  /** Destination path relative to `dist/`, POSIX separators. */
  path: string;
  /** Size in bytes. */
  bytes: number;
}

/**
 * Copies one rule's files.
 *
 * @param rule The copy rule to apply.
 * @param manifest Accumulator for the manifest entries.
 * @returns The number of files copied.
 */
function applyRule(rule: CopyRule, manifest: ManifestEntry[]): number {
  const source = join(ROOT, rule.from);
  if (!existsSync(source)) {
    if (rule.required) throw new Error(`required asset directory is missing: ${rule.from}`);
    log.detail(`skipped ${rule.from} (not present)`);
    return 0;
  }

  const files = walk(source, (path) => {
    if (rule.extensions === null) return true;
    const lower = path.toLowerCase();
    return rule.extensions.some((extension) => lower.endsWith(extension));
  });

  if (files.length === 0) {
    log.detail(`skipped ${rule.from} (no matching files)`);
    return 0;
  }

  let copied = 0;
  let bytes = 0;
  for (const file of files) {
    const relative = file.slice(source.length + 1).split('\\').join('/');
    const destination = join(DIST, rule.to, relative);
    ensureDir(join(destination, '..'));
    copyFileSync(file, destination);
    const size = statSync(destination).size;
    manifest.push({ path: `${rule.to}/${relative}`, bytes: size });
    copied++;
    bytes += size;
  }
  log.detail(`${rule.from} -> dist/${rule.to} (${copied} files, ${formatBytes(bytes)})`);
  return copied;
}

/**
 * Copies every configured asset and writes the manifest.
 */
function main(): void {
  const manifest: ManifestEntry[] = [];
  let total = 0;

  for (const rule of RULES) total += applyRule(rule, manifest);

  manifest.sort((a, b) => a.path.localeCompare(b.path));

  // The Wasm placeholders are intentionally tiny; flag them so a release build
  // never silently ships the 8-byte stubs as if they were real modules.
  const stubs = manifest.filter(
    (entry) => entry.path.endsWith('.wasm') && entry.bytes <= 16,
  );
  if (stubs.length > 0) {
    log.warn(
      `${stubs.length} Wasm module(s) are header-only placeholders (${stubs
        .map((entry) => basename(entry.path))
        .join(', ')}); fine for development, replace before release`,
    );
  }

  const manifestPath = join(DIST, 'assets', 'manifest.json');
  writeIfChanged(
    manifestPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), files: manifest }, null, 2)}\n`,
  );

  log.ok(`copied ${total} asset file(s) into dist/`);
}

try {
  main();
} catch (error: unknown) {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
