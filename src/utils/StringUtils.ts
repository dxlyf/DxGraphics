/**
 * String helpers used by shader assembly, ID generation and debug output.
 *
 * @packageDocumentation
 */

import { hashString } from './MathUtils';

/** Converts `camelCase`/`PascalCase` to `kebab-case`. */
export function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

/** Converts `camelCase`/`kebab-case` to `snake_case`. */
export function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

/** Converts `snake_case`/`kebab-case` to `camelCase`. */
export function camelCase(value: string): string {
  return value
    .replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (c) => c.toLowerCase());
}

/** Converts `snake_case`/`kebab-case` to `PascalCase`. */
export function pascalCase(value: string): string {
  const camel = camelCase(value);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/** Upper-cases the first character, leaving the rest untouched. */
export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Truncates to `length` characters, appending `suffix` when trimmed. */
export function truncate(value: string, length: number, suffix: string = '…'): string {
  return value.length <= length ? value : value.slice(0, Math.max(0, length - suffix.length)) + suffix;
}

/** Pads a number with leading zeros to `width` digits. */
export function padNumber(value: number, width: number = 2): string {
  return Math.abs(value).toString().padStart(width, '0');
}

/** Formats a byte count as `1.5 MB`, `12.0 kB`, ... */
export function formatBytes(bytes: number, decimals: number = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(index === 0 ? 0 : decimals)} ${units[index]}`;
}

/** Formats a duration in seconds as `1m 03.2s` / `842ms`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'n/a';
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${padNumber(seconds - minutes * 60, 4)}s`;
}

/**
 * Indents every non-empty line of a shader snippet.
 *
 * Used by `ShaderChunk` when composing GLSL/WGSL so generated source stays
 * readable in `gl.getShaderSource` dumps.
 */
export function indent(source: string, spaces: number = 2): string {
  const prefix = ' '.repeat(spaces);
  return source
    .split('\n')
    .map((line) => (line.trim().length === 0 ? line : prefix + line))
    .join('\n');
}

/** Removes line comments and block comments from a shader source. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Collapses a shader source into a single-line hashing key.
 *
 * Comments and insignificant whitespace are removed first so that formatting
 * changes do not invalidate the compiled-program cache.
 */
export function shaderKey(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable numeric key for a shader source (see {@link shaderKey}). */
export function shaderHash(source: string): number {
  return hashString(shaderKey(source));
}

/** Replaces `{name}` placeholders in a template with values. */
export function interpolate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in variables ? String(variables[key]) : match,
  );
}

/** Prefixes every line of a GLSL/WGSL chunk with `#define`-style macros. */
export function injectDefines(source: string, defines: Record<string, string | number | boolean>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(defines)) {
    if (value === false) continue;
    lines.push(value === true ? `#define ${key}` : `#define ${key} ${value}`);
  }
  if (lines.length === 0) return source;
  return `${lines.join('\n')}\n${source}`;
}

/** `true` when `value` is a non-empty string after trimming. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Trims and lowercases a value for case-insensitive comparisons. */
export function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Joins URL fragments with `/`, collapsing duplicate separators.
 *
 * Named `joinUrlPath` (rather than `joinPath`) so it does not collide with the
 * filesystem-oriented `joinPath` exported by `utils/PathUtils`.
 */
export function joinUrlPath(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join('/')
    .replace(/([^:/])\/{2,}/g, '$1/');
}

/** Returns the file extension (without the dot) of a path, lowercased. */
export function getExtension(path: string): string {
  const match = /\.([^./\\]+)$/.exec(path);
  return match ? match[1].toLowerCase() : '';
}

/** Returns the file name (with extension) of a path. */
export function getFileName(path: string): string {
  const match = /[^/\\]*$/.exec(path);
  return match ? match[0] : path;
}

/** Returns the basename of a path, without its extension. */
export function getBaseName(path: string): string {
  return getFileName(path).replace(/\.[^.]*$/, '');
}
