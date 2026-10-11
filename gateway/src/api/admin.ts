/**
 * Admin routes (SPEC §5.9): `x-admin-token` (constant-time compare); disabled when `ADMIN_TOKEN` is
 * unset. `POST /api/admin/credit`, `POST /api/admin/price`, `GET /api/admin/workspaces`.
 *
 * @module api/admin
 */
import { AdminCreditRequestSchema, AdminPriceRequestSchema } from '@beagle/shared/api';
import type { Hono, MiddlewareHandler } from 'hono';
import { safeEqual } from '../auth/crypto.js';
import type { Services } from '../services.js';
import type { AppEnv } from './auth.js';
import { parseOr400 } from './dashboard.js';
import { adminWorkspaceDto } from './dto.js';
import { ApiError } from './errors.js';

/** Requires a valid `x-admin-token`. */
export function requireAdmin(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const expected = services.config.secrets.adminToken;
    if (expected === undefined) throw new ApiError(404, 'not_found', 'admin routes are disabled');
    const presented = c.req.header('x-admin-token') ?? '';
    if (!safeEqual(presented, expected)) throw new ApiError(401, 'unauthorized', 'bad admin token');
    await next();
  };
}

/** Mounts the admin routes. */
export function mountAdmin(app: Hono<AppEnv>, services: Services): void {
  app.use('/api/admin/*', requireAdmin(services));

  app.post('/api/admin/credit', async (c) => {
    const body = parseOr400(AdminCreditRequestSchema, await c.req.json().catch(() => ({})));
    const id = services.ledger.adjust(body.workspace, body.amountMicro, body.memo ?? null);
    return c.json({ ok: true, ledgerId: id, balanceMicro: services.ledger.balance(body.workspace).toString() });
  });

  app.post('/api/admin/price', async (c) => {
    const body = parseOr400(AdminPriceRequestSchema, await c.req.json().catch(() => ({})));
    const writer = services.chain?.writer;
    if (writer === undefined) throw new ApiError(503, 'operator_disabled', 'no operator key configured');
    if (services.config.operator.dryRun) return c.json({ ok: true, dryRun: true, priceE18: body.priceE18.toString() });
    const txHash = await writer.postPrice(body.priceE18);
    services.repos.pricePosts.insert({ priceE18: body.priceE18, source: 'admin', txHash, status: 'sent', createdAt: services.now() });
    services.price.invalidate();
    return c.json({ ok: true, txHash, priceE18: body.priceE18.toString() });
  });

  app.get('/api/admin/workspaces', (c) => c.json(services.repos.workspaces.list().map((w) => adminWorkspaceDto(services, w))));
}
