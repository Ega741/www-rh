/**
 * ETH/USD price in integer micro-USD per ETH (`docs/SPEC.md` §4.1 economics): Chainlink
 * AggregatorV3 `ETH_USD_FEED` when healthy (answer > 0 and updated within 3600 s), otherwise the
 * fixed `ETH_USD_PRICE`; cached 60 s.
 *
 * @module economics/ethUsd
 */
import { parseAbi, type Address } from 'viem';
import type { RunnerPublicClient } from '../chain/clients.js';
import { errorMessage, type Logger } from '../log.js';

/** Minimal Chainlink `AggregatorV3Interface`. */
export const aggregatorV3Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/** Maximum feed answer age. */
export const FEED_MAX_AGE_S = 3_600;
/** Price cache lifetime. */
export const PRICE_CACHE_MS = 60_000;

/** Source of the ETH/USD price. */
export interface EthUsdSource {
  /** ETH/USD × 1e6 (integer). Never throws. */
  ethUsdMicro(): Promise<number>;
}

/** A fixed price. */
export class FixedEthUsd implements EthUsdSource {
  constructor(private readonly micro: number) {}

  ethUsdMicro(): Promise<number> {
    return Promise.resolve(this.micro);
  }
}

/** Converts a feed answer with `decimals` to micro-USD (floor). */
export function feedAnswerToMicro(answer: bigint, decimals: number): number {
  if (answer <= 0n) throw new RangeError('feed answer must be positive');
  const micro = decimals >= 6 ? answer / 10n ** BigInt(decimals - 6) : answer * 10n ** BigInt(6 - decimals);
  if (micro <= 0n || micro > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('feed answer out of range');
  return Number(micro);
}

/** Chainlink reader with cache, staleness check and fixed fallback. */
export class FeedEthUsd implements EthUsdSource {
  #cached: { micro: number; at: number } | null = null;
  #decimals: number | null = null;

  constructor(
    private readonly client: RunnerPublicClient,
    private readonly feed: Address,
    private readonly fallbackMicro: number,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async ethUsdMicro(): Promise<number> {
    if (this.#cached !== null && this.now() - this.#cached.at < PRICE_CACHE_MS) return this.#cached.micro;
    let micro: number;
    try {
      this.#decimals ??= await this.client.readContract({ address: this.feed, abi: aggregatorV3Abi, functionName: 'decimals' });
      const [, answer, , updatedAt] = await this.client.readContract({ address: this.feed, abi: aggregatorV3Abi, functionName: 'latestRoundData' });
      const ageS = Math.floor(this.now() / 1000) - Number(updatedAt);
      if (ageS > FEED_MAX_AGE_S) throw new Error(`feed answer is ${ageS}s old`);
      micro = feedAnswerToMicro(answer, this.#decimals);
    } catch (err) {
      this.log.warn('ETH/USD feed rejected, using ETH_USD_PRICE', { error: errorMessage(err) });
      micro = this.fallbackMicro;
    }
    this.#cached = { micro, at: this.now() };
    return micro;
  }
}
