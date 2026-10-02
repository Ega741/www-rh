import { describe, expect, it } from 'vitest';
import { DEFAULT_GRADUATION_GRACE_SECONDS, formatCountdown, graceEndsAt, graceWindow, initialReopenTracker, sellsReopened, trackReopen, type ReopenTracker } from './grace';
import type { CurvePhaseName } from './types';

const COMPLETED_AT = 1_790_000_000n; // uint64 from completedAt(token)
const GRACE = DEFAULT_GRADUATION_GRACE_SECONDS; // uint32 from graduationGrace() (viem: number)
const END_MS = (Number(COMPLETED_AT) + GRACE) * 1000;

describe('graceEndsAt', () => {
  it('is completedAt + graduationGrace in unix seconds', () => {
    expect(graceEndsAt(COMPLETED_AT, GRACE)).toBe(1_790_086_400);
    expect(graceEndsAt(100, 3600n)).toBe(3700);
  });

  it('is unknown before both reads arrive or while completedAt is 0', () => {
    expect(graceEndsAt(undefined, GRACE)).toBeNull();
    expect(graceEndsAt(COMPLETED_AT, undefined)).toBeNull();
    expect(graceEndsAt(null, null)).toBeNull();
    expect(graceEndsAt(0n, GRACE)).toBeNull();
  });
});

describe('graceWindow (SPEC §2.3 rule 3)', () => {
  it('runs until completedAt + grace with the remaining whole seconds', () => {
    expect(graceWindow(COMPLETED_AT, GRACE, Number(COMPLETED_AT) * 1000)).toEqual({ state: 'running', endsAt: 1_790_086_400, remainingSeconds: GRACE });
    expect(graceWindow(COMPLETED_AT, GRACE, END_MS - 1)).toEqual({ state: 'running', endsAt: 1_790_086_400, remainingSeconds: 1 });
  });

  it('opens sells exactly at completedAt + grace (block.timestamp >= end), like the contract', () => {
    expect(graceWindow(COMPLETED_AT, GRACE, END_MS)).toEqual({ state: 'expired', endsAt: 1_790_086_400, expiredForSeconds: 0 });
    expect(graceWindow(COMPLETED_AT, GRACE, END_MS + 999)).toMatchObject({ state: 'expired', expiredForSeconds: 0 });
    expect(graceWindow(COMPLETED_AT, GRACE, END_MS + 90_000)).toMatchObject({ state: 'expired', expiredForSeconds: 90 });
  });

  it('follows a changed grace (it applies to curves already waiting)', () => {
    const now = Number(COMPLETED_AT) * 1000 + 2 * 3_600_000;
    expect(sellsReopened(COMPLETED_AT, GRACE, now)).toBe(false);
    expect(sellsReopened(COMPLETED_AT, 3600, now)).toBe(true);
  });

  it('is unknown (sells stay disabled) without both values', () => {
    expect(graceWindow(undefined, GRACE, END_MS)).toEqual({ state: 'unknown' });
    expect(graceWindow(0n, GRACE, END_MS)).toEqual({ state: 'unknown' });
    expect(sellsReopened(undefined, undefined, END_MS)).toBe(false);
  });
});

describe('formatCountdown', () => {
  it('formats HH:MM:SS without wrapping hours', () => {
    expect(formatCountdown(0)).toBe('00:00:00');
    expect(formatCountdown(59)).toBe('00:00:59');
    expect(formatCountdown(3_661)).toBe('01:01:01');
    expect(formatCountdown(GRACE)).toBe('24:00:00');
    expect(formatCountdown(30 * 86_400)).toBe('720:00:00');
  });

  it('clamps negative and non-finite input to zero', () => {
    expect(formatCountdown(-5)).toBe('00:00:00');
    expect(formatCountdown(Number.NaN)).toBe('00:00:00');
  });
});

describe('trackReopen (CurveReopened notice)', () => {
  const TOKEN = '0x2222222222222222222222222222222222222222';
  const run = (steps: Array<[CurvePhaseName, bigint | undefined]>, token = TOKEN, start: ReopenTracker = initialReopenTracker) =>
    steps.reduce((t, [phase, completedAt]) => trackReopen(t, { token, phase, completedAt }), start);

  it('flags complete → bonding when completedAt was non-zero', () => {
    const t = run([
      ['complete', undefined],
      ['complete', COMPLETED_AT],
      ['bonding', undefined],
    ]);
    expect(t.reopened).toBe(true);
    expect(t.completedAt).toBe(0n);
  });

  it('does not flag a stale runner "complete" corrected by the chain (completedAt 0 or unread)', () => {
    expect(run([['complete', 0n], ['bonding', 0n]]).reopened).toBe(false);
    expect(run([['complete', undefined], ['bonding', undefined]]).reopened).toBe(false);
    expect(run([['bonding', undefined], ['bonding', undefined]]).reopened).toBe(false);
  });

  it('clears the notice on a new completion or graduation and opens a fresh completedAt scope', () => {
    const reopened = run([['complete', COMPLETED_AT], ['bonding', undefined]]);
    const again = trackReopen(reopened, { token: TOKEN, phase: 'complete', completedAt: COMPLETED_AT });
    expect(again).toMatchObject({ reopened: false, completions: 1, completedAt: 0n }); // the old value is ignored
    expect(trackReopen(again, { token: TOKEN, phase: 'complete', completedAt: COMPLETED_AT + 7_200n }).completedAt).toBe(COMPLETED_AT + 7_200n);
    expect(run([['graduated', undefined]], TOKEN, reopened).reopened).toBe(false);
  });

  it('starts over for another token', () => {
    const reopened = run([['complete', COMPLETED_AT], ['bonding', undefined]]);
    const other = trackReopen(reopened, { token: '0x3333333333333333333333333333333333333333', phase: 'bonding', completedAt: undefined });
    expect(other).toMatchObject({ reopened: false, completions: 0, phase: 'bonding' });
  });

  it('returns the same object when nothing changed (safe React state updater)', () => {
    const t = run([['complete', COMPLETED_AT]]);
    expect(trackReopen(t, { token: TOKEN, phase: 'complete', completedAt: COMPLETED_AT })).toBe(t);
  });
});
