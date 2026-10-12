/**
 * The {@link BeagleApi} interface the MCP tools are written against (SPEC §6.2) and its REST
 * implementation over the gateway routes of SPEC §5.9 / §5.8.
 *
 * Every monetary value is a `bigint` in µUSD once parsed; token amounts and `priceE18` are
 * `bigint` raw units. Wire parsing uses the zod schemas of `@beagle/shared/api`, so a gateway
 * response that does not match the DTO contract surfaces as a {@link BeagleApiError} with code
 * `invalid_response` instead of leaking malformed data into the tools.
 *
 * @module api
 */
import {
  BalanceDtoSchema,
  BudgetDtoSchema,
  ConfigDtoSchema,
  CreditEventListDtoSchema,
  ErrorDtoSchema,
  ModelsDtoSchema,
  PriceDtoSchema,
  PriceHistoryDtoSchema,
  QuoteDtoSchema,
  StatusDtoSchema,
  UpgradeDtoSchema,
  UsageListDtoSchema,
  UsageSummaryDtoSchema,
  type BalanceDto,
  type BudgetDto,
  type ConfigDto,
  type CreditEventDto,
  type ModelDto,
  type PriceDto,
  type QuoteDto,
  type RegisterBudgetRequest,
  type StatusDto,
  type UpgradeDto,
  type UsageRowDto,
  type UsageSummaryDto,
} from '@beagle/shared/api';
import { ChatCompletionSchema, OpenAiErrorBodySchema, type ChatCompletion, type ChatCompletionRequest } from '@beagle/shared/openai';
import { z } from 'zod';

/** Usage summary windows accepted by `GET /api/usage/summary`. */
export type UsageWindow = '24h' | '7d' | '30d';

/** Query of {@link BeagleApi.quote}: exactly one of `tokens` (raw units) or `usdMicro`. */
export interface QuoteQuery {
  tokens?: bigint;
  usdMicro?: bigint;
}

/** Query of {@link BeagleApi.usage}. */
export interface UsageQuery {
  /** Rows to return (newest first), 1–200; the gateway default is 50. */
  limit?: number;
  /** Summary window; the gateway default is `24h`. */
  window?: UsageWindow;
}

/** Result of {@link BeagleApi.usage}. */
export interface UsageResult {
  rows: UsageRowDto[];
  summary: UsageSummaryDto;
}

/** Query of {@link BeagleApi.receipts} (`GET /api/receipts?limit&before`, newest first). */
export interface ReceiptsQuery {
  /** Rows to return, 1–200; the gateway default is 50. */
  limit?: number;
  /** Cursor: rows recorded by the gateway before this `created_at` timestamp (unix milliseconds; several events can share a slot), from the previous page's `nextBefore`. */
  before?: number;
}

/** Result of {@link BeagleApi.receipts}. */
export interface ReceiptsResult {
  rows: CreditEventDto[];
  nextBefore: number | null;
}

/**
 * Per-request routing hints of {@link BeagleApi.complete}. The REST client sends them as the
 * `x-beagle-difficulty` / `x-beagle-fallback` request headers (SPEC §5.8); an in-process
 * implementation feeds them straight into the router. Implementations may ignore them.
 */
export interface CompletionOptions {
  /** Overrides the difficulty estimate, `0..1`. */
  difficulty?: number;
  /** Fallback policy; the gateway default is `cheaper`. */
  fallback?: 'none' | 'cheaper' | 'any';
}

/**
 * Billing metadata of one completion, taken from the `x-beagle-*` response headers (SPEC §5.8).
 * Fields are `null` when the gateway did not report them.
 */
export interface BeagleCompletionMeta {
  requestId: string | null;
  /** Catalog id of the served model. */
  model: string | null;
  provider: string | null;
  paidBy: 'credit' | 'byok' | null;
  costMicro: bigint | null;
  balanceMicro: bigint | null;
  /** Routing reasons (`x-beagle-route`), split on `; `. */
  route: string[];
}

/**
 * A `chat.completion` with optional Beagle billing metadata attached. A plain
 * {@link ChatCompletion} satisfies this type, so implementations that cannot provide the
 * metadata simply omit `beagle`.
 */
export interface BeagleChatCompletion extends ChatCompletion {
  beagle?: BeagleCompletionMeta;
}

/**
 * What the MCP tools need from the gateway (SPEC §6.2). The REST client ({@link createRestBeagleApi})
 * implements it over HTTP; the gateway's `/mcp` mount passes an in-process implementation bound
 * to the workspace of the API key.
 */
export interface BeagleApi {
  /** `GET /api/balance`: balance, reservations, budget headroom, plan and the token price. */
  balance(): Promise<BalanceDto>;
  /** `GET /api/models`: the catalog with live availability (aliases are static, see `@beagle/shared/models`). */
  models(): Promise<ModelDto[]>;
  /** `GET /api/quote`: tokens → µUSD or µUSD → tokens at the current published price point. */
  quote(q: QuoteQuery): Promise<QuoteDto>;
  /**
   * `POST /v1/chat/completions` (non-streaming). Costs credit unless the route is BYOK. The result
   * may carry {@link BeagleChatCompletion.beagle} with cost and balance.
   */
  complete(req: ChatCompletionRequest, options?: CompletionOptions): Promise<BeagleChatCompletion>;
  /** `GET /api/usage` + `GET /api/usage/summary`. */
  usage(q: UsageQuery): Promise<UsageResult>;
  /** `GET /api/budgets`: the workspace's delegation budgets with headroom and draws. */
  budgets(): Promise<BudgetDto[]>;
  /**
   * `POST /api/budgets/register`: tells the gateway about a token account just delegated to the
   * operator (SPEC §3.4 discovery (a)); `workspace` funds another workspace than the owner.
   * Fails with `not_delegated` (400) when the account is not delegated to the operator.
   */
  registerBudget(req: RegisterBudgetRequest): Promise<BudgetDto>;
  /** `POST /api/upgrades`: buys `pro` periods or `warm` hours with credit (402 when short). */
  upgrade(kind: 'pro' | 'warm', quantity: number): Promise<UpgradeDto>;
  /** `GET /api/status`: cluster, mint, indexer, price, provider health, house model, operator. */
  status(): Promise<StatusDto>;
  /** `GET /api/config`: cluster, RPC, mint / token program / operator, explorer, aliases, fees, upgrade prices. */
  config(): Promise<ConfigDto>;
  /** `GET /api/price`: the current published price point and whether it is stale (SPEC §3.3). */
  price(): Promise<PriceDto>;
  /** `GET /api/price/history?limit`: price points, newest first. */
  priceHistory(q?: { limit?: number }): Promise<PriceDto[]>;
  /** `GET /api/receipts`: the workspace's credit events (burns and draws), newest first. */
  receipts(q?: ReceiptsQuery): Promise<ReceiptsResult>;
}

/**
 * A gateway or transport failure. `status` is the HTTP status (`0` when no response arrived),
 * `code` the gateway error code (`insufficient_credit`, `invalid_api_key`, …) or one of the
 * client-side codes `network_error`, `timeout`, `invalid_response`, `http_error`.
 */
export class BeagleApiError extends Error {
  override readonly name = 'BeagleApiError';
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.status = status;
    this.code = code;
  }

  /** `true` when `error` is a {@link BeagleApiError} (works across module instances). */
  static is(error: unknown): error is BeagleApiError {
    return (
      error instanceof BeagleApiError ||
      (typeof error === 'object' &&
        error !== null &&
        (error as { name?: unknown }).name === 'BeagleApiError' &&
        typeof (error as { code?: unknown }).code === 'string' &&
        typeof (error as { status?: unknown }).status === 'number')
    );
  }
}

/** The subset of `fetch` the client needs; defaults to `globalThis.fetch`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Options of {@link createRestBeagleApi}. */
export interface RestBeagleApiOptions {
  /** Gateway origin, e.g. `http://localhost:8787` (a trailing slash is tolerated). */
  baseUrl: string;
  /** `bgl_…` API key, sent as `Authorization: Bearer`. */
  apiKey: string;
  /** Injected fetch (tests); defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Per-request timeout for everything but completions (default 30 000 ms). */
  timeoutMs?: number;
  /** Timeout of `POST /v1/chat/completions` (default 180 000 ms). */
  completionTimeoutMs?: number;
}

const ModelsResponseSchema = ModelsDtoSchema;
const BudgetsResponseSchema = z.array(BudgetDtoSchema);

type Method = 'GET' | 'POST';

interface RequestSpec {
  method: Method;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error(`createRestBeagleApi: baseUrl must start with http:// or https:// (got ${JSON.stringify(baseUrl)})`);
  }
  return trimmed;
}

function buildUrl(base: string, path: string, query: RequestSpec['query']): string {
  const url = new URL(base + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Extracts `{ code, message }` from either error envelope the gateway uses (SPEC §5.8, §5.9). */
function parseErrorBody(status: number, body: unknown): { code: string; message: string } {
  const api = ErrorDtoSchema.safeParse(body);
  if (api.success) return api.data.error;
  const openai = OpenAiErrorBodySchema.safeParse(body);
  if (openai.success) {
    return { code: openai.data.error.code ?? openai.data.error.type, message: openai.data.error.message };
  }
  if (typeof body === 'string' && body.trim() !== '') return { code: 'http_error', message: body.slice(0, 500) };
  return { code: 'http_error', message: `HTTP ${status}` };
}

function headerBigInt(headers: Headers, name: string): bigint | null {
  const raw = headers.get(name);
  if (raw === null || !/^-?\d+$/.test(raw.trim())) return null;
  return BigInt(raw.trim());
}

/** Drops `undefined` optionals from a parsed completion so it satisfies the exact-optional {@link ChatCompletion}. */
function toChatCompletion(parsed: z.output<typeof ChatCompletionSchema>): ChatCompletion {
  return {
    id: parsed.id,
    object: parsed.object,
    created: parsed.created,
    model: parsed.model,
    choices: parsed.choices.map((choice) => ({
      index: choice.index,
      message: {
        role: choice.message.role,
        content: choice.message.content,
        refusal: choice.message.refusal,
        ...(choice.message.tool_calls === undefined ? {} : { tool_calls: choice.message.tool_calls }),
      },
      finish_reason: choice.finish_reason,
      logprobs: choice.logprobs,
    })),
    usage: {
      prompt_tokens: parsed.usage.prompt_tokens,
      completion_tokens: parsed.usage.completion_tokens,
      total_tokens: parsed.usage.total_tokens,
      ...(parsed.usage.prompt_tokens_details === undefined ? {} : { prompt_tokens_details: parsed.usage.prompt_tokens_details }),
    },
    ...(parsed.system_fingerprint === undefined ? {} : { system_fingerprint: parsed.system_fingerprint }),
  };
}

/** Reads the `x-beagle-*` response headers into a {@link BeagleCompletionMeta}. */
export function completionMetaFromHeaders(headers: Headers): BeagleCompletionMeta {
  const paidBy = headers.get('x-beagle-paid-by');
  const route = headers.get('x-beagle-route');
  return {
    requestId: headers.get('x-beagle-request-id'),
    model: headers.get('x-beagle-model'),
    provider: headers.get('x-beagle-provider'),
    paidBy: paidBy === 'credit' || paidBy === 'byok' ? paidBy : null,
    costMicro: headerBigInt(headers, 'x-beagle-cost-micro'),
    balanceMicro: headerBigInt(headers, 'x-beagle-balance-micro'),
    route: route === null || route.trim() === '' ? [] : route.split(';').map((s) => s.trim()).filter((s) => s !== ''),
  };
}

/**
 * Builds a {@link BeagleApi} that talks to a gateway over HTTP with `Authorization: Bearer <apiKey>`.
 * Only routes marked "key OK" or public in SPEC §5.9 are used, plus `POST /v1/chat/completions`.
 */
export function createRestBeagleApi(options: RestBeagleApiOptions): BeagleApi {
  const base = normalizeBaseUrl(options.baseUrl);
  const apiKey = options.apiKey.trim();
  if (apiKey === '') throw new Error('createRestBeagleApi: apiKey is required');
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const completionTimeoutMs = options.completionTimeoutMs ?? 180_000;

  async function request(spec: RequestSpec): Promise<{ status: number; headers: Headers; body: unknown }> {
    const url = buildUrl(base, spec.path, spec.query);
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      ...(spec.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(spec.headers ?? {}),
    };
    const init: RequestInit = {
      method: spec.method,
      headers,
      signal: AbortSignal.timeout(spec.timeoutMs),
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
    };
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new BeagleApiError(
        0,
        timedOut ? 'timeout' : 'network_error',
        timedOut
          ? `request to ${spec.method} ${spec.path} timed out after ${spec.timeoutMs} ms`
          : `request to ${spec.method} ${spec.path} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const text = await response.text();
    let body: unknown = text;
    if (text !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      const { code, message } = parseErrorBody(response.status, body);
      throw new BeagleApiError(response.status, code, message);
    }
    return { status: response.status, headers: response.headers, body };
  }

  function parse<S extends z.ZodType>(schema: S, body: unknown, what: string, status: number): z.output<S> {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new BeagleApiError(status, 'invalid_response', `${what}: unexpected response shape: ${z.prettifyError(result.error)}`);
    }
    return result.data;
  }

  async function get<S extends z.ZodType>(path: string, schema: S, query?: RequestSpec['query']): Promise<z.output<S>> {
    const res = await request({ method: 'GET', path, timeoutMs, ...(query === undefined ? {} : { query }) });
    return parse(schema, res.body, `GET ${path}`, res.status);
  }

  return {
    balance: () => get('/api/balance', BalanceDtoSchema),

    models: async () => (await get('/api/models', ModelsResponseSchema)).models,

    quote: async (q) => {
      const hasTokens = q.tokens !== undefined;
      const hasUsd = q.usdMicro !== undefined;
      if (hasTokens === hasUsd) {
        throw new BeagleApiError(400, 'invalid_request', 'quote: pass exactly one of tokens or usdMicro');
      }
      return get('/api/quote', QuoteDtoSchema, hasTokens ? { tokens: q.tokens!.toString() } : { usdMicro: q.usdMicro!.toString() });
    },

    complete: async (req, opts) => {
      const headers: Record<string, string> = {};
      if (opts?.difficulty !== undefined) headers['x-beagle-difficulty'] = String(opts.difficulty);
      if (opts?.fallback !== undefined) headers['x-beagle-fallback'] = opts.fallback;
      const res = await request({
        method: 'POST',
        path: '/v1/chat/completions',
        body: { ...req, stream: false },
        headers,
        timeoutMs: completionTimeoutMs,
      });
      const completion = toChatCompletion(parse(ChatCompletionSchema, res.body, 'POST /v1/chat/completions', res.status));
      const result: BeagleChatCompletion = { ...completion, beagle: completionMetaFromHeaders(res.headers) };
      return result;
    },

    usage: async (q) => {
      const [list, summary] = await Promise.all([
        get('/api/usage', UsageListDtoSchema, q.limit === undefined ? undefined : { limit: q.limit }),
        get('/api/usage/summary', UsageSummaryDtoSchema, q.window === undefined ? undefined : { window: q.window }),
      ]);
      return { rows: list.rows, summary };
    },

    budgets: () => get('/api/budgets', BudgetsResponseSchema),

    registerBudget: async (req) => {
      const body = { tokenAccount: req.tokenAccount, ...(req.workspace === undefined ? {} : { workspace: req.workspace }) };
      const res = await request({ method: 'POST', path: '/api/budgets/register', body, timeoutMs });
      return parse(BudgetDtoSchema, res.body, 'POST /api/budgets/register', res.status);
    },

    upgrade: async (kind, quantity) => {
      const res = await request({ method: 'POST', path: '/api/upgrades', body: { kind, quantity }, timeoutMs });
      return parse(UpgradeDtoSchema, res.body, 'POST /api/upgrades', res.status);
    },

    status: () => get('/api/status', StatusDtoSchema),

    config: () => get('/api/config', ConfigDtoSchema),

    price: () => get('/api/price', PriceDtoSchema),

    priceHistory: (q) => get('/api/price/history', PriceHistoryDtoSchema, q?.limit === undefined ? undefined : { limit: q.limit }),

    receipts: async (q) => {
      const query = { ...(q?.limit === undefined ? {} : { limit: q.limit }), ...(q?.before === undefined ? {} : { before: q.before }) };
      return get('/api/receipts', CreditEventListDtoSchema, Object.keys(query).length === 0 ? undefined : query);
    },
  };
}
