/**
 * Published token price (SPEC §3.3, §5.4): the `price_points` history, the in-memory cache of
 * the last point, the refresh loop per source (`manual` keep-alive, `feed` JSON, Jupiter Price
 * API), the step bound / min-change / keep-alive rules, staleness, and the quote math for
 * `GET /api/price`, `GET /api/price/history`, `GET /api/quote` and `BalanceDto.price`.
 *
 * @module chain/price
 */
import type { PriceDtoWire, PriceSource, QuoteDtoWire } from '@beagle/shared/api';
import { formatPriceE18, formatTokenAmount, quoteUsdMicro, tokensForUsdMicro, tokensPerUsd } from '@beagle/shared/credit';
import { ApiError } from '../api/errors.js';
import type { PriceSourceKind } from '../config.js';
import type { PricePointRow, Repos } from '../db/repos.js';
import type { Logger } from '../log.js';

/** One published price point. */
export interface PricePoint {
  id: number;
  priceE18: bigint;
  source: PriceSource;
  /** Unix seconds. */
  observedAt: number;
}

/** The current point with its staleness. */
export interface PriceSnapshot extends PricePoint {
  stale: boolean;
}

/** Options of {@link PriceService}. */
export interface PriceServiceOptions {
  source: PriceSourceKind;
  /** Manual bootstrap when the history is empty. */
  initialPriceE18?: bigint;
  feedUrl?: string;
  jupiterUrl: string;
  /** The mint whose price Jupiter is asked for. */
  mint?: string;
  minChangeBps: number;
  maxStepBps: number;
  maxAgeS: number;
  decimals: number;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

/** Result of one {@link PriceService.refresh} / {@link PriceService.observe}. */
export type PriceRefreshResult =
  | { action: 'appended'; point: PricePoint; keepAlive: boolean }
  | { action: 'skipped'; reason: string }
  | { action: 'rejected'; priceE18: bigint; lastPriceE18: bigint }
  | { action: 'failed'; error: string };

/**
 * Converts a USD price (JS number from a feed) into `priceE18`. Uses the shortest round-trip
 * decimal form of the number (`String(n)`, exponent-aware), so `0.03` becomes exactly `3e16`
 * instead of exposing binary float noise; digits beyond 1e-18 are truncated.
 */
export function usdToPriceE18(priceUsd: number): bigint {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new RangeError(`priceUsd must be a positive number (got ${priceUsd})`);
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(priceUsd));
  if (!m) throw new RangeError(`priceUsd is not a plain decimal number (got ${priceUsd})`);
  const frac = m[2] ?? '';
  const exponent = 18 + Number(m[3] ?? '0') - frac.length;
  const digits = BigInt(`${m[1]}${frac}`);
  const value = exponent >= 0 ? digits * 10n ** BigInt(exponent) : digits / 10n ** BigInt(-exponent);
  if (value <= 0n) throw new RangeError(`priceUsd is too small to represent (got ${priceUsd})`);
  return value;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** The price history and the current point. */
export class PriceService {
  private latest: PricePointRow | undefined;
  private readonly now: () => number;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(
    private readonly repos: Repos,
    private readonly options: PriceServiceOptions,
    private readonly logger: Logger,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Loads the last point; bootstraps the manual price when the history is empty. */
  init(): void {
    this.latest = this.repos.pricePoints.latest();
    if (this.latest === undefined && this.options.source === 'manual' && this.options.initialPriceE18 !== undefined) {
      this.set(this.options.initialPriceE18, 'manual');
      this.logger.info('price bootstrapped from INITIAL_PRICE_USD', { priceE18: this.options.initialPriceE18.toString() });
    }
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }

  private snapshot(row: PricePointRow): PriceSnapshot {
    return { id: row.id, priceE18: row.priceE18, source: row.source, observedAt: row.observedAt, stale: this.nowSec() - row.observedAt > this.options.maxAgeS };
  }

  /** The current point, or `undefined` before the first one. */
  current(): PriceSnapshot | undefined {
    return this.latest === undefined ? undefined : this.snapshot(this.latest);
  }

  /** `PRICE_MAX_AGE_S`. */
  get maxAgeS(): number {
    return this.options.maxAgeS;
  }

  /** `true` when the price is stale (or missing). */
  isStale(): boolean {
    return this.current()?.stale ?? true;
  }

  private append(priceE18: bigint, source: PriceSource): PricePoint {
    const now = this.now();
    const row = this.repos.pricePoints.insert({ priceE18, source, observedAt: Math.floor(now / 1000), createdAt: now });
    this.latest = row;
    return { id: row.id, priceE18: row.priceE18, source: row.source, observedAt: row.observedAt };
  }

  /** Admin / CLI: appends a manual point unconditionally (bypasses the step bound; logged). */
  set(priceE18: bigint, source: PriceSource = 'manual'): PricePoint {
    if (priceE18 <= 0n) throw new RangeError('priceE18 must be positive');
    const point = this.append(priceE18, source);
    this.logger.info('price_set', { pricePointId: point.id, priceE18: priceE18.toString(), source });
    return point;
  }

  /**
   * Applies the §3.3 rules to an observed price: a jump above `PRICE_MAX_STEP_BPS` is rejected
   * (`price_rejected`), a change below `PRICE_MIN_CHANGE_BPS` is skipped unless the last point is
   * older than `PRICE_MAX_AGE_S / 2` (keep-alive), otherwise a point is appended.
   */
  observe(priceE18: bigint, source: PriceSource): PriceRefreshResult {
    if (priceE18 <= 0n) return { action: 'failed', error: 'price must be positive' };
    const last = this.latest;
    let keepAlive = false;
    if (last !== undefined && last.priceE18 > 0n) {
      const delta = priceE18 > last.priceE18 ? priceE18 - last.priceE18 : last.priceE18 - priceE18;
      if (delta * 10_000n > last.priceE18 * BigInt(this.options.maxStepBps)) {
        this.logger.warn('price_rejected', { priceE18: priceE18.toString(), lastPriceE18: last.priceE18.toString(), maxStepBps: this.options.maxStepBps, source });
        return { action: 'rejected', priceE18, lastPriceE18: last.priceE18 };
      }
      keepAlive = this.nowSec() - last.observedAt > this.options.maxAgeS / 2;
      if (delta * 10_000n < last.priceE18 * BigInt(this.options.minChangeBps) && !keepAlive) return { action: 'skipped', reason: 'change below PRICE_MIN_CHANGE_BPS' };
    }
    const point = this.append(priceE18, source);
    this.logger.info('price_point', { pricePointId: point.id, priceE18: priceE18.toString(), source, keepAlive });
    return { action: 'appended', point, keepAlive };
  }

  /** Fetches `PRICE_FEED_URL` → `{ priceUsd }`. */
  async fetchFeedPrice(): Promise<bigint> {
    if (this.options.feedUrl === undefined) throw new Error('PRICE_FEED_URL is not configured');
    const res = await this.fetchImpl(this.options.feedUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`price feed HTTP ${res.status}`);
    const json = (await res.json()) as unknown;
    const raw = isRecord(json) ? json['priceUsd'] : undefined;
    const price = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof price !== 'number') throw new Error('price feed lacks a numeric priceUsd');
    return usdToPriceE18(price);
  }

  /** Fetches `{JUPITER_PRICE_URL}?ids=<mint>` → `data[mint].usdPrice` (v2 layout) or `[mint].usdPrice` (v3 layout). */
  async fetchJupiterPrice(): Promise<bigint> {
    const mint = this.options.mint;
    if (mint === undefined) throw new Error('no mint configured for the Jupiter price lookup');
    const url = `${this.options.jupiterUrl}?ids=${encodeURIComponent(mint)}`;
    const res = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Jupiter price API HTTP ${res.status}`);
    const json = (await res.json()) as unknown;
    const data = isRecord(json) && isRecord(json['data']) ? json['data'] : json;
    const entry = isRecord(data) ? data[mint] : undefined;
    const raw = isRecord(entry) ? (entry['usdPrice'] ?? entry['price']) : undefined;
    const price = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof price !== 'number') throw new Error(`Jupiter price API has no usdPrice for ${mint}`);
    return usdToPriceE18(price);
  }

  /** One refresh per the configured source. */
  async refresh(): Promise<PriceRefreshResult> {
    try {
      switch (this.options.source) {
        case 'manual': {
          if (this.latest === undefined) return { action: 'skipped', reason: 'no manual price set yet' };
          return this.observe(this.latest.priceE18, 'manual');
        }
        case 'feed':
          return this.observe(await this.fetchFeedPrice(), 'feed');
        case 'jupiter':
          return this.observe(await this.fetchJupiterPrice(), 'jupiter');
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.warn('price refresh failed', { source: this.options.source, error });
      return { action: 'failed', error };
    }
  }

  /** Points newest first. */
  history(limit: number): PricePoint[] {
    return this.repos.pricePoints.list(limit).map((r) => ({ id: r.id, priceE18: r.priceE18, source: r.source, observedAt: r.observedAt }));
  }

  /** `PriceDto` wire form (`stale` relative to now; zeros when there is no point yet). */
  toDto(point: PricePoint | undefined): PriceDtoWire {
    if (point === undefined) {
      return { pricePointId: 0, priceE18: '0', observedAt: 0, stale: true, source: this.options.source, maxAgeS: this.options.maxAgeS, usdPerToken: '0', tokensPerUsd: '0' };
    }
    return {
      pricePointId: point.id,
      priceE18: point.priceE18.toString(),
      observedAt: point.observedAt,
      stale: this.nowSec() - point.observedAt > this.options.maxAgeS,
      source: point.source,
      maxAgeS: this.options.maxAgeS,
      usdPerToken: formatPriceE18(point.priceE18, { minFractionDigits: 0, maxFractionDigits: 18 }).slice(1),
      tokensPerUsd: formatTokenAmount(tokensPerUsd(point.priceE18, this.options.decimals), this.options.decimals, 6),
    };
  }

  /** `GET /api/price`. */
  priceDto(): PriceDtoWire {
    return this.toDto(this.current());
  }

  /** `GET /api/price/history`. */
  historyDto(limit: number): PriceDtoWire[] {
    return this.history(limit).map((p) => this.toDto(p));
  }

  /** `GET /api/quote`: exactly one of `tokens` / `usdMicro` at the current point (503 when there is none). */
  quote(q: { tokens?: bigint; usdMicro?: bigint }): QuoteDtoWire {
    const point = this.current();
    if (point === undefined) throw new ApiError(503, 'price_unavailable', 'No price point has been published yet.');
    const base = { priceE18: point.priceE18.toString(), pricePointId: point.id, stale: point.stale };
    if (q.tokens !== undefined && q.usdMicro === undefined) {
      return { tokens: q.tokens.toString(), usdMicro: quoteUsdMicro(q.tokens, point.priceE18, this.options.decimals).toString(), ...base };
    }
    if (q.usdMicro !== undefined && q.tokens === undefined) {
      return { tokens: tokensForUsdMicro(q.usdMicro, point.priceE18, this.options.decimals).toString(), usdMicro: q.usdMicro.toString(), ...base };
    }
    throw new ApiError(400, 'invalid_request', 'pass exactly one of tokens or usdMicro');
  }
}
