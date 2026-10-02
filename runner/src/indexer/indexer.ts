/**
 * Polling launchpad indexer (`docs/SPEC.md` §4.1 `indexer/`): every 1000 ms, `eth_getLogs` over
 * ranges of ≤ 2000 blocks from `last_processed_block + 1` up to `head − CONFIRMATIONS`; each range
 * is applied in ONE transaction together with `last_processed_block` (restart resumes exactly);
 * events are emitted after commit and only for live logs (blocks ≥ the head seen at startup).
 * RPC failures are retried with exponential backoff; the head keeps being polled even when no
 * launchpad address is configured.
 *
 * Safety against lagging / reorganizing nodes:
 * - before advancing past a range whose `eth_getLogs` returned `[]`, the node's head is re-read in
 *   the same pass (a node that has not seen those blocks answers `[]`);
 * - the hash of every committed range end is stored; the next range's first block must have it as
 *   parent hash, otherwise the reorg is logged and the indexer rewinds `reorgRewindBlocks` blocks
 *   (re-applying is idempotent; balances of orphaned logs are fixed by the drift check);
 * - every 10 min while live, the indexed `mind_balance` of every mind is compared with on-chain
 *   `mindBalance(token)` at the last indexed block; drift is logged as an error and corrected.
 *
 * @module indexer/indexer
 */
import type { Address } from 'viem';
import type { LaunchpadReader } from '../chain/launchpad.js';
import type { Repos } from '../db/repos.js';
import { errorMessage, type Logger } from '../log.js';
import { backoffMs, sleep } from '../util.js';
import type { IndexerEvents } from './events.js';
import type { LogSource } from './source.js';
import { CurveIndexerVenue, type IndexerVenue } from './venue.js';

/** Poll interval (SPEC §4.1). */
export const INDEXER_POLL_MS = 1_000;
/** Maximum `eth_getLogs` range (SPEC §4.1). */
export const INDEXER_MAX_RANGE = 2_000n;
/** Blocks re-indexed after a parent-hash mismatch. */
export const REORG_REWIND_BLOCKS = 64;
/** Vault balance drift check period (while live). */
export const BALANCE_DRIFT_CHECK_MS = 10 * 60_000;

/** Options of {@link Indexer}. */
export interface IndexerOptions {
  /** Launchpad address (curve mode, when no `venue` is given); `null` = only track the head. */
  address: Address | null;
  /** Venue log handling; default: {@link CurveIndexerVenue} over `address`. */
  venue?: IndexerVenue;
  startBlock: bigint;
  confirmations: number;
  pollMs?: number;
  maxBackoffMs?: number;
  /** Blocks re-indexed after a reorg is detected (default {@link REORG_REWIND_BLOCKS}). */
  reorgRewindBlocks?: number;
  /** On-chain `mindBalance` reads for the drift check; `null` disables it. */
  balanceReader?: Pick<LaunchpadReader, 'mindBalance'> | null;
  /** Drift check period (default {@link BALANCE_DRIFT_CHECK_MS}). */
  driftCheckMs?: number;
  now?: () => number;
}

/** Health snapshot. */
export interface IndexerStatus {
  /** True once everything up to the startup head is processed. */
  live: boolean;
  lastError: string | null;
  headBlock: bigint | null;
  lastIndexedBlock: bigint | null;
  /** Head observed at startup: logs at or above it are "live". */
  liveFrom: bigint | null;
}

/** Result of one {@link Indexer.syncOnce} pass. */
export interface SyncResult {
  head: bigint;
  toBlock: bigint | null;
  logs: number;
  events: number;
  /** True when everything up to `head − CONFIRMATIONS` has been processed. */
  caughtUp: boolean;
  /** Set when a parent-hash mismatch made the indexer rewind. */
  reorg?: { at: bigint; rewoundTo: bigint | null };
}

/** The launchpad log indexer. */
export class Indexer {
  #live = false;
  #lastError: string | null = null;
  #head: bigint | null = null;
  #liveFrom: bigint | null = null;
  #stopped = false;
  readonly #abort = new AbortController();
  #loop: Promise<void> | null = null;
  readonly #liveWaiters: (() => void)[] = [];
  #lastDriftCheck = 0;
  readonly #venue: IndexerVenue;

  constructor(
    private readonly repos: Repos,
    private readonly source: LogSource,
    private readonly events: IndexerEvents,
    private readonly opts: IndexerOptions,
    private readonly log: Logger,
  ) {
    this.#venue = opts.venue ?? new CurveIndexerVenue(opts.address);
  }

  /** Health snapshot for `/api/health`. */
  get status(): IndexerStatus {
    return { live: this.#live, lastError: this.#lastError, headBlock: this.#head, lastIndexedBlock: this.repos.state.lastBlock() ?? null, liveFrom: this.#liveFrom };
  }

  /** Resolves once the indexer has processed up to the startup head. */
  whenLive(): Promise<void> {
    if (this.#live) return Promise.resolve();
    return new Promise((resolve) => this.#liveWaiters.push(resolve));
  }

  async #timestamps(blocks: readonly bigint[]): Promise<Map<bigint, bigint>> {
    const out = new Map<bigint, bigint>();
    for (const block of blocks) {
      const cached = this.repos.chain.blockTimestamp(Number(block));
      if (cached !== undefined) {
        out.set(block, BigInt(cached));
        continue;
      }
      const ts = await this.source.getBlockTimestamp(block);
      this.repos.chain.putBlockTimestamp(Number(block), Number(ts));
      out.set(block, ts);
    }
    return out;
  }

  /** Fetches the head and processes every pending range once. */
  async syncOnce(): Promise<SyncResult> {
    const head = await this.source.getBlockNumber();
    this.#head = head;
    this.#liveFrom ??= head;
    const result: SyncResult = { head, toBlock: null, logs: 0, events: 0, caughtUp: true };
    if (this.#venue.address === null) return result;
    const target = head - BigInt(this.opts.confirmations);
    const last = this.repos.state.lastBlock();
    let from = last === undefined ? this.opts.startBlock : last + 1n;
    while (from <= target && !this.#stopped) {
      const to = from + INDEXER_MAX_RANGE - 1n < target ? from + INDEXER_MAX_RANGE - 1n : target;
      const batch = await this.#venue.fetchRange(this.source, from, to, this.repos);
      const toHeader = await this.source.getBlockHeader(to);
      const fromHeader = from === to ? toHeader : await this.source.getBlockHeader(from);
      const prevHash = from > 0n ? this.repos.chain.blockHash(Number(from - 1n)) : undefined;
      if (prevHash !== undefined && fromHeader.parentHash.toLowerCase() !== prevHash) {
        result.reorg = { at: from - 1n, rewoundTo: this.#rewind(from - 1n, prevHash, fromHeader.parentHash) };
        result.caughtUp = false;
        return result;
      }
      if (batch.rawCount === 0) {
        // a lagging node answers [] for blocks it has not seen: verify its head before skipping them
        const nodeHead = await this.source.getBlockNumber();
        if (nodeHead < to) throw new Error(`RPC head ${nodeHead} is behind block ${to} after an empty eth_getLogs; not advancing`);
      }
      const timestamps = await this.#timestamps(batch.blocksNeedingTimestamps);
      const applied = this.repos.tx(() => {
        const evs = batch.apply(this.repos, (b) => timestamps.get(b) ?? 0n, (message, fields) => this.log.error(message, fields));
        this.repos.state.setLastBlock(to);
        this.repos.chain.putBlockHash(Number(to), toHeader.hash);
        return evs;
      });
      const liveFrom = this.#liveFrom;
      for (const ev of applied) if (BigInt(ev.blockNumber) >= liveFrom) this.events.emit(ev);
      result.logs += batch.logCount;
      result.events += applied.length;
      result.toBlock = to;
      from = to + 1n;
    }
    result.caughtUp = from > target;
    return result;
  }

  /**
   * Parent-hash mismatch above `at`: rewinds `last_processed_block` (preferring a block whose hash is
   * stored, so the fork point is verified again on the next pass). Returns the new last block.
   */
  #rewind(at: bigint, expected: string, got: string): bigint | null {
    const depth = BigInt(this.opts.reorgRewindBlocks ?? REORG_REWIND_BLOCKS);
    const floor = this.opts.startBlock - 1n;
    let target = at - depth < floor ? floor : at - depth;
    if (target >= 0n) {
      const hashed = this.repos.chain.latestHashedBlockAtOrBelow(Number(target));
      if (hashed !== undefined && BigInt(hashed) >= floor && target - BigInt(hashed) <= depth) target = BigInt(hashed);
    }
    this.log.error('chain reorganization detected (parent hash mismatch); rewinding the indexer', { block: at, storedHash: expected, parentHash: got, rewindTo: target });
    this.repos.tx(() => {
      this.repos.state.setLastBlock(target);
      this.repos.chain.deleteBlockHashesAbove(target < 0n ? -1 : Number(target));
    });
    return target < 0n ? null : target;
  }

  /**
   * Compares every mind's indexed `mind_balance` with on-chain `mindBalance(token)` at the last
   * indexed block; drift is logged as an error and corrected. Returns the number of corrections.
   * Runs inside the polling loop (never concurrently with a range commit).
   */
  async checkBalances(): Promise<number> {
    const reader = this.opts.balanceReader;
    const block = this.repos.state.lastBlock();
    if (reader === undefined || reader === null || block === undefined) return 0;
    const minds = this.repos.minds.all();
    let corrected = 0;
    let failures = 0;
    for (let i = 0; i < minds.length && !this.#stopped; i += 8) {
      const batch = minds.slice(i, i + 8);
      const results = await Promise.allSettled(batch.map((m) => reader.mindBalance(m.token as Address, block)));
      results.forEach((r, j) => {
        const token = (batch[j] as { token: string }).token;
        if (r.status !== 'fulfilled') {
          failures++;
          return;
        }
        const indexed = BigInt(this.repos.minds.get(token)?.mind_balance ?? '0');
        if (r.value === indexed) return;
        this.log.error('vault balance drift: indexed mind_balance differs from on-chain mindBalance(token); correcting', { token, block, indexed, onchain: r.value });
        this.repos.minds.setBalance(token, r.value);
        corrected++;
      });
    }
    if (failures > 0) this.log.warn('balance drift check: some mindBalance reads failed', { failures, block });
    return corrected;
  }

  #markLive(): void {
    if (this.#live) return;
    this.#live = true;
    this.log.info('indexer live', { head: this.#head, lastIndexedBlock: this.repos.state.lastBlock() });
    for (const resolve of this.#liveWaiters.splice(0)) resolve();
  }

  /** Starts the polling loop. */
  start(): void {
    if (this.#loop !== null) return;
    if (this.#venue.address === null) this.log.warn(`no ${this.#venue.venue === 'pons' ? 'registry' : 'launchpad'} address: tracking the chain head only`);
    this.#loop = this.#run();
  }

  async #run(): Promise<void> {
    let failures = 0;
    while (!this.#stopped) {
      try {
        const r = await this.syncOnce();
        this.#lastError = null;
        failures = 0;
        if (r.caughtUp) this.#markLive();
        const now = (this.opts.now ?? Date.now)();
        if (this.#live && r.caughtUp && this.opts.balanceReader != null && now - this.#lastDriftCheck >= (this.opts.driftCheckMs ?? BALANCE_DRIFT_CHECK_MS)) {
          this.#lastDriftCheck = now;
          await this.checkBalances().catch((err: unknown) => this.log.warn('balance drift check failed', { error: errorMessage(err) }));
        }
        await sleep(this.opts.pollMs ?? INDEXER_POLL_MS, this.#abort.signal);
      } catch (err) {
        if (this.#stopped) break;
        this.#lastError = errorMessage(err);
        const delay = backoffMs(failures++, 1_000, this.opts.maxBackoffMs ?? 30_000);
        this.log.warn('indexer RPC error, retrying', { error: this.#lastError, retryInMs: delay });
        await sleep(delay, this.#abort.signal).catch(() => undefined);
      }
    }
  }

  /** Stops the loop and waits for the in-flight pass. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abort.abort(new Error('indexer stopped'));
    await this.#loop?.catch(() => undefined);
    this.#loop = null;
  }
}
