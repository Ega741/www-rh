import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_SPEC,
  MODELS,
  MODEL_IDS,
  MODEL_PRICES,
  costOfUsageMicroUsd,
  isModelId,
  modelById,
  modelIdToHash,
  modelSpec,
  pricesForServedModel,
  toPublicModelSpec,
} from '../src/models.js';

describe('model catalog (SPEC §3.1)', () => {
  it('has the four models with the normative prices and request flags', () => {
    expect(MODEL_IDS).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1']);
    const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]));
    expect(byId['claude-opus-5-5']).toMatchObject({ inputUsdPerMTok: 4, outputUsdPerMTok: 20, cacheReadUsdPerMTok: 0.2, cacheWriteUsdPerMTok: 5, maxTokens: 16000, supportsEffort: true, supportsFallbacks: true });
    expect(byId['claude-sonnet-5-5']).toMatchObject({ inputUsdPerMTok: 2, outputUsdPerMTok: 10, cacheReadUsdPerMTok: 0.2, cacheWriteUsdPerMTok: 2.5, maxTokens: 16000, supportsEffort: true, supportsFallbacks: true });
    expect(byId['claude-haiku-4-5']).toMatchObject({ inputUsdPerMTok: 1, outputUsdPerMTok: 5, cacheReadUsdPerMTok: 0.1, cacheWriteUsdPerMTok: 1.25, maxTokens: 8192, supportsEffort: false, supportsFallbacks: false });
    expect(byId['claude-fable-5-1']).toMatchObject({ inputUsdPerMTok: 10, outputUsdPerMTok: 50, cacheReadUsdPerMTok: 0.25, cacheWriteUsdPerMTok: 12.5, maxTokens: 16000, supportsEffort: true, supportsFallbacks: true });
    for (const m of MODELS) {
      if (m.id === 'claude-haiku-4-5') expect(m.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
      else expect(m.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    }
  });

  it('default model is opus-5-5 and the public projection drops request flags', () => {
    expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
    expect(DEFAULT_MODEL_SPEC.id).toBe(DEFAULT_MODEL);
    const pub = toPublicModelSpec(DEFAULT_MODEL_SPEC);
    expect(pub.isDefault).toBe(true);
    expect(Object.keys(pub).sort()).toEqual(['cacheReadUsdPerMTok', 'cacheWriteUsdPerMTok', 'description', 'id', 'inputUsdPerMTok', 'isDefault', 'label', 'modelIdHash', 'outputUsdPerMTok']);
  });

  it('modelIdHash = keccak256(toBytes(id)) and lookups round-trip', () => {
    for (const m of MODELS) {
      expect(m.modelIdHash).toBe(keccak256(toBytes(m.id)));
      expect(modelIdToHash(m.id)).toBe(m.modelIdHash);
      expect(modelById(m.modelIdHash)?.id).toBe(m.id);
      expect(modelById(m.modelIdHash.toUpperCase().replace('0X', '0x'))?.id).toBe(m.id);
      expect(modelSpec(m.id)).toBe(m);
      expect(isModelId(m.id)).toBe(true);
    }
    expect(modelById(`0x${'00'.repeat(32)}`)).toBeUndefined();
    expect(isModelId('gpt-5')).toBe(false);
    // known answer, independent of toBytes: keccak of the UTF-8 encoding
    expect(modelIdToHash('claude-opus-5-5')).toBe(keccak256(new TextEncoder().encode('claude-opus-5-5')));
  });

  it('MODEL_PRICES = catalog + fallback targets; pricesForServedModel is an exact match with a fable-5-1 default', () => {
    expect(Object.keys(MODEL_PRICES).sort()).toEqual(
      ['claude-fable-5-1', 'claude-haiku-4-5', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5'],
    );
    expect(MODEL_PRICES['claude-opus-5']).toEqual({ inputUsdPerMTok: 5, outputUsdPerMTok: 25, cacheReadUsdPerMTok: 0.5, cacheWriteUsdPerMTok: 6.25 });
    expect(MODEL_PRICES['claude-opus-4-8']).toEqual({ inputUsdPerMTok: 5, outputUsdPerMTok: 25, cacheReadUsdPerMTok: 0.5, cacheWriteUsdPerMTok: 6.25 });
    expect(MODEL_PRICES['claude-sonnet-5']).toEqual({ inputUsdPerMTok: 2, outputUsdPerMTok: 10, cacheReadUsdPerMTok: 0.2, cacheWriteUsdPerMTok: 2.5 });
    expect(pricesForServedModel('claude-opus-4-8')).toEqual({ prices: MODEL_PRICES['claude-opus-4-8'], known: true });
    expect(pricesForServedModel('claude-haiku-4-5-20251001')).toEqual({ prices: MODEL_PRICES['claude-fable-5-1'], known: false });
    expect(pricesForServedModel('toString').known).toBe(false);
  });

  it('costOfUsageMicroUsd: exact nano-USD arithmetic rounded up to whole micro-USD', () => {
    expect(
      costOfUsageMicroUsd('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 500_000 }),
    ).toBe(8_900_000); // 4 + 2 + 0.4 + 2.5 USD
    expect(costOfUsageMicroUsd('claude-opus-5-5', { input_tokens: 0, output_tokens: 0 })).toBe(0);
    // 1 cache-read token on opus = 200 nano-USD → ceil → 1 µUSD
    expect(costOfUsageMicroUsd('claude-opus-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1 })).toBe(1);
    // 5 cache-read tokens on haiku = 500 nano → 1 µUSD; 10 = 1000 nano → exactly 1 µUSD
    expect(costOfUsageMicroUsd('claude-haiku-4-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 5 })).toBe(1);
    expect(costOfUsageMicroUsd('claude-haiku-4-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 10 })).toBe(1);
    expect(costOfUsageMicroUsd('claude-haiku-4-5', { input_tokens: 1234, output_tokens: 567, cache_read_input_tokens: null, cache_creation_input_tokens: 89 })).toBe(
      Math.ceil((1234 * 1000 + 567 * 5000 + 89 * 1250) / 1000),
    );
    // served ≠ requested: billed at the served fallback model
    expect(costOfUsageMicroUsd('claude-opus-4-8', { input_tokens: 1000, output_tokens: 1000 })).toBe(30_000);
    // unknown served model: claude-fable-5-1 prices
    expect(costOfUsageMicroUsd('mystery-model', { input_tokens: 1000, output_tokens: 1000 })).toBe(60_000);
    expect(() => costOfUsageMicroUsd('claude-opus-5-5', { input_tokens: -1, output_tokens: 0 })).toThrow(RangeError);
    expect(() => costOfUsageMicroUsd('claude-opus-5-5', { input_tokens: 1.5, output_tokens: 0 })).toThrow(RangeError);
  });
});
