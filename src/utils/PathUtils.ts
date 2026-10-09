/**
 * Filesystem-independent path helpers.
 *
 * These intentionally avoid `node:path` so the module stays usable in the
 * browser (asset URLs, cache keys) and in workers.
 *
 * @packageDocumentation
 */

/** Splits a path into non-empty segments, normalising separators. */
export function splitPath(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter((part) => part.length > 0);
}

/** Joins segments with `/`, collapsing duplicate separators. */
export function joinPath(...segments: string[]): string {
  const collapsed = segments
    .filter((part) => part.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
  return collapsed;
}

/** Normalises a path by resolving `.` and `..` segments textually. */
export function normalizePath(path: string): string {
  const isAbsolute = path.startsWith('/');
  const parts = splitPath(path);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop();
      else if (!isAbsolute) stack.push('..');
      continue;
    }
    stack.push(part);
  }
  return (isAbsolute ? '/' : '') + stack.join('/');
}

/** Returns the directory portion of a path (always ending with `/` or empty). */
export function dirname(path: string): string {
  const index = path.replace(/\\/g, '/').lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index + 1);
}

/** Returns the file name portion of a path (everything after the last `/`). */
export function basename(path: string, extension?: string): string {
  const index = path.replace(/\\/g, '/').lastIndexOf('/');
  const name = index < 0 ? path : path.slice(index + 1);
  if (extension && name.endsWith(extension)) return name.slice(0, -extension.length);
  return name;
}

/** Returns the extension of a path, including the leading dot. */
export function extname(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index);
}

/** `true` when the path points to an absolute location or an absolute URL. */
export function isAbsolutePath(path: string): boolean {
  return /^([a-z]+:\/\/|\/|\\\\|[a-z]:[\\/])/i.test(path);
}

/** `true` when the string looks like a data URI. */
export function isDataUri(path: string): boolean {
  return /^data:[^,]*[,;]/i.test(path);
}

/** `true` when the string is an http(s) URL. */
export function isHttpUrl(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

/** `true` when the string is a blob URL. */
export function isBlobUrl(path: string): boolean {
  return /^blob:/i.test(path);
}

/** Resolves `relative` against `base` (textually, no filesystem access). */
export function resolvePath(base: string, relative: string): string {
  if (isAbsolutePath(relative)) return normalizePath(relative);
  const directory = dirname(base);
  return normalizePath(`${directory}${relative}`);
}

/**
 * Resolves an asset reference against a base URL.
 *
 * Absolute URLs, data URIs, blob URLs and protocol-relative paths are returned
 * unchanged; everything else is joined onto `baseUrl`.
 */
export function resolveAssetUrl(baseUrl: string, relative: string): string {
  if (
    relative.length === 0 ||
    isAbsolutePath(relative) ||
    isDataUri(relative) ||
    isBlobUrl(relative) ||
    relative.startsWith('//')
  ) {
    return relative;
  }
  return joinPath(baseUrl, relative);
}

/** Appends a cache-busting query parameter when `version` is provided. */
export function withCacheBust(url: string, version?: string | number | null): string {
  if (version == null) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}v=${encodeURIComponent(String(version))}`;
}

/** Converts a Windows-style path to POSIX separators. */
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/');
}

/** Removes a leading `/`, `./` or protocol from a path. */
export function stripLeadingSlash(path: string): string {
  return path.replace(/^\.?\//, '');
}

/** Ensures the path ends with exactly one `/`. */
export function ensureTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

/** Removes a trailing `/` unless the path is exactly `/`. */
export function removeTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * Builds a query string.
 *
 * `undefined` and `null` values are skipped; arrays are repeated.
 */
export function buildQueryString(
  params: Record<string, string | number | boolean | null | undefined | readonly (string | number)[]>,
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/** Parses a query string into a plain record (last value wins). */
export function parseQueryString(query: string): Record<string, string> {
  const result: Record<string, string> = {};
  const source = query.startsWith('?') ? query.slice(1) : query;
  if (source.length === 0) return result;
  for (const pair of source.split('&')) {
    const index = pair.indexOf('=');
    if (index < 0) {
      result[decodeURIComponent(pair)] = '';
      continue;
    }
    result[decodeURIComponent(pair.slice(0, index))] = decodeURIComponent(pair.slice(index + 1));
  }
  return result;
}

/** Numeric-aware natural comparison used to sort file lists. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
