/**
 * Polling launchpad indexer (R9): `eth_getLogs` over ranges of at most `batchBlocks` (≤ 2000) up
 * to `head - confirmations`; each range is applied in one transaction together with the new
 * `last_block`, so a crash resumes exactly where it stopped; events are emitted after commit; the
 * first observed head separates replayed history (`live: false`) from live events.
 *
 * @module indexer/indexer
 */
import type { Address } from 'viem';
import type { IndexerStatus } from '@www-rh/shared';
import type { Repos } from '../db/repos.js';
import { errorMessage, type Logger } from '../log.js';
import { backoffMs, sleep } from '../util.js';
import { applyLogs, blocksNeedingTimestamps } from './apply.js';
import type { IndexerEvents } from './events.js';
import type { LogSource } from './source.js';

/** Options of {@link Indexer}. */
export interface IndexerOptions {
  /** Launchpad address, or `null` to keep the indexer disabled. */
  address: Address | null;
  startBlock: bigint;
  confirmations: number;
  batchBlocks: number;
  pollMs: number;
  /** Max backoff after errors. */
  maxBackoffMs?: number;
}

/** Result of one {@link Indexer.syncOnce} pass. */
export interface SyncResult {
  head: bigint;
  target: bigint;
  fromBlock: bigint | null;
  toBlock: bigint | null;
  logs: number;
  events: number;
}

/** The launchpad log indexer. */
export class Indexer {
  #status: IndexerStatus;
  #lastError: string | null = null;
  #head: bigint | null = null;
  #liveFrom: bigint | null = null;
  #stopped = false;
  #abort = new AbortController();
  #loop: Promise<void> | null = null;

  constructor(
    private readonly repos: Repos,
    private readonly source: LogSource,
    private readonly events: IndexerEvents,
    private readonly opts: IndexerOptions,
    private readonly log: Logger,
  ) {
    this.#status = opts.address === null ? 'disabled' : 'starting';
  }

  /** Current status for `/api/health`. */
  get status(): { status: IndexerStatus; lastError: string | null; headBlock: bigint | null; lastIndexedBlock: bigint | null; liveFrom: bigint | null } {
    return { status: this.#status, lastError: this.#lastError, headBlock: this.#head, lastIndexedBlock: this.repos.state.lastBlock() ?? null, liveFrom: this.#liveFrom };
  }

  /** Whether the indexer has caught up with `head - confirmations` at least once. */
  get isLive(): boolean {
    return this.#status === 'live';
  }

  /**
   * Fetches the head and processes every pending range once.
   * The first successful call fixes `liveFrom` (= head at startup).
   */
  async syncOnce(): Promise<SyncResult> {
    const address = this.opts.address;
    if (address === null) return { head: 0n, target: 0n, fromBlock: null, toBlock: null, logs: 0, events: 0 };
    const head = await this.source.getBlockNumber();
    this.#head = head;
    this.#liveFrom ??= head;
    const target = head - BigInt(this.opts.confirmations);
    const last = this.repos.state.lastBlock();
    let from = last === undefined ? this.opts.startBlock : last + 1n;
    const result: SyncResult = { head, target, fromBlock: null, toBlock: null, logs: 0, events: 0 };
    if (from > target) return result;
    this.#status = 'syncing';
    result.fromBlock = from;
    const step = BigInt(Math.min(2000, Math.max(1, this.opts.batchBlocks)));
    while (from <= target && !this.#stopped) {
      const to = from + step - 1n < target ? from + step - 1n : target;
      const logs = await this.source.getLogs(address, from, to);
      const timestamps = new Map<bigint, bigint>();
      for (const block of blocksNeedingTimestamps(logs)) timestamps.set(block, await this.source.getBlockTimestamp(block));
      const liveFrom = this.#liveFrom;
      const emitted = this.repos.tx(() => {
        const evs = applyLogs(this.repos, logs, (b) => timestamps.get(b) ?? 0n, liveFrom);
        this.repos.state.setLastBlock(to);
        return evs;
      });
      for (const ev of emitted) this.events.emit(ev);
      result.logs += logs.length;
      result.events += emitted.length;
      result.toBlock = to;
      if (logs.length > 0) this.log.debug('indexed range', { from, to, logs: logs.length });
      from = to + 1n;
    }
    return result;
  }

  /** Starts the polling loop (retries with exponential backoff on RPC errors). */
  start(): void {
    if (this.#loop !== null) return;
    if (this.opts.address === null) {
      this.log.warn('no launchpad address configured (LAUNCHPAD_ADDRESS / deployments) — indexer disabled');
      return;
    }
    this.#loop = this.#run();
  }

  async #run(): Promise<void> {
    let failures = 0;
    while (!this.#stopped) {
      try {
        await this.syncOnce();
        if (this.#status !== 'live') this.log.info('indexer live', { head: this.#head, lastBlock: this.repos.state.lastBlock() });
        this.#status = 'live';
        this.#lastError = null;
        failures = 0;
        await sleep(this.opts.pollMs, this.#abort.signal);
      } catch (err) {
        if (this.#stopped) break;
        this.#status = 'error';
        this.#lastError = errorMessage(err);
        const delay = backoffMs(failures++, 1_000, this.opts.maxBackoffMs ?? 60_000);
        this.log.warn('indexer error, retrying', { error: this.#lastError, retryInMs: delay });
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
