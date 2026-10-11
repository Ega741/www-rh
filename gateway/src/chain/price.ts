/**
 * Token price and quotes for the API (`GET /api/price`, `GET /api/quote`, `BalanceDto.price`):
 * reads `priceSource.latestPrice()` and `desk.maxPriceAge()` through the {@link ChainReader} with a
 * short cache; integer math from `@beagle/shared/credit` mirrors the contract.
 *
 * @module chain/price
 */
import type { PriceDtoWire, QuoteDtoWire } from '@beagle/shared/api';
import { formatPriceE18, quoteUsdMicro, tokensForUsdMicro, tokensPerUsd, formatTokenAmount } from '@beagle/shared/credit';
import { ApiError } from '../api/errors.js';
import type { ChainReader } from './clients.js';

/** A price observation. */
export interface PriceReading {
  priceE18: bigint;
  /** Unix seconds. */
  updatedAt: number;
  stale: boolean;
  maxPriceAge: number;
  source: 'manual' | 'chainlink' | 'unknown';
}

/** Options of {@link PriceService}. */
export interface PriceServiceOptions {
  reader: ChainReader | undefined;
  source: 'manual' | 'chainlink' | 'unknown';
  decimals: number;
  /** Cache TTL (default 5 000 ms). */
  ttlMs?: number;
  now?: () => number;
}

/** Cached price reads and quote math. */
export class PriceService {
  private cache: { at: number; value: PriceReading } | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: PriceServiceOptions) {
    this.ttlMs = options.ttlMs ?? 5000;
    this.now = options.now ?? (() => Date.now());
  }

  /** The current price (zeros and `stale: true` when no chain is configured or the read fails). */
  async read(): Promise<PriceReading> {
    if (this.cache !== undefined && this.now() - this.cache.at < this.ttlMs) return this.cache.value;
    const reader = this.options.reader;
    let value: PriceReading = { priceE18: 0n, updatedAt: 0, stale: true, maxPriceAge: 0, source: this.options.source };
    if (reader !== undefined) {
      try {
        const [price, maxPriceAge] = await Promise.all([reader.latestPrice(), reader.maxPriceAge()]);
        const nowSec = Math.floor(this.now() / 1000);
        value = {
          priceE18: price.priceE18,
          updatedAt: price.updatedAt,
          stale: price.priceE18 === 0n || nowSec - price.updatedAt > maxPriceAge,
          maxPriceAge,
          source: this.options.source,
        };
      } catch {
        value = { priceE18: 0n, updatedAt: 0, stale: true, maxPriceAge: 0, source: this.options.source };
      }
    }
    this.cache = { at: this.now(), value };
    return value;
  }

  /** Drops the cache (tests, after a post). */
  invalidate(): void {
    this.cache = undefined;
  }

  /** `PriceDto` wire form. */
  toDto(reading: PriceReading): PriceDtoWire {
    return {
      priceE18: reading.priceE18.toString(),
      updatedAt: reading.updatedAt,
      stale: reading.stale,
      usdPerToken: reading.priceE18 === 0n ? '0' : formatPriceE18(reading.priceE18, { minFractionDigits: 0, maxFractionDigits: 18 }).slice(1),
      tokensPerUsd: reading.priceE18 === 0n ? '0' : formatTokenAmount(tokensPerUsd(reading.priceE18, this.options.decimals), this.options.decimals, 6),
      source: reading.source,
      maxPriceAge: reading.maxPriceAge,
    };
  }

  /** `GET /api/price`. */
  async priceDto(): Promise<PriceDtoWire> {
    return this.toDto(await this.read());
  }

  /** `GET /api/quote`: exactly one of `tokens` / `usdMicro`. Throws 503 `price_unavailable` when stale. */
  async quote(q: { tokens?: bigint; usdMicro?: bigint }): Promise<QuoteDtoWire> {
    const reading = await this.read();
    if (reading.priceE18 === 0n || reading.stale) throw new ApiError(503, 'price_unavailable', 'The on-chain token price is unavailable or stale.');
    if (q.tokens !== undefined) {
      const usdMicro = quoteUsdMicro(q.tokens, reading.priceE18, this.options.decimals);
      return { tokens: q.tokens.toString(), usdMicro: usdMicro.toString(), priceE18: reading.priceE18.toString(), updatedAt: reading.updatedAt };
    }
    if (q.usdMicro !== undefined) {
      const tokens = tokensForUsdMicro(q.usdMicro, reading.priceE18, this.options.decimals);
      return { tokens: tokens.toString(), usdMicro: q.usdMicro.toString(), priceE18: reading.priceE18.toString(), updatedAt: reading.updatedAt };
    }
    throw new ApiError(400, 'invalid_request', 'pass exactly one of tokens or usdMicro');
  }
}
