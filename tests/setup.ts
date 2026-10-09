/**
 * Global Vitest setup.
 *
 * Runs once per test file before the suite. Keeps the environment deterministic:
 *  - pinned `Math.random` is *not* applied (tests that need determinism use
 *    `seededRandom`), but a per-test tolerance helper is installed;
 *  - logging is quietened unless `LYF_TEST_LOG=1`;
 *  - DOM-free tests keep working in the Node environment.
 */

import { afterEach, beforeEach } from 'vitest';
import { LogLevel, resetIdCounter, setLogLevel } from '../src/utils';

/** Set `LYF_TEST_LOG=1` to see library warnings and errors while testing. */
const verbose = typeof process !== 'undefined' && process.env?.LYF_TEST_LOG === '1';

beforeEach(() => {
  resetIdCounter();
  setLogLevel(verbose ? LogLevel.Debug : LogLevel.Error);
});

afterEach(() => {
  // Nothing global to unwind yet; kept as the single place to add teardown.
});
