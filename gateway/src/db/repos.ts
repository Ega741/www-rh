/**
 * Repositories over the SPEC §5.2 tables. Every method is synchronous (node:sqlite) and uses
 * prepared statements; monetary columns are read as `bigint`. Timestamps are unix milliseconds
 * except chain mirrors (`credit_events.block_time`) and `price_points.observed_at`, which are seconds.
 * Workspaces, owners, token accounts and signatures are base58 and stored verbatim (case-sensitive).
 *
 * @module db/repos
 */
import type { PriceSource } from '@beagle/shared/api';
import type { Plan, Provider, Tier } from '@beagle/shared/models';
import { big, blob, num, optNum, optText, text, type Db, type Row } from './sqlite.js';

// ---------------------------------------------------------------------------------------------
// Row types

/** `workspaces` row. */
export interface WorkspaceRow {
  owner: string;
  createdAt: number;
  plan: Plan;
  planUntil: number | null;
  displayName: string | null;
}

/** `api_keys` row. */
export interface ApiKeyRow {
  id: string;
  workspace: string;
  name: string;
  prefix: string;
  hash: string;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

/** `sessions` row. */
export interface SessionRow {
  id: string;
  workspace: string;
  createdAt: number;
  expiresAt: number;
}

/** `ledger` row. */
export interface LedgerRow {
  id: number;
  workspace: string;
  kind: 'credit' | 'debit' | 'adjustment' | 'upgrade';
  amountMicro: bigint;
  refType: string | null;
  refId: string | null;
  memo: string | null;
  createdAt: number;
}

/** `credit_events` row: one indexed burn instruction (SPEC §3.2, §5.4). */
export interface CreditEventRow {
  signature: string;
  ixIndex: number;
  kind: 'purchase' | 'draw';
  workspace: string;
  /** Owner of the burned token account (null when unresolvable). */
  payer: string | null;
  tokenAccount: string;
  /** The burn authority (owner or delegate). */
  authority: string | null;
  tokenAmount: bigint;
  usdMicro: bigint;
  priceE18: bigint;
  pricePointId: number | null;
  priceStale: boolean;
  memo: string | null;
  receiptHash: string | null;
  slot: number;
  /** Unix seconds, or null when the RPC reported none. */
  blockTime: number | null;
  createdAt: number;
}

/** `price_points` row. */
export interface PricePointRow {
  id: number;
  priceE18: bigint;
  source: PriceSource;
  /** Unix seconds. */
  observedAt: number;
  createdAt: number;
}

/** `reservations` row. */
export interface ReservationRow {
  id: string;
  workspace: string;
  amountMicro: bigint;
  createdAt: number;
  expiresAt: number;
}

/** `usage` row. */
export interface UsageRow {
  id: string;
  workspace: string;
  apiKeyId: string | null;
  endpoint: string;
  requestedModel: string;
  servedModel: string | null;
  provider: Provider | null;
  tier: Tier | null;
  paidBy: 'credit' | 'byok' | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  upstreamCostMicro: bigint;
  chargedMicro: bigint;
  status: 'ok' | 'error';
  httpStatus: number;
  errorCode: string | null;
  latencyMs: number;
  routeReasons: string[];
  stream: boolean;
  difficulty: number | null;
  drawId: number | null;
  /** Catalog price at request time (JSON of `ModelPrice`), or null. */
  priceJson: string | null;
  markupBps: number;
  createdAt: number;
}

/** `provider_keys` row (ciphertext stays encrypted). */
export interface ProviderKeyRow {
  id: string;
  workspace: string;
  provider: Provider;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  last4: string;
  baseUrl: string | null;
  lastError: string | null;
  createdAt: number;
}

/** Why a budget cannot back credit right now (SPEC §5.4). */
export type BudgetStalledReason = 'price' | 'revoked' | 'exhausted' | 'draw_failed';

/** `budgets` row: one SPL token account delegated to the operator (SPEC §3.4). */
export interface BudgetRow {
  tokenAccount: string;
  owner: string;
  workspace: string;
  delegate: string | null;
  /** `delegatedAmount` (raw token units). */
  cap: bigint;
  /** The account's token amount (raw). */
  balance: bigint;
  headroomTokens: bigint;
  headroomMicro: bigint;
  headroomCheckedAt: number | null;
  stalledReason: BudgetStalledReason | null;
  closed: boolean;
  registeredAt: number | null;
  lastSeenSlot: number | null;
  updatedAt: number;
}

/** `budget_draws` row. */
export interface BudgetDrawRow {
  id: number;
  tokenAccount: string;
  workspace: string;
  tokenAmount: bigint;
  usdMicro: bigint;
  receiptHash: string;
  usageIds: string[];
  /** The canonical `DrawBatch` as JSON (wire form). */
  batchJson: string;
  signature: string | null;
  lastValidBlockHeight: number | null;
  status: 'pending' | 'sent' | 'confirmed' | 'failed';
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** `upgrades` row. */
export interface UpgradeRow {
  id: string;
  workspace: string;
  kind: 'pro' | 'warm';
  quantity: number;
  amountMicro: bigint;
  startsAt: number;
  endsAt: number;
  createdAt: number;
}

/** `provider_health` row. */
export interface ProviderHealthRow {
  provider: Provider;
  state: 'ok' | 'degraded' | 'down';
  failures: number;
  openedAt: number | null;
  openForMs: number;
  updatedAt: number;
}

/** Credit position of a workspace (SPEC §5.2 balance definitions). */
export interface BalanceSnapshot {
  balance: bigint;
  reserved: bigint;
  budgetHeadroom: bigint;
  /** `balance − reserved + budgetHeadroom`. */
  available: bigint;
}

// ---------------------------------------------------------------------------------------------
// Mappers

function parseJsonArray(v: string): string[] {
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const mapWorkspace = (r: Row): WorkspaceRow => ({
  owner: text(r['owner']),
  createdAt: num(r['created_at']),
  plan: text(r['plan']) === 'pro' ? 'pro' : 'free',
  planUntil: optNum(r['plan_until']),
  displayName: optText(r['display_name']),
});

const mapApiKey = (r: Row): ApiKeyRow => ({
  id: text(r['id']),
  workspace: text(r['workspace']),
  name: text(r['name']),
  prefix: text(r['prefix']),
  hash: text(r['hash']),
  createdAt: num(r['created_at']),
  revokedAt: optNum(r['revoked_at']),
  lastUsedAt: optNum(r['last_used_at']),
});

const mapSession = (r: Row): SessionRow => ({
  id: text(r['id']),
  workspace: text(r['workspace']),
  createdAt: num(r['created_at']),
  expiresAt: num(r['expires_at']),
});

const mapLedger = (r: Row): LedgerRow => ({
  id: num(r['id']),
  workspace: text(r['workspace']),
  kind: text(r['kind']) as LedgerRow['kind'],
  amountMicro: big(r['amount_micro']),
  refType: optText(r['ref_type']),
  refId: optText(r['ref_id']),
  memo: optText(r['memo']),
  createdAt: num(r['created_at']),
});

const mapCreditEvent = (r: Row): CreditEventRow => ({
  signature: text(r['signature']),
  ixIndex: num(r['ix_index']),
  kind: text(r['kind']) as CreditEventRow['kind'],
  workspace: text(r['workspace']),
  payer: optText(r['payer']),
  tokenAccount: text(r['token_account']),
  authority: optText(r['authority']),
  tokenAmount: big(r['token_amount']),
  usdMicro: big(r['usd_micro']),
  priceE18: big(r['price_e18']),
  pricePointId: optNum(r['price_point_id']),
  priceStale: num(r['price_stale']) === 1,
  memo: optText(r['memo']),
  receiptHash: optText(r['receipt_hash']),
  slot: num(r['slot']),
  blockTime: optNum(r['block_time']),
  createdAt: num(r['created_at']),
});

const mapPricePoint = (r: Row): PricePointRow => ({
  id: num(r['id']),
  priceE18: big(r['price_e18']),
  source: text(r['source']) as PriceSource,
  observedAt: num(r['observed_at']),
  createdAt: num(r['created_at']),
});

const mapReservation = (r: Row): ReservationRow => ({
  id: text(r['id']),
  workspace: text(r['workspace']),
  amountMicro: big(r['amount_micro']),
  createdAt: num(r['created_at']),
  expiresAt: num(r['expires_at']),
});

const mapUsage = (r: Row): UsageRow => ({
  id: text(r['id']),
  workspace: text(r['workspace']),
  apiKeyId: optText(r['api_key_id']),
  endpoint: text(r['endpoint']),
  requestedModel: text(r['requested_model']),
  servedModel: optText(r['served_model']),
  provider: optText(r['provider']) as Provider | null,
  tier: optText(r['tier']) as Tier | null,
  paidBy: optText(r['paid_by']) as UsageRow['paidBy'],
  inputTokens: num(r['input_tokens']),
  outputTokens: num(r['output_tokens']),
  cacheReadTokens: num(r['cache_read_tokens']),
  cacheWriteTokens: num(r['cache_write_tokens']),
  upstreamCostMicro: big(r['upstream_cost_micro']),
  chargedMicro: big(r['charged_micro']),
  status: text(r['status']) === 'error' ? 'error' : 'ok',
  httpStatus: num(r['http_status']),
  errorCode: optText(r['error_code']),
  latencyMs: num(r['latency_ms']),
  routeReasons: parseJsonArray(text(r['route_reasons'])),
  stream: num(r['stream']) === 1,
  difficulty: r['difficulty'] === null ? null : Number(r['difficulty']),
  drawId: optNum(r['draw_id']),
  priceJson: optText(r['price_json']),
  markupBps: num(r['markup_bps']),
  createdAt: num(r['created_at']),
});

const mapProviderKey = (r: Row): ProviderKeyRow => ({
  id: text(r['id']),
  workspace: text(r['workspace']),
  provider: text(r['provider']) as Provider,
  ciphertext: blob(r['ciphertext']),
  iv: blob(r['iv']),
  tag: blob(r['tag']),
  last4: text(r['last4']),
  baseUrl: optText(r['base_url']),
  lastError: optText(r['last_error']),
  createdAt: num(r['created_at']),
});

const mapBudget = (r: Row): BudgetRow => ({
  tokenAccount: text(r['token_account']),
  owner: text(r['owner']),
  workspace: text(r['workspace']),
  delegate: optText(r['delegate']),
  cap: big(r['cap']),
  balance: big(r['balance']),
  headroomTokens: big(r['headroom_tokens']),
  headroomMicro: big(r['headroom_micro']),
  headroomCheckedAt: optNum(r['headroom_checked_at']),
  stalledReason: optText(r['stalled_reason']) as BudgetRow['stalledReason'],
  closed: num(r['closed']) === 1,
  registeredAt: optNum(r['registered_at']),
  lastSeenSlot: optNum(r['last_seen_slot']),
  updatedAt: num(r['updated_at']),
});

const mapBudgetDraw = (r: Row): BudgetDrawRow => ({
  id: num(r['id']),
  tokenAccount: text(r['token_account']),
  workspace: text(r['workspace']),
  tokenAmount: big(r['token_amount']),
  usdMicro: big(r['usd_micro']),
  receiptHash: text(r['receipt_hash']),
  usageIds: parseJsonArray(text(r['usage_ids'])),
  batchJson: text(r['batch_json']),
  signature: optText(r['signature']),
  lastValidBlockHeight: optNum(r['last_valid_block_height']),
  status: text(r['status']) as BudgetDrawRow['status'],
  error: optText(r['error']),
  createdAt: num(r['created_at']),
  updatedAt: num(r['updated_at']),
});

const mapUpgrade = (r: Row): UpgradeRow => ({
  id: text(r['id']),
  workspace: text(r['workspace']),
  kind: text(r['kind']) as UpgradeRow['kind'],
  quantity: num(r['quantity']),
  amountMicro: big(r['amount_micro']),
  startsAt: num(r['starts_at']),
  endsAt: num(r['ends_at']),
  createdAt: num(r['created_at']),
});

const mapHealth = (r: Row): ProviderHealthRow => ({
  provider: text(r['provider']) as Provider,
  state: text(r['state']) as ProviderHealthRow['state'],
  failures: num(r['failures']),
  openedAt: optNum(r['opened_at']),
  openForMs: num(r['open_for_ms']),
  updatedAt: num(r['updated_at']),
});

/** Normalizes a workspace id: base58 is case-sensitive, so only surrounding whitespace is dropped (SPEC §1). */
export function normalizeWorkspace(address: string): string {
  return address.trim();
}

// ---------------------------------------------------------------------------------------------
// Repositories

/** `workspaces`. */
export class WorkspaceRepo {
  constructor(private readonly db: Db) {}

  /** Creates the workspace if missing; returns the row. */
  ensure(owner: string, now: number): WorkspaceRow {
    const ws = normalizeWorkspace(owner);
    this.db.run('INSERT OR IGNORE INTO workspaces(owner, created_at, plan) VALUES (?, ?, ?)', [ws, now, 'free']);
    return this.get(ws) as WorkspaceRow;
  }

  get(owner: string): WorkspaceRow | undefined {
    const r = this.db.get('SELECT * FROM workspaces WHERE owner = ?', [normalizeWorkspace(owner)]);
    return r === undefined ? undefined : mapWorkspace(r);
  }

  /** The effective plan after lazy expiry (SPEC §5.11). */
  effectivePlan(row: WorkspaceRow, now: number): { plan: Plan; planUntil: number | null } {
    if (row.plan === 'pro' && row.planUntil !== null && row.planUntil > now) return { plan: 'pro', planUntil: row.planUntil };
    return { plan: 'free', planUntil: row.planUntil !== null && row.planUntil > now ? row.planUntil : null };
  }

  setPlan(owner: string, plan: Plan, planUntil: number | null): void {
    this.db.run('UPDATE workspaces SET plan = ?, plan_until = ? WHERE owner = ?', [plan, planUntil, normalizeWorkspace(owner)]);
  }

  list(limit = 200): WorkspaceRow[] {
    return this.db.all('SELECT * FROM workspaces ORDER BY created_at DESC LIMIT ?', [limit]).map(mapWorkspace);
  }
}

/** `api_keys`. */
export class ApiKeyRepo {
  constructor(private readonly db: Db) {}

  insert(row: Omit<ApiKeyRow, 'revokedAt' | 'lastUsedAt'>): void {
    this.db.run('INSERT INTO api_keys(id, workspace, name, prefix, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      row.id,
      normalizeWorkspace(row.workspace),
      row.name,
      row.prefix,
      row.hash,
      row.createdAt,
    ]);
  }

  byHash(hash: string): ApiKeyRow | undefined {
    const r = this.db.get('SELECT * FROM api_keys WHERE hash = ?', [hash]);
    return r === undefined ? undefined : mapApiKey(r);
  }

  byId(id: string): ApiKeyRow | undefined {
    const r = this.db.get('SELECT * FROM api_keys WHERE id = ?', [id]);
    return r === undefined ? undefined : mapApiKey(r);
  }

  listByWorkspace(workspace: string): ApiKeyRow[] {
    return this.db
      .all('SELECT * FROM api_keys WHERE workspace = ? AND revoked_at IS NULL ORDER BY created_at DESC', [normalizeWorkspace(workspace)])
      .map(mapApiKey);
  }

  countByWorkspace(workspace: string): number {
    const r = this.db.get('SELECT COUNT(*) AS n FROM api_keys WHERE workspace = ? AND revoked_at IS NULL', [normalizeWorkspace(workspace)]);
    return r === undefined ? 0 : num(r['n']);
  }

  /** Revokes the key when it belongs to `workspace`; returns whether a row changed. */
  revoke(id: string, workspace: string, now: number): boolean {
    return (
      this.db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace = ? AND revoked_at IS NULL', [now, id, normalizeWorkspace(workspace)])
        .changes > 0
    );
  }

  touch(id: string, now: number): void {
    this.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now, id]);
  }
}

/** `sessions`. */
export class SessionRepo {
  constructor(private readonly db: Db) {}

  insert(row: SessionRow): void {
    this.db.run('INSERT INTO sessions(id, workspace, created_at, expires_at) VALUES (?, ?, ?, ?)', [
      row.id,
      normalizeWorkspace(row.workspace),
      row.createdAt,
      row.expiresAt,
    ]);
  }

  get(id: string): SessionRow | undefined {
    const r = this.db.get('SELECT * FROM sessions WHERE id = ?', [id]);
    return r === undefined ? undefined : mapSession(r);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
  }

  purgeExpired(now: number): number {
    return this.db.run('DELETE FROM sessions WHERE expires_at <= ?', [now]).changes;
  }
}

/** `siws_nonces`. */
export class NonceRepo {
  constructor(private readonly db: Db) {}

  insert(nonce: string, now: number, expiresAt: number): void {
    this.db.run('INSERT INTO siws_nonces(nonce, created_at, expires_at) VALUES (?, ?, ?)', [nonce, now, expiresAt]);
  }

  /** `true` when the nonce is known and unexpired (not consumed). */
  peek(nonce: string, now: number): boolean {
    return this.db.get('SELECT 1 AS x FROM siws_nonces WHERE nonce = ? AND expires_at > ?', [nonce, now]) !== undefined;
  }

  /** Consumes the nonce (single use); `false` when unknown or expired. */
  consume(nonce: string, now: number): boolean {
    return this.db.run('DELETE FROM siws_nonces WHERE nonce = ? AND expires_at > ?', [nonce, now]).changes > 0;
  }

  /** Deletes expired nonces (housekeeping; indexed on `expires_at`). */
  purgeExpired(now: number): number {
    return this.db.run('DELETE FROM siws_nonces WHERE expires_at <= ?', [now]).changes;
  }
}

/** `ledger` plus the balance definitions. */
export class LedgerRepo {
  constructor(private readonly db: Db) {}

  insert(row: Omit<LedgerRow, 'id'>): number {
    const r = this.db.run('INSERT INTO ledger(workspace, kind, amount_micro, ref_type, ref_id, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      normalizeWorkspace(row.workspace),
      row.kind,
      row.amountMicro,
      row.refType,
      row.refId,
      row.memo,
      row.createdAt,
    ]);
    return Number(r.lastInsertRowid);
  }

  hasRef(refType: string, refId: string): boolean {
    return this.db.get('SELECT 1 AS x FROM ledger WHERE ref_type = ? AND ref_id = ?', [refType, refId]) !== undefined;
  }

  balance(workspace: string): bigint {
    const r = this.db.get('SELECT COALESCE(SUM(amount_micro), 0) AS s FROM ledger WHERE workspace = ?', [normalizeWorkspace(workspace)], true);
    return r === undefined ? 0n : big(r['s']);
  }

  reserved(workspace: string, now: number): bigint {
    const r = this.db.get(
      'SELECT COALESCE(SUM(amount_micro), 0) AS s FROM reservations WHERE workspace = ? AND expires_at > ?',
      [normalizeWorkspace(workspace), now],
      true,
    );
    return r === undefined ? 0n : big(r['s']);
  }

  /** Σ `headroom_micro` over the open, non-stalled budgets of `workspace` (SPEC §5.2). */
  budgetHeadroom(workspace: string): bigint {
    const r = this.db.get(
      'SELECT COALESCE(SUM(headroom_micro), 0) AS s FROM budgets WHERE workspace = ? AND closed = 0 AND stalled_reason IS NULL',
      [normalizeWorkspace(workspace)],
      true,
    );
    return r === undefined ? 0n : big(r['s']);
  }

  snapshot(workspace: string, now: number): BalanceSnapshot {
    const balance = this.balance(workspace);
    const reserved = this.reserved(workspace, now);
    const budgetHeadroom = this.budgetHeadroom(workspace);
    return { balance, reserved, budgetHeadroom, available: balance - reserved + budgetHeadroom };
  }

  list(workspace: string, limit: number, before?: number): LedgerRow[] {
    const rows =
      before === undefined
        ? this.db.all('SELECT * FROM ledger WHERE workspace = ? ORDER BY created_at DESC, id DESC LIMIT ?', [normalizeWorkspace(workspace), limit], true)
        : this.db.all(
            'SELECT * FROM ledger WHERE workspace = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?',
            [normalizeWorkspace(workspace), before, limit],
            true,
          );
    return rows.map(mapLedger);
  }

  /** Workspaces whose `balance − reserved` is negative (drawer candidates). */
  workspacesInDeficit(now: number): { workspace: string; deficit: bigint }[] {
    const rows = this.db.all(
      `SELECT l.workspace AS workspace,
              COALESCE(SUM(l.amount_micro), 0) - COALESCE((SELECT SUM(r.amount_micro) FROM reservations r WHERE r.workspace = l.workspace AND r.expires_at > ?), 0) AS net
       FROM ledger l GROUP BY l.workspace HAVING net < 0`,
      [now],
      true,
    );
    return rows.map((r) => ({ workspace: text(r['workspace']), deficit: -big(r['net']) }));
  }

  deleteByRefs(refType: string, refIds: readonly string[]): number {
    let n = 0;
    for (const id of refIds) n += this.db.run('DELETE FROM ledger WHERE ref_type = ? AND ref_id = ?', [refType, id]).changes;
    return n;
  }
}

/** `credit_events`. */
export class CreditEventRepo {
  constructor(private readonly db: Db) {}

  exists(signature: string, ixIndex: number): boolean {
    return this.db.get('SELECT 1 AS x FROM credit_events WHERE signature = ? AND ix_index = ?', [signature, ixIndex]) !== undefined;
  }

  get(signature: string, ixIndex: number): CreditEventRow | undefined {
    const r = this.db.get('SELECT * FROM credit_events WHERE signature = ? AND ix_index = ?', [signature, ixIndex], true);
    return r === undefined ? undefined : mapCreditEvent(r);
  }

  insert(row: CreditEventRow): void {
    this.db.run(
      `INSERT INTO credit_events(signature, ix_index, kind, workspace, payer, token_account, authority, token_amount, usd_micro, price_e18,
         price_point_id, price_stale, memo, receipt_hash, slot, block_time, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.signature,
        row.ixIndex,
        row.kind,
        normalizeWorkspace(row.workspace),
        row.payer,
        row.tokenAccount,
        row.authority,
        row.tokenAmount.toString(),
        row.usdMicro,
        row.priceE18.toString(),
        row.pricePointId,
        row.priceStale ? 1 : 0,
        row.memo,
        row.receiptHash,
        row.slot,
        row.blockTime,
        row.createdAt,
      ],
    );
  }

  /** Events of `workspace`, newest first, with a `created_at` cursor. */
  list(workspace: string, limit: number, before?: number): CreditEventRow[] {
    const rows =
      before === undefined
        ? this.db.all('SELECT * FROM credit_events WHERE workspace = ? ORDER BY created_at DESC, slot DESC, ix_index DESC LIMIT ?', [normalizeWorkspace(workspace), limit], true)
        : this.db.all(
            'SELECT * FROM credit_events WHERE workspace = ? AND created_at < ? ORDER BY created_at DESC, slot DESC, ix_index DESC LIMIT ?',
            [normalizeWorkspace(workspace), before, limit],
            true,
          );
    return rows.map(mapCreditEvent);
  }

  listBySignature(signature: string): CreditEventRow[] {
    return this.db.all('SELECT * FROM credit_events WHERE signature = ? ORDER BY ix_index ASC', [signature], true).map(mapCreditEvent);
  }

  /** Distinct signatures of events applied at or before `maxCreatedAt` with `slot ≥ minSlot`, newest first (finality sweep). */
  signaturesForSweep(minSlot: number, maxCreatedAt: number, limit: number): { signature: string; slot: number }[] {
    return this.db
      .all('SELECT signature, MAX(slot) AS slot FROM credit_events WHERE slot >= ? AND created_at <= ? GROUP BY signature ORDER BY slot DESC LIMIT ?', [minSlot, maxCreatedAt, limit])
      .map((r) => ({ signature: text(r['signature']), slot: num(r['slot']) }));
  }

  deleteBySignature(signature: string): number {
    return this.db.run('DELETE FROM credit_events WHERE signature = ?', [signature]).changes;
  }

  /** Unix seconds of the newest block time seen, or null. */
  lastBlockTime(): number | null {
    const r = this.db.get('SELECT MAX(block_time) AS t FROM credit_events');
    return r === undefined ? null : optNum(r['t']);
  }
}

/** `price_points`. */
export class PricePointRepo {
  constructor(private readonly db: Db) {}

  insert(row: Omit<PricePointRow, 'id'>): PricePointRow {
    const r = this.db.run('INSERT INTO price_points(price_e18, source, observed_at, created_at) VALUES (?, ?, ?, ?)', [
      row.priceE18.toString(),
      row.source,
      row.observedAt,
      row.createdAt,
    ]);
    return { ...row, id: Number(r.lastInsertRowid) };
  }

  latest(): PricePointRow | undefined {
    const r = this.db.get('SELECT * FROM price_points ORDER BY id DESC LIMIT 1');
    return r === undefined ? undefined : mapPricePoint(r);
  }

  get(id: number): PricePointRow | undefined {
    const r = this.db.get('SELECT * FROM price_points WHERE id = ?', [id]);
    return r === undefined ? undefined : mapPricePoint(r);
  }

  /** Newest first. */
  list(limit: number): PricePointRow[] {
    return this.db.all('SELECT * FROM price_points ORDER BY id DESC LIMIT ?', [limit]).map(mapPricePoint);
  }
}

/** `reservations`. */
export class ReservationRepo {
  constructor(private readonly db: Db) {}

  insert(row: ReservationRow): void {
    this.db.run('INSERT INTO reservations(id, workspace, amount_micro, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [
      row.id,
      normalizeWorkspace(row.workspace),
      row.amountMicro,
      row.createdAt,
      row.expiresAt,
    ]);
  }

  get(id: string): ReservationRow | undefined {
    const r = this.db.get('SELECT * FROM reservations WHERE id = ?', [id], true);
    return r === undefined ? undefined : mapReservation(r);
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM reservations WHERE id = ?', [id]).changes > 0;
  }

  purgeExpired(now: number): number {
    return this.db.run('DELETE FROM reservations WHERE expires_at <= ?', [now]).changes;
  }
}

/** Filters of {@link UsageRepo.list}. */
export interface UsageListFilter {
  limit: number;
  before?: number;
  model?: string;
  status?: 'ok' | 'error';
}

/** `usage`. */
export class UsageRepo {
  constructor(private readonly db: Db) {}

  insert(row: UsageRow): void {
    this.db.run(
      `INSERT INTO usage(id, workspace, api_key_id, endpoint, requested_model, served_model, provider, tier, paid_by, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, upstream_cost_micro, charged_micro, status, http_status, error_code, latency_ms, route_reasons, stream,
         difficulty, draw_id, price_json, markup_bps, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        normalizeWorkspace(row.workspace),
        row.apiKeyId,
        row.endpoint,
        row.requestedModel,
        row.servedModel,
        row.provider,
        row.tier,
        row.paidBy,
        row.inputTokens,
        row.outputTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
        row.upstreamCostMicro,
        row.chargedMicro,
        row.status,
        row.httpStatus,
        row.errorCode,
        row.latencyMs,
        JSON.stringify(row.routeReasons),
        row.stream ? 1 : 0,
        row.difficulty,
        row.drawId,
        row.priceJson,
        row.markupBps,
        row.createdAt,
      ],
    );
  }

  get(id: string): UsageRow | undefined {
    const r = this.db.get('SELECT * FROM usage WHERE id = ?', [id], true);
    return r === undefined ? undefined : mapUsage(r);
  }

  getForWorkspace(id: string, workspace: string): UsageRow | undefined {
    const r = this.db.get('SELECT * FROM usage WHERE id = ? AND workspace = ?', [id, normalizeWorkspace(workspace)], true);
    return r === undefined ? undefined : mapUsage(r);
  }

  list(workspace: string, f: UsageListFilter): UsageRow[] {
    const where = ['workspace = ?'];
    const params: (string | number)[] = [normalizeWorkspace(workspace)];
    if (f.before !== undefined) {
      where.push('created_at < ?');
      params.push(f.before);
    }
    if (f.model !== undefined) {
      where.push('(requested_model = ? OR served_model = ?)');
      params.push(f.model, f.model);
    }
    if (f.status !== undefined) {
      where.push('status = ?');
      params.push(f.status);
    }
    params.push(f.limit);
    return this.db.all(`SELECT * FROM usage WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, params, true).map(mapUsage);
  }

  /** Aggregates for `GET /api/usage/summary`. */
  summary(workspace: string, since: number): {
    requests: number;
    chargedMicro: bigint;
    upstreamCostMicro: bigint;
    inputTokens: number;
    outputTokens: number;
    byModel: { model: string; requests: number; chargedMicro: bigint }[];
    byDay: { day: string; requests: number; chargedMicro: bigint }[];
  } {
    const ws = normalizeWorkspace(workspace);
    const total = this.db.get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(charged_micro), 0) AS charged, COALESCE(SUM(upstream_cost_micro), 0) AS upstream,
              COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens), 0) AS inp, COALESCE(SUM(output_tokens), 0) AS outp
       FROM usage WHERE workspace = ? AND created_at >= ?`,
      [ws, since],
      true,
    ) as Row;
    const byModel = this.db
      .all(
        `SELECT COALESCE(served_model, requested_model) AS model, COUNT(*) AS n, COALESCE(SUM(charged_micro), 0) AS charged
         FROM usage WHERE workspace = ? AND created_at >= ? GROUP BY model ORDER BY charged DESC, n DESC`,
        [ws, since],
        true,
      )
      .map((r) => ({ model: text(r['model']), requests: num(r['n']), chargedMicro: big(r['charged']) }));
    const byDay = this.db
      .all(
        `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n, COALESCE(SUM(charged_micro), 0) AS charged
         FROM usage WHERE workspace = ? AND created_at >= ? GROUP BY day ORDER BY day ASC`,
        [ws, since],
        true,
      )
      .map((r) => ({ day: text(r['day']), requests: num(r['n']), chargedMicro: big(r['charged']) }));
    return {
      requests: num(total['n']),
      chargedMicro: big(total['charged']),
      upstreamCostMicro: big(total['upstream']),
      inputTokens: num(total['inp']),
      outputTokens: num(total['outp']),
      byModel,
      byDay,
    };
  }

  /** Credit-paid rows not yet settled by a draw, oldest first (SPEC §5.4 drawer). */
  unsettled(workspace: string, limit = 500): UsageRow[] {
    return this.db
      .all(
        `SELECT * FROM usage WHERE workspace = ? AND draw_id IS NULL AND paid_by = 'credit' AND charged_micro > 0 ORDER BY created_at ASC, id ASC LIMIT ?`,
        [normalizeWorkspace(workspace), limit],
        true,
      )
      .map(mapUsage);
  }

  setDrawId(ids: readonly string[], drawId: number | null): void {
    for (const id of ids) this.db.run('UPDATE usage SET draw_id = ? WHERE id = ?', [drawId, id]);
  }

  /** Un-marks `ids` that are still marked with `drawId` (a failed draw releases only its own rows). */
  clearDrawId(ids: readonly string[], drawId: number): number {
    let n = 0;
    for (const id of ids) n += this.db.run('UPDATE usage SET draw_id = NULL WHERE id = ? AND draw_id = ?', [id, drawId]).changes;
    return n;
  }

  /** Marks the unsettled rows among `ids` with `drawId` (idempotent; never steals a row from another draw). */
  claimDrawId(ids: readonly string[], drawId: number): number {
    let n = 0;
    for (const id of ids) n += this.db.run('UPDATE usage SET draw_id = ? WHERE id = ? AND draw_id IS NULL', [drawId, id]).changes;
    return n;
  }
}

/** `provider_keys`. */
export class ProviderKeyRepo {
  constructor(private readonly db: Db) {}

  upsert(row: Omit<ProviderKeyRow, 'lastError'>): void {
    this.db.run(
      `INSERT INTO provider_keys(id, workspace, provider, ciphertext, iv, tag, last4, base_url, last_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(workspace, provider) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, last4 = excluded.last4,
         base_url = excluded.base_url, last_error = NULL, created_at = excluded.created_at`,
      [row.id, normalizeWorkspace(row.workspace), row.provider, row.ciphertext, row.iv, row.tag, row.last4, row.baseUrl, row.createdAt],
    );
  }

  get(workspace: string, provider: string): ProviderKeyRow | undefined {
    const r = this.db.get('SELECT * FROM provider_keys WHERE workspace = ? AND provider = ?', [normalizeWorkspace(workspace), provider]);
    return r === undefined ? undefined : mapProviderKey(r);
  }

  list(workspace: string): ProviderKeyRow[] {
    return this.db.all('SELECT * FROM provider_keys WHERE workspace = ? ORDER BY provider', [normalizeWorkspace(workspace)]).map(mapProviderKey);
  }

  providers(workspace: string): Provider[] {
    return this.db.all('SELECT provider FROM provider_keys WHERE workspace = ?', [normalizeWorkspace(workspace)]).map((r) => text(r['provider']) as Provider);
  }

  delete(workspace: string, provider: string): boolean {
    return this.db.run('DELETE FROM provider_keys WHERE workspace = ? AND provider = ?', [normalizeWorkspace(workspace), provider]).changes > 0;
  }

  setLastError(workspace: string, provider: string, error: string | null): void {
    this.db.run('UPDATE provider_keys SET last_error = ? WHERE workspace = ? AND provider = ?', [error, normalizeWorkspace(workspace), provider]);
  }
}

/** On-chain facts of a delegated token account, as written by the scanner / register (SPEC §3.4). */
export interface BudgetUpsert {
  tokenAccount: string;
  owner: string;
  /** Workspace to fund; when omitted an existing row keeps its workspace and a new row funds the owner. */
  workspace?: string;
  delegate: string | null;
  cap: bigint;
  balance: bigint;
  lastSeenSlot?: number;
  /** Set by `POST /api/budgets/register`; the scanner leaves it untouched. */
  registeredAt?: number;
  now: number;
}

/** `budgets`. */
export class BudgetRepo {
  constructor(private readonly db: Db) {}

  /** Inserts or refreshes the chain facts of a budget (headroom fields are left to `setHeadroom`). */
  upsert(row: BudgetUpsert): BudgetRow {
    const existing = this.get(row.tokenAccount);
    const workspace = normalizeWorkspace(row.workspace ?? existing?.workspace ?? row.owner);
    const registeredAt = row.registeredAt ?? existing?.registeredAt ?? null;
    const lastSeenSlot = row.lastSeenSlot ?? existing?.lastSeenSlot ?? null;
    this.db.run(
      `INSERT INTO budgets(token_account, owner, workspace, delegate, cap, balance, closed, registered_at, last_seen_slot, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(token_account) DO UPDATE SET owner = excluded.owner, workspace = excluded.workspace, delegate = excluded.delegate, cap = excluded.cap,
         balance = excluded.balance, registered_at = excluded.registered_at, last_seen_slot = excluded.last_seen_slot, updated_at = excluded.updated_at`,
      [row.tokenAccount, normalizeWorkspace(row.owner), workspace, row.delegate, row.cap.toString(), row.balance.toString(), registeredAt, lastSeenSlot, row.now],
    );
    return this.get(row.tokenAccount) as BudgetRow;
  }

  get(tokenAccount: string): BudgetRow | undefined {
    const r = this.db.get('SELECT * FROM budgets WHERE token_account = ?', [tokenAccount], true);
    return r === undefined ? undefined : mapBudget(r);
  }

  /** Budgets funding `workspace`, newest registration first. */
  list(workspace: string): BudgetRow[] {
    return this.db
      .all('SELECT * FROM budgets WHERE workspace = ? ORDER BY COALESCE(registered_at, updated_at) DESC, token_account ASC', [normalizeWorkspace(workspace)], true)
      .map(mapBudget);
  }

  /** Budgets whose token account belongs to `owner`. */
  listByOwner(owner: string): BudgetRow[] {
    return this.db.all('SELECT * FROM budgets WHERE owner = ? ORDER BY token_account ASC', [normalizeWorkspace(owner)], true).map(mapBudget);
  }

  /** Open budgets (all workspaces) for the headroom refresh. */
  listOpen(): BudgetRow[] {
    return this.db.all('SELECT * FROM budgets WHERE closed = 0 ORDER BY token_account ASC', [], true).map(mapBudget);
  }

  /** Distinct owners with an open budget. */
  openOwners(): string[] {
    return this.db.all('SELECT DISTINCT owner FROM budgets WHERE closed = 0 ORDER BY owner ASC').map((r) => text(r['owner']));
  }

  /** Open, non-stalled budgets of one workspace, largest headroom first (drawer candidates). */
  listDrawable(workspace: string): BudgetRow[] {
    return this.db
      .all(
        'SELECT * FROM budgets WHERE workspace = ? AND closed = 0 AND stalled_reason IS NULL ORDER BY headroom_micro DESC, token_account ASC',
        [normalizeWorkspace(workspace)],
        true,
      )
      .map(mapBudget);
  }

  setHeadroom(tokenAccount: string, headroomTokens: bigint, headroomMicro: bigint, stalledReason: BudgetStalledReason | null, now: number): void {
    this.db.run(
      'UPDATE budgets SET headroom_tokens = ?, headroom_micro = ?, stalled_reason = ?, headroom_checked_at = ?, updated_at = ? WHERE token_account = ?',
      [headroomTokens.toString(), headroomMicro, stalledReason, now, now, tokenAccount],
    );
  }

  /** Marks a budget closed (`revoked`) or reopens it; a closed budget backs no credit, so its headroom is zeroed. */
  setClosed(tokenAccount: string, closed: boolean, stalledReason: BudgetStalledReason | null, now: number): void {
    this.db.run(
      `UPDATE budgets SET closed = ?, stalled_reason = ?, headroom_tokens = '0', headroom_micro = 0, headroom_checked_at = ?, updated_at = ? WHERE token_account = ?`,
      [closed ? 1 : 0, stalledReason, now, now, tokenAccount],
    );
  }

  setStalled(tokenAccount: string, stalledReason: BudgetStalledReason | null, now: number): void {
    this.db.run('UPDATE budgets SET stalled_reason = ?, updated_at = ? WHERE token_account = ?', [stalledReason, now, tokenAccount]);
  }

  setWorkspace(tokenAccount: string, workspace: string, registeredAt: number, now: number): void {
    this.db.run('UPDATE budgets SET workspace = ?, registered_at = ?, updated_at = ? WHERE token_account = ?', [normalizeWorkspace(workspace), registeredAt, now, tokenAccount]);
  }
}

/** `budget_draws`. */
export class BudgetDrawRepo {
  constructor(private readonly db: Db) {}

  insert(row: Omit<BudgetDrawRow, 'id'>): number {
    const r = this.db.run(
      `INSERT INTO budget_draws(token_account, workspace, token_amount, usd_micro, receipt_hash, usage_ids, batch_json, signature, last_valid_block_height, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.tokenAccount,
        normalizeWorkspace(row.workspace),
        row.tokenAmount.toString(),
        row.usdMicro,
        row.receiptHash.toLowerCase(),
        JSON.stringify(row.usageIds),
        row.batchJson,
        row.signature,
        row.lastValidBlockHeight,
        row.status,
        row.error,
        row.createdAt,
        row.updatedAt,
      ],
    );
    return Number(r.lastInsertRowid);
  }

  get(id: number): BudgetDrawRow | undefined {
    const r = this.db.get('SELECT * FROM budget_draws WHERE id = ?', [id], true);
    return r === undefined ? undefined : mapBudgetDraw(r);
  }

  byReceiptHash(hash: string): BudgetDrawRow | undefined {
    const r = this.db.get('SELECT * FROM budget_draws WHERE receipt_hash = ?', [hash.toLowerCase()], true);
    return r === undefined ? undefined : mapBudgetDraw(r);
  }

  bySignature(signature: string): BudgetDrawRow | undefined {
    const r = this.db.get('SELECT * FROM budget_draws WHERE signature = ?', [signature], true);
    return r === undefined ? undefined : mapBudgetDraw(r);
  }

  listByTokenAccount(tokenAccount: string): BudgetDrawRow[] {
    return this.db.all('SELECT * FROM budget_draws WHERE token_account = ? ORDER BY id DESC', [tokenAccount], true).map(mapBudgetDraw);
  }

  /** Draws still `pending`/`sent` (not yet confirmed by the indexer). */
  listInFlight(): BudgetDrawRow[] {
    return this.db.all(`SELECT * FROM budget_draws WHERE status IN ('pending','sent') ORDER BY id ASC`, [], true).map(mapBudgetDraw);
  }

  setStatus(
    id: number,
    status: BudgetDrawRow['status'],
    now: number,
    fields: { signature?: string | null; lastValidBlockHeight?: number | null; error?: string | null } = {},
  ): void {
    const row = this.get(id);
    if (row === undefined) return;
    this.db.run('UPDATE budget_draws SET status = ?, signature = ?, last_valid_block_height = ?, error = ?, updated_at = ? WHERE id = ?', [
      status,
      fields.signature === undefined ? row.signature : fields.signature,
      fields.lastValidBlockHeight === undefined ? row.lastValidBlockHeight : fields.lastValidBlockHeight,
      fields.error === undefined ? row.error : fields.error,
      now,
      id,
    ]);
  }
}

/** `upgrades`. */
export class UpgradeRepo {
  constructor(private readonly db: Db) {}

  insert(row: UpgradeRow): void {
    this.db.run('INSERT INTO upgrades(id, workspace, kind, quantity, amount_micro, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      row.id,
      normalizeWorkspace(row.workspace),
      row.kind,
      row.quantity,
      row.amountMicro,
      row.startsAt,
      row.endsAt,
      row.createdAt,
    ]);
  }

  list(workspace: string, limit = 100): UpgradeRow[] {
    return this.db.all('SELECT * FROM upgrades WHERE workspace = ? ORDER BY created_at DESC LIMIT ?', [normalizeWorkspace(workspace), limit], true).map(mapUpgrade);
  }

  /** Latest warm window end across all workspaces (house warm state). */
  warmUntil(): number | null {
    const r = this.db.get(`SELECT MAX(ends_at) AS t FROM upgrades WHERE kind = 'warm'`);
    return r === undefined ? null : optNum(r['t']);
  }
}

/** `provider_health`. */
export class ProviderHealthRepo {
  constructor(private readonly db: Db) {}

  all(): ProviderHealthRow[] {
    return this.db.all('SELECT * FROM provider_health').map(mapHealth);
  }

  upsert(row: ProviderHealthRow): void {
    this.db.run(
      `INSERT INTO provider_health(provider, state, failures, opened_at, open_for_ms, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET state = excluded.state, failures = excluded.failures, opened_at = excluded.opened_at,
         open_for_ms = excluded.open_for_ms, updated_at = excluded.updated_at`,
      [row.provider, row.state, row.failures, row.openedAt, row.openForMs, row.updatedAt],
    );
  }
}

/** Generic key/value tables (`indexer_state`, `settings`). */
export class KvRepo {
  constructor(
    private readonly db: Db,
    private readonly table: 'indexer_state' | 'settings',
  ) {}

  get(key: string): string | undefined {
    const r = this.db.get(`SELECT value FROM ${this.table} WHERE key = ?`, [key]);
    return r === undefined ? undefined : text(r['value']);
  }

  set(key: string, value: string): void {
    this.db.run(`INSERT INTO ${this.table}(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
  }

  delete(key: string): void {
    this.db.run(`DELETE FROM ${this.table} WHERE key = ?`, [key]);
  }
}

/** `rate_limits`: fixed window per API key (SPEC §5.7). */
export class RateLimitRepo {
  constructor(private readonly db: Db) {}

  /** Increments the counter of `keyId` in the window containing `now`; returns the new count. */
  hit(keyId: string, now: number, windowMs: number): { count: number; windowStart: number } {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    return this.db.transaction(() => {
      const r = this.db.get('SELECT window_start, count FROM rate_limits WHERE key_id = ?', [keyId]);
      if (r === undefined || num(r['window_start']) !== windowStart) {
        this.db.run('INSERT INTO rate_limits(key_id, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key_id) DO UPDATE SET window_start = ?, count = 1', [
          keyId,
          windowStart,
          windowStart,
        ]);
        return { count: 1, windowStart };
      }
      const count = num(r['count']) + 1;
      this.db.run('UPDATE rate_limits SET count = ? WHERE key_id = ?', [count, keyId]);
      return { count, windowStart };
    });
  }
}

/** All repositories over one connection. */
export class Repos {
  readonly workspaces: WorkspaceRepo;
  readonly apiKeys: ApiKeyRepo;
  readonly sessions: SessionRepo;
  readonly nonces: NonceRepo;
  readonly ledger: LedgerRepo;
  readonly creditEvents: CreditEventRepo;
  readonly pricePoints: PricePointRepo;
  readonly reservations: ReservationRepo;
  readonly usage: UsageRepo;
  readonly providerKeys: ProviderKeyRepo;
  readonly budgets: BudgetRepo;
  readonly budgetDraws: BudgetDrawRepo;
  readonly upgrades: UpgradeRepo;
  readonly health: ProviderHealthRepo;
  readonly indexerState: KvRepo;
  readonly settings: KvRepo;
  readonly rateLimits: RateLimitRepo;

  constructor(readonly db: Db) {
    this.workspaces = new WorkspaceRepo(db);
    this.apiKeys = new ApiKeyRepo(db);
    this.sessions = new SessionRepo(db);
    this.nonces = new NonceRepo(db);
    this.ledger = new LedgerRepo(db);
    this.creditEvents = new CreditEventRepo(db);
    this.pricePoints = new PricePointRepo(db);
    this.reservations = new ReservationRepo(db);
    this.usage = new UsageRepo(db);
    this.providerKeys = new ProviderKeyRepo(db);
    this.budgets = new BudgetRepo(db);
    this.budgetDraws = new BudgetDrawRepo(db);
    this.upgrades = new UpgradeRepo(db);
    this.health = new ProviderHealthRepo(db);
    this.indexerState = new KvRepo(db, 'indexer_state');
    this.settings = new KvRepo(db, 'settings');
    this.rateLimits = new RateLimitRepo(db);
  }

  /** Runs `fn` in a transaction. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }
}
