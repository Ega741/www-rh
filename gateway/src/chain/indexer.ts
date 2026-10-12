/**
 * Burn indexer (SPEC §3.2, §5.4): pages `getSignaturesForAddress(mint)` back to the cursor, fetches
 * each transaction (`jsonParsed`), extracts every `burn` / `burnChecked` of the mint (top-level and
 * inner instructions), resolves the token account owner from `preTokenBalances`, honours the first
 * `beagle:` memo, classifies purchases vs operator draws, prices each event with the published
 * price point at observation and applies it idempotently on `(signature, ixIndex)` — one SQLite
 * transaction per signature, cursor included. The ledger credit for purchases and draws is written
 * here and nowhere else. `sweepFinality()` reverts events whose signatures the RPC no longer knows.
 *
 * @module chain/indexer
 */
import type { DrawBatchWire, IndexerStatusDto } from '@beagle/shared/api';
import { quoteUsdMicro } from '@beagle/shared/credit';
import { isBeagleMemo, parseMemo, type ParsedMemo } from '@beagle/shared/memo';
import { isBurnInstructionType, MEMO_PROGRAM_PARSED_NAME, TOKEN_PROGRAM_PARSED_NAMES, type BurnInstructionType } from '@beagle/shared/solana';
import type { Repos } from '../db/repos.js';
import type { Logger } from '../log.js';
import type { PriceService, PriceSnapshot } from './price.js';
import type { ChainReader, RpcInstruction, RpcParsedTransaction, RpcSignatureInfo } from './rpc.js';

/** Options of {@link Indexer}. */
export interface IndexerOptions {
  mint: string;
  /** The draw authority; `undefined` → every burn is a purchase. */
  operator: string | undefined;
  decimals: number;
  /** `INDEX_PAGE_LIMIT` (≤ 1000). */
  pageLimit: number;
  /** `TX_FETCH_CONCURRENCY`. */
  fetchConcurrency: number;
  /** `INDEX_FROM_SIGNATURE`: on an empty cursor, index only burns after it. */
  indexFromSignature: string | undefined;
  /** `CREDIT_WHEN_STALE`. */
  creditWhenStale: boolean;
  /** `MIN_CREDIT_USD` in µUSD (dust guard). */
  minCreditMicro: bigint;
  /** Age after which an event must be found at the RPC or is reverted (default 120 000 ms). */
  finalityAgeMs?: number;
  /** Slot window of the finality sweep relative to the head (default 3000 ≈ 20 min). */
  finalitySweepSlots?: number;
  /** Signatures checked per sweep (RPC maximum 256). */
  finalityBatch?: number;
  now?: () => number;
}

const KEY_LAST_SIGNATURE = 'last_signature';
const KEY_LAST_SLOT = 'last_slot';
const KEY_HEAD_SLOT = 'head_slot';
const KEY_LAST_EVENT_AT = 'last_event_at';
/** Hard cap on signature pages collected in one poll (RPC paging safety). */
const MAX_PAGES = 200;

/** One burn instruction of the mint found in a transaction. */
export interface BurnInstruction {
  /** Position in the flattened instruction list (top-level, then its inner instructions, in order). */
  ixIndex: number;
  program: string;
  type: BurnInstructionType;
  tokenAccount: string;
  authority: string | null;
  amount: bigint;
}

/** Thrown by {@link Indexer.applyParsedTransaction} when no usable price point exists; the poll stops and retries later. */
export class PriceDeferredError extends Error {
  override readonly name = 'PriceDeferredError';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Top-level instructions each followed by their inner instructions, in execution order. */
export function flattenInstructions(tx: RpcParsedTransaction): RpcInstruction[] {
  const inner = new Map<number, RpcInstruction[]>();
  for (const group of tx.meta?.innerInstructions ?? []) inner.set(group.index, group.instructions);
  const out: RpcInstruction[] = [];
  tx.transaction.message.instructions.forEach((ix, i) => {
    out.push(ix);
    for (const sub of inner.get(i) ?? []) out.push(sub);
  });
  return out;
}

/** Every `burn` / `burnChecked` of `mint` in `tx` (top-level and inner), with its flattened index. */
export function extractBurns(tx: RpcParsedTransaction, mint: string): BurnInstruction[] {
  const out: BurnInstruction[] = [];
  flattenInstructions(tx).forEach((ix, ixIndex) => {
    if (ix.program === undefined || !(TOKEN_PROGRAM_PARSED_NAMES as readonly string[]).includes(ix.program)) return;
    if (!isRecord(ix.parsed) || !isBurnInstructionType(ix.parsed['type']) || !isRecord(ix.parsed['info'])) return;
    const info = ix.parsed['info'];
    if (info['mint'] !== mint || typeof info['account'] !== 'string') return;
    const raw = ix.parsed['type'] === 'burnChecked' ? (isRecord(info['tokenAmount']) ? info['tokenAmount']['amount'] : undefined) : info['amount'];
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return;
    const authority = typeof info['authority'] === 'string' ? info['authority'] : typeof info['multisigAuthority'] === 'string' ? info['multisigAuthority'] : null;
    out.push({ ixIndex, program: ix.program, type: ix.parsed['type'], tokenAccount: info['account'], authority, amount: BigInt(raw) });
  });
  return out;
}

/** The memo honoured for `tx`: the first `beagle:` memo, else the first memo at all, else `null`. */
export function extractMemo(tx: RpcParsedTransaction): string | null {
  const memos = flattenInstructions(tx)
    .filter((ix) => ix.program === MEMO_PROGRAM_PARSED_NAME && typeof ix.parsed === 'string')
    .map((ix) => ix.parsed as string);
  return memos.find(isBeagleMemo) ?? memos[0] ?? null;
}

/** The owner of `tokenAccount` from `meta.preTokenBalances` (falls back to `postTokenBalances`), or `undefined`. */
export function resolveOwner(tx: RpcParsedTransaction, tokenAccount: string): string | undefined {
  const keys = tx.transaction.message.accountKeys;
  for (const balances of [tx.meta?.preTokenBalances, tx.meta?.postTokenBalances]) {
    for (const b of balances ?? []) {
      if (keys[b.accountIndex]?.pubkey === tokenAccount && typeof b.owner === 'string') return b.owner;
    }
  }
  return undefined;
}

/** The indexer. `step()` does one poll; `sweepFinality()` one finality check; `status()` feeds `GET /api/status`. */
export class Indexer {
  private head = 0;
  private readonly now: () => number;

  constructor(
    private readonly repos: Repos,
    private readonly reader: ChainReader,
    private readonly price: PriceService,
    private readonly options: IndexerOptions,
    private readonly logger: Logger,
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** The newest processed signature (the `until` of the next poll), or `undefined` on an empty database. */
  lastSignature(): string | undefined {
    return this.repos.indexerState.get(KEY_LAST_SIGNATURE);
  }

  private lastSlot(): number | null {
    const v = this.repos.indexerState.get(KEY_LAST_SLOT);
    return v === undefined ? null : Number(v);
  }

  /** `{ lastSignature, lastSlot, headSlot, lagSlots, lastEventAt }`. */
  status(): IndexerStatusDto {
    const lastSlot = this.lastSlot();
    const lastEventAt = this.repos.indexerState.get(KEY_LAST_EVENT_AT);
    const storedHead = this.repos.indexerState.get(KEY_HEAD_SLOT);
    const headSlot = Math.max(this.head, storedHead === undefined ? 0 : Number(storedHead));
    return {
      lastSignature: this.lastSignature() ?? null,
      lastSlot,
      headSlot,
      lagSlots: lastSlot === null ? 0 : Math.max(0, headSlot - lastSlot),
      lastEventAt: lastEventAt === undefined ? null : Number(lastEventAt),
    };
  }

  /** Signatures newer than the cursor, oldest first (the newest `pageLimit` only on a fresh database). */
  async collectSignatures(): Promise<RpcSignatureInfo[]> {
    const until = this.lastSignature() ?? this.options.indexFromSignature;
    const pages: RpcSignatureInfo[][] = [];
    let before: string | undefined;
    for (let n = 0; n < MAX_PAGES; n++) {
      const page = await this.reader.getSignaturesForAddress(this.options.mint, {
        limit: this.options.pageLimit,
        ...(before === undefined ? {} : { before }),
        ...(until === undefined ? {} : { until }),
      });
      if (page.length === 0) break;
      pages.push(page);
      if (until === undefined || page.length < this.options.pageLimit) break;
      before = page[page.length - 1]?.signature;
    }
    return pages.flat().reverse();
  }

  /** One poll: fetch the signatures after the cursor, apply them oldest first, advance the cursor. */
  async step(): Promise<{ processed: number; events: number } | undefined> {
    this.head = await this.reader.getSlot();
    this.repos.indexerState.set(KEY_HEAD_SLOT, String(this.head));
    const signatures = await this.collectSignatures();
    if (signatures.length === 0) return undefined;
    let processed = 0;
    let events = 0;
    const concurrency = Math.max(1, this.options.fetchConcurrency);
    outer: for (let i = 0; i < signatures.length; i += concurrency) {
      const chunk = signatures.slice(i, i + concurrency);
      const txs = await Promise.all(chunk.map((info) => (info.err === null || info.err === undefined ? this.reader.getParsedTransaction(info.signature) : Promise.resolve(null))));
      for (let j = 0; j < chunk.length; j++) {
        const info = chunk[j] as RpcSignatureInfo;
        const tx = txs[j] ?? null;
        if (info.err !== null && info.err !== undefined) {
          this.advance(info);
          processed++;
          continue;
        }
        if (tx === null) {
          this.logger.warn('indexer: transaction not available at the commitment yet; retrying next poll', { signature: info.signature, slot: info.slot });
          break outer;
        }
        try {
          events += await this.applySignature(info, tx);
        } catch (e) {
          if (e instanceof PriceDeferredError) {
            this.logger.warn('indexer: no usable price point; deferring burns', { signature: info.signature, reason: e.message });
            break outer;
          }
          throw e;
        }
        processed++;
      }
    }
    if (events > 0) this.logger.info('indexed burns', { events, processed, head: this.head });
    return { processed, events };
  }

  private advance(info: RpcSignatureInfo): void {
    this.repos.indexerState.set(KEY_LAST_SIGNATURE, info.signature);
    this.repos.indexerState.set(KEY_LAST_SLOT, String(info.slot));
  }

  /** Applies `tx` and moves the cursor past it in one database transaction. */
  async applySignature(info: RpcSignatureInfo, tx: RpcParsedTransaction): Promise<number> {
    const prepared = await this.prepare(info.signature, tx);
    return this.repos.transaction(() => {
      const n = this.applyPrepared(prepared);
      this.advance(info);
      return n;
    });
  }

  /** Applies one parsed transaction (idempotent). Public for tests; `applySignature` also moves the cursor. */
  async applyParsedTransaction(signature: string, tx: RpcParsedTransaction): Promise<number> {
    const prepared = await this.prepare(signature, tx);
    return this.repos.transaction(() => this.applyPrepared(prepared));
  }

  private async prepare(signature: string, tx: RpcParsedTransaction): Promise<PreparedTransaction> {
    const burns = tx.meta?.err === null || tx.meta?.err === undefined ? extractBurns(tx, this.options.mint) : [];
    const owners = new Map<string, string | null>();
    for (const burn of burns) {
      if (owners.has(burn.tokenAccount)) continue;
      let owner = resolveOwner(tx, burn.tokenAccount) ?? null;
      if (owner === null) owner = await this.fetchOwner(burn.tokenAccount);
      owners.set(burn.tokenAccount, owner);
    }
    const memo = burns.length === 0 ? null : extractMemo(tx);
    return { signature, slot: tx.slot, blockTime: tx.blockTime ?? null, burns, owners, memo, parsedMemo: parseMemo(memo) };
  }

  private async fetchOwner(tokenAccount: string): Promise<string | null> {
    try {
      const [account] = await this.reader.getMultipleParsedAccounts([tokenAccount]);
      const parsed = account?.data?.parsed;
      if (isRecord(parsed) && isRecord(parsed['info']) && typeof parsed['info']['owner'] === 'string') return parsed['info']['owner'];
    } catch (e) {
      this.logger.warn('indexer: owner lookup failed', { tokenAccount, error: e });
    }
    return null;
  }

  private currentPrice(): PriceSnapshot {
    const price = this.price.current();
    if (price === undefined) throw new PriceDeferredError('no price point published yet');
    if (price.stale && !this.options.creditWhenStale) throw new PriceDeferredError('price is stale and CREDIT_WHEN_STALE=false');
    return price;
  }

  private applyPrepared(p: PreparedTransaction): number {
    let applied = 0;
    const now = this.now();
    for (const burn of p.burns) {
      if (this.repos.creditEvents.exists(p.signature, burn.ixIndex)) continue;
      const owner = p.owners.get(burn.tokenAccount) ?? null;
      const draw = this.classifyDraw(p.parsedMemo, burn);
      let workspace: string;
      let priceE18: bigint;
      let pricePointId: number | null;
      let priceStale = false;
      let usdMicro: bigint;
      let receiptHash: string | null = null;
      let kind: 'purchase' | 'draw' = 'purchase';
      if (draw !== undefined) {
        kind = 'draw';
        workspace = draw.memo.workspace;
        receiptHash = draw.memo.receiptHash;
        if (draw.batch !== undefined) {
          priceE18 = draw.batch.priceE18;
          pricePointId = draw.batch.pricePointId;
        } else {
          const price = this.currentPrice();
          priceE18 = price.priceE18;
          pricePointId = price.id;
          priceStale = price.stale;
          this.logger.warn('orphan_draw', { signature: p.signature, ixIndex: burn.ixIndex, receiptHash, workspace });
        }
        usdMicro = quoteUsdMicro(burn.amount, priceE18, this.options.decimals);
      } else {
        workspace = p.parsedMemo?.kind === 'purchase' ? p.parsedMemo.workspace : (owner ?? burn.authority ?? burn.tokenAccount);
        const price = this.currentPrice();
        priceE18 = price.priceE18;
        pricePointId = price.id;
        priceStale = price.stale;
        usdMicro = quoteUsdMicro(burn.amount, priceE18, this.options.decimals);
        if (usdMicro < this.options.minCreditMicro) usdMicro = 0n;
      }
      this.repos.workspaces.ensure(workspace, now);
      this.repos.creditEvents.insert({
        signature: p.signature,
        ixIndex: burn.ixIndex,
        kind,
        workspace,
        payer: owner,
        tokenAccount: burn.tokenAccount,
        authority: burn.authority,
        tokenAmount: burn.amount,
        usdMicro,
        priceE18,
        pricePointId,
        priceStale,
        memo: p.memo,
        receiptHash,
        slot: p.slot,
        blockTime: p.blockTime,
        createdAt: now,
      });
      const refId = `${p.signature}:${burn.ixIndex}`;
      if (usdMicro > 0n && !this.repos.ledger.hasRef('credit_event', refId)) {
        this.repos.ledger.insert({ workspace, kind: 'credit', amountMicro: usdMicro, refType: 'credit_event', refId, memo: kind === 'draw' ? 'budget draw' : 'burn', createdAt: now });
      }
      if (draw?.row !== undefined) {
        this.repos.budgetDraws.setStatus(draw.row.id, 'confirmed', now, { signature: p.signature, error: null });
        // The draw settled exactly these rows: (re-)mark them so a draw the drawer had given up on can never be drawn twice.
        this.repos.usage.claimDrawId(draw.row.usageIds, draw.row.id);
        this.logger.info('draw confirmed', { signature: p.signature, drawId: draw.row.id, workspace, usdMicro: usdMicro.toString() });
      }
      this.repos.indexerState.set(KEY_LAST_EVENT_AT, String(now));
      applied++;
    }
    return applied;
  }

  /** A draw memo signed by the operator → the matching `budget_draws` row (if any) and its batch. */
  private classifyDraw(memo: ParsedMemo | undefined, burn: BurnInstruction): { memo: ParsedMemo & { kind: 'draw' }; row: { id: number; usageIds: string[] } | undefined; batch: { priceE18: bigint; pricePointId: number } | undefined } | undefined {
    if (memo?.kind !== 'draw' || this.options.operator === undefined || burn.authority !== this.options.operator) return undefined;
    const row = this.repos.budgetDraws.byReceiptHash(memo.receiptHash);
    if (row === undefined) return { memo, row: undefined, batch: undefined };
    let batch: { priceE18: bigint; pricePointId: number } | undefined;
    try {
      const parsed = JSON.parse(row.batchJson) as Partial<DrawBatchWire>;
      if (typeof parsed.priceE18 === 'string' && /^\d+$/.test(parsed.priceE18) && typeof parsed.pricePointId === 'number') {
        batch = { priceE18: BigInt(parsed.priceE18), pricePointId: parsed.pricePointId };
      }
    } catch {
      batch = undefined;
    }
    return { memo, row: { id: row.id, usageIds: row.usageIds }, batch };
  }

  /**
   * Finality sweep: events older than `finalityAgeMs` within the last `finalitySweepSlots` slots whose
   * signature the RPC no longer knows (or reports as failed) are reverted: credit events and their
   * ledger rows are deleted; a reverted draw goes back to `failed` and releases its usage rows.
   */
  async sweepFinality(): Promise<{ checked: number; reverted: string[] }> {
    const ageMs = this.options.finalityAgeMs ?? 120_000;
    const windowSlots = this.options.finalitySweepSlots ?? 3000;
    const batch = Math.min(256, this.options.finalityBatch ?? 256);
    const head = this.head > 0 ? this.head : await this.reader.getSlot();
    const candidates = this.repos.creditEvents.signaturesForSweep(Math.max(0, head - windowSlots), this.now() - ageMs, batch);
    if (candidates.length === 0) return { checked: 0, reverted: [] };
    const statuses = await this.reader.getSignatureStatuses(candidates.map((c) => c.signature));
    const reverted: string[] = [];
    candidates.forEach((c, i) => {
      const status = statuses[i] ?? null;
      if (status !== null && (status.err === null || status.err === undefined)) return;
      const n = this.revertSignature(c.signature);
      if (n > 0) reverted.push(c.signature);
      this.logger.warn('finality_revert', { signature: c.signature, slot: c.slot, events: n, reason: status === null ? 'signature not found at finalized' : 'transaction failed' });
    });
    return { checked: candidates.length, reverted };
  }

  /** Deletes every event of `signature` with its ledger rows; reverted draws become `failed`. Returns the events removed. */
  revertSignature(signature: string): number {
    return this.repos.transaction(() => {
      const rows = this.repos.creditEvents.listBySignature(signature);
      if (rows.length === 0) return 0;
      const now = this.now();
      this.repos.ledger.deleteByRefs(
        'credit_event',
        rows.map((r) => `${r.signature}:${r.ixIndex}`),
      );
      for (const row of rows) {
        if (row.kind !== 'draw' || row.receiptHash === null) continue;
        const draw = this.repos.budgetDraws.byReceiptHash(row.receiptHash);
        if (draw === undefined || draw.status !== 'confirmed') continue;
        this.repos.budgetDraws.setStatus(draw.id, 'failed', now, { error: 'transaction dropped before finality' });
        this.repos.usage.clearDrawId(draw.usageIds, draw.id);
        this.repos.budgets.setStalled(draw.tokenAccount, 'draw_failed', now);
      }
      return this.repos.creditEvents.deleteBySignature(signature);
    });
  }
}

interface PreparedTransaction {
  signature: string;
  slot: number;
  blockTime: number | null;
  burns: BurnInstruction[];
  owners: Map<string, string | null>;
  memo: string | null;
  parsedMemo: ParsedMemo | undefined;
}
