import { describe, expect, it } from 'vitest';
import { averageCharge, dayBars, modelBars, ratio, windowDays } from './usage.js';
import { isUsageWindow, windowLabel } from './windows.js';

describe('usage bars', () => {
  it('ratio is safe for big values', () => {
    expect(ratio(0n, 10n)).toBe(0);
    expect(ratio(5n, 10n)).toBe(0.5);
    expect(ratio(10n, 10n)).toBe(1);
    expect(ratio(15n, 10n)).toBe(1);
    expect(ratio(10n ** 30n, 4n * 10n ** 30n)).toBe(0.25);
    expect(ratio(1n, 0n)).toBe(0);
  });
  it('modelBars sorts, scales and merges the tail', () => {
    const bars = modelBars(
      [
        { model: 'a', requests: 1, chargedMicro: 100n },
        { model: 'b', requests: 5, chargedMicro: 400n },
        { model: 'c', requests: 2, chargedMicro: 50n },
        { model: 'd', requests: 2, chargedMicro: 25n },
      ],
      2,
    );
    expect(bars.map((b) => b.key)).toEqual(['b', 'a', 'other']);
    expect(bars[0]?.ratio).toBe(1);
    expect(bars[1]?.ratio).toBe(0.25);
    expect(bars[2]).toMatchObject({ label: 'other (2)', value: 75n, requests: 4 });
    expect(modelBars([])).toEqual([]);
  });
  it('dayBars zero-fills the window', () => {
    const today = new Date(Date.UTC(2026, 9, 11));
    const bars = dayBars([{ day: '2026-10-10', requests: 3, chargedMicro: 300n }], '7d', today);
    expect(bars).toHaveLength(7);
    expect(bars[0]?.key).toBe('2026-10-05');
    expect(bars[6]?.key).toBe('2026-10-11');
    expect(bars[5]).toMatchObject({ label: '10-10', value: 300n, requests: 3, ratio: 1 });
    expect(bars[6]).toMatchObject({ value: 0n, requests: 0, ratio: 0 });
    expect(dayBars([], '24h', today)).toHaveLength(2);
    expect(windowDays('30d')).toBe(30);
  });
  it('windows and averages', () => {
    expect(isUsageWindow('7d')).toBe(true);
    expect(isUsageWindow('1y')).toBe(false);
    expect(windowLabel('24h')).toBe('Last 24 hours');
    expect(averageCharge(1000n, 4)).toBe(250n);
    expect(averageCharge(1000n, 0)).toBe(0n);
  });
});
