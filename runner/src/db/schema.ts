/**
 * SQLite schema (`docs/SPEC.md` §4.1 `db/`) applied idempotently and tracked with
 * `PRAGMA user_version`.
 *
 * Conventions: uint256 / wei / token values are TEXT decimal strings (with a REAL copy only where a
 * list is ordered by such a value); timestamps are INTEGER unix milliseconds; hashes and
 * addresses are lowercase hex TEXT. Chain-derived rows are idempotent on `(tx_hash, log_index)`.
 *
 * @module db/schema
 */
import type { Db } from './sqlite.js';

const SCHEMA_V1 = `
CREATE TABLE indexer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- every applied log: the indexer's idempotency guard
CREATE TABLE chain_events (
  tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL,
  event TEXT NOT NULL, token TEXT,
  PRIMARY KEY (tx_hash, log_index)
);

-- block timestamp cache (unix seconds)
CREATE TABLE blocks (number INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL);

CREATE TABLE minds (
  token TEXT PRIMARY KEY,
  creator TEXT NOT NULL,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  metadata_uri TEXT NOT NULL,
  model_id TEXT NOT NULL,
  persona_hash TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 0,
  phase INTEGER NOT NULL DEFAULT 0,
  real_eth_reserve TEXT NOT NULL DEFAULT '0',
  tokens_sold TEXT NOT NULL DEFAULT '0',
  price_wei TEXT NOT NULL,
  mcap_sort REAL NOT NULL DEFAULT 0,
  mind_balance TEXT NOT NULL DEFAULT '0',
  pool TEXT,
  position_id TEXT,
  created_block INTEGER NOT NULL,
  created_log_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_tick_at INTEGER,
  last_tick_ended_at INTEGER,
  current_url TEXT,
  last_frame_at INTEGER,
  meta_status TEXT NOT NULL DEFAULT 'pending',
  meta_image TEXT,
  meta_description TEXT,
  meta_persona TEXT,
  meta_persona_verified INTEGER NOT NULL DEFAULT 0,
  meta_links TEXT,
  meta_resolved_at INTEGER,
  cooling_until INTEGER,
  failed_ticks INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX minds_by_created ON minds (created_at DESC, token);
CREATE INDEX minds_by_mcap ON minds (mcap_sort DESC);

CREATE TABLE trades (
  tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  token TEXT NOT NULL, trader TEXT NOT NULL, is_buy INTEGER NOT NULL,
  eth_amount TEXT NOT NULL, token_amount TEXT NOT NULL, fee TEXT NOT NULL,
  real_eth_reserve TEXT NOT NULL, tokens_sold TEXT NOT NULL, price_wei TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX trades_by_token ON trades (token, block_number DESC, log_index DESC);
CREATE INDEX trades_by_time ON trades (timestamp);

CREATE TABLE fee_accruals (
  tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL,
  token TEXT NOT NULL, mind_amount TEXT NOT NULL, protocol_amount TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE fundings (
  tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL, timestamp INTEGER NOT NULL,
  token TEXT NOT NULL, from_addr TEXT NOT NULL, amount TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE draws (
  tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL, timestamp INTEGER NOT NULL,
  token TEXT NOT NULL, amount TEXT NOT NULL, receipt_hash TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX draws_by_token ON draws (token, block_number DESC);
CREATE INDEX draws_by_receipt ON draws (receipt_hash);

CREATE TABLE harvests (
  tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL,
  token TEXT NOT NULL, eth_out TEXT NOT NULL, tokens_burned TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

-- indexed MemoryAnchored logs
CREATE TABLE anchor_logs (
  tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL,
  token TEXT NOT NULL, seq INTEGER NOT NULL, content_hash TEXT NOT NULL, uri TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX anchor_logs_by_seq ON anchor_logs (token, seq);

-- ------------------------------------------------------------------ runner-local
CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'finding')),
  content TEXT NOT NULL,
  url TEXT,
  created_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  tick_id INTEGER,
  anchor_id INTEGER,
  UNIQUE (token, seq)
);

-- local anchor batches (pending / dry_run / confirmed / failed)
CREATE TABLE anchors (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  uri TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX anchors_by_token ON anchors (token, from_seq);

CREATE TABLE ticks (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  requested_model TEXT NOT NULL,
  served_model TEXT,
  iterations INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_micro INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  receipt_id INTEGER
);
CREATE INDEX ticks_by_token ON ticks (token, id DESC);

CREATE TABLE thoughts (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  tick_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('aloud', 'summary')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX thoughts_by_token ON thoughts (token, id DESC);

CREATE TABLE receipts (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX receipts_by_token ON receipts (token, id DESC);

CREATE TABLE metadata (
  hash TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  persona_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

const FTS = `CREATE VIRTUAL TABLE memories_fts USING fts5(content, url, content = 'memories', content_rowid = 'id');`;

/**
 * v2 — draw receipt lifecycle (pending / unknown / confirmed / failed), indexer block hashes.
 *
 * - `receipts.tx_nonce` / `raw_tx`: the signed transaction, persisted BEFORE it is broadcast, so a
 *   receipt whose send outcome is unknown can be resolved by hash and nonce (and re-broadcast with
 *   the exact same bytes);
 * - `receipts.nonce_floor` / `check_block` / `check_at`: two-phase proof that a transaction can no
 *   longer be mined (operator nonce consumed by another transaction, indexer past that point);
 * - receipts left `pending` without a transaction hash by older runners may have been broadcast:
 *   they become `unknown` (resolved by the reconciler through the operator nonce).
 */
const SCHEMA_V2 = `
ALTER TABLE receipts ADD COLUMN tx_nonce INTEGER;
ALTER TABLE receipts ADD COLUMN raw_tx TEXT;
ALTER TABLE receipts ADD COLUMN nonce_floor INTEGER;
ALTER TABLE receipts ADD COLUMN check_block INTEGER;
ALTER TABLE receipts ADD COLUMN check_at INTEGER;
ALTER TABLE receipts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE receipts ADD COLUMN broadcast_at INTEGER;
UPDATE receipts SET status = 'unknown' WHERE status = 'pending' AND tx_hash IS NULL;
CREATE INDEX receipts_by_status ON receipts (status, id);
CREATE INDEX ticks_by_receipt ON ticks (receipt_id);

-- hashes of indexed range ends (parent-hash reorg detection)
CREATE TABLE block_hashes (number INTEGER PRIMARY KEY, hash TEXT NOT NULL);
`;

/**
 * v3 — Pons mode (`docs/SPEC.md` §9): the venue of every mind and the Pons launch state of minds
 * registered by `PonsMindRegistry`.
 *
 * - `pons_minds.claimable`: Σ escrow `Credited` − Σ `Claimed` for the mind account (= the escrow
 *   balance, exact because every change of it is evented);
 * - `quote_reserve` / `token_reserve`: tradeable curve reserves after the last indexed trade (the
 *   fallback when the per-block `getReserves()` read is unavailable);
 * - `pending_fee` / `pending_tax`: Σ curve fee / creator tax since the last `FeesSwept` (what a
 *   sweep inside `harvest` would credit to the account);
 * - `pool_id`: from the hook's `PoolRegistered`; `registry_pool_id`: from the registry's `PoolIdSet`.
 */
const SCHEMA_V3 = `
ALTER TABLE minds ADD COLUMN venue TEXT NOT NULL DEFAULT 'curve';

CREATE TABLE pons_minds (
  token TEXT PRIMARY KEY,
  curve TEXT NOT NULL,
  account TEXT NOT NULL,
  deployer TEXT,
  launch_config_id INTEGER,
  fee_bps INTEGER,
  creator_tax_bps INTEGER,
  launched_here INTEGER NOT NULL DEFAULT 0,
  adopted INTEGER NOT NULL DEFAULT 0,
  fee_recipient TEXT,
  pool_id TEXT,
  registry_pool_id TEXT,
  claimable TEXT NOT NULL DEFAULT '0',
  phantom_quote TEXT,
  supply TEXT,
  graduation_threshold TEXT,
  quote_reserve TEXT,
  token_reserve TEXT,
  pending_fee TEXT NOT NULL DEFAULT '0',
  pending_tax TEXT NOT NULL DEFAULT '0',
  launch_phase INTEGER NOT NULL DEFAULT 0,
  swept_at INTEGER,
  last_harvest_at INTEGER
);
CREATE INDEX pons_minds_by_curve ON pons_minds (curve);
CREATE INDEX pons_minds_by_account ON pons_minds (account);
`;

/** Ordered migrations; index + 1 is the resulting `user_version`. */
const MIGRATIONS: readonly ((db: Db) => void)[] = [
  (db) => {
    db.exec(SCHEMA_V1);
    try {
      db.exec(FTS);
    } catch {
      // SQLite built without FTS5: recall falls back to LIKE.
    }
  },
  (db) => db.exec(SCHEMA_V2),
  (db) => db.exec(SCHEMA_V3),
];

/** Latest schema version. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Applies every migration above the database's `user_version` (up to `target`), each in one transaction. */
export function migrate(db: Db, target: number = SCHEMA_VERSION): void {
  const current = db.userVersion;
  if (current > SCHEMA_VERSION) throw new Error(`database schema version ${current} is newer than this runner (${SCHEMA_VERSION})`);
  for (let v = current; v < Math.min(target, SCHEMA_VERSION); v++) {
    const step = MIGRATIONS[v] as (db: Db) => void;
    db.transaction(() => {
      step(db);
      db.setUserVersion(v + 1);
    });
  }
}
