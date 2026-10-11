import { describe, expect, it } from 'vitest';
import { IDLE_WATCH, MAX_POLL_ATTEMPTS, WATCH_POLL_MS, creditLanded, observeBalance, observeEvents, purchaseIndexed, restartWatch, startWatch } from './poll.js';

const BURN_TX = `0x${'ab'.repeat(32)}` as const;
const OTHER_TX = `0x${'cd'.repeat(32)}` as const;

describe('credit landing watcher', () => {
  it('creditLanded', () => {
    expect(creditLanded(100n, 100n, 50n)).toBe(false);
    expect(creditLanded(100n, 149n, 50n)).toBe(false);
    expect(creditLanded(100n, 150n, 50n)).toBe(true);
    expect(creditLanded(100n, 101n, undefined)).toBe(true);
    expect(creditLanded(100n, 100n, undefined)).toBe(false);
  });
  it('polls for about two minutes as documented', () => {
    expect((MAX_POLL_ATTEMPTS * WATCH_POLL_MS) / 1000).toBeGreaterThanOrEqual(110);
    expect((MAX_POLL_ATTEMPTS * WATCH_POLL_MS) / 1000).toBeLessThanOrEqual(130);
  });
  it('state machine lands or times out on the balance', () => {
    let s = startWatch(1_000_000n, 2_500_000n);
    expect(s.status).toBe('watching');
    expect(s.txHash).toBeUndefined();
    s = observeBalance(s, 1_000_000n);
    expect(s).toMatchObject({ status: 'watching', attempts: 1 });
    s = observeBalance(s, 3_500_000n);
    expect(s.status).toBe('landed');
    expect(observeBalance(s, 0n)).toBe(s);
    expect(observeBalance(IDLE_WATCH, 5n)).toBe(IDLE_WATCH);

    let t = startWatch(0n, 1n);
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) t = observeBalance(t, 0n);
    expect(t.status).toBe('timeout');
    const again = restartWatch(t);
    expect(again).toMatchObject({ status: 'watching', attempts: 0, beforeMicro: 0n, expectedMicro: 1n });
  });
  it('lands on the indexed purchase event even when a concurrent debit shrinks the balance delta', () => {
    const rows = [
      { kind: 'draw', txHash: BURN_TX },
      { kind: 'purchase', txHash: OTHER_TX },
    ];
    expect(purchaseIndexed(rows, BURN_TX)).toBe(false);
    expect(purchaseIndexed([...rows, { kind: 'purchase', txHash: BURN_TX.toUpperCase().replace('0X', '0x') }], BURN_TX)).toBe(true);

    // $10.00 expected, but agent traffic settled $0.05 in the meantime: the balance grew by $9.95 only.
    let s = startWatch(1_000_000n, 10_000_000n, BURN_TX);
    s = observeBalance(s, 10_950_000n);
    expect(s.status).toBe('watching');
    expect(observeEvents(s, rows)).toBe(s);
    s = observeEvents(s, [...rows, { kind: 'purchase', txHash: BURN_TX }]);
    expect(s.status).toBe('landed');
    expect(observeEvents(s, [])).toBe(s);
  });
  it('ignores events without a known burn tx and outside the watching state', () => {
    const s = startWatch(0n, 1n);
    expect(observeEvents(s, [{ kind: 'purchase', txHash: BURN_TX }])).toBe(s);
    expect(observeEvents(IDLE_WATCH, [{ kind: 'purchase', txHash: BURN_TX }])).toBe(IDLE_WATCH);
  });
});
