/**
 * Price poster (SPEC §5.4, optional): fetches `PRICE_FEED_URL` → `{ priceUsd }` → `priceE18`, reads
 * the `ManualPriceSource` bounds, clamps the step to `maxStepBps`, skips within `minInterval` or when
 * the change is below 0.5 %, posts with the operator key and records the post. `DRY_RUN` logs only.
 *
 * Keep-alive: the desk rejects quotes older than `maxPriceAge`, so a flat price is re-posted anyway
 * once the on-chain quote is within two post intervals of going stale (the band only skips posts
 * that are not needed for liveness).
 *
 * @module chain/poster
 */
import { parseUsdToMicro } from '@beagle/shared/credit';
import type { Hex } from 'viem';
import type { Repos } from '../db/repos.js';
import type { Logger } from '../log.js';
import type { ChainReader, ChainWriter } from './clients.js';

/** Options of {@link PricePoster}. */
export interface PosterOptions {
  feedUrl: string;
  dryRun: boolean;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  /** Minimum relative change to post (bps; default 50 = 0.5 %). */
  minChangeBps?: number;
  /** `PRICE_POST_INTERVAL_MS` (default 300 000): the keep-alive posts when `age ≥ maxPriceAge − 2·interval`. */
  postIntervalMs?: number;
}

/** Converts a USD price (number) into `priceE18` (18-decimal fixed point) without float drift beyond 1e-12. */
export function usdToPriceE18(priceUsd: number): bigint {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new RangeError(`priceUsd must be a positive number (got ${priceUsd})`);
  // parseUsdToMicro handles up to 6 decimals; scale manually for finer prices.
  const text = priceUsd.toFixed(12);
  const [whole = '0', frac = ''] = text.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, '0').slice(0, 18));
}

/** Clamps `next` to within `maxStepBps` of `current` (no-op when `current` is zero). */
export function clampStep(current: bigint, next: bigint, maxStepBps: number): bigint {
  if (current === 0n) return next;
  const maxDelta = (current * BigInt(maxStepBps)) / 10_000n;
  if (next > current + maxDelta) return current + maxDelta;
  if (next < current - maxDelta) return current - maxDelta;
  return next;
}

/** Result of one {@link PricePoster.tick}. */
export type PosterResult =
  | { action: 'skipped'; reason: string }
  | { action: 'dry_run'; priceE18: bigint; keepAlive: boolean }
  | { action: 'posted'; priceE18: bigint; txHash: Hex; keepAlive: boolean }
  | { action: 'failed'; error: string };

/**
 * `true` when the on-chain quote (last updated at `updatedAt`, seconds) will be older than
 * `maxPriceAge` before two more post intervals pass — i.e. it must be refreshed now even if unchanged.
 */
export function needsKeepAlive(nowSec: number, updatedAt: number, maxPriceAge: number, postIntervalMs: number): boolean {
  if (updatedAt <= 0 || maxPriceAge <= 0) return false;
  const lead = 2 * Math.ceil(postIntervalMs / 1000);
  return nowSec - updatedAt >= Math.max(0, maxPriceAge - lead);
}

/** The poster. */
export class PricePoster {
  private readonly now: () => number;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(
    private readonly repos: Repos,
    private readonly reader: ChainReader,
    private readonly writer: ChainWriter | undefined,
    private readonly options: PosterOptions,
    private readonly logger: Logger,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Fetches the feed price as `priceE18`. */
  async fetchFeedPrice(): Promise<bigint> {
    const res = await this.fetchImpl(this.options.feedUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`price feed HTTP ${res.status}`);
    const json = (await res.json()) as { priceUsd?: unknown };
    const price = typeof json.priceUsd === 'string' ? Number(json.priceUsd) : json.priceUsd;
    if (typeof price !== 'number') throw new Error('price feed lacks a numeric priceUsd');
    return usdToPriceE18(price);
  }

  /** One attempt. */
  async tick(): Promise<PosterResult> {
    let target: bigint;
    try {
      target = await this.fetchFeedPrice();
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.warn('poster: feed fetch failed', { error });
      return { action: 'failed', error };
    }
    let current: { priceE18: bigint; updatedAt: number };
    let bounds: { maxStepBps: number; minInterval: number };
    let maxPriceAge: number;
    try {
      [current, bounds, maxPriceAge] = await Promise.all([this.reader.latestPrice(), this.reader.priceSourceBounds(), this.reader.maxPriceAge()]);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { action: 'failed', error };
    }
    const nowSec = Math.floor(this.now() / 1000);
    if (current.priceE18 !== 0n && nowSec < current.updatedAt + bounds.minInterval) return { action: 'skipped', reason: 'within minInterval' };
    const next = clampStep(current.priceE18, target, bounds.maxStepBps);
    const keepAlive = current.priceE18 !== 0n && needsKeepAlive(nowSec, current.updatedAt, maxPriceAge, this.options.postIntervalMs ?? 300_000);
    if (current.priceE18 !== 0n && !keepAlive) {
      const delta = next > current.priceE18 ? next - current.priceE18 : current.priceE18 - next;
      if (delta * 10_000n < current.priceE18 * BigInt(this.options.minChangeBps ?? 50)) return { action: 'skipped', reason: 'change below 0.5%' };
    }
    if (keepAlive) this.logger.info('poster: keep-alive post (on-chain quote about to go stale)', { updatedAt: current.updatedAt, maxPriceAge, priceE18: next });
    if (this.writer === undefined || this.options.dryRun) {
      this.logger.info('poster: dry run', { priceE18: next, target, current: current.priceE18, keepAlive });
      return { action: 'dry_run', priceE18: next, keepAlive };
    }
    const id = this.repos.pricePosts.insert({ priceE18: next, source: this.options.feedUrl, txHash: null, status: 'pending', createdAt: this.now() });
    try {
      const txHash = await this.writer.postPrice(next);
      this.repos.pricePosts.setStatus(id, 'sent', txHash);
      this.logger.info('poster: price posted', { priceE18: next, txHash, keepAlive });
      return { action: 'posted', priceE18: next, txHash, keepAlive };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.repos.pricePosts.setStatus(id, `failed: ${error.slice(0, 200)}`, null);
      this.logger.error('poster: post failed', { error });
      return { action: 'failed', error };
    }
  }
}

/** Parses `--usd` style input for the CLI (`post-price --usd 0.01`). */
export function usdStringToPriceE18(input: string): bigint {
  const micro = parseUsdToMicro(input);
  if (micro <= 0n) throw new RangeError('price must be positive');
  return micro * 10n ** 12n;
}
