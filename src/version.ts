/**
 * Library version.
 *
 * Kept as a hand-maintained constant (rather than injected at build time) so the
 * value is available identically in ESM, CJS, workers and Node without a build
 * step. `scripts/release.ts` rewrites this file during a release.
 *
 * @packageDocumentation
 */

/** Semantic version of the library. */
export const VERSION = '0.1.0';

/** Major version component. */
export const VERSION_MAJOR = 0;

/** Minor version component. */
export const VERSION_MINOR = 1;

/** Patch version component. */
export const VERSION_PATCH = 0;

/** Human readable build identifier; `dev` outside of a published artifact. */
export const BUILD_ID = 'dev';

/** Parsed {@link VERSION} components. */
export interface VersionInfo {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  raw: string;
}

/**
 * Parse a semantic version string into its components.
 *
 * Tolerant by design: anything that is not a valid semver is reported as
 * `0.0.0` with the original string preserved in {@link VersionInfo.raw}.
 */
export function parseVersion(version: string = VERSION): VersionInfo {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?/.exec(version.trim());
  if (!match) {
    return { major: 0, minor: 0, patch: 0, prerelease: null, raw: version };
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    raw: version,
  };
}

/** `true` when {@link VERSION} carries a prerelease tag such as `-beta.1`. */
export const IS_PRERELEASE = parseVersion().prerelease !== null;

/** `"@dxyl/graphics@0.1.0"`, handy for logging and `User-Agent` style headers. */
export const VERSION_STRING = `@dxyl/graphics@${VERSION}`;

/**
 * Compare two semantic versions.
 *
 * @returns `-1` if `a < b`, `1` if `a > b`, `0` if they are equal.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  const preA = pa.prerelease;
  const preB = pb.prerelease;
  if (preA === preB) return 0;
  if (preA === null) return 1;
  if (preB === null) return -1;
  return preA < preB ? -1 : 1;
}
