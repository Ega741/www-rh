import { receiptHash } from '@beagle/shared/canonical';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_ACTIVE_KEYS } from '../src/api/dashboard.js';
import { headerSafe } from '../src/api/inference.js';
import { jsonRequest, makeHarness, parseSse, WS1, WS2, type Harness } from './helpers.js';

describe('HTTP flows (house model via mock provider)', () => {
  let h: Harness;
  let key1: string;
  let key2: string;

  beforeAll(async () => {
    h = await makeHarness({ RATE_LIMIT_RPM: '100', MAX_BODY_BYTES: '4096' });
    key1 = h.key(WS1);
    key2 = h.key(WS2);
    h.credit(WS1, 10_000_000n);
  });
  afterAll(async () => h.close());

  it('GET /healthz', async () => {
    const res = await h.app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('401 without a key, with an unknown key, and in the Anthropic envelope on /v1/messages', async () => {
    const a = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'beagle/auto', messages: [{ role: 'user', content: 'x' }] }));
    expect(a.status).toBe(401);
    expect(await a.json()).toMatchObject({ error: { code: 'invalid_api_key', type: 'invalid_api_key' } });
    const b = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'beagle/auto', messages: [] }, { authorization: 'Bearer bgl_' + 'x'.repeat(43) }));
    expect(b.status).toBe(401);
    const c = await h.app.request(jsonRequest('POST', '/v1/messages', { model: 'beagle/auto', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }));
    expect(c.status).toBe(401);
    expect(await c.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
  });

  it('200 JSON completion with x-beagle headers, ledger debit, usage row and receipt', async () => {
    const before = h.services.ledger.balance(WS1);
    const res = await h.app.request(
      jsonRequest('POST', '/v1/chat/completions', { model: 'beagle/auto', messages: [{ role: 'user', content: 'hello beagle' }], max_tokens: 64 }, { authorization: `Bearer ${key1}` }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-beagle-model')).toBe('house/gpt-oss-20b');
    expect(res.headers.get('x-beagle-provider')).toBe('house');
    expect(res.headers.get('x-beagle-paid-by')).toBe('credit');
    const cost = BigInt(res.headers.get('x-beagle-cost-micro') ?? '0');
    expect(cost).toBeGreaterThan(0n);
    expect(res.headers.get('x-beagle-balance-micro')).toBe((before - cost).toString());
    const route = res.headers.get('x-beagle-route') ?? '';
    expect(route.length).toBeGreaterThan(0);
    expect(route.length).toBeLessThanOrEqual(512);
    expect([...route].every((ch) => (ch.codePointAt(0) ?? 0) <= 0xff)).toBe(true);
    const body = (await res.json()) as { id: string; model: string; choices: { message: { content: string } }[]; usage: { total_tokens: number } };
    expect(body.id).toMatch(/^req_/);
    expect(body.model).toBe('house/gpt-oss-20b');
    expect(body.choices[0]?.message.content).toBe('echo: hello beagle');
    expect(body.usage.total_tokens).toBeGreaterThan(0);
    expect(h.services.ledger.balance(WS1)).toBe(before - cost);

    const usage = await h.app.request('/api/usage?limit=5', { headers: { authorization: `Bearer ${key1}` } });
    expect(usage.status).toBe(200);
    const list = (await usage.json()) as { rows: { id: string; chargedMicro: string; status: string }[] };
    expect(list.rows[0]).toMatchObject({ id: body.id, chargedMicro: cost.toString(), status: 'ok' });

    const receipt = await h.app.request(`/api/receipts/${body.id}`, { headers: { authorization: `Bearer ${key1}` } });
    expect(receipt.status).toBe(200);
    const r = (await receipt.json()) as { receipt: Record<string, unknown>; hash: string };
    expect(Object.keys(r).sort()).toEqual(['hash', 'receipt']); // ReceiptDto = { receipt, hash }, nothing flattened
    expect(r.hash).toHaveLength(66);
    expect(receiptHash(r.receipt)).toBe(r.hash);
    expect(r.receipt).toMatchObject({ v: 1, requestId: body.id, workspace: WS1, servedModel: 'house/gpt-oss-20b', provider: 'house', paidBy: 'credit', chargedMicro: cost.toString(), markupBps: 1000 });

    expect(h.mock?.requests.at(-1)?.body['model']).toBe('openai/gpt-oss-20b');
    expect(h.mock?.requests.at(-1)?.body['max_tokens']).toBe(64);
  });

  it('GET /api/balance with a key returns decimal strings and price', async () => {
    const res = await h.app.request('/api/balance', { headers: { authorization: `Bearer ${key1}` } });
    expect(res.status).toBe(200);
    const b = (await res.json()) as Record<string, unknown>;
    expect(typeof b['balanceMicro']).toBe('string');
    expect(b['balanceMicro']).toMatch(/^-?\d+$/);
    expect(b['budgetHeadroomMicro']).toBe('0');
    expect(b['plan']).toBe('free');
    expect(b['price']).toMatchObject({ priceE18: '0', stale: true });
  });

  it('SSE stream: chunks, final cost/balance comment, [DONE]; settles the usage row', async () => {
    const before = h.services.ledger.balance(WS1);
    const res = await h.app.request(
      jsonRequest('POST', '/v1/chat/completions', { model: 'beagle/cheap', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'stream me' }], max_tokens: 32 }, { authorization: `Bearer ${key1}` }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-beagle-model')).toBe('house/gpt-oss-20b');
    const text = await res.text();
    const { data, comments } = parseSse(text);
    expect(data.at(-1)).toBe('[DONE]');
    const chunks = data.slice(0, -1).map((d) => JSON.parse(d) as { object: string; choices: { delta: { content?: string; role?: string }; finish_reason: string | null }[]; usage?: unknown });
    expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);
    expect(chunks[0]?.choices[0]?.delta.role).toBe('assistant');
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('echo: stream me');
    expect(chunks.some((c) => c.choices[0]?.finish_reason === 'stop')).toBe(true);
    expect(chunks.at(-1)?.usage).toBeDefined();
    const trailer = comments.find((c) => c.startsWith('beagle cost='));
    expect(trailer).toBeDefined();
    const m = /beagle cost=(\d+) balance=(-?\d+)/.exec(trailer ?? '');
    const cost = BigInt(m?.[1] ?? '0');
    expect(cost).toBeGreaterThan(0n);
    expect(BigInt(m?.[2] ?? '1')).toBe(before - cost);
    expect(h.services.ledger.balance(WS1)).toBe(before - cost);
    const row = h.services.repos.usage.list(WS1, { limit: 1 })[0];
    expect(row?.stream).toBe(true);
    expect(row?.status).toBe('ok');
  });

  it('POST /v1/messages returns the Anthropic shape and streams Anthropic events', async () => {
    const res = await h.app.request(
      jsonRequest('POST', '/v1/messages', { model: 'beagle/auto', max_tokens: 64, messages: [{ role: 'user', content: 'ping anthropic shape' }] }, { 'x-api-key': key1, 'anthropic-version': '2023-06-01' }),
    );
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { type: string; role: string; model: string; content: { type: string; text: string }[]; usage: { output_tokens: number; cache_read_input_tokens: number }; stop_reason: string };
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('assistant');
    expect(msg.model).toBe('house/gpt-oss-20b');
    expect(msg.content[0]?.text).toBe('echo: ping anthropic shape');
    expect(msg.usage.output_tokens).toBeGreaterThan(0);
    expect(msg.usage.cache_read_input_tokens).toBe(0);
    expect(msg.stop_reason).toBe('end_turn');

    const stream = await h.app.request(
      jsonRequest('POST', '/v1/messages', { model: 'beagle/auto', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'stream' }] }, { 'x-api-key': key1 }),
    );
    expect(stream.status).toBe(200);
    const { events, comments } = parseSse(await stream.text());
    expect(events[0]).toBe('message_start');
    expect(events).toContain('content_block_delta');
    expect(events.at(-1)).toBe('message_stop');
    expect(comments.some((c) => c.startsWith('beagle cost='))).toBe(true);
  });

  it('400 on invalid bodies and forced Anthropic tool choice', async () => {
    const a = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'beagle/auto' }, { authorization: `Bearer ${key1}` }));
    expect(a.status).toBe(400);
    expect(await a.json()).toMatchObject({ error: { type: 'invalid_request_error', code: 'invalid_request_error', param: 'messages' } });
    const b = await h.app.request(new Request('http://gw/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key1}`, 'content-type': 'application/json' }, body: '{not json' }));
    expect(b.status).toBe(400);
    const n = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'beagle/auto', messages: [{ role: 'user', content: 'x' }], n: 2 }, { authorization: `Bearer ${key1}` }));
    expect(n.status).toBe(400);
    const c = await h.app.request(
      jsonRequest('POST', '/v1/messages', { model: 'beagle/auto', max_tokens: 5, messages: [{ role: 'user', content: 'x' }], tools: [{ name: 't', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } }, { 'x-api-key': key1 }),
    );
    expect(c.status).toBe(400);
    expect(await c.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
  });

  it('404 model_not_found and 403 plan_required', async () => {
    const a = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'nope/nothing', messages: [{ role: 'user', content: 'x' }] }, { authorization: `Bearer ${key1}` }));
    expect(a.status).toBe(404);
    expect(await a.json()).toMatchObject({ error: { code: 'model_not_found' } });
    const b = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'house/gpt-oss-120b', messages: [{ role: 'user', content: 'x' }] }, { authorization: `Bearer ${key1}` }));
    expect(b.status).toBe(403);
    expect(await b.json()).toMatchObject({ error: { code: 'plan_required' } });
  });

  it('402 insufficient_credit for a workspace without credit, in both envelopes', async () => {
    const a = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'beagle/auto', messages: [{ role: 'user', content: 'no credit' }] }, { authorization: `Bearer ${key2}` }));
    expect(a.status).toBe(402);
    expect(a.headers.get('x-beagle-balance-micro')).toBe('0');
    expect(a.headers.get('x-beagle-credits-url')).toBe('http://localhost:5173/app/credits');
    expect(await a.json()).toEqual({ error: { message: 'Insufficient credit: burn BEAGLE on the Credits page or open a budget.', type: 'insufficient_credit', code: 'insufficient_credit', param: null } });
    const b = await h.app.request(jsonRequest('POST', '/v1/messages', { model: 'beagle/auto', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }, { 'x-api-key': key2 }));
    expect(b.status).toBe(402);
    expect(await b.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error', message: expect.stringMatching(/^insufficient_credit:/) } });
    const row = h.services.repos.usage.list(WS2, { limit: 1 })[0];
    expect(row).toMatchObject({ status: 'error', httpStatus: 402, errorCode: 'insufficient_credit', chargedMicro: 0n });
  });

  it('GET /v1/models lists catalog + aliases with beagle extension; /v1/models/:id', async () => {
    const res = await h.app.request('/v1/models', { headers: { authorization: `Bearer ${key1}` } });
    expect(res.status).toBe(200);
    const list = (await res.json()) as { object: string; data: { id: string; owned_by: string; beagle: { available: boolean; alias: boolean } }[] };
    expect(list.object).toBe('list');
    const house = list.data.find((m) => m.id === 'house/gpt-oss-20b');
    expect(house?.beagle.available).toBe(true);
    const claude = list.data.find((m) => m.id === 'anthropic/claude-opus-5-5');
    expect(claude?.beagle.available).toBe(false);
    const auto = list.data.find((m) => m.id === 'beagle/auto');
    expect(auto).toMatchObject({ owned_by: 'beagle', beagle: { alias: true } });
    const one = await h.app.request('/v1/models/house%2Fgpt-oss-20b', { headers: { authorization: `Bearer ${key1}` } });
    expect(one.status).toBe(200);
    expect(((await one.json()) as { id: string }).id).toBe('house/gpt-oss-20b');
    const missing = await h.app.request('/v1/models/nope', { headers: { authorization: `Bearer ${key1}` } });
    expect(missing.status).toBe(404);
    const percent = await h.app.request('/v1/models/a%25', { headers: { authorization: `Bearer ${key1}` } });
    expect(percent.status).toBe(404);
    expect(await percent.json()).toMatchObject({ error: { code: 'model_not_found' } });
  });

  it('control characters in the model id yield 404 with sanitized headers, not 500', async () => {
    for (const model of ['nope\u0000x', 'bad\u0001model', 'bad\u007fmodel', 'crlf\r\nx-injected: 1']) {
      const res = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'x' }] }, { authorization: `Bearer ${key1}` }));
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: 'model_not_found' } });
      const route = res.headers.get('x-beagle-route') ?? '';
      expect([...route].every((ch) => (ch.codePointAt(0) ?? 0) >= 0x20 && (ch.codePointAt(0) ?? 0) !== 0x7f && (ch.codePointAt(0) ?? 0) <= 0xff)).toBe(true);
      expect(res.headers.get('x-injected')).toBeNull();
    }
    expect(headerSafe('a\u0000b\tc\u007fd\r\ne')).toBe('a b\tc d  e');
  });

  it('GET /api/usage accepts empty filter values (the canonical URL of SPEC §5.9)', async () => {
    const res = await h.app.request('/api/usage?limit=50&model=&status=', { headers: { authorization: `Bearer ${key1}` } });
    expect(res.status).toBe(200);
    const list = (await res.json()) as { rows: unknown[] };
    expect(list.rows.length).toBeGreaterThan(0);
    expect((await h.app.request('/api/usage?limit=50&status=bogus', { headers: { authorization: `Bearer ${key1}` } })).status).toBe(400);
  });

  it('413 when the body exceeds MAX_BODY_BYTES', async () => {
    const big = 'x'.repeat(5000);
    const res = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'beagle/auto', messages: [{ role: 'user', content: big }] }, { authorization: `Bearer ${key1}` }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'request_too_large' } });
  });

  it('CORS headers for the configured origin only', async () => {
    const ok = await h.app.request('/api/status', { headers: { origin: 'http://localhost:5173' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    const bad = await h.app.request('/api/status', { headers: { origin: 'http://evil.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await h.app.request('/v1/chat/completions', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
    expect(pre.headers.get('access-control-expose-headers')?.toLowerCase()).toContain('x-beagle-cost-micro');
  });

  it('public routes: status, config, models, price, quote', async () => {
    const status = (await (await h.app.request('/api/status')).json()) as Record<string, unknown>;
    expect(status['chainId']).toBe(31337);
    expect(status['creditDesk']).toBeNull();
    expect(status['providers']).toMatchObject({ house: { configured: true, state: 'ok' }, anthropic: { configured: false } });
    const config = (await (await h.app.request('/api/config')).json()) as Record<string, unknown>;
    expect(config).toMatchObject({ chainId: 31337, markupBps: 1000, pro: { priceMicro: '20000000', days: 30 }, warmHourPriceMicro: '2000000' });
    const models = (await (await h.app.request('/api/models')).json()) as { models: unknown[]; aliases: unknown[] };
    expect(models.models.length).toBe(12);
    expect(models.aliases.length).toBe(4);
    const price = (await (await h.app.request('/api/price')).json()) as Record<string, unknown>;
    expect(price).toMatchObject({ priceE18: '0', stale: true, source: 'unknown' });
    const quote = await h.app.request('/api/quote?tokens=1000');
    expect(quote.status).toBe(503);
    const badQuote = await h.app.request('/api/quote');
    expect(badQuote.status).toBe(400);
  });
});

describe('rate limiting', () => {
  it('returns 429 rate_limited with Retry-After after RATE_LIMIT_RPM requests', async () => {
    const h = await makeHarness({ RATE_LIMIT_RPM: '2' });
    try {
      const key = h.key(WS1);
      h.credit(WS1, 1_000_000n);
      const body = { model: 'beagle/auto', messages: [{ role: 'user', content: 'x' }] };
      expect((await h.app.request(jsonRequest('POST', '/v1/chat/completions', body, { authorization: `Bearer ${key}` }))).status).toBe(200);
      expect((await h.app.request(jsonRequest('POST', '/v1/chat/completions', body, { authorization: `Bearer ${key}` }))).status).toBe(200);
      const third = await h.app.request(jsonRequest('POST', '/v1/chat/completions', body, { authorization: `Bearer ${key}` }));
      expect(third.status).toBe(429);
      expect(third.headers.get('retry-after')).toMatch(/^\d+$/);
      expect(await third.json()).toMatchObject({ error: { code: 'rate_limited' } });
    } finally {
      await h.close();
    }
  });
});

describe('dashboard with session auth', () => {
  let h: Harness;
  const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const ws = account.address.toLowerCase();

  beforeAll(async () => {
    h = await makeHarness();
  });
  afterAll(async () => h.close());

  it('SIWE nonce → verify sets a cookie and returns a token; /api/me works with cookie and bearer', async () => {
    const nonceRes = await h.app.request('/api/auth/nonce');
    const { nonce } = (await nonceRes.json()) as { nonce: string };
    expect(nonce.length).toBeGreaterThanOrEqual(8);
    const message = createSiweMessage({ address: account.address, chainId: 31337, domain: 'localhost:8787', nonce, uri: 'http://localhost:8787', version: '1', statement: 'Sign in to Beagle' });
    const signature = await account.signMessage({ message });
    const verify = await h.app.request(jsonRequest('POST', '/api/auth/verify', { message, signature }));
    expect(verify.status).toBe(200);
    const { token, workspace } = (await verify.json()) as { token: string; workspace: string };
    expect(workspace).toBe(ws);
    const cookie = verify.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('beagle_session=');
    expect(cookie).toContain('HttpOnly');
    const me1 = await h.app.request('/api/me', { headers: { cookie: cookie.split(';')[0] ?? '' } });
    expect(me1.status).toBe(200);
    expect(await me1.json()).toMatchObject({ workspace: ws, plan: 'free', balanceMicro: '0' });
    const me2 = await h.app.request('/api/me', { headers: { authorization: `Bearer ${token}` } });
    expect(me2.status).toBe(200);
    const replay = await h.app.request(jsonRequest('POST', '/api/auth/verify', { message, signature }));
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: { code: 'siwe_bad_nonce' } });
    const anon = await h.app.request('/api/me');
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const logout = await h.app.request('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(logout.status).toBe(200);
    expect((await h.app.request('/api/me', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('keys: create (key shown once), list masked, revoke; key cannot use session-only routes', async () => {
    const token = h.session(ws);
    const auth = { authorization: `Bearer ${token}` };
    const created = await h.app.request(jsonRequest('POST', '/api/keys', { name: 'laptop' }, auth));
    expect(created.status).toBe(201);
    const c = (await created.json()) as { id: string; key: string; prefix: string; name: string };
    expect(c.key).toMatch(/^bgl_/);
    expect(c.prefix).toBe(c.key.slice(0, 12));
    const list = (await (await h.app.request('/api/keys', { headers: auth })).json()) as Record<string, unknown>[];
    expect(list.some((k) => k['id'] === c.id && k['key'] === undefined)).toBe(true);
    expect((await h.app.request('/api/keys', { headers: { authorization: `Bearer ${c.key}` } })).status).toBe(401);
    expect((await h.app.request('/api/balance', { headers: { authorization: `Bearer ${c.key}` } })).status).toBe(200);
    expect((await h.app.request(`/api/keys/${c.id}`, { method: 'DELETE', headers: auth })).status).toBe(200);
    expect((await h.app.request('/api/balance', { headers: { authorization: `Bearer ${c.key}` } })).status).toBe(401);
  });

  it('keys: at most MAX_ACTIVE_KEYS active keys per workspace', async () => {
    const auth = { authorization: `Bearer ${h.session(WS2)}` };
    for (let i = h.services.repos.apiKeys.countByWorkspace(WS2); i < MAX_ACTIVE_KEYS; i++) h.services.apiKeys.create(WS2, `k${i}`);
    const over = await h.app.request(jsonRequest('POST', '/api/keys', { name: 'one too many' }, auth));
    expect(over.status).toBe(400);
    expect(await over.json()).toMatchObject({ error: { code: 'too_many_keys' } });
    const victim = h.services.repos.apiKeys.listByWorkspace(WS2)[0]!;
    expect((await h.app.request(`/api/keys/${victim.id}`, { method: 'DELETE', headers: auth })).status).toBe(200);
    expect((await h.app.request(jsonRequest('POST', '/api/keys', { name: 'fits again' }, auth))).status).toBe(201);
  });

  it('ledger, receipts list, usage summary, budgets (empty), upgrades prices', async () => {
    const auth = { authorization: `Bearer ${h.session(ws)}` };
    h.credit(ws, 123n);
    const ledger = (await (await h.app.request('/api/ledger', { headers: auth })).json()) as { rows: { kind: string; amountMicro: string }[]; nextBefore: null };
    expect(ledger.rows[0]).toMatchObject({ kind: 'adjustment', amountMicro: '123' });
    const receipts = (await (await h.app.request('/api/receipts', { headers: auth })).json()) as { rows: unknown[] };
    expect(receipts.rows).toEqual([]);
    const summary = (await (await h.app.request('/api/usage/summary?window=7d', { headers: auth })).json()) as Record<string, unknown>;
    expect(summary).toMatchObject({ window: '7d', requests: 0, chargedMicro: '0' });
    expect((await h.app.request('/api/usage/summary?window=1y', { headers: auth })).status).toBe(400);
    expect(await (await h.app.request('/api/budgets', { headers: auth })).json()).toEqual([]);
    expect((await h.app.request('/api/budgets/42', { headers: auth })).status).toBe(404);
    expect(await (await h.app.request('/api/upgrades/prices')).json()).toEqual({ pro: { priceMicro: '20000000', days: 30 }, warmHourPriceMicro: '2000000' });
  });

  it('BYOK providers: validation, SSRF guard, store masked, test, delete', async () => {
    const auth = { authorization: `Bearer ${h.session(ws)}` };
    const badProvider = await h.app.request(jsonRequest('PUT', '/api/providers/house', { apiKey: 'sk-xxxxxxxx' }, auth));
    expect(badProvider.status).toBe(400);
    const http = await h.app.request(jsonRequest('PUT', '/api/providers/openai', { apiKey: 'sk-xxxxxxxx', baseUrl: 'http://api.example.com/v1' }, auth));
    expect(http.status).toBe(400);
    const privateIp = await h.app.request(jsonRequest('PUT', '/api/providers/openai', { apiKey: 'sk-xxxxxxxx', baseUrl: 'https://10.0.0.5/v1' }, auth));
    expect(privateIp.status).toBe(400);
    expect(await privateIp.json()).toMatchObject({ error: { code: 'unsafe_base_url' } });
    const local = await h.app.request(jsonRequest('PUT', '/api/providers/openai', { apiKey: 'sk-xxxxxxxx', baseUrl: 'https://localhost/v1' }, auth));
    expect(local.status).toBe(400);
    const ok = await h.app.request(jsonRequest('PUT', '/api/providers/openai', { apiKey: 'sk-test-1234-abcd' }, auth));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ provider: 'openai', last4: 'abcd', baseUrl: null, lastError: null });
    const list = (await (await h.app.request('/api/providers', { headers: auth })).json()) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('sk-test-1234');
    const stored = h.services.repos.providerKeys.get(ws, 'openai');
    expect(stored).toBeDefined();
    expect(Buffer.from(stored!.ciphertext).toString('utf8')).not.toContain('sk-test');
    expect(h.services.registry.byokProviders(ws)).toEqual(['openai']);
    expect((await h.app.request('/api/providers/openai', { method: 'DELETE', headers: auth })).status).toBe(200);
    expect((await h.app.request('/api/providers/openai', { method: 'DELETE', headers: auth })).status).toBe(404);
  });

  it('upgrades: 402 when short, then pro plan and warm window', async () => {
    const auth = { authorization: `Bearer ${h.session(ws)}` };
    const short = await h.app.request(jsonRequest('POST', '/api/upgrades', { kind: 'pro', quantity: 1 }, auth));
    expect(short.status).toBe(402);
    expect(await short.json()).toMatchObject({ error: { code: 'insufficient_credit' } });
    // Budget headroom is not prepaid credit: an upgrade bought on it could never be drawn → 402.
    const nowMs = h.services.now();
    h.services.repos.budgets.upsertOpened({ budgetId: 9, owner: ws, workspace: ws, cap: 10n ** 24n, deadline: Math.floor(nowMs / 1000) + 7200, openedBlock: 1, now: nowMs });
    h.services.repos.budgets.setHeadroom(9, 10n ** 24n, 25_000_000n, null, nowMs);
    expect(h.services.ledger.snapshot(ws).available).toBeGreaterThanOrEqual(25_000_000n);
    for (const kind of ['pro', 'warm'] as const) {
      const onHeadroom = await h.app.request(jsonRequest('POST', '/api/upgrades', { kind, quantity: 1 }, auth));
      expect(onHeadroom.status).toBe(402);
    }
    expect(h.services.ledger.balance(ws)).toBe(123n);
    expect(((await (await h.app.request('/api/me', { headers: auth })).json()) as { plan: string }).plan).toBe('free');
    h.services.repos.budgets.setClosed(9, true, nowMs);
    h.credit(ws, 30_000_000n);
    const pro = await h.app.request(jsonRequest('POST', '/api/upgrades', { kind: 'pro', quantity: 1 }, auth));
    expect(pro.status).toBe(201);
    expect(await pro.json()).toMatchObject({ kind: 'pro', quantity: 1, amountMicro: '20000000' });
    const me = (await (await h.app.request('/api/me', { headers: auth })).json()) as { plan: string; planUntil: number };
    expect(me.plan).toBe('pro');
    expect(me.planUntil).toBeGreaterThan(Date.now());
    const warm = await h.app.request(jsonRequest('POST', '/api/upgrades', { kind: 'warm', quantity: 2 }, auth));
    expect(warm.status).toBe(201);
    const status = (await (await h.app.request('/api/status')).json()) as { house: { warmUntil: number | null } };
    expect(status.house.warmUntil).toBeGreaterThan(Date.now());
    const list = (await (await h.app.request('/api/upgrades', { headers: auth })).json()) as unknown[];
    expect(list).toHaveLength(2);
    expect((await h.app.request(jsonRequest('POST', '/api/upgrades', { kind: 'warm', quantity: 999 }, auth))).status).toBe(400);
  });

  it('admin routes need the token; credit adjusts the ledger', async () => {
    expect((await h.app.request(jsonRequest('POST', '/api/admin/credit', { workspace: WS2, amountMicro: '5' }))).status).toBe(401);
    expect((await h.app.request(jsonRequest('POST', '/api/admin/credit', { workspace: WS2, amountMicro: '5' }, { 'x-admin-token': 'wrong' }))).status).toBe(401);
    const before = h.services.ledger.balance(WS2);
    const res = await h.app.request(jsonRequest('POST', '/api/admin/credit', { workspace: WS2, amountMicro: '5', memo: 'gift' }, { 'x-admin-token': 'test-admin' }));
    expect(res.status).toBe(200);
    expect(h.services.ledger.balance(WS2)).toBe(before + 5n);
    const list = await h.app.request('/api/admin/workspaces', { headers: { 'x-admin-token': 'test-admin' } });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { workspace: string }[]).some((w) => w.workspace === WS2)).toBe(true);
  });

  it('unknown routes return the right envelope', async () => {
    const api = await h.app.request('/api/nope');
    expect(api.status).toBe(404);
    expect(await api.json()).toMatchObject({ error: { code: 'not_found' } });
    const v1 = await h.app.request('/v1/nope');
    expect(v1.status).toBe(404);
    expect(await v1.json()).toMatchObject({ error: { type: 'invalid_request_error' } });
  });
});
