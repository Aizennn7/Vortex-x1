/**
 * Structured logging with mandatory redaction. Every log line is a single
 * JSON object; secrets never reach stdout because `redact` runs on the way in.
 */

import { redact } from './secrets.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
};

export interface LogRecord {
  level: LogLevel;
  time: string;
  msg: string;
  component?: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  level?: LogLevel;
  component?: string;
  secrets?: string[];
  /** Sink override for tests. */
  sink?: (line: string, record: LogRecord) => void;
}

export class Logger {
  private level: LogLevel;
  private readonly component: string | undefined;
  private readonly secrets: string[];
  private readonly sink: (line: string, record: LogRecord) => void;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.component = options.component;
    this.secrets = options.secrets ?? [];
    this.sink =
      options.sink ??
      ((line) => {
        process.stdout.write(`${line}\n`);
      });
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setSecrets(secrets: string[]): void {
    this.secrets.length = 0;
    this.secrets.push(...secrets);
  }

  child(component: string, extra: Record<string, unknown> = {}): BoundLogger {
    return new BoundLogger(this, { component, ...extra });
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const record: LogRecord = {
      level,
      time: new Date().toISOString(),
      msg,
      ...(this.component ? { component: this.component } : {}),
      ...(redact(fields, this.secrets) as Record<string, unknown>),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ level, time: record.time, msg, serialisationError: true });
    }
    this.sink(line, record);
  }

  trace(msg: string, fields?: Record<string, unknown>): void {
    this.log('trace', msg, fields);
  }
  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.log('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log('error', msg, fields);
  }
  fatal(msg: string, fields?: Record<string, unknown>): void {
    this.log('fatal', msg, fields);
  }
}

export class BoundLogger {
  constructor(
    private readonly parent: Logger,
    private readonly fields: Record<string, unknown>,
  ) {}

  child(component: string, extra: Record<string, unknown> = {}): BoundLogger {
    return new BoundLogger(this.parent, { ...this.fields, component, ...extra });
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    this.parent.log(level, msg, { ...this.fields, ...(fields ?? {}) });
  }

  trace(msg: string, fields?: Record<string, unknown>): void {
    this.emit('trace', msg, fields);
  }
  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit('error', msg, fields);
  }
  fatal(msg: string, fields?: Record<string, unknown>): void {
    this.emit('fatal', msg, fields);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options);
}

/** Stable slug for grouping log lines in the control centre. */
export function logEventKey(component: string, event: string): string {
  return `${component}:${event}`.toLowerCase().replace(/[^a-z0-9:._-]/g, '_');
}
