/**
 * Thin wrapper over `node:sqlite` (`DatabaseSync`): WAL, foreign keys, cached prepared statements,
 * synchronous transactions (nestable via savepoints) and bigint-safe reads for monetary columns.
 *
 * @module db/sqlite
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from 'node:sqlite';

/** One result row. */
export type Row = Record<string, SQLOutputValue>;
/** Bind parameters. */
export type Params = readonly SQLInputValue[];

/** Reads a monetary / 64-bit column as `bigint` (statements opened with `big: true` return bigint already). */
export function big(v: SQLOutputValue | undefined): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  if (v === null || v === undefined) return 0n;
  throw new TypeError(`expected an integer column, got ${typeof v}`);
}

/** Reads a small integer column as `number`. */
export function num(v: SQLOutputValue | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v === null || v === undefined) return 0;
  if (typeof v === 'string') return Number(v);
  throw new TypeError(`expected a numeric column, got ${typeof v}`);
}

/** Reads a nullable integer column. */
export function optNum(v: SQLOutputValue | undefined): number | null {
  return v === null || v === undefined ? null : num(v);
}

/** Reads a text column. */
export function text(v: SQLOutputValue | undefined): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint' || typeof v === 'number') return String(v);
  throw new TypeError(`expected a text column, got ${typeof v}`);
}

/** Reads a nullable text column. */
export function optText(v: SQLOutputValue | undefined): string | null {
  return v === null || v === undefined ? null : text(v);
}

/** Reads a BLOB column. */
export function blob(v: SQLOutputValue | undefined): Uint8Array {
  if (v instanceof Uint8Array) return v;
  throw new TypeError(`expected a blob column, got ${typeof v}`);
}

/** A SQLite connection with helpers. */
export class Db {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;

  /** Opens (or creates) the database at `path` (`':memory:'` for tests). */
  constructor(path: string) {
    if (path !== ':memory:' && path !== '') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA synchronous = NORMAL');
  }

  /** A cached prepared statement; `bigints: true` returns every INTEGER as `bigint`. */
  stmt(sql: string, bigints = false): StatementSync {
    const key = `${bigints ? 'B' : 'N'}:${sql}`;
    let s = this.cache.get(key);
    if (s === undefined) {
      s = this.raw.prepare(sql);
      if (bigints) s.setReadBigInts(true);
      this.cache.set(key, s);
    }
    return s;
  }

  /** Runs a statement, returning `{ changes, lastInsertRowid }`. */
  run(sql: string, params: Params = []): { changes: number; lastInsertRowid: bigint } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: BigInt(r.lastInsertRowid) };
  }

  /** First row or `undefined`. */
  get(sql: string, params: Params = [], bigints = false): Row | undefined {
    return this.stmt(sql, bigints).get(...params) as Row | undefined;
  }

  /** All rows. */
  all(sql: string, params: Params = [], bigints = false): Row[] {
    return this.stmt(sql, bigints).all(...params) as Row[];
  }

  /** Runs `fn` inside a transaction (savepoint when nested). Rolls back on throw. */
  transaction<T>(fn: () => T): T {
    const name = `sp${this.depth}`;
    if (this.depth === 0) this.raw.exec('BEGIN IMMEDIATE');
    else this.raw.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      if (this.depth === 0) this.raw.exec('COMMIT');
      else this.raw.exec(`RELEASE ${name}`);
      return out;
    } catch (e) {
      this.depth--;
      if (this.depth === 0) this.raw.exec('ROLLBACK');
      else this.raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw e;
    }
  }

  /** `PRAGMA user_version`. */
  get userVersion(): number {
    const row = this.raw.prepare('PRAGMA user_version').get() as { user_version: number | bigint };
    return Number(row.user_version);
  }

  set userVersion(v: number) {
    this.raw.exec(`PRAGMA user_version = ${Math.trunc(v)}`);
  }

  /** Closes the connection. */
  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}
