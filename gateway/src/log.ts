/**
 * JSON-lines logger (SPEC §5.13): `{ level, time, msg, requestId?, workspace?, ... }` to stdout.
 * Secrets never reach the output: API keys (`bgl_…`), provider keys (`sk-…`, `sk-ant-…`, `AIza…`) and
 * bearer tokens are redacted from every string, and any field whose name ends in key / secret /
 * token / password / private / cookie / authorization is replaced wholesale.
 *
 * @module log
 */

/** Log levels, least to most severe. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
/** One of {@link LOG_LEVELS}. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Extra structured fields of a log line. */
export type LogFields = Record<string, unknown>;

/** A logger bound to a level and optional base fields. */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A child logger whose lines carry `fields` (e.g. `requestId`, `workspace`). */
  child(fields: LogFields): Logger;
}

/** Options of {@link createLogger}. */
export interface LoggerOptions {
  level?: LogLevel;
  /** Sink for finished lines (default `process.stdout.write`). */
  write?: (line: string) => void;
  /** Clock (default `Date.now`). */
  now?: () => number;
  /** Fields added to every line. */
  base?: LogFields;
}

const REDACTIONS: readonly RegExp[] = [
  /bgl_[A-Za-z0-9_-]{8,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g,
  /\b(bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

/** Replaces secret-looking substrings of `text` with `[redacted]`. */
export function redactString(text: string): string {
  let out = text;
  for (const re of REDACTIONS) {
    out = out.replace(re, (match: string, ...groups: unknown[]) => {
      const first = groups[0];
      if (typeof first === 'string' && /^bearer$/i.test(first)) return `${first} [redacted]`;
      void match;
      return '[redacted]';
    });
  }
  return out;
}

/** Field names whose string values are replaced wholesale (tx/receipt hashes are not secrets and stay visible). */
const SECRET_KEYS = /(apikey|api_key|secret|password|private|privatekey|private_key|token|authorization|cookie|ciphertext|key)$/i;

/** Deep-redacts `value`: secret-named keys are replaced wholesale, strings are pattern-redacted. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), ...(value.stack ? { stack: redactString(value.stack) } : {}) };
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = SECRET_KEYS.test(k) && typeof v === 'string' && v !== '' ? '[redacted]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** `true` when `level` is one of {@link LOG_LEVELS}. */
export function isLogLevel(level: string): level is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(level);
}

/** Creates a {@link Logger}. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const threshold = LOG_LEVELS.indexOf(level);
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => Date.now());

  function make(base: LogFields): Logger {
    const emit = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
      if (LOG_LEVELS.indexOf(lvl) < threshold) return;
      const record = { level: lvl, time: new Date(now()).toISOString(), msg: redactString(msg), ...(redactValue({ ...base, ...(fields ?? {}) }) as LogFields) };
      try {
        write(JSON.stringify(record));
      } catch {
        write(JSON.stringify({ level: lvl, time: record.time, msg: record.msg, error: 'unserializable fields' }));
      }
    };
    return {
      debug: (msg, fields) => emit('debug', msg, fields),
      info: (msg, fields) => emit('info', msg, fields),
      warn: (msg, fields) => emit('warn', msg, fields),
      error: (msg, fields) => emit('error', msg, fields),
      child: (fields) => make({ ...base, ...fields }),
    };
  }
  return make(options.base ?? {});
}

/** A logger that discards everything (tests). */
export const silentLogger: Logger = createLogger({ write: () => undefined, level: 'error' }).child({});
