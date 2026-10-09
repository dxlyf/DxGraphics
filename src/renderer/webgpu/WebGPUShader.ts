/**
 * WGSL shader modules with validation-error surfacing.
 *
 * ## Validation is asynchronous
 *
 * `device.createShaderModule()` returns immediately; WGSL validation happens on the
 * implementation's own thread and reports through `module.getCompilationInfo()` and,
 * on some drivers, through the device's error scope. There is therefore no way to
 * return a truthful synchronous "did this compile?" answer, and pretending otherwise
 * would be worse than useless.
 *
 * The contract this class implements instead:
 *
 * - {@link WebGPUShader.compile} creates the modules and returns a result that says
 *   "created, validation pending";
 * - {@link WebGPUShader.whenValidated} resolves with the real outcome, including the
 *   annotated diagnostics;
 * - {@link WebGPUShader.lastReport} holds the annotated text of the most recent
 *   validation pass, so a synchronous caller can still show it after the fact.
 *
 * ## Line and column
 *
 * `GPUCompilationMessage` carries `lineNum`/`linePos` when the implementation provides
 * them; when it does not, both are `0` and the position has to come out of the message
 * text (`main.wgsl:12:5`). {@link parseWGSLDiagnostic} handles the textual form, and
 * {@link formatWGSLDiagnostics} prefers the structured values when they are usable.
 *
 * @packageDocumentation
 */

import { createLogger } from '../../utils/Logger';
import { createId } from '../../utils/Id';
import {
  ShaderStage,
  type IShader,
  type ShaderCompileResult,
  type ShaderMember,
  type UniformValue,
} from '../interfaces/IShader';
import type {
  GPUCompilationInfoLike,
  GPUCompilationMessageLike,
  GPUDeviceLike,
  GPUShaderModuleLike,
} from './WebGPUUtils';

/** Logger for shader diagnostics. */
const log = createLogger('renderer:webgpu:shader');

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

/** Severity of one WGSL diagnostic. */
export type WGSLDiagnosticSeverity = 'error' | 'warning' | 'info';

/** One WGSL diagnostic, normalised across the structured and textual forms. */
export interface WGSLDiagnostic {
  /** Severity as reported (or inferred). */
  readonly severity: WGSLDiagnosticSeverity;
  /** Message text, position prefix stripped. */
  readonly message: string;
  /** 1-based line, or `null` when it could not be determined. */
  readonly line: number | null;
  /** 1-based column, or `null` when it could not be determined. */
  readonly column: number | null;
  /** Byte offset of the diagnostic, when the implementation reported one. */
  readonly offset: number | null;
  /** Length of the offending span, when known. */
  readonly length: number | null;
}

/** Text patterns implementations use to embed a position in a WGSL message. */
const WGSL_POSITION_PATTERNS: readonly { re: RegExp; lineGroup: number; columnGroup: number }[] = [
  // `main.wgsl:12:5 error: ...` / `vs_main:12:5`
  { re: /(?:^|[\s(])[^\s:()]*:(\d+):(\d+)/i, lineGroup: 1, columnGroup: 2 },
  // `at line 12:5` / `at 12.5`
  { re: /at\s+(?:line\s+)?(\d+)\s*[:.]\s*(\d+)/i, lineGroup: 1, columnGroup: 2 },
  // `line 12, column 5`
  { re: /line\s+(\d+)\s*,?\s*column\s+(\d+)/i, lineGroup: 1, columnGroup: 2 },
  // bare `12:5`
  { re: /(\d+):(\d+)/, lineGroup: 1, columnGroup: 2 },
];

/**
 * Extracts a line/column pair from a WGSL diagnostic message.
 *
 * @param message Raw message text.
 * @returns The 1-based line and column, or `null` when the text carries neither.
 */
export function parseWGSLDiagnostic(message: string): { line: number; column: number } | null {
  if (typeof message !== 'string' || message.length === 0) return null;

  for (const pattern of WGSL_POSITION_PATTERNS) {
    const match = pattern.re.exec(message);
    if (match === null) continue;

    const line = Number.parseInt(match[pattern.lineGroup] ?? '', 10);
    if (!Number.isFinite(line) || line <= 0) continue;

    const columnToken = match[pattern.columnGroup];
    const column = columnToken === undefined ? NaN : Number.parseInt(columnToken, 10);
    return { line, column: Number.isFinite(column) && column > 0 ? column : 1 };
  }

  return null;
}

/**
 * Normalises the messages a shader module reported.
 *
 * @param info Compilation info, or `null`.
 * @param source Source text, used to fall back to a textual position when the
 *   structured one is missing.
 * @returns Normalised diagnostics.
 */
export function normalizeWGSLDiagnostics(
  info: GPUCompilationInfoLike | null | undefined,
  source: string | null = null,
): WGSLDiagnostic[] {
  void source;
  if (info?.messages == null) return [];

  const diagnostics: WGSLDiagnostic[] = [];
  for (const message of info.messages) {
    diagnostics.push(normalizeMessage(message));
  }
  return diagnostics;
}

/** Normalises one `GPUCompilationMessage`. */
function normalizeMessage(message: GPUCompilationMessageLike): WGSLDiagnostic {
  const severity: WGSLDiagnosticSeverity =
    message.type === 'error' ? 'error' : message.type === 'warning' ? 'warning' : 'info';

  const text = typeof message.message === 'string' ? message.message : String(message.message ?? '');
  const structuredLine = Number.isFinite(message.lineNum) && message.lineNum > 0 ? Math.floor(message.lineNum) : null;
  const structuredColumn =
    Number.isFinite(message.linePos) && message.linePos > 0 ? Math.floor(message.linePos) : null;

  const parsed = structuredLine === null ? parseWGSLDiagnostic(text) : null;

  return {
    severity,
    message: text,
    line: structuredLine ?? parsed?.line ?? null,
    column: structuredColumn ?? parsed?.column ?? null,
    offset: Number.isFinite(message.offset) ? Math.floor(message.offset) : null,
    length: Number.isFinite(message.length) ? Math.floor(message.length) : null,
  };
}

/** Options accepted by {@link formatWGSLDiagnostics}. */
export interface FormatWGSLDiagnosticsOptions {
  /** Label shown in the header (`'main.wgsl'`, ...). */
  label?: string;
  /** Shader stage shown in the header. */
  stage?: ShaderStage | string;
  /** Source lines reproduced around each diagnostic. Defaults to `0`. */
  context?: number;
  /** Omit the header block. */
  noHeader?: boolean;
}

/**
 * Renders WGSL diagnostics as an annotated, human-readable report.
 *
 * ```text
 * [main.wgsl (fragment)] 1 error
 *   unresolved value 'x'
 *      12 |   let y = x * 2.0;
 *         |           ^
 * ```
 *
 * @param source WGSL source the diagnostics refer to, or `null`.
 * @param diagnostics Normalised diagnostics.
 * @param options Header and context tuning.
 * @returns The report, or `''` when there is nothing to report.
 */
export function formatWGSLDiagnostics(
  source: string | null | undefined,
  diagnostics: readonly WGSLDiagnostic[],
  options: FormatWGSLDiagnosticsOptions = {},
): string {
  if (diagnostics.length === 0) return '';

  const lines = source == null ? null : source.split(/\r?\n/);
  const width = Math.max(2, ...diagnostics.map((d) => (d.line === null ? 1 : String(d.line).length)));
  const out: string[] = [];

  if (!(options.noHeader ?? false)) {
    const errors = diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
    const parts: string[] = [];
    if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
    if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
    if (parts.length === 0) parts.push(`${diagnostics.length} message${diagnostics.length === 1 ? '' : 's'}`);
    const label = options.label ?? 'shader';
    const stage = options.stage !== undefined ? ` (${String(options.stage)})` : '';
    out.push(`[${label}${stage}] ${parts.join(', ')}`);
  }

  const context = Math.max(0, Math.floor(options.context ?? 0));
  for (const diagnostic of diagnostics) {
    out.push(`  ${diagnostic.message}`);
    if (lines === null || diagnostic.line === null) continue;

    const first = Math.max(1, diagnostic.line - context);
    const last = Math.min(lines.length, diagnostic.line + context);
    for (let number = first; number <= last; number++) {
      const text = lines[number - 1] ?? '';
      out.push(`  ${String(number).padStart(width)} | ${text}`);
      if (number !== diagnostic.line) continue;
      const column = resolveWGSLColumn(diagnostic, text);
      if (column >= 0) out.push(`  ${' '.repeat(width)} | ${' '.repeat(column)}^`);
    }
  }

  return out.join('\n');
}

/**
 * Works out the caret column for a diagnostic.
 *
 * Preference order: the identifier the implementation quoted, then the structured
 * column, then column `0`.
 *
 * @param diagnostic Diagnostic to place.
 * @param sourceLine The source line it refers to.
 */
export function resolveWGSLColumn(diagnostic: WGSLDiagnostic, sourceLine: string): number {
  const quoted = /'([^']+)'/.exec(diagnostic.message) ?? /"([^"]+)"/.exec(diagnostic.message);
  if (quoted !== null) {
    const index = sourceLine.indexOf(quoted[1]);
    if (index >= 0) return index;
  }
  if (diagnostic.column !== null && diagnostic.column > 0) {
    const zeroBased = diagnostic.column - 1;
    if (zeroBased <= sourceLine.length) return zeroBased;
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* WebGPUShader                                                               */
/* -------------------------------------------------------------------------- */

/** Stage modules a shader holds. */
export interface WebGPUShaderModules {
  /** Vertex module, or `null`. */
  readonly vertex: GPUShaderModuleLike | null;
  /** Fragment module, or `null`. */
  readonly fragment: GPUShaderModuleLike | null;
}

/**
 * A WGSL shader pair.
 *
 * Implements {@link IShader} so the material layer can hold it without knowing the
 * backend. `use()` is a no-op — WebGPU binds pipelines, not programs — and the
 * method exists to satisfy the interface.
 */
export class WebGPUShader implements IShader {
  /** @inheritdoc */
  public readonly id: string;

  /** @inheritdoc */
  public get backend(): string {
    return 'webgpu';
  }

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
    return this.modules.vertex !== null || this.modules.fragment !== null;
  }

  /** @inheritdoc */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /** @inheritdoc */
  public get attributes(): readonly ShaderMember[] {
    return [];
  }

  /** @inheritdoc */
  public get uniforms(): readonly ShaderMember[] {
    return [];
  }

  /** Device the modules were created on. */
  private readonly device: GPUDeviceLike;

  /** Label used in diagnostics. */
  private readonly label: string;

  /** Created modules. */
  private modules: WebGPUShaderModules = { vertex: null, fragment: null };

  /** Vertex source. */
  private sourceVertex: string | null = null;

  /** Fragment source. */
  private sourceFragment: string | null = null;

  /** Most recent diagnostics. */
  private diagnostics: WGSLDiagnostic[] = [];

  /** Annotated report of the most recent validation pass. */
  private report: string = '';

  /** Entry point names the modules were created with. */
  private entryPoints: { vertex: string; fragment: string } = { vertex: 'vs_main', fragment: 'fs_main' };

  /** Pending validation promises, one per module. */
  private readonly pending: Promise<boolean>[] = [];

  /** `true` once validated against the implementation. */
  private validated: boolean = false;

  /** `true` once {@link WebGPUShader.dispose} has run. */
  private disposed: boolean = false;

  /**
   * Creates an uncompiled shader pair.
   *
   * @param device Device to create modules on.
   * @param options Label and entry-point names.
   */
  constructor(device: GPUDeviceLike, options: { label?: string } = {}) {
    this.device = device;
    this.label = options.label ?? 'shader';
    this.id = `webgpu-shader-${createId()}`;
  }

  /** Created modules. */
  public getModules(): WebGPUShaderModules {
    return this.modules;
  }

  /** Diagnostics from the most recent validation pass. */
  public getDiagnostics(): readonly WGSLDiagnostic[] {
    return this.diagnostics;
  }

  /** Annotated diagnostics from the most recent validation pass. */
  public get lastReport(): string {
    return this.report;
  }

  /** `true` once the implementation has reported its validation result. */
  public get isValidated(): boolean {
    return this.validated;
  }

  /** `true` when the most recent validation pass reported an error. */
  public get hasErrors(): boolean {
    return this.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  }

  /* ------------------------------------------------------------------ compile */

  /** @inheritdoc */
  public compile(vertexSource: string | null, fragmentSource: string): ShaderCompileResult {
    return this.compileStages(vertexSource, fragmentSource, this.entryPoints).result;
  }

  /**
   * Creates the stage modules.
   *
   * @param vertexSource Vertex WGSL, or `null` for a fragment-only shader.
   * @param fragmentSource Fragment WGSL, or `null` for a vertex-only shader.
   * @param entryPoints Entry-point names to record.
   * @returns The synchronous result plus the modules that were created.
   */
  public compileStages(
    vertexSource: string | null,
    fragmentSource: string | null,
    entryPoints: { vertex?: string; fragment?: string } = {},
  ): { result: ShaderCompileResult; modules: WebGPUShaderModules } {
    if (this.disposed) {
      throw new Error(`WebGPUShader(${this.label}): cannot compile a disposed shader.`);
    }

    this.entryPoints = {
      vertex: entryPoints.vertex ?? this.entryPoints.vertex,
      fragment: entryPoints.fragment ?? this.entryPoints.fragment,
    };
    this.sourceVertex = vertexSource;
    this.sourceFragment = fragmentSource;
    this.validated = false;
    this.pending.length = 0;
    this.diagnostics = [];

    this.modules = {
      vertex: vertexSource === null ? null : this.createModule(vertexSource, 'vertex'),
      fragment: fragmentSource === null ? null : this.createModule(fragmentSource, 'fragment'),
    };

    if (this.modules.vertex === null && this.modules.fragment === null) {
      this.report =
        `WebGPUShader(${this.label}): neither a vertex nor a fragment source was supplied, so no ` +
        'module was created.';
      return { result: { success: false, attributes: [], uniforms: [], log: this.report }, modules: this.modules };
    }

    // Validation is reported asynchronously; the synchronous result is therefore
    // "created". The report is filled in by `whenValidated()`.
    this.report = `[${this.label}] modules created; WGSL validation is pending`;

    return {
      result: { success: true, attributes: [], uniforms: [], log: this.report },
      modules: this.modules,
    };
  }

  /**
   * Waits for the implementation to validate the modules and formats the result.
   *
   * @returns `true` when every module validated without errors.
   */
  public async whenValidated(): Promise<boolean> {
    if (this.validated) return !this.hasErrors;
    if (this.pending.length === 0) {
      this.validated = true;
      return true;
    }

    const results = await Promise.all(this.pending);
    this.validated = true;
    const ok = results.every((value) => value) && !this.hasErrors;
    this.report = this.buildReport(ok);
    if (!ok) log.error(`WebGPUShader(${this.label}) failed WGSL validation:\n${this.report}`);
    else if (this.diagnostics.length > 0) {
      log.debug(`WebGPUShader(${this.label}) validated with warnings:\n${this.report}`);
    }
    return ok;
  }

  /* ------------------------------------------------------------------ IShader */

  /**
   * No-op: WebGPU binds pipelines rather than programs.
   *
   * @returns `true` when at least one module exists.
   */
  public use(): boolean {
    return this.isCompiled;
  }

  /**
   * Not applicable to WebGPU, where uniforms live in bind groups.
   *
   * @param name Uniform name; recorded at debug level.
   * @param value Value; ignored.
   */
  public setUniform(name: string, value: UniformValue): void {
    void value;
    log.debug(
      `WebGPUShader(${this.label}): setUniform('${name}') is a no-op on WebGPU. Write the value ` +
        'into a uniform buffer and bind it through a bind group instead.',
    );
  }

  /**
   * Not applicable to WebGPU.
   *
   * @param values Uniform bag; ignored.
   */
  public setUniforms(values: Readonly<Record<string, UniformValue>>): void {
    void values;
    log.debug(`WebGPUShader(${this.label}): setUniforms() is a no-op on WebGPU; use bind groups.`);
  }

  /**
   * Always `-1`: WGSL declares `@location(n)` explicitly.
   *
   * @param name Attribute name; ignored.
   */
  public getAttributeLocation(name: string): number {
    void name;
    return -1;
  }

  /**
   * Always `null`: WGSL declares `@group(n) @binding(m)` explicitly.
   *
   * @param name Uniform name; ignored.
   */
  public getUniformLocation(name: string): unknown {
    void name;
    return null;
  }

  /** @inheritdoc */
  public dispose(): void {
    if (this.disposed) return;
    this.modules = { vertex: null, fragment: null };
    this.pending.length = 0;
    this.disposed = true;
  }

  /** @returns A human-readable description. */
  public toString(): string {
    return (
      `WebGPUShader(${this.label}, vertex=${this.modules.vertex !== null}, ` +
      `fragment=${this.modules.fragment !== null})`
    );
  }

  /* ---------------------------------------------------------------- internals */

  /** Creates one module and starts its validation. */
  private createModule(source: string, stage: 'vertex' | 'fragment'): GPUShaderModuleLike | null {
    let module: GPUShaderModuleLike;
    try {
      module = this.device.createShaderModule({ label: `${this.label}.${stage}`, code: source });
    } catch (error) {
      const diagnostic: WGSLDiagnostic = {
        severity: 'error',
        message: `createShaderModule threw: ${(error as Error)?.message ?? String(error)}`,
        line: null,
        column: null,
        offset: null,
        length: null,
      };
      this.diagnostics.push(diagnostic);
      log.error(`WebGPUShader(${this.label}).${stage}: ${diagnostic.message}`);
      return null;
    }

    if (typeof module.getCompilationInfo === 'function') {
      this.pending.push(this.collectValidation(module, source, stage));
    }
    return module;
  }

  /** Pulls the compilation info and normalises it. */
  private async collectValidation(
    module: GPUShaderModuleLike,
    source: string,
    stage: 'vertex' | 'fragment',
  ): Promise<boolean> {
    try {
      const info = await (module.getCompilationInfo as () => Promise<GPUCompilationInfoLike>).call(module);
      const diagnostics = normalizeWGSLDiagnostics(info, source);
      for (const diagnostic of diagnostics) this.diagnostics.push(diagnostic);
      const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
      if (errors.length > 0) {
        log.debug(`WebGPUShader(${this.label}).${stage}: ${errors.length} WGSL error(s)`);
        return false;
      }
      return true;
    } catch (error) {
      log.debug(`WebGPUShader(${this.label}).${stage}: getCompilationInfo() failed`, error);
      return true;
    }
  }

  /** Builds the annotated report for the current diagnostics. */
  private buildReport(ok: boolean): string {
    if (this.diagnostics.length === 0) {
      return ok
        ? `[${this.label}] WGSL validated without diagnostics`
        : `[${this.label}] WGSL validation failed and the implementation returned no diagnostics.`;
    }

    // Diagnostics are grouped by the stage whose source line they fall inside.
    const sections: string[] = [];
    for (const stage of ['vertex', 'fragment'] as const) {
      const source = stage === 'vertex' ? this.sourceVertex : this.sourceFragment;
      if (source === null) continue;
      const lineCount = source.split(/\r?\n/).length;
      const mine = this.diagnostics.filter((diagnostic) => {
        if (diagnostic.line === null) return stage === 'vertex';
        return diagnostic.line >= 1 && diagnostic.line <= lineCount;
      });
      if (mine.length === 0) continue;
      sections.push(
        formatWGSLDiagnostics(source, mine, {
          label: `${this.label}.${stage}`,
          stage,
          context: 1,
        }),
      );
    }

    if (sections.length === 0) {
      sections.push(formatWGSLDiagnostics(this.sourceVertex ?? this.sourceFragment, this.diagnostics, {
        label: this.label,
        context: 1,
      }));
    }
    return sections.join('\n');
  }
}

/**
 * Creates a single-stage shader module, for compute and utility pipelines.
 *
 * @param device Device to create the module on.
 * @param code WGSL source.
 * @param label Optional label.
 * @returns The module.
 */
export function createShaderModule(device: GPUDeviceLike, code: string, label?: string): GPUShaderModuleLike {
  return device.createShaderModule(label === undefined ? { code } : { label, code });
}

/**
 * Rewrites an `IShader`-style compile result into an annotated report.
 *
 * @param source WGSL source.
 * @param diagnostics Normalised diagnostics.
 * @param options Header tuning.
 */
export function describeWGSLFailure(
  source: string,
  diagnostics: readonly WGSLDiagnostic[],
  options: FormatWGSLDiagnosticsOptions = {},
): string {
  return formatWGSLDiagnostics(source, diagnostics, { context: 1, ...options });
}
