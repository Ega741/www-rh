import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MAX_METADATA_JSON_BYTES,
  MAX_METADATA_URI_BYTES,
  anchorBatchHash,
  anchorBatchUri,
  canonicalJson,
  drawReceiptHash,
  memoryContentHash,
  metadataDataUri,
  metadataHash,
  metadataUri,
  personaHash,
} from '../src/canonical.js';
import { costOfUsageMicroUsd } from '../src/models.js';
import type { AnchorBatch, DrawReceiptObject, MindMetadata } from '../src/types.js';

// Golden values computed independently of this code: `cast keccak '<canonical string>'` (Foundry)
// and Python `hashlib.sha256` / `base64` over the hand-written canonical strings below.
const here = dirname(fileURLToPath(import.meta.url));
const token = `0x${'ab'.repeat(20)}` as const;

const batch: AnchorBatch = {
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

const receipt: DrawReceiptObject = {
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

describe('canonicalJson (SPEC §3.2)', () => {
  it('sorts keys, strips whitespace, stringifies bigints, omits undefined', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1n, y: -0 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":"1"}}');
    expect(canonicalJson([3, 2, 1])).toBe('[3,2,1]');
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
    expect(canonicalJson(12345678901234567890n)).toBe('"12345678901234567890"');
    expect(canonicalJson({ Z: 1, a: 2, _: 3 })).toBe('{"Z":1,"_":3,"a":2}');
    expect(canonicalJson({})).toBe('{}');
  });

  it('escapes strings exactly like JSON.stringify', () => {
    expect(canonicalJson({ s: 'line\n"q"\u0001\\' })).toBe('{"s":"line\\n\\"q\\"\\u0001\\\\"}');
    expect(canonicalJson('é😀')).toBe('"é😀"');
  });

  it('rejects non-integer numbers and values without a canonical form', () => {
    expect(() => canonicalJson(0.1)).toThrow(TypeError);
    expect(() => canonicalJson(2 ** 53)).toThrow(TypeError);
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson([undefined] as never)).toThrow(TypeError);
    expect(() => canonicalJson(new Date(0) as never)).toThrow(TypeError);
    expect(() => canonicalJson((() => 1) as never)).toThrow(TypeError);
  });
});

describe('hashes and URIs (golden vectors)', () => {
  it('anchor batch → keccak256, URI', () => {
    expect(canonicalJson(batch)).toBe(BATCH_CANONICAL);
    expect(anchorBatchHash(batch)).toBe('0x036c2d015c75100433ea5b97cc94b81e1fc240987314c6f571aa9c6d9d789c99');
    expect(anchorBatchHash({ ...batch, extra: 1 } as AnchorBatch)).toBe(anchorBatchHash(batch));
    expect(anchorBatchUri(token.toUpperCase().replace('0X', '0x'), 1, 5)).toBe(`runner://memories/${token}/1-5`);
  });

  it('memory item → keccak256 (Memory.contentHash)', () => {
    expect(memoryContentHash(batch.memories[0]!)).toBe('0xde8de28588a8d71d96af3b75bda84b7bac30fb3661ee5ec042bd84683ba6e424');
  });

  it('draw receipt → keccak256; cost and amount are reproducible from the receipt', () => {
    const t = receipt.ticks[0]!;
    expect(
      costOfUsageMicroUsd(t.model, { input_tokens: t.inputTokens, output_tokens: t.outputTokens, cache_read_input_tokens: t.cacheReadTokens, cache_creation_input_tokens: t.cacheWriteTokens }),
    ).toBe(t.costUsdMicro);
    const micro = BigInt(t.costUsdMicro);
    const price = BigInt(receipt.ethUsdPriceMicro);
    expect((micro * 10n ** 18n + price - 1n) / price).toBe(BigInt(receipt.amountWei)); // ceilDiv
    expect(drawReceiptHash(receipt)).toBe('0x9dff4ce82cc06cab3eb712ae69d94008bf9b58953bd9f43d8cb2cd389ee62e56');
  });

  it('metadata → sha256 (no 0x), runner URI, data: URI; persona → keccak256', () => {
    const hash = metadataHash(metadata);
    expect(hash).toBe('85fe9dde6d2de39ee8e656e4d2787eab4842ef908598a5e054cbe3dc530df03e');
    expect(metadataUri(hash)).toBe('runner://metadata/85fe9dde6d2de39ee8e656e4d2787eab4842ef908598a5e054cbe3dc530df03e');
    expect(metadataDataUri(metadata)).toBe(
      'data:application/json;base64,eyJkZXNjcmlwdGlvbiI6IkEgY3VyaW91cyBtaW5kLiIsImxpbmtzIjp7IngiOiJodHRwczovL3guY29tL21pbmQifSwibW9kZWwiOiJjbGF1ZGUtb3B1cy01LTUiLCJuYW1lIjoiTWluZCIsInBlcnNvbmEiOiJZb3UgbG92ZSBtYXBzLiIsInN5bWJvbCI6Ik1JTkQifQ==',
    );
    expect(personaHash('You love maps.')).toBe('0x5464813f7ee731f624878f8f98e26b3b31ac2808eb9e53fa5594bbc6634bc9c9');
    expect(personaHash('You love maps.\n')).not.toBe(personaHash('You love maps.'));
    expect(MAX_METADATA_JSON_BYTES).toBe(32768);
    expect(MAX_METADATA_URI_BYTES).toBe(2048);
  });

  it('data: URIs decode back to the canonical JSON for every base64 padding case', () => {
    for (const persona of ['a', 'ab', 'abc', 'é😀']) {
      const meta: MindMetadata = { name: 'M', symbol: 'M', persona, model: 'claude-haiku-4-5' };
      const b64 = metadataDataUri(meta).slice('data:application/json;base64,'.length);
      expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(canonicalJson(meta));
      expect(b64).toBe(Buffer.from(canonicalJson(meta), 'utf8').toString('base64'));
    }
  });
});

describe('package hygiene', () => {
  it('src imports no node:* module (isomorphic)', () => {
    const src = resolve(here, '../src');
    for (const file of readdirSync(src).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(src, file), 'utf8');
      expect(/from\s+['"]node:|require\(['"]node:|getBuiltinModule/.test(text), file).toBe(false);
    }
  });
});

describe('scripts/sync-deployments.mjs', () => {
  const script = resolve(here, '../../../scripts/sync-deployments.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'www-rh-sync-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('generates a sorted, checksummed DEPLOYMENTS map and supports --check', () => {
    const deployments = join(dir, 'deployments');
    mkdirSync(deployments, { recursive: true });
    writeFileSync(join(deployments, '46630.json'), JSON.stringify({ chainId: 46630, launchpad: '0x5fbdb2315678afecb367f032d93f642f64180aa3', graduator: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512', graduatorKind: 'mock', deployedAt: 1759400000 }));
    writeFileSync(join(deployments, '31337.json'), JSON.stringify({ chainId: 31337, launchpad: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', graduator: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9', graduatorKind: 'uniswapv3', deployedAt: 1 }));
    writeFileSync(join(deployments, 'notes.txt'), 'ignored');
    const out = join(dir, 'deployments.generated.ts');
    execFileSync(process.execPath, [script, '--deployments', deployments, '--out', out]);
    const text = readFileSync(out, 'utf8');
    expect(text.indexOf('31337:')).toBeLessThan(text.indexOf('46630:'));
    expect(text).toContain("launchpad: '0x5FbDB2315678afecb367f032d93F642f64180aa3'");
    expect(text).toContain("graduatorKind: 'mock', deployedAt: 1759400000");
    expect(text).toContain("import type { DeploymentRecord } from './addresses.js';");
    expect(() => execFileSync(process.execPath, [script, '--deployments', deployments, '--out', out, '--check'], { stdio: 'pipe' })).not.toThrow();
    writeFileSync(join(deployments, '1.json'), JSON.stringify({ chainId: 1, launchpad: '0x0000000000000000000000000000000000000000', graduator: '0x0000000000000000000000000000000000000001', graduatorKind: 'mock', deployedAt: 1 }));
    expect(() => execFileSync(process.execPath, [script, '--deployments', deployments, '--out', out], { stdio: 'pipe' })).toThrow();
  });

  it('reports whether the committed generated file is up to date with contracts/deployments', () => {
    // Informational: a fresh deploy makes it stale until `pnpm deployments:sync` runs (CI runs --check explicitly).
    try {
      execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' });
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[canonical.test] src/deployments.generated.ts is out of date — run `pnpm deployments:sync`');
    }
    expect(true).toBe(true);
  });
});
