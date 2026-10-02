/**
 * In-process events emitted by the indexer **after** each batch commits (R9). `live` is true only
 * for logs at or above the chain head observed at startup; consumers must not trigger on-chain
 * side effects (graduate / harvest / status transactions) for replayed history (`live: false`).
 *
 * @module indexer/events
 */
import { EventEmitter } from 'node:events';
import type { TradeRow } from '../db/repos.js';

/** Common fields of every indexed event. */
interface Base {
  token: string;
  blockNumber: number;
  txHash: string;
  live: boolean;
}

/** Domain events derived from launchpad logs. */
export type IndexedEvent =
  | (Base & { type: 'mind:created' })
  | (Base & { type: 'mind:config' })
  | (Base & { type: 'mind:status'; status: number })
  | (Base & { type: 'mind:funded'; amount: bigint })
  | (Base & { type: 'trade'; trade: TradeRow })
  | (Base & { type: 'curve:complete' })
  | (Base & { type: 'graduated' })
  | (Base & { type: 'harvested'; ethOut: bigint })
  | (Base & { type: 'draw'; amount: bigint; receiptHash: string })
  | (Base & { type: 'anchor'; seq: number; contentHash: string; uri: string });

/** Typed wrapper over `EventEmitter` for {@link IndexedEvent}. */
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

  /** Emits `event` to all listeners; a throwing listener does not affect the others. */
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
