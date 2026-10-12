/**
 * MCP over HTTP (SPEC §5.10): `/mcp` mounts `createBeagleMcpServer` from `@beagle/mcp` on the SDK's
 * web-standard Streamable HTTP transport in stateless mode (no session ids, JSON responses), one
 * server + transport per request, API-key auth → workspace, and an in-process `BeagleApi` bound to
 * that workspace (plus `registerBudget`, SPEC §6.2). Wallet tools return unsigned transaction
 * requests (no agent key on the server).
 *
 * `@beagle/mcp` is loaded lazily on the first `/mcp` request so a broken or missing MCP build never
 * takes the inference and dashboard routes down with it.
 *
 * @module api/mcp
 */
import {
  BalanceDtoSchema,
  BudgetDtoSchema,
  ConfigDtoSchema,
  ModelsDtoSchema,
  QuoteDtoSchema,
  StatusDtoSchema,
  UpgradeDtoSchema,
  UsageListDtoSchema,
  UsageSummaryDtoSchema,
  CreditEventListDtoSchema,
  PriceDtoSchema,
  PriceHistoryDtoSchema,
} from '@beagle/shared/api';
import type { BeagleApi, BeagleChatCompletion } from '@beagle/mcp';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Hono } from 'hono';
import { z } from 'zod';
import { uuid } from '../auth/crypto.js';
import type { Logger } from '../log.js';
import { InsufficientCreditError } from '../metering/reserve.js';
import type { Services } from '../services.js';
import { fromOpenAI } from '../translate/fromOpenAI.js';
import { toChatCompletion } from '../translate/toOpenAI.js';
import { UpgradeInputError, UpgradeService } from '../upgrades/plans.js';
import { authenticateKey, type AppEnv } from './auth.js';
import { budgetsOf, registerBudget } from './dashboard.js';
import { balanceDto, budgetDto, configDto, creditEventDto, modelsDto, statusDto, usageListDto, usageSummaryDto } from './dto.js';
import { ApiError, GatewayError } from './errors.js';
import { checkRateLimit } from './ratelimit.js';

/**
 * The error the in-process api throws: shaped like `@beagle/mcp`'s `BeagleApiError` (`name`,
 * `status`, `code`) so the MCP server's duck-typed `BeagleApiError.is` recognises it.
 */
export class InProcessApiError extends Error {
  override readonly name = 'BeagleApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  static is(e: unknown): e is InProcessApiError {
    return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'BeagleApiError' && typeof (e as { code?: unknown }).code === 'string' && typeof (e as { status?: unknown }).status === 'number';
  }
}

/** Thrown when a DTO fails its own schema (a gateway bug; details go to the log, not the caller). */
class InvalidResponseError extends Error {
  override readonly name = 'InvalidResponseError';
  constructor(
    readonly what: string,
    readonly details: string,
  ) {
    super(`${what}: response failed validation`);
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new InvalidResponseError(what, z.prettifyError(r.error));
  return r.data;
}

/**
 * Maps a thrown value onto the tool-result error. Like `GatewayError.from`, unknown errors (SQLite
 * text, TypeErrors, DTO validation paths) are masked as `Internal error.` and logged with the
 * request context instead of being serialised to the API-key holder.
 */
export function toApiError(e: unknown, logger?: Logger): InProcessApiError {
  if (e instanceof InProcessApiError) return e;
  if (InProcessApiError.is(e)) return new InProcessApiError(e.status, e.code, e.message);
  if (GatewayError.is(e)) return new InProcessApiError(e.status, e.code, e.message);
  if (ApiError.is(e)) return new InProcessApiError(e.status, e.code, e.message);
  if (e instanceof InsufficientCreditError) return new InProcessApiError(402, 'insufficient_credit', e.message);
  if (e instanceof UpgradeInputError) return new InProcessApiError(400, 'invalid_request', e.message);
  if (e instanceof InvalidResponseError) {
    logger?.error('mcp: response failed validation', { what: e.what, details: e.details });
    return new InProcessApiError(500, 'invalid_response', 'Internal error.');
  }
  logger?.error('mcp: unhandled error', { error: e });
  return new InProcessApiError(500, 'internal_error', 'Internal error.');
}

/** Builds the in-process `BeagleApi` for `workspace` (SPEC §6.2, calling the services directly). */
export function createInProcessBeagleApi(services: Services, workspace: string, apiKeyId: string | null, plan: 'free' | 'pro'): BeagleApi {
  const log = services.logger.child({ workspace });
  const guard = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw toApiError(e, log);
    }
  };
  return {
    balance: () => guard(() => parse(BalanceDtoSchema, balanceDto(services, workspace), 'balance')),
    models: () => guard(() => parse(ModelsDtoSchema, modelsDto(services, plan, services.registry.byokProviders(workspace)), 'models').models),
    quote: (q) => guard(() => parse(QuoteDtoSchema, services.price.quote(q), 'quote')),
    complete: (req, options) =>
      guard(async () => {
        const requestId = `req_${uuid()}`;
        const base = fromOpenAI({ ...req, stream: false });
        const outcome = await services.executor.execute({
          requestId,
          workspace,
          apiKeyId,
          endpoint: 'mcp',
          requestedModel: req.model,
          base,
          ...(options?.difficulty === undefined ? {} : { difficultyOverride: options.difficulty }),
          ...(options?.fallback === undefined ? {} : { fallbackOverride: options.fallback }),
        });
        if (outcome.kind === 'error') throw new InProcessApiError(outcome.error.status, outcome.error.code, outcome.error.message);
        if (outcome.kind !== 'response') throw new InProcessApiError(500, 'internal_error', 'unexpected streaming outcome');
        const completion = toChatCompletion(outcome.response, { id: requestId, created: Math.floor(services.now() / 1000), model: outcome.meta.model.id });
        const result: BeagleChatCompletion = {
          ...completion,
          beagle: {
            requestId,
            model: outcome.meta.model.id,
            provider: outcome.meta.model.provider,
            paidBy: outcome.meta.paidBy,
            costMicro: outcome.settlement.chargedMicro,
            balanceMicro: outcome.settlement.balanceMicro,
            route: outcome.meta.routeReasons,
          },
        };
        return result;
      }),
    usage: (q) =>
      guard(() => ({
        rows: parse(UsageListDtoSchema, usageListDto(services, workspace, { limit: q.limit ?? 50 }), 'usage').rows,
        summary: parse(UsageSummaryDtoSchema, usageSummaryDto(services, workspace, q.window ?? '24h'), 'usage summary'),
      })),
    budgets: () => guard(() => budgetsOf(services, workspace).map((b) => parse(BudgetDtoSchema, budgetDto(services, b), 'budget'))),
    registerBudget: (req) => guard(async () => parse(BudgetDtoSchema, await registerBudget(services, workspace, req.tokenAccount, req.workspace), 'budget')),
    upgrade: (kind, quantity) => guard(() => parse(UpgradeDtoSchema, UpgradeService.toDto(services.upgrades.purchase(workspace, kind, quantity)), 'upgrade')),
    status: () => guard(() => parse(StatusDtoSchema, statusDto(services), 'status')),
    config: () => guard(() => parse(ConfigDtoSchema, configDto(services), 'config')),
    price: () => guard(() => parse(PriceDtoSchema, services.price.priceDto(), 'price')),
    priceHistory: (q) => guard(() => parse(PriceHistoryDtoSchema, services.price.historyDto(Math.min(1000, Math.max(1, q?.limit ?? 100))), 'price history')),
    receipts: (q) =>
      guard(() => {
        const limit = Math.min(200, Math.max(1, q?.limit ?? 50));
        const rows = services.repos.creditEvents.list(workspace, limit, q?.before);
        const last = rows[rows.length - 1];
        return parse(CreditEventListDtoSchema, { rows: rows.map((r) => creditEventDto(services, r)), nextBefore: rows.length === limit && last !== undefined ? last.createdAt : null }, 'receipts');
      }),
  };
}

type McpModule = typeof import('@beagle/mcp');
let mcpModule: Promise<McpModule> | undefined;

/** Loads `@beagle/mcp` once (lazily: a broken MCP build must not take the whole gateway down). */
function loadMcp(): Promise<McpModule> {
  mcpModule ??= import('@beagle/mcp').catch((e: unknown) => {
    mcpModule = undefined;
    throw e;
  });
  return mcpModule;
}

/** Mounts `/mcp`. */
export function mountMcp(app: Hono<AppEnv>, services: Services): void {
  app.all('/mcp', async (c) => {
    const principal = authenticateKey(services, c.req.raw.headers);
    if (principal === undefined || principal.kind !== 'key') {
      return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: send Authorization: Bearer bgl_… (a Beagle API key)' }, id: null }, 401);
    }
    if (c.req.method !== 'POST') {
      return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this endpoint is stateless; use POST' }, id: null }, 405, { allow: 'POST' });
    }
    try {
      checkRateLimit(services, principal.apiKeyId, principal.plan);
    } catch (e) {
      if (GatewayError.is(e)) return c.json({ jsonrpc: '2.0', error: { code: -32000, message: e.message }, id: null }, 429, e.headers);
      throw e;
    }
    let mcp: McpModule;
    try {
      mcp = await loadMcp();
    } catch (e) {
      services.logger.error('mcp: @beagle/mcp failed to load', { error: e });
      return c.json({ jsonrpc: '2.0', error: { code: -32603, message: 'MCP server unavailable on this gateway.' }, id: null }, 503);
    }
    const api = createInProcessBeagleApi(services, principal.workspace, principal.apiKeyId, principal.plan);
    const server = mcp.createBeagleMcpServer(api, { workspace: principal.workspace, apiUrl: services.config.server.publicUrl, rpcUrl: services.chainInfo.publicRpcUrl });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(c.req.raw);
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, headers: response.headers });
    } finally {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    }
  });
}
