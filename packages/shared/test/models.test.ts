import { describe, expect, it } from 'vitest';
import {
  ALIASES,
  ALIAS_DESCRIPTIONS,
  BYOK_PROVIDERS,
  DEFAULT_CATALOG,
  ModelSpecSchema,
  PLANS,
  PROVIDERS,
  TIER_ORDER,
  cheaperTier,
  findModel,
  isAlias,
  mergeCatalog,
  modelPriceSum,
  modelsByTier,
  modelsInTier,
  pricierTier,
  resolveModel,
  tierIndex,
  type ModelSpec,
} from '../src/models.js';

const byId = (id: string): ModelSpec => {
  const m = DEFAULT_CATALOG.find((x) => x.id === id);
  if (!m) throw new Error(`missing ${id}`);
  return m;
};

describe('DEFAULT_CATALOG (SPEC §4.4)', () => {
  it('lists the 12 models in spec order', () => {
    expect(DEFAULT_CATALOG.map((m) => m.id)).toEqual([
      'anthropic/claude-opus-5-5',
      'anthropic/claude-sonnet-5-5',
      'anthropic/claude-haiku-5-5',
      'anthropic/claude-fable-5-1',
      'openai/gpt-5.5',
      'openai/gpt-5.4-mini',
      'openai/gpt-5.4-nano',
      'google/gemini-3.1-pro',
      'google/gemini-3-flash',
      'google/gemini-3.1-flash-lite',
      'house/gpt-oss-20b',
      'house/gpt-oss-120b',
    ]);
  });

  it('every entry validates against ModelSpecSchema and has provider = id prefix', () => {
    for (const m of DEFAULT_CATALOG) {
      expect(ModelSpecSchema.safeParse(m).success, m.id).toBe(true);
      expect(m.id.startsWith(`${m.provider}/`)).toBe(true);
      expect(Object.isFrozen(m)).toBe(true);
    }
  });

  it('has the table values', () => {
    const opus = byId('anthropic/claude-opus-5-5');
    expect(opus).toMatchObject({
      tier: 'frontier',
      upstreamId: 'claude-opus-5-5',
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      price: { inputPerM: 4_000_000, outputPerM: 20_000_000, cacheReadPerM: 200_000, cacheWritePerM: 5_000_000 },
      capabilities: { tools: true, vision: true, json: true, reasoning: true },
      autoEligible: true,
    });
    expect(byId('anthropic/claude-sonnet-5-5').price).toEqual({ inputPerM: 2_000_000, outputPerM: 10_000_000, cacheReadPerM: 200_000, cacheWritePerM: 2_500_000 });
    expect(byId('anthropic/claude-haiku-5-5')).toMatchObject({ tier: 'budget', price: { inputPerM: 100_000, outputPerM: 500_000, cacheReadPerM: 10_000, cacheWritePerM: 125_000 } });
    expect(byId('anthropic/claude-fable-5-1')).toMatchObject({ tier: 'frontier', autoEligible: false, price: { inputPerM: 10_000_000, outputPerM: 50_000_000, cacheReadPerM: 250_000 } });
    expect(byId('anthropic/claude-fable-5-1').price.cacheWritePerM).toBeUndefined();
    expect(byId('openai/gpt-5.5')).toMatchObject({ tier: 'frontier', upstreamId: 'gpt-5.5', contextWindow: 400_000, maxOutput: 128_000, price: { inputPerM: 5_000_000, outputPerM: 30_000_000, cacheReadPerM: 500_000 } });
    expect(byId('openai/gpt-5.4-mini')).toMatchObject({ tier: 'efficient', price: { inputPerM: 750_000, outputPerM: 4_500_000, cacheReadPerM: 75_000 } });
    expect(byId('openai/gpt-5.4-nano')).toMatchObject({ tier: 'budget', price: { inputPerM: 200_000, outputPerM: 1_200_000, cacheReadPerM: 20_000 }, capabilities: { tools: true, vision: true, json: true, reasoning: false } });
    expect(byId('google/gemini-3.1-pro')).toMatchObject({ tier: 'frontier', contextWindow: 1_000_000, maxOutput: 65_536, price: { inputPerM: 2_000_000, outputPerM: 12_000_000, cacheReadPerM: 200_000 } });
    expect(byId('google/gemini-3-flash')).toMatchObject({ tier: 'efficient', price: { inputPerM: 500_000, outputPerM: 3_000_000, cacheReadPerM: 50_000 } });
    expect(byId('google/gemini-3.1-flash-lite')).toMatchObject({ tier: 'budget', price: { inputPerM: 250_000, outputPerM: 1_500_000, cacheReadPerM: 25_000 }, capabilities: { reasoning: false } });
    expect(byId('house/gpt-oss-20b')).toMatchObject({ tier: 'house', upstreamId: 'openai/gpt-oss-20b', contextWindow: 131_072, maxOutput: 32_768, price: { inputPerM: 50_000, outputPerM: 200_000 }, capabilities: { tools: true, vision: false, json: true, reasoning: true }, autoEligible: true });
    expect(byId('house/gpt-oss-120b')).toMatchObject({ tier: 'house', upstreamId: 'openai/gpt-oss-120b', price: { inputPerM: 100_000, outputPerM: 500_000 }, requiresPlan: 'pro', autoEligible: true });
    expect(byId('house/gpt-oss-20b').requiresPlan).toBeUndefined();
  });

  it('marks OpenAI and Google prices as third-party snapshots', () => {
    for (const m of DEFAULT_CATALOG) {
      if (m.provider === 'openai' || m.provider === 'google') expect(m.notes, m.id).toBe('price snapshot 2026-10; verify');
      else expect(m.notes, m.id).not.toBe('price snapshot 2026-10; verify');
    }
  });
});

describe('enums and aliases', () => {
  it('exports the vocabularies', () => {
    expect(PROVIDERS).toEqual(['anthropic', 'openai', 'google', 'house']);
    expect(BYOK_PROVIDERS).toEqual(['anthropic', 'openai', 'google']);
    expect(TIER_ORDER).toEqual(['frontier', 'efficient', 'budget', 'house']);
    expect(PLANS).toEqual(['free', 'pro']);
    expect(ALIASES).toEqual(['beagle/auto', 'beagle/best', 'beagle/cheap', 'beagle/house']);
    for (const a of ALIASES) expect(ALIAS_DESCRIPTIONS[a].length).toBeGreaterThan(10);
  });
  it('isAlias', () => {
    expect(isAlias('beagle/auto')).toBe(true);
    expect(isAlias('beagle/house')).toBe(true);
    expect(isAlias('beagle/nope')).toBe(false);
    expect(isAlias('anthropic/claude-opus-5-5')).toBe(false);
  });
  it('tier helpers', () => {
    expect(tierIndex('frontier')).toBe(0);
    expect(tierIndex('house')).toBe(3);
    expect(cheaperTier('frontier')).toBe('efficient');
    expect(cheaperTier('efficient')).toBe('budget');
    expect(cheaperTier('budget')).toBe('house');
    expect(cheaperTier('house')).toBeUndefined();
    expect(pricierTier('house')).toBe('budget');
    expect(pricierTier('frontier')).toBeUndefined();
  });
});

describe('resolveModel / findModel', () => {
  it('resolves catalog ids', () => {
    expect(resolveModel('anthropic/claude-opus-5-5')).toEqual({ kind: 'model', model: byId('anthropic/claude-opus-5-5') });
    expect(findModel('house/gpt-oss-20b')?.id).toBe('house/gpt-oss-20b');
  });
  it('resolves aliases', () => {
    expect(resolveModel('beagle/auto')).toEqual({ kind: 'alias', alias: 'beagle/auto' });
    expect(resolveModel(' beagle/best ')).toEqual({ kind: 'alias', alias: 'beagle/best' });
    expect(findModel('beagle/auto')).toBeUndefined();
  });
  it('resolves unique bare upstream ids', () => {
    expect(resolveModel('claude-sonnet-5-5')).toEqual({ kind: 'model', model: byId('anthropic/claude-sonnet-5-5') });
    expect(resolveModel('gpt-5.5')?.kind).toBe('model');
    expect(findModel('openai/gpt-oss-120b')?.id).toBe('house/gpt-oss-120b');
  });
  it('returns undefined for unknown or ambiguous ids', () => {
    expect(resolveModel('nope')).toBeUndefined();
    expect(resolveModel('')).toBeUndefined();
    const dup = mergeCatalog(DEFAULT_CATALOG, [
      { ...byId('openai/gpt-5.5'), id: 'other/gpt-5.5', provider: 'openai', upstreamId: 'gpt-5.5' },
    ]);
    expect(resolveModel('gpt-5.5', dup)).toBeUndefined();
    expect(resolveModel('openai/gpt-5.5', dup)?.kind).toBe('model');
  });
  it('uses the supplied catalog', () => {
    expect(resolveModel('anthropic/claude-opus-5-5', [])).toBeUndefined();
  });
});

describe('modelsByTier / modelsInTier', () => {
  it('groups the defaults', () => {
    const groups = modelsByTier();
    expect(groups.frontier.map((m) => m.id)).toEqual(['anthropic/claude-opus-5-5', 'anthropic/claude-fable-5-1', 'openai/gpt-5.5', 'google/gemini-3.1-pro']);
    expect(groups.efficient).toHaveLength(3);
    expect(groups.budget).toHaveLength(3);
    expect(groups.house.map((m) => m.id)).toEqual(['house/gpt-oss-20b', 'house/gpt-oss-120b']);
    expect(modelsInTier(DEFAULT_CATALOG, 'house')).toEqual(groups.house);
    expect(modelsByTier([]).budget).toEqual([]);
  });
  it('modelPriceSum', () => {
    expect(modelPriceSum(byId('house/gpt-oss-20b'))).toBe(250_000);
  });
});

describe('mergeCatalog', () => {
  it('overrides fields by id with field-level price/capability merge', () => {
    const merged = mergeCatalog(DEFAULT_CATALOG, [
      { id: 'openai/gpt-5.5', price: { inputPerM: 1 }, capabilities: { vision: false }, notes: 'custom', autoEligible: false },
    ]);
    expect(merged).toHaveLength(12);
    const m = merged.find((x) => x.id === 'openai/gpt-5.5')!;
    expect(m.price).toEqual({ inputPerM: 1, outputPerM: 30_000_000, cacheReadPerM: 500_000 });
    expect(m.capabilities).toEqual({ tools: true, vision: false, json: true, reasoning: true });
    expect(m.notes).toBe('custom');
    expect(m.autoEligible).toBe(false);
    expect(byId('openai/gpt-5.5').price.inputPerM).toBe(5_000_000); // defaults untouched
    expect(merged.map((x) => x.id)).toEqual(DEFAULT_CATALOG.map((x) => x.id)); // order kept
  });
  it('removes and clears', () => {
    const merged = mergeCatalog(DEFAULT_CATALOG, [
      { id: 'anthropic/claude-fable-5-1', remove: true },
      { id: 'house/gpt-oss-120b', requiresPlan: null, notes: null },
      { id: 'house/gpt-oss-20b', requiresPlan: 'pro' },
    ]);
    expect(merged.map((x) => x.id)).not.toContain('anthropic/claude-fable-5-1');
    const large = merged.find((x) => x.id === 'house/gpt-oss-120b')!;
    expect('requiresPlan' in large).toBe(false);
    expect('notes' in large).toBe(false);
    expect(merged.find((x) => x.id === 'house/gpt-oss-20b')?.requiresPlan).toBe('pro');
  });
  it('appends complete new models and rejects incomplete ones', () => {
    const extra = {
      id: 'openai/gpt-6',
      provider: 'openai',
      upstreamId: 'gpt-6',
      displayName: 'GPT-6',
      tier: 'frontier',
      contextWindow: 1,
      maxOutput: 1,
      price: { inputPerM: 1, outputPerM: 2 },
      capabilities: { tools: true, vision: true, json: true, reasoning: true },
      autoEligible: true,
    };
    const merged = mergeCatalog(DEFAULT_CATALOG, [extra]);
    expect(merged).toHaveLength(13);
    expect(merged[12]).toEqual(extra);
    expect(() => mergeCatalog(DEFAULT_CATALOG, [{ id: 'openai/gpt-7', tier: 'frontier' }])).toThrow(/new model openai\/gpt-7 is incomplete/);
    expect(() => mergeCatalog(DEFAULT_CATALOG, [{ id: 'openai/gpt-5.5', tier: 'ultra' }])).toThrow(/invalid overrides/);
    expect(() => mergeCatalog(DEFAULT_CATALOG, [{ id: 'openai/gpt-5.5', price: { inputPerM: -1 } }])).toThrow(/invalid overrides/);
    expect(() => mergeCatalog(DEFAULT_CATALOG, { id: 'x' } as unknown as unknown[])).toThrow(/invalid overrides/);
    expect(() => mergeCatalog(DEFAULT_CATALOG, [{ id: 'bad id' , provider: 'openai', upstreamId: 'x', displayName: 'x', tier: 'house', contextWindow: 1, maxOutput: 1, price: { inputPerM: 1, outputPerM: 1 }, capabilities: { tools: true, vision: true, json: true, reasoning: true }, autoEligible: true }])).toThrow(/provider\/model/);
  });
  it('is a no-op for empty overrides', () => {
    expect(mergeCatalog(DEFAULT_CATALOG, [])).toEqual([...DEFAULT_CATALOG]);
  });
});
