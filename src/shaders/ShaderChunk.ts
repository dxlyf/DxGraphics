/**
 * `ShaderChunk` — a named chunk registry with dependency resolution.
 *
 * A chunk is a named source fragment that other sources pull in with an include
 * directive:
 *
 * ```glsl
 * // GLSL
 * #include <common>
 * ```
 *
 * ```wgsl
 * // WGSL
 * //!include common
 * ```
 *
 * Why a registry instead of a bundler: `.glsl`/`.wgsl` files need a
 * plugin (`vite-plugin-glsl`, `raw-loader`, ...) to become strings, and this
 * library must also work with plain `tsc`. Chunks therefore live in TypeScript
 * modules as template literals (`src/shaders/glsl/chunks/*.ts`) and are
 * registered here at import time; the include syntax is kept so the source text
 * still reads like a shader.
 *
 * Resolution rules:
 *  - includes are resolved depth-first, so a chunk appears *after* everything it
 *    depends on;
 *  - a chunk is emitted at most once per {@link resolve} call, which keeps
 *    diamond dependencies (`a` needs `b` and `c`, both need `d`) from duplicating
 *    `d` and breaking GLSL/WGSL redeclaration rules;
 *  - a cycle throws a {@link ShaderChunkError} naming the full chain
 *    (`a -> b -> a`) instead of overflowing the stack;
 *  - a bare name is qualified with the caller's language (`common` becomes
 *    `glsl/common` when resolving GLSL) before the unqualified fallback is tried.
 *
 * @packageDocumentation
 */

import { log } from '../utils/Logger';
import type { ShaderLanguage } from './types';

/** Raised for a missing chunk, a malformed include or a dependency cycle. */
export class ShaderChunkError extends Error {
  /** Name of the chunk the error is about, when known. */
  public readonly chunk: string | undefined;

  /** Dependency chain leading to the failure, outermost first. */
  public readonly chain: readonly string[];

  /**
   * @param message Human-readable description.
   * @param chunk Chunk the error is about.
   * @param chain Dependency chain, for diagnostics.
   */
  constructor(message: string, chunk?: string, chain: readonly string[] = []) {
    super(chain.length > 0 ? `${message} (chain: ${chain.join(' -> ')})` : message);
    this.name = 'ShaderChunkError';
    this.chunk = chunk;
    this.chain = chain;
  }
}

/** A registered chunk. */
interface ChunkRecord {
  /** Source text, includes still unresolved. */
  source: string;
  /** Language the chunk was written in, when it declared one. */
  language: ShaderLanguage | undefined;
  /** `true` for the chunks shipped with the library. */
  builtin: boolean;
}

/** The registry, keyed by (possibly language-qualified) chunk name. */
const registry = new Map<string, ChunkRecord>();

/** Matches `#include <name>` and `#include "name"` anywhere in GLSL source. */
const GLSL_INCLUDE = /#[ \t]*include[ \t]*[<"]([\w.\-/]+)[>"]/g;

/** Matches a whole `//!include name` line in WGSL source. */
const WGSL_INCLUDE = /^[ \t]*\/\/![ \t]*include[ \t]+([\w.\-/]+)[ \t]*$/gm;

/** Valid chunk-name shape: letters, digits, `_`, `-`, `.` and `/`. */
const VALID_NAME = /^[\w.\-/]+$/;

/** Options accepted when registering a chunk. */
export interface DefineChunkOptions {
  /** Language the chunk is written in; enables `'<language>/<name>'` lookups. */
  language?: ShaderLanguage;
  /** `true` for library chunks, which `clearChunks()` keeps by default. */
  builtin?: boolean;
  /**
   * Reject a redefinition instead of replacing it. Defaults to `false`, so user
   * code can override a built-in chunk.
   */
  strict?: boolean;
}

/** Options accepted by {@link resolve}. */
export interface ShaderChunkResolveOptions {
  /** Language of the source being resolved; qualifies bare include names. */
  language?: ShaderLanguage;
  /** Separator inserted between expanded chunks. Defaults to `'\n'`. */
  separator?: string;
  /** Throw when an include cannot be resolved. Defaults to `true`. */
  failOnMissing?: boolean;
  /** Keep the include directive when a chunk is missing (only when `failOnMissing` is false). */
  keepMissing?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Registers (or replaces) a chunk.
 *
 * @param name Chunk name; `'glsl/lighting'` and `'lighting'` are distinct keys.
 * @param source Source text, which may itself contain include directives.
 * @param options Registration options.
 * @throws ShaderChunkError when the name is malformed, the source is empty or
 *   `strict` is set and the chunk already exists.
 */
export function defineChunk(name: string, source: string, options: DefineChunkOptions = {}): void {
  if (!VALID_NAME.test(name)) {
    throw new ShaderChunkError(`Invalid shader chunk name "${name}"`, name);
  }
  if (typeof source !== 'string' || source.length === 0) {
    throw new ShaderChunkError(`Shader chunk "${name}" needs a non-empty source`, name);
  }
  if (registry.has(name)) {
    if (options.strict) {
      throw new ShaderChunkError(`Shader chunk "${name}" is already defined`, name);
    }
    log.debug(`Shader chunk "${name}" was redefined`);
  }
  registry.set(name, {
    source,
    language: options.language,
    builtin: options.builtin ?? false,
  });
}

/**
 * Registers several chunks at once.
 *
 * @param chunks Chunk name to source map.
 * @param options Shared registration options.
 */
export function defineChunks(
  chunks: Readonly<Record<string, string>>,
  options: DefineChunkOptions = {},
): void {
  for (const [name, source] of Object.entries(chunks)) defineChunk(name, source, options);
}

/** Removes a chunk. Returns `true` when a chunk was removed. */
export function undefineChunk(name: string): boolean {
  return registry.delete(name);
}

/**
 * Removes chunks from the registry.
 *
 * @param includeBuiltins Also drop the chunks shipped with the library.
 * @returns The number of chunks removed.
 */
export function clearChunks(includeBuiltins: boolean = false): number {
  let removed = 0;
  for (const [name, record] of Array.from(registry)) {
    if (record.builtin && !includeBuiltins) continue;
    registry.delete(name);
    removed++;
  }
  return removed;
}

/** `true` when a chunk is registered under `name`. */
export function hasChunk(name: string): boolean {
  return registry.has(name);
}

/**
 * Reads a chunk's source.
 *
 * @param name Chunk name.
 * @throws ShaderChunkError when the chunk is not registered.
 */
export function getChunk(name: string): string {
  const record = registry.get(name);
  if (!record) throw new ShaderChunkError(`Shader chunk "${name}" is not defined`, name);
  return record.source;
}

/** Every registered chunk name, in registration order. */
export function listChunks(): string[] {
  return Array.from(registry.keys());
}

/** Chunk names that contain a given language, when they declared one. */
export function listChunksByLanguage(language: ShaderLanguage): string[] {
  const names: string[] = [];
  for (const [name, record] of registry) {
    if (record.language === language) names.push(name);
  }
  return names;
}

/** `true` when a chunk is one of the library's built-in chunks. */
export function isBuiltinChunk(name: string): boolean {
  return registry.get(name)?.builtin ?? false;
}

/**
 * Qualifies a bare chunk name with a language prefix.
 *
 * @param name Chunk name.
 * @param language Language to qualify with.
 * @returns `'<language>/<name>'`, or `name` unchanged when it is already qualified.
 */
export function qualifyChunkName(name: string, language?: ShaderLanguage): string {
  if (!language) return name;
  return name.startsWith(`${language}/`) ? name : `${language}/${name}`;
}

/**
 * Resolves a chunk name against the registry, trying the language-qualified
 * spelling first and the bare spelling second.
 *
 * @returns The registry key, or `null` when neither exists.
 */
export function findChunkKey(name: string, language?: ShaderLanguage): string | null {
  const qualified = qualifyChunkName(name, language);
  if (registry.has(qualified)) return qualified;
  if (registry.has(name)) return name;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Includes                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Extracts the include names referenced by a source, in order of appearance.
 *
 * @param source Source text.
 * @param language Language to look for; both syntaxes are scanned when omitted.
 */
export function extractIncludes(source: string, language?: ShaderLanguage): string[] {
  const names: string[] = [];
  if (language !== 'wgsl') {
    for (const match of source.matchAll(new RegExp(GLSL_INCLUDE.source, 'g'))) names.push(match[1]);
  }
  if (language !== 'glsl') {
    for (const match of source.matchAll(new RegExp(WGSL_INCLUDE.source, 'gm'))) names.push(match[1]);
  }
  return names;
}

/**
 * Direct dependencies of a registered chunk.
 *
 * @param name Chunk name.
 * @throws ShaderChunkError when the chunk is not registered.
 */
export function getChunkDependencies(name: string): string[] {
  const record = registry.get(name);
  if (!record) throw new ShaderChunkError(`Shader chunk "${name}" is not defined`, name);
  return extractIncludes(record.source, record.language);
}

/** Removes every include directive from a source. */
export function stripIncludes(source: string): string {
  return source
    .replace(new RegExp(GLSL_INCLUDE.source, 'g'), '')
    .replace(new RegExp(WGSL_INCLUDE.source, 'gm'), '');
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Resolves one chunk (and its transitive dependencies) into flat source text.
 *
 * @param name Chunk name; a bare name is language-qualified before lookup.
 * @param options Resolution options.
 * @returns The concatenated source of the chunk and its dependencies.
 * @throws ShaderChunkError for a missing chunk or a dependency cycle.
 */
export function resolveChunk(name: string, options: ShaderChunkResolveOptions = {}): string {
  const state: ResolveState = {
    resolved: new Set<string>(),
    stack: [],
    options,
  };
  return expandChunk(name, state);
}

/**
 * Resolves a list of chunk names, emitting each chunk at most once.
 *
 * @param names Chunk names, in the order they should appear.
 * @param options Resolution options.
 * @returns The concatenated, de-duplicated source.
 * @throws ShaderChunkError for a missing chunk or a dependency cycle.
 */
export function resolveChunkNames(
  names: readonly string[],
  options: ShaderChunkResolveOptions = {},
): string {
  const state: ResolveState = {
    resolved: new Set<string>(),
    stack: [],
    options,
  };
  const parts: string[] = [];
  for (const name of names) {
    const source = expandChunk(name, state);
    if (source.length > 0) parts.push(source);
  }
  return parts.join(options.separator ?? '\n');
}

/**
 * Resolves a template (or a list of chunk names).
 *
 * ```ts
 * resolve('#include <common>\nvoid main() {}', { language: 'glsl' });
 * resolve(['glsl/common', 'glsl/lighting']);
 * ```
 *
 * @param input Template text with include directives, or an array of chunk names.
 * @param options Resolution options.
 * @returns The resolved source.
 * @throws ShaderChunkError for a missing chunk or a dependency cycle.
 */
export function resolve(
  input: string | readonly string[],
  options: ShaderChunkResolveOptions = {},
): string {
  if (Array.isArray(input)) return resolveChunkNames(input as readonly string[], options);
  return expandTemplate(input as string, {
    resolved: new Set<string>(),
    stack: [],
    options,
  });
}

/** Mutable state threaded through a single `resolve()` call. */
interface ResolveState {
  /** Chunks already emitted by this call. */
  resolved: Set<string>;
  /** Chunks currently being expanded, innermost last (cycle detection). */
  stack: string[];
  /** Caller options. */
  options: ShaderChunkResolveOptions;
}

/** Resolves the includes of `source` and returns the expanded text. */
function expandTemplate(source: string, state: ResolveState): string {
  const separator = state.options.separator ?? '\n';
  const language = state.options.language;

  // GLSL first, then WGSL: a source is written in exactly one language, so the
  // order only matters for the (documented) case of an unqualified source.
  let result = source.replace(new RegExp(GLSL_INCLUDE.source, 'g'), (_match, name: string) => {
    return includeChunkSource(name, state, separator);
  });

  result = result.replace(new RegExp(WGSL_INCLUDE.source, 'gm'), (_match, name: string) => {
    return includeChunkSource(name, state, separator);
  });

  return result;
}

/** Expands one chunk, recursively, with cycle detection and de-duplication. */
function expandChunk(name: string, state: ResolveState): string {
  const key = findChunkKey(name, state.options.language);
  if (key === null) {
    return missingChunk(name, state);
  }
  if (state.stack.includes(key)) {
    const chain = [...state.stack, key];
    throw new ShaderChunkError(`Circular shader chunk dependency involving "${key}"`, key, chain);
  }
  if (state.resolved.has(key)) return '';

  state.stack.push(key);
  const record = registry.get(key) as ChunkRecord;
  const expanded = expandTemplate(record.source, state);
  state.stack.pop();
  state.resolved.add(key);
  return expanded;
}

/** Emits or rejects a missing include. */
function missingChunk(name: string, state: ResolveState): string {
  const from = state.stack.length > 0 ? state.stack[state.stack.length - 1] : undefined;
  const message = from
    ? `Shader chunk "${name}" is not defined (included from "${from}")`
    : `Shader chunk "${name}" is not defined`;
  if (state.options.failOnMissing ?? true) {
    throw new ShaderChunkError(message, name, [...state.stack, name]);
  }
  log.warnOnce(message);
  return state.options.keepMissing ? `#include <${name}>` : '';
}

/** Shared implementation used by the template replacer. */
function includeChunkSource(name: string, state: ResolveState, separator: string): string {
  const key = findChunkKey(name, state.options.language);
  if (key === null) return missingChunk(name, state);
  const expanded = expandChunk(name, state);
  return expanded.length > 0 ? `${expanded}${separator}` : '';
}

/**
 * The transitive dependency list of a chunk, in resolution order.
 *
 * @param name Chunk name.
 * @param options Resolution options (only `language` is used).
 * @returns Chunk keys, dependencies first.
 */
export function getChunkDependencyTree(
  name: string,
  options: ShaderChunkResolveOptions = {},
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (current: string, stack: string[]): void => {
    const key = findChunkKey(current, options.language);
    if (key === null) throw new ShaderChunkError(`Shader chunk "${current}" is not defined`, current);
    if (seen.has(key)) return;
    if (stack.includes(key)) {
      throw new ShaderChunkError(`Circular shader chunk dependency involving "${key}"`, key, [...stack, key]);
    }
    for (const dependency of getChunkDependencies(key)) visit(dependency, [...stack, key]);
    seen.add(key);
    out.push(key);
  };
  visit(name, []);
  return out;
}
