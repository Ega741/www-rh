/**
 * Pure helpers for "wait until the indexer credits the burn" polling (SPEC §7, Credits page).
 * The landing is detected from two signals: the indexed `purchase` credit event of the burn
 * transaction (`GET /api/receipts`, authoritative) and the workspace balance growing by at least
 * the quoted amount (`GET /api/balance`, a hint that fails when a concurrent debit or a lower
 * execution price shrinks the delta).
 */
import type { Hex } from 'viem';

/**
 * `true` once the ledger reflects a purchase: the balance grew by at least `expectedMicro`
 * (when known) or at all (when the expected amount is unknown).
 */
export function creditLanded(beforeMicro: bigint, afterMicro: bigint, expectedMicro: bigint | undefined): boolean {
  if (expectedMicro === undefined || expectedMicro <= 0n) return afterMicro > beforeMicro;
  return afterMicro - beforeMicro >= expectedMicro;
}

/** A credit event row as far as the watcher cares (`CreditEventDto`). */
export interface PurchaseLike {
  kind: string;
  txHash: string;
}

/** `true` when the indexed credit events contain the `purchase` of `txHash`. */
export function purchaseIndexed(rows: readonly PurchaseLike[], txHash: Hex): boolean {
  const h = txHash.toLowerCase();
  return rows.some((r) => r.kind === 'purchase' && r.txHash.toLowerCase() === h);
}

/** Interval in ms between balance / credit-event polls while watching. */
export const WATCH_POLL_MS = 2000;

/** Give up after this many balance polls (60 × 2 s ≈ 2 minutes). */
export const MAX_POLL_ATTEMPTS = 60;

/** State of the post-burn watcher. */
export interface WatchState {
  status: 'idle' | 'watching' | 'landed' | 'timeout';
  beforeMicro: bigint;
  expectedMicro: bigint | undefined;
  /** The burn transaction whose indexed `CreditPurchased` event marks the landing, when known. */
  txHash: Hex | undefined;
  attempts: number;
}

/** Initial watcher state. */
export const IDLE_WATCH: WatchState = { status: 'idle', beforeMicro: 0n, expectedMicro: undefined, txHash: undefined, attempts: 0 };

/** Starts watching from `beforeMicro` for `expectedMicro`, landing on the `purchase` event of `txHash` when given. */
export function startWatch(beforeMicro: bigint, expectedMicro: bigint | undefined, txHash?: Hex): WatchState {
  return { status: 'watching', beforeMicro, expectedMicro, txHash, attempts: 0 };
}

/** Restarts a timed-out watch with the same targets ("check again"). */
export function restartWatch(state: WatchState): WatchState {
  return startWatch(state.beforeMicro, state.expectedMicro, state.txHash);
}

/** Feeds a fresh balance into the watcher; returns the next state. */
export function observeBalance(state: WatchState, balanceMicro: bigint): WatchState {
  if (state.status !== 'watching') return state;
  if (creditLanded(state.beforeMicro, balanceMicro, state.expectedMicro)) return { ...state, status: 'landed' };
  const attempts = state.attempts + 1;
  if (attempts >= MAX_POLL_ATTEMPTS) return { ...state, attempts, status: 'timeout' };
  return { ...state, attempts };
}

/** Feeds the latest indexed credit events into the watcher; lands when the burn tx is among them. */
export function observeEvents(state: WatchState, rows: readonly PurchaseLike[]): WatchState {
  if (state.status !== 'watching' || state.txHash === undefined) return state;
  return purchaseIndexed(rows, state.txHash) ? { ...state, status: 'landed' } : state;
}
