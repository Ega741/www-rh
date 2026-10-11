/**
 * The Hono application: request ids and access logs, CORS for `PUBLIC_WEB_ORIGIN`, body limits
 * (413), `/healthz`, and the inference, dashboard, admin and MCP mounts with per-area error envelopes.
 * `createApp(services)` returns an app usable with `app.request()` in tests and `serve()` in `main`.
 *
 * @module api/server
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { uuid } from '../auth/crypto.js';
import type { Services } from '../services.js';
import { mountAdmin } from './admin.js';
import type { AppEnv } from './auth.js';
import { mountDashboard } from './dashboard.js';
import { ApiError, GatewayError } from './errors.js';
import { errorResponse, mountInference } from './inference.js';
import { mountMcp } from './mcp.js';

type Flavor = 'openai' | 'anthropic' | 'api';

/** Which error envelope a path uses. */
export function flavorOf(path: string): Flavor {
  if (path.startsWith('/v1/messages')) return 'anthropic';
  if (path.startsWith('/v1/')) return 'openai';
  return 'api';
}

function render(err: GatewayError | ApiError, flavor: Flavor): Response {
  if (flavor === 'api') {
    const body = { error: { code: err.code, message: err.message } };
    return new Response(JSON.stringify(body), { status: err.status, headers: { 'content-type': 'application/json; charset=utf-8', ...err.headers } });
  }
  const g = GatewayError.is(err) ? err : new GatewayError(err.status === 401 ? 'invalid_api_key' : err.status === 404 ? 'model_not_found' : 'internal_error', err.message, { status: err.status, headers: err.headers });
  return errorResponse(g, flavor);
}

/** Builds the application. */
export function createApp(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { config, logger } = services;

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? `http_${uuid()}`;
    c.set('requestId', requestId);
    const started = services.now();
    await next();
    const ms = services.now() - started;
    const path = new URL(c.req.url).pathname;
    if (path !== '/healthz') logger.info('request', { method: c.req.method, path, status: c.res.status, ms, requestId });
  });

  const corsMiddleware = cors({
    origin: (origin) => (config.server.webOrigins.includes(origin) ? origin : null),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type', 'x-api-key', 'x-admin-token', 'x-beagle-difficulty', 'x-beagle-fallback', 'anthropic-version', 'mcp-protocol-version', 'mcp-session-id', 'accept', 'x-request-id'],
    exposeHeaders: ['x-beagle-request-id', 'x-beagle-model', 'x-beagle-provider', 'x-beagle-paid-by', 'x-beagle-cost-micro', 'x-beagle-balance-micro', 'x-beagle-route', 'x-beagle-credits-url', 'retry-after', 'x-ratelimit-remaining', 'mcp-session-id'],
    maxAge: 600,
  });
  app.use('/api/*', corsMiddleware);
  app.use('/v1/*', corsMiddleware);
  app.use('/mcp', corsMiddleware);
  app.use('/healthz', corsMiddleware);

  const tooLarge = (c: Context<AppEnv>): Response => {
    const path = new URL(c.req.url).pathname;
    const err = new GatewayError('request_too_large', `Request body exceeds ${config.server.maxBodyBytes} bytes.`);
    return render(err, flavorOf(path));
  };
  app.use('/v1/*', bodyLimit({ maxSize: config.server.maxBodyBytes, onError: tooLarge }));
  app.use('/api/*', bodyLimit({ maxSize: config.server.maxBodyBytes, onError: tooLarge }));
  app.use('/mcp', bodyLimit({ maxSize: config.server.maxBodyBytes, onError: tooLarge }));

  app.get('/healthz', (c) => c.json({ ok: true }));

  mountInference(app, services);
  mountDashboard(app, services);
  mountAdmin(app, services);
  mountMcp(app, services);

  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    const flavor = flavorOf(path);
    if (flavor === 'api') return render(new ApiError(404, 'not_found', `No route for ${c.req.method} ${path}`), 'api');
    return render(new GatewayError('invalid_request_error', `No route for ${c.req.method} ${path}`, { status: 404 }), flavor);
  });

  app.onError((err, c) => {
    const path = new URL(c.req.url).pathname;
    const flavor = flavorOf(path);
    if (err instanceof HTTPException) {
      const res = err.getResponse();
      return res;
    }
    if (GatewayError.is(err) || ApiError.is(err)) {
      if (err.status >= 500) logger.error('request failed', { path, code: err.code, error: err });
      return render(err, flavor);
    }
    const wrapped = GatewayError.from(err);
    if (wrapped.status >= 500) logger.error('unhandled error', { path, error: err, requestId: c.get('requestId') });
    return render(wrapped, flavor);
  });

  return app;
}
