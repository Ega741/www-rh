/**
 * Typed repositories over the runner's SQLite schema. All wei / uint256 values cross this boundary
 * as decimal strings or bigints, never as JS numbers (R8).
 *
 * @module db/repos
 */
import type { Db } from './sqlite.js';
import type { TxRecordStatus } from '@www-rh/shared';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** `minds` row. */
export interface MindRow {
  token: string;
  creator: string;
  name: string;
  symbol: string;
  metadata_uri: string;
  model_id: string;
  persona_hash: string;
  status: number;
  phase: number;
  real_eth_reserve: string;
  tokens_sold: string;
  price_wei: string;
  mcap_sort: number;
  mind_balance: string;
  pool: string | null;
  position_id: string | null;
  graduator: string | null;
  created_block: number;
  created_log_index: number;
  created_at: string;
  activity_at: string;
  last_trade_at: string | null;
  last_tick_at: string | null;
  current_url: string | null;
  last_frame_at: string | null;
  meta_status: 'pending' | 'ok' | 'error';
  meta_image: string | null;
  meta_description: string | null;
  meta_persona: string | null;
  meta_links: string | null;
  meta_error: string | null;
  meta_resolved_at: string | null;
  cooling_until: string | null;
  failed_ticks: number;
}

/** `trades` row. */
export interface TradeRow {
  tx_hash: string;
  log_index: number;
  block_number: number;
  timestamp: string;
  token: string;
  trader: string;
  is_buy: number;
  eth_amount: string;
  token_amount: string;
  fee: string;
  real_eth_reserve: string;
  tokens_sold: string;
  price_wei: string;
}

/** `draws` row (on-chain `ComputeDrawn`). */
export interface DrawRow {
  tx_hash: string;
  log_index: number;
  block_number: number;
  timestamp: string;
  token: string;
  amount: string;
  receipt_hash: string;
}

/** `memories` row. */
export interface MemoryRow {
  id: number;
  token: string;
  seq: number;
  kind: 'note' | 'finding';
  content: string;
  url: string | null;
  created_at: string;
  content_hash: string;
  tick_id: number | null;
  batch_id: number | null;
}

/** `memory_batches` row. */
export interface BatchRow {
  id: number;
  token: string;
  from_seq: number;
  to_seq: number;
  content_hash: string;
  uri: string;
  status: TxRecordStatus;
  tx_hash: string | null;
  error: string | null;
  created_at: string;
}

/** `ticks` row. */
export interface TickRow {
  id: number;
  token: string;
  started_at: string;
  finished_at: string | null;
  requested_model: string;
  served_model: string | null;
  iterations: number;
  cost_usd_micro: number;
  stop_reason: string | null;
  status: string;
  error: string | null;
  summary: string | null;
}

/** `thoughts` row. */
export interface ThoughtRow {
  id: number;
  token: string;
  tick_id: number;
  kind: 'aloud' | 'summary';
  text: string;
  created_at: string;
}

/** `compute_ledger` row joined with its receipt. */
export interface LedgerRow {
  id: number;
  token: string;
  tick_id: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd_micro: number;
  created_at: string;
  receipt_id: number | null;
  receipt_hash: string | null;
  receipt_status: TxRecordStatus | null;
  receipt_tx: string | null;
}

/** `receipts` row. */
export interface ReceiptRow {
  id: number;
  token: string;
  receipt_hash: string;
  receipt_json: string;
  amount_wei: string;
  cost_usd_micro: number;
  status: TxRecordStatus;
  tx_hash: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

/** Key/value state of the indexer and global counters. */
export class StateRepo {
  constructor(private readonly db: Db) {}

  get(key: string): string | undefined {
    return this.db.get<{ value: string }>('SELECT value FROM indexer_state WHERE key = ?', key)?.value;
  }

  set(key: string, value: string): void {
    this.db.run('INSERT INTO indexer_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  /** Last fully processed block, or `undefined` before the first batch. */
  lastBlock(): bigint | undefined {
    const v = this.get('last_block');
    return v === undefined ? undefined : BigInt(v);
  }

  setLastBlock(block: bigint): void {
    this.set('last_block', block.toString(10));
  }

  /** Adds `delta` to a bigint counter stored as a decimal string. */
  addBigint(key: string, delta: bigint): void {
    const current = BigInt(this.get(key) ?? '0');
    this.set(key, (current + delta).toString(10));
  }

  bigint(key: string): bigint {
    return BigInt(this.get(key) ?? '0');
  }
}

/** Idempotency ledger of applied logs. */
export class ChainEventsRepo {
  constructor(private readonly db: Db) {}

  /** Records the log; returns `false` if `(txHash, logIndex)` was already applied. */
  insertIfNew(txHash: string, logIndex: number, blockNumber: number, event: string, token: string | null): boolean {
    return (
      this.db.run(
        'INSERT OR IGNORE INTO chain_events (tx_hash, log_index, block_number, event, token) VALUES (?, ?, ?, ?, ?)',
        txHash,
        logIndex,
        blockNumber,
        event,
        token,
      ).changes === 1
    );
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT count(*) AS n FROM chain_events')?.n ?? 0;
  }
}

/** Input of {@link MindsRepo.insertCreated}. */
export interface NewMind {
  token: string;
  creator: string;
  name: string;
  symbol: string;
  metadataUri: string;
  modelId: string;
  personaHash: string;
  blockNumber: number;
  logIndex: number;
  createdAt: string;
  priceWei: string;
  mcapSort: number;
}

/** Sort orders of {@link MindsRepo.list}. */
export type MindSort = 'created' | 'mcap' | 'activity';

const MIND_ORDER: Record<MindSort, string> = {
  created: 'created_block DESC, created_log_index DESC',
  mcap: 'mcap_sort DESC, created_block DESC',
  activity: 'activity_at DESC, created_block DESC',
};

/** Indexed + local state of every mind. */
export class MindsRepo {
  constructor(private readonly db: Db) {}

  insertCreated(m: NewMind): boolean {
    return (
      this.db.run(
        `INSERT OR IGNORE INTO minds (token, creator, name, symbol, metadata_uri, model_id, persona_hash, price_wei, mcap_sort,
           created_block, created_log_index, created_at, activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.token,
        m.creator,
        m.name,
        m.symbol,
        m.metadataUri,
        m.modelId,
        m.personaHash,
        m.priceWei,
        m.mcapSort,
        m.blockNumber,
        m.logIndex,
        m.createdAt,
        m.createdAt,
      ).changes === 1
    );
  }

  get(token: string): MindRow | undefined {
    return this.db.get<MindRow>('SELECT * FROM minds WHERE token = ?', token.toLowerCase());
  }

  list(sort: MindSort, limit: number, offset: number): MindRow[] {
    return this.db.all<MindRow>(`SELECT * FROM minds ORDER BY ${MIND_ORDER[sort]} LIMIT ? OFFSET ?`, limit, offset);
  }

  all(): MindRow[] {
    return this.db.all<MindRow>('SELECT * FROM minds ORDER BY created_block, created_log_index');
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT count(*) AS n FROM minds')?.n ?? 0;
  }

  countWhere(column: 'status' | 'phase', value: number): number {
    return this.db.get<{ n: number }>(`SELECT count(*) AS n FROM minds WHERE ${column} = ?`, value)?.n ?? 0;
  }

  applyTrade(token: string, s: { realEthReserve: string; tokensSold: string; priceWei: string; mcapSort: number; at: string }): void {
    this.db.run(
      `UPDATE minds SET real_eth_reserve = ?, tokens_sold = ?, price_wei = ?, mcap_sort = ?, last_trade_at = ?,
         activity_at = max(activity_at, ?) WHERE token = ?`,
      s.realEthReserve,
      s.tokensSold,
      s.priceWei,
      s.mcapSort,
      s.at,
      s.at,
      token,
    );
  }

  setPhase(token: string, phase: number): void {
    this.db.run('UPDATE minds SET phase = ? WHERE token = ?', phase, token);
  }

  setGraduated(token: string, pool: string, positionId: string, graduator: string | null): void {
    this.db.run(
      "UPDATE minds SET phase = 2, pool = ?, position_id = ?, graduator = ?, real_eth_reserve = '0' WHERE token = ?",
      pool,
      positionId,
      graduator,
      token,
    );
  }

  /** Adds a signed delta to the indexed vault balance (never below zero). */
  addBalance(token: string, delta: bigint): void {
    const row = this.db.get<{ mind_balance: string }>('SELECT mind_balance FROM minds WHERE token = ?', token);
    if (row === undefined) return;
    const next = BigInt(row.mind_balance) + delta;
    this.db.run('UPDATE minds SET mind_balance = ? WHERE token = ?', (next < 0n ? 0n : next).toString(10), token);
  }

  /** Overwrites the indexed balance with a fresh on-chain read. */
  setBalance(token: string, balance: bigint): void {
    this.db.run('UPDATE minds SET mind_balance = ? WHERE token = ?', balance.toString(10), token);
  }

  setStatus(token: string, status: number): void {
    this.db.run('UPDATE minds SET status = ? WHERE token = ?', status, token);
  }

  setConfig(token: string, modelId: string, personaHash: string, metadataUri: string): void {
    this.db.run(
      "UPDATE minds SET model_id = ?, persona_hash = ?, metadata_uri = ?, meta_status = 'pending' WHERE token = ?",
      modelId,
      personaHash,
      metadataUri,
      token,
    );
  }

  setMetadata(
    token: string,
    m: { status: 'ok' | 'error'; image: string | null; description: string | null; persona: string | null; links: string | null; error: string | null; at: string },
  ): void {
    this.db.run(
      `UPDATE minds SET meta_status = ?, meta_image = ?, meta_description = ?, meta_persona = ?, meta_links = ?, meta_error = ?,
         meta_resolved_at = ? WHERE token = ?`,
      m.status,
      m.image,
      m.description,
      m.persona,
      m.links,
      m.error,
      m.at,
      token,
    );
  }

  touchTick(token: string, at: string): void {
    this.db.run('UPDATE minds SET last_tick_at = ?, activity_at = max(activity_at, ?) WHERE token = ?', at, at, token);
  }

  setCurrentUrl(token: string, url: string | null): void {
    this.db.run('UPDATE minds SET current_url = ? WHERE token = ?', url, token);
  }

  setLastFrameAt(token: string, at: string): void {
    this.db.run('UPDATE minds SET last_frame_at = ? WHERE token = ?', at, token);
  }

  setCooling(token: string, until: string | null, failedTicks: number): void {
    this.db.run('UPDATE minds SET cooling_until = ?, failed_ticks = ? WHERE token = ?', until, failedTicks, token);
  }
}

/** Curve trades. */
export class TradesRepo {
  constructor(private readonly db: Db) {}

  insert(t: TradeRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO trades (tx_hash, log_index, block_number, timestamp, token, trader, is_buy, eth_amount, token_amount,
         fee, real_eth_reserve, tokens_sold, price_wei) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.tx_hash,
      t.log_index,
      t.block_number,
      t.timestamp,
      t.token,
      t.trader,
      t.is_buy,
      t.eth_amount,
      t.token_amount,
      t.fee,
      t.real_eth_reserve,
      t.tokens_sold,
      t.price_wei,
    );
  }

  listByToken(token: string, limit: number): TradeRow[] {
    return this.db.all<TradeRow>('SELECT * FROM trades WHERE token = ? ORDER BY block_number DESC, log_index DESC LIMIT ?', token, limit);
  }

  /** `(token, eth_amount)` of trades since `sinceIso`, for the given tokens. */
  since(tokens: readonly string[], sinceIso: string): { token: string; eth_amount: string }[] {
    if (tokens.length === 0) return [];
    const placeholders = tokens.map(() => '?').join(',');
    return this.db.all<{ token: string; eth_amount: string }>(
      `SELECT token, eth_amount FROM trades WHERE timestamp >= ? AND token IN (${placeholders})`,
      sinceIso,
      ...tokens,
    );
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT count(*) AS n FROM trades')?.n ?? 0;
  }
}

/** Fee accruals, fundings, draws, anchors and harvests (append-only chain facts). */
export class LedgerEventsRepo {
  constructor(private readonly db: Db) {}

  insertFeeAccrual(r: { txHash: string; logIndex: number; blockNumber: number; token: string; mindAmount: string; protocolAmount: string }): void {
    this.db.run(
      'INSERT OR IGNORE INTO fee_accruals (tx_hash, log_index, block_number, token, mind_amount, protocol_amount) VALUES (?, ?, ?, ?, ?, ?)',
      r.txHash,
      r.logIndex,
      r.blockNumber,
      r.token,
      r.mindAmount,
      r.protocolAmount,
    );
  }

  insertFunding(r: { txHash: string; logIndex: number; blockNumber: number; timestamp: string; token: string; from: string; amount: string }): void {
    this.db.run(
      'INSERT OR IGNORE INTO fundings (tx_hash, log_index, block_number, timestamp, token, from_addr, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
      r.txHash,
      r.logIndex,
      r.blockNumber,
      r.timestamp,
      r.token,
      r.from,
      r.amount,
    );
  }

  insertDraw(r: DrawRow): void {
    this.db.run(
      'INSERT OR IGNORE INTO draws (tx_hash, log_index, block_number, timestamp, token, amount, receipt_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
      r.tx_hash,
      r.log_index,
      r.block_number,
      r.timestamp,
      r.token,
      r.amount,
      r.receipt_hash,
    );
  }

  draws(token: string, limit: number): DrawRow[] {
    return this.db.all<DrawRow>('SELECT * FROM draws WHERE token = ? ORDER BY block_number DESC, log_index DESC LIMIT ?', token, limit);
  }

  insertAnchor(r: { txHash: string; logIndex: number; blockNumber: number; token: string; seq: number; contentHash: string; uri: string }): void {
    this.db.run(
      'INSERT OR IGNORE INTO onchain_anchors (tx_hash, log_index, block_number, token, seq, content_hash, uri) VALUES (?, ?, ?, ?, ?, ?, ?)',
      r.txHash,
      r.logIndex,
      r.blockNumber,
      r.token,
      r.seq,
      r.contentHash,
      r.uri,
    );
  }

  insertHarvest(r: { txHash: string; logIndex: number; blockNumber: number; token: string; ethOut: string; tokensBurned: string }): void {
    this.db.run(
      'INSERT OR IGNORE INTO harvests (tx_hash, log_index, block_number, token, eth_out, tokens_burned) VALUES (?, ?, ?, ?, ?, ?)',
      r.txHash,
      r.logIndex,
      r.blockNumber,
      r.token,
      r.ethOut,
      r.tokensBurned,
    );
  }
}

/** Memories (+ FTS index) and their anchor batches. */
export class MemoriesRepo {
  constructor(private readonly db: Db) {}

  lastSeq(token: string): number {
    return this.db.get<{ s: number | null }>('SELECT max(seq) AS s FROM memories WHERE token = ?', token)?.s ?? 0;
  }

  /** Inserts a memory with the given (pre-computed) seq and hash; caller runs this in a transaction. */
  insert(m: Omit<MemoryRow, 'id' | 'batch_id'>): MemoryRow {
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO memories (token, seq, kind, content, url, created_at, content_hash, tick_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      m.token,
      m.seq,
      m.kind,
      m.content,
      m.url,
      m.created_at,
      m.content_hash,
      m.tick_id,
    );
    if (this.db.hasFts) {
      this.db.run('INSERT INTO memories_fts (rowid, content, url) VALUES (?, ?, ?)', lastInsertRowid, m.content, m.url ?? '');
    }
    return { ...m, id: lastInsertRowid, batch_id: null };
  }

  list(token: string, limit: number, beforeSeq?: number): MemoryRow[] {
    return beforeSeq === undefined
      ? this.db.all<MemoryRow>('SELECT * FROM memories WHERE token = ? ORDER BY seq DESC LIMIT ?', token, limit)
      : this.db.all<MemoryRow>('SELECT * FROM memories WHERE token = ? AND seq < ? ORDER BY seq DESC LIMIT ?', token, beforeSeq, limit);
  }

  range(token: string, fromSeq: number, toSeq: number): MemoryRow[] {
    return this.db.all<MemoryRow>('SELECT * FROM memories WHERE token = ? AND seq BETWEEN ? AND ? ORDER BY seq', token, fromSeq, toSeq);
  }

  /** Full-text search (FTS5 when available, else case-insensitive LIKE on every term). */
  search(token: string, query: string, limit: number): MemoryRow[] {
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1)
      .slice(0, 8);
    if (terms.length === 0) return this.list(token, limit);
    if (this.db.hasFts) {
      const match = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
      return this.db.all<MemoryRow>(
        `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ? AND m.token = ? ORDER BY bm25(memories_fts), m.seq DESC LIMIT ?`,
        match,
        token,
        limit,
      );
    }
    const where = terms.map(() => "(lower(content) LIKE ? ESCAPE '\\' OR lower(coalesce(url, '')) LIKE ? ESCAPE '\\')").join(' OR ');
    const params = terms.flatMap((t) => {
      const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return [like, like];
    });
    return this.db.all<MemoryRow>(`SELECT * FROM memories WHERE token = ? AND (${where}) ORDER BY seq DESC LIMIT ?`, token, ...params, limit);
  }

  /** Memories not yet covered by an anchor batch, oldest first. */
  unbatched(token: string, limit: number): MemoryRow[] {
    return this.db.all<MemoryRow>('SELECT * FROM memories WHERE token = ? AND batch_id IS NULL ORDER BY seq LIMIT ?', token, limit);
  }

  assignBatch(token: string, fromSeq: number, toSeq: number, batchId: number): void {
    this.db.run('UPDATE memories SET batch_id = ? WHERE token = ? AND seq BETWEEN ? AND ?', batchId, token, fromSeq, toSeq);
  }

  insertBatch(b: Omit<BatchRow, 'id'>): number {
    return this.db.run(
      'INSERT INTO memory_batches (token, from_seq, to_seq, content_hash, uri, status, tx_hash, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      b.token,
      b.from_seq,
      b.to_seq,
      b.content_hash,
      b.uri,
      b.status,
      b.tx_hash,
      b.error,
      b.created_at,
    ).lastInsertRowid;
  }

  updateBatch(id: number, status: TxRecordStatus, txHash: string | null, error: string | null): void {
    this.db.run('UPDATE memory_batches SET status = ?, tx_hash = coalesce(?, tx_hash), error = ? WHERE id = ?', status, txHash, error, id);
  }

  /** Marks the batch with `uri` as confirmed by an indexed `MemoryAnchored` event. */
  confirmBatchByUri(token: string, uri: string, contentHash: string, txHash: string): BatchRow | undefined {
    this.db.run(
      "UPDATE memory_batches SET status = 'confirmed', tx_hash = ?, error = NULL WHERE token = ? AND uri = ? AND content_hash = ?",
      txHash,
      token,
      uri,
      contentHash,
    );
    return this.db.get<BatchRow>('SELECT * FROM memory_batches WHERE token = ? AND uri = ?', token, uri);
  }

  batch(id: number): BatchRow | undefined {
    return this.db.get<BatchRow>('SELECT * FROM memory_batches WHERE id = ?', id);
  }

  batches(token: string, limit: number): BatchRow[] {
    return this.db.all<BatchRow>('SELECT * FROM memory_batches WHERE token = ? ORDER BY from_seq DESC LIMIT ?', token, limit);
  }

  /** Anchor batches of `token` covering `seqs`, keyed by batch id. */
  batchesById(ids: readonly number[]): Map<number, BatchRow> {
    const out = new Map<number, BatchRow>();
    if (ids.length === 0) return out;
    const rows = this.db.all<BatchRow>(`SELECT * FROM memory_batches WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    for (const r of rows) out.set(r.id, r);
    return out;
  }
}

/** Tick records. */
export class TicksRepo {
  constructor(private readonly db: Db) {}

  start(token: string, requestedModel: string, startedAt: string): number {
    return this.db.run('INSERT INTO ticks (token, started_at, requested_model) VALUES (?, ?, ?)', token, startedAt, requestedModel).lastInsertRowid;
  }

  finish(
    id: number,
    r: { finishedAt: string; servedModel: string | null; iterations: number; costUsdMicro: number; stopReason: string | null; status: string; error: string | null; summary: string | null },
  ): void {
    this.db.run(
      `UPDATE ticks SET finished_at = ?, served_model = ?, iterations = ?, cost_usd_micro = ?, stop_reason = ?, status = ?, error = ?, summary = ?
       WHERE id = ?`,
      r.finishedAt,
      r.servedModel,
      r.iterations,
      r.costUsdMicro,
      r.stopReason,
      r.status,
      r.error,
      r.summary,
      id,
    );
  }

  get(id: number): TickRow | undefined {
    return this.db.get<TickRow>('SELECT * FROM ticks WHERE id = ?', id);
  }

  /** Costs (µUSD) of the last `n` finished ticks of `token`, newest first. */
  recentCosts(token: string, n: number): number[] {
    return this.db
      .all<{ c: number }>("SELECT cost_usd_micro AS c FROM ticks WHERE token = ? AND status != 'running' ORDER BY id DESC LIMIT ?", token, n)
      .map((r) => r.c);
  }

  /** Total cost (µUSD) of ticks of `token` started at or after `sinceIso`. */
  costSince(token: string, sinceIso: string): number {
    return this.db.get<{ c: number | null }>('SELECT sum(cost_usd_micro) AS c FROM ticks WHERE token = ? AND started_at >= ?', token, sinceIso)?.c ?? 0;
  }

  /** Ticks left `running` by a crashed process are closed as `aborted`. */
  closeDangling(at: string): number {
    return this.db.run("UPDATE ticks SET status = 'aborted', finished_at = ?, error = 'runner restarted' WHERE status = 'running'", at).changes;
  }
}

/** Persisted thoughts (R7). */
export class ThoughtsRepo {
  constructor(private readonly db: Db) {}

  insert(token: string, tickId: number, kind: 'aloud' | 'summary', text: string, createdAt: string): ThoughtRow {
    const { lastInsertRowid } = this.db.run('INSERT INTO thoughts (token, tick_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)', token, tickId, kind, text, createdAt);
    return { id: lastInsertRowid, token, tick_id: tickId, kind, text, created_at: createdAt };
  }

  list(token: string, limit: number): ThoughtRow[] {
    return this.db.all<ThoughtRow>('SELECT * FROM thoughts WHERE token = ? ORDER BY id DESC LIMIT ?', token, limit);
  }
}

const LEDGER_SELECT = `SELECT l.*, r.receipt_hash AS receipt_hash, r.status AS receipt_status, r.tx_hash AS receipt_tx
  FROM compute_ledger l LEFT JOIN receipts r ON r.id = l.receipt_id`;

/** Compute ledger (usage per tick and served model) and draw receipts (R2). */
export class ComputeRepo {
  constructor(private readonly db: Db) {}

  /** Adds usage to the `(tickId, model)` line, creating it if needed. */
  addUsage(r: {
    token: string;
    tickId: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsdMicro: number;
    createdAt: string;
  }): void {
    this.db.run(
      `INSERT INTO compute_ledger (token, tick_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_micro, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tick_id, model) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
         cost_usd_micro = cost_usd_micro + excluded.cost_usd_micro`,
      r.token,
      r.tickId,
      r.model,
      r.inputTokens,
      r.outputTokens,
      r.cacheReadTokens,
      r.cacheWriteTokens,
      r.costUsdMicro,
      r.createdAt,
    );
  }

  ledger(token: string, limit: number): LedgerRow[] {
    return this.db.all<LedgerRow>(`${LEDGER_SELECT} WHERE l.token = ? ORDER BY l.tick_id DESC, l.model LIMIT ?`, token, limit);
  }

  /** Lines not attached to any receipt, oldest first. */
  unreceipted(token: string, limit: number): LedgerRow[] {
    return this.db.all<LedgerRow>(`${LEDGER_SELECT} WHERE l.token = ? AND l.receipt_id IS NULL ORDER BY l.tick_id, l.model LIMIT ?`, token, limit);
  }

  /** µUSD spent but not yet settled on-chain (no receipt, or receipt not confirmed). */
  unsettledMicro(token: string): number {
    return (
      this.db.get<{ c: number | null }>(
        `SELECT sum(l.cost_usd_micro) AS c FROM compute_ledger l LEFT JOIN receipts r ON r.id = l.receipt_id
         WHERE l.token = ? AND (l.receipt_id IS NULL OR r.status != 'confirmed')`,
        token,
      )?.c ?? 0
    );
  }

  insertReceipt(r: Omit<ReceiptRow, 'id'>, ledgerIds: readonly number[]): number {
    const id = this.db.run(
      `INSERT INTO receipts (token, receipt_hash, receipt_json, amount_wei, cost_usd_micro, status, tx_hash, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.token,
      r.receipt_hash,
      r.receipt_json,
      r.amount_wei,
      r.cost_usd_micro,
      r.status,
      r.tx_hash,
      r.error,
      r.created_at,
      r.updated_at,
    ).lastInsertRowid;
    for (const lid of ledgerIds) this.db.run('UPDATE compute_ledger SET receipt_id = ? WHERE id = ?', id, lid);
    return id;
  }

  updateReceipt(id: number, status: TxRecordStatus, txHash: string | null, error: string | null, at: string): void {
    this.db.run('UPDATE receipts SET status = ?, tx_hash = coalesce(?, tx_hash), error = ?, updated_at = ? WHERE id = ?', status, txHash, error, at, id);
  }

  /** Detaches the ledger lines of a failed receipt so they are settled again later. */
  releaseReceipt(id: number): void {
    this.db.run('UPDATE compute_ledger SET receipt_id = NULL WHERE receipt_id = ?', id);
  }

  /** Marks the receipt with `receiptHash` as confirmed by an indexed `ComputeDrawn` event. */
  confirmByHash(receiptHash: string, txHash: string, at: string): ReceiptRow | undefined {
    this.db.run("UPDATE receipts SET status = 'confirmed', tx_hash = ?, error = NULL, updated_at = ? WHERE receipt_hash = ?", txHash, at, receiptHash.toLowerCase());
    return this.db.get<ReceiptRow>('SELECT * FROM receipts WHERE receipt_hash = ?', receiptHash.toLowerCase());
  }

  receipts(token: string, limit: number): ReceiptRow[] {
    return this.db.all<ReceiptRow>('SELECT * FROM receipts WHERE token = ? ORDER BY id DESC LIMIT ?', token, limit);
  }

  receiptsWithStatus(status: TxRecordStatus): ReceiptRow[] {
    return this.db.all<ReceiptRow>('SELECT * FROM receipts WHERE status = ? ORDER BY id', status);
  }
}

/** Uploaded metadata JSON (R1). */
export class MetadataRepo {
  constructor(private readonly db: Db) {}

  put(hash: string, json: string, personaHash: string, createdAt: string): void {
    this.db.run('INSERT OR IGNORE INTO metadata (hash, json, persona_hash, created_at) VALUES (?, ?, ?, ?)', hash, json, personaHash, createdAt);
  }

  get(hash: string): { hash: string; json: string; persona_hash: string; created_at: string } | undefined {
    return this.db.get('SELECT * FROM metadata WHERE hash = ?', hash.toLowerCase());
  }
}

/** All repositories over one database. */
export class Repos {
  readonly state: StateRepo;
  readonly events: ChainEventsRepo;
  readonly minds: MindsRepo;
  readonly trades: TradesRepo;
  readonly facts: LedgerEventsRepo;
  readonly memories: MemoriesRepo;
  readonly ticks: TicksRepo;
  readonly thoughts: ThoughtsRepo;
  readonly compute: ComputeRepo;
  readonly metadata: MetadataRepo;

  constructor(readonly db: Db) {
    this.state = new StateRepo(db);
    this.events = new ChainEventsRepo(db);
    this.minds = new MindsRepo(db);
    this.trades = new TradesRepo(db);
    this.facts = new LedgerEventsRepo(db);
    this.memories = new MemoriesRepo(db);
    this.ticks = new TicksRepo(db);
    this.thoughts = new ThoughtsRepo(db);
    this.compute = new ComputeRepo(db);
    this.metadata = new MetadataRepo(db);
  }

  /** Runs `fn` in one transaction. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }
}
