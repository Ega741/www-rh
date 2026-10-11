import { describe, expect, it } from 'vitest';
import { BPS_DENOMINATOR } from '@beagle/shared/credit';
import {
  DEADLINE_SAFETY_SECONDS,
  DEFAULT_TOLERANCE_BPS,
  EMPTY_FLOW,
  MAX_BUDGET_HOURS,
  TOLERANCE_CHOICES_BPS,
  UINT256_MAX,
  activeStep,
  approvalFor,
  approveLabel,
  budgetDeadline,
  createFlow,
  creditFloor,
  cumulativeApproval,
  describeBlocker,
  failedWith,
  formatBps,
  planBudget,
  planBurn,
  reduceFlow,
  type BlockerCode,
} from './steps.js';

const HASH = `0x${'1'.repeat(64)}` as const;

describe('flow reducer', () => {
  it('walks approve → burn to done', () => {
    let s = createFlow([{ id: 'approve', label: 'Approve' }, { id: 'burn', label: 'Burn' }]);
    expect(s.status).toBe('running');
    s = reduceFlow(s, { type: 'signing', id: 'approve' });
    expect(activeStep(s)?.id).toBe('approve');
    s = reduceFlow(s, { type: 'sent', id: 'approve', hash: HASH });
    expect(s.steps[0]).toMatchObject({ status: 'pending', hash: HASH });
    s = reduceFlow(s, { type: 'confirmed', id: 'approve' });
    s = reduceFlow(s, { type: 'signing', id: 'burn' });
    s = reduceFlow(s, { type: 'sent', id: 'burn', hash: HASH });
    s = reduceFlow(s, { type: 'confirmed', id: 'burn' });
    expect(s.status).toBe('done');
    expect(activeStep(s)).toBeUndefined();
  });
  it('skipped steps count as complete; failures stop the flow', () => {
    let s = createFlow([{ id: 'approve', label: 'Approve' }, { id: 'burn', label: 'Burn' }]);
    s = reduceFlow(s, { type: 'skip', id: 'approve' });
    expect(s.status).toBe('running');
    s = reduceFlow(s, { type: 'failed', id: 'burn', error: 'rejected' });
    expect(s.status).toBe('failed');
    expect(s.steps[1]?.error).toBe('rejected');
    expect(s.steps[1]).not.toHaveProperty('revert');
    expect(reduceFlow(s, { type: 'reset' })).toEqual(EMPTY_FLOW);
    expect(reduceFlow(s, { type: 'confirmed', id: 'nope' })).toEqual(s);
    expect(createFlow([]).status).toBe('idle');
  });
  it('keeps the decoded revert name of a failed step so the page can offer a specific action', () => {
    let s = createFlow([{ id: 'approve', label: 'Approve' }, { id: 'burn', label: 'Burn' }]);
    s = reduceFlow(s, { type: 'skip', id: 'approve' });
    expect(failedWith(s, 'SlippageExceeded')).toBeUndefined();
    s = reduceFlow(s, { type: 'sent', id: 'burn', hash: HASH });
    s = reduceFlow(s, { type: 'failed', id: 'burn', error: 'Price moved against you', revert: 'SlippageExceeded' });
    expect(s.status).toBe('failed');
    expect(failedWith(s, 'SlippageExceeded')).toMatchObject({ id: 'burn', status: 'failed', hash: HASH, error: 'Price moved against you', revert: 'SlippageExceeded' });
    expect(failedWith(s, 'PriceStale')).toBeUndefined();
    // an explicit `revert: undefined` leaves the key out (exactOptionalPropertyTypes-friendly state)
    const generic = reduceFlow(createFlow([{ id: 'x', label: 'X' }]), { type: 'failed', id: 'x', error: 'boom', revert: undefined });
    expect(generic.steps[0]).toEqual({ id: 'x', label: 'X', status: 'failed', error: 'boom' });
  });
});

describe('credit floor', () => {
  it('is quote − ceil(quote · bps / 10 000), 1 % by default', () => {
    expect(DEFAULT_TOLERANCE_BPS).toBe(100);
    expect(creditFloor(2_500_000n)).toBe(2_475_000n);
    expect(creditFloor(2_500_000n, DEFAULT_TOLERANCE_BPS)).toBe(2_475_000n);
    expect(creditFloor(1_000_000n, 50)).toBe(995_000n);
    expect(creditFloor(1_000_000n, 200)).toBe(980_000n);
    expect(creditFloor(1_000_000n, 500)).toBe(950_000n);
  });
  it('rounds the tolerance up, never down (the floor is conservative for the user, not the desk)', () => {
    // 999 · 100 / 10 000 = 9.99 → 10, so the floor is 989 (not 990)
    expect(creditFloor(999n, 100)).toBe(989n);
    // 1 · 100 / 10 000 = 0.01 → 1: the floor collapses to 0, which disables the on-chain check
    expect(creditFloor(1n, 100)).toBe(0n);
    expect(creditFloor(0n)).toBe(0n);
    expect(creditFloor(123_456_789n, 0)).toBe(123_456_789n);
  });
  it('is 0 (floor disabled) for tolerances of 100 % or more', () => {
    expect(creditFloor(1_000_000n, 10_000)).toBe(0n);
    expect(creditFloor(1_000_000n, 20_000)).toBe(0n);
  });
  it('stays exact on big values and rejects bad input', () => {
    expect(creditFloor(10n ** 30n, 100)).toBe(10n ** 30n - 10n ** 28n);
    expect(creditFloor(UINT256_MAX, 10_000)).toBe(0n);
    expect(() => creditFloor(-1n)).toThrow(RangeError);
    expect(() => creditFloor(1n, -1)).toThrow(RangeError);
    expect(() => creditFloor(1n, 1.5)).toThrow(RangeError);
    expect(() => creditFloor(1n, Number.NaN)).toThrow(RangeError);
  });
  it('bounds the slip to the tolerance, within one µUSD of rounding, for every offered choice', () => {
    const quotes = [1n, 7n, 999n, 1_000n, 123_457n, 2_500_000n, 999_999_999n, 10n ** 24n + 3n];
    for (const bps of TOLERANCE_CHOICES_BPS) {
      for (const q of quotes) {
        const floor = creditFloor(q, bps);
        const slip = q - floor;
        expect(floor >= 0n && floor <= q).toBe(true);
        // slip ≥ q · bps / 10 000 (never below the tolerance) …
        expect(slip * BPS_DENOMINATOR >= q * BigInt(bps)).toBe(true);
        // … and slip − 1 < q · bps / 10 000 (at most one µUSD of rounding on top)
        expect((slip - 1n) * BPS_DENOMINATOR < q * BigInt(bps)).toBe(true);
      }
    }
  });
  it('offers 0.5 / 1 / 2 / 5 % with the default among them', () => {
    expect([...TOLERANCE_CHOICES_BPS]).toEqual([50, 100, 200, 500]);
    expect(TOLERANCE_CHOICES_BPS).toContain(DEFAULT_TOLERANCE_BPS);
  });
  it('formats bps as a percentage', () => {
    expect(formatBps(100)).toBe('1 %');
    expect(formatBps(50)).toBe('0.5 %');
    expect(formatBps(200)).toBe('2 %');
    expect(formatBps(500)).toBe('5 %');
    expect(formatBps(25)).toBe('0.25 %');
    expect(formatBps(1)).toBe('0.01 %');
    expect(formatBps(0)).toBe('0 %');
    expect(formatBps(10_000)).toBe('100 %');
    expect(() => formatBps(-1)).toThrow(RangeError);
    expect(() => formatBps(1.5)).toThrow(RangeError);
  });
});

describe('cumulative approval', () => {
  it('approves allowance + amount, capped at uint256.max', () => {
    expect(UINT256_MAX).toBe(2n ** 256n - 1n);
    expect(cumulativeApproval(0n, 1000n)).toBe(1000n);
    expect(cumulativeApproval(400n, 1000n)).toBe(1400n);
    expect(cumulativeApproval(UINT256_MAX - 1n, 5n)).toBe(UINT256_MAX);
    expect(cumulativeApproval(UINT256_MAX, 1n)).toBe(UINT256_MAX);
    expect(() => cumulativeApproval(-1n, 1n)).toThrow(RangeError);
    expect(() => cumulativeApproval(1n, -1n)).toThrow(RangeError);
  });
  it('skips when the allowance covers the amount, cannot decide without an allowance', () => {
    expect(approvalFor(1000n, 1000n)).toEqual({ needsApprove: false, approveAmount: undefined });
    expect(approvalFor(5000n, 1000n)).toEqual({ needsApprove: false, approveAmount: undefined });
    expect(approvalFor(999n, 1000n)).toEqual({ needsApprove: true, approveAmount: 1999n });
    expect(approvalFor(0n, 1000n)).toEqual({ needsApprove: true, approveAmount: 1000n });
    expect(approvalFor(undefined, 1000n)).toEqual({ needsApprove: true, approveAmount: undefined });
  });
  it('labels the approve step with the breakdown when an allowance exists', () => {
    const e18 = 10n ** 18n;
    expect(approveLabel(1500n * e18, 500n * e18, 1000n * e18, 18, 'BEAGLE')).toBe('Approve 1,500 BEAGLE for the credit desk (500 already allowed + 1,000)');
    expect(approveLabel(1000n * e18, 0n, 1000n * e18, 18, 'BEAGLE')).toBe('Approve 1,000 BEAGLE for the credit desk');
    expect(approveLabel(1000n * e18, undefined, 1000n * e18, 18, 'BEAGLE')).toBe('Approve 1,000 BEAGLE for the credit desk');
  });
});

const env = { connected: true, rightChain: true, deskKnown: true, paused: false, workspaceValid: true };

describe('planBurn', () => {
  const base = { ...env, amount: 1000n, usdMicro: 2_500_000n, priceAvailable: true, priceStale: false, minBurn: 10n, balance: 5000n, allowance: 0n };
  it('runs with a cumulative approve when the allowance is short, and the 1 % floor', () => {
    expect(planBurn(base)).toEqual({ canRun: true, blockers: [], needsApprove: true, approveAmount: 1000n, minUsdMicro: 2_475_000n });
    expect(planBurn({ ...base, allowance: 400n })).toMatchObject({ canRun: true, needsApprove: true, approveAmount: 1400n });
    expect(planBurn({ ...base, allowance: UINT256_MAX - 1n, amount: 5n })).toMatchObject({ needsApprove: false, approveAmount: undefined });
  });
  it('skips the approve when the allowance already covers the amount (open budgets share it)', () => {
    expect(planBurn({ ...base, allowance: 1000n })).toMatchObject({ canRun: true, needsApprove: false, approveAmount: undefined });
    expect(planBurn({ ...base, allowance: 1001n }).needsApprove).toBe(false);
    expect(planBurn({ ...base, allowance: 999n })).toMatchObject({ needsApprove: true, approveAmount: 1999n });
  });
  it('blocks while the allowance is unknown instead of approving a non-cumulative amount', () => {
    const p = planBurn({ ...base, allowance: undefined });
    expect(p).toMatchObject({ canRun: false, blockers: ['allowance_unknown'], needsApprove: true, approveAmount: undefined });
  });
  it('applies the chosen tolerance to the live quote', () => {
    expect(planBurn({ ...base, toleranceBps: 50 }).minUsdMicro).toBe(2_487_500n);
    expect(planBurn({ ...base, toleranceBps: 200 }).minUsdMicro).toBe(2_450_000n);
    expect(planBurn({ ...base, toleranceBps: 500 }).minUsdMicro).toBe(2_375_000n);
    expect(planBurn({ ...base, toleranceBps: 0 }).minUsdMicro).toBe(2_500_000n);
  });
  it('needs the live quote (the floor is derived from it)', () => {
    const p = planBurn({ ...base, usdMicro: undefined });
    expect(p.blockers).toEqual(['quote_pending']);
    expect(p.canRun).toBe(false);
    expect(p.minUsdMicro).toBeUndefined();
    // a price problem explains the missing quote; it is not reported twice
    expect(planBurn({ ...base, usdMicro: undefined, priceStale: true }).blockers).toEqual(['price_stale']);
    expect(planBurn({ ...base, usdMicro: undefined, priceAvailable: false }).blockers).toEqual(['price_unavailable']);
    // no amount: nothing to quote yet
    expect(planBurn({ ...base, usdMicro: undefined, amount: undefined }).blockers).toEqual(['no_amount']);
  });
  it('collects blockers', () => {
    expect(planBurn({ ...base, connected: false }).blockers).toEqual(['not_connected']);
    expect(planBurn({ ...base, rightChain: false }).blockers).toEqual(['wrong_chain']);
    expect(planBurn({ ...base, paused: true }).blockers).toEqual(['paused']);
    expect(planBurn({ ...base, priceAvailable: false }).blockers).toEqual(['price_unavailable']);
    expect(planBurn({ ...base, priceStale: true }).blockers).toEqual(['price_stale']);
    expect(planBurn({ ...base, workspaceValid: false }).blockers).toEqual(['bad_workspace']);
    expect(planBurn({ ...base, amount: undefined }).blockers).toEqual(['no_amount']);
    expect(planBurn({ ...base, amount: 5n }).blockers).toEqual(['below_min_burn']);
    expect(planBurn({ ...base, usdMicro: 0n }).blockers).toEqual(['quote_zero']);
    expect(planBurn({ ...base, balance: 10n }).blockers).toEqual(['insufficient_balance']);
    expect(planBurn({ ...base, deskKnown: false }).blockers).toEqual(['desk_unknown']);
    expect(planBurn({ ...base, amount: undefined })).toMatchObject({ needsApprove: false, approveAmount: undefined, minUsdMicro: 2_475_000n });
  });
});

describe('planBudget', () => {
  const base = { ...env, cap: 500n, hours: 24, balance: 100n, allowance: 500n };
  it('ignores balance, validates hours', () => {
    expect(planBudget(base)).toEqual({ canRun: true, blockers: [], needsApprove: false, approveAmount: undefined });
    expect(planBudget({ ...base, hours: 721 }).blockers).toEqual(['bad_hours']);
    expect(planBudget({ ...base, hours: 0 }).blockers).toEqual(['bad_hours']);
    expect(planBudget({ ...base, cap: 0n })).toMatchObject({ blockers: ['no_amount'], needsApprove: false, approveAmount: undefined });
  });
  it('approves allowance + cap so existing budgets keep their allowance', () => {
    expect(planBudget({ ...base, allowance: 1n })).toMatchObject({ canRun: true, needsApprove: true, approveAmount: 501n });
    expect(planBudget({ ...base, allowance: 0n })).toMatchObject({ needsApprove: true, approveAmount: 500n });
    expect(planBudget({ ...base, allowance: 499n })).toMatchObject({ needsApprove: true, approveAmount: 999n });
    expect(planBudget({ ...base, allowance: 10_000n })).toMatchObject({ needsApprove: false, approveAmount: undefined });
    expect(planBudget({ ...base, allowance: undefined })).toMatchObject({ canRun: false, blockers: ['allowance_unknown'], needsApprove: true, approveAmount: undefined });
  });
  it('deadline in unix seconds', () => {
    expect(budgetDeadline(1_760_000_000_000, 2)).toBe(1_760_000_000n + 7200n);
    expect(budgetDeadline(1_760_000_000_999, 719)).toBe(1_760_000_000n + 719n * 3600n);
  });
  it('keeps the maximum duration below the desk limit so a lagging block timestamp cannot revert it', () => {
    const nowMs = 1_760_000_000_000;
    const maxSeconds = BigInt(MAX_BUDGET_HOURS * 3600);
    const deadline = budgetDeadline(nowMs, MAX_BUDGET_HOURS);
    expect(deadline).toBe(1_760_000_000n + maxSeconds - BigInt(DEADLINE_SAFETY_SECONDS));
    // block.timestamp up to DEADLINE_SAFETY_SECONDS behind the browser clock still satisfies deadline <= block.timestamp + 30 days
    const laggingBlock = 1_760_000_000n - BigInt(DEADLINE_SAFETY_SECONDS);
    expect(deadline <= laggingBlock + maxSeconds).toBe(true);
    expect(deadline > 1_760_000_000n).toBe(true);
  });
});

describe('describeBlocker', () => {
  it('has text for every code', () => {
    const ctx = { chainName: 'Robinhood Chain', minBurnText: '10 BEAGLE' };
    expect(describeBlocker('wrong_chain', ctx)).toBe('Switch your wallet to Robinhood Chain');
    expect(describeBlocker('below_min_burn', ctx)).toBe('Minimum burn is 10 BEAGLE');
    expect(describeBlocker('below_min_burn', { chainName: 'x' })).toBe('Amount is below the minimum burn');
    expect(describeBlocker('bad_hours', { chainName: 'x', maxHours: 168 })).toMatch(/168/);
    expect(describeBlocker('quote_pending', ctx)).toMatch(/quote/i);
    expect(describeBlocker('allowance_unknown', ctx)).toMatch(/allowance/i);
    const all: BlockerCode[] = ['not_connected', 'wrong_chain', 'no_session', 'paused', 'price_unavailable', 'price_stale', 'bad_workspace', 'no_amount', 'below_min_burn', 'quote_zero', 'quote_pending', 'insufficient_balance', 'allowance_unknown', 'bad_hours', 'desk_unknown'];
    for (const code of all) expect(describeBlocker(code, ctx).length).toBeGreaterThan(0);
  });
});
