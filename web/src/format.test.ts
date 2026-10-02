import { describe, expect, it } from 'vitest';
import {
  displayUrl,
  formatBps,
  formatCompact,
  formatDecimal,
  formatDuration,
  formatEth,
  formatPrice,
  formatRunway,
  formatTokens,
  formatUsd,
  impliedEthUsd,
  parseAmount,
  progressPercent,
  runwayHours,
  shortAddress,
  timeAgo,
} from './format';

describe('formatDecimal / formatEth', () => {
  it('formats whole and fractional ETH with truncation', () => {
    expect(formatEth(0n)).toBe('0 ETH');
    expect(formatEth(10n ** 18n)).toBe('1 ETH');
    expect(formatEth(1_234_567_890_000_000_000n)).toBe('1.2345 ETH');
    expect(formatEth(1_999_999_999_999_999_999n)).toBe('1.9999 ETH');
    expect(formatEth(12_345n * 10n ** 18n, { symbol: false })).toBe('12,345');
  });

  it('keeps significant digits for small values and switches to subscript zeros for tiny ones', () => {
    expect(formatEth(1_230_000_000_000_000n)).toBe('0.00123 ETH');
    expect(formatDecimal('0.000000001272498')).toBe('0.0₈1272');
    expect(formatDecimal('0.0001')).toBe('0.0001');
    expect(formatDecimal('0.00001')).toBe('0.0₄1');
  });

  it('formats the initial curve price (wei per 1e18 tokens) as ETH per token', () => {
    // x0 * 1e18 / y0 = 1.365e18 * 1e18 / 1.073e27
    const price = (1_365_000_000_000_000_000n * 10n ** 18n) / (1_073_000_000n * 10n ** 18n);
    expect(formatPrice(price)).toBe('0.0₈1272 ETH');
  });
});

describe('numbers, tokens, usd, bps', () => {
  it('compacts numbers', () => {
    expect(formatCompact(950)).toBe('950');
    expect(formatCompact(12_345)).toBe('12.3K');
    expect(formatCompact(800_000_000)).toBe('800M');
    expect(formatCompact(1_250_000_000)).toBe('1.25B');
  });

  it('formats token amounts', () => {
    expect(formatTokens(800_000_000n * 10n ** 18n)).toBe('800M');
    expect(formatTokens(34_123_456n * 10n ** 18n)).toBe('34.1M');
    expect(formatTokens(5n * 10n ** 17n)).toBe('0.5');
  });

  it('formats usd', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(12.345)).toBe('$12.35');
    expect(formatUsd(0.01234)).toBe('$0.0123');
    expect(formatUsd(0.00001)).toBe('<$0.0001');
    expect(formatUsd(2_500_000)).toBe('$2.5M');
  });

  it('formats basis points', () => {
    expect(formatBps(4250)).toBe('42.5%');
    expect(formatBps(100n)).toBe('1%');
  });

  it('computes curve progress from tokensSold', () => {
    expect(progressPercent(0n)).toBe(0);
    expect(progressPercent(400_000_000n * 10n ** 18n)).toBe(50);
    expect(progressPercent(800_000_000n * 10n ** 18n)).toBe(100);
    expect(progressPercent(900_000_000n * 10n ** 18n)).toBe(100);
  });
});

describe('runway and time', () => {
  it('computes runway hours', () => {
    expect(runwayHours(10, 0)).toBeNull();
    expect(runwayHours(10, 2)).toBe(5);
    expect(runwayHours(-1, 2)).toBe(0);
  });

  it('formats runway', () => {
    expect(formatRunway(null)).toBe('∞');
    expect(formatRunway(0)).toBe('empty');
    expect(formatRunway(0.75)).toBe('45m');
    expect(formatRunway(13 + 1 / 3)).toBe('13h 20m');
    expect(formatRunway(24 * 4 + 3)).toBe('4d 3h');
    expect(formatRunway(24 * 400)).toBe('>1y');
  });

  it('formats durations and relative times', () => {
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(48 * 3_600_000)).toBe('2d');
    expect(timeAgo(1_000, 3_000)).toBe('just now');
    expect(timeAgo(0, 90_000)).toBe('1m ago');
    expect(timeAgo(0, 3 * 86_400_000)).toBe('3d ago');
  });
});

describe('parsing and misc', () => {
  it('parses user amounts', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('-1')).toBeNull();
    expect(parseAmount('0.1')).toBe(10n ** 17n);
    expect(parseAmount('.5')).toBe(5n * 10n ** 17n);
    expect(parseAmount('1,5')).toBe(15n * 10n ** 17n);
    expect(parseAmount('1.0000000000000000001')).toBeNull();
    expect(parseAmount('12', 6)).toBe(12_000_000n);
  });

  it('derives ETH/USD from a balance pair', () => {
    expect(impliedEthUsd(2n * 10n ** 18n, 6000)).toBe(3000);
    expect(impliedEthUsd(0n, 10)).toBeNull();
  });

  it('shortens addresses and urls', () => {
    expect(shortAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
    expect(displayUrl('https://arxiv.org/abs/2401.00001?x=1')).toBe('arxiv.org/abs/2401.00001?x=1');
    expect(displayUrl('not a url')).toBe('not a url');
  });
});
