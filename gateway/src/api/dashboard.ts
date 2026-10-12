/**
 * Dashboard API (SPEC §5.9): auth (SIWS, sessions), keys, balance, usage, ledger, receipts, BYOK
 * providers, budgets (SPL delegation), upgrades, models, price + history, quote, status, config.
 * JSON with decimal-string money; errors `{ error: { code, message } }`.
 *
 * @module api/dashboard
 */
import {
  CreateApiKeyRequestSchema,
  CursorQuerySchema,
  PriceHistoryQuerySchema,
  PutProviderKeyRequestSchema,
  QuoteQuerySchema,
  RegisterBudgetRequestSchema,
  UpgradeRequestSchema,
  UsageQuerySchema,
  UsageWindowSchema,
  VerifyRequestSchema,
  type BudgetDtoWire,
} from '@beagle/shared/api';
import { BYOK_PROVIDERS, type ByokProvider } from '@beagle/shared/models';
import { isBase58Pubkey } from '@beagle/shared/solana';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { uuid } from '../auth/crypto.js';
import { sessionCookie } from '../auth/session.js';
import { BudgetRegisterError } from '../chain/budgets.js';
import type { BudgetRow } from '../db/repos.js';
import { buildReceipt } from '../metering/receipts.js';
import { InsufficientCreditError } from '../metering/reserve.js';
import { UpgradeInputError, UpgradeService } from '../upgrades/plans.js';
import type { Services } from '../services.js';
import type { InternalRequest } from '../translate/internal.js';
import { ProviderError } from '../providers/types.js';
import { UnsafeBaseUrlError } from '../providers/registry.js';
import { principalOf, requireSession, type AppEnv } from './auth.js';
import { apiKeyDto, balanceDto, budgetDrawDto, budgetDto, configDto, creditEventDto, ledgerRowDto, meDto, modelsDto, providerKeyDto, statusDto, usageListDto, usageSummaryDto } from './dto.js';
import { ApiError } from './errors.js';

/** Active API keys a workspace may hold (`POST /api/keys` → 400 `too_many_keys` beyond it). */
export const MAX_ACTIVE_KEYS = 50;

/** Drops empty-string query values (`?model=&status=`), which mean "no filter" (SPEC §5.9). */
export function nonEmptyQuery(query: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''));
}

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (e) {
    throw new ApiError(400, 'invalid_json', `invalid JSON body: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Parses with `schema` or throws a 400 `invalid_request`. */
export function parseOr400<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue === undefined ? '' : issue.path.map(String).join('.');
    throw new ApiError(400, 'invalid_request', issue === undefined ? 'invalid request' : path === '' ? issue.message : `${path}: ${issue.message}`);
  }
  return r.data;
}

function byokProvider(raw: string): ByokProvider {
  if (!(BYOK_PROVIDERS as readonly string[]).includes(raw)) throw new ApiError(400, 'invalid_provider', `provider must be one of ${BYOK_PROVIDERS.join(', ')}`);
  return raw as ByokProvider;
}

/**
 * `POST /api/budgets/register` (SPEC §3.4, §5.9), shared with the MCP in-process api: validates the
 * account on chain (mint, delegate = operator → 400 `not_delegated`), lets only the token account
 * owner choose another `workspace` to fund (403 `not_owner` otherwise) and returns the budget.
 */
export async function registerBudget(services: Services, principalWorkspace: string, tokenAccount: string, workspace?: string): Promise<BudgetDtoWire> {
  const scanner = services.budgets;
  if (scanner === undefined) throw new ApiError(503, 'chain_unavailable', 'This gateway has no chain access configured; budgets are disabled.');
  let state;
  try {
    state = await scanner.inspect(tokenAccount);
  } catch (e) {
    if (e instanceof BudgetRegisterError) throw new ApiError(400, e.code === 'not_delegated' ? 'not_delegated' : 'invalid_token_account', e.message);
    throw e;
  }
  if (workspace !== undefined && workspace !== state.owner && state.owner !== principalWorkspace) {
    throw new ApiError(403, 'not_owner', 'only the token account owner may fund another workspace with it');
  }
  const row = scanner.applyState(state, undefined, { registeredAt: services.now(), ...(workspace === undefined ? {} : { workspace }) });
  services.logger.info('budget registered', { tokenAccount, owner: row.owner, workspace: row.workspace, by: principalWorkspace });
  return budgetDto(services, row);
}

/** `GET /api/budgets[/:tokenAccount]`: the budgets that fund `workspace` plus those its wallet delegated. */
export function budgetsOf(services: Services, workspace: string): BudgetRow[] {
  const seen = new Set<string>();
  const out: BudgetRow[] = [];
  for (const row of [...services.repos.budgets.list(workspace), ...services.repos.budgets.listByOwner(workspace)]) {
    if (seen.has(row.tokenAccount)) continue;
    seen.add(row.tokenAccount);
    out.push(row);
  }
  return out;
}

/** Mounts the dashboard routes. */
export function mountDashboard(app: Hono<AppEnv>, services: Services): void {
  const secureCookie = services.config.server.publicUrl.startsWith('https:');

  // ---- auth ----------------------------------------------------------------------------------
  app.get('/api/auth/nonce', (c) => c.json({ nonce: services.siws.issueNonce() }));

  app.post('/api/auth/verify', async (c) => {
    const body = parseOr400(VerifyRequestSchema, await readJson(c));
    const result = services.siws.verify(body.message, body.signature, body.publicKey);
    if (!result.ok) throw new ApiError(401, `siws_${result.code}`, result.message);
    const workspace = result.address;
    services.repos.workspaces.ensure(workspace, services.now());
    const { token } = services.sessions.create(workspace);
    c.header('set-cookie', sessionCookie(token, secureCookie));
    return c.json({ token, workspace });
  });

  app.post('/api/auth/logout', requireSession(services), (c) => {
    const p = principalOf(c);
    if (p.kind === 'session') services.sessions.destroy(p.sessionToken);
    c.header('set-cookie', sessionCookie(null, secureCookie));
    return c.json({ ok: true });
  });

  app.get('/api/me', requireSession(services), (c) => {
    const ws = services.repos.workspaces.ensure(principalOf(c).workspace, services.now());
    return c.json(meDto(services, ws));
  });

  app.get('/api/balance', requireSession(services, true), (c) => c.json(balanceDto(services, principalOf(c).workspace)));

  // ---- API keys ------------------------------------------------------------------------------
  app.get('/api/keys', requireSession(services), (c) => c.json(services.apiKeys.list(principalOf(c).workspace).map((k) => apiKeyDto(k))));

  app.post('/api/keys', requireSession(services), async (c) => {
    const raw = c.req.header('content-length') === '0' || c.req.header('content-type') === undefined ? {} : await readJson(c);
    const body = parseOr400(CreateApiKeyRequestSchema, raw ?? {});
    const workspace = principalOf(c).workspace;
    if (services.repos.apiKeys.countByWorkspace(workspace) >= MAX_ACTIVE_KEYS) {
      throw new ApiError(400, 'too_many_keys', `a workspace may hold at most ${MAX_ACTIVE_KEYS} active API keys; revoke one first`);
    }
    const created = services.apiKeys.create(workspace, body.name);
    return c.json({ id: created.id, key: created.key, prefix: created.prefix, name: created.name, createdAt: created.createdAt, lastUsedAt: null }, 201);
  });

  app.delete('/api/keys/:id', requireSession(services), (c) => {
    const ok = services.apiKeys.revoke(c.req.param('id'), principalOf(c).workspace);
    if (!ok) throw new ApiError(404, 'not_found', 'unknown or already revoked key');
    return c.json({ ok: true });
  });

  // ---- usage / ledger / receipts -------------------------------------------------------------
  app.get('/api/usage', requireSession(services, true), (c) => {
    const q = parseOr400(UsageQuerySchema, nonEmptyQuery(c.req.query()));
    return c.json(
      usageListDto(services, principalOf(c).workspace, {
        limit: q.limit,
        ...(q.before === undefined ? {} : { before: q.before }),
        ...(q.model === undefined ? {} : { model: q.model }),
        ...(q.status === undefined ? {} : { status: q.status }),
      }),
    );
  });

  app.get('/api/usage/summary', requireSession(services, true), (c) => {
    const window = parseOr400(UsageWindowSchema.default('24h'), c.req.query('window'));
    return c.json(usageSummaryDto(services, principalOf(c).workspace, window));
  });

  app.get('/api/ledger', requireSession(services), (c) => {
    const q = parseOr400(CursorQuerySchema, nonEmptyQuery(c.req.query()));
    const rows = services.repos.ledger.list(principalOf(c).workspace, q.limit, q.before);
    const last = rows[rows.length - 1];
    return c.json({ rows: rows.map(ledgerRowDto), nextBefore: rows.length === q.limit && last !== undefined ? last.createdAt : null });
  });

  app.get('/api/receipts', requireSession(services, true), (c) => {
    const q = parseOr400(CursorQuerySchema, nonEmptyQuery(c.req.query()));
    const rows = services.repos.creditEvents.list(principalOf(c).workspace, q.limit, q.before);
    const last = rows[rows.length - 1];
    return c.json({ rows: rows.map((r) => creditEventDto(services, r)), nextBefore: rows.length === q.limit && last !== undefined ? last.createdAt : null });
  });

  app.get('/api/receipts/:requestId', requireSession(services, true), (c) => {
    const row = services.repos.usage.getForWorkspace(c.req.param('requestId'), principalOf(c).workspace);
    if (row === undefined) throw new ApiError(404, 'not_found', 'unknown request id');
    const built = buildReceipt(row);
    if (built === undefined) throw new ApiError(404, 'receipt_unavailable', 'this request was not served by a model, so it has no receipt');
    return c.json({ receipt: built.receipt, hash: built.hash });
  });

  // ---- BYOK providers ------------------------------------------------------------------------
  app.get('/api/providers', requireSession(services), (c) => c.json(services.repos.providerKeys.list(principalOf(c).workspace).map(providerKeyDto)));

  app.put('/api/providers/:provider', requireSession(services), async (c) => {
    const provider = byokProvider(c.req.param('provider'));
    const body = parseOr400(PutProviderKeyRequestSchema, await readJson(c));
    if (services.keyring === undefined) throw new ApiError(503, 'byok_disabled', 'KEYRING_MASTER_KEY is not configured; BYOK is disabled on this gateway');
    let baseUrl: string | null = null;
    if (body.baseUrl !== undefined) {
      try {
        await services.registry.validateBaseUrl(body.baseUrl);
      } catch (e) {
        if (e instanceof UnsafeBaseUrlError) throw new ApiError(400, 'unsafe_base_url', e.message);
        throw e;
      }
      baseUrl = body.baseUrl.replace(/\/+$/, '');
    }
    const workspace = principalOf(c).workspace;
    const enc = services.keyring.encrypt(body.apiKey, workspace, provider);
    services.repos.providerKeys.upsert({ id: `pk_${uuid()}`, workspace, provider, ciphertext: enc.ciphertext, iv: enc.iv, tag: enc.tag, last4: body.apiKey.slice(-4), baseUrl, createdAt: services.now() });
    const row = services.repos.providerKeys.get(workspace, provider);
    return c.json(row === undefined ? { ok: true } : providerKeyDto(row));
  });

  app.delete('/api/providers/:provider', requireSession(services), (c) => {
    const provider = byokProvider(c.req.param('provider'));
    if (!services.repos.providerKeys.delete(principalOf(c).workspace, provider)) throw new ApiError(404, 'not_found', 'no key stored for this provider');
    return c.json({ ok: true });
  });

  app.post('/api/providers/:provider/test', requireSession(services), async (c) => {
    const provider = byokProvider(c.req.param('provider'));
    const workspace = principalOf(c).workspace;
    const creds = await services.registry.byokCredentials(provider, workspace);
    if (creds === undefined) throw new ApiError(404, 'not_found', 'no key stored for this provider');
    const model = services.catalog.filter((m) => m.provider === provider && m.autoEligible).sort((a, b) => a.price.inputPerM + a.price.outputPerM - (b.price.inputPerM + b.price.outputPerM))[0];
    if (model === undefined) throw new ApiError(404, 'no_model', 'no catalog model for this provider');
    const req: InternalRequest = {
      upstreamModel: model.upstreamId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ok' }] }],
      maxTokens: 8,
      stream: false,
      metadata: { requestId: `test_${uuid()}`, workspace },
    };
    const started = services.now();
    try {
      await services.registry.adapter(provider).complete(req, creds, AbortSignal.timeout(30_000));
      services.repos.providerKeys.setLastError(workspace, provider, null);
      return c.json({ ok: true, model: model.id, latencyMs: services.now() - started, error: null });
    } catch (e) {
      const message = ProviderError.is(e) ? `${e.code} (${e.status}): ${e.message}` : e instanceof Error ? e.message : String(e);
      if (ProviderError.is(e) && e.authFailure) services.repos.providerKeys.setLastError(workspace, provider, message.slice(0, 200));
      return c.json({ ok: false, model: model.id, latencyMs: services.now() - started, error: message });
    }
  });

  // ---- budgets (SPL delegation) --------------------------------------------------------------
  app.get('/api/budgets', requireSession(services, true), (c) => c.json(budgetsOf(services, principalOf(c).workspace).map((b) => budgetDto(services, b))));

  app.post('/api/budgets/register', requireSession(services, true), async (c) => {
    const body = parseOr400(RegisterBudgetRequestSchema, await readJson(c));
    return c.json(await registerBudget(services, principalOf(c).workspace, body.tokenAccount, body.workspace), 201);
  });

  const budgetOf = (c: Context<AppEnv>): BudgetRow => {
    const tokenAccount = c.req.param('tokenAccount');
    const row = isBase58Pubkey(tokenAccount) ? services.repos.budgets.get(tokenAccount) : undefined;
    const ws = principalOf(c).workspace;
    if (row === undefined || (row.workspace !== ws && row.owner !== ws)) throw new ApiError(404, 'not_found', 'unknown budget');
    return row;
  };
  app.get('/api/budgets/:tokenAccount', requireSession(services, true), (c) => c.json(budgetDto(services, budgetOf(c))));
  app.get('/api/budgets/:tokenAccount/draws', requireSession(services, true), (c) => c.json(services.repos.budgetDraws.listByTokenAccount(budgetOf(c).tokenAccount).map(budgetDrawDto)));

  // ---- upgrades ------------------------------------------------------------------------------
  app.get('/api/upgrades/prices', (c) => c.json(services.upgrades.prices()));
  app.get('/api/upgrades', requireSession(services, true), (c) => c.json(services.upgrades.list(principalOf(c).workspace).map(UpgradeService.toDto)));
  app.post('/api/upgrades', requireSession(services, true), async (c) => {
    const body = parseOr400(UpgradeRequestSchema, await readJson(c));
    try {
      return c.json(UpgradeService.toDto(services.upgrades.purchase(principalOf(c).workspace, body.kind, body.quantity)), 201);
    } catch (e) {
      if (e instanceof InsufficientCreditError) {
        throw new ApiError(402, 'insufficient_credit', e.message, { 'x-beagle-balance-micro': e.balanceMicro.toString(), 'x-beagle-credits-url': `${services.config.server.webOrigins[0] ?? ''}/app/credits` });
      }
      if (e instanceof UpgradeInputError) throw new ApiError(400, 'invalid_request', e.message);
      throw e;
    }
  });

  // ---- public --------------------------------------------------------------------------------
  app.get('/api/models', (c) => c.json(modelsDto(services)));
  app.get('/api/price', (c) => c.json(services.price.priceDto()));
  app.get('/api/price/history', (c) => {
    const q = parseOr400(PriceHistoryQuerySchema, nonEmptyQuery(c.req.query()));
    return c.json(services.price.historyDto(q.limit));
  });
  app.get('/api/quote', (c) => {
    const q = parseOr400(QuoteQuerySchema, c.req.query());
    return c.json(services.price.quote({ ...(q.tokens === undefined ? {} : { tokens: q.tokens }), ...(q.usdMicro === undefined ? {} : { usdMicro: q.usdMicro }) }));
  });
  app.get('/api/status', (c) => c.json(statusDto(services)));
  app.get('/api/config', (c) => c.json(configDto(services)));
}
