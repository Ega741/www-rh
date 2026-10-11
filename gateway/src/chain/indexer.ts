/**
 * CreditDesk indexer (SPEC §5.4): polls `getLogs` in chunks from `last_block + 1` to
 * `head − CONFIRMATIONS`, applies the four events idempotently inside one transaction per chunk,
 * and guards against reorgs by comparing the stored hash of `last_block` before every step.
 * The ledger credit for purchases and draws is written here and nowhere else.
 *
 * @module chain/indexer
 */
import type { IndexerStatusDto } from '@beagle/shared/api';
import type { Address, Hex } from 'viem';
import type { Repos } from '../db/repos.js';
import type { Logger } from '../log.js';
import type { ChainReader, DeskLog } from './clients.js';

/** Options of {@link Indexer}. */
export interface IndexerOptions {
  creditDesk: Address;
  /** First block to index on an empty database. */
  startBlock: number;
  confirmations: number;
  chunkBlocks: number;
  now?: () => number;
}

/** Extra blocks rewound on a reorg (`R = CONFIRMATIONS + 10`). */
export const REORG_EXTRA_BLOCKS = 10;

const KEY_LAST_BLOCK = 'last_block';
const KEY_LAST_HASH = 'last_block_hash';

function lower(v: unknown): string {
  return String(v).toLowerCase();
}

function asBigint(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' || typeof v === 'string') return BigInt(v);
  throw new TypeError(`expected a bigint, got ${typeof v}`);
}

/** The indexer. `step()` does one poll; `status()` feeds `GET /api/status`. */
export class Indexer {
  private head = 0;
  private readonly now: () => number;

  constructor(
    private readonly repos: Repos,
    private readonly reader: ChainReader,
    private readonly options: IndexerOptions,
    private readonly logger: Logger,
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** The last fully indexed block (`START_BLOCK − 1` on first run). */
  lastBlock(): number {
    const v = this.repos.indexerState.get(KEY_LAST_BLOCK);
    return v === undefined ? this.options.startBlock - 1 : Number(v);
  }

  private lastHash(): Hex | undefined {
    const v = this.repos.indexerState.get(KEY_LAST_HASH);
    return v === undefined ? undefined : (v as Hex);
  }

  private setLast(block: number, hash: Hex | undefined): void {
    this.repos.indexerState.set(KEY_LAST_BLOCK, String(block));
    if (hash === undefined) this.repos.indexerState.delete(KEY_LAST_HASH);
    else this.repos.indexerState.set(KEY_LAST_HASH, hash);
  }

  /** `{ lastBlock, head, lagBlocks, lastEventAt }`. */
  status(): IndexerStatusDto {
    const lastBlock = this.lastBlock();
    return { lastBlock, head: this.head, lagBlocks: Math.max(0, this.head - lastBlock), lastEventAt: this.repos.creditEvents.lastEventAt() };
  }

  /**
   * Reorg guard: when the stored hash of `last_block` no longer matches the chain, rewinds
   * `R = CONFIRMATIONS + 10` blocks (deleting events, their ledger rows and recomputing budgets).
   * Returns `true` when a rewind happened.
   */
  async checkReorg(): Promise<boolean> {
    const last = this.lastBlock();
    const hash = this.lastHash();
    if (last < 0 || hash === undefined) return false;
    const block = await this.reader.getBlock(BigInt(last));
    if (block !== undefined && block.hash.toLowerCase() === hash.toLowerCase()) return false;
    const rewindTo = Math.max(this.options.startBlock - 1, last - (this.options.confirmations + REORG_EXTRA_BLOCKS));
    this.logger.warn('reorg detected; rewinding', { lastBlock: last, expectedHash: hash, actualHash: block?.hash ?? null, rewindTo });
    this.rewind(rewindTo);
    return true;
  }

  /** Deletes everything above `toBlock` and resets the cursor (public for tests). */
  rewind(toBlock: number): void {
    this.repos.transaction(() => {
      const removed = this.repos.creditEvents.listAbove(toBlock);
      const budgetIds = new Set<number>();
      for (const ev of removed) {
        if (ev.kind === 'draw' && ev.budgetId !== null) budgetIds.add(ev.budgetId);
      }
      this.repos.ledger.deleteByRefs(
        'credit_event',
        removed.map((ev) => `${ev.txHash}:${ev.logIndex}`),
      );
      this.repos.creditEvents.deleteAbove(toBlock);
      const now = this.now();
      for (const id of budgetIds) {
        this.repos.budgets.setDrawn(id, this.repos.creditEvents.drawnByBudget(id), now);
        for (const draw of this.repos.budgetDraws.listByBudget(id)) {
          if (draw.status === 'confirmed' && removed.some((ev) => ev.receiptHash !== null && ev.receiptHash.toLowerCase() === draw.receiptHash.toLowerCase())) {
            this.repos.budgetDraws.setStatus(draw.id, 'sent', now);
          }
        }
      }
      this.setLast(toBlock, undefined);
    });
  }

  /** One poll: reorg check, then every pending chunk. Returns the range processed (or `undefined`). */
  async step(): Promise<{ from: number; to: number; events: number } | undefined> {
    const headBn = await this.reader.getBlockNumber();
    this.head = Number(headBn);
    await this.checkReorg();
    const target = this.head - this.options.confirmations;
    let from = this.lastBlock() + 1;
    if (from > target) return undefined;
    const first = from;
    let total = 0;
    while (from <= target) {
      const to = Math.min(target, from + this.options.chunkBlocks - 1);
      const logs = await this.reader.getLogs(BigInt(from), BigInt(to));
      const blockTimes = new Map<string, number>();
      for (const log of logs) {
        const key = log.blockHash.toLowerCase();
        if (blockTimes.has(key)) continue;
        const block = await this.reader.getBlock(log.blockNumber);
        blockTimes.set(key, block === undefined ? Math.floor(this.now() / 1000) : Number(block.timestamp));
      }
      const tip = await this.reader.getBlock(BigInt(to));
      const applied = this.applyChunk(logs, blockTimes, to, tip?.hash);
      total += applied;
      if (applied > 0) this.logger.info('indexed events', { from, to, events: applied });
      from = to + 1;
    }
    return { from: first, to: target, events: total };
  }

  /** Applies one chunk in a transaction and advances the cursor. Returns the number of new events. */
  applyChunk(logs: readonly DeskLog[], blockTimes: ReadonlyMap<string, number>, toBlock: number, toHash: Hex | undefined): number {
    return this.repos.transaction(() => {
      let applied = 0;
      const sorted = [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
      for (const log of sorted) {
        if (this.applyLog(log, blockTimes.get(log.blockHash.toLowerCase()) ?? Math.floor(this.now() / 1000))) applied++;
      }
      this.setLast(toBlock, toHash);
      return applied;
    });
  }

  /** Applies one log idempotently on `(tx_hash, log_index)`. Returns `false` when already applied. */
  applyLog(log: DeskLog, blockTime: number): boolean {
    const now = this.now();
    const txHash = log.transactionHash.toLowerCase();
    const blockNumber = Number(log.blockNumber);
    const refId = `${txHash}:${log.logIndex}`;
    const a = log.args;
    switch (log.eventName) {
      case 'CreditPurchased': {
        if (this.repos.creditEvents.exists(txHash, log.logIndex)) return false;
        const workspace = lower(a['workspace']);
        const usdMicro = asBigint(a['usdMicro']);
        this.repos.workspaces.ensure(workspace, now);
        this.repos.creditEvents.insert({
          txHash,
          logIndex: log.logIndex,
          kind: 'purchase',
          receiptId: Number(asBigint(a['receiptId'])),
          workspace,
          payer: lower(a['payer']),
          tokenAmount: asBigint(a['tokenAmount']),
          usdMicro,
          priceE18: asBigint(a['priceE18']),
          budgetId: null,
          receiptHash: null,
          blockNumber,
          blockHash: log.blockHash.toLowerCase(),
          blockTime,
          createdAt: now,
        });
        if (!this.repos.ledger.hasRef('credit_event', refId)) {
          this.repos.ledger.insert({ workspace, kind: 'credit', amountMicro: usdMicro, refType: 'credit_event', refId, memo: `purchase #${String(a['receiptId'])}`, createdAt: now });
        }
        return true;
      }
      case 'BudgetOpened': {
        const budgetId = Number(asBigint(a['budgetId']));
        const workspace = lower(a['workspace']);
        this.repos.workspaces.ensure(workspace, now);
        const existed = this.repos.budgets.get(budgetId) !== undefined;
        this.repos.budgets.upsertOpened({
          budgetId,
          owner: lower(a['owner']),
          workspace,
          cap: asBigint(a['cap']),
          deadline: Number(asBigint(a['deadline'])),
          openedBlock: blockNumber,
          now,
        });
        return !existed;
      }
      case 'BudgetDrawn': {
        if (this.repos.creditEvents.exists(txHash, log.logIndex)) return false;
        const workspace = lower(a['workspace']);
        const budgetId = Number(asBigint(a['budgetId']));
        const usdMicro = asBigint(a['usdMicro']);
        const tokenAmount = asBigint(a['tokenAmount']);
        const receiptHash = lower(a['receiptHash']);
        this.repos.workspaces.ensure(workspace, now);
        this.repos.creditEvents.insert({
          txHash,
          logIndex: log.logIndex,
          kind: 'draw',
          receiptId: Number(asBigint(a['receiptId'])),
          workspace,
          payer: null,
          tokenAmount,
          usdMicro,
          priceE18: asBigint(a['priceE18']),
          budgetId,
          receiptHash,
          blockNumber,
          blockHash: log.blockHash.toLowerCase(),
          blockTime,
          createdAt: now,
        });
        if (!this.repos.ledger.hasRef('credit_event', refId)) {
          this.repos.ledger.insert({ workspace, kind: 'credit', amountMicro: usdMicro, refType: 'credit_event', refId, memo: `budget #${budgetId} draw`, createdAt: now });
        }
        this.repos.budgets.addDrawn(budgetId, tokenAmount, now);
        const draw = this.repos.budgetDraws.byReceiptHash(receiptHash);
        if (draw !== undefined && draw.status !== 'confirmed') this.repos.budgetDraws.setStatus(draw.id, 'confirmed', now, { txHash, error: null });
        return true;
      }
      case 'BudgetClosed': {
        const budgetId = Number(asBigint(a['budgetId']));
        const row = this.repos.budgets.get(budgetId);
        if (row === undefined) return false;
        this.repos.budgets.setClosed(budgetId, true, now);
        this.repos.budgets.setDrawn(budgetId, asBigint(a['drawn']), now);
        return !row.closed;
      }
    }
  }
}
