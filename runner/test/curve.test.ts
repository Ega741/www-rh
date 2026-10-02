import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CURVE_SUPPLY, priceOf, quoteBuy, quoteSell } from '@www-rh/shared';
import { curveMetrics } from '../src/indexer/apply.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, '../../packages/shared/fixtures/curve.json');

interface FixtureCase {
  op: string;
  realEthReserve: string;
  tokensSold: string;
  amountIn: string;
  tokensOut?: string;
  ethOut?: string;
  ethUsed?: string;
  fee?: string;
  tradeFeeBps?: string;
}

const fixture: { tradeFeeBps: string; cases: FixtureCase[] } | undefined = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : undefined;

describe.skipIf(fixture === undefined)('curve mirror vs the Foundry fixture (packages/shared/fixtures/curve.json)', () => {
  it('every case reproduces exactly and the indexer price matches priceOf on the post-trade state', () => {
    const f = fixture as NonNullable<typeof fixture>;
    expect(f.cases.length).toBeGreaterThanOrEqual(40);
    for (const [i, c] of f.cases.entries()) {
      const state = { realEthReserve: BigInt(c.realEthReserve), tokensSold: BigInt(c.tokensSold) };
      const fee = BigInt(c.tradeFeeBps ?? f.tradeFeeBps);
      if (c.op === 'sell') {
        const q = quoteSell(state, BigInt(c.amountIn), fee);
        expect(q.ethOut.toString(), `case ${i}`).toBe(c.ethOut);
        expect(q.fee.toString(), `case ${i}`).toBe(c.fee);
        expect(curveMetrics(q.next.realEthReserve, q.next.tokensSold).priceWei).toBe(priceOf(q.next).toString());
      } else {
        const q = quoteBuy(state, BigInt(c.amountIn), fee);
        expect(q.tokensOut.toString(), `case ${i}`).toBe(c.tokensOut);
        expect(q.ethUsed.toString(), `case ${i}`).toBe(c.ethUsed);
        expect(q.fee.toString(), `case ${i}`).toBe(c.fee);
        if (c.op === 'complete') expect(q.next.tokensSold).toBe(CURVE_SUPPLY);
        expect(curveMetrics(q.next.realEthReserve, q.next.tokensSold).priceWei).toBe(priceOf(q.next).toString());
      }
    }
  });
});

describe('curveMetrics', () => {
  it('prices the initial curve and never throws on out-of-range input', () => {
    expect(curveMetrics(0n, 0n).priceWei).toBe(priceOf({ realEthReserve: 0n, tokensSold: 0n }).toString());
    expect(curveMetrics(0n, CURVE_SUPPLY + 1n)).toEqual({ priceWei: '0', mcapSort: 0 });
  });
});
