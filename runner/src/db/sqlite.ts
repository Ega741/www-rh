/**
 * SQLite access via the built-in `node:sqlite` (R8): WAL journal, foreign keys, busy timeout,
 * migrations on open, and a re-entrant transaction helper. A single runner process owns the file.
 *
 * @module db/sqlite
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { migrate } from './schema.js';

/** Values that can be bound to a statement parameter. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** Thin wrapper over `DatabaseSync` with a statement cache and transactions. */
export class Db {
  readonly #db: DatabaseSync;
  readonly #cache = new Map<string, StatementSync>();
  #txDepth = 0;
  /** Whether the FTS5 memory index exists (falls back to `LIKE` search otherwise). */
  readonly hasFts: boolean;

  private constructor(db: DatabaseSync, schemaVersion?: number) {
    this.#db = db;
    migrate(this, schemaVersion);
    this.hasFts = this.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'memories_fts'")?.n === 1;
  }

  /**
   * Opens (creating if needed) the database at `path`; `':memory:'` gives a private in-memory DB.
   * Applies pragmas and pending migrations (`opts.schemaVersion` stops at an older version: tests of
   * the migrations themselves).
   */
  static open(path: string, opts: { schemaVersion?: number } = {}): Db {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA synchronous = NORMAL');
    raw.exec('PRAGMA foreign_keys = ON');
    return new Db(raw, opts.schemaVersion);
  }

  /** Executes one or more SQL statements without parameters. */
  exec(sql: string): void {
    this.#db.exec(sql);
  }

  #stmt(sql: string): StatementSync {
    let stmt = this.#cache.get(sql);
    if (stmt === undefined) {
      stmt = this.#db.prepare(sql);
      this.#cache.set(sql, stmt);
    }
    return stmt;
  }

  /** Runs a write statement; returns the number of changed rows and the last rowid. */
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.#stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Returns the first row, or `undefined`. */
  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#stmt(sql).get(...params) as T | undefined;
  }

  /** Returns all rows. */
  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.#stmt(sql).all(...params) as T[];
  }

  /**
   * Runs `fn` inside a transaction (`BEGIN IMMEDIATE … COMMIT`, rolled back if it throws).
   * Nested calls join the outer transaction.
   */
  transaction<T>(fn: () => T): T {
    if (this.#txDepth > 0) {
      this.#txDepth++;
      try {
        return fn();
      } finally {
        this.#txDepth--;
      }
    }
    this.#db.exec('BEGIN IMMEDIATE');
    this.#txDepth = 1;
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    } finally {
      this.#txDepth = 0;
    }
  }

  /** `PRAGMA user_version` (schema version). */
  get userVersion(): number {
    return Number(this.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
  }

  /** Sets `PRAGMA user_version`. */
  setUserVersion(version: number): void {
    this.#db.exec(`PRAGMA user_version = ${Math.trunc(version)}`);
  }

  /** Closes the database (idempotent). */
  close(): void {
    if (!this.#db.isOpen) return;
    this.#cache.clear();
    this.#db.close();
  }
}
