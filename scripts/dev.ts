/**
 * `pnpm dev` — development entry point.
 *
 * Two modes:
 *
 * - **watch** (default): rebuild the library bundle and the type declarations on
 *   every change, so an external consumer (or the playground) picks the changes
 *   up immediately;
 * - **serve** (`--serve`): also start the Vite dev server for `playground/` and
 *   print the exact URL it is listening on.
 *
 * Usage:
 * ```text
 * node --experimental-strip-types scripts/dev.ts [--serve] [--types-only]
 * ```
 *
 * @packageDocumentation
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';

import { ROOT, log } from './_shared.ts';

/** The port the playground dev server prefers. */
const PREFERRED_PORT = 5173;

/**
 * Finds a free TCP port at or above `start`.
 *
 * Asking the OS for a free port beats hard-coding one: a stale server on 5173 is
 * the most common cause of "why is my change not showing up?".
 *
 * @param start First port to try.
 * @param attempts How many consecutive ports to probe.
 * @returns The first free port, or `null` when none of them are free.
 */
async function findFreePort(start: number, attempts = 20): Promise<number | null> {
  for (let port = start; port < start + attempts; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  return null;
}

/**
 * Runs a child process with inherited stdio so its output streams live.
 *
 * @param command Executable.
 * @param args Arguments.
 * @param label Prefix used in the log line.
 * @returns The child process.
 */
function spawnLive(command: string, args: readonly string[], label: string): ReturnType<typeof spawn> {
  log.step(`${label}: ${command} ${args.join(' ')}`);
  const child = spawn(command, [...args], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('exit', (code, signal) => {
    if (signal) log.warn(`${label} stopped (${signal})`);
    else if (code !== 0) log.error(`${label} exited with code ${code}`);
  });
  return child;
}

/**
 * Starts the development processes.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const serve = args.includes('--serve');
  const typesOnly = args.includes('--types-only');

  const children: ReturnType<typeof spawn>[] = [];

  // Type declarations in watch mode: an external consumer's editor sees the new
  // types as soon as the file is saved.
  children.push(
    spawnLive('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], 'types'),
  );

  if (!typesOnly) {
    // The library bundle, rebuilt on change.
    children.push(spawnLive('pnpm', ['exec', 'vite', 'build', '--watch'], 'bundle'));
  }

  if (serve) {
    const port = (await findFreePort(PREFERRED_PORT)) ?? PREFERRED_PORT;
    if (port !== PREFERRED_PORT) {
      log.warn(`port ${PREFERRED_PORT} is busy; using ${port} instead`);
    }
    children.push(
      spawnLive(
        'pnpm',
        ['exec', 'vite', '--config', join('playground', 'vite.config.ts'), '--port', String(port), '--strictPort'],
        'playground',
      ),
    );
    log.ok(`playground will be served at http://127.0.0.1:${port}/`);
  } else {
    log.detail('pass --serve to also start the playground dev server');
  }

  /** Shuts every child down cleanly. */
  const shutdown = (): void => {
    for (const child of children) {
      if (!child.killed) child.kill('SIGINT');
    }
  };

  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
