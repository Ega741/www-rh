import { describe, expect, it } from 'vitest';
import { EMPTY_FLOW, STALLED_TEXT, activeStep, budgetState, createFlow, describeBlocker, lastSignature, minCreditTokens, planBudget, planBurn, reduceFlow, replacesCapNote, type BlockerCode, type FlowEnv } from './steps.js';

const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const OPERATOR = 'BEJQY85xuHoT2NyAT5eXF9ftMv6RnSM7LQSujxm8BAbZ';

describe('flow reducer', () => {
  it('walks a single burn step to done', () => {
    let s = createFlow([{ id: 'burn', label: 'Burn' }]);
    expect(s.status).toBe('running');
    s = reduceFlow(s, { type: 'signing', id: 'burn' });
    expect(activeStep(s)?.id).toBe('burn');
    s = reduceFlow(s, { type: 'sent', id: 'burn', signature: SIG });
    expect(s.steps[0]).toMatchObject({ status: 'pending', signature: SIG });
    s = reduceFlow(s, { type: 'confirmed', id: 'burn' });
    expect(s.status).toBe('done');
    expect(activeStep(s)).toBeUndefined();
    expect(lastSignature(s)).toBe(SIG);
  });
  it('skipped steps count as complete; failures stop the flow and keep logs', () => {
    let s = createFlow([{ id: 'approve', label: 'Approve' }, { id: 'register', label: 'Register' }]);
    s = reduceFlow(s, { type: 'skip', id: 'approve' });
    expect(s.status).toBe('running');
    s = reduceFlow(s, { type: 'failed', id: 'register', error: 'rejected', logs: [] });
    expect(s.status).toBe('failed');
    expect(s.steps[1]?.error).toBe('rejected');
    expect(s.steps[1]).not.toHaveProperty('logs');
    const withLogs = reduceFlow(createFlow([{ id: 'x', label: 'x' }]), { type: 'failed', id: 'x', error: 'e', signature: SIG, logs: ['Program log: boom'] });
    expect(withLogs.steps[0]).toMatchObject({ status: 'failed', signature: SIG, logs: ['Program log: boom'] });
    expect(lastSignature(withLogs)).toBe(SIG);
    expect(lastSignature(EMPTY_FLOW)).toBeUndefined();
    expect(reduceFlow(s, { type: 'reset' })).toEqual(EMPTY_FLOW);
    expect(reduceFlow(s, { type: 'confirmed', id: 'nope' })).toEqual(s);
    expect(createFlow([]).status).toBe('idle');
  });
});

const READY: FlowEnv = { connected: true, deploymentKnown: true, configMismatch: false, workspaceValid: true, accountKnown: true, hasTokenAccount: true, balance: 10_000_000n };

describe('planBurn', () => {
  const base = { ...READY, amount: 1_000_000n, usdMicro: 10_000n, priceAvailable: true, priceStale: false, minCreditMicro: 1_000n };
  it('runs with a fresh price, a quote above the minimum and enough balance', () => {
    expect(planBurn(base)).toEqual({ canRun: true, blockers: [] });
  });
  it('blocks on a stale or missing price before anything else about the quote', () => {
    expect(planBurn({ ...base, priceStale: true }).blockers).toEqual(['price_stale']);
    expect(planBurn({ ...base, priceAvailable: false, usdMicro: undefined }).blockers).toEqual(['price_unavailable']);
  });
  it('enforces the minimum credit in µUSD and rejects zero quotes', () => {
    expect(planBurn({ ...base, usdMicro: 999n }).blockers).toEqual(['below_min_credit']);
    expect(planBurn({ ...base, usdMicro: 1_000n }).canRun).toBe(true);
    expect(planBurn({ ...base, usdMicro: 0n }).blockers).toEqual(['quote_zero']);
    expect(planBurn({ ...base, usdMicro: 5n, minCreditMicro: undefined }).canRun).toBe(true);
  });
  it('checks the token account and the balance', () => {
    expect(planBurn({ ...base, accountKnown: false }).blockers).toEqual(['account_pending']);
    expect(planBurn({ ...base, hasTokenAccount: false, balance: 0n }).blockers).toEqual(['no_token_account']);
    expect(planBurn({ ...base, balance: 999_999n }).blockers).toEqual(['insufficient_balance']);
    expect(planBurn({ ...base, balance: undefined }).canRun).toBe(true);
  });
  it('collects environment blockers and stops at a missing amount', () => {
    expect(planBurn({ ...base, connected: false, amount: undefined }).blockers).toEqual(['not_connected', 'no_amount']);
    expect(planBurn({ ...base, configMismatch: true, deploymentKnown: false }).blockers).toEqual(['config_mismatch']);
    expect(planBurn({ ...base, deploymentKnown: false }).blockers).toEqual(['deployment_unknown']);
    expect(planBurn({ ...base, workspaceValid: false, amount: 0n }).blockers).toEqual(['bad_workspace', 'no_amount']);
    // Account blockers are not reported while the wallet is disconnected (nothing to read).
    expect(planBurn({ ...base, connected: false, accountKnown: false }).blockers).toEqual(['not_connected']);
  });
});

describe('planBudget', () => {
  const base = { ...READY, cap: 5_000_000n, operatorKnown: true };
  it('runs and flags a cap above the balance as advisory', () => {
    expect(planBudget(base)).toEqual({ canRun: true, blockers: [], capAboveBalance: false });
    expect(planBudget({ ...base, cap: 50_000_000n })).toEqual({ canRun: true, blockers: [], capAboveBalance: true });
  });
  it('needs the operator, a cap and an existing token account', () => {
    expect(planBudget({ ...base, operatorKnown: false }).blockers).toEqual(['operator_unknown']);
    expect(planBudget({ ...base, cap: undefined }).blockers).toEqual(['no_amount']);
    expect(planBudget({ ...base, cap: 0n }).canRun).toBe(false);
    expect(planBudget({ ...base, hasTokenAccount: false, balance: 0n }).blockers).toEqual(['no_token_account']);
    expect(planBudget({ ...base, accountKnown: false }).blockers).toEqual(['account_pending']);
    expect(planBudget({ ...base, configMismatch: true, operatorKnown: false }).blockers).toEqual(['config_mismatch']);
  });
});

describe('describeBlocker', () => {
  it('has text for every code', () => {
    const codes: BlockerCode[] = ['not_connected', 'no_session', 'deployment_unknown', 'config_mismatch', 'operator_unknown', 'price_unavailable', 'price_stale', 'bad_workspace', 'no_amount', 'below_min_credit', 'quote_zero', 'no_token_account', 'insufficient_balance', 'account_pending'];
    for (const c of codes) expect(describeBlocker(c, { symbol: 'BEAGLE' }).length).toBeGreaterThan(5);
    expect(describeBlocker('below_min_credit', { symbol: 'BEAGLE', minCreditText: '$0.001 (0.1 BEAGLE)' })).toBe('Minimum credit is $0.001 (0.1 BEAGLE)');
    expect(describeBlocker('no_token_account', { symbol: 'BGL' })).toBe('This wallet has no BGL token account');
  });
});

describe('minCreditTokens', () => {
  it('is the ceiling amount quoting the minimum credit', () => {
    // $0.001 at $0.01 per token with 6 decimals = 0.1 BEAGLE = 100_000 raw
    expect(minCreditTokens(1_000n, 10n ** 16n, 6)).toBe(100_000n);
    expect(minCreditTokens(1_000n, 3n * 10n ** 15n, 6)).toBe(333_334n);
    expect(minCreditTokens(1_000n, undefined, 6)).toBeUndefined();
    expect(minCreditTokens(1_000n, 0n, 6)).toBeUndefined();
  });
});

describe('budget display', () => {
  const open = { closed: false, stalledReason: null, headroomTokens: 5n, delegate: OPERATOR };
  it('labels states in priority order', () => {
    expect(budgetState(open, OPERATOR)).toEqual({ label: 'open', tone: 'ok' });
    expect(budgetState({ ...open, closed: true }, OPERATOR)).toEqual({ label: 'closed', tone: 'neutral' });
    expect(budgetState({ ...open, stalledReason: 'price' }, OPERATOR)).toEqual({ label: `stalled: ${STALLED_TEXT.price}`, tone: 'warn' });
    expect(budgetState({ ...open, delegate: null }, OPERATOR)).toEqual({ label: 'revoked', tone: 'neutral' });
    expect(budgetState({ ...open, delegate: '11111111111111111111111111111111' }, OPERATOR)).toEqual({ label: 'delegated elsewhere', tone: 'neutral' });
    expect(budgetState({ ...open, headroomTokens: 0n }, OPERATOR)).toEqual({ label: 'exhausted', tone: 'neutral' });
    expect(budgetState({ ...open, delegate: null }, undefined)).toEqual({ label: 'open', tone: 'ok' });
  });
  it('explains that a new approval replaces the cap', () => {
    expect(replacesCapNote(0n, '0 BEAGLE')).toBeUndefined();
    expect(replacesCapNote(5n, '5 BEAGLE')).toMatch(/already delegates 5 BEAGLE .* replaces that cap/);
  });
});
