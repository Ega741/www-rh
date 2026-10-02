/**
 * ETH/USD price in integer micro-USD per ETH (`docs/SPEC.md` §4.1 economics): Chainlink
 * AggregatorV3 `ETH_USD_FEED` when healthy (answer > 0, updated within 3600 s and inside the
 * plausible range `ETH_USD_MIN`..`ETH_USD_MAX`), otherwise the fixed `ETH_USD_PRICE` clamped to that
 * range (logged); cached 60 s. The price converts spend into wei drawn from a vault, so an absurd
 * fallback (a typo, a unit error) must never reach a receipt.
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

/** Plausible ETH/USD range in micro-USD (`ETH_USD_MIN` / `ETH_USD_MAX`). */
export interface EthUsdBounds {
  min: number;
  max: number;
}

/** Defaults of `ETH_USD_MIN` = 100 and `ETH_USD_MAX` = 100000 (× 1e6). */
export const DEFAULT_ETH_USD_BOUNDS: EthUsdBounds = { min: 100_000_000, max: 100_000_000_000 };

/** Clamps a fallback price into `bounds`. */
export function clampEthUsdMicro(micro: number, bounds: EthUsdBounds): { micro: number; clamped: boolean } {
  if (micro < bounds.min) return { micro: bounds.min, clamped: true };
  if (micro > bounds.max) return { micro: bounds.max, clamped: true };
  return { micro, clamped: false };
}

/** Source of the ETH/USD price. */
export interface EthUsdSource {
  /** ETH/USD × 1e6 (integer). Never throws. */
  ethUsdMicro(): Promise<number>;
}

/** A fixed price (`ETH_USD_PRICE` without a feed), clamped to the plausible range. */
export class FixedEthUsd implements EthUsdSource {
  readonly #micro: number;

  constructor(micro: number, bounds: EthUsdBounds = DEFAULT_ETH_USD_BOUNDS, log?: Logger) {
    const c = clampEthUsdMicro(micro, bounds);
    if (c.clamped) log?.error('ETH_USD_PRICE outside ETH_USD_MIN..ETH_USD_MAX; clamped', { configuredMicro: micro, usedMicro: c.micro, bounds });
    this.#micro = c.micro;
  }

  ethUsdMicro(): Promise<number> {
    return Promise.resolve(this.#micro);
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
    private readonly bounds: EthUsdBounds = DEFAULT_ETH_USD_BOUNDS,
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
      if (micro < this.bounds.min || micro > this.bounds.max) throw new Error(`feed answer ${micro / 1e6} USD outside ETH_USD_MIN..ETH_USD_MAX`);
    } catch (err) {
      const fallback = clampEthUsdMicro(this.fallbackMicro, this.bounds);
      micro = fallback.micro;
      this.log.warn('ETH/USD feed rejected, using ETH_USD_PRICE', { error: errorMessage(err), usedMicro: micro });
      if (fallback.clamped) this.log.error('ETH_USD_PRICE fallback outside ETH_USD_MIN..ETH_USD_MAX; clamped', { configuredMicro: this.fallbackMicro, usedMicro: micro });
    }
    this.#cached = { micro, at: this.now() };
    return micro;
  }
}
