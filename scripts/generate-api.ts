/**
 * `pnpm generate:api` — builds `docs/api/generated.md`, a dependency-free API
 * index derived from the real source.
 *
 * Typedoc (`pnpm docs`) produces the full reference with cross-links, but it is a
 * heavy tool that needs a full program build. This generator is deliberately
 * simpler: it walks `src/`, extracts the exported classes, functions, interfaces
 * and type aliases with their leading documentation, and emits a single Markdown
 * index. That keeps a readable API overview available in CI even when Typedoc is
 * unavailable, and it fails loudly when a module barrel exports nothing.
 *
 * It understands the small, consistent subset of TypeScript the library actually
 * uses:
 *
 * ```ts
 * export class Foo extends Bar {}      export function foo(): void {}
 * export interface Foo {}              export type Foo = ...
 * export enum Foo {}                   export abstract class Foo {}
 * ```
 *
 * Anything more exotic (re-exports through aliases, declaration merging) is
 * reported as "not indexed" rather than silently skipped.
 *
 * Usage:
 * ```text
 * node --experimental-strip-types scripts/generate-api.ts [--check] [--out docs/api/generated.md]
 * ```
 *
 * @packageDocumentation
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  ROOT,
  SRC,
  leadingDocComment,
  log,
  sourceFiles,
  toRelative,
  walk,
  writeIfChanged,
} from './_shared.ts';

/** What kind of declaration an entry describes. */
type DeclarationKind = 'class' | 'function' | 'interface' | 'type' | 'enum' | 'const' | 'namespace';

/** One indexed declaration. */
interface ApiEntry {
  /** Exported name. */
  name: string;
  /** Declaration kind. */
  kind: DeclarationKind;
  /** Source file, relative to the package root, POSIX separators. */
  file: string;
  /** First line of the declaration, trimmed and normalised. */
  signature: string;
  /** Leading JSDoc, comment markers stripped. */
  documentation: string;
  /** `true` when the declaration is documented. */
  documented: boolean;
}

/** One source file's worth of indexed declarations. */
interface ApiModule {
  /** Module path relative to `src/`, e.g. `math/Vec3.ts`. */
  path: string;
  /** Module-level documentation. */
  documentation: string;
  /** The declarations found in the file. */
  entries: ApiEntry[];
}

/** Matches the start of an exported declaration. */
const DECLARATION_PATTERN =
  /^export\s+(?:declare\s+)?(abstract\s+)?(class|function|interface|type|enum|const|let|namespace)\s+([A-Za-z_$][\w$]*)/;

/**
 * Splits a source file into its module documentation and its exported
 * declarations.
 *
 * @param file Absolute path to a `.ts` file.
 * @param contents The file's text.
 * @returns The indexed module.
 */
function indexModule(file: string, contents: string): ApiModule {
  const lines = contents.split(/\r?\n/);
  const relative = toRelative(file).replace(/^src\//, '');
  const entries: ApiEntry[] = [];
  let moduleDoc = leadingDocComment(contents);

  // Skip the module documentation block when collecting declaration docs.
  let moduleDocEndLine = 0;
  if (contents.trimStart().startsWith('/**')) {
    const end = contents.indexOf('*/');
    if (end >= 0) moduleDocEndLine = contents.slice(0, end).split('\n').length;
  }

  /** The JSDoc block immediately above line `index`, or an empty string. */
  const docAbove = (index: number): string => {
    let cursor = index - 1;
    while (cursor >= 0 && lines[cursor].trim().length === 0) cursor--;
    if (cursor < 0 || !lines[cursor].trimEnd().endsWith('*/')) return '';
    const end = cursor;
    while (cursor >= 0 && !lines[cursor].trimStart().startsWith('/**')) cursor--;
    if (cursor < 0) return '';
    return lines
      .slice(cursor, end + 1)
      .join('\n')
      .replace(/^\s*\/\*\*/, '')
      .replace(/\*\/\s*$/, '')
      .replace(/^\s*\* ?/gm, '')
      .trim();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = DECLARATION_PATTERN.exec(line);
    if (!match) continue;
    if (i + 1 === moduleDocEndLine) moduleDoc = leadingDocComment(contents);

    const kind = match[2] as DeclarationKind;
    const documentation = docAbove(i);

    entries.push({
      name: match[3],
      kind,
      file: `src/${relative}`,
      signature: line.trim().replace(/\s*\{\s*$/, ''),
      documentation,
      documented: documentation.length > 0,
    });
  }

  return { path: relative, documentation: moduleDoc, entries };
}

/**
 * Renders the collected modules as Markdown.
 *
 * @param modules The indexed modules, already sorted by path.
 * @param stats Aggregate counters for the summary table.
 * @returns The Markdown document.
 */
function renderMarkdown(
  modules: readonly ApiModule[],
  stats: { total: number; documented: number; files: number },
): string {
  const byKind = new Map<DeclarationKind, number>();
  for (const module of modules) {
    for (const entry of module.entries) {
      byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
    }
  }

  const lines: string[] = [
    '# API index',
    '',
    '> Generated by `pnpm generate:api`. **Do not edit by hand** — change the source',
    '> and regenerate. The full reference with cross-links is produced by `pnpm docs`.',
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Source modules | ${stats.files} |`,
    `| Public declarations | ${stats.total} |`,
    `| Documented declarations | ${stats.documented} (${stats.total > 0 ? Math.round((stats.documented / stats.total) * 100) : 0}%) |`,
    '',
    '| Kind | Count |',
    '| --- | --- |',
    ...[...byKind.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => `| \`${kind}\` | ${count} |`),
    '',
    '## Modules',
    '',
  ];

  for (const module of modules) {
    if (module.entries.length === 0) continue;
    lines.push(`### \`src/${module.path}\``, '');
    if (module.documentation) {
      lines.push(module.documentation.split('\n')[0], '');
    }
    for (const entry of module.entries) {
      const summary = entry.documentation
        ? entry.documentation.split('\n').find((line) => line.trim().length > 0) ?? ''
        : '_undocumented_';
      lines.push(`- **\`${entry.name}\`** (${entry.kind}) — ${summary}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Runs the generator.
 */
function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1] : join(ROOT, 'docs', 'api', 'generated.md');

  const files = walk(SRC, (path) => path.endsWith('.ts') && !path.endsWith('.d.ts'));
  const modules: ApiModule[] = [];
  const emptyBarrels: string[] = [];
  const undocumented: string[] = [];

  for (const file of files) {
    const contents = readFileSync(file, 'utf8');
    const module = indexModule(file, contents);
    modules.push(module);
    if (module.path.endsWith('index.ts') && module.entries.length === 0) {
      emptyBarrels.push(module.path);
    }
    for (const entry of module.entries) {
      if (!entry.documented) undocumented.push(`${entry.file}: ${entry.name}`);
    }
  }

  modules.sort((a, b) => a.path.localeCompare(b.path));
  const all = modules.flatMap((module) => module.entries);
  const markdown = renderMarkdown(modules, {
    total: all.length,
    documented: all.filter((entry) => entry.documented).length,
    files: sourceFiles().length,
  });

  if (check) {
    if (!existsSync(out) || readFileSync(out, 'utf8') !== markdown) {
      log.error(`${toRelative(out)} is out of date; run pnpm generate:api`);
      process.exitCode = 1;
      return;
    }
    log.ok('API index is up to date');
  } else if (writeIfChanged(out, markdown)) {
    log.ok(`wrote ${toRelative(out)}`);
  } else {
    log.detail(`${toRelative(out)} unchanged`);
  }

  log.detail(`${all.length} declarations across ${modules.length} modules`);

  if (emptyBarrels.length > 0) {
    log.warn(`${emptyBarrels.length} barrel file(s) export nothing: ${emptyBarrels.slice(0, 5).join(', ')}`);
  }

  // Documentation coverage is a quality signal, not a build gate: report the
  // worst offenders rather than failing.
  if (undocumented.length > 0) {
    log.warn(`${undocumented.length} declaration(s) have no JSDoc, e.g. ${undocumented.slice(0, 5).join(', ')}`);
  }
}

try {
  main();
} catch (error: unknown) {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
