/**
 * Per-key fixed-window rate limit (SPEC §5.7): `RATE_LIMIT_RPM` (`_PRO` on the pro plan); 429
 * `rate_limited` with `Retry-After`.
 *
 * @module api/ratelimit
 */
import type { MiddlewareHandler } from 'hono';
import type { Services } from '../services.js';
import type { AppEnv } from './auth.js';
import { GatewayError } from './errors.js';

/** Window length. */
export const RATE_WINDOW_MS = 60_000;

/** Checks and counts one request for `apiKeyId`; throws the 429 when over the limit. */
export function checkRateLimit(services: Services, apiKeyId: string, plan: 'free' | 'pro'): { remaining: number } {
  const limit = plan === 'pro' ? services.config.economics.rateLimitRpmPro : services.config.economics.rateLimitRpm;
  const now = services.now();
  const { count, windowStart } = services.repos.rateLimits.hit(apiKeyId, now, RATE_WINDOW_MS);
  if (count > limit) {
    const retryAfterSec = Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000));
    throw new GatewayError('rate_limited', `Rate limit of ${limit} requests per minute exceeded.`, { retryAfterSec });
  }
  return { remaining: limit - count };
}

/** Middleware form of {@link checkRateLimit} for key principals (sessions are not limited). */
export function rateLimit(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get('principal');
    if (principal !== undefined && principal.kind === 'key') {
      const { remaining } = checkRateLimit(services, principal.apiKeyId, principal.plan);
      c.header('x-ratelimit-remaining', String(remaining));
    }
    await next();
  };
}
