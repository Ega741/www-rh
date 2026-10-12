/**
 * Burn indexer (SPEC §3.2, §5.4): pages `getSignaturesForAddress(mint)` back to the cursor, fetches
 * each transaction (`jsonParsed`), extracts every `burn` / `burnChecked` of the mint (top-level and
 * inner instructions), resolves the token account owner from `preTokenBalances`, honours the first
 * `beagle:` memo, classifies purchases vs operator draws, prices each event with the published
 * price point at observation and applies it idempotently on `(signature, ixIndex)` — one SQLite
 * transaction per signature, cursor included. The ledger credit for purchases and draws is written
 * here and nowhere else.
 *
 * Paging never loses burns: a walk that hits the page cap (`maxPages`) records the unfetched range
 * as a **backfill gap** in `indexer_state` and keeps draining it on the following polls; a cursor the
 * RPC no longer knows (dropped transaction) is detected by slot and resumed from its slot instead of
 * walking the whole history.
 *
 * `sweepFinality()` reverts events whose signatures the RPC consistently fails to report: a
 * signature seen `finalized` leaves the sweep set; one that is missing is re-checked with
 * `getTransaction` and reverted only after `finalityMisses` consecutive sweeps agree (a single
 * answer from a lagging / snapshot-restarted RPC node must never destroy a credit).
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
  /** Signature pages fetched per walk before the rest is deferred to a backfill gap (default 200). */
  maxPages?: number;
  /** Age after which an event must be found at the RPC or counts as missing (default 120 000 ms). */
  finalityAgeMs?: number;
  /** Slot window of the finality sweep relative to the head (default 3000 ≈ 20 min). */
  finalitySweepSlots?: number;
  /** Signatures checked per sweep (RPC maximum 256). */
  finalityBatch?: number;
  /** Consecutive sweeps that must fail to find a signature before its events are reverted (default 3). */
  finalityMisses?: number;
  now?: () => number;
}

const KEY_LAST_SIGNATURE = 'last_signature';
const KEY_LAST_SLOT = 'last_slot';
const KEY_HEAD_SLOT = 'head_slot';
const KEY_LAST_EVENT_AT = 'last_event_at';
/** JSON list of {@link BackfillGap}s still to drain (newest gap first). */
const KEY_BACKFILL = 'backfill';
/** Default {@link IndexerOptions.maxPages}. */
export const DEFAULT_MAX_PAGES = 200;
/** Default {@link IndexerOptions.finalityMisses}. */
export const DEFAULT_FINALITY_MISSES = 3;

/** A range of the mint's signature history that a capped walk left unfetched: everything older than `before` and newer than `until`. */
export interface BackfillGap {
  /** The oldest signature already fetched: the walk continues with `before = this`. */
  before: string;
  /** The cursor the walk was heading for (exclusive); `undefined` = the beginning of history. */
  until?: string;
  /** Slot of `until` (stops the walk when the RPC no longer knows `until`). */
  untilSlot?: number;
}

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

/** Thrown while applying a transaction when the poll must stop and retry later (the cursor stays before the transaction). */
export class IndexerDeferredError extends Error {
  override readonly name: string = 'IndexerDeferredError';
}

/** Thrown by {@link Indexer.applyParsedTransaction} when no usable price point exists; the poll stops and retries later. */
export class PriceDeferredError extends IndexerDeferredError {
  override readonly name = 'PriceDeferredError';
}

/** Thrown when the owner of a burned token account could not be looked up because the RPC failed (never credit the wrong key on a transient error). */
export class OwnerLookupDeferredError extends IndexerDeferredError {
  override readonly name = 'OwnerLookupDeferredError';
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

/** Result of one signature walk. */
interface Walk {
  /** Pages as fetched (newest first, each page newest first). */
  pages: RpcSignatureInfo[][];
  /** `true` when the walk ended at `until` / the end of history; `false` when the page cap stopped it. */
  reachedUntil: boolean;
  /** The oldest signature fetched (the `before` of a continuation), if any. */
  oldest: string | undefined;
}

/** What a batch application did; `complete` is false when the poll stopped early (retry next poll). */
interface Applied {
  processed: number;
  events: number;
  complete: boolean;
}

/** The indexer. `step()` does one poll; `sweepFinality()` one finality check; `status()` feeds `GET /api/status`. */
export class Indexer {
  private head = 0;
  private readonly now: () => number;
  /** `INDEX_FROM_SIGNATURE` once the RPC confirmed it exists (with its slot). */
  private indexFrom: { signature: string; slot: number } | undefined;

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

  /** Backfill gaps still to drain (SPEC §5.4 paging never skips burns). */
  backfillGaps(): BackfillGap[] {
    const raw = this.repos.indexerState.get(KEY_BACKFILL);
    if (raw === undefined) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed.filter((g) => isRecord(g) && typeof g['before'] === 'string') as unknown as BackfillGap[]) : [];
    } catch {
      return [];
    }
  }

  private saveGaps(gaps: readonly BackfillGap[]): void {
    if (gaps.length === 0) this.repos.indexerState.delete(KEY_BACKFILL);
    else this.repos.indexerState.set(KEY_BACKFILL, JSON.stringify(gaps));
  }

  /**
   * Pages backwards from `before` (or the head) towards `until`, at most `maxPages` pages. When the
   * RPC no longer knows `until` (a dropped cursor transaction) it would return the whole history:
   * entries older than `untilSlot` are cut off instead and the walk counts as complete.
   */
  private async walk(range: { until: string | undefined; untilSlot: number | null | undefined; before?: string }): Promise<Walk> {
    const maxPages = Math.max(1, this.options.maxPages ?? DEFAULT_MAX_PAGES);
    const pages: RpcSignatureInfo[][] = [];
    let before = range.before;
    let oldest: string | undefined;
    for (let n = 0; n < maxPages; n++) {
      let page = await this.reader.getSignaturesForAddress(this.options.mint, {
        limit: this.options.pageLimit,
        ...(before === undefined ? {} : { before }),
        ...(range.until === undefined ? {} : { until: range.until }),
      });
      if (page.length === 0) return { pages, reachedUntil: true, oldest };
      if (range.until !== undefined && range.untilSlot !== null && range.untilSlot !== undefined && page.some((s) => s.slot < (range.untilSlot as number))) {
        // The RPC paged past the cursor's slot without stopping at `until`: it does not know that signature
        // (dropped at finality, or missing from this node's history). Resume from the cursor's slot.
        const untilSlot = range.untilSlot;
        page = page.filter((s) => s.slot >= untilSlot);
        this.logger.warn('indexer: cursor signature unknown to the RPC; resuming from its slot', { until: range.until, untilSlot });
        if (page.length > 0) {
          pages.push(page);
          oldest = page[page.length - 1]?.signature;
        }
        return { pages, reachedUntil: true, oldest };
      }
      pages.push(page);
      oldest = page[page.length - 1]?.signature;
      if (range.until === undefined || page.length < this.options.pageLimit) return { pages, reachedUntil: true, oldest };
      before = oldest;
    }
    return { pages, reachedUntil: false, oldest };
  }

  /** Signatures newer than the cursor, oldest first (the newest `pageLimit` only on a fresh database). */
  async collectSignatures(): Promise<RpcSignatureInfo[]> {
    const walk = await this.walk({ until: this.lastSignature() ?? this.options.indexFromSignature, untilSlot: this.lastSlot() ?? this.indexFrom?.slot });
    return walk.pages.flat().reverse();
  }

  /** On a fresh database with `INDEX_FROM_SIGNATURE`: refuse to walk the whole history behind a signature the RPC does not know. */
  private async checkIndexFrom(): Promise<boolean> {
    const from = this.options.indexFromSignature;
    if (from === undefined || this.lastSignature() !== undefined) return true;
    if (this.indexFrom?.signature === from) return true;
    const [status] = await this.reader.getSignatureStatuses([from]);
    if (status === null || status === undefined) {
      this.logger.error('indexer: INDEX_FROM_SIGNATURE is unknown to the RPC; not indexing until it is (typo, or a node without that history?)', { indexFromSignature: from });
      return false;
    }
    this.indexFrom = { signature: from, slot: status.slot };
    return true;
  }

  /** One poll: drain a backfill gap (if any), fetch the signatures after the cursor, apply them oldest first, advance the cursor. */
  async step(): Promise<{ processed: number; events: number } | undefined> {
    this.head = await this.reader.getSlot();
    this.repos.indexerState.set(KEY_HEAD_SLOT, String(this.head));
    if (!(await this.checkIndexFrom())) return undefined;
    let processed = 0;
    let events = 0;
    let didSomething = false;

    const gap = this.backfillGaps()[0];
    if (gap !== undefined) {
      const r = await this.backfill(gap);
      processed += r.processed;
      events += r.events;
      didSomething = true;
    }

    const until = this.lastSignature() ?? this.options.indexFromSignature;
    const cursorSlot = this.lastSlot() ?? this.indexFrom?.slot ?? null;
    const walk = await this.walk({ until, untilSlot: cursorSlot });
    const signatures = walk.pages.flat().reverse();
    if (signatures.length > 0) {
      didSomething = true;
      const r = await this.apply(signatures, true);
      processed += r.processed;
      events += r.events;
      if (!walk.reachedUntil && r.processed > 0 && walk.oldest !== undefined) {
        // The cursor is now at or past the oldest fetched signature: everything between it and the old
        // cursor is still unindexed and unreachable from the head — remember it and drain it on later polls.
        const newGap: BackfillGap = { before: walk.oldest, ...(until === undefined ? {} : { until }), ...(cursorSlot === null ? {} : { untilSlot: cursorSlot }) };
        this.saveGaps([newGap, ...this.backfillGaps()]);
        this.logger.error('indexer: page cap reached; older signatures queued for backfill', { ...newGap, maxPages: this.options.maxPages ?? DEFAULT_MAX_PAGES, pageLimit: this.options.pageLimit });
      }
    }
    if (!didSomething) return undefined;
    if (events > 0) this.logger.info('indexed burns', { events, processed, head: this.head });
    return { processed, events };
  }

  /** Drains up to `maxPages` pages of `gap` (older history: applied without moving the cursor). */
  private async backfill(gap: BackfillGap): Promise<Applied> {
    const walk = await this.walk({ until: gap.until, untilSlot: gap.untilSlot, before: gap.before });
    const signatures = walk.pages.flat().reverse();
    const r = signatures.length === 0 ? { processed: 0, events: 0, complete: true } : await this.apply(signatures, false);
    if (r.complete) {
      const rest = this.backfillGaps().filter((g) => g.before !== gap.before || g.until !== gap.until);
      if (walk.reachedUntil || walk.oldest === undefined) {
        this.saveGaps(rest);
        this.logger.info('indexer: backfill gap drained', { before: gap.before, until: gap.until ?? null, processed: r.processed, events: r.events });
      } else {
        this.saveGaps([{ ...gap, before: walk.oldest }, ...rest]);
      }
    }
    return r;
  }

  /** Applies `signatures` (oldest first), `fetchConcurrency` at a time; `moveCursor` advances `last_signature` per signature (head walk only). */
  private async apply(signatures: readonly RpcSignatureInfo[], moveCursor: boolean): Promise<Applied> {
    let processed = 0;
    let events = 0;
    const concurrency = Math.max(1, this.options.fetchConcurrency);
    for (let i = 0; i < signatures.length; i += concurrency) {
      const chunk = signatures.slice(i, i + concurrency);
      const txs = await Promise.all(chunk.map((info) => (info.err === null || info.err === undefined ? this.reader.getParsedTransaction(info.signature) : Promise.resolve(null))));
      for (let j = 0; j < chunk.length; j++) {
        const info = chunk[j] as RpcSignatureInfo;
        const tx = txs[j] ?? null;
        if (info.err !== null && info.err !== undefined) {
          if (moveCursor) this.advance(info);
          processed++;
          continue;
        }
        if (tx === null) {
          this.logger.warn('indexer: transaction not available at the commitment yet; retrying next poll', { signature: info.signature, slot: info.slot });
          return { processed, events, complete: false };
        }
        try {
          events += moveCursor ? await this.applySignature(info, tx) : await this.applyParsedTransaction(info.signature, tx);
        } catch (e) {
          if (e instanceof IndexerDeferredError) {
            this.logger.warn('indexer: deferring the rest of the poll', { signature: info.signature, reason: e.message });
            return { processed, events, complete: false };
          }
          throw e;
        }
        processed++;
      }
    }
    return { processed, events, complete: true };
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

  /** Applies one parsed transaction (idempotent). Public for tests and backfills; `applySignature` also moves the cursor. */
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

  /** The owner from `getAccountInfo`; `null` when the account is gone; defers the poll when the RPC fails (SPEC §3.2 credits the owner, never a guess). */
  private async fetchOwner(tokenAccount: string): Promise<string | null> {
    let account;
    try {
      [account] = await this.reader.getMultipleParsedAccounts([tokenAccount]);
    } catch (e) {
      this.logger.warn('indexer: owner lookup failed; retrying next poll', { tokenAccount, error: e });
      throw new OwnerLookupDeferredError(`owner lookup of ${tokenAccount} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const parsed = account?.data?.parsed;
    if (isRecord(parsed) && isRecord(parsed['info']) && typeof parsed['info']['owner'] === 'string') return parsed['info']['owner'];
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
        const price = this.currentPrice();
        priceE18 = price.priceE18;
        pricePointId = price.id;
        priceStale = price.stale;
        usdMicro = quoteUsdMicro(burn.amount, priceE18, this.options.decimals);
        if (usdMicro < this.options.minCreditMicro) usdMicro = 0n;
        if (p.parsedMemo?.kind === 'purchase') workspace = p.parsedMemo.workspace;
        else if (owner !== null) workspace = owner;
        else if (burn.authority !== null) {
          // The account is gone (closed in the same transaction) and the balances do not name its owner: the
          // burn authority is the owner in every ordinary burn; a third-party delegate burn is the rare exception.
          workspace = burn.authority;
          this.logger.warn('owner_unresolved', { signature: p.signature, ixIndex: burn.ixIndex, tokenAccount: burn.tokenAccount, creditedTo: 'authority', workspace });
        } else {
          // Nobody to credit: record the burn with no credit instead of inventing a workspace from the account address.
          workspace = burn.tokenAccount;
          usdMicro = 0n;
          this.logger.warn('owner_unresolved', { signature: p.signature, ixIndex: burn.ixIndex, tokenAccount: burn.tokenAccount, creditedTo: 'none' });
        }
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
   * Finality sweep: events older than `finalityAgeMs` within the last `finalitySweepSlots` slots that
   * were not yet seen `finalized`. A signature reported finalized without error is marked and never
   * re-checked; one reported with an error or not at all is re-fetched with `getTransaction` and, when
   * that fails to show it successful too, counts as one miss — `finalityMisses` consecutive misses
   * revert its events (credit events and ledger rows deleted; a reverted draw goes back to `failed`
   * and releases its usage rows). Any successful sighting in between resets the counter.
   */
  async sweepFinality(): Promise<{ checked: number; reverted: string[]; finalized: number }> {
    const ageMs = this.options.finalityAgeMs ?? 120_000;
    const windowSlots = this.options.finalitySweepSlots ?? 3000;
    const batch = Math.min(256, this.options.finalityBatch ?? 256);
    const threshold = Math.max(1, this.options.finalityMisses ?? DEFAULT_FINALITY_MISSES);
    const head = this.head > 0 ? this.head : await this.reader.getSlot();
    const now = this.now();
    const candidates = this.repos.creditEvents.signaturesForSweep(Math.max(0, head - windowSlots), now - ageMs, batch);
    if (candidates.length === 0) return { checked: 0, reverted: [], finalized: 0 };
    const statuses = await this.reader.getSignatureStatuses(candidates.map((c) => c.signature));
    const reverted: string[] = [];
    let finalized = 0;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i] as (typeof candidates)[number];
      const status = statuses[i] ?? null;
      if (status !== null && (status.err === null || status.err === undefined)) {
        if (status.confirmationStatus === 'finalized') {
          this.repos.creditEvents.markFinalized(c.signature, now);
          finalized++;
        } else if (c.misses > 0) this.repos.creditEvents.setFinalityMisses(c.signature, 0);
        continue;
      }
      // Not found (or reported failed): ask again by another route before counting a miss.
      let tx: RpcParsedTransaction | null;
      try {
        tx = await this.reader.getParsedTransaction(c.signature);
      } catch (e) {
        this.logger.warn('finality_check_failed', { signature: c.signature, slot: c.slot, error: e });
        continue;
      }
      if (tx !== null && (tx.meta?.err === null || tx.meta?.err === undefined)) {
        if (c.misses > 0) this.repos.creditEvents.setFinalityMisses(c.signature, 0);
        continue;
      }
      const misses = c.misses + 1;
      const reason = status === null ? 'signature not found at finalized' : 'transaction failed';
      if (misses < threshold) {
        this.repos.creditEvents.setFinalityMisses(c.signature, misses);
        this.logger.warn('finality_miss', { signature: c.signature, slot: c.slot, misses, threshold, reason });
        continue;
      }
      const n = this.revertSignature(c.signature);
      if (n > 0) reverted.push(c.signature);
      this.logger.warn('finality_revert', { signature: c.signature, slot: c.slot, events: n, misses, reason });
    }
    return { checked: candidates.length, reverted, finalized };
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
