/**
 * Integer-only credit math (SPEC §1, §4.3), mirroring the Solidity `CreditMath` library.
 *
 * All money is `bigint`: µUSD (`1 USD = 1_000_000 µUSD`), raw token units and `priceE18`
 * (USD per whole token scaled by `1e18`). Nothing here touches floating point except the
 * token-count inputs of {@link costMicroUsd}, which are safe integers.
 *
 * @module credit
 */
import type { ModelPrice } from './models.js';

/** µUSD in one USD. */
export const MICRO_USD = 1_000_000n;
/** Scale of `priceE18` (USD per whole token × 1e18). */
export const PRICE_SCALE = 10n ** 18n;
/** Upper bound of token `decimals` accepted by the desk and by this module (SPEC §3.1). */
export const MAX_TOKEN_DECIMALS = 36;
/** Basis-point denominator. */
export const BPS_DENOMINATOR = 10_000n;

function assertNonNegative(name: string, value: bigint): void {
  if (typeof value !== 'bigint') throw new TypeError(`${name} must be a bigint`);
  if (value < 0n) throw new RangeError(`${name} must be ≥ 0 (got ${value})`);
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
    throw new RangeError(`decimals must be an integer in [0, ${MAX_TOKEN_DECIMALS}] (got ${decimals})`);
  }
}

function assertTokenCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer (got ${value})`);
  }
}

/** `ceil(a / b)` for non-negative `a` and positive `b`. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  assertNonNegative('a', a);
  if (b <= 0n) throw new RangeError(`divisor must be > 0 (got ${b})`);
  return (a + b - 1n) / b;
}

/**
 * µUSD credited for burning `amount` raw token units at `priceE18`
 * (`floor(amount · priceE18 / 10^(decimals + 12))`, SPEC §1). Mirrors `CreditMath.usdMicro`.
 */
export function quoteUsdMicro(amount: bigint, priceE18: bigint, decimals = 18): bigint {
  assertNonNegative('amount', amount);
  assertNonNegative('priceE18', priceE18);
  assertDecimals(decimals);
  return (amount * priceE18) / 10n ** BigInt(decimals + 12);
}

/**
 * Raw token units needed to receive `usdMicro` at `priceE18`
 * (`ceil(usdMicro · 10^(decimals + 12) / priceE18)`, SPEC §1). Throws when `priceE18` is zero.
 * Mirrors `CreditMath.tokensForUsdMicro`.
 */
export function tokensForUsdMicro(usdMicro: bigint, priceE18: bigint, decimals = 18): bigint {
  assertNonNegative('usdMicro', usdMicro);
  assertNonNegative('priceE18', priceE18);
  assertDecimals(decimals);
  if (priceE18 === 0n) throw new RangeError('priceE18 must be > 0');
  return ceilDiv(usdMicro * 10n ** BigInt(decimals + 12), priceE18);
}

/** Token counts of one request, as reported by the provider (cache fields default to 0). */
export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** `ceilDiv(tokens · pricePerMillion, 1_000_000)` in µUSD. */
export function componentCostMicroUsd(tokens: number, pricePerMillion: number): bigint {
  assertTokenCount('tokens', tokens);
  if (!Number.isSafeInteger(pricePerMillion) || pricePerMillion < 0) {
    throw new RangeError(`pricePerMillion must be a non-negative safe integer (got ${pricePerMillion})`);
  }
  if (tokens === 0 || pricePerMillion === 0) return 0n;
  return ceilDiv(BigInt(tokens) * BigInt(pricePerMillion), MICRO_USD);
}

/**
 * Upstream cost of `usage` at `price` in µUSD: the sum of per-component
 * `ceilDiv(tokens · pricePerMillion, 1_000_000)` (SPEC §1). Cache reads/writes fall back to the
 * input price when the model lists no cache price.
 */
export function costMicroUsd(usage: UsageTokens, price: ModelPrice): bigint {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return (
    componentCostMicroUsd(usage.inputTokens, price.inputPerM) +
    componentCostMicroUsd(usage.outputTokens, price.outputPerM) +
    componentCostMicroUsd(cacheRead, price.cacheReadPerM ?? price.inputPerM) +
    componentCostMicroUsd(cacheWrite, price.cacheWritePerM ?? price.inputPerM)
  );
}

/** `cost + ceilDiv(cost · bps, 10_000)` (SPEC §1). `bps` may be 0. */
export function applyMarkupBps(cost: bigint, bps: number | bigint): bigint {
  assertNonNegative('cost', cost);
  const b = typeof bps === 'bigint' ? bps : BigInt(bps);
  if (b < 0n) throw new RangeError(`bps must be ≥ 0 (got ${b})`);
  if (cost === 0n || b === 0n) return cost;
  return cost + ceilDiv(cost * b, BPS_DENOMINATOR);
}

/** Options of the decimal formatters. */
export interface FormatOptions {
  /** Fraction digits to show at most (extra digits are rounded or truncated, see each formatter). */
  maxFractionDigits?: number;
  /** Fraction digits to show at least (padded with zeros). */
  minFractionDigits?: number;
}

/**
 * Formats `abs / 10^scale` with at most `max` and at least `min` fraction digits.
 * `round`: round half up (money display) instead of truncating (balances).
 */
function formatScaled(abs: bigint, scale: number, max: number, min: number, round: boolean): string {
  if (!Number.isInteger(max) || max < 0) throw new RangeError('maxFractionDigits must be a non-negative integer');
  if (!Number.isInteger(min) || min < 0) throw new RangeError('minFractionDigits must be a non-negative integer');
  const digits = Math.min(Math.max(max, min), scale);
  const drop = scale - digits;
  let q = abs;
  if (drop > 0) {
    const d = 10n ** BigInt(drop);
    q = round ? (abs + d / 2n) / d : abs / d;
  }
  const unit = 10n ** BigInt(digits);
  const whole = (q / unit).toString();
  let frac = digits === 0 ? '' : (q % unit).toString().padStart(digits, '0');
  frac = frac.replace(/0+$/, '');
  const minDigits = Math.max(min, 0);
  if (frac.length < minDigits) frac = frac.padEnd(minDigits, '0');
  return frac === '' ? whole : `${whole}.${frac}`;
}

/**
 * Formats µUSD as a dollar string: `2_500_000n` → `"$2.50"`, `-150_000n` → `"-$0.15"`,
 * `2_500_100n` → `"$2.5001"`. Shows at least `minFractionDigits` (2) and at most
 * `maxFractionDigits` (4) decimals, rounding half up.
 */
export function formatUsdMicro(x: bigint, options: FormatOptions = {}): string {
  const { maxFractionDigits = 4, minFractionDigits = 2 } = options;
  const negative = x < 0n;
  const body = formatScaled(negative ? -x : x, 6, maxFractionDigits, minFractionDigits, true);
  return `${negative ? '-' : ''}$${body}`;
}

/**
 * Parses a dollar amount (`"2.5"`, `"$10"`, `"-0.25"`) into µUSD. At most six fraction digits
 * are accepted; anything else throws.
 */
export function parseUsdToMicro(input: string): bigint {
  const m = /^\s*(-)?\$?\s*(\d*)(?:\.(\d*))?\s*$/.exec(input);
  if (!m || ((m[2] ?? '') === '' && (m[3] ?? '') === '')) throw new SyntaxError(`invalid USD amount: ${JSON.stringify(input)}`);
  const whole = m[2] === '' || m[2] === undefined ? '0' : m[2];
  const frac = m[3] ?? '';
  if (frac.length > 6) throw new RangeError(`USD amount has more than 6 fraction digits: ${JSON.stringify(input)}`);
  const micro = BigInt(whole) * MICRO_USD + BigInt(frac.padEnd(6, '0') || '0');
  return m[1] ? -micro : micro;
}

/**
 * Formats raw token units as a decimal string (`1000e18, 18` → `"1000"`, `15e17, 18` → `"1.5"`),
 * truncating (not rounding) to `maxFractionDigits` (4) and trimming trailing zeros.
 */
export function formatTokenAmount(raw: bigint, decimals: number, maxFractionDigits = 4): string {
  assertDecimals(decimals);
  const negative = raw < 0n;
  const body = formatScaled(negative ? -raw : raw, decimals, maxFractionDigits, 0, false);
  return negative ? `-${body}` : body;
}

/**
 * Parses a decimal token amount (`"1000.5"`) into raw units with `decimals`. More fraction digits
 * than `decimals` throw; so does anything that is not a plain decimal number.
 */
export function parseTokenAmount(input: string, decimals: number): bigint {
  assertDecimals(decimals);
  const m = /^\s*(-)?(\d*)(?:\.(\d*))?\s*$/.exec(input);
  if (!m || ((m[2] ?? '') === '' && (m[3] ?? '') === '')) throw new SyntaxError(`invalid token amount: ${JSON.stringify(input)}`);
  const whole = m[2] === '' || m[2] === undefined ? '0' : m[2];
  const frac = m[3] ?? '';
  if (frac.length > decimals) {
    throw new RangeError(`token amount has more than ${decimals} fraction digits: ${JSON.stringify(input)}`);
  }
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  return m[1] ? -raw : raw;
}

/**
 * Formats `priceE18` (USD per whole token × 1e18) as a dollar string: `2_500_000_000_000_000n` →
 * `"$0.0025"`. Rounds half up to `maxFractionDigits` (6), shows at least `minFractionDigits` (2).
 */
export function formatPriceE18(priceE18: bigint, options: FormatOptions = {}): string {
  assertNonNegative('priceE18', priceE18);
  const { maxFractionDigits = 6, minFractionDigits = 2 } = options;
  return `$${formatScaled(priceE18, 18, maxFractionDigits, minFractionDigits, true)}`;
}

/** Raw token units bought by one USD at `priceE18` (`tokensForUsdMicro(1_000_000n, …)`). */
export function tokensPerUsd(priceE18: bigint, decimals = 18): bigint {
  return tokensForUsdMicro(MICRO_USD, priceE18, decimals);
}
