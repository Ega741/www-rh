/**
 * In-process events emitted by the indexer after each range commits (`docs/SPEC.md` §4.1
 * `indexer/`, §9.4). Pons mode maps `Swept` to `curve:complete` and `PoolCreated` to `graduated`. They are emitted **only for live logs** (blocks ≥ the head observed at startup);
 * replayed history never reaches listeners, so it can never trigger graduate / harvest / status /
 * settlement transactions.
 *
 * @module indexer/events
 */
import { EventEmitter } from 'node:events';
import type { TradeRow } from '../db/repos.js';

interface Base {
  /** Lowercase token address. */
  token: string;
  blockNumber: number;
  txHash: string;
}

/** Domain events derived from live launchpad logs. */
export type IndexedEvent =
  | (Base & { type: 'mind:created' })
  | (Base & { type: 'mind:config' })
  | (Base & { type: 'mind:status'; status: number })
  | (Base & { type: 'trade'; trade: TradeRow })
  | (Base & { type: 'fee:accrued'; mindAmount: bigint })
  | (Base & { type: 'mind:funded'; amount: bigint })
  | (Base & { type: 'curve:complete' })
  | (Base & { type: 'curve:reopened' })
  | (Base & { type: 'graduated' })
  | (Base & { type: 'compute:drawn'; amount: bigint; receiptHash: string })
  | (Base & { type: 'memory:anchored'; seq: number; contentHash: string; uri: string })
  | (Base & { type: 'harvested'; ethOut: bigint })
  // ---------------------------------------------------------------- Pons mode (docs/SPEC.md §9)
  /** Escrow `Credited` to the mind account (creator fees swept by Pons, the registry or the account). */
  | (Base & { type: 'pons:credited'; amount: bigint })
  /** Escrow `Claimed` by the mind account (part of `harvest`). */
  | (Base & { type: 'pons:claimed'; amount: bigint })
  /** The hook's `PoolRegistered` for a mind's token: the operator records it with `setPoolId`. */
  | (Base & { type: 'pons:pool-registered'; poolId: string })
  /** `MindAdopted` (first adoption or takeover, §9.7: the fee recipient was handed to the preparer's account). */
  | (Base & { type: 'pons:adopted' })
  /** `MindLeft` (the creator moved the fee recipient away; Dormant until a takeover, §9.7). */
  | (Base & { type: 'pons:left' });

/** Event type names. */
export type IndexedEventType = IndexedEvent['type'];

/** Typed wrapper over `EventEmitter`; a throwing listener never affects the others. */
export class IndexerEvents {
  readonly #emitter = new EventEmitter();

  constructor() {
    this.#emitter.setMaxListeners(100);
  }

  /** Subscribes to every event; returns an unsubscribe function. */
  on(listener: (event: IndexedEvent) => void): () => void {
    this.#emitter.on('event', listener);
    return () => this.#emitter.off('event', listener);
  }

  /** Emits `event` to all listeners. */
  emit(event: IndexedEvent): void {
    for (const listener of this.#emitter.listeners('event') as ((e: IndexedEvent) => void)[]) {
      try {
        listener(event);
      } catch {
        // listeners own their error handling
      }
    }
  }
}
