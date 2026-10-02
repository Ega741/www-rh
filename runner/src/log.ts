/**
 * Minimal leveled logger writing one line per record to stderr (`time level [component] message {json}`).
 *
 * @module log
 */

/** Log levels in increasing severity. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: LogLevel = 'info';

/** Sets the global minimum level. */
export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

/** A component-scoped logger. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(component: string): Logger;
}

function render(fields: Record<string, unknown> | undefined): string {
  if (fields === undefined) return '';
  try {
    return ` ${JSON.stringify(fields, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v instanceof Error ? v.message : v))}`;
  } catch {
    return '';
  }
}

/** Creates a logger for `component`. */
export function createLogger(component: string): Logger {
  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[level] < ORDER[threshold]) return;
    process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${component}] ${message}${render(fields)}\n`);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (sub) => createLogger(`${component}:${sub}`),
  };
}

/** A logger that drops everything (tests). */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

/** Best-effort message of an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.split('\n')[0] ?? err.message;
  return String(err);
}
