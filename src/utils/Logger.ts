/**
 * Levelled logging with optional colour output and pluggable sinks.
 *
 * The library never writes to `console` outside of this module, which makes it
 * possible to silence or capture diagnostics in tests.
 *
 * @packageDocumentation
 */

/** Severity levels, ordered from most to least verbose. */
export enum LogLevel {
  Trace = 0,
  Debug = 1,
  Info = 2,
  Warn = 3,
  Error = 4,
  Silent = 5,
}

/** A single log record handed to sinks. */
export interface LogRecord {
  level: LogLevel;
  /** Short level name (`'info'`, `'warn'`, ...). */
  levelName: string;
  /** Logger name, usually the owning module. */
  namespace: string;
  /** Primary message. */
  message: string;
  /** Extra structured payload. */
  args: unknown[];
  /** Timestamp in milliseconds since process start. */
  time: number;
}

/** Consumer of {@link LogRecord}s. */
export type LogSink = (record: LogRecord) => void;

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.Trace]: 'trace',
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warn]: 'warn',
  [LogLevel.Error]: 'error',
  [LogLevel.Silent]: 'silent',
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  [LogLevel.Trace]: '#8a8a8a',
  [LogLevel.Debug]: '#4a9eff',
  [LogLevel.Info]: '#2ecc71',
  [LogLevel.Warn]: '#f39c12',
  [LogLevel.Error]: '#e74c3c',
  [LogLevel.Silent]: '#000000',
};

/** Global logging configuration shared by every logger instance. */
export interface LoggerOptions {
  /** Records below this level are dropped. */
  level: LogLevel;
  /** Sinks receiving the records. Defaults to the console sink. */
  sinks: LogSink[];
  /** Emit `%c` coloured output when the console supports it. */
  colors: boolean;
  /** Include a `performance.now()` timestamp. */
  timestamps: boolean;
}

const options: LoggerOptions = {
  level: LogLevel.Warn,
  sinks: [],
  colors: true,
  timestamps: false,
};

/** Default sink writing to `console` with optional colours. */
const consoleSink: LogSink = (record) => {
  const console_ = typeof console !== 'undefined' ? console : undefined;
  if (!console_) return;

  const prefix = record.namespace ? `[${record.namespace}]` : '';
  const time = options.timestamps ? `+${record.time.toFixed(1)}ms ` : '';
  const label = `${time}${prefix}`.trim();

  const method =
    record.level >= LogLevel.Error
      ? console_.error
      : record.level >= LogLevel.Warn
        ? console_.warn
        : console_.log;

  if (options.colors && typeof document !== 'undefined' && method === console_.log) {
    console_.log(
      `%c${label}`,
      `color:${LEVEL_COLORS[record.level]};font-weight:600`,
      record.message,
      ...record.args,
    );
    return;
  }
  method.call(console_, label, record.message, ...record.args);
};

/** Emits a record to every configured sink (or the console sink). */
function emit(record: LogRecord): void {
  const sinks = options.sinks.length > 0 ? options.sinks : [consoleSink];
  for (const sink of sinks) {
    try {
      sink(record);
    } catch {
      /* a broken sink must never break rendering */
    }
  }
}

/**
 * Namespaced logger.
 *
 * ```ts
 * const log = createLogger('renderer');
 * log.info('created', { backend: 'webgl2' });
 * ```
 */
export class Logger {
  /** Namespace shown as a prefix on every record. */
  public readonly namespace: string;

  /** Creates a logger; prefer {@link createLogger} for the shared registry. */
  constructor(namespace: string = '') {
    this.namespace = namespace;
  }

  /** `true` when `level` would be recorded by this logger. */
  public isLevelEnabled(level: LogLevel): boolean {
    return level >= options.level && options.level !== LogLevel.Silent;
  }

  /** Records at {@link LogLevel.Trace}. */
  public trace(message: string, ...args: unknown[]): void {
    this.write(LogLevel.Trace, message, args);
  }

  /** Records at {@link LogLevel.Debug}. */
  public debug(message: string, ...args: unknown[]): void {
    this.write(LogLevel.Debug, message, args);
  }

  /** Records at {@link LogLevel.Info}. */
  public info(message: string, ...args: unknown[]): void {
    this.write(LogLevel.Info, message, args);
  }

  /** Records at {@link LogLevel.Warn}. */
  public warn(message: string, ...args: unknown[]): void {
    this.write(LogLevel.Warn, message, args);
  }

  /** Records at {@link LogLevel.Error}. */
  public error(message: string, ...args: unknown[]): void {
    this.write(LogLevel.Error, message, args);
  }

  /** Records an error at warn level once, de-duplicated by message. */
  private readonly warned = new Set<string>();

  /** Emits `message` only the first time it is seen for this logger. */
  public warnOnce(message: string, ...args: unknown[]): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.warn(message, ...args);
  }

  /** Creates a child logger whose namespace is suffixed. */
  public child(suffix: string): Logger {
    return new Logger(this.namespace ? `${this.namespace}:${suffix}` : suffix);
  }

  /** Starts a timer; the returned function logs the elapsed milliseconds. */
  public time(label: string): () => number {
    const start =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    return () => {
      const end =
        typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      const elapsed = end - start;
      this.debug(`${label}: ${elapsed.toFixed(2)}ms`);
      return elapsed;
    };
  }

  /** Builds and emits a record. */
  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (!this.isLevelEnabled(level)) return;
    emit({
      level,
      levelName: LEVEL_NAMES[level],
      namespace: this.namespace,
      message,
      args,
      time: typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(),
    });
  }
}

/** Logger cache keyed by namespace. */
const loggers = new Map<string, Logger>();

/** Returns (and caches) the logger for `namespace`. */
export function createLogger(namespace: string = ''): Logger {
  let logger = loggers.get(namespace);
  if (!logger) {
    logger = new Logger(namespace);
    loggers.set(namespace, logger);
  }
  return logger;
}

/** The logger used by internal, self-diagnosing code paths. */
export const log = createLogger('graphics');

/** Updates the global logging configuration. */
export function configureLogging(next: Partial<LoggerOptions>): void {
  if (next.level !== undefined) options.level = next.level;
  if (next.sinks !== undefined) options.sinks = next.sinks.slice();
  if (next.colors !== undefined) options.colors = next.colors;
  if (next.timestamps !== undefined) options.timestamps = next.timestamps;
}

/** Returns the active logging configuration (a copy; mutate via {@link configureLogging}). */
export function getLoggingOptions(): LoggerOptions {
  return { ...options, sinks: options.sinks.slice() };
}

/** Enables or disables logging in one call. */
export function setLogLevel(level: LogLevel): void {
  options.level = level;
}

/** Convenience: log everything. */
export function enableVerboseLogging(): void {
  options.level = LogLevel.Debug;
}

/** Convenience: silence everything. */
export function disableLogging(): void {
  options.level = LogLevel.Silent;
}

/** Routes all log records to a custom sink (replacing the console sink). */
export function setLogSink(sink: LogSink | null): void {
  options.sinks = sink ? [sink] : [];
}

/** Captures records in memory; primarily a test helper. */
export function createMemorySink(): { sink: LogSink; records: LogRecord[]; clear(): void } {
  const records: LogRecord[] = [];
  return {
    sink: (record) => records.push(record),
    records,
    clear: () => {
      records.length = 0;
    },
  };
}
