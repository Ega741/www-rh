import { keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import { canonicalJson, keccakCanonical, utf8ByteLength } from './canonical';
import { METADATA_LIMITS, buildMetadata, dataUriFits, metadataJson, modelHashOf, personaHashOf, validateDraft, type MetadataDraft } from './metadata';
import { verifyReceipt } from './receipts';
import type { ComputeReceipt } from './types';

describe('canonical JSON hashing (SPEC §3.2)', () => {
  it('sorts keys and omits undefined (shared canonicalJson)', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1n, y: undefined, x: 'é' } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"x":"é","z":"1"}}');
  });

  it('hashes canonical JSON with keccak256', () => {
    expect(keccakCanonical({ b: 2, a: 1 })).toBe(keccak256(toBytes('{"a":1,"b":2}')));
    expect(utf8ByteLength('€')).toBe(3);
  });
});

const draft: MetadataDraft = {
  name: ' Night Sky ',
  symbol: 'STARS',
  description: '',
  image: '',
  persona: 'You read new exoplanet papers every day and explain them plainly.\n',
  model: 'claude-opus-5-5',
  links: { x: '', website: 'https://example.org', telegram: '' },
};

function decodeDataUri(uri: string): string {
  const b64 = uri.slice(uri.indexOf(',') + 1);
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

describe('metadata (SPEC §5 / §7 create flow)', () => {
  it('builds metadata without empty optionals and keeps the persona verbatim', () => {
    expect(buildMetadata(draft)).toEqual({
      name: 'Night Sky',
      symbol: 'STARS',
      persona: 'You read new exoplanet papers every day and explain them plainly.\n',
      model: 'claude-opus-5-5',
      links: { website: 'https://example.org' },
    });
  });

  it('embeds the canonical JSON in the data: URI fallback, which fits on-chain', () => {
    const meta = buildMetadata(draft);
    const { uri, fits } = dataUriFits(meta);
    expect(uri.startsWith('data:application/json;base64,')).toBe(true);
    expect(fits).toBe(true);
    expect(decodeDataUri(uri)).toBe(metadataJson(meta));
    expect(metadataJson(meta).startsWith('{"links":{"website":"https://example.org"},"model":"claude-opus-5-5","name":"Night Sky"')).toBe(true);
  });

  it('reports when the data: URI would exceed the 2048-byte metadataURI limit', () => {
    const meta = buildMetadata({ ...draft, persona: 'x'.repeat(2000) });
    const { fits, bytes } = dataUriFits(meta);
    expect(fits).toBe(false);
    expect(bytes > METADATA_LIMITS.metadataUriBytes).toBe(true);
  });

  it('hashes persona and model id as keccak256 of UTF-8 bytes', () => {
    expect(personaHashOf('hello')).toBe(keccak256(toBytes('hello')));
    expect(modelHashOf('claude-opus-5-5')).toBe(keccak256(toBytes('claude-opus-5-5')));
  });

  it('validates SPEC §5 limits and required fields', () => {
    expect(validateDraft(draft)).toEqual({});
    const bad = validateDraft({
      ...draft,
      name: 'n'.repeat(65),
      symbol: 'A B',
      persona: 'short',
      image: 'data:image/png;base64,AAAA',
      model: 'gpt-x',
      links: { x: 'x.com/me', website: '', telegram: '' },
    });
    expect(Object.keys(bad).sort()).toEqual(['image', 'links', 'model', 'name', 'persona', 'symbol']);
    expect(validateDraft({ ...draft, symbol: 'ÉÉÉÉÉÉÉÉÉ' }).symbol).toBeDefined();
    expect(validateDraft({ ...draft, description: 'd'.repeat(2001) }).description).toBeDefined();
    expect(validateDraft({ ...draft, image: `https://x.example/${'a'.repeat(600)}` }).image).toBeDefined();
  });
});

describe('verifyReceipt (W6)', () => {
  const object = {
    token: '0x00000000000000000000000000000000000000aa',
    fromTickId: 1,
    toTickId: 2,
    ticks: [{ tickId: 1, model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdMicro: 140 }],
    ethUsdPriceMicro: 3_000_000_000,
    amountWei: '46666666666',
  };
  const base: ComputeReceipt = {
    receiptHash: keccakCanonical(object),
    status: 'confirmed',
    txHash: null,
    amountWei: 46_666_666_666n,
    fromTickId: 1,
    toTickId: 2,
    tickCount: 1,
    costUsd: 0.00014,
    createdAt: null,
    object,
  };

  it('verifies a matching receipt and flags tampering', () => {
    expect(verifyReceipt(base)).toBe('verified');
    expect(verifyReceipt({ ...base, object: { ...object, amountWei: '1' } })).toBe('mismatch');
    expect(verifyReceipt({ ...base, object: null })).toBe('unverifiable');
  });
});
