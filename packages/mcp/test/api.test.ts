import { MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@beagle/shared/addresses';
import type {
  BalanceDtoWire,
  BudgetDtoWire,
  ConfigDtoWire,
  CreditEventDtoWire,
  PriceDtoWire,
  StatusDtoWire,
  UpgradeDtoWire,
  UsageRowDtoWire,
  UsageSummaryDtoWire,
} from '@beagle/shared/api';
import { describe, expect, it } from 'vitest';
import { BeagleApiError, completionMetaFromHeaders, createRestBeagleApi, type FetchLike } from '../src/api.js';
import { AGENT_ATA, signatureOf } from './fake-api.js';
import { AGENT, MINT, OPERATOR, OTHER_WORKSPACE } from './fake-connection.js';

const BASE = 'http://gateway.test:8787';
const KEY = 'bgl_testkey_0123456789';
const WS = AGENT;
const SIG = signatureOf(0xab);

interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (req: Recorded) => Response | Promise<Response>;

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function stub(handler: Handler): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const rec: Recorded = { url: new URL(input), method: init?.method ?? 'GET', headers, body };
    calls.push(rec);
    return handler(rec);
  };
  return { fetch, calls };
}

const priceWire: PriceDtoWire = {
  pricePointId: 7,
  priceE18: '10000000000000000',
  observedAt: 1_760_000_000,
  stale: false,
  source: 'manual',
  maxAgeS: 3600,
  usdPerToken: '0.01',
  tokensPerUsd: '100',
};

const balanceWire: BalanceDtoWire = {
  balanceMicro: '12340000',
  reservedMicro: '10000',
  budgetHeadroomMicro: '0',
  availableMicro: '12330000',
  plan: 'free',
  planUntil: null,
  price: priceWire,
};

const summaryWire: UsageSummaryDtoWire = {
  window: '7d',
  requests: 2,
  chargedMicro: '12',
  upstreamCostMicro: '10',
  inputTokens: 24,
  outputTokens: 40,
  byModel: [{ model: 'house/gpt-oss-20b', requests: 2, chargedMicro: '12' }],
  byDay: [{ day: '2026-10-09', requests: 2, chargedMicro: '12' }],
};

const rowWire: UsageRowDtoWire = {
  id: 'req_1',
  workspace: WS,
  apiKeyId: 'k1',
  endpoint: '/v1/chat/completions',
  requestedModel: 'beagle/auto',
  servedModel: 'house/gpt-oss-20b',
  provider: 'house',
  tier: 'house',
  paidBy: 'credit',
  inputTokens: 12,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  upstreamCostMicro: '5',
  chargedMicro: '6',
  status: 'ok',
  httpStatus: 200,
  errorCode: null,
  latencyMs: 300,
  routeReasons: [],
  stream: false,
  difficulty: 0.3,
  drawId: null,
  createdAt: 1_760_000_000_000,
};

const budgetWire: BudgetDtoWire = {
  tokenAccount: AGENT_ATA,
  owner: WS,
  workspace: WS,
  delegate: OPERATOR,
  cap: '500000000',
  balance: '1000000000',
  headroomTokens: '500000000',
  headroomMicro: '5000000',
  closed: false,
  stalledReason: null,
  registeredAt: 1_760_000_000_000,
  lastSeenSlot: 120,
  draws: [],
};

const receiptWire: CreditEventDtoWire = {
  signature: SIG,
  ixIndex: 0,
  slot: 42,
  blockTime: 1_760_000_000,
  kind: 'purchase',
  workspace: WS,
  payer: WS,
  tokenAccount: AGENT_ATA,
  tokenAmount: '500000000',
  usdMicro: '5000000',
  priceE18: '10000000000000000',
  pricePointId: 7,
  priceStale: false,
  memo: null,
  receiptHash: null,
  explorerUrl: `https://explorer.solana.com/tx/${SIG}?cluster=devnet`,
};

const upgradeWire: UpgradeDtoWire = {
  id: 'upg_1',
  workspace: WS,
  kind: 'warm',
  quantity: 2,
  amountMicro: '4000000',
  startsAt: 1_760_000_000_000,
  endsAt: 1_760_007_200_000,
  createdAt: 1_760_000_000_000,
};

const statusWire: StatusDtoWire = {
  cluster: 'devnet',
  mint: MINT,
  token: { mint: MINT, symbol: 'BEAGLE', decimals: 6, tokenProgram: TOKEN_PROGRAM_ID },
  indexer: { lastSignature: SIG, lastSlot: 10, headSlot: 10, lagSlots: 0, lastEventAt: null },
  price: priceWire,
  providers: {
    anthropic: { state: 'ok', configured: true },
    openai: { state: 'ok', configured: true },
    google: { state: 'down', configured: false },
    house: { state: 'ok', configured: true },
  },
  house: { enabled: true, warmUntil: null, largeModel: 'house/gpt-oss-120b' },
  operator: { address: OPERATOR, enabled: false, dryRun: true, solBalance: '1500000000' },
  version: '0.1.0',
};

const configWire: ConfigDtoWire = {
  cluster: 'devnet',
  rpcUrl: 'https://api.devnet.solana.com',
  mint: MINT,
  decimals: 6,
  symbol: 'BEAGLE',
  tokenProgram: TOKEN_PROGRAM_ID,
  memoProgram: MEMO_PROGRAM_ID,
  operator: OPERATOR,
  explorer: 'https://explorer.solana.com',
  aliases: ['beagle/auto', 'beagle/best', 'beagle/cheap', 'beagle/house'],
  markupBps: 1000,
  byokFeeBps: 0,
  minCreditMicro: '1000',
  pro: { priceMicro: '20000000', days: 30 },
  warmHourPriceMicro: '2000000',
};

const completionWire = {
  id: 'req_abc',
  object: 'chat.completion',
  created: 1_760_000_000,
  model: 'anthropic/claude-haiku-5-5',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello!', refusal: null }, finish_reason: 'stop', logprobs: null }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
};

describe('createRestBeagleApi', () => {
  it('validates the options', () => {
    expect(() => createRestBeagleApi({ baseUrl: 'gateway.test', apiKey: KEY })).toThrow(/http/);
    expect(() => createRestBeagleApi({ baseUrl: BASE, apiKey: '  ' })).toThrow(/apiKey/);
  });

  it('GET /api/balance with the bearer key, parsing money to bigint', async () => {
    const { fetch, calls } = stub(() => json(balanceWire));
    const api = createRestBeagleApi({ baseUrl: `${BASE}/`, apiKey: KEY, fetch });
    const balance = await api.balance();
    expect(calls.length).toBe(1);
    expect(calls[0]!.url.toString()).toBe(`${BASE}/api/balance`);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.headers['accept']).toBe('application/json');
    expect(calls[0]!.headers['content-type']).toBeUndefined();
    expect(balance.balanceMicro).toBe(12_340_000n);
    expect(balance.availableMicro).toBe(12_330_000n);
    expect(balance.price.priceE18).toBe(10n ** 16n);
    expect(balance.price.pricePointId).toBe(7);
  });

  it('GET /api/models returns the models array', async () => {
    const { fetch, calls } = stub(() =>
      json({
        models: [
          {
            id: 'house/gpt-oss-20b',
            provider: 'house',
            upstreamId: 'openai/gpt-oss-20b',
            displayName: 'gpt-oss-20b',
            tier: 'house',
            contextWindow: 131072,
            maxOutput: 32768,
            price: { inputPerM: 50000, outputPerM: 200000 },
            capabilities: { tools: true, vision: false, json: true, reasoning: true },
            autoEligible: true,
            available: true,
            providerState: 'ok',
          },
        ],
        aliases: [{ id: 'beagle/auto', description: 'auto' }],
      }),
    );
    const api = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch });
    const models = await api.models();
    expect(calls[0]!.url.pathname).toBe('/api/models');
    expect(models.length).toBe(1);
    expect(models[0]!.id).toBe('house/gpt-oss-20b');
    expect(models[0]!.available).toBe(true);
  });

  it('GET /api/quote with tokens= or usdMicro=', async () => {
    const { fetch, calls } = stub(() => json({ tokens: '500000000', usdMicro: '5000000', priceE18: '10000000000000000', pricePointId: 7, stale: false }));
    const api = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch });
    const byUsd = await api.quote({ usdMicro: 5_000_000n });
    expect(calls[0]!.url.pathname).toBe('/api/quote');
    expect(calls[0]!.url.searchParams.get('usdMicro')).toBe('5000000');
    expect(calls[0]!.url.searchParams.has('tokens')).toBe(false);
    expect(byUsd.tokens).toBe(500_000_000n);
    expect(byUsd.pricePointId).toBe(7);
    await api.quote({ tokens: 500_000_000n });
    expect(calls[1]!.url.searchParams.get('tokens')).toBe('500000000');
    await expect(api.quote({})).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    await expect(api.quote({ tokens: 1n, usdMicro: 1n })).rejects.toBeInstanceOf(BeagleApiError);
    expect(calls.length).toBe(2);
  });

  it('POST /v1/chat/completions with JSON body, routing headers and metadata from response headers', async () => {
    const { fetch, calls } = stub(() =>
      json(completionWire, {
        headers: {
          'x-beagle-request-id': 'req_abc',
          'x-beagle-model': 'anthropic/claude-haiku-5-5',
          'x-beagle-provider': 'anthropic',
          'x-beagle-paid-by': 'credit',
          'x-beagle-cost-micro': '1234',
          'x-beagle-balance-micro': '9990000',
          'x-beagle-route': 'alias beagle/auto -> tier budget; picked anthropic/claude-haiku-5-5',
        },
      }),
    );
    const api = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch });
    const res = await api.complete({ model: 'beagle/auto', messages: [{ role: 'user', content: 'hi' }] }, { difficulty: 0.4, fallback: 'none' });
    const call = calls[0]!;
    expect(call.url.pathname).toBe('/v1/chat/completions');
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(call.headers['x-beagle-difficulty']).toBe('0.4');
    expect(call.headers['x-beagle-fallback']).toBe('none');
    expect(call.body).toEqual({ model: 'beagle/auto', messages: [{ role: 'user', content: 'hi' }], stream: false });
    expect(res.choices[0]!.message.content).toBe('hello!');
    expect(res.beagle).toEqual({
      requestId: 'req_abc',
      model: 'anthropic/claude-haiku-5-5',
      provider: 'anthropic',
      paidBy: 'credit',
      costMicro: 1234n,
      balanceMicro: 9_990_000n,
      route: ['alias beagle/auto -> tier budget', 'picked anthropic/claude-haiku-5-5'],
    });
  });

  it('omits routing headers when no options are given and tolerates missing metadata headers', async () => {
    const { fetch, calls } = stub(() => json(completionWire));
    const api = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch });
    const res = await api.complete({ model: 'beagle/auto', messages: [{ role: 'user', content: 'hi' }] });
    expect(calls[0]!.headers['x-beagle-difficulty']).toBeUndefined();
    expect(res.beagle).toEqual({ requestId: null, model: null, provider: null, paidBy: null, costMicro: null, balanceMicro: null, route: [] });
  });

  it('maps an OpenAI error envelope to BeagleApiError', async () => {
    const { fetch } = stub(() =>
      json(
        { error: { message: 'Insufficient credit: burn BEAGLE on the Credits page or open a budget.', type: 'insufficient_credit', code: 'insufficient_credit', param: null } },
        { status: 402 },
      ),
    );
    const api = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch });
    const error = await api.complete({ model: 'beagle/auto', messages: [{ role: 'user', content: 'hi' }] }).catch((e: unknown) => e);
    expect(BeagleApiError.is(error)).toBe(true);
    expect(error).toMatchObject({ status: 402, code: 'insufficient_credit', message: 'Insufficient credit: burn BEAGLE on the Credits page or open a budget.' });
  });

  it('GET /api/usage and /api/usage/summary in parallel with the query parameters', async () => {
    const { fetch, calls } = stub((req) => (req.url.pathname === '/api/usage' ? json({ rows: [rowWire], nextBefore: null }) : json(summaryWire)));
    const api = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch });
    const result = await api.usage({ limit: 10, window: '7d' });
    const paths = calls.map((c) => `${c.url.pathname}?${c.url.searchParams.toString()}`).sort();
    expect(paths).toEqual(['/api/usage/summary?window=7d', '/api/usage?limit=10']);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.chargedMicro).toBe(6n);
    expect(result.summary.window).toBe('7d');
    expect(result.summary.chargedMicro).toBe(12n);

    calls.length = 0;
    await api.usage({});
    expect(calls.map((c) => c.url.search).sort()).toEqual(['', '']);
  });

  it('GET /api/budgets (keyed by token account)', async () => {
    const { fetch, calls } = stub(() => json([budgetWire]));
    const api = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch });
    const budgets = await api.budgets();
    expect(calls[0]!.url.pathname).toBe('/api/budgets');
    expect(budgets[0]!.tokenAccount).toBe(AGENT_ATA);
    expect(budgets[0]!.delegate).toBe(OPERATOR);
    expect(budgets[0]!.cap).toBe(500_000_000n);
    expect(budgets[0]!.headroomMicro).toBe(5_000_000n);
  });

  it('POST /api/budgets/register { tokenAccount, workspace? } and maps not_delegated', async () => {
    const { fetch, calls } = stub(() => json({ ...budgetWire, workspace: OTHER_WORKSPACE }, { status: 201 }));
    const api = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch });
    const budget = await api.registerBudget({ tokenAccount: AGENT_ATA, workspace: OTHER_WORKSPACE });
    expect(calls[0]!.url.pathname).toBe('/api/budgets/register');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ tokenAccount: AGENT_ATA, workspace: OTHER_WORKSPACE });
    expect(budget.workspace).toBe(OTHER_WORKSPACE);
    await api.registerBudget({ tokenAccount: AGENT_ATA });
    expect(calls[1]!.body).toEqual({ tokenAccount: AGENT_ATA });

    const rejected = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch: stub(() => json({ error: { code: 'not_delegated', message: 'no delegation to the operator' } }, { status: 400 })).fetch });
    await expect(rejected.registerBudget({ tokenAccount: AGENT_ATA })).rejects.toMatchObject({ status: 400, code: 'not_delegated' });
  });

  it('GET /api/price and /api/price/history?limit', async () => {
    const { fetch, calls } = stub((req) => (req.url.pathname === '/api/price' ? json({ ...priceWire, stale: true }) : json([priceWire, { ...priceWire, pricePointId: 6, observedAt: 1_759_990_000 }])));
    const api = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch });
    const price = await api.price();
    expect(calls[0]!.url.pathname).toBe('/api/price');
    expect(price.stale).toBe(true);
    expect(price.priceE18).toBe(10n ** 16n);
    expect(price.observedAt).toBe(1_760_000_000);
    const history = await api.priceHistory({ limit: 2 });
    expect(calls[1]!.url.pathname).toBe('/api/price/history');
    expect(calls[1]!.url.searchParams.get('limit')).toBe('2');
    expect(history.map((p) => p.pricePointId)).toEqual([7, 6]);
    await api.priceHistory();
    expect(calls[2]!.url.search).toBe('');
  });

  it('GET /api/receipts?limit&before parses credit events', async () => {
    const { fetch, calls } = stub(() => json({ rows: [receiptWire], nextBefore: 1_759_999_000 }));
    const api = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch });
    const page = await api.receipts({ limit: 5, before: 1_760_000_100 });
    expect(calls[0]!.url.pathname).toBe('/api/receipts');
    expect(calls[0]!.url.searchParams.get('limit')).toBe('5');
    expect(calls[0]!.url.searchParams.get('before')).toBe('1760000100');
    expect(page.nextBefore).toBe(1_759_999_000);
    expect(page.rows[0]!.signature).toBe(SIG);
    expect(page.rows[0]!.usdMicro).toBe(5_000_000n);
    expect(page.rows[0]!.tokenAmount).toBe(500_000_000n);
    expect(page.rows[0]!.pricePointId).toBe(7);
    await api.receipts();
    expect(calls[1]!.url.search).toBe('');
  });

  it('POST /api/upgrades { kind, quantity }', async () => {
    const { fetch, calls } = stub(() => json(upgradeWire, { status: 201 }));
    const api = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch });
    const upgrade = await api.upgrade('warm', 2);
    expect(calls[0]!.url.pathname).toBe('/api/upgrades');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ kind: 'warm', quantity: 2 });
    expect(upgrade.amountMicro).toBe(4_000_000n);
  });

  it('GET /api/status and /api/config', async () => {
    const { fetch, calls } = stub((req) => (req.url.pathname === '/api/status' ? json(statusWire) : json(configWire)));
    const api = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch });
    const status = await api.status();
    const config = await api.config();
    expect(calls.map((c) => c.url.pathname)).toEqual(['/api/status', '/api/config']);
    expect(status.cluster).toBe('devnet');
    expect(status.providers.google?.state).toBe('down');
    expect(status.operator.solBalance).toBe(1_500_000_000n);
    expect(config.mint).toBe(MINT);
    expect(config.operator).toBe(OPERATOR);
    expect(config.minCreditMicro).toBe(1_000n);
    expect(config.pro.priceMicro).toBe(20_000_000n);
    expect(config.warmHourPriceMicro).toBe(2_000_000n);
  });

  it('maps the /api error envelope to BeagleApiError with status and code', async () => {
    const { fetch } = stub(() => json({ error: { code: 'invalid_api_key', message: 'revoked' } }, { status: 401 }));
    const api = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch });
    await expect(api.balance()).rejects.toMatchObject({ name: 'BeagleApiError', status: 401, code: 'invalid_api_key', message: 'revoked' });
  });

  it('maps non-JSON failures to http_error and malformed bodies to invalid_response', async () => {
    const api1 = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch: stub(() => new Response('bad gateway', { status: 502 })).fetch });
    await expect(api1.status()).rejects.toMatchObject({ status: 502, code: 'http_error', message: 'bad gateway' });

    const api2 = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch: stub(() => new Response('', { status: 500 })).fetch });
    await expect(api2.status()).rejects.toMatchObject({ status: 500, code: 'http_error', message: 'HTTP 500' });

    const api3 = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch: stub(() => json({ balanceMicro: 12 })).fetch });
    const error = await api3.balance().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 200, code: 'invalid_response' });
    expect((error as Error).message).toMatch(/GET \/api\/balance/);

    // an EVM-shaped budget (no tokenAccount) is rejected rather than leaking into the tools
    const api4 = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch: stub(() => json([{ budgetId: 3, owner: WS, cap: '1' }])).fetch });
    await expect(api4.budgets()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('maps thrown fetch errors to network_error / timeout with status 0', async () => {
    const failing: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const api = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch: failing });
    await expect(api.balance()).rejects.toMatchObject({ status: 0, code: 'network_error' });

    const timingOut: FetchLike = async () => {
      throw new DOMException('aborted', 'TimeoutError');
    };
    const api2 = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch: timingOut });
    await expect(api2.balance()).rejects.toMatchObject({ status: 0, code: 'timeout' });
  });

  it('passes an abort signal with the configured timeout', async () => {
    let signal: AbortSignal | undefined;
    const f: FetchLike = async (_input, init) => {
      signal = init?.signal ?? undefined;
      return json(statusWire);
    };
    const api = createRestBeagleApi({ baseUrl: BASE, apiKey: KEY, fetch: f, timeoutMs: 5 });
    await api.status();
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe('completionMetaFromHeaders', () => {
  it('ignores malformed numeric headers and unknown paidBy values', () => {
    const meta = completionMetaFromHeaders(new Headers({ 'x-beagle-cost-micro': 'abc', 'x-beagle-paid-by': 'cash', 'x-beagle-route': ' ; ' }));
    expect(meta.costMicro).toBeNull();
    expect(meta.paidBy).toBeNull();
    expect(meta.route).toEqual([]);
  });
});
