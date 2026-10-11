/**
 * Amount parsing / formatting for the UI, built on `@beagle/shared/credit`. Money is bigint µUSD,
 * token amounts are raw units; nothing here touches floating point.
 */
import {
  formatPriceE18,
  formatTokenAmount,
  formatUsdMicro,
  parseTokenAmount,
  parseUsdToMicro,
  quoteUsdMicro,
  tokensForUsdMicro,
  type FormatOptions,
} from '@beagle/shared/credit';

/** Which unit an amount input is denominated in. */
export type AmountMode = 'usd' | 'token';

/** Result of {@link parseAmount}. */
export type ParsedAmount = { ok: true; value: bigint } | { ok: false; error: string };

/** Parses a user-typed amount (USD → µUSD, token → raw units). Zero and negatives are rejected. */
export function parseAmount(input: string, mode: AmountMode, decimals: number): ParsedAmount {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, error: 'Enter an amount' };
  try {
    const value = mode === 'usd' ? parseUsdToMicro(trimmed) : parseTokenAmount(trimmed, decimals);
    if (value < 0n) return { ok: false, error: 'Amount must be positive' };
    if (value === 0n) return { ok: false, error: 'Amount must be greater than zero' };
    return { ok: true, value };
  } catch (e) {
    if (e instanceof RangeError) {
      return { ok: false, error: mode === 'usd' ? 'At most 6 decimal places' : `At most ${decimals} decimal places` };
    }
    return { ok: false, error: 'Not a valid number' };
  }
}

/** Both sides of an amount at a given price. */
export interface Converted {
  tokens: bigint;
  usdMicro: bigint;
}

/**
 * Converts a parsed amount to tokens + µUSD at `priceE18`. In USD mode the token amount is the
 * ceiling needed for that many µUSD and `usdMicro` is re-quoted from it (what the desk will
 * actually credit). Returns `undefined` when the price is unavailable (0).
 */
export function convertAmount(mode: AmountMode, value: bigint, priceE18: bigint, decimals: number): Converted | undefined {
  if (priceE18 <= 0n || value < 0n) return undefined;
  if (mode === 'usd') {
    const tokens = tokensForUsdMicro(value, priceE18, decimals);
    return { tokens, usdMicro: quoteUsdMicro(tokens, priceE18, decimals) };
  }
  return { tokens: value, usdMicro: quoteUsdMicro(value, priceE18, decimals) };
}

/** `$12.34` style, rounding half up (shared `formatUsdMicro`). */
export function fmtUsd(micro: bigint, options?: FormatOptions): string {
  return formatUsdMicro(micro, options);
}

/** `1,000.5 BEAGLE` style token amount (truncating), optionally with the symbol. */
export function fmtTokens(raw: bigint, decimals: number, symbol?: string, maxFractionDigits = 4): string {
  const body = groupThousands(formatTokenAmount(raw, decimals, maxFractionDigits));
  return symbol === undefined || symbol === '' ? body : `${body} ${symbol}`;
}

/** `$0.0025` style price per whole token. */
export function fmtPrice(priceE18: bigint, options?: FormatOptions): string {
  return formatPriceE18(priceE18, options);
}

/** µUSD per 1M tokens → `$2.50` (model price tables). */
export function fmtPerMillion(microPerM: number): string {
  return formatUsdMicro(BigInt(Math.max(0, Math.trunc(microPerM))), { maxFractionDigits: 2 });
}

/** Integer with thousands separators (`1,234,567`). */
export function fmtCount(n: number | bigint): string {
  return groupThousands(typeof n === 'bigint' ? n.toString() : Math.trunc(n).toString());
}

/** Compact integer (`1.2k`, `3.4M`, `12B`). */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const fmt = (v: number, unit: string): string => {
    const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    return `${sign}${s.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1')}${unit}`;
  };
  if (abs >= 1e9) return fmt(abs / 1e9, 'B');
  if (abs >= 1e6) return fmt(abs / 1e6, 'M');
  if (abs >= 1e3) return fmt(abs / 1e3, 'k');
  return `${sign}${abs.toString()}`;
}

/** Inserts thousands separators into the integer part of a decimal string. */
export function groupThousands(decimal: string): string {
  const negative = decimal.startsWith('-');
  const body = negative ? decimal.slice(1) : decimal;
  const [whole = '', frac] = body.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${frac === undefined ? '' : `.${frac}`}`;
}

/** Context window / token counts: `128K`, `1M`. */
export function fmtContext(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return tokens.toString();
}
