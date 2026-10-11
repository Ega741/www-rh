/**
 * Request authentication for Hono routes: API keys (`Authorization: Bearer bgl_…` / `x-api-key`) for
 * inference and MCP, sessions (cookie or bearer) for the dashboard, both for routes marked "key OK".
 *
 * @module api/auth
 */
import type { Plan } from '@beagle/shared/models';
import type { Context, MiddlewareHandler } from 'hono';
import { extractApiKey } from '../auth/apiKeys.js';
import { extractSessionToken } from '../auth/session.js';
import type { Services } from '../services.js';
import { ApiError, GatewayError } from './errors.js';

/** Who is calling. */
export type Principal = { kind: 'key'; workspace: string; apiKeyId: string; plan: Plan } | { kind: 'session'; workspace: string; sessionToken: string; plan: Plan };

/** Hono environment of the gateway app. */
export type AppEnv = { Variables: { principal: Principal; requestId: string } };

function planOf(services: Services, workspace: string): Plan {
  const row = services.repos.workspaces.get(workspace);
  return row === undefined ? 'free' : services.repos.workspaces.effectivePlan(row, services.now()).plan;
}

/** Resolves an API key principal from the headers, or `undefined`. */
export function authenticateKey(services: Services, headers: Headers): Principal | undefined {
  const presented = extractApiKey(headers);
  if (presented === undefined) return undefined;
  const auth = services.apiKeys.authenticate(presented);
  if (auth === undefined) return undefined;
  return { kind: 'key', workspace: auth.workspace, apiKeyId: auth.key.id, plan: planOf(services, auth.workspace) };
}

/** Resolves a session principal from the headers, or `undefined`. */
export function authenticateSession(services: Services, headers: Headers): Principal | undefined {
  const token = extractSessionToken(headers);
  if (token === undefined) return undefined;
  const session = services.sessions.resolve(token);
  if (session === undefined) return undefined;
  return { kind: 'session', workspace: session.workspace, sessionToken: token, plan: planOf(services, session.workspace) };
}

/** Inference / MCP auth: API key required (401 `invalid_api_key` in the caller's envelope). */
export function requireApiKey(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const hasKey = extractApiKey(c.req.raw.headers) !== undefined;
    const principal = authenticateKey(services, c.req.raw.headers);
    if (principal === undefined) {
      throw GatewayError.invalidApiKey(hasKey ? 'Invalid or revoked API key.' : 'Missing API key: send Authorization: Bearer bgl_… or x-api-key.');
    }
    c.set('principal', principal);
    await next();
  };
}

/** Dashboard auth: session required; API keys also accepted when `keyOk`. */
export function requireSession(services: Services, keyOk = false): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = authenticateSession(services, c.req.raw.headers) ?? (keyOk ? authenticateKey(services, c.req.raw.headers) : undefined);
    if (principal === undefined) throw new ApiError(401, 'unauthorized', keyOk ? 'Sign in or send an API key.' : 'Sign in first (SIWE).');
    c.set('principal', principal);
    await next();
  };
}

/** The principal set by the auth middleware. */
export function principalOf(c: Context<AppEnv>): Principal {
  return c.get('principal');
}
