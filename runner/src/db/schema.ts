/**
 * SQLite schema and forward-only migrations (tracked in `PRAGMA user_version`).
 *
 * Conventions (R8): uint256 / wei values are TEXT decimal strings; timestamps are ISO-8601 TEXT;
 * addresses and hashes are lowercase hex TEXT. Chain-derived tables are idempotent on
 * `(tx_hash, log_index)`; runner-local tables use integer ids.
 *
 * @module db/schema
 */
import type { Db } from './sqlite.js';

const MIGRATION_1 = `
CREATE TABLE indexer_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Every applied log, the idempotency guard of the indexer (R9).
CREATE TABLE chain_events (
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  event        TEXT    NOT NULL,
  token        TEXT,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE minds (
  token             TEXT PRIMARY KEY,
  creator           TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  symbol            TEXT    NOT NULL,
  metadata_uri      TEXT    NOT NULL,
  model_id          TEXT    NOT NULL,
  persona_hash      TEXT    NOT NULL,
  status            INTEGER NOT NULL DEFAULT 0,
  phase             INTEGER NOT NULL DEFAULT 0,
  real_eth_reserve  TEXT    NOT NULL DEFAULT '0',
  tokens_sold       TEXT    NOT NULL DEFAULT '0',
  price_wei         TEXT    NOT NULL,
  mcap_sort         REAL    NOT NULL DEFAULT 0,
  mind_balance      TEXT    NOT NULL DEFAULT '0',
  pool              TEXT,
  position_id       TEXT,
  graduator         TEXT,
  created_block     INTEGER NOT NULL,
  created_log_index INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL,
  activity_at       TEXT    NOT NULL,
  last_trade_at     TEXT,
  last_tick_at      TEXT,
  current_url       TEXT,
  last_frame_at     TEXT,
  meta_status       TEXT    NOT NULL DEFAULT 'pending',
  meta_image        TEXT,
  meta_description  TEXT,
  meta_persona      TEXT,
  meta_links        TEXT,
  meta_error        TEXT,
  meta_resolved_at  TEXT,
  cooling_until     TEXT,
  failed_ticks      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX minds_by_created  ON minds (created_block DESC, created_log_index DESC);
CREATE INDEX minds_by_mcap     ON minds (mcap_sort DESC);
CREATE INDEX minds_by_activity ON minds (activity_at DESC);

CREATE TABLE trades (
  tx_hash          TEXT    NOT NULL,
  log_index        INTEGER NOT NULL,
  block_number     INTEGER NOT NULL,
  timestamp        TEXT    NOT NULL,
  token            TEXT    NOT NULL,
  trader           TEXT    NOT NULL,
  is_buy           INTEGER NOT NULL,
  eth_amount       TEXT    NOT NULL,
  token_amount     TEXT    NOT NULL,
  fee              TEXT    NOT NULL,
  real_eth_reserve TEXT    NOT NULL,
  tokens_sold      TEXT    NOT NULL,
  price_wei        TEXT    NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX trades_by_token ON trades (token, block_number DESC, log_index DESC);
CREATE INDEX trades_by_time  ON trades (timestamp);

CREATE TABLE fee_accruals (
  tx_hash         TEXT    NOT NULL,
  log_index       INTEGER NOT NULL,
  block_number    INTEGER NOT NULL,
  token           TEXT    NOT NULL,
  mind_amount     TEXT    NOT NULL,
  protocol_amount TEXT    NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE fundings (
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp    TEXT    NOT NULL,
  token        TEXT    NOT NULL,
  from_addr    TEXT    NOT NULL,
  amount       TEXT    NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE draws (
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp    TEXT    NOT NULL,
  token        TEXT    NOT NULL,
  amount       TEXT    NOT NULL,
  receipt_hash TEXT    NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX draws_by_token ON draws (token, block_number DESC);

CREATE TABLE onchain_anchors (
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  token        TEXT    NOT NULL,
  seq          INTEGER NOT NULL,
  content_hash TEXT    NOT NULL,
  uri          TEXT    NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE harvests (
  tx_hash       TEXT    NOT NULL,
  log_index     INTEGER NOT NULL,
  block_number  INTEGER NOT NULL,
  token         TEXT    NOT NULL,
  eth_out       TEXT    NOT NULL,
  tokens_burned TEXT    NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

-- ---------------------------------------------------------------- runner-local
CREATE TABLE memories (
  id           INTEGER PRIMARY KEY,
  token        TEXT    NOT NULL,
  seq          INTEGER NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('note', 'finding')),
  content      TEXT    NOT NULL,
  url          TEXT,
  created_at   TEXT    NOT NULL,
  content_hash TEXT    NOT NULL,
  tick_id      INTEGER,
  batch_id     INTEGER,
  UNIQUE (token, seq)
);

CREATE TABLE memory_batches (
  id           INTEGER PRIMARY KEY,
  token        TEXT    NOT NULL,
  from_seq     INTEGER NOT NULL,
  to_seq       INTEGER NOT NULL,
  content_hash TEXT    NOT NULL,
  uri          TEXT    NOT NULL,
  status       TEXT    NOT NULL,
  tx_hash      TEXT,
  error        TEXT,
  created_at   TEXT    NOT NULL,
  UNIQUE (token, from_seq)
);

CREATE TABLE ticks (
  id              INTEGER PRIMARY KEY,
  token           TEXT    NOT NULL,
  started_at      TEXT    NOT NULL,
  finished_at     TEXT,
  requested_model TEXT    NOT NULL,
  served_model    TEXT,
  iterations      INTEGER NOT NULL DEFAULT 0,
  cost_usd_micro  INTEGER NOT NULL DEFAULT 0,
  stop_reason     TEXT,
  status          TEXT    NOT NULL DEFAULT 'running',
  error           TEXT,
  summary         TEXT
);
CREATE INDEX ticks_by_token ON ticks (token, id DESC);

CREATE TABLE thoughts (
  id         INTEGER PRIMARY KEY,
  token      TEXT    NOT NULL,
  tick_id    INTEGER NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('aloud', 'summary')),
  text       TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE INDEX thoughts_by_token ON thoughts (token, id DESC);

CREATE TABLE compute_ledger (
  id                 INTEGER PRIMARY KEY,
  token              TEXT    NOT NULL,
  tick_id            INTEGER NOT NULL,
  model              TEXT    NOT NULL,
  input_tokens       INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_usd_micro     INTEGER NOT NULL,
  created_at         TEXT    NOT NULL,
  receipt_id         INTEGER,
  UNIQUE (tick_id, model)
);
CREATE INDEX ledger_by_token ON compute_ledger (token, tick_id DESC);

CREATE TABLE receipts (
  id             INTEGER PRIMARY KEY,
  token          TEXT    NOT NULL,
  receipt_hash   TEXT    NOT NULL UNIQUE,
  receipt_json   TEXT    NOT NULL,
  amount_wei     TEXT    NOT NULL,
  cost_usd_micro INTEGER NOT NULL,
  status         TEXT    NOT NULL,
  tx_hash        TEXT,
  error          TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX receipts_by_token ON receipts (token, id DESC);

CREATE TABLE metadata (
  hash         TEXT PRIMARY KEY,
  json         TEXT NOT NULL,
  persona_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
`;

const FTS = `CREATE VIRTUAL TABLE memories_fts USING fts5(content, url, tokenize = 'unicode61');`;

/** Ordered migrations; index + 1 is the resulting `user_version`. */
const MIGRATIONS: readonly ((db: Db) => void)[] = [
  (db) => {
    db.exec(MIGRATION_1);
    try {
      db.exec(FTS);
    } catch {
      // SQLite built without FTS5: memory recall falls back to LIKE.
    }
  },
];

/** Latest schema version. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Applies every migration above the database's `user_version`, each in its own transaction. */
export function migrate(db: Db): void {
  const current = db.userVersion;
  if (current > SCHEMA_VERSION) {
    throw new Error(`database schema version ${current} is newer than this runner (${SCHEMA_VERSION})`);
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v] as (db: Db) => void;
    db.transaction(() => {
      step(db);
      db.setUserVersion(v + 1);
    });
  }
}
