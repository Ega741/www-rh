/** Aggregation of `GET /api/usage/summary` into CSS bar charts (no chart library, SPEC §7). */
import type { UsageWindow } from './windows.js';
import { utcDayKey } from './time.js';

/** One bar. `ratio` is the value relative to the tallest bar in `[0, 1]`. */
export interface Bar {
  key: string;
  label: string;
  value: bigint;
  requests: number;
  ratio: number;
}

/** `value / max` in `[0, 1]` without float overflow on large bigints. */
export function ratio(value: bigint, max: bigint): number {
  if (max <= 0n || value <= 0n) return 0;
  if (value >= max) return 1;
  return Number((value * 10_000n) / max) / 10_000;
}

function withRatios(bars: Omit<Bar, 'ratio'>[]): Bar[] {
  const max = bars.reduce((m, b) => (b.value > m ? b.value : m), 0n);
  return bars.map((b) => ({ ...b, ratio: ratio(b.value, max) }));
}

/** Bars by model, highest charge first; models beyond `limit` are merged into "other". */
export function modelBars(byModel: readonly { model: string; requests: number; chargedMicro: bigint }[], limit = 8): Bar[] {
  const sorted = [...byModel].sort((a, b) => (a.chargedMicro === b.chargedMicro ? b.requests - a.requests : a.chargedMicro > b.chargedMicro ? -1 : 1));
  const head = sorted.slice(0, limit);
  const tail = sorted.slice(limit);
  const bars: Omit<Bar, 'ratio'>[] = head.map((m) => ({ key: m.model, label: m.model, value: m.chargedMicro, requests: m.requests }));
  if (tail.length > 0) {
    bars.push({
      key: 'other',
      label: `other (${tail.length})`,
      value: tail.reduce((s, m) => s + m.chargedMicro, 0n),
      requests: tail.reduce((s, m) => s + m.requests, 0),
    });
  }
  return withRatios(bars);
}

/** Number of UTC days a window's day chart spans. */
export function windowDays(window: UsageWindow): number {
  switch (window) {
    case '24h':
      return 2;
    case '7d':
      return 7;
    case '30d':
      return 30;
  }
}

/** Bars per UTC day ending `today`, zero-filled for days without usage. */
export function dayBars(byDay: readonly { day: string; requests: number; chargedMicro: bigint }[], window: UsageWindow, today: Date): Bar[] {
  const days = windowDays(window);
  const byKey = new Map(byDay.map((d) => [d.day, d] as const));
  const bars: Omit<Bar, 'ratio'>[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = utcDayKey(today, -i);
    const row = byKey.get(key);
    bars.push({ key, label: key.slice(5), value: row?.chargedMicro ?? 0n, requests: row?.requests ?? 0 });
  }
  return withRatios(bars);
}

/** Average charged per request in µUSD (0 when there are no requests). */
export function averageCharge(chargedMicro: bigint, requests: number): bigint {
  return requests <= 0 ? 0n : chargedMicro / BigInt(requests);
}
