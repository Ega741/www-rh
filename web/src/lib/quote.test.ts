import { CURVE_SUPPLY, INITIAL_RESERVES, quoteBuy } from '@www-rh/shared';
import { describe, expect, it } from 'vitest';
import { deadlineFromNow, estimateBuy, estimateSell, minOutWithSlippage, planInitialBuy, priceImpactBps, slippagePercentToBps } from './quote';

const ETH = 10n ** 18n;

describe('planInitialBuy (W2)', () => {
  it('without an initial buy sends only the creation fee and expects no tokens', () => {
    const plan = planInitialBuy({ initialBuyWei: 0n, creationFee: 123n });
    expect(plan).toMatchObject({ value: 123n, tokensOut: 0n, minTokensOut: 0n, completes: false });
  });

  it('quotes on a fresh curve with the shared curve math and applies slippage', () => {
    const plan = planInitialBuy({ initialBuyWei: ETH / 10n, creationFee: 0n, tradeFeeBps: 100n, slippageBps: 100n });
    const q = quoteBuy(INITIAL_RESERVES, ETH / 10n, 100n);
    expect(plan.tokensOut).toBe(q.tokensOut);
    expect(plan.fee).toBe(ETH / 1000n);
    expect(plan.value).toBe(ETH / 10n);
    expect(plan.minTokensOut).toBe((q.tokensOut * 9_900n) / 10_000n);
    expect(plan.tokensOut > 0n && plan.tokensOut < CURVE_SUPPLY).toBe(true);
  });

  it('value = creationFee + initialBuy', () => {
    const plan = planInitialBuy({ initialBuyWei: ETH, creationFee: ETH / 100n });
    expect(plan.value).toBe(ETH + ETH / 100n);
  });

  it('flags an initial buy that completes the curve and computes the refund', () => {
    const plan = planInitialBuy({ initialBuyWei: 10n * ETH, creationFee: 0n });
    expect(plan.completes).toBe(true);
    expect(plan.tokensOut).toBe(CURVE_SUPPLY);
    expect(plan.refund > 5n * ETH).toBe(true);
    expect(plan.curveShareBps).toBe(10_000n);
  });
});

describe('slippage, deadline, estimates', () => {
  it('parses slippage percentages into bps', () => {
    expect(slippagePercentToBps('1')).toBe(100n);
    expect(slippagePercentToBps('0.5')).toBe(50n);
    expect(slippagePercentToBps('.25')).toBe(25n);
    expect(slippagePercentToBps('2,5')).toBe(250n);
    expect(slippagePercentToBps('20')).toBe(2_000n);
    expect(slippagePercentToBps('20.01')).toBeNull();
    expect(slippagePercentToBps('0.1')).toBe(10n);
    expect(slippagePercentToBps('0.05')).toBeNull();
    expect(slippagePercentToBps('-1')).toBeNull();
    expect(slippagePercentToBps('0.001')).toBeNull();
    expect(slippagePercentToBps('')).toBeNull();
  });

  it('applies slippage to min-out', () => {
    expect(minOutWithSlippage(10_000n, 100n)).toBe(9_900n);
    expect(minOutWithSlippage(10_000n, 0n)).toBe(10_000n);
  });

  it('computes unix deadlines', () => {
    expect(deadlineFromNow(10, 1_700_000_000_000)).toBe(1_700_000_600n);
  });

  it('estimates buys and sells and round-trips without profit', () => {
    const buy = estimateBuy(INITIAL_RESERVES, ETH, 100n);
    expect(buy).not.toBeNull();
    const after = quoteBuy(INITIAL_RESERVES, ETH, 100n).next;
    const sell = estimateSell(after, buy?.tokensOut ?? 0n, 100n);
    expect(sell).not.toBeNull();
    expect((sell?.ethOut ?? 0n) < ETH).toBe(true);
    expect(estimateSell(INITIAL_RESERVES, ETH, 100n)).toBeNull();
    expect(estimateBuy(INITIAL_RESERVES, 0n, 100n)).toBeNull();
  });

  it('computes price impact', () => {
    expect(priceImpactBps(1_000n, 1_000n, 10n ** 18n)).toBe(0n);
    expect(priceImpactBps(1_000n, 1_100n, 10n ** 18n)).toBe(1_000n);
    expect(priceImpactBps(0n, 1n, 1n)).toBeNull();
  });
});
