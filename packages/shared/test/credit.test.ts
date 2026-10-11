import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BPS_DENOMINATOR,
  MAX_TOKEN_DECIMALS,
  MICRO_USD,
  PRICE_SCALE,
  applyMarkupBps,
  ceilDiv,
  componentCostMicroUsd,
  costMicroUsd,
  formatPriceE18,
  formatTokenAmount,
  formatUsdMicro,
  parseTokenAmount,
  parseUsdToMicro,
  quoteUsdMicro,
  tokensForUsdMicro,
  tokensPerUsd,
} from '../src/credit.js';
import { DEFAULT_CATALOG } from '../src/models.js';

const E18 = 10n ** 18n;
const PRICE_0025 = 2_500_000_000_000_000n; // $0.0025 per token

describe('constants', () => {
  it('match SPEC §1', () => {
    expect(MICRO_USD).toBe(1_000_000n);
    expect(PRICE_SCALE).toBe(E18);
    expect(MAX_TOKEN_DECIMALS).toBe(36);
    expect(BPS_DENOMINATOR).toBe(10_000n);
  });
});

describe('ceilDiv', () => {
  it('rounds up', () => {
    expect(ceilDiv(0n, 3n)).toBe(0n);
    expect(ceilDiv(1n, 3n)).toBe(1n);
    expect(ceilDiv(3n, 3n)).toBe(1n);
    expect(ceilDiv(4n, 3n)).toBe(2n);
    expect(ceilDiv(10n ** 30n + 1n, 10n ** 30n)).toBe(2n);
  });
  it('rejects bad input', () => {
    expect(() => ceilDiv(-1n, 3n)).toThrow(RangeError);
    expect(() => ceilDiv(1n, 0n)).toThrow(RangeError);
    expect(() => ceilDiv(1 as unknown as bigint, 1n)).toThrow(TypeError);
  });
});

describe('quoteUsdMicro', () => {
  it('reproduces the SPEC example: 1000 BEAGLE at $0.0025 = $2.50', () => {
    expect(quoteUsdMicro(1000n * E18, PRICE_0025)).toBe(2_500_000n);
    expect(quoteUsdMicro(1000n * E18, PRICE_0025, 18)).toBe(2_500_000n);
  });
  it('handles other decimals', () => {
    expect(quoteUsdMicro(1_000_000n, E18, 6)).toBe(1_000_000n); // 1 token at $1 (6 decimals)
    expect(quoteUsdMicro(10n ** 8n, 2n * E18, 8)).toBe(2_000_000n); // 1 token at $2 (8 decimals)
    expect(quoteUsdMicro(1n, E18, 0)).toBe(1_000_000n); // 0-decimal token
    expect(quoteUsdMicro(10n ** 36n, 1n, 36)).toBe(0n); // 1 token at 1e-18 USD → 1e-12 USD → 0 µUSD
  });
  it('floors', () => {
    // 1 wei at $0.0025: 2.5e-21 USD → 0
    expect(quoteUsdMicro(1n, PRICE_0025)).toBe(0n);
    // 3 tokens at $1/3-ish: 333333333333333333 * 3 = 999999999999999999 → floor(0.999999999999 USD * 1e6) = 999_999
    expect(quoteUsdMicro(3n * E18, 333_333_333_333_333_333n)).toBe(999_999n);
    expect(quoteUsdMicro(0n, PRICE_0025)).toBe(0n);
    expect(quoteUsdMicro(1000n * E18, 0n)).toBe(0n);
  });
  it('validates input', () => {
    expect(() => quoteUsdMicro(-1n, PRICE_0025)).toThrow(RangeError);
    expect(() => quoteUsdMicro(1n, -1n)).toThrow(RangeError);
    expect(() => quoteUsdMicro(1n, 1n, 37)).toThrow(RangeError);
    expect(() => quoteUsdMicro(1n, 1n, 1.5)).toThrow(RangeError);
    expect(() => quoteUsdMicro(1n, 1n, -1)).toThrow(RangeError);
  });
});

describe('tokensForUsdMicro', () => {
  it('inverts the SPEC example', () => {
    expect(tokensForUsdMicro(2_500_000n, PRICE_0025)).toBe(1000n * E18);
  });
  it('ceils', () => {
    // 1 µUSD at $3 per token: 1e-6/3 tokens = 333333333333.33… wei → 333333333334
    expect(tokensForUsdMicro(1n, 3n * E18)).toBe(333_333_333_334n);
    expect(tokensForUsdMicro(0n, 3n * E18)).toBe(0n);
    expect(tokensForUsdMicro(1_000_000n, E18, 6)).toBe(1_000_000n);
  });
  it('round-trips within one unit', () => {
    const cases: Array<[bigint, bigint, number]> = [
      [1n, PRICE_0025, 18],
      [2_500_000n, PRICE_0025, 18],
      [123_456_789n, 7n * 10n ** 15n, 18],
      [999n, 10n ** 9n, 6],
      [10n ** 12n, 10n ** 24n, 8],
    ];
    for (const [usd, price, decimals] of cases) {
      const tokens = tokensForUsdMicro(usd, price, decimals);
      expect(quoteUsdMicro(tokens, price, decimals)).toBeGreaterThanOrEqual(usd);
      if (tokens > 0n) expect(quoteUsdMicro(tokens - 1n, price, decimals)).toBeLessThan(usd);
    }
  });
  it('rejects a zero price and bad input', () => {
    expect(() => tokensForUsdMicro(1n, 0n)).toThrow(/priceE18 must be > 0/);
    expect(() => tokensForUsdMicro(-1n, 1n)).toThrow(RangeError);
    expect(() => tokensForUsdMicro(1n, 1n, 40)).toThrow(RangeError);
  });
  it('tokensPerUsd', () => {
    expect(tokensPerUsd(10n ** 16n)).toBe(100n * E18); // $0.01 → 100 tokens per USD
    expect(tokensPerUsd(E18, 6)).toBe(1_000_000n);
  });
});

describe('costMicroUsd', () => {
  const opus = DEFAULT_CATALOG.find((m) => m.id === 'anthropic/claude-opus-5-5')!;
  it('sums per-component ceilDiv(tokens · pricePerMillion, 1e6)', () => {
    expect(componentCostMicroUsd(1234, 4_000_000)).toBe(4936n);
    expect(componentCostMicroUsd(1, 4_000_000)).toBe(4n);
    expect(componentCostMicroUsd(1, 1)).toBe(1n); // ceil(1e-6)
    expect(componentCostMicroUsd(0, 4_000_000)).toBe(0n);
    expect(componentCostMicroUsd(5, 0)).toBe(0n);
    expect(costMicroUsd({ inputTokens: 1234, outputTokens: 100 }, opus.price)).toBe(4936n + 2_000_000n);
    expect(
      costMicroUsd({ inputTokens: 1000, outputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 1000 }, opus.price),
    ).toBe(4_000_000n + 200_000n + 5_000_000n);
  });
  it('falls back to the input price for cache tokens without a cache price', () => {
    const price = { inputPerM: 50_000, outputPerM: 200_000 };
    expect(costMicroUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 2_000_000 }, price)).toBe(150_000n);
  });
  it('rejects bad token counts', () => {
    expect(() => costMicroUsd({ inputTokens: -1, outputTokens: 0 }, opus.price)).toThrow(RangeError);
    expect(() => costMicroUsd({ inputTokens: 1.5, outputTokens: 0 }, opus.price)).toThrow(RangeError);
    expect(() => componentCostMicroUsd(1, -1)).toThrow(RangeError);
  });
});

describe('applyMarkupBps', () => {
  it('adds ceilDiv(cost · bps, 10_000)', () => {
    expect(applyMarkupBps(4936n, 1000)).toBe(4936n + 494n);
    expect(applyMarkupBps(10_000n, 1000)).toBe(11_000n);
    expect(applyMarkupBps(1n, 1)).toBe(2n);
    expect(applyMarkupBps(4936n, 1000n)).toBe(5430n);
  });
  it('is the identity for zero cost or zero bps', () => {
    expect(applyMarkupBps(0n, 1000)).toBe(0n);
    expect(applyMarkupBps(4936n, 0)).toBe(4936n);
  });
  it('rejects negatives', () => {
    expect(() => applyMarkupBps(-1n, 10)).toThrow(RangeError);
    expect(() => applyMarkupBps(1n, -10)).toThrow(RangeError);
  });
});

describe('formatUsdMicro', () => {
  it('formats dollars with 2..4 decimals by default', () => {
    expect(formatUsdMicro(2_500_000n)).toBe('$2.50');
    expect(formatUsdMicro(2_500_100n)).toBe('$2.5001');
    expect(formatUsdMicro(0n)).toBe('$0.00');
    expect(formatUsdMicro(-150_000n)).toBe('-$0.15');
    expect(formatUsdMicro(1_234_567_800n)).toBe('$1234.5678');
    expect(formatUsdMicro(1_000_000n)).toBe('$1.00');
  });
  it('rounds half up at maxFractionDigits', () => {
    expect(formatUsdMicro(2_500_150n)).toBe('$2.5002');
    expect(formatUsdMicro(2_500_149n)).toBe('$2.5001');
    expect(formatUsdMicro(999_999n, { maxFractionDigits: 2 })).toBe('$1.00');
    expect(formatUsdMicro(2_500_150n, { maxFractionDigits: 6 })).toBe('$2.50015');
    expect(formatUsdMicro(2_500_150n, { maxFractionDigits: 9 })).toBe('$2.50015');
  });
  it('honours minFractionDigits', () => {
    expect(formatUsdMicro(3_000_000n, { minFractionDigits: 0 })).toBe('$3');
    expect(formatUsdMicro(2_500_000n, { minFractionDigits: 0 })).toBe('$2.5');
    expect(formatUsdMicro(2_500_000n, { minFractionDigits: 3 })).toBe('$2.500');
    expect(formatUsdMicro(2_500_000n, { maxFractionDigits: 0, minFractionDigits: 0 })).toBe('$3');
  });
  it('rejects bad options', () => {
    expect(() => formatUsdMicro(1n, { maxFractionDigits: -1 })).toThrow(RangeError);
    expect(() => formatUsdMicro(1n, { minFractionDigits: 1.5 })).toThrow(RangeError);
  });
});

describe('parseUsdToMicro', () => {
  it('parses decimal dollars', () => {
    expect(parseUsdToMicro('2.5')).toBe(2_500_000n);
    expect(parseUsdToMicro('$10')).toBe(10_000_000n);
    expect(parseUsdToMicro(' $ 10.25 ')).toBe(10_250_000n);
    expect(parseUsdToMicro('-0.25')).toBe(-250_000n);
    expect(parseUsdToMicro('.5')).toBe(500_000n);
    expect(parseUsdToMicro('1.')).toBe(1_000_000n);
    expect(parseUsdToMicro('0')).toBe(0n);
    expect(parseUsdToMicro('0.000001')).toBe(1n);
    expect(parseUsdToMicro('123456789.123456')).toBe(123_456_789_123_456n);
  });
  it('rejects more than 6 fraction digits and garbage', () => {
    expect(() => parseUsdToMicro('0.0000001')).toThrow(RangeError);
    expect(() => parseUsdToMicro('abc')).toThrow(SyntaxError);
    expect(() => parseUsdToMicro('')).toThrow(SyntaxError);
    expect(() => parseUsdToMicro('.')).toThrow(SyntaxError);
    expect(() => parseUsdToMicro('1,000')).toThrow(SyntaxError);
    expect(() => parseUsdToMicro('1e6')).toThrow(SyntaxError);
  });
  it('round-trips with formatUsdMicro', () => {
    for (const x of [0n, 1n, 2_500_000n, 123_456_789_123_456n, -99n]) {
      expect(parseUsdToMicro(formatUsdMicro(x, { maxFractionDigits: 6 }))).toBe(x);
    }
  });
});

describe('formatTokenAmount / parseTokenAmount', () => {
  it('formats raw units, truncating to maxFractionDigits', () => {
    expect(formatTokenAmount(1000n * E18, 18)).toBe('1000');
    expect(formatTokenAmount(15n * 10n ** 17n, 18)).toBe('1.5');
    expect(formatTokenAmount(1n, 18)).toBe('0');
    expect(formatTokenAmount(123_456_789n, 6)).toBe('123.4567');
    expect(formatTokenAmount(123_456_789n, 6, 6)).toBe('123.456789');
    expect(formatTokenAmount(123_456_789n, 6, 0)).toBe('123');
    expect(formatTokenAmount(-15n * 10n ** 17n, 18)).toBe('-1.5');
    expect(formatTokenAmount(42n, 0)).toBe('42');
    expect(formatTokenAmount(0n, 18)).toBe('0');
    expect(formatTokenAmount(999_999_999_999_999_999n, 18)).toBe('0.9999');
  });
  it('parses decimal strings into raw units', () => {
    expect(parseTokenAmount('1000.5', 18)).toBe(10_005n * 10n ** 17n);
    expect(parseTokenAmount('1000', 18)).toBe(1000n * E18);
    expect(parseTokenAmount('0.000001', 6)).toBe(1n);
    expect(parseTokenAmount('.5', 2)).toBe(50n);
    expect(parseTokenAmount('-1', 6)).toBe(-1_000_000n);
    expect(parseTokenAmount('7', 0)).toBe(7n);
  });
  it('rejects too many fraction digits and garbage', () => {
    expect(() => parseTokenAmount('1.0000000000000000001', 18)).toThrow(RangeError);
    expect(() => parseTokenAmount('1.5', 0)).toThrow(RangeError);
    expect(() => parseTokenAmount('', 18)).toThrow(SyntaxError);
    expect(() => parseTokenAmount('$1', 18)).toThrow(SyntaxError);
    expect(() => parseTokenAmount('1', 37)).toThrow(RangeError);
  });
  it('round-trips', () => {
    for (const s of ['0', '1', '1000.5', '0.123456789012345678']) {
      expect(formatTokenAmount(parseTokenAmount(s, 18), 18, 18)).toBe(s);
    }
  });
});

describe('formatPriceE18', () => {
  it('formats USD per token', () => {
    expect(formatPriceE18(PRICE_0025)).toBe('$0.0025');
    expect(formatPriceE18(10n ** 16n)).toBe('$0.01');
    expect(formatPriceE18(E18)).toBe('$1.00');
    expect(formatPriceE18(1_234_567_890_123_456_789n)).toBe('$1.234568');
    expect(formatPriceE18(1_234_567_890_123_456_789n, { maxFractionDigits: 2 })).toBe('$1.23');
    expect(formatPriceE18(0n)).toBe('$0.00');
  });
  it('rejects negatives', () => {
    expect(() => formatPriceE18(-1n)).toThrow(RangeError);
  });
});

describe('fixture parity with CreditMath (fixtures/quote.json)', () => {
  const url = new URL('../fixtures/quote.json', import.meta.url);

  it('matches every case produced by contracts/script/GenerateFixtures.s.sol', () => {
    if (!existsSync(url)) {
      throw new Error(
        'packages/shared/fixtures/quote.json is missing: run `cd contracts && forge script script/GenerateFixtures.s.sol` to generate it',
      );
    }
    const raw: unknown = JSON.parse(readFileSync(url, 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    const cases = raw as Array<{ amount: string; priceE18: string; decimals: number; usdMicro: string; tokensBack: string }>;
    expect(cases.length).toBeGreaterThanOrEqual(24);
    for (const c of cases) {
      const amount = BigInt(c.amount);
      const price = BigInt(c.priceE18);
      const label = `amount=${c.amount} price=${c.priceE18} decimals=${c.decimals}`;
      const usd = quoteUsdMicro(amount, price, c.decimals);
      expect(usd, label).toBe(BigInt(c.usdMicro));
      if (price > 0n) expect(tokensForUsdMicro(usd, price, c.decimals), `${label} tokensBack`).toBe(BigInt(c.tokensBack));
    }
  });
});
