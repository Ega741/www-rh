import { describe, expect, it } from 'vitest';
import {
  ponsBoundedSnipeTaxBps,
  ponsCreatorShare,
  ponsGetAmountIn,
  ponsGetAmountOut,
  ponsPrice,
  ponsProgressBps,
  ponsQuoteBuy,
  ponsQuoteSell,
  ponsReservesAfterBuy,
  ponsReservesAfterSell,
  ponsSnipeTaxBpsAt,
} from '../src/ponsCurve.js';

const E = 10n ** 18n;
// mainnet launch config 0 (SPEC §9.1 / verified on chain): supply 1e9 tokens, 1 % fee, phantom 1.68 ETH, threshold 4.2 ETH
const SUPPLY = 10n ** 27n;
const PHANTOM = 1_680_000_000_000_000_000n;
const THRESHOLD = 4_200_000_000_000_000_000n;
// reserved = mulDiv(supply, phantom, phantom + threshold) (curve.initialize), sellable = supply − reserved
const RESERVED = (SUPPLY * PHANTOM) / (PHANTOM + THRESHOLD);
const SELLABLE = SUPPLY - RESERVED;
const fresh = { quoteReserve: PHANTOM, tokenReserve: SUPPLY, sellable: SELLABLE, feeBps: 100n, taxBps: 0n };

describe('Pons curve primitives (PonsV2BondingCurveMath, fee 0)', () => {
  it('getAmountOut / getAmountIn floor exactly like the library and revert like it', () => {
    // 97·10000·1000 / (1000·10000 + 97·10000) = 970000000 / 10970000 = 88.42 → 88
    expect(ponsGetAmountOut(97n, 1000n, 1000n)).toBe(88n);
    // 50·1000·10000 / (950·10000) + 1 = 52 + 1
    expect(ponsGetAmountIn(50n, 1000n, 1000n)).toBe(53n);
    expect(() => ponsGetAmountOut(0n, 1n, 1n)).toThrow(RangeError);
    expect(() => ponsGetAmountOut(1n, 0n, 1n)).toThrow(/InsufficientLiquidity/);
    expect(() => ponsGetAmountOut(1n, 10n ** 30n, 1n)).toThrow(/InsufficientOutputAmount/);
    expect(() => ponsGetAmountIn(1000n, 1000n, 1000n)).toThrow(/InsufficientLiquidity/);
    expect(RESERVED).toBe(285_714_285_714_285_714_285_714_285n);
    expect(SELLABLE).toBe(714_285_714_285_714_285_714_285_715n);
  });
});

describe('ponsQuoteBuy (PonsV2BondingCurve.buy)', () => {
  it('small hand-computed buy: fee and tax off the input, no cap', () => {
    // fee = 100·100/1e4 = 1, tax = 100·200/1e4 = 2, net 97 → 88 tokens
    expect(ponsQuoteBuy({ quoteIn: 100n, quoteReserve: 1000n, tokenReserve: 1000n, sellable: 500n, feeBps: 100n, taxBps: 200n })).toEqual({
      tokensOut: 88n, spent: 100n, fee: 1n, tax: 2n, refund: 0n, snipeTax: 0n, capped: false,
    });
  });

  it('small hand-computed capped buy: filled up to sellable, input grossed up (ceil), the rest refunded', () => {
    // 88 > sellable 50 → net = getAmountIn(50) = 53; spent = ceil(53·1e4 / 9700) = ceil(54.64) = 55
    // fee = 55·100/1e4 = 0, tax = 55·200/1e4 = 1, refund = 100 − 55
    expect(ponsQuoteBuy({ quoteIn: 100n, quoteReserve: 1000n, tokenReserve: 1000n, sellable: 50n, feeBps: 100n, taxBps: 200n })).toEqual({
      tokensOut: 50n, spent: 55n, fee: 0n, tax: 1n, refund: 45n, snipeTax: 0n, capped: true,
    });
  });

  it('first 1 ETH buy on the mainnet config', () => {
    // net 0.99 ETH; tokensOut = 0.99e18·1e27 / (1.68e18 + 0.99e18) = 0.99e27 / 2.67 (floor)
    const q = ponsQuoteBuy({ ...fresh, quoteIn: E });
    expect(q).toEqual({ tokensOut: 370_786_516_853_932_584_269_662_921n, spent: E, fee: E / 100n, tax: 0n, refund: 0n, snipeTax: 0n, capped: false });
    const after = ponsReservesAfterBuy({ quoteReserve: PHANTOM, tokenReserve: SUPPLY }, q);
    expect(after).toEqual({ quoteReserve: 2_670_000_000_000_000_000n, tokenReserve: 629_213_483_146_067_415_730_337_079n });
    expect(ponsPrice(after.quoteReserve, after.tokenReserve)).toBe(4_243_392_857n); // wei per 1e18 tokens
    expect(ponsProgressBps(after.quoteReserve - PHANTOM, THRESHOLD)).toBe(2357n); // 0.99 / 4.2
  });

  it('creator tax is layered on top of the base fee', () => {
    const q = ponsQuoteBuy({ ...fresh, quoteIn: E, taxBps: 500n });
    expect([q.fee, q.tax, q.tokensOut]).toEqual([E / 100n, E / 20n, 358_778_625_954_198_473_282_442_748n]);
  });

  it('the completing buy (10 ETH into a fresh curve) is capped at the sellable allocation and refunds the rest', () => {
    const q = ponsQuoteBuy({ ...fresh, quoteIn: 10n * E });
    expect(q).toEqual({
      tokensOut: SELLABLE,
      spent: 4_242_424_242_424_242_426n,
      fee: 42_424_242_424_242_424n,
      tax: 0n,
      refund: 5_757_575_757_575_757_574n,
      snipeTax: 0n,
      capped: true,
    });
    const after = ponsReservesAfterBuy({ quoteReserve: PHANTOM, tokenReserve: SUPPLY }, q);
    expect(after.tokenReserve).toBe(RESERVED); // readyToGraduate: sellable == 0
    expect(after.quoteReserve - PHANTOM).toBe(THRESHOLD + 2n); // the real reserve reaches the threshold (rounding favours the curve)
    expect(ponsProgressBps(after.quoteReserve - PHANTOM, THRESHOLD)).toBe(10_000n);
    expect(q.spent + q.refund).toBe(10n * E);
  });

  it('snipe tax: capped so the buyer keeps 1 %, charged off the input', () => {
    expect(ponsBoundedSnipeTaxBps(100n, 0n, 9_900n)).toBe(9_800n);
    expect(ponsBoundedSnipeTaxBps(100n, 0n, 50n)).toBe(50n);
    const q = ponsQuoteBuy({ ...fresh, quoteIn: E, snipeTaxBps: 9_900n });
    expect([q.fee, q.snipeTax, q.tokensOut]).toEqual([E / 100n, 980_000_000_000_000_000n, 5_917_159_763_313_609_467_455_621n]);
    // decay: 14 halvings across the window, 0 from the window end
    expect([0n, 1n, 2n, 14n, 15n].map((t) => ponsSnipeTaxBpsAt(9_900n, 15n, t))).toEqual([9_900n, 9_900n, 4_950n, 1n, 0n]);
    expect([1n, 2n, 3n].map((t) => ponsSnipeTaxBpsAt(9_900n, 3n, t))).toEqual([618n, 19n, 0n]);
  });

  it('reverts like the contract', () => {
    expect(() => ponsQuoteBuy({ ...fresh, quoteIn: 0n })).toThrow(/ZeroAmount/);
    expect(() => ponsQuoteBuy({ ...fresh, quoteIn: E, sellable: 0n })).toThrow(/CurveGraduated/);
    expect(() => ponsQuoteBuy({ ...fresh, quoteIn: E, feeBps: 1_500n, taxBps: 600n })).toThrow(/InvalidFeePolicy/);
  });
});

describe('ponsQuoteSell (PonsV2BondingCurve.sell)', () => {
  it('small hand-computed sell: swap first, fees off the output', () => {
    // gross = 100·1e4·1000 / (1000·1e4 + 100·1e4) = 90.9 → 90; fee = 0, tax = 90·200/1e4 = 1
    expect(ponsQuoteSell({ tokensIn: 100n, quoteReserve: 1000n, tokenReserve: 1000n, feeBps: 100n, taxBps: 200n })).toEqual({ quoteOut: 89n, grossQuoteOut: 90n, fee: 0n, tax: 1n });
  });

  it('selling half of the first buy back on the mainnet config', () => {
    const r = { quoteReserve: 2_670_000_000_000_000_000n, tokenReserve: 629_213_483_146_067_415_730_337_079n };
    const tokensIn = 370_786_516_853_932_584_269_662_921n / 2n;
    const q = ponsQuoteSell({ tokensIn, ...r, feeBps: 100n, taxBps: 0n });
    expect(q).toEqual({ quoteOut: 601_578_620_689_655_172n, grossQuoteOut: 607_655_172_413_793_103n, fee: 6_076_551_724_137_931n, tax: 0n });
    expect(ponsReservesAfterSell(r, tokensIn, q)).toEqual({ quoteReserve: r.quoteReserve - q.grossQuoteOut, tokenReserve: r.tokenReserve + tokensIn });
    expect(() => ponsQuoteSell({ tokensIn: 0n, ...r, feeBps: 100n, taxBps: 0n })).toThrow(/ZeroAmount/);
  });
});

describe('price, progress, creator share', () => {
  it('price = quote·1e18/token; progress = real·1e4/threshold capped at 10000', () => {
    expect(ponsPrice(PHANTOM, SUPPLY)).toBe(1_680_000_000n);
    expect(ponsPrice(1n, 0n)).toBe(0n);
    expect(ponsProgressBps(THRESHOLD / 2n, THRESHOLD)).toBe(5_000n);
    expect(ponsProgressBps(THRESHOLD + E, THRESHOLD)).toBe(10_000n);
    expect(ponsProgressBps(1n, 0n)).toBe(0n);
  });

  it('creator share of a sweep (buyback disabled): fee minus the 30 % protocol share, plus the full tax', () => {
    expect(ponsCreatorShare(1_000n, 50n)).toBe(750n);
    expect(ponsCreatorShare(999n, 0n, 3_000n)).toBe(999n - 299n);
  });
});
