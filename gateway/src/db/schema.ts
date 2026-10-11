/**
 * Schema migrations (SPEC §5.2), applied in order and tracked with `PRAGMA user_version`.
 * Monetary columns are INTEGER µUSD; token amounts and `priceE18` are decimal TEXT.
 *
 * @module db/schema
 */
import type { Db } from './sqlite.js';

/** Ordered migrations; `user_version` equals the number applied. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE workspaces (
    owner TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    plan_until INTEGER,
    display_name TEXT
  );
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(owner),
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_used_at INTEGER
  );
  CREATE INDEX api_keys_workspace ON api_keys(workspace);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(owner),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE siwe_nonces (
    nonce TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace TEXT NOT NULL REFERENCES workspaces(owner),
    kind TEXT NOT NULL CHECK (kind IN ('credit','debit','adjustment','upgrade')),
    amount_micro INTEGER NOT NULL,
    ref_type TEXT,
    ref_id TEXT,
    memo TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ledger_workspace ON ledger(workspace);
  CREATE UNIQUE INDEX ledger_ref ON ledger(ref_type, ref_id) WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL;
  CREATE TABLE credit_events (
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('purchase','draw')),
    receipt_id INTEGER NOT NULL,
    workspace TEXT NOT NULL,
    payer TEXT,
    token_amount TEXT NOT NULL,
    usd_micro INTEGER NOT NULL,
    price_e18 TEXT NOT NULL,
    budget_id INTEGER,
    receipt_hash TEXT,
    block_number INTEGER NOT NULL,
    block_hash TEXT NOT NULL,
    block_time INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
  );
  CREATE INDEX credit_events_workspace ON credit_events(workspace, block_number);
  CREATE INDEX credit_events_block ON credit_events(block_number);
  CREATE TABLE reservations (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    amount_micro INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX reservations_workspace ON reservations(workspace);
  CREATE TABLE usage (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    api_key_id TEXT,
    endpoint TEXT NOT NULL,
    requested_model TEXT NOT NULL,
    served_model TEXT,
    provider TEXT,
    tier TEXT,
    paid_by TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    upstream_cost_micro INTEGER NOT NULL DEFAULT 0,
    charged_micro INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    http_status INTEGER NOT NULL,
    error_code TEXT,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    route_reasons TEXT NOT NULL DEFAULT '[]',
    stream INTEGER NOT NULL DEFAULT 0,
    difficulty REAL,
    draw_id INTEGER,
    price_json TEXT,
    markup_bps INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX usage_workspace_created ON usage(workspace, created_at);
  CREATE INDEX usage_unsettled ON usage(workspace, created_at) WHERE draw_id IS NULL AND paid_by = 'credit' AND charged_micro > 0;
  CREATE TABLE provider_keys (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL REFERENCES workspaces(owner),
    provider TEXT NOT NULL,
    ciphertext BLOB NOT NULL,
    iv BLOB NOT NULL,
    tag BLOB NOT NULL,
    last4 TEXT NOT NULL,
    base_url TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (workspace, provider)
  );
  CREATE TABLE budgets (
    budget_id INTEGER PRIMARY KEY,
    owner TEXT NOT NULL,
    workspace TEXT NOT NULL,
    cap TEXT NOT NULL,
    drawn TEXT NOT NULL DEFAULT '0',
    deadline INTEGER NOT NULL,
    closed INTEGER NOT NULL DEFAULT 0,
    headroom_tokens TEXT NOT NULL DEFAULT '0',
    headroom_micro INTEGER NOT NULL DEFAULT 0,
    headroom_checked_at INTEGER,
    stalled_reason TEXT,
    opened_block INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX budgets_workspace ON budgets(workspace);
  CREATE TABLE budget_draws (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    budget_id INTEGER NOT NULL,
    workspace TEXT NOT NULL,
    token_amount TEXT NOT NULL,
    usd_micro INTEGER NOT NULL,
    receipt_hash TEXT NOT NULL UNIQUE,
    usage_ids TEXT NOT NULL,
    batch_json TEXT NOT NULL,
    tx_hash TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','sent','confirmed','failed')),
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX budget_draws_budget ON budget_draws(budget_id);
  CREATE TABLE upgrades (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('pro','warm')),
    quantity INTEGER NOT NULL,
    amount_micro INTEGER NOT NULL,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX upgrades_workspace ON upgrades(workspace, created_at);
  CREATE TABLE provider_health (
    provider TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    opened_at INTEGER,
    open_for_ms INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE indexer_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE price_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    price_e18 TEXT NOT NULL,
    source TEXT NOT NULL,
    tx_hash TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE rate_limits (
    key_id TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE INDEX siwe_nonces_expires ON siwe_nonces(expires_at);
  `,
];

/** Applies pending migrations. Idempotent; safe to call from the CLI while the gateway runs. */
export function migrate(db: Db): { from: number; to: number } {
  const from = db.userVersion;
  if (from > MIGRATIONS.length) {
    throw new Error(`database schema version ${from} is newer than this gateway supports (${MIGRATIONS.length})`);
  }
  for (let v = from; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.raw.exec(MIGRATIONS[v] as string);
      db.userVersion = v + 1;
    });
  }
  return { from, to: MIGRATIONS.length };
}
