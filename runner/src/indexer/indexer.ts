/**
 * Polling launchpad indexer (`docs/SPEC.md` §4.1 `indexer/`): every 1000 ms, `eth_getLogs` over
 * ranges of ≤ 2000 blocks from `last_processed_block + 1` up to `head − CONFIRMATIONS`; each range
 * is applied in ONE transaction together with `last_processed_block` (restart resumes exactly);
 * events are emitted after commit and only for live logs (blocks ≥ the head seen at startup).
 * RPC failures are retried with exponential backoff; the head keeps being polled even when no
 * launchpad address is configured.
 *
 * @module indexer/indexer
 */
import type { Address } from 'viem';
import type { Repos } from '../db/repos.js';
import { errorMessage, type Logger } from '../log.js';
import { backoffMs, sleep } from '../util.js';
import { applyLogs, blocksNeedingTimestamps, decodeLaunchpadLogs } from './apply.js';
import type { IndexerEvents } from './events.js';
import type { LogSource } from './source.js';

/** Poll interval (SPEC §4.1). */
export const INDEXER_POLL_MS = 1_000;
/** Maximum `eth_getLogs` range (SPEC §4.1). */
export const INDEXER_MAX_RANGE = 2_000n;

/** Options of {@link Indexer}. */
export interface IndexerOptions {
  /** Launchpad address; `null` = only track the head. */
  address: Address | null;
  startBlock: bigint;
  confirmations: number;
  pollMs?: number;
  maxBackoffMs?: number;
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

  constructor(
    private readonly repos: Repos,
    private readonly source: LogSource,
    private readonly events: IndexerEvents,
    private readonly opts: IndexerOptions,
    private readonly log: Logger,
  ) {}

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
    const address = this.opts.address;
    if (address === null) return result;
    const target = head - BigInt(this.opts.confirmations);
    const last = this.repos.state.lastBlock();
    let from = last === undefined ? this.opts.startBlock : last + 1n;
    while (from <= target && !this.#stopped) {
      const to = from + INDEXER_MAX_RANGE - 1n < target ? from + INDEXER_MAX_RANGE - 1n : target;
      const decoded = decodeLaunchpadLogs(await this.source.getLogs(address, from, to));
      const timestamps = await this.#timestamps(blocksNeedingTimestamps(decoded));
      const applied = this.repos.tx(() => {
        const evs = applyLogs(this.repos, decoded, (b) => timestamps.get(b) ?? 0n);
        this.repos.state.setLastBlock(to);
        return evs;
      });
      const liveFrom = this.#liveFrom;
      for (const ev of applied) if (BigInt(ev.blockNumber) >= liveFrom) this.events.emit(ev);
      result.logs += decoded.length;
      result.events += applied.length;
      result.toBlock = to;
      from = to + 1n;
    }
    result.caughtUp = from > target;
    return result;
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
    if (this.opts.address === null) this.log.warn('no launchpad address: tracking the chain head only');
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
