/**
 * MCP over HTTP (SPEC §5.10): `/mcp` mounts `createBeagleMcpServer` from `@beagle/mcp` on the SDK's
 * web-standard Streamable HTTP transport in stateless mode (no session ids, JSON responses), one
 * server + transport per request, API-key auth → workspace, and an in-process `BeagleApi` bound to
 * that workspace. Wallet tools return unsigned transaction requests (no agent key on the server).
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
} from '@beagle/shared/api';
import { BeagleApiError, createBeagleMcpServer, type BeagleApi, type BeagleChatCompletion } from '@beagle/mcp';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Hono } from 'hono';
import { z } from 'zod';
import { uuid } from '../auth/crypto.js';
import { InsufficientCreditError } from '../metering/reserve.js';
import type { Services } from '../services.js';
import { fromOpenAI } from '../translate/fromOpenAI.js';
import { toChatCompletion } from '../translate/toOpenAI.js';
import { UpgradeInputError, UpgradeService } from '../upgrades/plans.js';
import { authenticateKey, type AppEnv } from './auth.js';
import { balanceDto, budgetDto, configDto, modelsDto, statusDto, usageListDto, usageSummaryDto } from './dto.js';
import { ApiError, GatewayError } from './errors.js';
import { checkRateLimit } from './ratelimit.js';

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new BeagleApiError(500, 'invalid_response', `${what}: ${z.prettifyError(r.error)}`);
  return r.data;
}

function toApiError(e: unknown): BeagleApiError {
  if (BeagleApiError.is(e)) return e;
  if (GatewayError.is(e)) return new BeagleApiError(e.status, e.code, e.message);
  if (ApiError.is(e)) return new BeagleApiError(e.status, e.code, e.message);
  if (e instanceof InsufficientCreditError) return new BeagleApiError(402, 'insufficient_credit', e.message);
  if (e instanceof UpgradeInputError) return new BeagleApiError(400, 'invalid_request', e.message);
  return new BeagleApiError(500, 'internal_error', e instanceof Error ? e.message : String(e));
}

/** Builds the in-process `BeagleApi` for `workspace` (SPEC §6.2, calling the services directly). */
export function createInProcessBeagleApi(services: Services, workspace: string, apiKeyId: string | null, plan: 'free' | 'pro'): BeagleApi {
  const guard = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw toApiError(e);
    }
  };
  return {
    balance: () => guard(async () => parse(BalanceDtoSchema, await balanceDto(services, workspace), 'balance')),
    models: () => guard(() => parse(ModelsDtoSchema, modelsDto(services, plan, services.registry.byokProviders(workspace)), 'models').models),
    quote: (q) => guard(async () => parse(QuoteDtoSchema, await services.price.quote(q), 'quote')),
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
        if (outcome.kind === 'error') throw new BeagleApiError(outcome.error.status, outcome.error.code, outcome.error.message);
        if (outcome.kind !== 'response') throw new BeagleApiError(500, 'internal_error', 'unexpected streaming outcome');
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
    budgets: () => guard(() => services.repos.budgets.list(workspace).map((b) => parse(BudgetDtoSchema, budgetDto(services, b), 'budget'))),
    upgrade: (kind, quantity) => guard(() => parse(UpgradeDtoSchema, UpgradeService.toDto(services.upgrades.purchase(workspace, kind, quantity)), 'upgrade')),
    status: () => guard(() => parse(StatusDtoSchema, statusDto(services), 'status')),
    config: () => guard(() => parse(ConfigDtoSchema, configDto(services), 'config')),
  };
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
    const api = createInProcessBeagleApi(services, principal.workspace, principal.apiKeyId, principal.plan);
    const server = createBeagleMcpServer(api, { workspace: principal.workspace as `0x${string}`, apiUrl: services.config.server.publicUrl });
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
