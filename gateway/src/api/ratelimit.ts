/**
 * Fixed-window rate limits (SPEC §5.7, §9): per API key on inference and MCP (`RATE_LIMIT_RPM`,
 * `_PRO` on the pro plan); the same window per principal (key, or session workspace) on the
 * mutating / I/O-triggering dashboard routes; and per client IP on the unauthenticated SIWS routes
 * (`AUTH_RATE_LIMIT_RPM`, `X-Forwarded-For` honoured only with `TRUST_PROXY`). 429 `rate_limited`
 * with `Retry-After`.
 *
 * @module api/ratelimit
 */
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import type { Services } from '../services.js';
import type { AppEnv } from './auth.js';
import { GatewayError } from './errors.js';

/** Window length. */
export const RATE_WINDOW_MS = 60_000;

/** Counts one request under `key` against `limit` per window; throws the 429 when over it. */
export function checkWindow(services: Services, key: string, limit: number): { remaining: number } {
  const now = services.now();
  const { count, windowStart } = services.repos.rateLimits.hit(key, now, RATE_WINDOW_MS);
  if (count > limit) {
    const retryAfterSec = Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000));
    throw new GatewayError('rate_limited', `Rate limit of ${limit} requests per minute exceeded.`, { retryAfterSec });
  }
  return { remaining: limit - count };
}

/** The plan's per-minute limit. */
function planLimit(services: Services, plan: 'free' | 'pro'): number {
  return plan === 'pro' ? services.config.economics.rateLimitRpmPro : services.config.economics.rateLimitRpm;
}

/** Checks and counts one request for `apiKeyId`; throws the 429 when over the limit. */
export function checkRateLimit(services: Services, apiKeyId: string, plan: 'free' | 'pro'): { remaining: number } {
  return checkWindow(services, apiKeyId, planLimit(services, plan));
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

/**
 * Per-principal limit for dashboard routes that do work (chain reads, outbound provider calls,
 * writes): a key shares its inference window, a session counts per workspace. Mount after the auth
 * middleware.
 */
export function principalRateLimit(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get('principal');
    if (principal !== undefined) {
      const key = principal.kind === 'key' ? principal.apiKeyId : `ws:${principal.workspace}`;
      const { remaining } = checkWindow(services, key, planLimit(services, principal.plan));
      c.header('x-ratelimit-remaining', String(remaining));
    }
    await next();
  };
}

/** The client address: the first `X-Forwarded-For` entry when `TRUST_PROXY`, else the socket peer; `unknown` when neither is available. */
export function clientIp(c: Context<AppEnv>, trustProxy: boolean): string {
  if (trustProxy) {
    const first = c.req
      .header('x-forwarded-for')
      ?.split(',')[0]
      ?.trim();
    if (first !== undefined && first !== '') return first;
  }
  try {
    const address = getConnInfo(c).remote.address;
    if (typeof address === 'string' && address !== '') return address;
  } catch {
    // not running under @hono/node-server (tests): no socket to ask
  }
  return 'unknown';
}

/** Per-IP limit (`AUTH_RATE_LIMIT_RPM`) for the unauthenticated SIWS routes. */
export function ipRateLimit(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    checkWindow(services, `ip:${clientIp(c, services.config.server.trustProxy)}`, services.config.economics.authRateLimitRpm);
    await next();
  };
}
