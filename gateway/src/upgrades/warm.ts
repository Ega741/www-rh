/**
 * Warm hours (SPEC §5.11): the `WarmDriver` keeps the house GPU warm until a deadline. Drivers:
 * `log` (records only), `ollama` (periodic 1-token completion with `keep_alive` while warm) and
 * `http` (`POST WARM_WEBHOOK_URL { until }`). The warm window itself lives in `settings.warm_until`.
 *
 * @module upgrades/warm
 */
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';
import type { Logger } from '../log.js';

/** Keeps the house model warm until `until` (unix ms). */
export interface WarmDriver {
  readonly kind: 'log' | 'ollama' | 'http';
  ensureWarm(until: number): Promise<void>;
  /** Stops timers. */
  stop(): void;
}

/** Fetch used by the drivers (injectable). */
export type WarmFetch = (input: string, init?: RequestInit) => Promise<Response>;

const KEY_WARM_UNTIL = 'warm_until';

/** Creates the configured driver. */
export function createWarmDriver(config: Config, logger: Logger, fetchImpl: WarmFetch = (i, init) => globalThis.fetch(i, init), setTimer = setInterval, clearTimer = clearInterval): WarmDriver {
  const e = config.economics;
  switch (e.warmDriver) {
    case 'http':
      return {
        kind: 'http',
        async ensureWarm(until) {
          const url = e.warmWebhookUrl;
          if (url === undefined) return;
          try {
            const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ until }), signal: AbortSignal.timeout(10_000) });
            if (!res.ok) logger.warn('warm webhook failed', { status: res.status });
          } catch (err) {
            logger.warn('warm webhook error', { error: err });
          }
        },
        stop: () => undefined,
      };
    case 'ollama': {
      let timer: ReturnType<typeof setInterval> | undefined;
      let deadline = 0;
      const ping = async (): Promise<void> => {
        const base = config.providers.houseBaseUrl;
        if (base === undefined || Date.now() >= deadline) {
          if (timer !== undefined) clearTimer(timer);
          timer = undefined;
          return;
        }
        try {
          await fetchImpl(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(config.providers.houseApiKey ? { authorization: `Bearer ${config.providers.houseApiKey}` } : {}) },
            body: JSON.stringify({ model: config.providers.houseModelSmall, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, keep_alive: '10m' }),
            signal: AbortSignal.timeout(30_000),
          });
        } catch (err) {
          logger.warn('warm ping failed', { error: err });
        }
      };
      return {
        kind: 'ollama',
        async ensureWarm(until) {
          deadline = Math.max(deadline, until);
          if (timer === undefined) {
            timer = setTimer(() => void ping(), e.warmPingIntervalMs);
            if (typeof timer === 'object' && timer !== null && 'unref' in timer) (timer as { unref(): void }).unref();
          }
          await ping();
        },
        stop() {
          if (timer !== undefined) clearTimer(timer);
          timer = undefined;
        },
      };
    }
    default:
      return {
        kind: 'log',
        async ensureWarm(until) {
          logger.info('warm window extended', { until: new Date(until).toISOString() });
        },
        stop: () => undefined,
      };
  }
}

/** Warm window state. */
export class WarmService {
  constructor(
    private readonly repos: Repos,
    private readonly driver: WarmDriver,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Current warm deadline (unix ms) or `null` when not warm. */
  warmUntil(): number | null {
    const v = this.repos.settings.get(KEY_WARM_UNTIL);
    if (v === undefined) return null;
    const t = Number(v);
    return Number.isFinite(t) && t > this.now() ? t : null;
  }

  /** Extends the window by `hours` from `max(now, currentWarmUntil)`; returns `[startsAt, endsAt]`. */
  extend(hours: number): { startsAt: number; endsAt: number } {
    const now = this.now();
    const startsAt = Math.max(now, this.warmUntil() ?? now);
    const endsAt = startsAt + hours * 3_600_000;
    this.repos.settings.set(KEY_WARM_UNTIL, String(endsAt));
    return { startsAt, endsAt };
  }

  /** Asks the driver to keep the GPU warm until the current deadline. */
  async ensureWarm(): Promise<void> {
    const until = this.warmUntil();
    if (until !== null) await this.driver.ensureWarm(until);
  }

  /** Stops driver timers. */
  stop(): void {
    this.driver.stop();
  }
}
