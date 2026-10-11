/** Pure helpers for "wait until the indexer credits the burn" polling (SPEC §7, Credits page). */

/**
 * `true` once the ledger reflects a purchase: the balance grew by at least `expectedMicro`
 * (when known) or at all (when the expected amount is unknown).
 */
export function creditLanded(beforeMicro: bigint, afterMicro: bigint, expectedMicro: bigint | undefined): boolean {
  if (expectedMicro === undefined || expectedMicro <= 0n) return afterMicro > beforeMicro;
  return afterMicro - beforeMicro >= expectedMicro;
}

/** Poll delay in ms for attempt `n` (0-based): 1.5 s, 2 s, 3 s, 4 s, capped at 5 s. */
export function pollDelayMs(attempt: number): number {
  const base = 1500;
  return Math.min(5000, base + Math.max(0, attempt) * 750);
}

/** Give up after this many attempts (~2 minutes). */
export const MAX_POLL_ATTEMPTS = 30;

/** State of the post-burn watcher. */
export interface WatchState {
  status: 'idle' | 'watching' | 'landed' | 'timeout';
  beforeMicro: bigint;
  expectedMicro: bigint | undefined;
  attempts: number;
}

/** Initial watcher state. */
export const IDLE_WATCH: WatchState = { status: 'idle', beforeMicro: 0n, expectedMicro: undefined, attempts: 0 };

/** Starts watching from `beforeMicro` for `expectedMicro`. */
export function startWatch(beforeMicro: bigint, expectedMicro: bigint | undefined): WatchState {
  return { status: 'watching', beforeMicro, expectedMicro, attempts: 0 };
}

/** Feeds a fresh balance into the watcher; returns the next state. */
export function observeBalance(state: WatchState, balanceMicro: bigint): WatchState {
  if (state.status !== 'watching') return state;
  if (creditLanded(state.beforeMicro, balanceMicro, state.expectedMicro)) return { ...state, status: 'landed' };
  const attempts = state.attempts + 1;
  if (attempts >= MAX_POLL_ATTEMPTS) return { ...state, attempts, status: 'timeout' };
  return { ...state, attempts };
}
