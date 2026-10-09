/**
 * GLSL compilation with actionable diagnostics.
 *
 * A raw `gl.getShaderInfoLog` string is close to useless on its own: it names a
 * line number but never shows the line, and drivers disagree about the exact
 * format. This module turns the log into an annotated report that reproduces the
 * offending source line and points a caret at the column the driver complained
 * about.
 *
 * The annotation is deliberately computed rather than parsed where possible. GLSL
 * logs carry a line number, sometimes a column, and almost always the offending
 * identifier in single quotes; the identifier is the most reliable column hint a
 * driver gives, so it is preferred over the numeric column.
 *
 * @packageDocumentation
 */

import { createId } from '../../utils/Id';
import { createLogger } from '../../utils/Logger';
import { ShaderStage } from '../interfaces/IShader';
import { glConst, type GL, type GLShaderObject } from './WebGLUtils';

/** Logger for shader diagnostics. */
const log = createLogger('renderer:webgl:shader');

/* -------------------------------------------------------------------------- */
/* Info-log parsing                                                           */
/* -------------------------------------------------------------------------- */

/** Severity a driver assigned to one log record. */
export type ShaderLogSeverity = 'error' | 'warning' | 'info';

/** One parsed record of a GLSL info log. */
export interface ShaderLogEntry {
  /** The record exactly as the driver produced it. */
  readonly raw: string;
  /** Severity parsed from the record's prefix. */
  readonly severity: ShaderLogSeverity;
  /** 1-based source line, or `null` when the driver did not report one. */
  readonly line: number | null;
  /** Column the driver reported, or `null` when absent. */
  readonly column: number | null;
  /** Message text with the `SEVERITY: 0:line:col:` prefix stripped. */
  readonly message: string;
}

/**
 * Driver log prefixes this parser understands.
 *
 * ANGLE emits `ERROR: 0:12: ...`; several mobile drivers emit
 * `ERROR: 0:12(5): ...` or `0(12) : error C1234: ...`; all of the shapes seen in
 * the wild are covered so a report is never silently swallowed.
 */
const LOG_PATTERNS: readonly RegExp[] = [
  /^(ERROR|WARNING|INFO)\s*:\s*(\d+)\s*:\s*(\d+)(?:\s*\(\s*(\d+)\s*\))?\s*:\s*(.*)$/i,
  /^(ERROR|WARNING|INFO)\s*:\s*(\d+)\s*\(\s*(\d+)\s*\)\s*:\s*(.*)$/i,
  /^(\d+)\s*\(\s*(\d+)\s*\)\s*:\s*(error|warning|info)\s*[A-Z]*\d*\s*:\s*(.*)$/i,
];

/**
 * Splits a GLSL info log into structured records.
 *
 * Unrecognised lines are preserved verbatim with `line: null`, so nothing the
 * driver said is ever dropped.
 *
 * @param infoLog Raw `getShaderInfoLog`/`getProgramInfoLog` output.
 * @returns Parsed records, in driver order.
 */
export function parseWebGLInfoLog(infoLog: string | null | undefined): ShaderLogEntry[] {
  if (infoLog == null) return [];
  const entries: ShaderLogEntry[] = [];

  for (const rawLine of String(infoLog).split(/\r?\n/)) {
    const raw = rawLine.trimEnd();
    if (raw.trim().length === 0) continue;
    entries.push(parseInfoLogLine(raw));
  }

  return entries;
}

/** Parses a single log line. */
function parseInfoLogLine(raw: string): ShaderLogEntry {
  const trimmed = raw.trim();

  // ANGLE form: ERROR: 0:12: message  /  ERROR: 0:12(4): message
  //
  // The first number is the *source string* index (always 0 for a single source) and
  // the second is the line number, so the line is group 3 and not group 2.
  const angle = LOG_PATTERNS[0].exec(trimmed);
  if (angle !== null) {
    return {
      raw,
      severity: normalizeSeverity(angle[1]),
      line: Number.parseInt(angle[3], 10),
      column: angle[4] !== undefined ? Number.parseInt(angle[4], 10) : null,
      message: angle[5],
    };
  }

  // ERROR: 0(12): message
  const flat = LOG_PATTERNS[1].exec(trimmed);
  if (flat !== null) {
    return {
      raw,
      severity: normalizeSeverity(flat[1]),
      line: Number.parseInt(flat[2], 10),
      column: Number.parseInt(flat[3], 10),
      message: flat[4],
    };
  }

  // HLSL-ish form: 12(4): error X3000: message
  const hlsl = LOG_PATTERNS[2].exec(trimmed);
  if (hlsl !== null) {
    return {
      raw,
      severity: normalizeSeverity(hlsl[3]),
      line: Number.parseInt(hlsl[1], 10),
      column: Number.parseInt(hlsl[2], 10),
      message: hlsl[4],
    };
  }

  return { raw, severity: 'info', line: null, column: null, message: trimmed };
}

/** Normalises a severity token. */
function normalizeSeverity(token: string | undefined): ShaderLogSeverity {
  const value = (token ?? '').toLowerCase();
  if (value.startsWith('err')) return 'error';
  if (value.startsWith('warn')) return 'warning';
  return 'info';
}

/* -------------------------------------------------------------------------- */
/* Annotation                                                                 */
/* -------------------------------------------------------------------------- */

/** Options accepted by {@link formatWebGLInfoLog}. */
export interface FormatInfoLogOptions {
  /** Stage label included in the header (`'vertex'`, `'fragment'`, ...). */
  stage?: ShaderStage | string;
  /** Name of the shader/program the log belongs to. */
  label?: string;
  /** Number of source lines reproduced around each failure. Defaults to `0`. */
  context?: number;
  /** Omit the header block. Defaults to `false`. */
  noHeader?: boolean;
}

/**
 * Renders a GLSL info log as an annotated, human-readable report.
 *
 * Each record is followed by the source line it refers to and a caret positioned
 * under the offending token:
 *
 * ```text
 * [shader main.vert (vertex)] 1 error
 *   ERROR: 0:12: 'x' : undeclared identifier
 *      12 |   float y = x * 2.0;
 *         |             ^
 * ```
 *
 * @param source Shader source the log refers to, or `null` to skip the excerpt.
 * @param infoLog Raw driver log.
 * @param options Header/stage/context tuning.
 * @returns The annotated report, or `''` when the log is empty.
 */
export function formatWebGLInfoLog(
  source: string | null | undefined,
  infoLog: string | null | undefined,
  options: FormatInfoLogOptions = {},
): string {
  const entries = parseWebGLInfoLog(infoLog);
  if (entries.length === 0) return '';

  const lines = source == null ? null : splitSourceLines(source);
  const lineNumberWidth = Math.max(
    2,
    ...entries.map((entry) => (entry.line === null ? 1 : String(entry.line).length)),
  );

  const out: string[] = [];

  if (!(options.noHeader ?? false)) {
    const errorCount = entries.filter((entry) => entry.severity === 'error').length;
    const warningCount = entries.filter((entry) => entry.severity === 'warning').length;
    const parts: string[] = [];
    if (errorCount > 0) parts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
    if (warningCount > 0) parts.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);
    if (parts.length === 0) parts.push(`${entries.length} message${entries.length === 1 ? '' : 's'}`);

    const label = options.label ?? 'shader';
    const stage = options.stage !== undefined ? ` (${String(options.stage)})` : '';
    out.push(`[${label}${stage}] ${parts.join(', ')}`);
  }

  const context = Math.max(0, Math.floor(options.context ?? 0));

  for (const entry of entries) {
    out.push(`  ${entry.raw}`);
    if (lines === null || entry.line === null) continue;

    const first = Math.max(1, entry.line - context);
    const last = Math.min(lines.length, entry.line + context);
    for (let number = first; number <= last; number++) {
      out.push(`  ${formatSourceLine(number, lines[number - 1] ?? '', lineNumberWidth)}`);
      if (number === entry.line) {
        const column = resolveCaretColumn(entry, lines[number - 1] ?? '');
        if (column >= 0) out.push(`  ${formatCaretLine(column, lineNumberWidth)}`);
      }
    }
  }

  return out.join('\n');
}

/**
 * Works out the column a caret should point at for one log record.
 *
 * Preference order:
 *  1. the identifier the driver quoted (`'x'`), located in the source line;
 *  2. the numeric column the driver reported, when it is inside the line;
 *  3. column `0`, so a caret is still drawn.
 *
 * @param entry Parsed log record.
 * @param sourceLine The source line the record refers to.
 * @returns A zero-based column index, or `-1` when no caret should be drawn.
 */
export function resolveCaretColumn(entry: ShaderLogEntry, sourceLine: string): number {
  const quoted = /'([^']+)'/.exec(entry.message) ?? /"([^"]+)"/.exec(entry.message);
  if (quoted !== null) {
    const index = sourceLine.indexOf(quoted[1]);
    if (index >= 0) return index;
  }

  if (entry.column !== null && Number.isFinite(entry.column)) {
    // GLSL columns are conventionally 1-based character positions; some drivers
    // emit 0, in which case the caret starts at the line beginning.
    const zeroBased = Math.max(0, entry.column - 1);
    if (zeroBased <= sourceLine.length) return zeroBased;
  }

  return 0;
}

/** Formats `   12 |   float y = x * 2.0;`. */
function formatSourceLine(lineNumber: number, text: string, width: number): string {
  return `${String(lineNumber).padStart(width)} | ${text}`;
}

/** Formats the caret row under a source line. */
function formatCaretLine(column: number, width: number): string {
  return `${' '.repeat(width)} | ${' '.repeat(Math.max(0, column))}^`;
}

/** Splits source text, tolerating CRLF. */
function splitSourceLines(source: string): string[] {
  return source.split(/\r?\n/);
}

/* -------------------------------------------------------------------------- */
/* Defines                                                                    */
/* -------------------------------------------------------------------------- */

/** Value a preprocessor definition may take. */
export type DefineValue = string | number | boolean | null | undefined;

/**
 * Prepends `#define` lines to a GLSL source.
 *
 * A leading `#version` directive must stay the very first token of a shader, so the
 * definitions are inserted after it. Empty definitions (`undefined`/`null`) are
 * emitted bare, which produces a flag the shader can test with `#ifdef`.
 *
 * @param source Original GLSL source.
 * @param defines Name → value map.
 * @returns The source with the definitions injected.
 */
export function prependDefines(source: string, defines: Readonly<Record<string, DefineValue>> | undefined): string {
  if (defines === undefined) return source;
  const names = Object.keys(defines);
  if (names.length === 0) return source;

  const block: string[] = [];
  for (const name of names) {
    const value = defines[name];
    if (value === null || value === undefined) block.push(`#define ${name}`);
    else if (typeof value === 'boolean') block.push(value ? `#define ${name} 1` : `#define ${name} 0`);
    else block.push(`#define ${name} ${String(value)}`);
  }

  const lines = splitSourceLines(source);
  let insertAt = 0;
  while (insertAt < lines.length && lines[insertAt].trim().length === 0) insertAt++;
  if (insertAt < lines.length && lines[insertAt].trim().startsWith('#version')) insertAt++;

  lines.splice(insertAt, 0, ...block);
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* WebGLShader                                                                */
/* -------------------------------------------------------------------------- */

/** Options accepted by {@link WebGLShader}. */
export interface WebGLShaderOptions {
  /** Human-readable label used in diagnostics. Defaults to the stage name. */
  label?: string;
  /** Preprocessor definitions injected before compilation. */
  defines?: Readonly<Record<string, DefineValue>>;
}

/**
 * One compiled GLSL stage.
 *
 * The class owns a single `WebGLShader` handle; {@link WebGLProgram} links two of
 * them. Compilation never throws — the outcome is reported through
 * {@link WebGLShader.isCompiled} and {@link WebGLShader.getReport} — because a
 * caller may legitimately want to fall back to a different program.
 */
export class WebGLShader {
  /** Stable identifier used in diagnostics and cache keys. */
  public readonly id: string;

  /** Stage this shader was created for. */
  public readonly stage: ShaderStage;

  /** Source as it was handed to the driver (defines already injected). */
  public readonly source: string;

  /** Context the shader belongs to. */
  private readonly gl: GL;

  /** Label used in reports. */
  private readonly label: string;

  /** Native handle, or `null` before compilation/after disposal. */
  private handle: GLShaderObject | null = null;

  /** Raw driver log from the last compilation. */
  private rawLog: string = '';

  /** `true` once compilation succeeded. */
  private compiled: boolean = false;

  /** `true` once the handle has been released. */
  private disposed: boolean = false;

  /**
   * Creates and immediately compiles a stage.
   *
   * @param gl Context to compile against.
   * @param stage Stage this source belongs to.
   * @param source GLSL source.
   * @param options Label and preprocessor definitions.
   */
  constructor(gl: GL, stage: ShaderStage, source: string, options: WebGLShaderOptions = {}) {
    this.gl = gl;
    this.stage = stage;
    this.source = prependDefines(source, options.defines);
    this.label = options.label ?? `${stage}-shader`;
    this.id = `webgl-${stage}-${createId()}`;
  }

  /** Native handle, or `null` when not compiled. */
  public get handleOrNull(): GLShaderObject | null {
    return this.handle;
  }

  /** `true` once the source compiled successfully. */
  public get isCompiled(): boolean {
    return this.compiled;
  }

  /** `true` once the handle has been released. */
  public get isDisposed(): boolean {
    return this.disposed;
  }

  /** Raw log from the last compilation. */
  public get infoLog(): string {
    return this.rawLog;
  }

  /**
   * Compiles the source.
   *
   * @returns `true` when the shader is usable.
   */
  public compile(): boolean {
    if (this.disposed) {
      throw new Error(`WebGLShader(${this.label}): cannot compile a disposed shader.`);
    }
    if (this.compiled) return true;

    const stageEnum = this.stageConstant();
    if (this.handle !== null) {
      this.gl.deleteShader(this.handle);
      this.handle = null;
    }

    const handle = this.gl.createShader(stageEnum);
    if (handle === null) {
      this.rawLog = `WebGLShader(${this.label}): gl.createShader returned null. The context may be lost.`;
      this.compiled = false;
      log.error(this.rawLog);
      return false;
    }

    this.gl.shaderSource(handle, this.source);
    this.gl.compileShader(handle);

    const status = this.gl.getShaderParameter(handle, glConst(this.gl, 'COMPILE_STATUS', 0x8b81));
    this.rawLog = this.gl.getShaderInfoLog(handle) ?? '';

    if (status !== true) {
      this.handle = handle;
      this.compiled = false;
      log.error(
        `WebGLShader(${this.label}) failed to compile:\n${this.getReport()}`,
      );
      return false;
    }

    this.handle = handle;
    this.compiled = true;

    if (this.rawLog.trim().length > 0) {
      log.debug(`WebGLShader(${this.label}) compiled with warnings:\n${this.getReport()}`);
    } else {
      log.debug(`WebGLShader(${this.label}) compiled`);
    }
    return true;
  }

  /**
   * Builds the annotated compilation report.
   *
   * @param options Header/context tuning.
   * @returns The report, or an explanatory message when the driver said nothing.
   */
  public getReport(options: FormatInfoLogOptions = {}): string {
    if (this.rawLog.trim().length === 0) {
      return this.compiled
        ? `[${this.label} (${this.stage})] compiled without diagnostics`
        : `[${this.label} (${this.stage})] compilation failed and the driver returned an empty info log. ` +
            'This usually means the context was lost while compiling.';
    }
    return formatWebGLInfoLog(this.source, this.rawLog, {
      stage: this.stage,
      label: this.label,
      ...options,
    });
  }

  /**
   * Returns the native handle, throwing when the shader is not usable.
   *
   * @returns The compiled handle.
   * @throws Error When compilation has not succeeded.
   */
  public getHandle(): GLShaderObject {
    if (this.handle === null || !this.compiled) {
      throw new Error(
        `WebGLShader(${this.label}) is not compiled, so it cannot be attached to a program.\n${this.getReport()}`,
      );
    }
    return this.handle;
  }

  /** Releases the native handle. */
  public dispose(): void {
    if (this.disposed) return;
    if (this.handle !== null) {
      this.gl.deleteShader(this.handle);
      this.handle = null;
    }
    this.compiled = false;
    this.disposed = true;
  }

  /** Maps the renderer-agnostic stage onto the GL enumeration. */
  private stageConstant(): number {
    switch (this.stage) {
      case ShaderStage.Vertex:
        return glConst(this.gl, 'VERTEX_SHADER', 0x8b31);
      case ShaderStage.Fragment:
        return glConst(this.gl, 'FRAGMENT_SHADER', 0x8b30);
      case ShaderStage.Compute:
        throw new Error(
          'WebGLShader: compute shaders are not part of WebGL. Use the WebGPU backend ' +
            '(`WebGPUCompute`) for GPU compute work.',
        );
      default:
        return glConst(this.gl, 'VERTEX_SHADER', 0x8b31);
    }
  }

  /** @returns A human-readable description. */
  public toString(): string {
    return `WebGLShader(${this.label}, ${this.stage}, ${this.compiled ? 'compiled' : 'uncompiled'})`;
  }
}
