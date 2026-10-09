#!/usr/bin/env -S node --experimental-strip-types
/**
 * Visual regression runner.
 *
 * Compares freshly rendered snapshots against the committed baselines in
 * `tests/visual/baselines/`, reports a per-pixel diff ratio, and writes diff images to
 * `tests/visual/diff/`.
 *
 * ## The decoder problem, and how this tool solves it
 *
 * Comparing snapshots means comparing decoded pixels. Decoding PNG without a dependency
 * means implementing inflate — hundreds of lines that would be the least trustworthy code
 * in the repository — and `package.json` may not gain a dependency. So this runner works
 * with **headerless raw RGBA** files (`.rgba`), which the renderer can produce with no
 * decoding at all:
 *
 * ```js
 * // in the browser, where the snapshot is taken
 * const image = ctx.getImageData(0, 0, width, height);          // Canvas2D
 * // or: gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf); // WebGL
 * download(new Blob([new Uint8Array(image.data.buffer)]), 'scene.rgba');
 * ```
 *
 * PNG is still supported **when a decoder already exists in the environment**: `sharp` or
 * `pngjs` is used if it resolves, and nothing is installed if it does not (see
 * `compare.ts`). When neither is available, `--png` fails with an explanation rather than
 * guessing.
 *
 * The runner always writes its **diff images as PNG**, using Node's built-in `zlib` — so the
 * artifacts you inspect are ordinary viewable images even though the comparison inputs are
 * raw.
 *
 * ## Baseline naming convention
 *
 * `tests/visual/baselines/<name>.<width>x<height>.rgba`
 *
 * The dimensions are in the filename because the format carries no header; the runner parses
 * them rather than being told, so a baseline cannot silently disagree with its own size. See
 * `tests/visual/baselines/README.md`.
 *
 * ## Usage
 *
 * ```bash
 * # Compare every actual snapshot against its baseline
 * node --experimental-strip-types tools/visual-test-runner/runner.ts
 *
 * # Compare one case
 * node --experimental-strip-types tools/visual-test-runner/runner.ts --name 2d-basic
 *
 * # Promote every actual snapshot to be the new baseline
 * node --experimental-strip-types tools/visual-test-runner/runner.ts --update
 *
 * # Loosen the per-channel tolerance and the allowed diff ratio
 * node --experimental-strip-types tools/visual-test-runner/runner.ts --threshold 0.15 --max-diff 0.02
 * ```
 *
 * ## Directories
 *
 * | Path | Role |
 * | --- | --- |
 * | `tests/visual/actual/` | Freshly rendered `.rgba` snapshots (git-ignored). |
 * | `tests/visual/baselines/` | Committed `.rgba` references. |
 * | `tests/visual/diff/` | Generated diff PNGs plus `report.json`. |
 *
 * ## Exit codes
 *
 * `0` every comparison passed (or `--update` ran), `1` at least one failed or a baseline is
 * missing, `2` bad usage or an unreadable input.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The `.ts` extension is required: Node's ESM loader does not resolve extensions, and these
 * tools run directly through `node --experimental-strip-types`. This matches the convention
 * already used by `scripts/**` (e.g. `import … from './_shared.ts'`).
 */
import {
  BitmapError,
  compareBitmaps,
  encodePng,
  readPngToRgba,
  type Bitmap,
  type CompareResult,
} from './compare.ts';

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(toolsDir, '..', '..');

const visualDir = join(repoRoot, 'tests', 'visual');
const baselineDir = join(visualDir, 'baselines');
const actualDir = join(visualDir, 'actual');
const diffDir = join(visualDir, 'diff');

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

interface CliOptions {
  readonly update: boolean;
  readonly name: string | null;
  readonly threshold: number;
  readonly maxDiffRatio: number;
  readonly alphaCutoff: number;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly clean: boolean;
  readonly png: boolean;
}

/** Prints usage. */
function printUsage(): void {
  process.stdout.write(
    [
      'runner — compare rendered snapshots against tests/visual/baselines',
      '',
      'Usage:',
      '  runner [--update] [--name <case>] [--threshold 0..1] [--max-diff 0..1]',
      '         [--alpha-cutoff 0..255] [--json] [--quiet] [--clean] [--png]',
      '',
      'Options:',
      '  --update          Promote every actual snapshot to be the new baseline.',
      '  --name <case>     Only process snapshots whose name matches.',
      '  --threshold 0..1  Per-channel tolerance counted as "unchanged" (default 0.1).',
      '  --max-diff 0..1   Allowed fraction of differing pixels (default 0.01).',
      '  --alpha-cutoff N  Ignore pixels whose alpha is at or below N (default 0).',
      '  --png             Read .png snapshots too, if a decoder is installed.',
      '  --clean           Delete tests/visual/diff before running.',
      '  --json            Emit a machine-readable report.',
      '  --quiet           Only print failures and the summary.',
      '  -h, --help        Show this message.',
      '',
      'Exit codes: 0 pass (or --update), 1 a comparison failed, 2 bad usage.',
      '',
    ].join('\n'),
  );
}

/** Parses the CLI arguments. */
function parseArgs(argv: readonly string[]): CliOptions {
  let update = false;
  let name: string | null = null;
  let threshold = 0.1;
  let maxDiffRatio = 0.01;
  let alphaCutoff = 0;
  let json = false;
  let quiet = false;
  let clean = false;
  let png = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--update':
        update = true;
        break;
      case '--name':
        name = argv[++i] ?? null;
        if (name === null) {
          process.stderr.write('runner: --name needs a value\n');
          process.exit(2);
        }
        break;
      case '--threshold':
        threshold = Number(argv[++i]);
        break;
      case '--max-diff':
        maxDiffRatio = Number(argv[++i]);
        break;
      case '--alpha-cutoff':
        alphaCutoff = Number(argv[++i]);
        break;
      case '--json':
        json = true;
        break;
      case '--quiet':
        quiet = true;
        break;
      case '--clean':
        clean = true;
        break;
      case '--png':
        png = true;
        break;
      case '-h':
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('-')) {
          process.stderr.write(`runner: unknown option '${arg}'\n`);
          printUsage();
          process.exit(2);
        }
    }
  }

  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    process.stderr.write(`runner: --threshold must be within 0..1 (got ${threshold})\n`);
    process.exit(2);
  }
  if (!Number.isFinite(maxDiffRatio) || maxDiffRatio < 0 || maxDiffRatio > 1) {
    process.stderr.write(`runner: --max-diff must be within 0..1 (got ${maxDiffRatio})\n`);
    process.exit(2);
  }

  return { update, name, threshold, maxDiffRatio, alphaCutoff, json, quiet, clean, png };
}

/* -------------------------------------------------------------------------- */
/* Snapshot discovery                                                         */
/* -------------------------------------------------------------------------- */

/** A snapshot file and its parsed dimensions. */
interface Snapshot {
  /** Case name, as used in the baseline filename. */
  readonly name: string;
  readonly path: string;
  readonly format: 'rgba' | 'png';
  /** `null` for PNG, where the decoder reports the size. */
  readonly width: number | null;
  readonly height: number | null;
}

/**
 * Parses `<name>.<width>x<height>.rgba` out of a filename.
 *
 * The dimensions live in the name because a headerless format cannot report them, and
 * parsing them means a baseline can never silently disagree with its own size.
 */
export function parseSnapshotName(fileName: string): Snapshot | null {
  const extension = extname(fileName).toLowerCase();

  if (extension === '.png') {
    return {
      name: basename(fileName, extension),
      path: fileName,
      format: 'png',
      width: null,
      height: null,
    };
  }

  if (extension !== '.rgba') return null;

  const match = /^(.*)\.(\d+)x(\d+)\.rgba$/.exec(fileName);
  if (match === null) {
    process.stderr.write(
      `runner: '${fileName}' does not follow the naming convention. Raw RGBA carries no ` +
        'header, so the dimensions must be in the filename:\n' +
        '  <name>.<width>x<height>.rgba   e.g.  2d-basic.800x500.rgba\n',
    );
    return null;
  }

  const width = Number(match[2]);
  const height = Number(match[3]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    process.stderr.write(`runner: '${fileName}' has non-positive dimensions\n`);
    return null;
  }

  return { name: match[1], path: fileName, format: 'rgba', width, height };
}

/** Lists the snapshot files in a directory, skipping the documentation files. */
function listSnapshots(directory: string, png: boolean): Snapshot[] {
  if (!existsSync(directory)) return [];
  const result: Snapshot[] = [];
  for (const entry of readdirSync(directory)) {
    const extension = extname(entry).toLowerCase();
    if (extension === '.png' && !png) continue;
    if (extension !== '.png' && extension !== '.rgba') continue;
    const parsed = parseSnapshotName(entry);
    if (parsed === null) continue;
    result.push({ ...parsed, path: join(directory, entry) });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/** Reads a snapshot into a bitmap, using the format-appropriate path. */
async function loadSnapshot(snapshot: Snapshot): Promise<Bitmap> {
  if (snapshot.format === 'png') return readPngToRgba(snapshot.path);
  if (snapshot.width === null || snapshot.height === null) {
    throw new BitmapError(`loadSnapshot: '${snapshot.path}' has no parsed dimensions`);
  }
  const fs = (await import('node:fs')) as unknown as { readFileSync(p: string): Uint8Array };
  const buffer = fs.readFileSync(snapshot.path);
  const expected = snapshot.width * snapshot.height * 4;
  if (buffer.byteLength !== expected) {
    throw new BitmapError(
      `'${basename(snapshot.path)}' is ${buffer.byteLength} bytes but ` +
        `${snapshot.width}×${snapshot.height} RGBA needs ${expected}. Either the filename's ` +
        'dimensions are wrong or the file is not tightly packed RGBA.',
    );
  }
  return {
    width: snapshot.width,
    height: snapshot.height,
    data: new Uint8ClampedArray(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  };
}

/** Writes raw RGBA bytes. */
async function writeRaw(path: string, bitmap: Bitmap): Promise<void> {
  const fs = (await import('node:fs')) as unknown as {
    writeFileSync(p: string, data: Uint8Array | Uint8ClampedArray): void;
  };
  fs.writeFileSync(path, bitmap.data);
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

/** One case's outcome. */
interface CaseReport {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'missing-baseline' | 'updated' | 'error';
  readonly diffRatio?: number;
  readonly diffPixels?: number;
  readonly totalPixels?: number;
  readonly maxChannelDelta?: number;
  readonly reason?: string;
  readonly diffImage?: string;
  readonly error?: string;
}

/** Formats a fraction as a percentage with three decimals. */
function percent(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.clean && existsSync(diffDir)) {
    rmSync(diffDir, { recursive: true, force: true });
  }
  mkdirSync(diffDir, { recursive: true });
  mkdirSync(baselineDir, { recursive: true });

  const actuals = listSnapshots(actualDir, options.png);
  if (actuals.length === 0) {
    const message =
      `runner: no snapshots found in ${actualDir.replace(repoRoot + '\\', '').replace(repoRoot + '/', '')}.\n\n` +
      'There is nothing to compare, which is not the same as passing. Produce snapshots\n' +
      'first — they are raw, tightly packed RGBA written as `<name>.<w>x<h>.rgba`:\n' +
      '  Canvas2D   ctx.getImageData(0, 0, w, h).data\n' +
      '  WebGL      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buffer)\n' +
      'Snapshots come from a real browser context: this repository has no headless GPU, so\n' +
      'the runner never fabricates them. See tests/visual/README.md.';
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ cases: [], note: message }, null, 2)}\n`);
    } else {
      process.stdout.write(`${message}\n`);
    }
    // Reporting "nothing to do" is not a successful visual test run.
    process.exit(1);
  }

  const filtered =
    options.name === null ? actuals : actuals.filter((snapshot) => snapshot.name === options.name);
  if (filtered.length === 0) {
    process.stderr.write(`runner: no snapshot matched --name '${options.name ?? ''}'\n`);
    process.exit(2);
  }

  const reports: CaseReport[] = [];

  for (const snapshot of filtered) {
    try {
      const actual = await loadSnapshot(snapshot);
      const baselinePath = join(baselineDir, `${snapshot.name}.${actual.width}x${actual.height}.rgba`);

      if (options.update) {
        mkdirSync(baselineDir, { recursive: true });
        await writeRaw(baselinePath, actual);
        reports.push({ name: snapshot.name, status: 'updated' });
        continue;
      }

      if (!existsSync(baselinePath)) {
        reports.push({
          name: snapshot.name,
          status: 'missing-baseline',
          reason:
            `no baseline at tests/visual/baselines/${basename(baselinePath)}. Run with ` +
            '`--update` once the rendering is known to be correct.',
        });
        continue;
      }

      const baselineStat = statSync(baselinePath);
      const baselineParsed = parseSnapshotName(basename(baselinePath));
      if (baselineParsed === null || baselineParsed.width === null || baselineParsed.height === null) {
        reports.push({
          name: snapshot.name,
          status: 'error',
          error: `the baseline name '${basename(baselinePath)}' is malformed`,
        });
        continue;
      }

      const baseline = await loadSnapshot({
        ...baselineParsed,
        path: baselinePath,
      });

      let diffFileName: string | undefined;
      const result: CompareResult = compareBitmaps(baseline, actual, {
        threshold: options.threshold,
        maxDiffRatio: options.maxDiffRatio,
        alphaCutoff: options.alphaCutoff,
      });

      // The diff image is encoded as a real PNG through Node's built-in `zlib`, so the
      // artifact is viewable in any image tool even though the compared inputs are raw.
      if (result.diff !== undefined) {
        diffFileName = `${snapshot.name}.${result.diff.width}x${result.diff.height}.diff.png`;
        const png = await encodePng(result.diff);
        writeFileSync(join(diffDir, diffFileName), png);
      }

      reports.push({
        name: snapshot.name,
        status: result.passed ? 'pass' : 'fail',
        diffRatio: result.diffRatio,
        diffPixels: result.diffPixels,
        totalPixels: result.totalPixels,
        maxChannelDelta: result.maxChannelDelta,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(diffFileName === undefined ? {} : { diffImage: `tests/visual/diff/${diffFileName}` }),
      });

      void baselineStat;
    } catch (error) {
      reports.push({
        name: snapshot.name,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /* ---------------------------------------------------------------- output */

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          options: {
            threshold: options.threshold,
            maxDiffRatio: options.maxDiffRatio,
            alphaCutoff: options.alphaCutoff,
            update: options.update,
          },
          cases: reports,
          summary: summarise(reports),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const report of reports) {
      if (options.quiet && report.status === 'pass') continue;

      const tag =
        report.status === 'pass'
          ? 'PASS'
          : report.status === 'updated'
            ? 'WROTE'
            : report.status === 'fail'
              ? 'FAIL'
              : report.status === 'missing-baseline'
                ? 'NO BASE'
                : 'ERROR';

      let line = `${tag.padEnd(8)} ${report.name}`;
      if (report.diffRatio !== undefined) {
        line += `  ${percent(report.diffRatio)} differ (${report.diffPixels}/${report.totalPixels})`;
        if (report.maxChannelDelta !== undefined) line += `  maxΔ ${report.maxChannelDelta}`;
      }
      process.stdout.write(`${line}\n`);
      if (report.reason !== undefined) process.stdout.write(`         ${report.reason}\n`);
      if (report.error !== undefined) process.stdout.write(`         ${report.error}\n`);
      if (report.diffImage !== undefined) {
        process.stdout.write(`         diff: ${report.diffImage}\n`);
      }
    }

    const summary = summarise(reports);
    process.stdout.write(
      `\n${summary.total} case(s): ${summary.passed} passed, ${summary.failed} failed, ` +
        `${summary.missing} missing a baseline, ${summary.updated} updated, ${summary.errored} errored\n`,
    );
    if (summary.failed > 0 || summary.missing > 0) {
      process.stdout.write(
        `Diff images (if any) are in tests/visual/diff/. Inspect them before running ` +
          '`--update`: promoting a bad render to a baseline makes the regression permanent.\n',
      );
    }
  }

  /* ---------------------------------------------------------------- report */

  writeFileSync(
    join(diffDir, 'report.json'),
    `${JSON.stringify({ cases: reports, summary: summarise(reports) }, null, 2)}\n`,
    'utf8',
  );

  const summary = summarise(reports);
  if (summary.errored > 0) process.exit(2);
  if (summary.failed > 0 || summary.missing > 0) process.exit(1);
  process.exit(0);
}

/** Aggregates the per-case reports. */
function summarise(reports: readonly CaseReport[]): {
  total: number;
  passed: number;
  failed: number;
  missing: number;
  updated: number;
  errored: number;
} {
  return {
    total: reports.length,
    passed: reports.filter((r) => r.status === 'pass').length,
    failed: reports.filter((r) => r.status === 'fail').length,
    missing: reports.filter((r) => r.status === 'missing-baseline').length,
    updated: reports.filter((r) => r.status === 'updated').length,
    errored: reports.filter((r) => r.status === 'error').length,
  };
}

main().catch((error: unknown) => {
  process.stderr.write(
    `runner: unexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(2);
});
