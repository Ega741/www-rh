import { describe, expect, it } from 'vitest';
import { IDLE_WATCH, MAX_POLL_ATTEMPTS, creditLanded, observeBalance, pollDelayMs, startWatch } from './poll.js';

describe('credit landing watcher', () => {
  it('creditLanded', () => {
    expect(creditLanded(100n, 100n, 50n)).toBe(false);
    expect(creditLanded(100n, 149n, 50n)).toBe(false);
    expect(creditLanded(100n, 150n, 50n)).toBe(true);
    expect(creditLanded(100n, 101n, undefined)).toBe(true);
    expect(creditLanded(100n, 100n, undefined)).toBe(false);
  });
  it('poll delay grows and caps', () => {
    expect(pollDelayMs(0)).toBe(1500);
    expect(pollDelayMs(2)).toBe(3000);
    expect(pollDelayMs(100)).toBe(5000);
  });
  it('state machine lands or times out', () => {
    let s = startWatch(1_000_000n, 2_500_000n);
    expect(s.status).toBe('watching');
    s = observeBalance(s, 1_000_000n);
    expect(s).toMatchObject({ status: 'watching', attempts: 1 });
    s = observeBalance(s, 3_500_000n);
    expect(s.status).toBe('landed');
    expect(observeBalance(s, 0n)).toBe(s);
    expect(observeBalance(IDLE_WATCH, 5n)).toBe(IDLE_WATCH);

    let t = startWatch(0n, 1n);
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) t = observeBalance(t, 0n);
    expect(t.status).toBe('timeout');
  });
});
