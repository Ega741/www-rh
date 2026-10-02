/**
 * Typed repositories over the runner schema. Wei / uint256 values cross this boundary as decimal
 * strings or bigints, timestamps as unix milliseconds.
 *
 * @module db/repos
 */
import type { Db } from './sqlite.js';

/** Settlement / anchoring status of a runner-originated record. */
export type RecordStatus = 'pending' | 'confirmed' | 'failed' | 'dry_run';

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
  created_block: number;
  created_log_index: number;
  created_at: number;
  last_tick_at: number | null;
  last_tick_ended_at: number | null;
  current_url: string | null;
  last_frame_at: number | null;
  meta_status: 'pending' | 'ok' | 'error';
  meta_image: string | null;
  meta_description: string | null;
  meta_persona: string | null;
  meta_persona_verified: number;
  meta_links: string | null;
  meta_resolved_at: number | null;
  cooling_until: number | null;
  failed_ticks: number;
}

/** `trades` row. */
export interface TradeRow {
  tx_hash: string;
  log_index: number;
  block_number: number;
  timestamp: number;
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

/** `draws` row (indexed `ComputeDrawn`). */
export interface DrawRow {
  tx_hash: string;
  log_index: number;
  block_number: number;
  timestamp: number;
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
  created_at: number;
  content_hash: string;
  tick_id: number | null;
  anchor_id: number | null;
}

/** `memories` row joined with its anchor's tx hash. */
export type MemoryWithAnchor = MemoryRow & { anchor_tx: string | null };

/** `anchors` row. */
export interface AnchorRow {
  id: number;
  token: string;
  from_seq: number;
  to_seq: number;
  content_hash: string;
  uri: string;
  status: RecordStatus;
  tx_hash: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/** `ticks` row joined with its receipt. */
export interface TickRow {
  id: number;
  token: string;
  started_at: number;
  ended_at: number | null;
  requested_model: string;
  served_model: string | null;
  iterations: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd_micro: number;
  stop_reason: string | null;
  status: string;
  error: string | null;
  receipt_id: number | null;
  receipt_hash: string | null;
  receipt_status: RecordStatus | null;
}

/** `thoughts` row. */
export interface ThoughtRow {
  id: number;
  token: string;
  tick_id: number;
  kind: 'aloud' | 'summary';
  text: string;
  created_at: number;
}

/** `receipts` row. */
export interface ReceiptRow {
  id: number;
  token: string;
  receipt_hash: string;
  receipt_json: string;
  amount_wei: string;
  status: RecordStatus;
  tx_hash: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const one = (db: Db, sql: string, ...params: (string | number | null)[]): number => db.get<{ n: number | null }>(sql, ...params)?.n ?? 0;

/** Key/value state of the indexer plus global counters. */
export class StateRepo {
  constructor(private readonly db: Db) {}

  get(key: string): string | undefined {
    return this.db.get<{ value: string }>('SELECT value FROM indexer_state WHERE key = ?', key)?.value;
  }

  set(key: string, value: string): void {
    this.db.run('INSERT INTO indexer_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  /** `last_processed_block`, or `undefined` before the first range. */
  lastBlock(): bigint | undefined {
    const v = this.get('last_processed_block');
    return v === undefined ? undefined : BigInt(v);
  }

  setLastBlock(block: bigint): void {
    this.set('last_processed_block', block.toString(10));
  }

  /** Adds `delta` to a bigint counter stored as a decimal string. */
  addBigint(key: string, delta: bigint): void {
    this.set(key, (this.bigint(key) + delta).toString(10));
  }

  bigint(key: string): bigint {
    return BigInt(this.get(key) ?? '0');
  }
}

/** Idempotency ledger of applied logs and the block-timestamp cache. */
export class ChainRepo {
  constructor(private readonly db: Db) {}

  /** Records the log; `false` if `(txHash, logIndex)` was already applied. */
  insertEvent(txHash: string, logIndex: number, blockNumber: number, event: string, token: string | null): boolean {
    return this.db.run('INSERT OR IGNORE INTO chain_events (tx_hash, log_index, block_number, event, token) VALUES (?, ?, ?, ?, ?)', txHash, logIndex, blockNumber, event, token).changes === 1;
  }

  eventCount(): number {
    return one(this.db, 'SELECT count(*) AS n FROM chain_events');
  }

  blockTimestamp(block: number): number | undefined {
    return this.db.get<{ timestamp: number }>('SELECT timestamp FROM blocks WHERE number = ?', block)?.timestamp;
  }

  putBlockTimestamp(block: number, timestamp: number): void {
    this.db.run('INSERT OR REPLACE INTO blocks (number, timestamp) VALUES (?, ?)', block, timestamp);
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
  createdAt: number;
  priceWei: string;
  mcapSort: number;
}

/** Sort orders of `GET /api/minds` (SPEC §5). */
export type MindSort = 'created' | 'mcap' | 'activity';

const MIND_ORDER: Record<MindSort, string> = {
  created: 'created_at DESC, token ASC',
  mcap: 'mcap_sort DESC, created_at DESC, token ASC',
  activity: 'last_tick_at IS NULL, last_tick_at DESC, created_at DESC, token ASC',
};

/** Resolved metadata fields of a mind. */
export interface MindMetaFields {
  status: 'ok' | 'error';
  image: string | null;
  description: string | null;
  persona: string | null;
  personaVerified: boolean;
  links: string | null;
  at: number;
}

/** Indexed and local state of every mind. */
export class MindsRepo {
  constructor(private readonly db: Db) {}

  insertCreated(m: NewMind): boolean {
    return (
      this.db.run(
        `INSERT OR IGNORE INTO minds (token, creator, name, symbol, metadata_uri, model_id, persona_hash, price_wei, mcap_sort,
           created_block, created_log_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.token, m.creator, m.name, m.symbol, m.metadataUri, m.modelId, m.personaHash, m.priceWei, m.mcapSort, m.blockNumber, m.logIndex, m.createdAt,
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
    return one(this.db, 'SELECT count(*) AS n FROM minds');
  }

  countWhere(column: 'status' | 'phase', value: number): number {
    return one(this.db, `SELECT count(*) AS n FROM minds WHERE ${column} = ?`, value);
  }

  withMetaStatus(status: 'pending' | 'ok' | 'error'): MindRow[] {
    return this.db.all<MindRow>('SELECT * FROM minds WHERE meta_status = ? ORDER BY created_at', status);
  }

  applyTrade(token: string, s: { realEthReserve: string; tokensSold: string; priceWei: string; mcapSort: number }): void {
    this.db.run('UPDATE minds SET real_eth_reserve = ?, tokens_sold = ?, price_wei = ?, mcap_sort = ? WHERE token = ?', s.realEthReserve, s.tokensSold, s.priceWei, s.mcapSort, token);
  }

  /** Phase `Complete`; the price is frozen at the final curve price. */
  setComplete(token: string, realEthReserve: string, priceWei: string, mcapSort: number): void {
    this.db.run('UPDATE minds SET phase = 1, real_eth_reserve = ?, price_wei = ?, mcap_sort = ? WHERE token = ?', realEthReserve, priceWei, mcapSort, token);
  }

  setGraduated(token: string, pool: string, positionId: string): void {
    this.db.run("UPDATE minds SET phase = 2, pool = ?, position_id = ?, real_eth_reserve = '0' WHERE token = ?", pool, positionId, token);
  }

  /** Adds a signed delta to the indexed vault balance. */
  addBalance(token: string, delta: bigint): void {
    const row = this.db.get<{ mind_balance: string }>('SELECT mind_balance FROM minds WHERE token = ?', token);
    if (row === undefined) return;
    const next = BigInt(row.mind_balance) + delta;
    this.db.run('UPDATE minds SET mind_balance = ? WHERE token = ?', (next < 0n ? 0n : next).toString(10), token);
  }

  setStatus(token: string, status: number): void {
    this.db.run('UPDATE minds SET status = ? WHERE token = ?', status, token);
  }

  setConfig(token: string, modelId: string, personaHash: string, metadataUri: string): void {
    this.db.run("UPDATE minds SET model_id = ?, persona_hash = ?, metadata_uri = ?, meta_status = 'pending' WHERE token = ?", modelId, personaHash, metadataUri, token);
  }

  setMetadata(token: string, m: MindMetaFields): void {
    this.db.run(
      `UPDATE minds SET meta_status = ?, meta_image = ?, meta_description = ?, meta_persona = ?, meta_persona_verified = ?, meta_links = ?,
         meta_resolved_at = ? WHERE token = ?`,
      m.status, m.image, m.description, m.persona, m.personaVerified ? 1 : 0, m.links, m.at, token,
    );
  }

  tickStarted(token: string, at: number): void {
    this.db.run('UPDATE minds SET last_tick_at = ? WHERE token = ?', at, token);
  }

  tickEnded(token: string, at: number, failedTicks: number, coolingUntil: number | null): void {
    this.db.run('UPDATE minds SET last_tick_ended_at = ?, failed_ticks = ?, cooling_until = ? WHERE token = ?', at, failedTicks, coolingUntil, token);
  }

  setCurrentUrl(token: string, url: string | null): void {
    this.db.run('UPDATE minds SET current_url = ? WHERE token = ?', url, token);
  }

  setLastFrameAt(token: string, at: number): void {
    this.db.run('UPDATE minds SET last_frame_at = ? WHERE token = ?', at, token);
  }
}

/** Curve trades. */
export class TradesRepo {
  constructor(private readonly db: Db) {}

  insert(t: TradeRow): void {
    this.db.run(
      `INSERT OR IGNORE INTO trades (tx_hash, log_index, block_number, timestamp, token, trader, is_buy, eth_amount, token_amount, fee,
         real_eth_reserve, tokens_sold, price_wei) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.tx_hash, t.log_index, t.block_number, t.timestamp, t.token, t.trader, t.is_buy, t.eth_amount, t.token_amount, t.fee, t.real_eth_reserve, t.tokens_sold, t.price_wei,
    );
  }

  listByToken(token: string, limit: number): TradeRow[] {
    return this.db.all<TradeRow>('SELECT * FROM trades WHERE token = ? ORDER BY block_number DESC, log_index DESC LIMIT ?', token, limit);
  }

  /** Trades of `tokens` with a block timestamp ≥ `sinceMs`. */
  since(tokens: readonly string[], sinceMs: number): TradeRow[] {
    if (tokens.length === 0) return [];
    return this.db.all<TradeRow>(`SELECT * FROM trades WHERE timestamp >= ? AND token IN (${tokens.map(() => '?').join(',')})`, sinceMs, ...tokens);
  }
}

/** Append-only chain facts: fee accruals, fundings, draws, harvests, anchor logs. */
export class FactsRepo {
  constructor(private readonly db: Db) {}

  insertFeeAccrual(r: { txHash: string; logIndex: number; blockNumber: number; token: string; mindAmount: string; protocolAmount: string }): void {
    this.db.run('INSERT OR IGNORE INTO fee_accruals (tx_hash, log_index, block_number, token, mind_amount, protocol_amount) VALUES (?, ?, ?, ?, ?, ?)', r.txHash, r.logIndex, r.blockNumber, r.token, r.mindAmount, r.protocolAmount);
  }

  insertFunding(r: { txHash: string; logIndex: number; blockNumber: number; timestamp: number; token: string; from: string; amount: string }): void {
    this.db.run('INSERT OR IGNORE INTO fundings (tx_hash, log_index, block_number, timestamp, token, from_addr, amount) VALUES (?, ?, ?, ?, ?, ?, ?)', r.txHash, r.logIndex, r.blockNumber, r.timestamp, r.token, r.from, r.amount);
  }

  insertDraw(r: DrawRow): void {
    this.db.run('INSERT OR IGNORE INTO draws (tx_hash, log_index, block_number, timestamp, token, amount, receipt_hash) VALUES (?, ?, ?, ?, ?, ?, ?)', r.tx_hash, r.log_index, r.block_number, r.timestamp, r.token, r.amount, r.receipt_hash);
  }

  draws(token: string, limit: number): DrawRow[] {
    return this.db.all<DrawRow>('SELECT * FROM draws WHERE token = ? ORDER BY block_number DESC, log_index DESC LIMIT ?', token, limit);
  }

  drawByReceiptHash(receiptHash: string): DrawRow | undefined {
    return this.db.get<DrawRow>('SELECT * FROM draws WHERE receipt_hash = ?', receiptHash.toLowerCase());
  }

  insertHarvest(r: { txHash: string; logIndex: number; blockNumber: number; token: string; ethOut: string; tokensBurned: string }): void {
    this.db.run('INSERT OR IGNORE INTO harvests (tx_hash, log_index, block_number, token, eth_out, tokens_burned) VALUES (?, ?, ?, ?, ?, ?)', r.txHash, r.logIndex, r.blockNumber, r.token, r.ethOut, r.tokensBurned);
  }

  insertAnchorLog(r: { txHash: string; logIndex: number; blockNumber: number; token: string; seq: number; contentHash: string; uri: string }): void {
    this.db.run('INSERT OR IGNORE INTO anchor_logs (tx_hash, log_index, block_number, token, seq, content_hash, uri) VALUES (?, ?, ?, ?, ?, ?, ?)', r.txHash, r.logIndex, r.blockNumber, r.token, r.seq, r.contentHash, r.uri);
  }

  anchorLog(token: string, seq: number): { tx_hash: string; content_hash: string; uri: string } | undefined {
    return this.db.get('SELECT tx_hash, content_hash, uri FROM anchor_logs WHERE token = ? AND seq = ? ORDER BY block_number DESC LIMIT 1', token, seq);
  }
}

/** Memories (+ FTS index) and anchor batches. */
export class MemoriesRepo {
  constructor(private readonly db: Db) {}

  lastSeq(token: string): number {
    return one(this.db, 'SELECT max(seq) AS n FROM memories WHERE token = ?', token);
  }

  /** Inserts a memory (caller computes seq + hash inside a transaction). */
  insert(m: Omit<MemoryRow, 'id' | 'anchor_id'>): MemoryRow {
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO memories (token, seq, kind, content, url, created_at, content_hash, tick_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      m.token, m.seq, m.kind, m.content, m.url, m.created_at, m.content_hash, m.tick_id,
    );
    if (this.db.hasFts) this.db.run('INSERT INTO memories_fts (rowid, content, url) VALUES (?, ?, ?)', lastInsertRowid, m.content, m.url ?? '');
    return { ...m, id: lastInsertRowid, anchor_id: null };
  }

  list(token: string, limit: number, beforeSeq?: number): MemoryWithAnchor[] {
    const base = "SELECT m.*, CASE WHEN a.status = 'confirmed' THEN a.tx_hash END AS anchor_tx FROM memories m LEFT JOIN anchors a ON a.id = m.anchor_id WHERE m.token = ?";
    return beforeSeq === undefined
      ? this.db.all<MemoryWithAnchor>(`${base} ORDER BY m.seq DESC LIMIT ?`, token, limit)
      : this.db.all<MemoryWithAnchor>(`${base} AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`, token, beforeSeq, limit);
  }

  range(token: string, fromSeq: number, toSeq: number): MemoryRow[] {
    return this.db.all<MemoryRow>('SELECT * FROM memories WHERE token = ? AND seq BETWEEN ? AND ? ORDER BY seq', token, fromSeq, toSeq);
  }

  recent(token: string, n: number): MemoryRow[] {
    return this.db.all<MemoryRow>('SELECT * FROM memories WHERE token = ? ORDER BY seq DESC LIMIT ?', token, n);
  }

  /** Full-text recall: FTS5 bm25 order when available, else `LIKE` on any term, newest first. */
  search(token: string, query: string, limit: number): MemoryRow[] {
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1)
      .slice(0, 8);
    if (terms.length === 0) return this.recent(token, limit);
    if (this.db.hasFts) {
      const match = terms.map((t) => `"${t}"*`).join(' OR ');
      return this.db.all<MemoryRow>(
        `SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.token = ? ORDER BY bm25(memories_fts), m.seq DESC LIMIT ?`,
        match, token, limit,
      );
    }
    const where = terms.map(() => "(lower(content) LIKE ? ESCAPE '\\' OR lower(coalesce(url, '')) LIKE ? ESCAPE '\\')").join(' OR ');
    const params = terms.flatMap((t) => {
      const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return [like, like];
    });
    return this.db.all<MemoryRow>(`SELECT * FROM memories WHERE token = ? AND (${where}) ORDER BY seq DESC LIMIT ?`, token, ...params, limit);
  }

  /** Memories not covered by an anchor batch, oldest first. */
  unanchored(token: string, limit: number): MemoryRow[] {
    return this.db.all<MemoryRow>('SELECT * FROM memories WHERE token = ? AND anchor_id IS NULL ORDER BY seq LIMIT ?', token, limit);
  }

  insertAnchor(a: Omit<AnchorRow, 'id'>): number {
    const id = this.db.run(
      'INSERT INTO anchors (token, from_seq, to_seq, content_hash, uri, status, tx_hash, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      a.token, a.from_seq, a.to_seq, a.content_hash, a.uri, a.status, a.tx_hash, a.error, a.created_at, a.updated_at,
    ).lastInsertRowid;
    this.db.run('UPDATE memories SET anchor_id = ? WHERE token = ? AND seq BETWEEN ? AND ?', id, a.token, a.from_seq, a.to_seq);
    return id;
  }

  updateAnchor(id: number, status: RecordStatus, txHash: string | null, error: string | null, at: number): void {
    this.db.run('UPDATE anchors SET status = ?, tx_hash = coalesce(?, tx_hash), error = ?, updated_at = ? WHERE id = ?', status, txHash, error, at, id);
  }

  /** Detaches the memories of a failed anchor so they are batched again. */
  releaseAnchor(id: number): void {
    this.db.run('UPDATE memories SET anchor_id = NULL WHERE anchor_id = ?', id);
  }

  anchorsWithStatus(status: RecordStatus): AnchorRow[] {
    return this.db.all<AnchorRow>('SELECT * FROM anchors WHERE status = ? ORDER BY id', status);
  }

  anchorByUri(token: string, uri: string): AnchorRow | undefined {
    return this.db.get<AnchorRow>("SELECT * FROM anchors WHERE token = ? AND uri = ? AND status != 'failed' ORDER BY id DESC LIMIT 1", token, uri);
  }
}

const TICK_SELECT = 'SELECT t.*, r.receipt_hash AS receipt_hash, r.status AS receipt_status FROM ticks t LEFT JOIN receipts r ON r.id = t.receipt_id';

/** Ticks (the per-tick compute ledger), thoughts and draw receipts. */
export class TicksRepo {
  constructor(private readonly db: Db) {}

  start(token: string, requestedModel: string, startedAt: number): number {
    return this.db.run('INSERT INTO ticks (token, started_at, requested_model) VALUES (?, ?, ?)', token, startedAt, requestedModel).lastInsertRowid;
  }

  finish(
    id: number,
    r: {
      endedAt: number; servedModel: string | null; iterations: number; inputTokens: number; outputTokens: number; cacheReadTokens: number;
      cacheWriteTokens: number; costUsdMicro: number; stopReason: string | null; status: string; error: string | null;
    },
  ): void {
    this.db.run(
      `UPDATE ticks SET ended_at = ?, served_model = ?, iterations = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
         cache_write_tokens = ?, cost_usd_micro = ?, stop_reason = ?, status = ?, error = ? WHERE id = ?`,
      r.endedAt, r.servedModel, r.iterations, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens, r.costUsdMicro, r.stopReason, r.status, r.error, id,
    );
  }

  get(id: number): TickRow | undefined {
    return this.db.get<TickRow>(`${TICK_SELECT} WHERE t.id = ?`, id);
  }

  /** Last `limit` ticks of `token`, newest first (the API ledger). */
  ledger(token: string, limit: number): TickRow[] {
    return this.db.all<TickRow>(`${TICK_SELECT} WHERE t.token = ? ORDER BY t.id DESC LIMIT ?`, token, limit);
  }

  /** Costs (µUSD) of the last `n` finished ticks, newest first. */
  recentCosts(token: string, n: number): number[] {
    return this.db.all<{ c: number }>("SELECT cost_usd_micro AS c FROM ticks WHERE token = ? AND status != 'running' ORDER BY id DESC LIMIT ?", token, n).map((r) => r.c);
  }

  /** Σ cost (µUSD) of ticks started at or after `sinceMs`. */
  costSince(token: string, sinceMs: number): number {
    return one(this.db, 'SELECT sum(cost_usd_micro) AS n FROM ticks WHERE token = ? AND started_at >= ?', token, sinceMs);
  }

  /** Σ cost (µUSD) not covered by a confirmed receipt. */
  unsettledMicro(token: string): number {
    return one(
      this.db,
      "SELECT sum(t.cost_usd_micro) AS n FROM ticks t LEFT JOIN receipts r ON r.id = t.receipt_id WHERE t.token = ? AND (t.receipt_id IS NULL OR r.status != 'confirmed')",
      token,
    );
  }

  /** Finished ticks with a positive cost and no receipt or a failed one, in id order. */
  eligibleForSettlement(token: string, limit: number): TickRow[] {
    return this.db.all<TickRow>(
      `${TICK_SELECT} WHERE t.token = ? AND t.status != 'running' AND t.cost_usd_micro > 0 AND (t.receipt_id IS NULL OR r.status = 'failed') ORDER BY t.id LIMIT ?`,
      token, limit,
    );
  }

  /** Ticks left `running` by a crashed process are closed as `aborted`. */
  closeDangling(at: number): number {
    return this.db.run("UPDATE ticks SET status = 'aborted', ended_at = ?, error = 'runner restarted' WHERE status = 'running'", at).changes;
  }

  insertThought(token: string, tickId: number, kind: 'aloud' | 'summary', text: string, createdAt: number): ThoughtRow {
    const { lastInsertRowid } = this.db.run('INSERT INTO thoughts (token, tick_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)', token, tickId, kind, text, createdAt);
    return { id: lastInsertRowid, token, tick_id: tickId, kind, text, created_at: createdAt };
  }

  thoughts(token: string, limit: number): ThoughtRow[] {
    return this.db.all<ThoughtRow>('SELECT * FROM thoughts WHERE token = ? ORDER BY id DESC LIMIT ?', token, limit);
  }

  /** Inserts a receipt and attaches `tickIds` to it. */
  insertReceipt(r: Omit<ReceiptRow, 'id'>, tickIds: readonly number[]): number {
    const id = this.db.run(
      'INSERT INTO receipts (token, receipt_hash, receipt_json, amount_wei, status, tx_hash, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      r.token, r.receipt_hash, r.receipt_json, r.amount_wei, r.status, r.tx_hash, r.error, r.created_at, r.updated_at,
    ).lastInsertRowid;
    for (const t of tickIds) this.db.run('UPDATE ticks SET receipt_id = ? WHERE id = ?', id, t);
    return id;
  }

  updateReceipt(id: number, status: RecordStatus, txHash: string | null, error: string | null, at: number): void {
    this.db.run('UPDATE receipts SET status = ?, tx_hash = coalesce(?, tx_hash), error = ?, updated_at = ? WHERE id = ?', status, txHash, error, at, id);
  }

  receipt(id: number): ReceiptRow | undefined {
    return this.db.get<ReceiptRow>('SELECT * FROM receipts WHERE id = ?', id);
  }

  receiptByHash(receiptHash: string): ReceiptRow | undefined {
    return this.db.get<ReceiptRow>('SELECT * FROM receipts WHERE receipt_hash = ?', receiptHash.toLowerCase());
  }

  receipts(token: string, limit: number): ReceiptRow[] {
    return this.db.all<ReceiptRow>('SELECT * FROM receipts WHERE token = ? ORDER BY id DESC LIMIT ?', token, limit);
  }

  receiptsWithStatus(status: RecordStatus): ReceiptRow[] {
    return this.db.all<ReceiptRow>('SELECT * FROM receipts WHERE status = ? ORDER BY id', status);
  }
}

/** Uploaded metadata documents. */
export class MetadataRepo {
  constructor(private readonly db: Db) {}

  put(hash: string, json: string, personaHash: string, createdAt: number): void {
    this.db.run('INSERT OR IGNORE INTO metadata (hash, json, persona_hash, created_at) VALUES (?, ?, ?, ?)', hash, json, personaHash, createdAt);
  }

  get(hash: string): { hash: string; json: string; persona_hash: string; created_at: number } | undefined {
    return this.db.get('SELECT * FROM metadata WHERE hash = ?', hash.toLowerCase());
  }
}

/** All repositories over one database. */
export class Repos {
  readonly state: StateRepo;
  readonly chain: ChainRepo;
  readonly minds: MindsRepo;
  readonly trades: TradesRepo;
  readonly facts: FactsRepo;
  readonly memories: MemoriesRepo;
  readonly ticks: TicksRepo;
  readonly metadata: MetadataRepo;

  constructor(readonly db: Db) {
    this.state = new StateRepo(db);
    this.chain = new ChainRepo(db);
    this.minds = new MindsRepo(db);
    this.trades = new TradesRepo(db);
    this.facts = new FactsRepo(db);
    this.memories = new MemoriesRepo(db);
    this.ticks = new TicksRepo(db);
    this.metadata = new MetadataRepo(db);
  }

  /** Runs `fn` in one transaction. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }
}
