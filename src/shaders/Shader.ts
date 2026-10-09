/**
 * `Shader` — a language-agnostic program description.
 *
 * A `Shader` is the mutable, runtime counterpart of the plain
 * {@link ShaderDescriptor} data record: it owns the stage sources, the defines,
 * the uniform container and the WGSL bindings, and it can resolve its own chunk
 * includes and serialise itself back to a descriptor.
 *
 * ```ts
 * const shader = new Shader({ name: 'custom', language: 'glsl', vertex, fragment });
 * shader.setDefine('USE_MAP', true);
 * shader.uniforms.set('uColor', new Color(1, 0, 0));
 * compiler.compile(shader.toDescriptor());
 * ```
 *
 * @packageDocumentation
 */

import { shaderHash, shaderKey } from '../utils/StringUtils';
import { resolve, resolveChunkNames, type ShaderChunkResolveOptions } from './ShaderChunk';
import type {
  ShaderBinding,
  ShaderDescriptor,
  ShaderLanguage,
  ShaderStage,
  UniformDeclaration,
  UniformType,
  UniformValue,
} from './types';
import { Uniforms } from './Uniforms';

/** The stages of a graphics program, in pipeline order. */
const GRAPHICS_STAGES: readonly ShaderStage[] = ['vertex', 'fragment'];

/** Serialisable form of a {@link Shader}. */
export interface ShaderJSON {
  /** Shader name. */
  name: string;
  /** Language of the sources. */
  language: ShaderLanguage;
  /** Stage sources that are present. */
  stages: Partial<Record<ShaderStage, string>>;
  /** Preprocessor defines. */
  defines: Record<string, string | number | boolean>;
  /** Uniform declarations. */
  uniforms: Record<string, UniformDeclaration>;
  /** Attribute declarations. */
  attributes: Record<string, string>;
  /** Explicit WGSL bindings. */
  bindings: ShaderBinding[];
  /** Source key, as reported by {@link Shader.key}. */
  key: string;
}

/** Options accepted when building a {@link Shader} from raw source. */
export interface ShaderFromSourceOptions {
  /** Shader name; defaults to `'shader'`. */
  name?: string;
  /** Language of the source; defaults to `'glsl'`. */
  language?: ShaderLanguage;
  /** Stage the source belongs to; defaults to `'vertex'`. */
  stage?: ShaderStage;
  /** Extra defines. */
  defines?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * A complete shader program description.
 *
 * Sources may contain include directives (`#include <name>` for GLSL,
 * `//!include name` for WGSL); {@link Shader.resolve} expands them through the
 * `ShaderChunk` registry.
 */
export class Shader {
  /** Program name, used in diagnostics and cache keys. */
  public name: string;

  /** Language the sources are written in. */
  public language: ShaderLanguage;

  /** Vertex-stage source, when present. */
  public vertex: string | undefined;

  /** Fragment-stage source, when present. */
  public fragment: string | undefined;

  /** Compute-stage source, when present. */
  public compute: string | undefined;

  /** Preprocessor defines injected ahead of every stage. */
  public readonly defines: Record<string, string | number | boolean> = {};

  /** Uniform container; insertion order defines the WGSL binding order. */
  public readonly uniforms: Uniforms = new Uniforms();

  /** Vertex attribute declarations, keyed by attribute name. */
  public readonly attributes: Record<string, string> = {};

  /** Explicit WGSL bindings. */
  public readonly bindings: ShaderBinding[] = [];

  /** Entry-point names per stage (WGSL). */
  public readonly entryPoints: Partial<Record<ShaderStage, string>> = {};

  /**
   * @param descriptor Descriptor to copy, or a program name for an empty shader.
   */
  constructor(descriptor: ShaderDescriptor | string = 'shader') {
    if (typeof descriptor === 'string') {
      this.name = descriptor;
      this.language = 'glsl';
      this.vertex = undefined;
      this.fragment = undefined;
      this.compute = undefined;
      return;
    }

    this.name = descriptor.name;
    this.language = descriptor.language;
    this.vertex = descriptor.vertex;
    this.fragment = descriptor.fragment;
    this.compute = descriptor.compute;

    if (descriptor.defines) {
      for (const [key, value] of Object.entries(descriptor.defines)) this.defines[key] = value;
    }
    if (descriptor.attributes) {
      for (const [key, value] of Object.entries(descriptor.attributes)) this.attributes[key] = value;
    }
    if (descriptor.bindings) {
      for (const binding of descriptor.bindings) this.bindings.push({ ...binding });
    }
    if (descriptor.entryPoints) {
      for (const [stage, entry] of Object.entries(descriptor.entryPoints)) {
        if (entry !== undefined) this.entryPoints[stage as ShaderStage] = entry;
      }
    }
    if (descriptor.uniforms) {
      for (const [name, declaration] of Object.entries(descriptor.uniforms)) {
        if (typeof declaration === 'string') {
          this.uniforms.set(name, null, { type: declaration });
        } else {
          this.uniforms.set(name, null, {
            type: declaration.type,
            elementType: declaration.elementType,
            group: declaration.group,
            binding: declaration.binding,
          });
        }
      }
    }
  }

  /* ---------------------------------------------------------------- static */

  /**
   * Builds a shader from a raw source string and a set of stage names.
   *
   * @param source Source text for the first stage.
   * @param options Name, language and stage configuration.
   */
  public static fromSource(source: string, options: ShaderFromSourceOptions = {}): Shader {
    const shader = new Shader(options.name ?? 'shader');
    shader.language = options.language ?? 'glsl';
    if (options.defines) {
      for (const [key, value] of Object.entries(options.defines)) shader.defines[key] = value;
    }
    shader.setStage(options.stage ?? 'vertex', source);
    return shader;
  }

  /**
   * Builds a shader from a descriptor.
   *
   * @param descriptor Descriptor to copy.
   */
  public static fromDescriptor(descriptor: ShaderDescriptor): Shader {
    return new Shader(descriptor);
  }

  /* --------------------------------------------------------------- queries */

  /**
   * Canonical source key.
   *
   * Comments and insignificant whitespace are stripped, so two shaders that
   * differ only in formatting share a key — which is exactly what the compiled
   * program cache needs. Defines participate in the key.
   */
  public get key(): string {
    return shaderKey(this.sourceKeyText());
  }

  /** Numeric hash of {@link key}, matching `shaderHash()` semantics. */
  public get hash(): number {
    return shaderHash(this.sourceKeyText());
  }

  /** `true` when the stage has source text. */
  public hasStage(stage: ShaderStage): boolean {
    const source = this.getSource(stage);
    return typeof source === 'string' && source.length > 0;
  }

  /** Every stage that carries source text. */
  public getStages(): ShaderStage[] {
    if (this.hasStage('compute')) return ['compute'];
    return GRAPHICS_STAGES.filter((stage) => this.hasStage(stage));
  }

  /**
   * Reads a stage's source.
   *
   * @param stage Stage to read.
   * @returns The source, or `undefined` when the stage is absent.
   */
  public getSource(stage: ShaderStage): string | undefined {
    switch (stage) {
      case 'vertex':
        return this.vertex;
      case 'fragment':
        return this.fragment;
      case 'compute':
        return this.compute;
      default:
        return undefined;
    }
  }

  /** `true` when the declared stages form a complete draw program. */
  public isValid(): boolean {
    if (this.hasStage('compute')) return this.getStages().length === 1;
    return this.hasStage('vertex') && this.hasStage('fragment');
  }

  /* -------------------------------------------------------------- mutation */

  /**
   * Sets a stage's source.
   *
   * @param stage Stage to write.
   * @param source Source text.
   * @returns This shader, for chaining.
   */
  public setStage(stage: ShaderStage, source: string): this {
    switch (stage) {
      case 'vertex':
        this.vertex = source;
        break;
      case 'fragment':
        this.fragment = source;
        break;
      case 'compute':
        this.compute = source;
        break;
      default:
        break;
    }
    return this;
  }

  /** Removes a stage's source. */
  public removeStage(stage: ShaderStage): this {
    return this.setStage(stage, '');
  }

  /**
   * Sets a preprocessor define.
   *
   * @param name Macro name.
   * @param value `true` emits a bare `#define`, `false` removes it, anything else
   *   emits `#define name value`.
   * @returns This shader, for chaining.
   */
  public setDefine(name: string, value: string | number | boolean): this {
    if (value === false) delete this.defines[name];
    else this.defines[name] = value;
    return this;
  }

  /** Declares a vertex attribute. */
  public setAttribute(name: string, type: string): this {
    this.attributes[name] = type;
    return this;
  }

  /** Declares a uniform with an explicit semantic type. */
  public setUniform(name: string, value: UniformValue, type?: UniformType): this {
    this.uniforms.set(name, value, type ? { type } : {});
    return this;
  }

  /* --------------------------------------------------------------- copying */

  /** Copy of this shader with the given defines merged in. */
  public withDefines(defines: Readonly<Record<string, string | number | boolean>>): Shader {
    const clone = this.clone();
    for (const [key, value] of Object.entries(defines)) clone.setDefine(key, value);
    return clone;
  }

  /** Independent copy of this shader. */
  public clone(): Shader {
    const clone = new Shader(this.name);
    clone.language = this.language;
    clone.vertex = this.vertex;
    clone.fragment = this.fragment;
    clone.compute = this.compute;
    for (const [key, value] of Object.entries(this.defines)) clone.defines[key] = value;
    for (const [key, value] of Object.entries(this.attributes)) clone.attributes[key] = value;
    for (const binding of this.bindings) clone.bindings.push({ ...binding });
    for (const [stage, entry] of Object.entries(this.entryPoints)) {
      if (entry !== undefined) clone.entryPoints[stage as ShaderStage] = entry;
    }
    clone.uniforms.copy(this.uniforms);
    return clone;
  }

  /* ------------------------------------------------------------- resolution */

  /**
   * Resolves a stage's chunk includes.
   *
   * @param stage Stage to resolve.
   * @param options Resolution options; the shader's language is used by default.
   * @returns The resolved source, or `undefined` when the stage is absent.
   * @throws ShaderChunkError for an unknown chunk or a dependency cycle.
   */
  public resolve(stage: ShaderStage, options: ShaderChunkResolveOptions = {}): string | undefined {
    const source = this.getSource(stage);
    if (source === undefined) return undefined;
    return resolve(source, { language: this.language, ...options });
  }

  /**
   * Resolves a list of chunk names with this shader's language.
   *
   * @param names Chunk names.
   * @param options Resolution options.
   */
  public resolveChunks(names: readonly string[], options: ShaderChunkResolveOptions = {}): string {
    return resolveChunkNames(names, { language: this.language, ...options });
  }

  /* ----------------------------------------------------------- conversion */

  /**
   * Converts this shader back into a plain descriptor.
   *
   * @returns A descriptor a `ShaderCompiler` or a backend can consume directly.
   */
  public toDescriptor(): ShaderDescriptor {
    const uniforms: Record<string, UniformDeclaration> = {};
    for (const declaration of this.uniforms.getDeclarations(this.language)) {
      uniforms[declaration.name] = declaration;
    }

    const descriptor: ShaderDescriptor = {
      name: this.name,
      language: this.language,
      defines: { ...this.defines },
      attributes: { ...this.attributes },
      bindings: this.bindings.map((binding) => ({ ...binding })),
      uniforms,
    };

    if (this.vertex !== undefined) descriptor.vertex = this.vertex;
    if (this.fragment !== undefined) descriptor.fragment = this.fragment;
    if (this.compute !== undefined) descriptor.compute = this.compute;
    if (Object.keys(this.entryPoints).length > 0) descriptor.entryPoints = { ...this.entryPoints };
    return descriptor;
  }

  /** Serialises the shader, including its stage sources. */
  public toJSON(): ShaderJSON {
    const stages: Partial<Record<ShaderStage, string>> = {};
    for (const stage of this.getStages()) {
      const source = this.getSource(stage);
      if (source !== undefined) stages[stage] = source;
    }

    const uniforms: Record<string, UniformDeclaration> = {};
    for (const declaration of this.uniforms.getDeclarations(this.language)) {
      uniforms[declaration.name] = declaration;
    }

    return {
      name: this.name,
      language: this.language,
      stages,
      defines: { ...this.defines },
      uniforms,
      attributes: { ...this.attributes },
      bindings: this.bindings.map((binding) => ({ ...binding })),
      key: this.key,
    };
  }

  /** `true` when all stage sources and defines match. */
  public equals(other: Shader | null | undefined): boolean {
    if (other == null) return false;
    return this.key === other.key && this.language === other.language;
  }

  /** Canonical text the {@link key} is derived from. */
  private sourceKeyText(): string {
    const parts: string[] = [`language=${this.language}`];
    for (const [key, value] of Object.entries(this.defines).sort(([a], [b]) => (a < b ? -1 : 1))) {
      parts.push(`#define ${key} ${value === true ? '1' : String(value)}`);
    }
    for (const stage of ['vertex', 'fragment', 'compute'] as const) {
      const source = this.getSource(stage);
      if (source !== undefined && source.length > 0) parts.push(`${stage}:${source}`);
    }
    return parts.join('\n');
  }
}
