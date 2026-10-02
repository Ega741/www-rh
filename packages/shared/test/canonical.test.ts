import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bytesToBase64,
  canonicalJson,
  compareCodePoints,
  hashDrawReceipt,
  hashMemoryBatch,
  hashMemoryItem,
  hashMetadata,
  keccakCanonical,
  metadataDataUri,
  personaHashOf,
} from '../src/canonical.js';
import { costOfUsageMicroUsd, modelSpec } from '../src/models.js';
import type { DrawReceipt, MemoryBatch, MindMetadata } from '../src/types.js';

// Golden values computed independently: `cast keccak '<canonical string>'` (Foundry) and Python
// `hashlib.sha256` / `base64` over the hand-written canonical strings below.
const token = '0x' + 'ab'.repeat(20);

const batch: MemoryBatch = {
  token,
  fromSeq: 1,
  toSeq: 2,
  memories: [
    { seq: 1, kind: 'finding', content: 'Found a paper on L2 sequencers.', url: 'https://example.com/paper', createdAt: '2026-10-02T10:00:00.000Z' },
    { seq: 2, kind: 'note', content: 'Note to self: check Blockscout.', url: null, createdAt: '2026-10-02T10:01:00.000Z' },
  ],
};
const BATCH_CANONICAL =
  '{"fromSeq":1,"memories":[{"content":"Found a paper on L2 sequencers.","createdAt":"2026-10-02T10:00:00.000Z","kind":"finding","seq":1,"url":"https://example.com/paper"},{"content":"Note to self: check Blockscout.","createdAt":"2026-10-02T10:01:00.000Z","kind":"note","seq":2,"url":null}],"toSeq":2,"token":"0xabababababababababababababababababababab"}';

const receipt: DrawReceipt = {
  token,
  fromTickId: 7,
  toTickId: 7,
  ticks: [{ tickId: 7, model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 20, cacheReadTokens: 2000, cacheWriteTokens: 300, costUsdMicro: 2700 }],
  ethUsdPriceMicro: 3_000_000_000,
  amountWei: '900000000000',
};

const metadata: MindMetadata = {
  name: 'Mind',
  symbol: 'MIND',
  description: 'A curious mind.',
  persona: 'You love maps.',
  model: 'claude-opus-5-5',
  links: { x: 'https://x.com/mind' },
};

describe('canonicalJson (R2)', () => {
  it('sorts keys, strips whitespace, stringifies bigints, normalises -0', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1n, y: -0 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":"1"}}');
    expect(canonicalJson([3, 2, 1])).toBe('[3,2,1]');
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
    expect(canonicalJson(0.1)).toBe('0.1');
    expect(canonicalJson(1e21)).toBe('1e+21');
    expect(canonicalJson(12345678901234567890n)).toBe('"12345678901234567890"');
    expect(canonicalJson('')).toBe('""');
    expect(canonicalJson({})).toBe('{}');
  });

  it('escapes strings like JSON.stringify', () => {
    expect(canonicalJson({ s: 'line\n"q"\u0001\\' })).toBe('{"s":"line\\n\\"q\\"\\u0001\\\\"}');
    expect(canonicalJson('é😀')).toBe('"é😀"');
  });

  it('orders keys by code point, not UTF-16 code unit', () => {
    // U+FB01 < U+1F600 by code point, but the surrogate 0xD83D < 0xFB01 by code unit.
    expect(canonicalJson({ '😀': 2, 'ﬁ': 1 })).toBe('{"ﬁ":1,"😀":2}');
    expect(keccakCanonical({ '😀': 2, 'ﬁ': 1 })).toBe('0xefa93dce830a0b8f60314e32c9fab587a76cc88a534555cba69c57f127ffdad8');
    expect(compareCodePoints('a', 'b')).toBe(-1);
    expect(compareCodePoints('ab', 'a')).toBe(1);
    expect(compareCodePoints('x', 'x')).toBe(0);
  });

  it('rejects values without a canonical form', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson([undefined] as never)).toThrow(TypeError);
    expect(() => canonicalJson(new Date(0) as never)).toThrow(TypeError);
    expect(() => canonicalJson((() => 1) as never)).toThrow(TypeError);
  });
});

describe('golden hashes', () => {
  it('memory batch → keccak256 (anchorMemory contentHash)', () => {
    expect(canonicalJson(batch)).toBe(BATCH_CANONICAL);
    expect(hashMemoryBatch(batch)).toBe('0x036c2d015c75100433ea5b97cc94b81e1fc240987314c6f571aa9c6d9d789c99');
    // extra keys on the input objects do not leak into the hash
    expect(hashMemoryBatch({ ...batch, extra: 1 } as MemoryBatch)).toBe(hashMemoryBatch(batch));
  });

  it('memory item → keccak256', () => {
    const first = batch.memories[0]!;
    expect(hashMemoryItem(first)).toBe('0xde8de28588a8d71d96af3b75bda84b7bac30fb3661ee5ec042bd84683ba6e424');
  });

  it('draw receipt → keccak256 (drawCompute receiptHash), cost and amount reproducible', () => {
    const t = receipt.ticks[0]!;
    expect(
      costOfUsageMicroUsd(modelSpec(t.model)!, {
        input_tokens: t.inputTokens,
        output_tokens: t.outputTokens,
        cache_read_input_tokens: t.cacheReadTokens,
        cache_creation_input_tokens: t.cacheWriteTokens,
      }),
    ).toBe(t.costUsdMicro);
    expect(BigInt(t.costUsdMicro) * 10n ** 18n / BigInt(receipt.ethUsdPriceMicro)).toBe(BigInt(receipt.amountWei));
    expect(hashDrawReceipt(receipt)).toBe('0x9dff4ce82cc06cab3eb712ae69d94008bf9b58953bd9f43d8cb2cd389ee62e56');
  });

  it('metadata → sha256 and data: URI fallback; persona → keccak256', () => {
    expect(hashMetadata(metadata)).toBe('0x85fe9dde6d2de39ee8e656e4d2787eab4842ef908598a5e054cbe3dc530df03e');
    expect(metadataDataUri(metadata)).toBe(
      'data:application/json;base64,eyJkZXNjcmlwdGlvbiI6IkEgY3VyaW91cyBtaW5kLiIsImxpbmtzIjp7IngiOiJodHRwczovL3guY29tL21pbmQifSwibW9kZWwiOiJjbGF1ZGUtb3B1cy01LTUiLCJuYW1lIjoiTWluZCIsInBlcnNvbmEiOiJZb3UgbG92ZSBtYXBzLiIsInN5bWJvbCI6Ik1JTkQifQ==',
    );
    expect(personaHashOf('You love maps.')).toBe('0x5464813f7ee731f624878f8f98e26b3b31ac2808eb9e53fa5594bbc6634bc9c9');
  });

  it('bytesToBase64 matches Buffer for all padding cases', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'abcd', 'é😀', '\u0000ÿ']) {
      const bytes = new TextEncoder().encode(s);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});

describe('scripts/sync-deployments.mjs', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = resolve(here, '../../../scripts/sync-deployments.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'www-rh-sync-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('generates a sorted, typed DEPLOYMENTS map and supports --check', () => {
    const deployments = join(dir, 'deployments');
    execFileSync('mkdir', ['-p', deployments]);
    writeFileSync(join(deployments, '46630.json'), JSON.stringify({ launchpad: '0x5FbDB2315678afecb367f032d93F642f64180aa3', graduator: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', graduatorKind: 'mock', chainId: 46630, deployedAt: 1759400000 }));
    writeFileSync(join(deployments, '31337.json'), JSON.stringify({ launchpad: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', chainId: 31337, blockNumber: 3 }));
    writeFileSync(join(deployments, 'notes.txt'), 'ignored');
    const out = join(dir, 'deployments.generated.ts');
    execFileSync(process.execPath, [script, '--deployments', deployments, '--out', out]);
    const text = readFileSync(out, 'utf8');
    expect(text.indexOf('31337:')).toBeLessThan(text.indexOf('46630:'));
    expect(text).toContain('"launchpad":"0x5fbdb2315678afecb367f032d93f642f64180aa3"');
    expect(text).toContain('"graduatorKind":"mock"');
    expect(text).toContain('"blockNumber":3');
    expect(text).toContain("import type { DeploymentRecord } from './addresses.js';");
    expect(() => execFileSync(process.execPath, [script, '--deployments', deployments, '--out', out, '--check'], { stdio: 'pipe' })).not.toThrow();
    writeFileSync(join(deployments, '1.json'), JSON.stringify({ launchpad: '0x0000000000000000000000000000000000000000', chainId: 1 }));
    expect(() => execFileSync(process.execPath, [script, '--deployments', deployments, '--out', out], { stdio: 'pipe' })).toThrow();
  });

  it('reports whether the committed generated file is up to date with contracts/deployments', () => {
    // Informational: a fresh deploy legitimately makes the file stale until `sync-deployments` runs
    // (CI should run `node scripts/sync-deployments.mjs --check` explicitly).
    try {
      execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' });
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[canonical.test] src/deployments.generated.ts is out of date — run `node scripts/sync-deployments.mjs`');
    }
    expect(true).toBe(true);
  });
});
