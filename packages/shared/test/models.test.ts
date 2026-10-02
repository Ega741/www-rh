import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_SPEC,
  MODELS,
  MODEL_IDS,
  costOfUsageUsd,
  isModelId,
  modelById,
  modelIdToHash,
  modelSpec,
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

  it('thinking config follows the SDK rules', () => {
    for (const m of MODELS) {
      if (m.id === 'claude-haiku-4-5') expect(m.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
      else expect(m.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    }
  });

  it('default model is opus-5-5', () => {
    expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
    expect(DEFAULT_MODEL_SPEC.id).toBe(DEFAULT_MODEL);
    expect(toPublicModelSpec(DEFAULT_MODEL_SPEC).isDefault).toBe(true);
    expect(toPublicModelSpec(DEFAULT_MODEL_SPEC)).not.toHaveProperty('thinking');
  });

  it('modelIdHash = keccak256(utf8(id)) and lookups round-trip', () => {
    for (const m of MODELS) {
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
});
