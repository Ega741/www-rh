/**
 * Display formatting for wei / ETH / USD / token amounts, curve progress and compute runway.
 * All functions are pure and never round amounts up (balances and quotes are truncated).
 *
 * @module format
 */
import { CURVE_SUPPLY, progressBps as curveProgressBps } from '@www-rh/shared';
import { formatUnits, parseUnits } from 'viem';

const SUBSCRIPT_DIGITS = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'] as const;

function subscript(n: number): string {
  return String(n)
    .split('')
    .map((d) => SUBSCRIPT_DIGITS[Number(d)] ?? d)
    .join('');
}

function groupThousands(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Options for {@link formatDecimal}. */
export interface DecimalFormat {
  /** Max fraction digits for values ≥ 1. Default 4. */
  maxFraction?: number;
  /** Significant digits kept for values < 1. Default 4. */
  significant?: number;
  /** Leading fractional zeros from which `0.0₈1272` notation kicks in. Default 4. */
  subscriptFrom?: number;
}

/**
 * Formats an exact decimal string (as produced by viem `formatUnits`) for display:
 * thousands separators, truncated fraction, and DEX-style subscript zeros for tiny values
 * (`0.000000001272` → `0.0₈1272`).
 */
export function formatDecimal(value: string, opts: DecimalFormat = {}): string {
  const { maxFraction = 4, significant = 4, subscriptFrom = 4 } = opts;
  const negative = value.startsWith('-');
  const abs = negative ? value.slice(1) : value;
  const [int = '0', frac = ''] = abs.split('.');
  const sign = negative ? '-' : '';
  if (int !== '0' && int !== '') {
    const digits = int.length >= 4 ? Math.min(maxFraction, 2) : maxFraction;
    const kept = frac.slice(0, digits).replace(/0+$/, '');
    return `${sign}${groupThousands(int)}${kept === '' ? '' : `.${kept}`}`;
  }
  const zeros = frac.length - frac.replace(/^0+/, '').length;
  if (zeros === frac.length) return '0';
  const sig = frac.slice(zeros, zeros + significant).replace(/0+$/, '');
  if (zeros >= subscriptFrom) return `${sign}0.0${subscript(zeros)}${sig}`;
  return `${sign}0.${'0'.repeat(zeros)}${sig}`;
}

/** `wei` as ETH, e.g. `1.2345 ETH`, `0.0₅12 ETH`. Pass `symbol: false` to omit the unit. */
export function formatEth(wei: bigint, opts: DecimalFormat & { symbol?: boolean } = {}): string {
  const { symbol = true, ...rest } = opts;
  const text = formatDecimal(formatUnits(wei, 18), rest);
  return symbol ? `${text} ETH` : text;
}

/**
 * Curve price (`priceWei` = wei per 1e18 tokens, i.e. wei per whole token) as ETH per token.
 */
export function formatPrice(priceWei: bigint, opts: { symbol?: boolean } = {}): string {
  return formatEth(priceWei, { significant: 4, symbol: opts.symbol ?? true });
}

/** Compact number: `950`, `12.3K`, `4.56M`, `1.2B`. */
export function formatCompact(n: number, maxFraction = 2): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = n / size;
      const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : maxFraction;
      return `${truncate(scaled, digits)}${suffix}`;
    }
  }
  return truncate(n, abs >= 100 ? 0 : maxFraction);
}

function truncate(n: number, digits: number): string {
  if (digits <= 0) return String(Math.trunc(n));
  const f = 10 ** digits;
  const t = Math.trunc(n * f) / f;
  return t.toFixed(digits).replace(/\.?0+$/, '');
}

/** Token amount (18 decimals) in compact form: `12.3M`, `800M`, `0.5`. */
export function formatTokens(amount: bigint): string {
  const whole = Number(formatUnits(amount, 18));
  if (whole !== 0 && Math.abs(whole) < 0.01) return formatDecimal(formatUnits(amount, 18));
  return formatCompact(whole);
}

/** USD amount: `$1,234`, `$12.34`, `$0.0123`, `<$0.0001`, `$1.2M`. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs < 0.0001) return `${sign}<$0.0001`;
  if (abs >= 1e6) return `${sign}$${formatCompact(abs)}`;
  const max = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  const min = abs >= 1000 ? 0 : 2;
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: min, maximumFractionDigits: max })}`;
}

/** Basis points as a percentage string: `4250` → `42.5%`. */
export function formatBps(bps: number | bigint, maxFraction = 2): string {
  return `${truncate(Number(bps) / 100, maxFraction)}%`;
}

/** Curve progress to graduation in percent (0..100) for `tokensSold`. */
export function progressPercent(tokensSold: bigint): number {
  const clamped = tokensSold < 0n ? 0n : tokensSold > CURVE_SUPPLY ? CURVE_SUPPLY : tokensSold;
  return Number(curveProgressBps(clamped)) / 100;
}

/**
 * Runway in hours from a USD balance and burn rate; `null` when nothing is burning
 * (an idle mind has infinite runway).
 */
export function runwayHours(balanceUsd: number, burnUsdPerHour: number): number | null {
  if (!(burnUsdPerHour > 0)) return null;
  return Math.max(0, balanceUsd) / burnUsdPerHour;
}

/** Runway for display: `∞`, `empty`, `45m`, `13h 20m`, `4d 3h`, `>1y`. */
export function formatRunway(hours: number | null): string {
  if (hours === null) return '∞';
  if (!Number.isFinite(hours)) return '∞';
  if (hours <= 0) return 'empty';
  return formatDuration(hours * 3_600_000);
}

/** Duration in ms for display: `45s`, `12m`, `3h 20m`, `4d 3h`, `>1y`. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  if (days > 365) return '>1y';
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** Relative time: `just now`, `12s ago`, `5m ago`, `3h ago`, `2d ago`. */
export function timeAgo(ms: number, now: number = Date.now()): string {
  const diff = now - ms;
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** Local clock time `HH:MM:SS`. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** `0x1234…abcd`. */
export function shortAddress(address: string, chars = 4): string {
  if (address.length <= 2 + chars * 2) return address;
  return `${address.slice(0, 2 + chars)}…${address.slice(-chars)}`;
}

/** `0x12345678…` for hashes. */
export function shortHash(hash: string, chars = 8): string {
  return hash.length <= 2 + chars ? hash : `${hash.slice(0, 2 + chars)}…`;
}

/** Hostname + path of a URL for compact display (falls back to the raw string). */
export function displayUrl(url: string, max = 64): string {
  let text = url;
  try {
    const u = new URL(url);
    text = `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
  } catch {
    // keep raw
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Parses a user-typed decimal amount into base units (default 18 decimals). Accepts `,` as the
 * decimal separator. Returns `null` for empty, malformed, negative or over-precise input.
 */
export function parseAmount(input: string, decimals = 18): bigint | null {
  const text = input.trim().replace(',', '.');
  if (text === '' || text === '.') return null;
  if (!/^[0-9]*\.?[0-9]*$/.test(text)) return null;
  const frac = text.split('.')[1] ?? '';
  if (frac.length > decimals) return null;
  try {
    return parseUnits(text.startsWith('.') ? `0${text}` : text, decimals);
  } catch {
    return null;
  }
}

/** Converts wei to a floating ETH number (display math only). */
export function weiToEth(wei: bigint): number {
  return Number(formatUnits(wei, 18));
}

/** Implied ETH/USD price from a balance pair, or `null` when not derivable. */
export function impliedEthUsd(balanceWei: bigint, balanceUsd: number): number | null {
  const eth = weiToEth(balanceWei);
  if (!(eth > 0) || !(balanceUsd > 0)) return null;
  return balanceUsd / eth;
}
