import { describe, expect, it } from 'vitest';
import { keccak256, toBytes, toHex } from 'viem';
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_SPEC,
  MODELS,
  MODEL_IDS,
  SERVED_MODEL_PRICING,
  costOfUsageMicroUsd,
  costOfUsageUsd,
  isModelId,
  modelById,
  modelIdToHash,
  modelSpec,
  pricingForServedModel,
  toPublicModelSpec,
} from '../src/models.js';

describe('model catalog', () => {
  it('has the four models with the normative prices', () => {
    const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]));
    expect(MODEL_IDS).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1']);
    expect(byId['claude-opus-5-5']).toMatchObject({ inputUsdPerMTok: 4, outputUsdPerMTok: 20, cacheReadUsdPerMTok: 0.2, cacheWriteUsdPerMTok: 5, supportsFallbacks: true });
    expect(byId['claude-sonnet-5-5']).toMatchObject({ inputUsdPerMTok: 2, outputUsdPerMTok: 10, cacheReadUsdPerMTok: 0.2, cacheWriteUsdPerMTok: 2.5, supportsFallbacks: true });
    expect(byId['claude-haiku-4-5']).toMatchObject({ inputUsdPerMTok: 1, outputUsdPerMTok: 5, cacheReadUsdPerMTok: 0.1, cacheWriteUsdPerMTok: 1.25, supportsFallbacks: false });
    expect(byId['claude-fable-5-1']).toMatchObject({ inputUsdPerMTok: 10, outputUsdPerMTok: 50, cacheReadUsdPerMTok: 0.25, cacheWriteUsdPerMTok: 12.5, supportsFallbacks: true });
  });

  it('request flags follow the SDK rules', () => {
    for (const m of MODELS) {
      if (m.id === 'claude-haiku-4-5') {
        expect(m.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
        expect(m.effort).toBeNull();
        expect(m.supportsFallbacks).toBe(false);
        expect(m.maxTokens).toBe(8192);
      } else {
        expect(m.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(m.effort).toBe('medium');
        expect(m.supportsFallbacks).toBe(true);
      }
    }
  });

  it('default model is opus-5-5', () => {
    expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
    expect(DEFAULT_MODEL_SPEC.id).toBe(DEFAULT_MODEL);
    expect(toPublicModelSpec(DEFAULT_MODEL_SPEC).isDefault).toBe(true);
    expect(toPublicModelSpec(DEFAULT_MODEL_SPEC)).not.toHaveProperty('thinking');
  });

  it('modelIdHash = keccak256(toBytes(id)) (R12) and lookups round-trip', () => {
    for (const m of MODELS) {
      expect(m.modelIdHash).toBe(keccak256(toBytes(m.id)));
      expect(m.modelIdHash).toBe(keccak256(toHex(m.id)));
      expect(modelIdToHash(m.id)).toBe(m.modelIdHash);
      expect(modelById(m.modelIdHash)?.id).toBe(m.id);
      expect(modelById(m.modelIdHash.toUpperCase().replace('0X', '0x'))?.id).toBe(m.id);
      expect(modelSpec(m.id)).toBe(m);
      expect(isModelId(m.id)).toBe(true);
    }
    expect(modelById(`0x${'00'.repeat(32)}`)).toBeUndefined();
    expect(isModelId('gpt-5')).toBe(false);
    // known-answer: keccak256("claude-opus-5-5")
    expect(modelIdToHash('claude-opus-5-5')).toBe(keccak256(new TextEncoder().encode('claude-opus-5-5')));
  });

  it('costOfUsageUsd bills each token class at its own rate', () => {
    const opus = modelSpec('claude-opus-5-5')!;
    const cost = costOfUsageUsd(opus, {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_input_tokens: 2_000_000,
      cache_creation_input_tokens: 500_000,
    });
    // 4 + 2 + 0.4 + 2.5
    expect(cost).toBeCloseTo(8.9, 9);
    expect(costOfUsageUsd(opus, { input_tokens: 0, output_tokens: 0 })).toBe(0);
    expect(costOfUsageUsd(opus, { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: null })).toBeCloseTo(0.004, 12);
  });

  it('costOfUsageMicroUsd is exact integer micro-USD with round-half-up', () => {
    const opus = modelSpec('claude-opus-5-5')!;
    const haiku = modelSpec('claude-haiku-4-5')!;
    expect(costOfUsageMicroUsd(opus, { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 500_000 })).toBe(8_900_000);
    // 1 cache-read token on opus = 0.2 µUSD -> 0; 3 tokens = 0.6 -> 1 (round half up)
    expect(costOfUsageMicroUsd(opus, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1 })).toBe(0);
    expect(costOfUsageMicroUsd(opus, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 3 })).toBe(1);
    // 0.5 µUSD rounds up: 5 cache-read tokens on haiku = 0.5 µUSD
    expect(costOfUsageMicroUsd(haiku, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 5 })).toBe(1);
    expect(costOfUsageMicroUsd(haiku, { input_tokens: 1234, output_tokens: 567, cache_creation_input_tokens: 89 })).toBe(Math.round(1234 * 1 + 567 * 5 + 89 * 1.25));
    expect(() => costOfUsageMicroUsd(opus, { input_tokens: -1, output_tokens: 0 })).toThrow(RangeError);
    expect(() => costOfUsageMicroUsd(opus, { input_tokens: 1.5, output_tokens: 0 })).toThrow(RangeError);
  });

  it('served-model pricing covers the catalog and fallback targets, with snapshot-id prefix match', () => {
    for (const m of MODELS) expect(pricingForServedModel(m.id)).toEqual({ inputUsdPerMTok: m.inputUsdPerMTok, outputUsdPerMTok: m.outputUsdPerMTok, cacheReadUsdPerMTok: m.cacheReadUsdPerMTok, cacheWriteUsdPerMTok: m.cacheWriteUsdPerMTok });
    expect(pricingForServedModel('claude-opus-4-8')?.inputUsdPerMTok).toBe(5);
    expect(pricingForServedModel('claude-opus-5')?.outputUsdPerMTok).toBe(25);
    expect(pricingForServedModel('claude-haiku-4-5-20251001')?.inputUsdPerMTok).toBe(1);
    // 'claude-opus-5-5' must not be priced as 'claude-opus-5'
    expect(pricingForServedModel('claude-opus-5-5-20261001')?.inputUsdPerMTok).toBe(4);
    expect(pricingForServedModel('gpt-5')).toBeUndefined();
    expect(Object.keys(SERVED_MODEL_PRICING)).toEqual(expect.arrayContaining([...MODEL_IDS]));
  });
});
