/**
 * Shared interval ticks: every component asking for the same period shares one timer, so all
 * home-grid thumbnails refresh together. Ticks pause while the tab is hidden.
 *
 * @module hooks/useTick
 */
import { useSyncExternalStore } from 'react';

interface Ticker {
  count: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const tickers = new Map<number, Ticker>();

function getTicker(periodMs: number): Ticker {
  let t = tickers.get(periodMs);
  if (t === undefined) {
    t = { count: 0, listeners: new Set(), timer: null };
    tickers.set(periodMs, t);
  }
  return t;
}

function subscribe(periodMs: number, listener: () => void): () => void {
  const t = getTicker(periodMs);
  t.listeners.add(listener);
  if (t.timer === null) {
    t.timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      t.count += 1;
      for (const l of t.listeners) l();
    }, periodMs);
  }
  return () => {
    t.listeners.delete(listener);
    if (t.listeners.size === 0 && t.timer !== null) {
      clearInterval(t.timer);
      t.timer = null;
    }
  };
}

const noop = (): void => undefined;

/** Returns a counter that increments every `periodMs` (shared timer per period); `0` and no timer while `enabled` is false. */
export function useTick(periodMs: number, enabled = true): number {
  return useSyncExternalStore(
    (listener) => (enabled ? subscribe(periodMs, listener) : noop),
    () => (enabled ? getTicker(periodMs).count : 0),
    () => 0,
  );
}

/** Current time in ms, refreshed every `periodMs` while `enabled` (for "12s ago" labels and countdowns). */
export function useNow(periodMs = 1_000, enabled = true): number {
  useTick(periodMs, enabled);
  return Date.now();
}
