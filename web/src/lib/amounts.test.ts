import { describe, expect, it } from 'vitest';
import { convertAmount, fmtCompact, fmtContext, fmtCount, fmtPerMillion, fmtPrice, fmtTokens, fmtUsd, groupThousands, parseAmount } from './amounts.js';

const PRICE = 2_500_000_000_000_000n; // $0.0025 per token

describe('parseAmount', () => {
  it('parses USD to µUSD', () => {
    expect(parseAmount('2.5', 'usd', 18)).toEqual({ ok: true, value: 2_500_000n });
    expect(parseAmount('$10', 'usd', 18)).toEqual({ ok: true, value: 10_000_000n });
  });
  it('parses token amounts to raw units', () => {
    expect(parseAmount('1000', 'token', 18)).toEqual({ ok: true, value: 1000n * 10n ** 18n });
    expect(parseAmount('1.5', 'token', 6)).toEqual({ ok: true, value: 1_500_000n });
  });
  it('rejects empty, zero, negative and malformed input', () => {
    expect(parseAmount('', 'usd', 18).ok).toBe(false);
    expect(parseAmount('0', 'usd', 18)).toEqual({ ok: false, error: 'Amount must be greater than zero' });
    expect(parseAmount('-1', 'token', 18)).toEqual({ ok: false, error: 'Amount must be positive' });
    expect(parseAmount('abc', 'usd', 18)).toEqual({ ok: false, error: 'Not a valid number' });
    expect(parseAmount('1.1234567', 'usd', 18)).toEqual({ ok: false, error: 'At most 6 decimal places' });
    expect(parseAmount('1.1234567', 'token', 6)).toEqual({ ok: false, error: 'At most 6 decimal places' });
  });
});

describe('convertAmount', () => {
  it('USD mode: ceil tokens then re-quote', () => {
    const c = convertAmount('usd', 2_500_000n, PRICE, 18);
    expect(c).toEqual({ tokens: 1000n * 10n ** 18n, usdMicro: 2_500_000n });
  });
  it('token mode: floor quote', () => {
    const c = convertAmount('token', 1000n * 10n ** 18n, PRICE, 18);
    expect(c?.usdMicro).toBe(2_500_000n);
  });
  it('returns undefined without a price', () => {
    expect(convertAmount('usd', 1n, 0n, 18)).toBeUndefined();
  });
});

describe('formatting', () => {
  it('formats money, tokens, price', () => {
    expect(fmtUsd(2_500_000n)).toBe('$2.50');
    expect(fmtUsd(-150_000n)).toBe('-$0.15');
    expect(fmtTokens(1_234_500n * 10n ** 15n, 18, 'BEAGLE')).toBe('1,234.5 BEAGLE');
    expect(fmtTokens(15n * 10n ** 17n, 18)).toBe('1.5');
    expect(fmtPrice(PRICE)).toBe('$0.0025');
    expect(fmtPerMillion(2_000_000)).toBe('$2.00');
    expect(fmtPerMillion(250_000)).toBe('$0.25');
  });
  it('groups thousands and compacts counts', () => {
    expect(groupThousands('1234567.891')).toBe('1,234,567.891');
    expect(groupThousands('-1000')).toBe('-1,000');
    expect(fmtCount(1234567)).toBe('1,234,567');
    expect(fmtCount(42n)).toBe('42');
    expect(fmtCompact(999)).toBe('999');
    expect(fmtCompact(1200)).toBe('1.2k');
    expect(fmtCompact(3_400_000)).toBe('3.4M');
    expect(fmtCompact(12_000_000_000)).toBe('12B');
    expect(fmtContext(1_000_000)).toBe('1M');
    expect(fmtContext(131_072)).toBe('131K');
    expect(fmtContext(512)).toBe('512');
  });
});
