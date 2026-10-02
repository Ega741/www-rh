import { describe, expect, it } from 'vitest';
import { parseMemoryBatchUri } from '../api';
import { normalizeCompute, normalizeMindDetail, normalizeMindsPage, normalizeStats, toStatusName } from './normalize';

const TOKEN = '0x00000000000000000000000000000000000000AA';
const HASH = `0x${'cd'.repeat(32)}`;

const summary = {
  token: TOKEN,
  name: 'Night Sky',
  symbol: 'STARS',
  creator: '0x00000000000000000000000000000000000000bb',
  metadataURI: 'runner://metadata/abc',
  image: null,
  modelId: HASH,
  model: 'claude-opus-5-5',
  status: 'paused',
  phase: 'bonding',
  priceWei: '1272000000',
  marketCapWei: '1272000000000000000',
  progressBps: 125,
  realEthReserveWei: '100000000000000000',
  tokensSold: '10000000000000000000000000',
  mindBalanceWei: '700000000000000',
  createdAt: '2026-10-02T10:00:00Z',
  trades24h: 3,
  volume24hWei: '5',
};

describe('normalizers', () => {
  it('normalises R11 summaries (Wei suffixes, nullable image, paused status)', () => {
    const page = normalizeMindsPage({ items: [summary, { bogus: true }], nextCursor: 'c2' });
    expect(page.nextCursor).toBe('c2');
    expect(page.items).toHaveLength(1);
    const m = page.items[0];
    expect(m).toMatchObject({ token: TOKEN.toLowerCase(), status: 'paused', image: null, realEthReserveWei: 10n ** 17n, lastTickAt: null });
  });

  it('accepts the pre-R11 field names', () => {
    const { realEthReserveWei: _drop, ...rest } = summary;
    const m = normalizeMindDetail({ ...rest, realEthReserve: '42', personaHash: HASH, metadata: { persona: 'p', description: 'd', links: { x: 'https://x.com/a' } } });
    expect(m.realEthReserveWei).toBe(42n);
    expect(m.persona).toBe('p');
    expect(m.description).toBe('d');
    expect(m.links).toEqual({ x: 'https://x.com/a' });
    expect(m.pool).toBeNull();
  });

  it('maps on-chain enum numbers and unknown statuses', () => {
    expect(toStatusName(0)).toBe('alive');
    expect(toStatusName(2)).toBe('paused');
    expect(toStatusName('retired')).toBe('dormant');
  });

  it('normalises compute receipts and extracts the canonical object', () => {
    const c = normalizeCompute({
      balanceWei: '1000',
      balanceUsd: 0.5,
      burnUsdPerHour: 0.1,
      runwayHours: 5,
      ledger: [{ tickId: 1, model: 'claude-opus-5-5', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 }],
      receipts: [
        { receiptHash: HASH, txHash: HASH, token: TOKEN, fromTickId: 1, toTickId: 1, ticks: [{ tickId: 1, costUsdMicro: 10000 }], ethUsdPriceMicro: 3000000000, amountWei: '3' },
        { receiptHash: HASH, amountWei: '4' },
      ],
    });
    expect(c.balanceWei).toBe(1000n);
    expect(c.ledger[0]?.settled).toBe(false);
    expect(c.receipts[0]?.object).toEqual({ token: TOKEN, fromTickId: 1, toTickId: 1, ticks: [{ tickId: 1, costUsdMicro: 10000 }], ethUsdPriceMicro: 3000000000, amountWei: '3' });
    expect(c.receipts[0]?.costUsd).toBeCloseTo(0.01);
    expect(c.receipts[1]?.object).toBeNull();
  });

  it('normalises stats with either naming', () => {
    expect(normalizeStats({ minds: 2, alive: 1, graduated: 0, volumeEthTotal: '9', feesToMindsEth: '3' })).toEqual({ minds: 2, alive: 1, graduated: 0, volumeWei: 9n, feesToMindsWei: 3n });
  });

  it('parses runner:// memory batch URIs', () => {
    expect(parseMemoryBatchUri(`runner://memories/${TOKEN}/5-9`)).toEqual({ token: TOKEN.toLowerCase(), fromSeq: 5, toSeq: 9 });
    expect(parseMemoryBatchUri('ipfs://x')).toBeNull();
  });
});
