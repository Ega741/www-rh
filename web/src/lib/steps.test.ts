import { describe, expect, it } from 'vitest';
import { DEADLINE_SAFETY_SECONDS, EMPTY_FLOW, MAX_BUDGET_HOURS, activeStep, budgetDeadline, createFlow, describeBlocker, planBudget, planBurn, reduceFlow } from './steps.js';

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
    expect(reduceFlow(s, { type: 'reset' })).toEqual(EMPTY_FLOW);
    expect(reduceFlow(s, { type: 'confirmed', id: 'nope' })).toEqual(s);
    expect(createFlow([]).status).toBe('idle');
  });
});

const env = { connected: true, rightChain: true, deskKnown: true, paused: false, workspaceValid: true };

describe('planBurn', () => {
  const base = { ...env, amount: 1000n, usdMicro: 2_500_000n, priceAvailable: true, priceStale: false, minBurn: 10n, balance: 5000n, allowance: 0n };
  it('runs with approve when allowance is short', () => {
    expect(planBurn(base)).toEqual({ canRun: true, blockers: [], needsApprove: true });
    expect(planBurn({ ...base, allowance: 1000n }).needsApprove).toBe(false);
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
    expect(planBurn({ ...base, amount: undefined }).needsApprove).toBe(false);
  });
});

describe('planBudget', () => {
  const base = { ...env, cap: 500n, hours: 24, balance: 100n, allowance: 500n };
  it('ignores balance, validates hours', () => {
    expect(planBudget(base)).toEqual({ canRun: true, blockers: [], needsApprove: false });
    expect(planBudget({ ...base, allowance: 1n }).needsApprove).toBe(true);
    expect(planBudget({ ...base, hours: 721 }).blockers).toEqual(['bad_hours']);
    expect(planBudget({ ...base, hours: 0 }).blockers).toEqual(['bad_hours']);
    expect(planBudget({ ...base, cap: 0n }).blockers).toEqual(['no_amount']);
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
  });
});
