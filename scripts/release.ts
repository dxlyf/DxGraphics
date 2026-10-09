/**
 * `pnpm release` — cut a release.
 *
 * Steps, in order, each of which can be skipped:
 *
 * 1. **guard**   refuse to run on a dirty tree or on a branch other than `main`
 * 2. **bump**    update the version in `package.json`, `src/version.ts` and the
 *                `CHANGELOG.md` heading, then commit and tag
 * 3. **verify**  typecheck, lint, test and a full build
 * 4. **publish** `npm publish --access public`
 *
 * The script is intentionally conservative: it never pushes, and `--dry-run`
 * prints every command it would have run. Pushing the tag is left to the caller
 * so a release cannot be published by a stray CI job.
 *
 * Usage:
 * ```text
 * node --experimental-strip-types scripts/release.ts 0.2.0 [--dry-run] [--skip-tests] [--no-git]
 * ```
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { ROOT, log, readPackageJson, run, writeIfChanged } from './_shared.ts';

/** Parsed release options. */
export interface ReleaseOptions {
  /** The version to release, e.g. `1.2.3` or `1.2.3-beta.1`. */
  version: string;
  /** Print the commands instead of running them. */
  dryRun: boolean;
  /** Skip the test/lint/typecheck stage. */
  skipChecks: boolean;
  /** Skip the git commit/tag stage. */
  skipGit: boolean;
  /** Skip `npm publish`. */
  skipPublish: boolean;
}

/** A full semver, optionally with a prerelease tag. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

/**
 * Parses the command line.
 *
 * @param argv Arguments following the script name.
 * @returns The resolved options.
 * @throws When no version, or an invalid version, is supplied.
 */
export function parseReleaseArgs(argv: readonly string[]): ReleaseOptions {
  const version = argv.find((argument) => !argument.startsWith('-'));
  if (!version) {
    throw new Error('usage: release.ts <version> [--dry-run] [--skip-tests] [--no-git] [--no-publish]');
  }
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`"${version}" is not a valid semantic version (expected e.g. 1.2.3 or 1.2.3-rc.1)`);
  }
  return {
    version,
    dryRun: argv.includes('--dry-run'),
    skipChecks: argv.includes('--skip-tests'),
    skipGit: argv.includes('--no-git'),
    skipPublish: argv.includes('--no-publish'),
  };
}

/**
 * Runs a command, honouring `--dry-run`.
 *
 * @param command Executable.
 * @param args Arguments.
 * @param options Release options.
 */
async function maybeRun(
  command: string,
  args: readonly string[],
  options: ReleaseOptions,
): Promise<void> {
  const printable = `${command} ${args.join(' ')}`;
  if (options.dryRun) {
    log.detail(`[dry-run] ${printable}`);
    return;
  }
  log.detail(printable);
  await run(command, args);
}

/**
 * Rewrites the version constants in `src/version.ts`.
 *
 * The file is hand-maintained (rather than injected at build time) so the value is
 * identical in ESM, CJS, workers and Node; a release has to keep it in sync.
 *
 * @param version The new version.
 * @returns `true` when the file changed.
 */
function bumpVersionSource(version: string): boolean {
  const path = join(ROOT, 'src', 'version.ts');
  const source = readFileSync(path, 'utf8');
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number);

  const updated = source
    .replace(/export const VERSION = '[^']*';/, `export const VERSION = '${version}';`)
    .replace(/export const VERSION_MAJOR = \d+;/, `export const VERSION_MAJOR = ${major};`)
    .replace(/export const VERSION_MINOR = \d+;/, `export const VERSION_MINOR = ${minor};`)
    .replace(/export const VERSION_PATCH = \d+;/, `export const VERSION_PATCH = ${patch};`)
    .replace(/export const BUILD_ID = '[^']*';/, `export const BUILD_ID = '${version}';`);

  return writeIfChanged(path, updated);
}

/**
 * Adds a `CHANGELOG.md` heading for the version when one is missing.
 *
 * @param version The new version.
 * @returns `true` when the file changed.
 */
function bumpChangelog(version: string): boolean {
  const path = join(ROOT, 'CHANGELOG.md');
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  if (source.includes(`## [${version}]`)) return false;

  const date = new Date().toISOString().slice(0, 10);
  const marker = '<!-- releases -->';
  const index = source.indexOf(marker);
  const heading = `## [${version}] - ${date}\n\n### Changed\n\n- Release ${version}.\n\n`;

  const updated =
    index >= 0
      ? `${source.slice(0, index + marker.length)}\n\n${heading}${source.slice(index + marker.length).replace(/^\s*/, '')}`
      : `${source}\n\n${heading}`;

  return writeIfChanged(path, updated);
}

/**
 * Performs the release.
 */
async function main(): Promise<void> {
  const options = parseReleaseArgs(process.argv.slice(2));
  const pkg = readPackageJson();
  const current = String(pkg.version ?? '0.0.0');

  log.step(`Releasing ${String(pkg.name)} ${current} -> ${options.version}`);
  if (options.dryRun) log.warn('dry run: no files will be written and no commands run');

  /* ---------------------------------------------------------------- guard */

  if (!options.skipGit) {
    const status = await run('git', ['status', '--porcelain']).catch(() => '');
    if (status.trim().length > 0) {
      throw new Error('the working tree is dirty; commit or stash your changes first');
    }
    const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (branch !== 'main' && branch !== 'master') {
      log.warn(`releasing from branch "${branch}" rather than main`);
    }
  }

  /* ----------------------------------------------------------------- bump */

  if (!options.dryRun) {
    const pkgPath = join(ROOT, 'package.json');
    const manifest = readFileSync(pkgPath, 'utf8');
    writeIfChanged(
      pkgPath,
      manifest.replace(/"version":\s*"[^"]*"/, `"version": "${options.version}"`),
    );
    log.ok(`package.json version -> ${options.version}`);

    if (bumpVersionSource(options.version)) log.ok(`src/version.ts -> ${options.version}`);
    else log.warn('src/version.ts was already current');

    if (bumpChangelog(options.version)) log.ok('CHANGELOG.md heading added');
  } else {
    log.detail(`[dry-run] package.json version -> ${options.version}`);
    log.detail(`[dry-run] src/version.ts -> ${options.version}`);
  }

  /* --------------------------------------------------------------- verify */

  if (options.skipChecks) {
    log.warn('verification skipped');
  } else {
    log.step('Verifying');
    await maybeRun('pnpm', ['run', 'typecheck'], options);
    await maybeRun('pnpm', ['run', 'test'], options);
    await maybeRun('pnpm', ['run', 'build'], options);
  }

  /* ------------------------------------------------------------------ git */

  if (!options.skipGit) {
    log.step('Committing and tagging');
    await maybeRun('git', ['add', 'package.json', 'src/version.ts', 'CHANGELOG.md'], options);
    await maybeRun('git', ['commit', '-m', `chore(release): ${options.version}`], options);
    await maybeRun('git', ['tag', '-a', `v${options.version}`, '-m', `v${options.version}`], options);
  }

  /* -------------------------------------------------------------- publish */

  if (options.skipPublish) {
    log.warn('publish skipped');
  } else {
    log.step('Publishing to npm');
    await maybeRun('npm', ['publish', '--access', 'public', '--provenance'], options);
  }

  log.ok(`release ${options.version} prepared`);
  if (!options.dryRun && !options.skipGit) {
    log.detail(`push it with: git push origin HEAD --follow-tags`);
  }
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
