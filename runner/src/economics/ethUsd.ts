/**
 * ETH/USD price in integer micro-USD per ETH: a Chainlink AggregatorV3 feed (`ETH_USD_FEED`) when
 * configured and fresh, otherwise the fixed `ETH_USD_PRICE`.
 *
 * @module economics/ethUsd
 */
import type { Address } from 'viem';
import { aggregatorV3Abi } from '@www-rh/shared';
import type { RunnerPublicClient } from '../chain/clients.js';
import { errorMessage, type Logger } from '../log.js';

/** Source of the ETH/USD price used for budgets and draw receipts. */
export interface EthUsdSource {
  /** ETH/USD × 1e6 (integer). Never throws: falls back to the configured fixed price. */
  priceMicro(): Promise<number>;
}

/** A fixed price. */
export class FixedEthUsd implements EthUsdSource {
  constructor(private readonly micro: number) {}

  priceMicro(): Promise<number> {
    return Promise.resolve(this.micro);
  }
}

/** Converts a feed answer with `decimals` to micro-USD (floor). */
export function feedAnswerToMicro(answer: bigint, decimals: number): number {
  if (answer <= 0n) throw new RangeError('non-positive feed answer');
  const micro = decimals >= 6 ? answer / 10n ** BigInt(decimals - 6) : answer * 10n ** BigInt(6 - decimals);
  if (micro <= 0n || micro > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('feed answer out of range');
  return Number(micro);
}

/** Chainlink AggregatorV3 reader with a short cache, staleness check and fixed fallback. */
export class FeedEthUsd implements EthUsdSource {
  #cached: { micro: number; at: number } | null = null;
  #decimals: number | null = null;

  constructor(
    private readonly client: RunnerPublicClient,
    private readonly feed: Address,
    private readonly fallbackMicro: number,
    private readonly maxAgeS: number,
    private readonly log: Logger,
    private readonly cacheMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async priceMicro(): Promise<number> {
    if (this.#cached !== null && this.now() - this.#cached.at < this.cacheMs) return this.#cached.micro;
    try {
      this.#decimals ??= await this.client.readContract({ address: this.feed, abi: aggregatorV3Abi, functionName: 'decimals' });
      const [, answer, , updatedAt] = await this.client.readContract({ address: this.feed, abi: aggregatorV3Abi, functionName: 'latestRoundData' });
      const ageS = Math.floor(this.now() / 1000) - Number(updatedAt);
      if (ageS > this.maxAgeS) throw new Error(`feed answer is stale (${ageS}s old)`);
      const micro = feedAnswerToMicro(answer, this.#decimals);
      this.#cached = { micro, at: this.now() };
      return micro;
    } catch (err) {
      this.log.warn('ETH/USD feed unavailable, using ETH_USD_PRICE', { error: errorMessage(err) });
      return this.#cached?.micro ?? this.fallbackMicro;
    }
  }
}
