/**
 * Inference API (SPEC §5.8): `POST /v1/chat/completions` (JSON + SSE), `GET /v1/models[/:id]`,
 * `POST /v1/messages` (Anthropic subset). Response headers `x-beagle-*`; streams end with the
 * `: beagle cost=<micro> balance=<micro>` comment line (and `data: [DONE]` for OpenAI).
 *
 * @module api/inference
 */
import { ALIASES, ALIAS_DESCRIPTIONS, isAlias } from '@beagle/shared/models';
import type { FallbackPolicy } from '@beagle/shared/routing';
import { ChatCompletionRequestSchema, formatSseBeagleTrailer, formatSseData, SSE_DONE, type OpenAiModel } from '@beagle/shared/openai';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { uuid } from '../auth/crypto.js';
import type { ExecMeta, ExecuteOutcome } from '../router/execute.js';
import type { Services } from '../services.js';
import { AnthropicMessagesRequestSchema, fromAnthropic } from '../translate/fromAnthropic.js';
import { fromOpenAI } from '../translate/fromOpenAI.js';
import type { InternalRequestBase } from '../translate/internal.js';
import { AnthropicStreamEncoder, anthropicErrorEvent, toAnthropicMessage } from '../translate/toAnthropic.js';
import { OpenAiChunkEncoder, openAiErrorFrame, toChatCompletion } from '../translate/toOpenAI.js';
import { principalOf, requireApiKey, type AppEnv } from './auth.js';
import { modelAvailability, openAiModelList } from './dto.js';
import { GatewayError } from './errors.js';
import { rateLimit } from './ratelimit.js';

/** Sanitizes a header value: Latin-1 only, no control characters (C0 except tab, DEL), ≤ `max` chars. */
export function headerSafe(value: string, max = 512): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) out += ' ';
    else if (code > 0xff) out += '-';
    else out += ch;
  }
  return out.length > max ? `${out.slice(0, max - 1)}…`.replace('…', '.') : out;
}

/** `x-beagle-route`: reasons joined by `; `, ≤ 512 chars. */
export function routeHeader(reasons: readonly string[]): string {
  return headerSafe(reasons.join('; '), 512);
}

function parseDifficulty(c: Context<AppEnv>): number | undefined {
  const raw = c.req.header('x-beagle-difficulty');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new GatewayError('invalid_request_error', 'x-beagle-difficulty must be a number in [0, 1]');
  return Math.min(1, Math.max(0, n));
}

function parseFallback(c: Context<AppEnv>): FallbackPolicy | undefined {
  const raw = c.req.header('x-beagle-fallback');
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'none' || v === 'cheaper' || v === 'any') return v;
  throw new GatewayError('invalid_request_error', 'x-beagle-fallback must be none, cheaper or any');
}

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (e) {
    throw new GatewayError('invalid_request_error', `invalid JSON body: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

function zodMessage(error: z.ZodError): { message: string; param: string | null } {
  const issue = error.issues[0];
  if (issue === undefined) return { message: 'invalid request', param: null };
  const path = issue.path.map(String).join('.');
  return { message: path === '' ? issue.message : `${path}: ${issue.message}`, param: path === '' ? null : path };
}

/** Common `x-beagle-*` headers. */
export function metaHeaders(requestId: string, meta: ExecMeta | undefined, settlement?: { chargedMicro: bigint; balanceMicro: bigint }): Record<string, string> {
  const h: Record<string, string> = { 'x-beagle-request-id': requestId };
  if (meta !== undefined) {
    h['x-beagle-model'] = meta.model.id;
    h['x-beagle-provider'] = meta.model.provider;
    h['x-beagle-paid-by'] = meta.paidBy;
    h['x-beagle-route'] = routeHeader(meta.routeReasons);
  }
  if (settlement !== undefined) {
    h['x-beagle-cost-micro'] = settlement.chargedMicro.toString();
    h['x-beagle-balance-micro'] = settlement.balanceMicro.toString();
  }
  return h;
}

/** Streams SSE text produced by `run` as a `text/event-stream` response. */
export function sseResponse(headers: Record<string, string>, run: (write: (text: string) => void, aborted: () => boolean) => Promise<void>): Response {
  const encoder = new TextEncoder();
  let aborted = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string): void => {
        if (aborted) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          aborted = true;
        }
      };
      try {
        await run(write, () => aborted);
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      aborted = true;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', ...headers },
  });
}

/** A `GatewayError` rendered in the envelope of `flavor`. */
export function errorResponse(err: GatewayError, flavor: 'openai' | 'anthropic'): Response {
  const r = flavor === 'anthropic' ? err.toAnthropic() : err.toOpenAi();
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', ...r.headers } });
}

/** Mounts the inference routes. */
export function mountInference(app: Hono<AppEnv>, services: Services): void {
  const runExecute = async (c: Context<AppEnv>, requestId: string, endpoint: string, requestedModel: string, base: InternalRequestBase): Promise<ExecuteOutcome> => {
    const principal = principalOf(c);
    const difficultyOverride = parseDifficulty(c);
    const fallbackOverride = parseFallback(c);
    return services.executor.execute({
      requestId,
      workspace: principal.workspace,
      apiKeyId: principal.kind === 'key' ? principal.apiKeyId : null,
      endpoint,
      requestedModel,
      base,
      ...(difficultyOverride === undefined ? {} : { difficultyOverride }),
      ...(fallbackOverride === undefined ? {} : { fallbackOverride }),
      signal: c.req.raw.signal,
    });
  };

  app.post('/v1/chat/completions', requireApiKey(services), rateLimit(services), async (c) => {
    const requestId = `req_${uuid()}`;
    const body = await readJson(c);
    const parsed = ChatCompletionRequestSchema.safeParse(body);
    if (!parsed.success) {
      const { message, param } = zodMessage(parsed.error);
      throw new GatewayError('invalid_request_error', message, { param });
    }
    const req = parsed.data;
    if (req.n !== undefined && req.n !== null && req.n !== 1) throw new GatewayError('invalid_request_error', 'n must be 1', { param: 'n' });
    const base = fromOpenAI(req);
    const outcome = await runExecute(c, requestId, 'chat.completions', req.model, base);
    const created = Math.floor(services.now() / 1000);
    if (outcome.kind === 'error') {
      const headers = { ...outcome.error.headers, 'x-beagle-request-id': requestId, 'x-beagle-route': routeHeader(outcome.routeReasons) };
      return errorResponse(new GatewayError(outcome.error.code, outcome.error.message, { status: outcome.error.status, param: outcome.error.param, headers }), 'openai');
    }
    if (outcome.kind === 'response') {
      const completion = toChatCompletion(outcome.response, { id: requestId, created, model: outcome.meta.model.id });
      return new Response(JSON.stringify(completion), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', ...metaHeaders(requestId, outcome.meta, outcome.settlement) },
      });
    }
    const includeUsage = req.stream_options?.include_usage === true;
    const encoder = new OpenAiChunkEncoder({ id: requestId, created, model: outcome.meta.model.id }, includeUsage);
    return sseResponse(metaHeaders(requestId, outcome.meta), async (write, aborted) => {
      for await (const chunk of outcome.chunks) {
        if (aborted()) break;
        if (chunk.type === 'error') {
          write(openAiErrorFrame('upstream_error', chunk.error.message));
          continue;
        }
        for (const out of encoder.encode(chunk)) write(formatSseData(out));
      }
      try {
        const result = await outcome.done;
        write(formatSseBeagleTrailer(result.settlement.chargedMicro, result.settlement.balanceMicro));
      } catch {
        // settlement failure is logged by the executor
      }
      write(SSE_DONE);
    });
  });

  app.get('/v1/models', requireApiKey(services), (c) => {
    const principal = principalOf(c);
    const byok = services.registry.byokProviders(principal.workspace);
    return c.json(openAiModelList(services, principal.plan, byok));
  });

  app.get('/v1/models/:id{.+}', requireApiKey(services), (c) => {
    const principal = principalOf(c);
    const id = c.req.param('id'); // Hono already percent-decodes path params
    const created = Math.floor(services.now() / 1000);
    if (isAlias(id)) {
      const alias: OpenAiModel = { id, object: 'model', created, owned_by: 'beagle', beagle: { tier: null, price: null, available: true, requiresPlan: null, alias: true } };
      return c.json({ ...alias, description: ALIAS_DESCRIPTIONS[id] });
    }
    const model = services.catalog.find((m) => m.id === id || m.upstreamId === id);
    if (model === undefined) throw new GatewayError('model_not_found', `Unknown model "${id}". Aliases: ${ALIASES.join(', ')}.`, { param: 'model' });
    const byok = services.registry.byokProviders(principal.workspace);
    const { available } = modelAvailability(services, model, principal.plan, byok);
    const dto: OpenAiModel = { id: model.id, object: 'model', created, owned_by: model.provider, beagle: { tier: model.tier, price: { ...model.price }, available, requiresPlan: model.requiresPlan ?? null, alias: false } };
    return c.json(dto);
  });

  app.post('/v1/messages', requireApiKey(services), rateLimit(services), async (c) => {
    const requestId = `req_${uuid()}`;
    const body = await readJson(c);
    const parsed = AnthropicMessagesRequestSchema.safeParse(body);
    if (!parsed.success) {
      const { message, param } = zodMessage(parsed.error);
      throw new GatewayError('invalid_request_error', message, { param });
    }
    const req = parsed.data;
    const base = fromAnthropic(req);
    const outcome = await runExecute(c, requestId, 'messages', req.model, base);
    if (outcome.kind === 'error') {
      const headers = { ...outcome.error.headers, 'x-beagle-request-id': requestId, 'x-beagle-route': routeHeader(outcome.routeReasons) };
      return errorResponse(new GatewayError(outcome.error.code, outcome.error.message, { status: outcome.error.status, headers }), 'anthropic');
    }
    if (outcome.kind === 'response') {
      const message = toAnthropicMessage(outcome.response, { id: requestId, model: outcome.meta.model.id });
      return new Response(JSON.stringify(message), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', ...metaHeaders(requestId, outcome.meta, outcome.settlement) },
      });
    }
    const encoder = new AnthropicStreamEncoder({ id: requestId, model: outcome.meta.model.id });
    return sseResponse(metaHeaders(requestId, outcome.meta), async (write, aborted) => {
      write(encoder.start());
      for await (const chunk of outcome.chunks) {
        if (aborted()) break;
        if (chunk.type === 'error') {
          write(anthropicErrorEvent('upstream_error', chunk.error.message));
          continue;
        }
        write(encoder.encode(chunk));
      }
      try {
        const result = await outcome.done;
        write(formatSseBeagleTrailer(result.settlement.chargedMicro, result.settlement.balanceMicro));
      } catch {
        // logged by the executor
      }
    });
  });
}
