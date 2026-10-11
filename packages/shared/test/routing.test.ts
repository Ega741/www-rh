import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, mergeCatalog, type ModelSpec, type Provider } from '../src/models.js';
import {
  DEFAULT_LOW_CREDIT_MICRO_USD,
  DEFAULT_PREFERENCE,
  DEFAULT_VERY_LOW_CREDIT_MICRO_USD,
  INSUFFICIENT_CREDIT_MESSAGE,
  aliasTier,
  autoTier,
  incapableReason,
  route,
  type ProviderState,
  type RoutingDecision,
  type RoutingInput,
} from '../src/routing.js';

const ok = (): Record<Provider, ProviderState> => ({
  anthropic: { state: 'ok' },
  openai: { state: 'ok' },
  google: { state: 'ok' },
  house: { state: 'ok' },
});

const RICH = 100_000_000n; // $100

function input(over: Partial<RoutingInput> = {}): RoutingInput {
  return {
    requested: 'beagle/auto',
    difficulty: 0.9,
    needs: { tools: false, vision: false, json: false, contextTokens: 1_000, maxOutputTokens: 1_000 },
    workspace: { availableMicroUsd: RICH, plan: 'free', byok: [] },
    providers: ok(),
    catalog: DEFAULT_CATALOG,
    ...over,
  };
}

function ids(d: RoutingDecision): string[] {
  if (d.kind !== 'ok') throw new Error(`expected ok, got ${d.code}: ${d.message}\n${d.reasons.join('\n')}`);
  return d.candidates.map((c) => c.model.id);
}

function paid(d: RoutingDecision): string[] {
  if (d.kind !== 'ok') throw new Error(`expected ok, got ${d.code}`);
  return d.candidates.map((c) => `${c.model.id}:${c.paidBy}`);
}

describe('tier mapping', () => {
  it('autoTier thresholds', () => {
    expect(autoTier(0.66)).toBe('frontier');
    expect(autoTier(0.9)).toBe('frontier');
    expect(autoTier(0.65)).toBe('efficient');
    expect(autoTier(0.33)).toBe('efficient');
    expect(autoTier(0.32)).toBe('budget');
    expect(autoTier(0)).toBe('budget');
  });
  it('aliasTier', () => {
    expect(aliasTier('beagle/best', 0)).toBe('frontier');
    expect(aliasTier('beagle/cheap', 1)).toBe('budget');
    expect(aliasTier('beagle/house', 1)).toBe('house');
    expect(aliasTier('beagle/auto', 0.5)).toBe('efficient');
  });
  it('defaults', () => {
    expect(DEFAULT_PREFERENCE).toEqual(['anthropic', 'openai', 'google', 'house']);
    expect(DEFAULT_LOW_CREDIT_MICRO_USD).toBe(1_000_000n);
    expect(DEFAULT_VERY_LOW_CREDIT_MICRO_USD).toBe(100_000n);
  });
});

describe('incapableReason', () => {
  const house = DEFAULT_CATALOG.find((m) => m.id === 'house/gpt-oss-20b')!;
  const large = DEFAULT_CATALOG.find((m) => m.id === 'house/gpt-oss-120b')!;
  const nano = DEFAULT_CATALOG.find((m) => m.id === 'openai/gpt-5.4-nano')!;
  const needs = { tools: false, vision: false, json: false, contextTokens: 10, maxOutputTokens: 10 };
  it('checks capabilities, context, plan and the house free limit', () => {
    expect(incapableReason(house, needs, 'free')).toBeUndefined();
    expect(incapableReason(house, { ...needs, vision: true }, 'free')).toBe('no vision');
    expect(incapableReason(nano, { ...needs, tools: true, json: true }, 'free')).toBeUndefined();
    expect(incapableReason(house, { ...needs, contextTokens: 131_072, maxOutputTokens: 1 }, 'pro')).toMatch(/^context 131073 > 131072$/);
    expect(incapableReason(large, needs, 'free')).toBe('requires plan pro');
    expect(incapableReason(large, needs, 'pro')).toBeUndefined();
    expect(incapableReason(house, { ...needs, contextTokens: 32_000, maxOutputTokens: 1_000 }, 'free')).toBe('house_context_pro');
    expect(incapableReason(house, { ...needs, contextTokens: 32_000, maxOutputTokens: 1_000 }, 'pro')).toBeUndefined();
    expect(incapableReason(house, { ...needs, contextTokens: 32_000, maxOutputTokens: 1_000 }, 'free', 40_000)).toBeUndefined();
  });
});

describe('route: scenarios of SPEC §4.6', () => {
  it('(a) beagle/auto hard request, rich credit, all ok → frontier, anthropic > openai > google, down to house', () => {
    const d = route(input());
    expect(d.kind).toBe('ok');
    if (d.kind !== 'ok') return;
    expect(d.tier).toBe('frontier');
    expect(ids(d)).toEqual([
      'anthropic/claude-opus-5-5',
      'openai/gpt-5.5',
      'google/gemini-3.1-pro',
      'anthropic/claude-sonnet-5-5',
      'openai/gpt-5.4-mini',
      'google/gemini-3-flash',
      'anthropic/claude-haiku-5-5',
      'openai/gpt-5.4-nano',
      'google/gemini-3.1-flash-lite',
      'house/gpt-oss-20b',
    ]);
    expect(d.candidates.every((c) => c.paidBy === 'credit')).toBe(true);
    expect(d.reasons.length).toBeGreaterThanOrEqual(7);
    expect(d.reasons[0]).toMatch(/^resolve: alias beagle\/auto → tier frontier \(difficulty 0\.90\)/);
    for (const r of d.reasons) expect(typeof r).toBe('string');
    expect(d.reasons.some((r) => r.startsWith('candidates: anthropic/claude-opus-5-5(credit) > openai/gpt-5.5(credit)'))).toBe(true);
  });

  it('(b) anthropic down → openai first', () => {
    const d = route(input({ providers: { ...ok(), anthropic: { state: 'down' } } }));
    expect(ids(d)[0]).toBe('openai/gpt-5.5');
    expect(ids(d)).not.toContain('anthropic/claude-opus-5-5');
    expect(ids(d)).not.toContain('anthropic/claude-haiku-5-5');
    if (d.kind === 'ok') expect(d.reasons.some((r) => /anthropic down/.test(r))).toBe(true);
  });

  it('degraded providers sort after ok ones within a tier', () => {
    const d = route(input({ providers: { ...ok(), anthropic: { state: 'degraded' } } }));
    expect(ids(d).slice(0, 3)).toEqual(['openai/gpt-5.5', 'google/gemini-3.1-pro', 'anthropic/claude-opus-5-5']);
  });

  it('(c) low credit moves one tier cheaper; very low credit goes to house', () => {
    const low = route(input({ workspace: { availableMicroUsd: 999_999n, plan: 'free', byok: [] } }));
    expect(low.kind === 'ok' && low.tier).toBe('efficient');
    expect(ids(low)[0]).toBe('anthropic/claude-sonnet-5-5');
    expect(ids(low)).not.toContain('anthropic/claude-opus-5-5');
    const veryLow = route(input({ workspace: { availableMicroUsd: 99_999n, plan: 'free', byok: [] } }));
    expect(veryLow.kind === 'ok' && veryLow.tier).toBe('house');
    expect(ids(veryLow)).toEqual(['house/gpt-oss-20b']);
    const exactlyLow = route(input({ workspace: { availableMicroUsd: 1_000_000n, plan: 'free', byok: [] } }));
    expect(exactlyLow.kind === 'ok' && exactlyLow.tier).toBe('frontier');
    const custom = route(input({ workspace: { availableMicroUsd: 5_000_000n, plan: 'free', byok: [] }, limits: { lowCreditMicroUsd: 10_000_000n } }));
    expect(custom.kind === 'ok' && custom.tier).toBe('efficient');
  });

  it('(d) zero credit without BYOK → insufficient_credit; with BYOK anthropic → only anthropic byok candidates', () => {
    const none = route(input({ workspace: { availableMicroUsd: 0n, plan: 'free', byok: [] } }));
    expect(none).toMatchObject({ kind: 'error', code: 'insufficient_credit', message: INSUFFICIENT_CREDIT_MESSAGE });
    const negative = route(input({ workspace: { availableMicroUsd: -5n, plan: 'free', byok: [] } }));
    expect(negative.kind === 'error' && negative.code).toBe('insufficient_credit');

    const byok = route(input({ workspace: { availableMicroUsd: 0n, plan: 'free', byok: ['anthropic'] } }));
    expect(paid(byok)).toEqual(['anthropic/claude-opus-5-5:byok', 'anthropic/claude-sonnet-5-5:byok', 'anthropic/claude-haiku-5-5:byok']);
    expect(byok.kind === 'ok' && byok.tier).toBe('frontier');
  });

  it('BYOK candidates come first within a tier and survive a down provider', () => {
    // Deliberate reading of §4.6 step 5: `down` describes the platform's credentials with the provider, so
    // only credit-paid candidates are dropped; the workspace's own key is still tried first.
    const d = route(input({ workspace: { availableMicroUsd: RICH, plan: 'free', byok: ['google'] }, providers: { ...ok(), google: { state: 'down' } } }));
    expect(paid(d).slice(0, 3)).toEqual(['google/gemini-3.1-pro:byok', 'anthropic/claude-opus-5-5:credit', 'openai/gpt-5.5:credit']);
    expect(d.kind === 'ok' && d.reasons.some((r) => r.includes('google down (credit-paid dropped)'))).toBe(true);
    // the same provider without a BYOK key contributes nothing
    const credit = route(input({ providers: { ...ok(), google: { state: 'down' } } }));
    expect(ids(credit).some((id) => id.startsWith('google/'))).toBe(false);
  });

  it('platform quota does not reorder BYOK candidates, a degraded provider state still does', () => {
    const byok2 = { availableMicroUsd: RICH, plan: 'free' as const, byok: ['openai', 'google'] as Provider[] };
    // openai quota is the platform's limit, not the workspace key's: preference order holds
    const quota = route(input({ difficulty: 0.3, providers: { ...ok(), openai: { state: 'ok', quotaRatio: 0.1 } }, workspace: byok2 }));
    expect(paid(quota).slice(0, 3)).toEqual(['openai/gpt-5.4-nano:byok', 'google/gemini-3.1-flash-lite:byok', 'anthropic/claude-haiku-5-5:credit']);
    expect(quota.kind === 'ok' && quota.reasons.some((r) => r.startsWith('quota:'))).toBe(false);
    // half-open (degraded) is about the upstream itself and applies to BYOK too
    const degraded = route(input({ difficulty: 0.3, providers: { ...ok(), openai: { state: 'degraded' } }, workspace: byok2 }));
    expect(paid(degraded).slice(0, 2)).toEqual(['google/gemini-3.1-flash-lite:byok', 'openai/gpt-5.4-nano:byok']);
  });

  it('(e) explicit model with fallback none / cheaper / any', () => {
    const none = route(input({ requested: 'anthropic/claude-opus-5-5', fallback: 'none' }));
    expect(ids(none)).toEqual(['anthropic/claude-opus-5-5']);
    expect(none.kind === 'ok' && none.tier).toBe('frontier');

    const cheaper = route(input({ requested: 'anthropic/claude-sonnet-5-5', fallback: 'cheaper' }));
    expect(ids(cheaper)).toEqual([
      'anthropic/claude-sonnet-5-5',
      'openai/gpt-5.4-mini',
      'google/gemini-3-flash',
      'anthropic/claude-haiku-5-5',
      'openai/gpt-5.4-nano',
      'google/gemini-3.1-flash-lite',
      'house/gpt-oss-20b',
    ]);

    const any = route(input({ requested: 'anthropic/claude-sonnet-5-5', fallback: 'any' }));
    expect(ids(any)).toEqual([...ids(cheaper), 'anthropic/claude-opus-5-5', 'openai/gpt-5.5', 'google/gemini-3.1-pro']);

    // default fallback is cheaper, also for explicit ids
    expect(ids(route(input({ requested: 'anthropic/claude-sonnet-5-5' })))).toEqual(ids(cheaper));
    // from budget with any: budget, house, then efficient, then frontier
    const fromBudget = route(input({ requested: 'anthropic/claude-haiku-5-5', fallback: 'any' }));
    expect(ids(fromBudget)).toEqual([
      'anthropic/claude-haiku-5-5',
      'openai/gpt-5.4-nano',
      'google/gemini-3.1-flash-lite',
      'house/gpt-oss-20b',
      'anthropic/claude-sonnet-5-5',
      'openai/gpt-5.4-mini',
      'google/gemini-3-flash',
      'anthropic/claude-opus-5-5',
      'openai/gpt-5.5',
      'google/gemini-3.1-pro',
    ]);
  });

  it('(f) house/gpt-oss-120b needs the pro plan', () => {
    const free = route(input({ requested: 'house/gpt-oss-120b' }));
    expect(free).toMatchObject({ kind: 'error', code: 'plan_required' });
    expect(free.kind === 'error' && free.message).toMatch(/pro plan/);
    const pro = route(input({ requested: 'house/gpt-oss-120b', workspace: { availableMicroUsd: RICH, plan: 'pro', byok: [] } }));
    expect(ids(pro)).toEqual(['house/gpt-oss-120b', 'house/gpt-oss-20b']);
    // aliases include the large house model only on pro
    expect(ids(route(input({ requested: 'beagle/house' })))).toEqual(['house/gpt-oss-20b']);
    expect(ids(route(input({ requested: 'beagle/house', workspace: { availableMicroUsd: RICH, plan: 'pro', byok: [] } })))).toEqual(['house/gpt-oss-20b', 'house/gpt-oss-120b']);
  });

  it('(g) capability filter: tools / vision / context; nothing fits → no_capable_model', () => {
    const noTools = mergeCatalog(DEFAULT_CATALOG, [{ id: 'anthropic/claude-opus-5-5', capabilities: { tools: false } }]);
    const d = route(input({ catalog: noTools, needs: { tools: true, vision: false, json: false, contextTokens: 10, maxOutputTokens: 10 } }));
    expect(ids(d)).not.toContain('anthropic/claude-opus-5-5');
    expect(ids(d)[0]).toBe('openai/gpt-5.5');
    if (d.kind === 'ok') expect(d.reasons.some((r) => r.includes('anthropic/claude-opus-5-5 (no tools)'))).toBe(true);

    const vision = route(input({ needs: { tools: false, vision: true, json: false, contextTokens: 10, maxOutputTokens: 10 } }));
    expect(ids(vision)).not.toContain('house/gpt-oss-20b');
    expect(ids(vision)).toContain('openai/gpt-5.4-nano');

    const explicitExcluded = route(input({ requested: 'house/gpt-oss-20b', needs: { tools: false, vision: true, json: false, contextTokens: 10, maxOutputTokens: 10 }, fallback: 'none' }));
    expect(explicitExcluded).toMatchObject({ kind: 'error', code: 'no_capable_model' });

    const huge = route(input({ needs: { tools: false, vision: false, json: false, contextTokens: 2_000_000, maxOutputTokens: 10 } }));
    expect(huge).toMatchObject({ kind: 'error', code: 'no_capable_model' });
    expect(huge.kind === 'error' && huge.reasons.some((r) => r.startsWith('capability: dropped'))).toBe(true);

    const medium = route(input({ needs: { tools: false, vision: false, json: false, contextTokens: 500_000, maxOutputTokens: 10 } }));
    expect(ids(medium)).not.toContain('openai/gpt-5.5');
    expect(ids(medium)).not.toContain('house/gpt-oss-20b');
    expect(ids(medium)[0]).toBe('anthropic/claude-opus-5-5');
  });

  it('house is skipped for free plans above 32K context (house_context_pro)', () => {
    const needs = { tools: false, vision: false, json: false, contextTokens: 40_000, maxOutputTokens: 1_000 };
    const free = route(input({ requested: 'beagle/cheap', needs }));
    expect(ids(free)).not.toContain('house/gpt-oss-20b');
    expect(free.kind === 'ok' && free.reasons.some((r) => r.includes('house_context_pro'))).toBe(true);
    const pro = route(input({ requested: 'beagle/cheap', needs, workspace: { availableMicroUsd: RICH, plan: 'pro', byok: [] } }));
    expect(ids(pro)).toContain('house/gpt-oss-20b');
    const houseOnly = route(input({ requested: 'beagle/house', needs, fallback: 'none' }));
    expect(houseOnly).toMatchObject({ kind: 'error', code: 'no_capable_model' });
  });

  it('(h) quotaRatio < 0.2 demotes openai behind cheaper tiers for easy requests only', () => {
    const providers = { ...ok(), openai: { state: 'ok' as const, quotaRatio: 0.1 } };
    const easy = route(input({ difficulty: 0.3, providers }));
    expect(ids(easy)).toEqual(['anthropic/claude-haiku-5-5', 'google/gemini-3.1-flash-lite', 'house/gpt-oss-20b', 'openai/gpt-5.4-nano']);
    expect(easy.kind === 'ok' && easy.tier).toBe('budget');
    expect(easy.kind === 'ok' && easy.reasons.some((r) => r.startsWith('quota:'))).toBe(true);

    const hard = route(input({ difficulty: 0.9, providers }));
    expect(ids(hard).slice(0, 4)).toEqual(['anthropic/claude-opus-5-5', 'google/gemini-3.1-pro', 'openai/gpt-5.5', 'anthropic/claude-sonnet-5-5']);
    expect(hard.kind === 'ok' && hard.reasons.some((r) => r.startsWith('quota:'))).toBe(false);

    // quota at exactly 0.2 is not limited
    const fine = route(input({ difficulty: 0.3, providers: { ...ok(), openai: { state: 'ok', quotaRatio: 0.2 } } }));
    expect(ids(fine)).toEqual(['anthropic/claude-haiku-5-5', 'openai/gpt-5.4-nano', 'google/gemini-3.1-flash-lite', 'house/gpt-oss-20b']);

    // BYOK candidates are not subject to platform quota
    const byok = route(input({ difficulty: 0.3, providers, workspace: { availableMicroUsd: RICH, plan: 'free', byok: ['openai'] } }));
    expect(ids(byok)[0]).toBe('openai/gpt-5.4-nano');
  });

  it('(i) is deterministic', () => {
    const a = route(input({ providers: { ...ok(), openai: { state: 'degraded', quotaRatio: 0.5 } }, workspace: { availableMicroUsd: 500_000n, plan: 'pro', byok: ['google'] } }));
    const b = route(input({ providers: { ...ok(), openai: { state: 'degraded', quotaRatio: 0.5 } }, workspace: { availableMicroUsd: 500_000n, plan: 'pro', byok: ['google'] } }));
    expect(a).toEqual(b);
    expect(JSON.stringify(a, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).toBe(
      JSON.stringify(b, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  });

  it('(j) claude-fable-5-1 is never added by expansion but stays first when explicit', () => {
    for (const requested of ['beagle/auto', 'beagle/best', 'anthropic/claude-opus-5-5', 'anthropic/claude-haiku-5-5']) {
      expect(ids(route(input({ requested, fallback: 'any' })))).not.toContain('anthropic/claude-fable-5-1');
    }
    const explicit = route(input({ requested: 'anthropic/claude-fable-5-1' }));
    expect(ids(explicit)[0]).toBe('anthropic/claude-fable-5-1');
    expect(ids(explicit)).toContain('anthropic/claude-opus-5-5');
    expect(ids(route(input({ requested: 'anthropic/claude-fable-5-1', fallback: 'none' })))).toEqual(['anthropic/claude-fable-5-1']);
    // stays first even when its provider is degraded
    const degraded = route(input({ requested: 'anthropic/claude-fable-5-1', providers: { ...ok(), anthropic: { state: 'degraded' } } }));
    expect(ids(degraded)[0]).toBe('anthropic/claude-fable-5-1');
  });

  it('(k) bare upstream id resolves', () => {
    const d = route(input({ requested: 'claude-sonnet-5-5', fallback: 'none' }));
    expect(ids(d)).toEqual(['anthropic/claude-sonnet-5-5']);
    expect(d.kind === 'ok' && d.reasons[0]).toBe('resolve: explicit anthropic/claude-sonnet-5-5 (tier efficient, from "claude-sonnet-5-5")');
  });

  it('unknown model', () => {
    const d = route(input({ requested: 'nope/nothing' }));
    expect(d).toMatchObject({ kind: 'error', code: 'unknown_model' });
    expect(d.reasons).toEqual(['resolve: unknown model "nope/nothing"']);
  });

  it('alias with fallback none keeps a single candidate of the target tier', () => {
    const d = route(input({ requested: 'beagle/best', fallback: 'none' }));
    expect(ids(d)).toEqual(['anthropic/claude-opus-5-5']);
    const empty = route(input({ requested: 'beagle/house', fallback: 'none', providers: { ...ok(), house: { state: 'down' } } }));
    expect(empty).toMatchObject({ kind: 'error', code: 'no_capable_model' });
  });

  it('explicit requests keep their tier at low credit and fail only at zero credit', () => {
    const low = route(input({ requested: 'anthropic/claude-opus-5-5', workspace: { availableMicroUsd: 50_000n, plan: 'free', byok: [] } }));
    expect(ids(low)[0]).toBe('anthropic/claude-opus-5-5');
    expect(low.kind === 'ok' && low.tier).toBe('frontier');
    const zero = route(input({ requested: 'anthropic/claude-opus-5-5', workspace: { availableMicroUsd: 0n, plan: 'free', byok: [] } }));
    expect(zero).toMatchObject({ kind: 'error', code: 'insufficient_credit' });
  });

  it('all providers down → no_capable_model (not insufficient_credit)', () => {
    const d = route(input({ providers: { anthropic: { state: 'down' }, openai: { state: 'down' }, google: { state: 'down' }, house: { state: 'down' } } }));
    expect(d).toMatchObject({ kind: 'error', code: 'no_capable_model' });
  });

  it('(l) zero credit when the house tier cannot serve → insufficient_credit, not no_capable_model', () => {
    const broke = { availableMicroUsd: 0n, plan: 'free' as const, byok: [] };
    const small = { tools: false, vision: false, json: false, contextTokens: 10, maxOutputTokens: 10 };
    const wide = { ...small, contextTokens: 40_000, maxOutputTokens: 100 };
    const expect402 = (d: RoutingDecision, label: string): void => {
      expect(d, label).toMatchObject({ kind: 'error', code: 'insufficient_credit', message: INSUFFICIENT_CREDIT_MESSAGE });
      expect(d.reasons.some((r) => r.startsWith('result: insufficient_credit (credit runway excluded')), label).toBe(true);
    };
    // free plan, > 32K context: house dropped (house_context_pro) while opus/sonnet/haiku would serve with credit
    for (const requested of ['beagle/auto', 'beagle/cheap', 'beagle/best']) {
      expect402(route(input({ requested, needs: wide, workspace: broke })), requested);
    }
    // vision: the house has none
    expect402(route(input({ needs: { ...small, vision: true }, workspace: broke })), 'vision');
    // house provider down
    expect402(route(input({ workspace: broke, providers: { ...ok(), house: { state: 'down' } } })), 'house down');
    // negative balance and positive-but-very-low credit classify the same way: credit is the only blocker
    expect402(route(input({ needs: wide, workspace: { ...broke, availableMicroUsd: -5n } })), 'negative');
    expect402(route(input({ needs: wide, workspace: { ...broke, availableMicroUsd: 50_000n } })), 'very low');
    // the classification does not depend on the fallback header
    expect402(route(input({ needs: wide, workspace: broke, fallback: 'none' })), 'none');
    expect(route(input({ needs: wide, workspace: broke, fallback: 'any' }))).toMatchObject({ kind: 'error', code: 'insufficient_credit' });

    // counterfactuals: with credit the request is served; when the house fits, the gate alone answers
    expect(ids(route(input({ needs: wide })))[0]).toBe('anthropic/claude-opus-5-5');
    const pro = route(input({ needs: wide, workspace: { ...broke, plan: 'pro' } }));
    expect(pro).toMatchObject({ kind: 'error', code: 'insufficient_credit' });
    expect(pro.reasons).toContain('result: insufficient_credit');
    // a BYOK key still serves at $0 even though the house cannot
    expect(paid(route(input({ needs: wide, workspace: { ...broke, byok: ['openai'] as Provider[] } })))).toEqual(['openai/gpt-5.5:byok', 'openai/gpt-5.4-mini:byok', 'openai/gpt-5.4-nano:byok']);

    // genuinely unservable requests stay no_capable_model, credit or not
    expect(route(input({ needs: { ...small, contextTokens: 2_000_000 }, workspace: broke }))).toMatchObject({ kind: 'error', code: 'no_capable_model' });
    const allDown = { anthropic: { state: 'down' as const }, openai: { state: 'down' as const }, google: { state: 'down' as const }, house: { state: 'down' as const } };
    expect(route(input({ workspace: broke, providers: allDown }))).toMatchObject({ kind: 'error', code: 'no_capable_model' });
    expect(route(input({ requested: 'beagle/house', needs: wide, workspace: broke }))).toMatchObject({ kind: 'error', code: 'no_capable_model' });
  });

  it('alias with fallback any at very low credit: house first, then the pricier tiers', () => {
    const d = route(input({ fallback: 'any', workspace: { availableMicroUsd: 50_000n, plan: 'free', byok: [] } }));
    expect(d.kind === 'ok' && d.tier).toBe('house');
    expect(ids(d)).toEqual([
      'house/gpt-oss-20b',
      'anthropic/claude-haiku-5-5',
      'openai/gpt-5.4-nano',
      'google/gemini-3.1-flash-lite',
      'anthropic/claude-sonnet-5-5',
      'openai/gpt-5.4-mini',
      'google/gemini-3-flash',
      'anthropic/claude-opus-5-5',
      'openai/gpt-5.5',
      'google/gemini-3.1-pro',
    ]);
    expect(route(input({ fallback: 'any', workspace: { availableMicroUsd: 0n, plan: 'free', byok: [] } }))).toMatchObject({ kind: 'error', code: 'insufficient_credit' });
  });

  it('(m) an explicit primary is never demoted by its provider quota; only its fallbacks are', () => {
    const anthropicLow = { ...ok(), anthropic: { state: 'ok' as const, quotaRatio: 0.1 } };
    // non-eligible primary (§4.6 step 6: "an explicit non-eligible primary stays first")
    const fable = route(input({ requested: 'anthropic/claude-fable-5-1', difficulty: 0.3, providers: anthropicLow }));
    expect(fable.kind === 'ok' && fable.tier).toBe('frontier');
    expect(ids(fable)).toEqual([
      'anthropic/claude-fable-5-1',
      'openai/gpt-5.5',
      'google/gemini-3.1-pro',
      'openai/gpt-5.4-mini',
      'google/gemini-3-flash',
      'openai/gpt-5.4-nano',
      'google/gemini-3.1-flash-lite',
      'house/gpt-oss-20b',
      'anthropic/claude-haiku-5-5',
      'anthropic/claude-sonnet-5-5',
      'anthropic/claude-opus-5-5',
    ]);
    expect(fable.kind === 'ok' && fable.reasons.some((r) => r.startsWith('quota:'))).toBe(true);

    // eligible primary (§0: explicit ids are honoured)
    const openaiLow = { ...ok(), openai: { state: 'ok' as const, quotaRatio: 0.1 } };
    const mini = route(input({ requested: 'openai/gpt-5.4-mini', difficulty: 0.3, providers: openaiLow }));
    expect(ids(mini)).toEqual([
      'openai/gpt-5.4-mini',
      'anthropic/claude-sonnet-5-5',
      'google/gemini-3-flash',
      'anthropic/claude-haiku-5-5',
      'google/gemini-3.1-flash-lite',
      'house/gpt-oss-20b',
      'openai/gpt-5.4-nano',
    ]);
    expect(mini.kind === 'ok' && mini.tier).toBe('efficient');

    // fallback none: a single candidate cannot move, and no quota reason is recorded
    const none = route(input({ requested: 'openai/gpt-5.4-mini', difficulty: 0.3, providers: openaiLow, fallback: 'none' }));
    expect(ids(none)).toEqual(['openai/gpt-5.4-mini']);
    expect(none.kind === 'ok' && none.reasons.some((r) => r.startsWith('quota:'))).toBe(false);
    // hard requests are untouched by the demotion either way
    expect(ids(route(input({ requested: 'openai/gpt-5.4-mini', difficulty: 0.9, providers: openaiLow })))[0]).toBe('openai/gpt-5.4-mini');
    // the alias path still demotes the whole provider (contrast with test (h))
    expect(ids(route(input({ difficulty: 0.3, providers: openaiLow })))).toEqual(['anthropic/claude-haiku-5-5', 'google/gemini-3.1-flash-lite', 'house/gpt-oss-20b', 'openai/gpt-5.4-nano']);
  });

  it('honours a custom preference and price ordering within a tier', () => {
    const d = route(input({ preference: ['google', 'openai', 'anthropic', 'house'] }));
    expect(ids(d).slice(0, 3)).toEqual(['google/gemini-3.1-pro', 'openai/gpt-5.5', 'anthropic/claude-opus-5-5']);
    // providers missing from the preference go last; same provider sorts by price then id
    const twoOpus: ModelSpec[] = mergeCatalog(DEFAULT_CATALOG, [
      { ...DEFAULT_CATALOG[0]!, id: 'anthropic/zz-cheap', upstreamId: 'zz', price: { inputPerM: 1, outputPerM: 1 } },
    ]);
    const e = route(input({ catalog: twoOpus, preference: ['openai'] }));
    expect(ids(e).slice(0, 4)).toEqual(['openai/gpt-5.5', 'anthropic/zz-cheap', 'google/gemini-3.1-pro', 'anthropic/claude-opus-5-5']);
  });

  it('beagle/cheap and beagle/best target their tiers', () => {
    expect(route(input({ requested: 'beagle/cheap', difficulty: 1 })).kind === 'ok' && ids(route(input({ requested: 'beagle/cheap', difficulty: 1 })))[0]).toBe('anthropic/claude-haiku-5-5');
    expect(ids(route(input({ requested: 'beagle/best', difficulty: 0 })))[0]).toBe('anthropic/claude-opus-5-5');
    expect(ids(route(input({ requested: 'beagle/auto', difficulty: 0.5 })))[0]).toBe('anthropic/claude-sonnet-5-5');
  });

  it('does not mutate its input', () => {
    const i = input();
    const snapshot = JSON.stringify(i, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    route(i);
    expect(JSON.stringify(i, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).toBe(snapshot);
  });
});
