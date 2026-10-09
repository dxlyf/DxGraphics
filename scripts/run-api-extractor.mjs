/**
 * Runs `api-extractor` when it is available in the local `node_modules`, and
 * explains how to opt in when it is not.
 *
 * `api-extractor` is deliberately *not* a required devDependency: it is a heavy
 * tool that only matters when publishing an API report, and the public registry
 * occasionally serves broken metadata for it. Installing it on demand keeps
 * `pnpm install` fast and reliable while `pnpm api` still works for maintainers:
 *
 *   pnpm add -D api-extractor && pnpm api
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);

/** Candidate paths for the `api-extractor` executable. */
const candidates = [
  'node_modules/api-extractor/bin/api-extractor',
  'node_modules/.bin/api-extractor',
  'node_modules/.bin/api-extractor.cmd',
];

const found = candidates.find((candidate) => existsSync(candidate));

if (!found) {
  console.warn(
    [
      '',
      'api-extractor is not installed, skipping the API report.',
      '',
      'The TypeScript declaration files are still produced by:',
      '  pnpm run build:types',
      '',
      'To generate the rolled-up .d.ts and the API report:',
      '  pnpm add -D api-extractor',
      '  pnpm run api',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

let command = found;
let args = ['run', '--local'];

if (found.endsWith('api-extractor')) {
  // Execute the JS entry point through the current node binary so the script
  // behaves identically on Windows and POSIX shells.
  args = [require.resolve(found.replace(/\\/g, '/')), 'run', '--local'];
  command = process.execPath;
}

const result = spawnSync(command, args, { stdio: 'inherit', shell: false });

if (result.error) {
  console.error(`Failed to run api-extractor: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 0);
