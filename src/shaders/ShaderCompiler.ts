/**
 * `ShaderCompiler` — backend-agnostic compile/link orchestration.
 *
 * The compiler owns the three jobs every backend would otherwise repeat:
 *  1. **source assembly** — chunk includes resolved, defines injected;
 *  2. **caching** — one {@link ShaderCache} keyed by the assembled source, so two
 *     materials that differ only in formatting share a program;
 *  3. **statistics** — compile/link counts, cache hits and releases.
 *
 * A backend only has to implement the structural {@link ShaderBackend} contract:
 *
 * ```ts
 * const compiler = new ShaderCompiler();
 * compiler.registerBackend('webgl2', {
 *   name: 'webgl2',
 *   languages: ['glsl'],
 *   compileShader: (stage, source) => gl.createShader(...),
 *   linkProgram: (compiled) => gl.createProgram(...),
 *   disposeProgram: (program) => gl.deleteProgram(program.handle),
 * });
 * const program = compiler.compile({ name: 'basic', language: 'glsl', vertex, fragment });
 * ```
 *
 * @packageDocumentation
 */

import { shaderKey } from '../utils/StringUtils';
import { ShaderCache } from './ShaderCache';
import { resolve } from './ShaderChunk';
import type {
  CompiledProgram,
  CompiledShader,
  ShaderBackend,
  ShaderCompileOptions,
  ShaderDescriptor,
  ShaderLanguage,
  ShaderStage,
  ShaderStats,
} from './types';

/** Raised when a program cannot be compiled, linked or dispatched. */
export class ShaderCompileError extends Error {
  /** Name of the descriptor that failed. */
  public readonly shaderName: string;

  /** Backend name that failed. */
  public readonly backend: string;

  /** Stage that failed, when the failure was stage-specific. */
  public readonly stage: ShaderStage | undefined;

  /**
   * @param message Human-readable description.
   * @param shaderName Descriptor name.
   * @param backend Backend name.
   * @param stage Stage that failed.
   * @param cause Original error, when one was caught.
   */
  constructor(
    message: string,
    shaderName: string,
    backend: string,
    stage?: ShaderStage,
    cause?: unknown,
  ) {
    super(
      stage
        ? `${message} (shader "${shaderName}", ${backend}, ${stage} stage)`
        : `${message} (shader "${shaderName}", ${backend})`,
    );
    this.name = 'ShaderCompileError';
    this.shaderName = shaderName;
    this.backend = backend;
    this.stage = stage;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Alias kept for the name used in the layer's documentation.
 *
 * `ShaderBackend` (declared in `types.ts`) and `IShaderBackend` are the same
 * structural interface; the `I`-prefixed spelling matches the other renderer
 * contracts (`ITexture`, `IShader`, ...).
 */
export type IShaderBackend = ShaderBackend;

/** The stages a descriptor can carry, in pipeline order. */
const STAGE_ORDER: readonly ShaderStage[] = ['vertex', 'fragment', 'compute'];

/** Milliseconds since the process started, when the platform exposes it. */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Orchestrates compilation for every registered backend.
 *
 * One compiler instance normally lives on the renderer: it holds the program
 * cache and is disposed with the renderer.
 */
export class ShaderCompiler {
  /** Registered backends, keyed by name. */
  private readonly backends = new Map<string, ShaderBackend>();

  /** Compiled program cache. */
  private readonly cache: ShaderCache<CompiledProgram>;

  /** Programs compiled from scratch. */
  private compiles = 0;

  /** Stages compiled from scratch. */
  private stageCompiles = 0;

  /** Programs served from the cache. */
  private cacheHits = 0;

  /** Compilations that missed the cache. */
  private cacheMisses = 0;

  /** Compilations that threw. */
  private failures = 0;

  /** Programs released through `invalidate`/`releaseAll`. */
  private released = 0;

  /** `true` once `dispose()` has run; further `compile()` calls throw. */
  private disposed = false;

  /**
   * @param cache Program cache to use; a private one is created when omitted.
   */
  constructor(cache?: ShaderCache<CompiledProgram>) {
    this.cache = cache ?? new ShaderCache<CompiledProgram>();
    this.cache.onEvict = (entry) => {
      this.releaseProgram(entry.value);
    };
  }

  /* -------------------------------------------------------------- backends */

  /**
   * Registers a backend under its own name.
   *
   * @param backend Backend implementation.
   * @returns This compiler, for chaining.
   */
  public registerBackend(backend: ShaderBackend): this;

  /**
   * Registers a backend under an explicit name.
   *
   * @param name Name used by {@link compile}'s `backend` option.
   * @param backend Backend implementation.
   * @returns This compiler, for chaining.
   */
  public registerBackend(name: string, backend: ShaderBackend): this;

  /** Shared implementation behind both overloads. */
  public registerBackend(nameOrBackend: string | ShaderBackend, backend?: ShaderBackend): this {
    if (backend === undefined) {
      const self = nameOrBackend as ShaderBackend;
      this.backends.set(self.name, self);
      return this;
    }
    this.backends.set(nameOrBackend as string, backend);
    return this;
  }

  /** Removes a backend from the registry. Returns `true` when it existed. */
  public unregisterBackend(name: string): boolean {
    return this.backends.delete(name);
  }

  /**
   * Reads a backend.
   *
   * @param name Backend name; the first registered backend when omitted.
   */
  public getBackend(name?: string): ShaderBackend | undefined {
    if (name === undefined) {
      const first = this.backends.values().next();
      return first.done ? undefined : first.value;
    }
    return this.backends.get(name);
  }

  /** Every registered backend name, in registration order. */
  public listBackends(): string[] {
    return Array.from(this.backends.keys());
  }

  /* ----------------------------------------------------------------- cache */

  /** The program cache backing this compiler. */
  public getCache(): ShaderCache<CompiledProgram> {
    return this.cache;
  }

  /**
   * Cache key for a descriptor plus options.
   *
   * The key *is* `shaderKey(assembled source)` — comments and insignificant
   * whitespace removed — with the defines folded in, so two define variants can
   * never collide. `options.cacheKeySuffix` appends an explicit variant tag.
   *
   * @param descriptor Descriptor to key.
   * @param options Compile options that affect the source.
   */
  public keyFor(descriptor: ShaderDescriptor, options: ShaderCompileOptions = {}): string {
    const language = options.language ?? descriptor.language;
    const defines = { ...descriptor.defines, ...options.defines };
    const parts: string[] = [`language=${language}`];
    for (const key of Object.keys(defines).sort()) {
      parts.push(`#define ${key} ${String(defines[key])}`);
    }
    for (const stage of STAGE_ORDER) {
      const source = this.stageSource(descriptor, stage);
      if (source !== undefined) parts.push(`${stage}:${source}`);
    }
    const base = shaderKey(parts.join('\n'));
    return options.cacheKeySuffix ? `${base}#${options.cacheKeySuffix}` : base;
  }

  /**
   * Reads a cached program.
   *
   * @param key Key from {@link keyFor} or {@link compile}.
   * @param backend Backend namespace; defaults to the first registered backend.
   */
  public getProgram(key: string, backend?: string): CompiledProgram | undefined {
    return this.cache.get(key, backend ?? this.defaultBackendName());
  }

  /** `true` when a program is cached. */
  public hasProgram(key: string, backend?: string): boolean {
    return this.cache.peek(key, backend ?? this.defaultBackendName()) !== undefined;
  }

  /* -------------------------------------------------------------- compile */

  /**
   * Compiles and links a descriptor.
   *
   * @param descriptor Program description; includes are resolved and defines
   *   injected before the backend sees the source.
   * @param options Backend selection, define overrides and caching flags.
   * @returns The compiled program — either a cached one or a freshly built one.
   * @throws ShaderCompileError when no backend can compile the descriptor or the
   *   backend fails.
   */
  public compile(descriptor: ShaderDescriptor, options: ShaderCompileOptions = {}): CompiledProgram {
    if (this.disposed) {
      throw new ShaderCompileError('ShaderCompiler has been disposed', descriptor.name, 'none');
    }

    const backendName = options.backend ?? this.defaultBackendName();
    const backend = this.backends.get(backendName);
    if (!backend) {
      throw new ShaderCompileError(
        `No shader backend registered under "${backendName}"`,
        descriptor.name,
        backendName,
      );
    }

    const language: ShaderLanguage = options.language ?? descriptor.language;
    if (backend.languages.length > 0 && !backend.languages.includes(language)) {
      throw new ShaderCompileError(
        `Backend "${backendName}" does not accept ${language.toUpperCase()} sources`,
        descriptor.name,
        backendName,
      );
    }

    const key = this.keyFor(descriptor, options);
    const useCache = options.cache ?? true;
    if (useCache && !options.force) {
      const cached = this.cache.get(key, backendName);
      if (cached) {
        this.cacheHits++;
        return cached;
      }
    }

    this.cacheMisses++;
    const stages = this.stagesOf(descriptor);
    if (stages.length === 0) {
      this.failures++;
      throw new ShaderCompileError('Descriptor declares no shader stage', descriptor.name, backendName);
    }

    const compiled: CompiledShader[] = [];
    for (const stage of stages) {
      let source: string;
      try {
        source = this.assembleStage(descriptor, stage, options) ?? '';
      } catch (error) {
        this.failures++;
        throw new ShaderCompileError(
          error instanceof Error ? error.message : 'Shader source assembly failed',
          descriptor.name,
          backendName,
          stage,
          error,
        );
      }
      try {
        compiled.push({ stage, handle: backend.compileShader(stage, source, descriptor), source });
        this.stageCompiles++;
      } catch (error) {
        this.failures++;
        throw new ShaderCompileError(
          error instanceof Error ? error.message : 'Shader compilation failed',
          descriptor.name,
          backendName,
          stage,
          error,
        );
      }
    }

    let handle: unknown;
    try {
      handle = backend.linkProgram(compiled, descriptor);
    } catch (error) {
      this.failures++;
      throw new ShaderCompileError(
        error instanceof Error ? error.message : 'Shader link failed',
        descriptor.name,
        backendName,
        undefined,
        error,
      );
    }

    const program: CompiledProgram = {
      key,
      backend: backendName,
      descriptor,
      handle,
      shaders: compiled,
      created: now(),
    };

    this.compiles++;
    if (useCache) this.cache.set(key, program, backendName);
    return program;
  }

  /**
   * Assembles the source of one stage: includes resolved, defines injected.
   *
   * @param descriptor Descriptor owning the stage.
   * @param stage Stage to assemble.
   * @param options Compile options.
   * @returns The source, or `undefined` when the stage is absent.
   * @throws ShaderChunkError for an unknown chunk or a dependency cycle.
   */
  public assembleStage(
    descriptor: ShaderDescriptor,
    stage: ShaderStage,
    options: ShaderCompileOptions = {},
  ): string | undefined {
    const source = this.stageSource(descriptor, stage);
    if (source === undefined) return undefined;

    const language = options.language ?? descriptor.language;
    const defines = { ...descriptor.defines, ...options.defines };

    const withIncludes =
      options.resolveIncludes === false ? source : resolve(source, { language, separator: '\n' });

    const defineLines: string[] = [];
    for (const name of Object.keys(defines).sort()) {
      const value = defines[name];
      if (value === false) continue;
      defineLines.push(value === true ? `#define ${name}` : `#define ${name} ${String(value)}`);
    }
    if (defineLines.length === 0) return withIncludes;
    return `${defineLines.join('\n')}\n${withIncludes}`;
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Releases one cached program.
   *
   * @param key Cache key.
   * @param backend Backend namespace.
   * @returns `true` when a program was released.
   */
  public invalidate(key: string, backend?: string): boolean {
    const namespace = backend ?? this.defaultBackendName();
    const program = this.cache.peek(key, namespace);
    if (!program) return false;
    this.cache.delete(key, namespace);
    this.releaseProgram(program);
    return true;
  }

  /**
   * Releases every cached program, optionally only one backend's.
   *
   * @param backend Backend namespace; omit to release everything.
   * @returns The number of programs released.
   */
  public invalidateAll(backend?: string): number {
    let count = 0;
    for (const [namespace, key] of this.cacheEntries()) {
      if (backend !== undefined && namespace !== backend) continue;
      const program = this.cache.peek(key, namespace);
      if (!program) continue;
      this.cache.delete(key, namespace);
      this.releaseProgram(program);
      count++;
    }
    return count;
  }

  /**
   * Releases every program and empties the cache.
   *
   * @returns The number of programs released.
   */
  public releaseAll(): number {
    return this.invalidateAll();
  }

  /** Current counters. */
  public getStats(): ShaderStats {
    return {
      compiles: this.compiles,
      stageCompiles: this.stageCompiles,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      failures: this.failures,
      programs: this.cache.size,
      released: this.released,
      backends: this.listBackends(),
    };
  }

  /** Resets the counters without touching the cache. */
  public resetStats(): void {
    this.compiles = 0;
    this.stageCompiles = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.failures = 0;
    this.released = 0;
  }

  /** Releases every program and drops the registered backends. */
  public dispose(): void {
    if (this.disposed) return;
    this.invalidateAll();
    this.cache.clear();
    this.cache.onEvict = null;
    this.backends.clear();
    this.disposed = true;
  }

  /* ------------------------------------------------------------ internals */

  /** Stages a descriptor actually declares, in pipeline order. */
  private stagesOf(descriptor: ShaderDescriptor): ShaderStage[] {
    return STAGE_ORDER.filter((stage) => {
      const source = this.stageSource(descriptor, stage);
      return typeof source === 'string' && source.length > 0;
    });
  }

  /** Raw source of one stage. */
  private stageSource(descriptor: ShaderDescriptor, stage: ShaderStage): string | undefined {
    switch (stage) {
      case 'vertex':
        return descriptor.vertex;
      case 'fragment':
        return descriptor.fragment;
      case 'compute':
        return descriptor.compute;
      default:
        return undefined;
    }
  }

  /** Name used when the caller does not pin a backend. */
  private defaultBackendName(): string {
    const first = this.backends.keys().next();
    return first.done ? 'default' : first.value;
  }

  /** `[namespace, key]` pairs for every cached program. */
  private cacheEntries(): [string, string][] {
    const out: [string, string][] = [];
    for (const backend of this.cache.backends()) {
      for (const key of this.cache.keys(backend)) out.push([backend, key]);
    }
    return out;
  }

  /** Hands a program back to its owning backend, ignoring failures. */
  private releaseProgram(program: CompiledProgram): void {
    const backend = this.backends.get(program.backend);
    this.released++;
    if (!backend) return;
    try {
      backend.disposeProgram(program);
    } catch {
      /* a backend that cannot release a program must not break teardown */
    }
  }
}
