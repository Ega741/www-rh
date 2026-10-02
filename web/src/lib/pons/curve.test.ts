import { describe, expect, it } from 'vitest';
import { ponsInitialReserves, ponsPrice, ponsProgressBps, ponsQuoteBuy, ponsQuoteSell, ponsReservedTokens, tryPonsQuoteBuy, tryPonsQuoteSell } from './curve';

// Hand-computed from PonsV2BondingCurve.buy/.sell and PonsV2BondingCurveMath (integer division
// truncates; getAmountIn adds 1; the clamped gross-up is mulDiv(..., Ceil)). The quote functions
// come from @www-rh/shared; these vectors pin the behaviour the launch form and trade panel rely on.
const R = { quoteReserve: 10_000_000n, tokenReserve: 1_000_000_000n };
const FEES = { feeBps: 100n, taxBps: 200n };

describe('Pons quote helpers (web)', () => {
  it('buy: fee and tax come off the input before the swap', () => {
    // 970000·1e9 / (1e7 + 970000) = 88422971.74…
    const q = ponsQuoteBuy({ quoteIn: 1_000_000n, ...R, sellable: 500_000_000n, ...FEES });
    expect(q).toMatchObject({ tokensOut: 88_422_971n, spent: 1_000_000n, fee: 10_000n, tax: 20_000n, refund: 0n });
  });

  it('buy beyond the sellable allocation is clamped, grossed up and refunded', () => {
    // net = getAmountIn(1e8) = 1e8·1e7·1e4/(9e8·1e4) + 1 = 1111112; spent = ceil(1111112·1e4/9700) = 1145477
    const q = ponsQuoteBuy({ quoteIn: 10_000_000n, ...R, sellable: 100_000_000n, ...FEES });
    expect(q).toMatchObject({ tokensOut: 100_000_000n, spent: 1_145_477n, fee: 11_454n, tax: 22_909n, refund: 8_854_523n });
  });

  it('sell: the swap happens first, both legs come off the output', () => {
    // gross = 5e7·1e7/(1e9 + 5e7) = 476190; fee 4761, tax 9523
    expect(ponsQuoteSell({ tokensIn: 50_000_000n, ...R, ...FEES })).toMatchObject({ quoteOut: 461_906n, fee: 4_761n, tax: 9_523n });
  });

  it('non-throwing wrappers return null where the curve reverts', () => {
    expect(tryPonsQuoteBuy({ quoteIn: 1_000n, ...R, sellable: 0n, ...FEES })).toBeNull();
    expect(tryPonsQuoteBuy({ quoteIn: 0n, ...R, sellable: 1n, ...FEES })).toBeNull();
    expect(tryPonsQuoteBuy({ quoteIn: 1n, quoteReserve: 10n ** 30n, tokenReserve: 1n, sellable: 1n, ...FEES })).toBeNull();
    expect(tryPonsQuoteSell({ tokensIn: 0n, ...R, ...FEES })).toBeNull();
    expect(tryPonsQuoteBuy({ quoteIn: 1_000_000n, ...R, sellable: 500_000_000n, ...FEES })?.tokensOut).toBe(88_422_971n);
  });

  it('price, progress and the fresh curve of a launch config', () => {
    expect(ponsPrice(R.quoteReserve, R.tokenReserve)).toBe(10n ** 16n);
    expect(ponsProgressBps(3n * 10n ** 17n, 10n ** 18n)).toBe(3_000n);
    expect(ponsProgressBps(2n * 10n ** 18n, 10n ** 18n)).toBe(10_000n);
    const supply = 10n ** 27n;
    // reserved = supply·phantom/(phantom + threshold) = 1e27·1/5
    expect(ponsReservedTokens(supply, 10n ** 18n, 4n * 10n ** 18n)).toBe(2n * 10n ** 26n);
    expect(ponsReservedTokens(supply, 0n, 0n)).toBe(0n);
    expect(ponsInitialReserves({ supply, phantomQuote: 10n ** 18n, graduationThreshold: 4n * 10n ** 18n })).toEqual({
      quoteReserve: 10n ** 18n,
      tokenReserve: supply,
      sellable: 8n * 10n ** 26n,
    });
  });

  it('buying the whole sellable allocation of a fresh curve brings the real reserve to the graduation threshold', () => {
    const config = { supply: 10n ** 27n, phantomQuote: 15n * 10n ** 17n, graduationThreshold: 4n * 10n ** 18n };
    const fresh = ponsInitialReserves(config);
    const q = ponsQuoteBuy({ quoteIn: 100n * 10n ** 18n, ...fresh, feeBps: 0n, taxBps: 0n });
    expect(q.tokensOut).toBe(fresh.sellable);
    // phantom·supply = (phantom + real)·reserved → real ≈ threshold (within the rounding of getAmountIn)
    expect(q.spent - config.graduationThreshold < 10n).toBe(true);
    expect(q.spent >= config.graduationThreshold).toBe(true);
  });
});
