/**
 * Repositories over the SPEC §5.2 tables. Every method is synchronous (node:sqlite) and uses
 * prepared statements; monetary columns are read as `bigint`. Timestamps are unix milliseconds
 * except on-chain mirrors (`budgets.deadline`, `credit_events.block_time`), which are seconds.
 *
 * @module db/repos
 */
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

/** `credit_events` row. */
export interface CreditEventRow {
  txHash: string;
  logIndex: number;
  kind: 'purchase' | 'draw';
  receiptId: number;
  workspace: string;
  payer: string | null;
  tokenAmount: bigint;
  usdMicro: bigint;
  priceE18: bigint;
  budgetId: number | null;
  receiptHash: string | null;
  blockNumber: number;
  blockHash: string;
  blockTime: number;
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

/** `budgets` row. */
export interface BudgetRow {
  budgetId: number;
  owner: string;
  workspace: string;
  cap: bigint;
  drawn: bigint;
  /** Unix seconds. */
  deadline: number;
  closed: boolean;
  headroomTokens: bigint;
  headroomMicro: bigint;
  headroomCheckedAt: number | null;
  stalledReason: 'price' | 'allowance' | 'draw_failed' | null;
  openedBlock: number | null;
  updatedAt: number;
}

/** `budget_draws` row. */
export interface BudgetDrawRow {
  id: number;
  budgetId: number;
  workspace: string;
  tokenAmount: bigint;
  usdMicro: bigint;
  receiptHash: string;
  usageIds: string[];
  /** The canonical `DrawBatch` as JSON (wire form). */
  batchJson: string;
  txHash: string | null;
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

/** `price_posts` row. */
export interface PricePostRow {
  id: number;
  priceE18: bigint;
  source: string;
  txHash: string | null;
  status: string;
  createdAt: number;
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
  txHash: text(r['tx_hash']),
  logIndex: num(r['log_index']),
  kind: text(r['kind']) as CreditEventRow['kind'],
  receiptId: num(r['receipt_id']),
  workspace: text(r['workspace']),
  payer: optText(r['payer']),
  tokenAmount: big(r['token_amount']),
  usdMicro: big(r['usd_micro']),
  priceE18: big(r['price_e18']),
  budgetId: optNum(r['budget_id']),
  receiptHash: optText(r['receipt_hash']),
  blockNumber: num(r['block_number']),
  blockHash: text(r['block_hash']),
  blockTime: num(r['block_time']),
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
  budgetId: num(r['budget_id']),
  owner: text(r['owner']),
  workspace: text(r['workspace']),
  cap: big(r['cap']),
  drawn: big(r['drawn']),
  deadline: num(r['deadline']),
  closed: num(r['closed']) === 1,
  headroomTokens: big(r['headroom_tokens']),
  headroomMicro: big(r['headroom_micro']),
  headroomCheckedAt: optNum(r['headroom_checked_at']),
  stalledReason: optText(r['stalled_reason']) as BudgetRow['stalledReason'],
  openedBlock: optNum(r['opened_block']),
  updatedAt: num(r['updated_at']),
});

const mapBudgetDraw = (r: Row): BudgetDrawRow => ({
  id: num(r['id']),
  budgetId: num(r['budget_id']),
  workspace: text(r['workspace']),
  tokenAmount: big(r['token_amount']),
  usdMicro: big(r['usd_micro']),
  receiptHash: text(r['receipt_hash']),
  usageIds: parseJsonArray(text(r['usage_ids'])),
  batchJson: text(r['batch_json']),
  txHash: optText(r['tx_hash']),
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

const mapPricePost = (r: Row): PricePostRow => ({
  id: num(r['id']),
  priceE18: big(r['price_e18']),
  source: text(r['source']),
  txHash: optText(r['tx_hash']),
  status: text(r['status']),
  createdAt: num(r['created_at']),
});

/** Lowercases a workspace id (SPEC §1). */
export function normalizeWorkspace(address: string): string {
  return address.trim().toLowerCase();
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

/** `siwe_nonces`. */
export class NonceRepo {
  constructor(private readonly db: Db) {}

  insert(nonce: string, now: number, expiresAt: number): void {
    this.db.run('INSERT INTO siwe_nonces(nonce, created_at, expires_at) VALUES (?, ?, ?)', [nonce, now, expiresAt]);
  }

  /** Consumes the nonce (single use); `false` when unknown or expired. */
  consume(nonce: string, now: number): boolean {
    const r = this.db.run('DELETE FROM siwe_nonces WHERE nonce = ? AND expires_at > ?', [nonce, now]);
    this.db.run('DELETE FROM siwe_nonces WHERE expires_at <= ?', [now]);
    return r.changes > 0;
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

  budgetHeadroom(workspace: string, nowSec: number): bigint {
    const r = this.db.get(
      'SELECT COALESCE(SUM(headroom_micro), 0) AS s FROM budgets WHERE workspace = ? AND closed = 0 AND deadline > ? AND stalled_reason IS NULL',
      [normalizeWorkspace(workspace), nowSec],
      true,
    );
    return r === undefined ? 0n : big(r['s']);
  }

  snapshot(workspace: string, now: number): BalanceSnapshot {
    const balance = this.balance(workspace);
    const reserved = this.reserved(workspace, now);
    const budgetHeadroom = this.budgetHeadroom(workspace, Math.floor(now / 1000));
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

  exists(txHash: string, logIndex: number): boolean {
    return this.db.get('SELECT 1 AS x FROM credit_events WHERE tx_hash = ? AND log_index = ?', [txHash, logIndex]) !== undefined;
  }

  insert(row: CreditEventRow): void {
    this.db.run(
      `INSERT INTO credit_events(tx_hash, log_index, kind, receipt_id, workspace, payer, token_amount, usd_micro, price_e18, budget_id, receipt_hash,
         block_number, block_hash, block_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.txHash,
        row.logIndex,
        row.kind,
        row.receiptId,
        normalizeWorkspace(row.workspace),
        row.payer === null ? null : normalizeWorkspace(row.payer),
        row.tokenAmount.toString(),
        row.usdMicro,
        row.priceE18.toString(),
        row.budgetId,
        row.receiptHash,
        row.blockNumber,
        row.blockHash,
        row.blockTime,
        row.createdAt,
      ],
    );
  }

  list(workspace: string, limit: number, before?: number): CreditEventRow[] {
    const rows =
      before === undefined
        ? this.db.all('SELECT * FROM credit_events WHERE workspace = ? ORDER BY block_number DESC, log_index DESC LIMIT ?', [normalizeWorkspace(workspace), limit], true)
        : this.db.all(
            'SELECT * FROM credit_events WHERE workspace = ? AND block_number < ? ORDER BY block_number DESC, log_index DESC LIMIT ?',
            [normalizeWorkspace(workspace), before, limit],
            true,
          );
    return rows.map(mapCreditEvent);
  }

  /** Events above `blockNumber` (for the reorg rewind). */
  listAbove(blockNumber: number): CreditEventRow[] {
    return this.db.all('SELECT * FROM credit_events WHERE block_number > ?', [blockNumber], true).map(mapCreditEvent);
  }

  deleteAbove(blockNumber: number): number {
    return this.db.run('DELETE FROM credit_events WHERE block_number > ?', [blockNumber]).changes;
  }

  /** Sum of drawn token amounts per budget from the remaining draw events. */
  drawnByBudget(budgetId: number): bigint {
    const rows = this.db.all('SELECT token_amount FROM credit_events WHERE kind = ? AND budget_id = ?', ['draw', budgetId]);
    return rows.reduce((sum, r) => sum + big(r['token_amount']), 0n);
  }

  lastEventAt(): number | null {
    const r = this.db.get('SELECT MAX(block_time) AS t FROM credit_events');
    return r === undefined ? null : optNum(r['t']);
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

/** `budgets`. */
export class BudgetRepo {
  constructor(private readonly db: Db) {}

  /** Upsert from `BudgetOpened` (keeps headroom fields when re-applied). */
  upsertOpened(row: { budgetId: number; owner: string; workspace: string; cap: bigint; deadline: number; openedBlock: number; now: number }): void {
    this.db.run(
      `INSERT INTO budgets(budget_id, owner, workspace, cap, drawn, deadline, closed, opened_block, updated_at)
       VALUES (?, ?, ?, ?, '0', ?, 0, ?, ?)
       ON CONFLICT(budget_id) DO UPDATE SET owner = excluded.owner, workspace = excluded.workspace, cap = excluded.cap, deadline = excluded.deadline,
         opened_block = excluded.opened_block, updated_at = excluded.updated_at`,
      [row.budgetId, normalizeWorkspace(row.owner), normalizeWorkspace(row.workspace), row.cap.toString(), row.deadline, row.openedBlock, row.now],
    );
  }

  get(budgetId: number): BudgetRow | undefined {
    const r = this.db.get('SELECT * FROM budgets WHERE budget_id = ?', [budgetId]);
    return r === undefined ? undefined : mapBudget(r);
  }

  list(workspace: string): BudgetRow[] {
    return this.db.all('SELECT * FROM budgets WHERE workspace = ? ORDER BY budget_id DESC', [normalizeWorkspace(workspace)]).map(mapBudget);
  }

  /** Open, unexpired budgets (all workspaces) for the headroom refresher. */
  listOpen(nowSec: number): BudgetRow[] {
    return this.db.all('SELECT * FROM budgets WHERE closed = 0 AND deadline > ? ORDER BY budget_id ASC', [nowSec]).map(mapBudget);
  }

  /** Open, unexpired, non-stalled budgets of one workspace (drawer candidates). */
  listDrawable(workspace: string, nowSec: number): BudgetRow[] {
    return this.db
      .all(
        'SELECT * FROM budgets WHERE workspace = ? AND closed = 0 AND deadline > ? AND stalled_reason IS NULL ORDER BY headroom_micro DESC, budget_id ASC',
        [normalizeWorkspace(workspace), nowSec],
      )
      .map(mapBudget);
  }

  addDrawn(budgetId: number, amount: bigint, now: number): void {
    const row = this.get(budgetId);
    if (row === undefined) return;
    this.db.run('UPDATE budgets SET drawn = ?, updated_at = ? WHERE budget_id = ?', [(row.drawn + amount).toString(), now, budgetId]);
  }

  setDrawn(budgetId: number, drawn: bigint, now: number): void {
    this.db.run('UPDATE budgets SET drawn = ?, updated_at = ? WHERE budget_id = ?', [drawn.toString(), now, budgetId]);
  }

  setClosed(budgetId: number, closed: boolean, now: number): void {
    this.db.run('UPDATE budgets SET closed = ?, updated_at = ? WHERE budget_id = ?', [closed ? 1 : 0, now, budgetId]);
  }

  setHeadroom(budgetId: number, headroomTokens: bigint, headroomMicro: bigint, stalledReason: BudgetRow['stalledReason'], now: number): void {
    this.db.run(
      'UPDATE budgets SET headroom_tokens = ?, headroom_micro = ?, stalled_reason = ?, headroom_checked_at = ?, updated_at = ? WHERE budget_id = ?',
      [headroomTokens.toString(), headroomMicro, stalledReason, now, now, budgetId],
    );
  }

  setStalled(budgetId: number, stalledReason: BudgetRow['stalledReason'], now: number): void {
    this.db.run('UPDATE budgets SET stalled_reason = ?, updated_at = ? WHERE budget_id = ?', [stalledReason, now, budgetId]);
  }
}

/** `budget_draws`. */
export class BudgetDrawRepo {
  constructor(private readonly db: Db) {}

  insert(row: Omit<BudgetDrawRow, 'id'>): number {
    const r = this.db.run(
      `INSERT INTO budget_draws(budget_id, workspace, token_amount, usd_micro, receipt_hash, usage_ids, batch_json, tx_hash, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.budgetId,
        normalizeWorkspace(row.workspace),
        row.tokenAmount.toString(),
        row.usdMicro,
        row.receiptHash,
        JSON.stringify(row.usageIds),
        row.batchJson,
        row.txHash,
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
    const r = this.db.get('SELECT * FROM budget_draws WHERE receipt_hash = ?', [hash], true);
    return r === undefined ? undefined : mapBudgetDraw(r);
  }

  listByBudget(budgetId: number): BudgetDrawRow[] {
    return this.db.all('SELECT * FROM budget_draws WHERE budget_id = ? ORDER BY id DESC', [budgetId], true).map(mapBudgetDraw);
  }

  /** Draws still `pending`/`sent` (not yet confirmed by the indexer). */
  listInFlight(): BudgetDrawRow[] {
    return this.db.all(`SELECT * FROM budget_draws WHERE status IN ('pending','sent') ORDER BY id ASC`, [], true).map(mapBudgetDraw);
  }

  setStatus(id: number, status: BudgetDrawRow['status'], now: number, fields: { txHash?: string | null; error?: string | null } = {}): void {
    const row = this.get(id);
    if (row === undefined) return;
    this.db.run('UPDATE budget_draws SET status = ?, tx_hash = ?, error = ?, updated_at = ? WHERE id = ?', [
      status,
      fields.txHash === undefined ? row.txHash : fields.txHash,
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

/** `price_posts`. */
export class PricePostRepo {
  constructor(private readonly db: Db) {}

  insert(row: Omit<PricePostRow, 'id'>): number {
    const r = this.db.run('INSERT INTO price_posts(price_e18, source, tx_hash, status, created_at) VALUES (?, ?, ?, ?, ?)', [
      row.priceE18.toString(),
      row.source,
      row.txHash,
      row.status,
      row.createdAt,
    ]);
    return Number(r.lastInsertRowid);
  }

  latest(): PricePostRow | undefined {
    const r = this.db.get('SELECT * FROM price_posts ORDER BY id DESC LIMIT 1');
    return r === undefined ? undefined : mapPricePost(r);
  }

  setStatus(id: number, status: string, txHash: string | null): void {
    this.db.run('UPDATE price_posts SET status = ?, tx_hash = ? WHERE id = ?', [status, txHash, id]);
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
  readonly reservations: ReservationRepo;
  readonly usage: UsageRepo;
  readonly providerKeys: ProviderKeyRepo;
  readonly budgets: BudgetRepo;
  readonly budgetDraws: BudgetDrawRepo;
  readonly upgrades: UpgradeRepo;
  readonly health: ProviderHealthRepo;
  readonly indexerState: KvRepo;
  readonly settings: KvRepo;
  readonly pricePosts: PricePostRepo;
  readonly rateLimits: RateLimitRepo;

  constructor(readonly db: Db) {
    this.workspaces = new WorkspaceRepo(db);
    this.apiKeys = new ApiKeyRepo(db);
    this.sessions = new SessionRepo(db);
    this.nonces = new NonceRepo(db);
    this.ledger = new LedgerRepo(db);
    this.creditEvents = new CreditEventRepo(db);
    this.reservations = new ReservationRepo(db);
    this.usage = new UsageRepo(db);
    this.providerKeys = new ProviderKeyRepo(db);
    this.budgets = new BudgetRepo(db);
    this.budgetDraws = new BudgetDrawRepo(db);
    this.upgrades = new UpgradeRepo(db);
    this.health = new ProviderHealthRepo(db);
    this.indexerState = new KvRepo(db, 'indexer_state');
    this.settings = new KvRepo(db, 'settings');
    this.pricePosts = new PricePostRepo(db);
    this.rateLimits = new RateLimitRepo(db);
  }

  /** Runs `fn` in a transaction. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }
}
