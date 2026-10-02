/**
 * Venue abstraction of the indexer (`docs/SPEC.md` §4.1 `indexer/`, §9.4): which logs a block
 * range needs, how they are decoded, and how they are applied to the database. The {@link Indexer}
 * owns ranges, reorg detection, timestamps, the commit and live/replay separation; a venue owns the
 * logs.
 *
 * - {@link CurveIndexerVenue}: every `MindLaunchpad` log (`eth_getLogs` on one address).
 * - `PonsIndexerVenue` (`pons.ts`): registry logs, then the address-filtered curve / factory /
 *   escrow / hook logs of the registered tokens.
 *
 * @module indexer/venue
 */
import type { Address } from 'viem';
import type { Venue } from '@www-rh/shared';
import type { Repos } from '../db/repos.js';
import { applyLogs, blocksNeedingTimestamps, decodeLaunchpadLogs, type AnomalySink } from './apply.js';
import type { IndexedEvent } from './events.js';
import type { LogSource } from './source.js';

/** The fetched and decoded logs of one block range, ready to be applied. */
export interface RangeBatch {
  /** Raw logs returned by the node (0 triggers the lagging-node head check). */
  readonly rawCount: number;
  /** Decoded logs that will be applied. */
  readonly logCount: number;
  /** Blocks whose timestamps {@link apply} needs and the logs do not carry. */
  readonly blocksNeedingTimestamps: readonly bigint[];
  /** Applies the batch inside the caller's DB transaction; returns the domain events of newly applied logs. */
  apply(repos: Repos, timestampOf: (block: bigint) => bigint, onAnomaly: AnomalySink): IndexedEvent[];
}

/** A venue's log handling. */
export interface IndexerVenue {
  readonly venue: Venue;
  /** The contract indexed (launchpad / registry); `null` = nothing to index (the head is still tracked). */
  readonly address: Address | null;
  /** Fetches (and pre-reads whatever applying needs) for `[fromBlock, toBlock]`. Throws on RPC failure (the range is retried). */
  fetchRange(source: LogSource, fromBlock: bigint, toBlock: bigint, repos: Repos): Promise<RangeBatch>;
}

/** Curve mode: every `MindLaunchpad` log. */
export class CurveIndexerVenue implements IndexerVenue {
  readonly venue = 'curve' as const;

  constructor(readonly address: Address | null) {}

  async fetchRange(source: LogSource, fromBlock: bigint, toBlock: bigint): Promise<RangeBatch> {
    if (this.address === null) return { rawCount: 0, logCount: 0, blocksNeedingTimestamps: [], apply: () => [] };
    const raw = await source.getLogs(this.address, fromBlock, toBlock);
    const decoded = decodeLaunchpadLogs(raw);
    return {
      rawCount: raw.length,
      logCount: decoded.length,
      blocksNeedingTimestamps: blocksNeedingTimestamps(decoded),
      apply: (repos, timestampOf, onAnomaly) => applyLogs(repos, decoded, timestampOf, onAnomaly),
    };
  }
}
