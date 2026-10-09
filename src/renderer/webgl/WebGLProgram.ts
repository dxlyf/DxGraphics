/**
 * Program linking, reflection and caching.
 *
 * A {@link WebGLProgram} owns two {@link WebGLShader} stages, links them, reflects
 * the resulting interface and exposes it as an {@link IShader}, which is the
 * contract the material layer speaks.
 *
 * ## Diagnostics
 *
 * Link failures are reported with both stage logs and the program log, each
 * annotated by {@link formatWebGLInfoLog}. Because a program log refers to lines of
 * *one* of the two stages without saying which, the lines are dispatched to the
 * source they fit into; a line that fits neither is reproduced verbatim rather
 * than dropped.
 *
 * ## Cache key
 *
 * {@link buildProgramKey} hashes the exact source pair plus the preprocessor
 * definitions, keeping the source lengths in the key so a hash collision cannot
 * silently swap two programs with different sizes. See the module report for the
 * full scheme.
 *
 * @packageDocumentation
 */

import { createId } from '../../utils/Id';
import { createLogger } from '../../utils/Logger';
import {
  ShaderStage,
  ShaderValueType,
  type IShader,
  type ShaderCompileResult,
  type ShaderMember,
  type UniformValue,
} from '../interfaces/IShader';
import { formatWebGLInfoLog, parseWebGLInfoLog, prependDefines, WebGLShader, type DefineValue } from './WebGLShader';
import { reflectUniforms, WebGLUniforms, type WebGLUniformInfo } from './WebGLUniforms';
import { glConst, type GL, type GLProgramObject, type GLShaderObject } from './WebGLUtils';

/** Logger for program diagnostics. */
const log = createLogger('renderer:webgl:program');

/* -------------------------------------------------------------------------- */
/* Attribute reflection                                                       */
/* -------------------------------------------------------------------------- */

/** Reflected description of one active vertex attribute. */
export interface WebGLAttributeInfo {
  /** Name exactly as the driver reports it. */
  readonly name: string;
  /** Attribute location the linker assigned. */
  readonly location: number;
  /** Value kind, mapped from the GL type. */
  readonly type: ShaderValueType | null;
  /** Raw `gl.*` type, kept for callers that need the exact component type. */
  readonly glType: number;
  /** Number of components per element (1..4). */
  readonly size: number;
}

/**
 * Reflects the active attributes of a linked program and binds their locations.
 *
 * @param gl Context the program belongs to.
 * @param program Linked program handle.
 * @returns One entry per active attribute.
 */
export function reflectAttributes(gl: GL, program: GLProgramObject): WebGLAttributeInfo[] {
  const count = readProgramParameter(gl, program, 'ACTIVE_ATTRIBUTES', 0x8b89);
  const infos: WebGLAttributeInfo[] = [];

  for (let i = 0; i < count; i++) {
    const active = gl.getActiveAttrib(program, i);
    if (active == null) continue;
    infos.push({
      name: active.name,
      location: gl.getAttribLocation(program, active.name),
      type: mapAttributeType(gl, active.type),
      glType: active.type,
      size: Math.max(1, active.size),
    });
  }

  return infos;
}

/** Maps a GL attribute type onto {@link ShaderValueType}. */
function mapAttributeType(gl: GL, glType: number): ShaderValueType | null {
  const float = glConst(gl, 'FLOAT', 0x1406);
  if (glType === float) return ShaderValueType.Float;
  const vec2 = glConst(gl, 'FLOAT_VEC2', 0x8b50);
  if (glType === vec2) return ShaderValueType.Vec2;
  const vec3 = glConst(gl, 'FLOAT_VEC3', 0x8b51);
  if (glType === vec3) return ShaderValueType.Vec3;
  const vec4 = glConst(gl, 'FLOAT_VEC4', 0x8b52);
  if (glType === vec4) return ShaderValueType.Vec4;
  const int = glConst(gl, 'INT', 0x1404);
  if (glType === int) return ShaderValueType.Int;
  const ivec2 = glConst(gl, 'INT_VEC2', 0x8b53);
  if (glType === ivec2) return ShaderValueType.IVec2;
  const ivec3 = glConst(gl, 'INT_VEC3', 0x8b54);
  if (glType === ivec3) return ShaderValueType.IVec3;
  const ivec4 = glConst(gl, 'INT_VEC4', 0x8b55);
  if (glType === ivec4) return ShaderValueType.IVec4;
  return null;
}

/** Reads a program parameter defensively. */
function readProgramParameter(gl: GL, program: GLProgramObject, name: string, fallback: number): number {
  try {
    const value = gl.getProgramParameter(program, glConst(gl, name, fallback));
    return typeof value === 'number' && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Cache key                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 32-bit FNV-1a hash, rendered as eight hex digits.
 *
 * Chosen over a rolling sum because it mixes every byte: two shaders that differ by
 * a single character in the middle must not collide, which a positional sum of
 * characters would allow.
 *
 * @param value Text to hash.
 * @returns Eight lowercase hex digits.
 */
export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    // `hash * 16777619` with 32-bit wraparound, written with shifts to stay exact.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Renders a definitions map as a stable, order-independent string. */
export function stableDefinesKey(defines: Readonly<Record<string, DefineValue>> | undefined): string {
  if (defines === undefined) return '';
  const names = Object.keys(defines).sort();
  const parts: string[] = [];
  for (const name of names) {
    const value = defines[name];
    parts.push(`${name}=${value === null || value === undefined ? '' : String(value)}`);
  }
  return parts.join(';');
}

/**
 * Builds the cache key for a program.
 *
 * Scheme: `v<vertexLength>x<vertexHash>-f<fragmentLength>x<fragmentHash>-d<definesHash>`.
 * The lengths are included so a hash collision between two shaders of different
 * sizes degrades to a cache miss instead of handing back the wrong program.
 *
 * @param vertexSource Vertex source, before definitions are injected.
 * @param fragmentSource Fragment source.
 * @param defines Preprocessor definitions.
 * @returns A stable key for the (source, defines) triple.
 */
export function buildProgramKey(
  vertexSource: string,
  fragmentSource: string,
  defines?: Readonly<Record<string, DefineValue>>,
): string {
  const vertex = `v${vertexSource.length.toString(36)}x${hashString(vertexSource)}`;
  const fragment = `f${fragmentSource.length.toString(36)}x${hashString(fragmentSource)}`;
  const defineKey = stableDefinesKey(defines);
  const definitions = defineKey.length === 0 ? 'd0' : `d${hashString(defineKey)}`;
  return `${vertex}-${fragment}-${definitions}`;
}

/* -------------------------------------------------------------------------- */
/* Bounded LRU cache                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Minimal bounded LRU map.
 *
 * JavaScript's `Map` preserves insertion order, so re-inserting a key on access
 * makes iteration order least-recently-used-first and eviction is a single
 * `keys().next()`. A doubly linked list would be faster for very large caches but
 * this one is bounded at a few dozen programs.
 *
 * Implemented inline rather than imported from `src/shaders/ShaderCache.ts`, which
 * is owned by another layer and may not exist.
 */
export class ProgramLRUCache<V> {
  /** Cached entries, in least-recently-used-first order. */
  private readonly entries: Map<string, V> = new Map();

  /** Upper bound on the number of entries. */
  private readonly limit: number;

  /** Called for every evicted value so the owner can free it. */
  private readonly onEvict: ((value: V, key: string) => void) | null;

  /** Number of successful lookups. */
  private hitCount: number = 0;

  /** Number of failed lookups. */
  private missCount: number = 0;

  /** Number of values evicted to respect {@link ProgramLRUCache.maxSize}. */
  private evictionCount: number = 0;

  /**
   * Creates a cache.
   *
   * @param maxSize Maximum number of entries; clamped to at least `1`.
   * @param onEvict Callback invoked whenever an entry leaves the cache.
   */
  constructor(maxSize: number = 64, onEvict?: (value: V, key: string) => void) {
    this.limit = Math.max(1, Math.floor(maxSize));
    this.onEvict = onEvict ?? null;
  }

  /** Maximum number of entries. */
  public get maxSize(): number {
    return this.limit;
  }

  /** Current number of entries. */
  public get size(): number {
    return this.entries.size;
  }

  /** Successful lookups. */
  public get hits(): number {
    return this.hitCount;
  }

  /** Failed lookups. */
  public get misses(): number {
    return this.missCount;
  }

  /** Evictions performed so far. */
  public get evictions(): number {
    return this.evictionCount;
  }

  /**
   * Looks a value up, marking it most recently used.
   *
   * @param key Cache key.
   * @returns The value, or `undefined`.
   */
  public get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) {
      this.missCount++;
      return undefined;
    }
    this.hitCount++;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /**
   * Inserts or replaces a value, evicting the least recently used entry when full.
   *
   * @param key Cache key.
   * @param value Value to store.
   * @returns The evicted value, when one was displaced.
   */
  public set(key: string, value: V): V | undefined {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);

    if (this.entries.size <= this.limit) return undefined;

    const oldest = this.entries.keys().next();
    if (oldest.done === true) return undefined;
    const evicted = this.entries.get(oldest.value);
    this.entries.delete(oldest.value);
    this.evictionCount++;
    if (evicted !== undefined) this.onEvict?.(evicted, oldest.value);
    return evicted;
  }

  /**
   * Removes one entry.
   *
   * @param key Cache key.
   * @param notify Invoke the eviction callback when an entry was removed.
   * @returns `true` when an entry was removed.
   */
  public delete(key: string, notify: boolean = true): boolean {
    const value = this.entries.get(key);
    if (value === undefined) return false;
    this.entries.delete(key);
    if (notify) this.onEvict?.(value, key);
    return true;
  }

  /**
   * Reports whether a key is cached, without touching its recency.
   *
   * @param key Cache key.
   */
  public has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Cache keys, least recently used first. */
  public keys(): string[] {
    return [...this.entries.keys()];
  }

  /** Cached values, least recently used first. */
  public values(): V[] {
    return [...this.entries.values()];
  }

  /**
   * Removes every entry.
   *
   * @param notify Invoke the eviction callback for each removed entry.
   */
  public clear(notify: boolean = true): void {
    if (notify && this.onEvict !== null) {
      for (const [key, value] of this.entries) this.onEvict(value, key);
    }
    this.entries.clear();
  }

  /** Resets the hit/miss/eviction counters. */
  public resetStatistics(): void {
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Link diagnostics                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Annotates a link log against whichever stage each line fits into.
 *
 * @param programLog Raw `getProgramInfoLog` output.
 * @param vertexSource Vertex source the program was built from.
 * @param fragmentSource Fragment source.
 * @returns The annotated report.
 */
export function annotateLinkLog(
  programLog: string,
  vertexSource: string,
  fragmentSource: string,
): string {
  const entries = parseWebGLInfoLog(programLog);
  if (entries.length === 0) return '';

  const vertexLines = vertexSource.split(/\r?\n/).length;
  const fragmentLines = fragmentSource.split(/\r?\n/).length;

  const out: string[] = [];
  for (const entry of entries) {
    const fitsVertex = entry.line !== null && entry.line >= 1 && entry.line <= vertexLines;
    const fitsFragment = entry.line !== null && entry.line >= 1 && entry.line <= fragmentLines;

    if (fitsVertex && !fitsFragment) {
      out.push(formatWebGLInfoLog(vertexSource, entry.raw, { stage: ShaderStage.Vertex, noHeader: true }));
    } else if (fitsFragment && !fitsVertex) {
      out.push(formatWebGLInfoLog(fragmentSource, entry.raw, { stage: ShaderStage.Fragment, noHeader: true }));
    } else if (fitsVertex) {
      // Ambiguous: the line exists in both stages. The vertex stage is inspected
      // first because a link error most often originates in the vertex interface.
      out.push(formatWebGLInfoLog(vertexSource, entry.raw, { stage: ShaderStage.Vertex, noHeader: true }));
    } else {
      out.push(`  ${entry.raw}`);
    }
  }
  return out.join('\n');
}

/* -------------------------------------------------------------------------- */
/* WebGLProgram                                                               */
/* -------------------------------------------------------------------------- */

/** Descriptor accepted by {@link WebGLProgram.compile}. */
export interface WebGLProgramDescriptor {
  /** Vertex stage source. */
  vertexSource: string;
  /** Fragment stage source. */
  fragmentSource: string;
  /** Preprocessor definitions injected into both stages. */
  defines?: Readonly<Record<string, DefineValue>>;
  /** Human-readable label used in diagnostics. */
  label?: string;
  /**
   * Optional attribute bindings applied with `bindAttribLocation` before linking.
   *
   * Pinning locations keeps a VAO reusable across programs that declare the same
   * attribute names.
   */
  attributeLocations?: Readonly<Record<string, number>>;
}

/**
 * A linked GLSL program.
 *
 * Implements {@link IShader} so the material layer can hold it without knowing the
 * backend. Compilation failures are reported through
 * {@link WebGLProgram.compile}'s result and through {@link WebGLProgram.lastReport};
 * programming errors (linking before compiling, disposing twice) throw.
 */
export class WebGLProgram implements IShader {
  /** @inheritdoc */
  public readonly id: string;

  /** @inheritdoc */
  public readonly backend: string;

  /** @inheritdoc */
  public get vertexSource(): string | null {
    return this.sourceVertex;
  }

  /** @inheritdoc */
  public get fragmentSource(): string | null {
    return this.sourceFragment;
  }

  /** @inheritdoc */
  public get isCompiled(): boolean {
    return this.compiled;
  }

  /** @inheritdoc */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /** @inheritdoc */
  public get attributes(): readonly ShaderMember[] {
    return this.reflectedAttributes;
  }

  /** @inheritdoc */
  public get uniforms(): readonly ShaderMember[] {
    return this.reflectedUniforms;
  }

  /** Cache key of the source pair this program was built from. */
  public get shaderKey(): string {
    return this.key;
  }

  /** Annotated diagnostics from the last compile/link. */
  public get lastReport(): string {
    return this.report;
  }

  /** Context the program belongs to. */
  private readonly gl: GL;

  /** Label used in diagnostics. */
  private readonly label: string;

  /** Native program handle, or `null`. */
  private handle: GLProgramObject | null = null;

  /** Vertex stage, or `null` before compilation. */
  private vertexShader: WebGLShader | null = null;

  /** Fragment stage, or `null` before compilation. */
  private fragmentShader: WebGLShader | null = null;

  /** Uniform table for this program. */
  public readonly uniformTable: WebGLUniforms;

  /** Reflected uniforms. */
  private uniformInfos: WebGLUniformInfo[] = [];

  /** Reflected attributes. */
  private attributeInfos: WebGLAttributeInfo[] = [];

  /** `name` → location, for O(1) attribute lookup. */
  private readonly attributeLocations: Map<string, number> = new Map();

  /** `name` → location, for O(1) uniform lookup. */
  private readonly uniformLocations: Map<string, WebGLUniformLocation | null> = new Map();

  /** `IShader`-shaped reflection views, rebuilt on every successful link. */
  private reflectedAttributes: ShaderMember[] = [];
  private reflectedUniforms: ShaderMember[] = [];

  /** Vertex source with definitions injected. */
  private sourceVertex: string = '';

  /** Fragment source with definitions injected. */
  private sourceFragment: string = '';

  /** Cache key of the source pair. */
  private key: string = '';

  /** `true` once linking has succeeded. */
  private compiled: boolean = false;

  /** `true` once {@link WebGLProgram.dispose} has run. */
  private disposed: boolean = false;

  /** Annotated diagnostics from the last compile/link. */
  private report: string = '';

  /**
   * Creates an uncompiled program.
   *
   * @param gl Context the program will be linked against.
   * @param options Label and initial backend label.
   */
  constructor(gl: GL, options: { label?: string; backend?: string } = {}) {
    this.gl = gl;
    this.label = options.label ?? 'program';
    this.backend = options.backend ?? 'webgl';
    this.id = `webgl-program-${createId()}`;
    this.uniformTable = new WebGLUniforms(gl);
  }

  /** Native handle, or `null` when not linked. */
  public get handleOrNull(): GLProgramObject | null {
    return this.handle;
  }

  /** @inheritdoc */
  public compile(vertexSource: string | null, fragmentSource: string): ShaderCompileResult {
    return this.compileDescriptor({
      vertexSource: vertexSource ?? '',
      fragmentSource,
    }).result;
  }

  /**
   * Compiles and links from a full descriptor.
   *
   * @param descriptor Sources, definitions and attribute bindings.
   * @returns The compile result plus the handle, for callers that want both.
   */
  public compileDescriptor(descriptor: WebGLProgramDescriptor): {
    result: ShaderCompileResult;
    success: boolean;
  } {
    if (this.disposed) {
      throw new Error(`WebGLProgram(${this.label}): cannot compile a disposed program.`);
    }

    this.releaseHandle();
    this.uniformLocations.clear();
    this.attributeLocations.clear();
    this.uniformInfos = [];
    this.attributeInfos = [];
    this.reflectedAttributes = [];
    this.reflectedUniforms = [];

    this.key = buildProgramKey(descriptor.vertexSource, descriptor.fragmentSource, descriptor.defines);
    this.sourceVertex = prependDefines(descriptor.vertexSource, descriptor.defines);
    this.sourceFragment = prependDefines(descriptor.fragmentSource, descriptor.defines);

    const vertexShader = new WebGLShader(this.gl, ShaderStage.Vertex, descriptor.vertexSource, {
      label: `${descriptor.label ?? this.label}.vertex`,
      defines: descriptor.defines,
    });
    const fragmentShader = new WebGLShader(this.gl, ShaderStage.Fragment, descriptor.fragmentSource, {
      label: `${descriptor.label ?? this.label}.fragment`,
      defines: descriptor.defines,
    });

    const vertexOk = vertexShader.compile();
    const fragmentOk = fragmentShader.compile();

    if (!vertexOk || !fragmentOk) {
      const sections: string[] = [];
      if (!vertexOk) sections.push(vertexShader.getReport({ context: 1 }));
      if (!fragmentOk) sections.push(fragmentShader.getReport({ context: 1 }));
      this.report = sections.join('\n');
      this.vertexShader = vertexOk ? vertexShader : null;
      this.fragmentShader = fragmentOk ? fragmentShader : null;
      vertexShader.dispose();
      fragmentShader.dispose();
      this.compiled = false;
      log.error(`WebGLProgram(${this.label}) failed to compile a stage:\n${this.report}`);
      return {
        result: { success: false, attributes: [], uniforms: [], log: this.report },
        success: false,
      };
    }

    const handle = this.gl.createProgram();
    if (handle === null) {
      this.report =
        `WebGLProgram(${this.label}): gl.createProgram returned null. The context may be lost, ` +
        'or the program limit may have been reached.';
      vertexShader.dispose();
      fragmentShader.dispose();
      this.compiled = false;
      log.error(this.report);
      return { result: { success: false, attributes: [], uniforms: [], log: this.report }, success: false };
    }

    this.gl.attachShader(handle, vertexShader.getHandle());
    this.gl.attachShader(handle, fragmentShader.getHandle());

    if (descriptor.attributeLocations !== undefined) {
      for (const name of Object.keys(descriptor.attributeLocations)) {
        this.gl.bindAttribLocation(handle, descriptor.attributeLocations[name], name);
      }
    }

    this.gl.linkProgram(handle);
    const linked = this.gl.getProgramParameter(handle, glConst(this.gl, 'LINK_STATUS', 0x8b82));
    const programLog = this.gl.getProgramInfoLog(handle) ?? '';

    if (linked !== true) {
      const sections: string[] = [];
      const vertexLog = vertexShader.infoLog.trim();
      const fragmentLog = fragmentShader.infoLog.trim();
      if (vertexLog.length > 0) {
        sections.push(formatWebGLInfoLog(this.sourceVertex, vertexLog, {
          stage: ShaderStage.Vertex,
          label: this.label,
        }));
      }
      if (fragmentLog.length > 0) {
        sections.push(formatWebGLInfoLog(this.sourceFragment, fragmentLog, {
          stage: ShaderStage.Fragment,
          label: this.label,
        }));
      }
      if (programLog.trim().length > 0) {
        sections.push(`[${this.label} link]\n${annotateLinkLog(programLog, this.sourceVertex, this.sourceFragment)}`);
      }
      this.report =
        sections.length > 0
          ? sections.join('\n')
          : `WebGLProgram(${this.label}): linking failed and the driver returned no diagnostics.`;

      this.gl.deleteProgram(handle);
      vertexShader.dispose();
      fragmentShader.dispose();
      this.compiled = false;
      log.error(`WebGLProgram(${this.label}) failed to link:\n${this.report}`);
      return { result: { success: false, attributes: [], uniforms: [], log: this.report }, success: false };
    }

    this.handle = handle;
    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;
    this.compiled = true;
    this.reflect();

    const diagnostics = programLog.trim();
    this.report =
      diagnostics.length > 0
        ? `[${this.label} link] linked with warnings\n${annotateLinkLog(programLog, this.sourceVertex, this.sourceFragment)}`
        : `[${this.label}] linked: ${this.reflectedAttributes.length} attributes, ${this.reflectedUniforms.length} uniforms`;

    return {
      result: {
        success: true,
        attributes: this.reflectedAttributes,
        uniforms: this.reflectedUniforms,
        log: this.report,
      },
      success: true,
    };
  }

  /** @inheritdoc */
  public use(): boolean {
    if (this.handle === null || !this.compiled) return false;
    this.gl.useProgram(this.handle);
    return true;
  }

  /**
   * Reflects the linked interface into the lookup tables.
   *
   * @returns This program, for chaining.
   */
  public reflect(): this {
    const handle = this.handle;
    if (handle === null) return this;

    this.uniformInfos = reflectUniforms(this.gl, handle);
    this.attributeInfos = reflectAttributes(this.gl, handle);
    this.uniformTable.reset(this.uniformInfos);

    for (const info of this.uniformInfos) this.uniformLocations.set(info.name, info.location);
    for (const info of this.attributeInfos) this.attributeLocations.set(info.name, info.location);

    this.reflectedAttributes = this.attributeInfos.map((info) => ({
      name: info.name,
      type: info.type ?? ShaderValueType.Float,
      location: info.location,
    }));
    this.reflectedUniforms = this.uniformInfos.map((info) => ({
      name: info.name,
      type: info.type,
      arrayLength: info.arrayLength,
    }));

    return this;
  }

  /* ------------------------------------------------------------ reflection API */

  /** @returns The reflected attribute list. */
  public getAttributes(): readonly WebGLAttributeInfo[] {
    return this.attributeInfos;
  }

  /** @returns The reflected uniform list. */
  public getUniforms(): readonly WebGLUniformInfo[] {
    return this.uniformInfos;
  }

  /** @returns The uniform upload table. */
  public getUniformTable(): WebGLUniforms {
    return this.uniformTable;
  }

  /** @inheritdoc */
  public getAttributeLocation(name: string): number {
    return this.attributeLocations.get(name) ?? -1;
  }

  /** @inheritdoc */
  public getUniformLocation(name: string): unknown {
    return this.uniformLocations.get(name) ?? null;
  }

  /** @inheritdoc */
  public setUniform(name: string, value: UniformValue): void {
    this.uniformTable.set(name, value);
  }

  /** @inheritdoc */
  public setUniforms(values: Readonly<Record<string, UniformValue>>): void {
    this.uniformTable.setUniforms(values);
  }

  /* ------------------------------------------------------------------ dispose */

  /** @inheritdoc */
  public dispose(): void {
    if (this.disposed) return;
    this.releaseHandle();
    this.uniformTable.reset([]);
    this.uniformLocations.clear();
    this.attributeLocations.clear();
    this.uniformInfos = [];
    this.attributeInfos = [];
    this.reflectedAttributes = [];
    this.reflectedUniforms = [];
    this.compiled = false;
    this.disposed = true;
  }

  /** Deletes the native program and its stages. */
  private releaseHandle(): void {
    if (this.handle !== null) {
      // Detach first: the stages are deleted below and a program that still
      // references them would keep them alive on some drivers.
      const handle = this.handle;
      const vertex: GLShaderObject | null = this.vertexShader?.handleOrNull ?? null;
      const fragment: GLShaderObject | null = this.fragmentShader?.handleOrNull ?? null;
      if (vertex !== null) this.gl.detachShader(handle, vertex);
      if (fragment !== null) this.gl.detachShader(handle, fragment);
      this.gl.deleteProgram(handle);
      this.handle = null;
    }
    this.vertexShader?.dispose();
    this.fragmentShader?.dispose();
    this.vertexShader = null;
    this.fragmentShader = null;
  }

  /** @returns A human-readable description. */
  public toString(): string {
    return `WebGLProgram(${this.label}, key=${this.key}, ${this.compiled ? 'linked' : 'unlinked'})`;
  }
}

/* -------------------------------------------------------------------------- */
/* Program cache                                                              */
/* -------------------------------------------------------------------------- */

/** Options accepted by {@link WebGLProgramCache}. */
export interface WebGLProgramCacheOptions {
  /** Maximum number of linked programs kept. Defaults to `64`. */
  maxSize?: number;
  /** Backend label stamped onto the programs it creates. */
  backend?: string;
}

/** Bookkeeping returned by {@link WebGLProgramCache.acquire}. */
export interface WebGLProgramAcquireResult {
  /** The linked program, or `null` when compilation failed. */
  readonly program: WebGLProgram | null;
  /** Cache key the program is stored under. */
  readonly key: string;
  /** `true` when the program came out of the cache rather than being linked. */
  readonly cached: boolean;
  /** Compile result, present only when a link was attempted. */
  readonly result: ShaderCompileResult | null;
}

/**
 * Bounded LRU cache of linked programs, keyed by {@link buildProgramKey}.
 *
 * Eviction disposes the program, which is why the cache owns programs outright:
 * handing out a reference to a program that later gets evicted would leave the
 * caller with a disposed handle.
 */
export class WebGLProgramCache {
  /** Context programs are linked against. */
  private readonly gl: GL;

  /** Underlying LRU store. */
  private readonly cache: ProgramLRUCache<WebGLProgram>;

  /** Backend label stamped onto created programs. */
  private readonly backend: string;

  /**
   * Creates a cache.
   *
   * @param gl Context to link against.
   * @param options Size and backend label.
   */
  constructor(gl: GL, options: WebGLProgramCacheOptions = {}) {
    this.gl = gl;
    this.backend = options.backend ?? 'webgl';
    this.cache = new ProgramLRUCache<WebGLProgram>(options.maxSize ?? 64, (program) => program.dispose());
  }

  /** Maximum number of cached programs. */
  public get maxSize(): number {
    return this.cache.maxSize;
  }

  /** Number of cached programs (also reported as `memory.programs`). */
  public get size(): number {
    return this.cache.size;
  }

  /** Successful lookups. */
  public get hits(): number {
    return this.cache.hits;
  }

  /** Failed lookups (i.e. links performed). */
  public get misses(): number {
    return this.cache.misses;
  }

  /** Programs disposed because the cache was full. */
  public get evictions(): number {
    return this.cache.evictions;
  }

  /**
   * Returns the cached program for a key.
   *
   * @param key Cache key.
   */
  public get(key: string): WebGLProgram | undefined {
    return this.cache.get(key);
  }

  /**
   * Inserts a program under a key, disposing any program it displaces.
   *
   * @param key Cache key.
   * @param program Program to store.
   */
  public set(key: string, program: WebGLProgram): void {
    this.cache.set(key, program);
  }

  /**
   * Looks a program up, linking it when it is not cached.
   *
   * @param descriptor Sources and definitions.
   * @returns The program (or `null` on failure) plus cache bookkeeping.
   */
  public acquire(descriptor: WebGLProgramDescriptor): WebGLProgramAcquireResult {
    const key = buildProgramKey(descriptor.vertexSource, descriptor.fragmentSource, descriptor.defines);
    const cached = this.cache.get(key);
    if (cached !== undefined && !cached.isDisposed) {
      return { program: cached, key, cached: true, result: null };
    }

    const program = new WebGLProgram(this.gl, { label: descriptor.label, backend: this.backend });
    const { result, success } = program.compileDescriptor(descriptor);
    if (!success) {
      return { program: null, key, cached: false, result };
    }

    this.cache.set(key, program);
    return { program, key, cached: false, result };
  }

  /**
   * Removes and disposes the program stored under a key.
   *
   * @param key Cache key.
   * @returns `true` when a program was removed.
   */
  public release(key: string): boolean {
    return this.cache.delete(key, true);
  }

  /** Removes every entry, disposing each program. */
  public clear(): void {
    this.cache.clear(true);
  }

  /**
   * Number of active GL program handles owned by the cache.
   *
   * Reported through `memory.programs`.
   */
  public getHandleCount(): number {
    let count = 0;
    for (const program of this.cache.values()) {
      if (program.handleOrNull !== null) count++;
    }
    return count;
  }

  /** Disposes every cached program and empties the cache. */
  public dispose(): void {
    this.cache.clear(true);
    this.cache.resetStatistics();
  }
}
