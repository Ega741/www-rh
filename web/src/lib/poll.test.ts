import { describe, expect, it } from 'vitest';
import { IDLE_WATCH, MAX_POLL_ATTEMPTS, WATCH_POLL_MS, creditLanded, observeBalance, observeEvents, purchaseIndexed, restartWatch, startWatch } from './poll.js';

const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const OTHER = '4VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

describe('credit landing watcher', () => {
  it('creditLanded', () => {
    expect(creditLanded(100n, 100n, undefined)).toBe(false);
    expect(creditLanded(100n, 101n, undefined)).toBe(true);
    expect(creditLanded(100n, 150n, 60n)).toBe(false);
    expect(creditLanded(100n, 160n, 60n)).toBe(true);
    expect(creditLanded(100n, 101n, 0n)).toBe(true);
  });
  it('polls for about two minutes as documented', () => {
    expect((WATCH_POLL_MS * MAX_POLL_ATTEMPTS) / 1000).toBe(120);
  });
  it('state machine lands or times out on the balance', () => {
    let s = startWatch(100n, 50n);
    expect(s.status).toBe('watching');
    s = observeBalance(s, 120n);
    expect(s).toMatchObject({ status: 'watching', attempts: 1 });
    expect(observeBalance(s, 150n).status).toBe('landed');
    for (let i = s.attempts; i < MAX_POLL_ATTEMPTS; i++) s = observeBalance(s, 100n);
    expect(s.status).toBe('timeout');
    expect(observeBalance(s, 1000n)).toBe(s);
    expect(restartWatch(s)).toEqual(startWatch(100n, 50n));
    expect(observeBalance(IDLE_WATCH, 1n)).toBe(IDLE_WATCH);
  });
  it('lands on the indexed purchase event of the burn signature (exact match)', () => {
    const s = startWatch(0n, undefined, SIG);
    expect(purchaseIndexed([{ kind: 'draw', signature: SIG }], SIG)).toBe(false);
    expect(purchaseIndexed([{ kind: 'purchase', signature: OTHER }], SIG)).toBe(false);
    expect(purchaseIndexed([{ kind: 'purchase', signature: SIG }], SIG)).toBe(true);
    expect(observeEvents(s, [{ kind: 'purchase', signature: SIG }]).status).toBe('landed');
    expect(observeEvents(s, [{ kind: 'purchase', signature: OTHER }])).toBe(s);
    expect(observeEvents(startWatch(0n, undefined), [{ kind: 'purchase', signature: SIG }]).status).toBe('watching');
    expect(observeEvents(IDLE_WATCH, [])).toBe(IDLE_WATCH);
  });
});
