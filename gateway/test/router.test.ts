import { applyMarkupBps, costMicroUsd } from '@beagle/shared/credit';
import { DEFAULT_CATALOG, type ModelSpec } from '@beagle/shared/models';
import { afterEach, describe, expect, it } from 'vitest';
import { billableUsage, maxTokensWithinBound } from '../src/router/execute.js';
import { HEALTH_OPEN_MS, HealthStore } from '../src/router/health.js';
import { networkError, ProviderError, type ProviderAdapter } from '../src/providers/types.js';
import type { InternalChunk, InternalRequestBase } from '../src/translate/internal.js';
import { jsonRequest, makeHarness, parseSse, WS1, WS2, type Harness } from './helpers.js';

const BASE: InternalRequestBase = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 16, stream: false };

/** A scripted adapter: each call pops the next behaviour. */
function scripted(provider: ProviderAdapter['provider'], script: (() => Promise<InternalChunk[]> | InternalChunk[])[], calls: string[] = []): ProviderAdapter {
  const next = (): (() => Promise<InternalChunk[]> | InternalChunk[]) => {
    const fn = script.shift();
    if (fn === undefined) throw new Error(`no scripted behaviour left for ${provider}`);
    return fn;
  };
  return {
    provider,
    async complete(req) {
      calls.push(`${provider}:${req.upstreamModel}`);
      const chunks = await next()();
      let text = '';
      let usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
      for (const c of chunks) {
        if (c.type === 'text') text += c.delta;
        if (c.type === 'finish') usage = c.usage;
        if (c.type === 'error') throw c.error;
      }
      return { id: 'x', model: req.upstreamModel, message: { role: 'assistant', content: [{ type: 'text', text }] }, finishReason: 'stop', usage };
    },
    async *stream(req) {
      calls.push(`${provider}:${req.upstreamModel}:stream`);
      const chunks = await next()();
      for (const c of chunks) yield c;
    },
  };
}

const ok = (text: string): InternalChunk[] => [
  { type: 'text', delta: text },
  { type: 'finish', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } },
];
const fail = (provider: ProviderAdapter['provider'], status: number, retryable: boolean, extra: Partial<ConstructorParameters<typeof ProviderError>[0]> = {}): (() => InternalChunk[]) => () => {
  throw new ProviderError({ provider, status, code: retryable ? 'upstream_error' : 'bad_request', message: `${provider} ${status}`, retryable, ...extra });
};

describe('router execution', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('falls back to the next candidate on a retryable error and records the route', async () => {
    const calls: string[] = [];
    h = await makeHarness(
      { ANTHROPIC_API_KEY: 'sk-ant-platform', OPENAI_API_KEY: 'sk-platform' },
      {
        adapters: {
          anthropic: scripted('anthropic', [fail('anthropic', 529, true)], calls),
          openai: scripted('openai', [() => ok('from openai')], calls),
        },
      },
      false,
    );
    const key = h.key(WS1);
    h.credit(WS1, 10_000_000n);
    const res = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'beagle/best', messages: [{ role: 'user', content: 'hi' }] }, { authorization: `Bearer ${key}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-beagle-model')).toBe('openai/gpt-5.5');
    expect(calls).toEqual(['anthropic:claude-opus-5-5', 'openai:gpt-5.5']);
    expect(res.headers.get('x-beagle-route')?.length).toBeLessThanOrEqual(512);
    const row = h.services.repos.usage.list(WS1, { limit: 1 })[0];
    expect(row?.routeReasons.some((r) => r.startsWith('anthropic/claude-opus-5-5 failed'))).toBe(true);
    expect(h.services.repos.reservations.purgeExpired(Date.now() + 1e9)).toBe(0); // all reservations released or settled
  });

  it('does not fall back on a 400 and passes the upstream message through', async () => {
    const calls: string[] = [];
    h = await makeHarness(
      { ANTHROPIC_API_KEY: 'sk-ant-platform', OPENAI_API_KEY: 'sk-platform' },
      { adapters: { anthropic: scripted('anthropic', [fail('anthropic', 400, false, { message: 'max_tokens too large' })], calls), openai: scripted('openai', [() => ok('never')], calls) } },
      false,
    );
    const key = h.key(WS1);
    h.credit(WS1, 10_000_000n);
    const res = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'anthropic/claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }, { authorization: `Bearer ${key}` }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_request_error', message: 'max_tokens too large' } });
    expect(calls).toEqual(['anthropic:claude-opus-5-5']);
    expect(h.services.ledger.balance(WS1)).toBe(10_000_000n);
    expect(h.services.health.state('anthropic')).toBe('ok');
  });

  it('honours x-beagle-fallback: none (502) and maps a final 429 to upstream_rate_limited', async () => {
    h = await makeHarness(
      { ANTHROPIC_API_KEY: 'sk-ant-platform', OPENAI_API_KEY: 'sk-platform' },
      { adapters: { anthropic: scripted('anthropic', [fail('anthropic', 500, true), fail('anthropic', 429, true, { code: 'rate_limited', retryAfterSec: 3 })]), openai: scripted('openai', [() => ok('x')]) } },
      false,
    );
    const key = h.key(WS1);
    h.credit(WS1, 10_000_000n);
    const body = { model: 'anthropic/claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] };
    const a = await h.app.request(jsonRequest('POST', '/v1/chat/completions', body, { authorization: `Bearer ${key}`, 'x-beagle-fallback': 'none' }));
    expect(a.status).toBe(502);
    expect(await a.json()).toMatchObject({ error: { code: 'upstream_error' } });
    const b = await h.app.request(jsonRequest('POST', '/v1/chat/completions', body, { authorization: `Bearer ${key}`, 'x-beagle-fallback': 'none' }));
    expect(b.status).toBe(429);
    expect(b.headers.get('retry-after')).toBe('3');
    expect(await b.json()).toMatchObject({ error: { code: 'upstream_rate_limited' } });
  });

  it('switches candidate before the first streamed byte, never after', async () => {
    const calls: string[] = [];
    const midStreamError = new ProviderError({ provider: 'openai', status: 0, code: 'network', message: 'socket closed', retryable: true });
    h = await makeHarness(
      { ANTHROPIC_API_KEY: 'sk-ant-platform', OPENAI_API_KEY: 'sk-platform' },
      {
        adapters: {
          anthropic: scripted('anthropic', [fail('anthropic', 503, true)], calls),
          openai: scripted('openai', [() => [{ type: 'text', delta: 'par' }, { type: 'error', error: midStreamError }]], calls),
        },
      },
      false,
    );
    const key = h.key(WS1);
    h.credit(WS1, 10_000_000n);
    const res = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'beagle/best', stream: true, messages: [{ role: 'user', content: 'hi' }] }, { authorization: `Bearer ${key}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-beagle-model')).toBe('openai/gpt-5.5');
    const { data } = parseSse(await res.text());
    expect(calls).toEqual(['anthropic:claude-opus-5-5:stream', 'openai:gpt-5.5:stream']);
    expect(data.some((d) => d.includes('"content":"par"'))).toBe(true);
    expect(data.some((d) => d.includes('"error"') && d.includes('socket closed'))).toBe(true);
    expect(data.at(-1)).toBe('[DONE]');
    const row = h.services.repos.usage.list(WS1, { limit: 1 })[0];
    expect(row?.status).toBe('error');
    expect(row?.servedModel).toBe('openai/gpt-5.5');
    expect(row?.chargedMicro).toBeGreaterThan(0n);
  });

  it('skips candidates without credentials and returns 503 when none is configured', async () => {
    h = await makeHarness({}, {}, false);
    const key = h.key(WS1);
    h.credit(WS1, 10_000_000n);
    const res = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'beagle/auto', messages: [{ role: 'user', content: 'hi' }] }, { authorization: `Bearer ${key}` }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'no_model_available' } });
  });

  it('BYOK requests consume no credit and a BYOK 401 flags only that key', async () => {
    const calls: string[] = [];
    h = await makeHarness(
      { OPENAI_API_KEY: 'sk-platform' },
      {
        adapters: {
          openai: scripted('openai', [() => ok('byok answer'), fail('openai', 401, false, { code: 'auth', authFailure: true })], calls),
        },
      },
      false,
    );
    const key = h.key(WS1);
    const enc = h.services.keyring!.encrypt('sk-user-key-1234', WS1, 'openai');
    h.services.repos.providerKeys.upsert({ id: 'pk1', workspace: WS1, provider: 'openai', ciphertext: enc.ciphertext, iv: enc.iv, tag: enc.tag, last4: '1234', baseUrl: null, createdAt: 1 });
    const res = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'openai/gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }] }, { authorization: `Bearer ${key}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-beagle-paid-by')).toBe('byok');
    expect(res.headers.get('x-beagle-cost-micro')).toBe('0');
    expect(h.services.ledger.balance(WS1)).toBe(0n);
    const bad = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'openai/gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }] }, { authorization: `Bearer ${key}` }));
    expect(bad.status).toBe(502);
    expect(h.services.repos.providerKeys.get(WS1, 'openai')?.lastError).toContain('401');
    expect(h.services.health.state('openai')).toBe('ok');
  });

  it('x-beagle-difficulty steers beagle/auto', async () => {
    const calls: string[] = [];
    h = await makeHarness(
      { ANTHROPIC_API_KEY: 'sk-ant-platform' },
      { adapters: { anthropic: scripted('anthropic', [() => ok('a'), () => ok('b')], calls) } },
      false,
    );
    const key = h.key(WS1);
    h.credit(WS1, 10_000_000n);
    const body = { model: 'beagle/auto', messages: [{ role: 'user', content: 'hi' }] };
    const hard = await h.app.request(jsonRequest('POST', '/v1/chat/completions', body, { authorization: `Bearer ${key}`, 'x-beagle-difficulty': '0.9' }));
    expect(hard.headers.get('x-beagle-model')).toBe('anthropic/claude-opus-5-5');
    const easy = await h.app.request(jsonRequest('POST', '/v1/chat/completions', body, { authorization: `Bearer ${key}`, 'x-beagle-difficulty': '0.1' }));
    expect(easy.headers.get('x-beagle-model')).toBe('anthropic/claude-haiku-5-5');
    const bad = await h.app.request(jsonRequest('POST', '/v1/chat/completions', body, { authorization: `Bearer ${key}`, 'x-beagle-difficulty': 'high' }));
    expect(bad.status).toBe(400);
  });
});

/** Rejects with the signal's reason when it fires before `ms` elapse. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason as unknown);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason as unknown);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** An adapter that only ever finishes when the per-attempt signal fires (a hung upstream). */
function hanging(provider: ProviderAdapter['provider'], calls: string[]): ProviderAdapter {
  return {
    provider,
    async complete(_req, _creds, signal) {
      calls.push('complete');
      await sleep(60_000, signal);
      throw new Error('unreachable');
    },
    async *stream(_req, _creds, signal) {
      calls.push('stream');
      yield { type: 'text', delta: 'par' };
      try {
        await sleep(60_000, signal);
      } catch (e) {
        yield { type: 'error', error: networkError(provider, e) };
      }
    },
  };
}

/** An adapter whose stream emits `chunks` after the given delays, honouring the signal. */
function paced(provider: ProviderAdapter['provider'], script: [number, InternalChunk][]): ProviderAdapter {
  return {
    provider,
    async complete() {
      throw new Error('stream only');
    },
    async *stream(_req, _creds, signal) {
      for (const [delay, chunk] of script) {
        try {
          await sleep(delay, signal);
        } catch (e) {
          yield { type: 'error', error: networkError(provider, e) };
          return;
        }
        yield chunk;
      }
    },
  };
}

const FINISH = (usage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }): InternalChunk => ({ type: 'finish', finishReason: 'stop', usage });

describe('client disconnects, BYOK failures and provider health', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('three aborted requests (JSON and SSE) leave the provider ok and settle as client_aborted', async () => {
    const calls: string[] = [];
    h = await makeHarness({ OPENAI_API_KEY: 'sk-platform' }, { adapters: { openai: hanging('openai', calls) } }, false);
    const key = h.key(WS1);
    h.credit(WS1, 10_000_000n);
    const send = async (stream: boolean): Promise<Response> => {
      const ctl = new AbortController();
      setTimeout(() => ctl.abort('Client connection prematurely closed.'), 25);
      const req = new Request('http://gw/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'openai/gpt-5.5', stream, messages: [{ role: 'user', content: 'hi' }] }),
        signal: ctl.signal,
      });
      const res = await h.app.request(req);
      await res.text();
      return res;
    };
    for (let i = 0; i < 3; i++) await send(false);
    expect(calls.filter((c) => c === 'complete')).toHaveLength(3);
    expect(h.services.health.state('openai')).toBe('ok');
    for (let i = 0; i < 3; i++) await send(true);
    expect(h.services.health.state('openai')).toBe('ok');
    const rows = h.services.repos.usage.list(WS1, { limit: 10 });
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.status).toBe('error');
      expect(row.errorCode).toBe('client_aborted');
      expect(row.servedModel).toBe('openai/gpt-5.5');
    }
    expect(rows.filter((r) => !r.stream).every((r) => r.httpStatus === 499)).toBe(true);
    expect(h.services.repos.reservations.purgeExpired(Date.now() + 1e9)).toBe(0);
    // A genuine upstream failure still counts.
    const fresh = await makeHarness({ OPENAI_API_KEY: 'sk-platform' }, { adapters: { openai: scripted('openai', [fail('openai', 503, true), fail('openai', 503, true), fail('openai', 503, true)]) } }, false);
    try {
      const k = fresh.key(WS1);
      fresh.credit(WS1, 10_000_000n);
      for (let i = 0; i < 3; i++) await fresh.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'openai/gpt-5.5', messages: [{ role: 'user', content: 'hi' }] }, { authorization: `Bearer ${k}` }));
      expect(fresh.services.health.state('openai')).toBe('down');
    } finally {
      await fresh.close();
    }
  });

  it('BYOK 5xx/429 failures never touch global health; credit-paid workspaces are unaffected', async () => {
    const calls: string[] = [];
    h = await makeHarness(
      { OPENAI_API_KEY: 'sk-platform' },
      { adapters: { openai: scripted('openai', [fail('openai', 503, true), fail('openai', 429, true, { code: 'rate_limited' }), fail('openai', 503, true), () => ok('platform answer')], calls) } },
      false,
    );
    const key1 = h.key(WS1);
    const enc = h.services.keyring!.encrypt('sk-user-key-1234', WS1, 'openai');
    h.services.repos.providerKeys.upsert({ id: 'pk1', workspace: WS1, provider: 'openai', ciphertext: enc.ciphertext, iv: enc.iv, tag: enc.tag, last4: '1234', baseUrl: null, createdAt: 1 });
    const body = { model: 'openai/gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }] };
    for (let i = 0; i < 3; i++) {
      const res = await h.app.request(jsonRequest('POST', '/v1/chat/completions', body, { authorization: `Bearer ${key1}`, 'x-beagle-fallback': 'none' }));
      expect([502, 429]).toContain(res.status);
    }
    expect(h.services.health.state('openai')).toBe('ok');
    const key2 = h.key(WS2);
    h.credit(WS2, 10_000_000n);
    const res = await h.app.request(jsonRequest('POST', '/v1/chat/completions', body, { authorization: `Bearer ${key2}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-beagle-paid-by')).toBe('credit');
    expect(calls).toHaveLength(4);
  });

  it('an upstream answer without usage is charged by the estimate (JSON and SSE)', async () => {
    const text = 'x'.repeat(4000);
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    h = await makeHarness(
      { OPENAI_API_KEY: 'sk-platform' },
      { adapters: { openai: scripted('openai', [() => [{ type: 'text', delta: text }, FINISH(zero)], () => [{ type: 'text', delta: text }, FINISH(zero)]]) } },
      false,
    );
    const key = h.key(WS1);
    h.credit(WS1, 10_000_000n);
    const json = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'openai/gpt-5.5', messages: [{ role: 'user', content: 'hi' }] }, { authorization: `Bearer ${key}` }));
    expect(json.status).toBe(200);
    expect(BigInt(json.headers.get('x-beagle-cost-micro') ?? '0')).toBeGreaterThan(0n);
    expect(((await json.json()) as { usage: { completion_tokens: number } }).usage.completion_tokens).toBe(1000);
    const sse = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'openai/gpt-5.5', stream: true, messages: [{ role: 'user', content: 'hi' }] }, { authorization: `Bearer ${key}` }));
    expect(sse.status).toBe(200);
    const trailer = parseSse(await sse.text()).comments.find((c) => c.startsWith('beagle cost='));
    expect(BigInt(/cost=(\d+)/.exec(trailer ?? '')?.[1] ?? '0')).toBeGreaterThan(0n);
    const rows = h.services.repos.usage.list(WS1, { limit: 2 });
    for (const row of rows) {
      expect(row.status).toBe('ok');
      expect(row.outputTokens).toBe(1000);
      expect(row.inputTokens).toBeGreaterThan(0);
      expect(row.chargedMicro).toBeGreaterThan(0n);
    }
    expect(h.services.ledger.balance(WS1)).toBe(10_000_000n - rows[0]!.chargedMicro - rows[1]!.chargedMicro);
    expect(billableUsage(zero, 7, 9)).toEqual({ usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }, estimated: true });
    expect(billableUsage({ ...zero, outputTokens: 1 }, 7, 9).estimated).toBe(false);
  });

  it('providers without a platform key are down for routing (SPEC §5.1): fallback none picks a configured one', async () => {
    const calls: string[] = [];
    h = await makeHarness({ OPENAI_API_KEY: 'sk-platform' }, { adapters: { openai: scripted('openai', [() => ok('gpt')], calls) } }, false);
    const key = h.key(WS1);
    h.credit(WS1, 10_000_000n);
    const res = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { model: 'beagle/best', messages: [{ role: 'user', content: 'hi' }] }, { authorization: `Bearer ${key}`, 'x-beagle-fallback': 'none' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-beagle-model')).toBe('openai/gpt-5.5');
    expect(res.headers.get('x-beagle-route')).toContain('anthropic down');
    expect(calls).toEqual(['openai:gpt-5.5']);
  });

  it('PROVIDER_TIMEOUT_MS is an idle timeout for streams: long generations survive, stalls do not', async () => {
    const chunk = (t: string): InternalChunk => ({ type: 'text', delta: t });
    h = await makeHarness(
      { ANTHROPIC_API_KEY: 'sk-ant', PROVIDER_TIMEOUT_MS: '1000' },
      { adapters: { anthropic: paced('anthropic', [[0, chunk('a')], [400, chunk('b')], [400, chunk('c')], [400, chunk('d')], [0, FINISH()]]) } },
      false,
    );
    const key = h.key(WS1);
    h.credit(WS1, 10_000_000n);
    const body = { model: 'anthropic/claude-haiku-5-5', stream: true, messages: [{ role: 'user', content: 'hi' }] };
    const okRes = await h.app.request(jsonRequest('POST', '/v1/chat/completions', body, { authorization: `Bearer ${key}` }));
    const okText = await okRes.text();
    expect(parseSse(okText).data.at(-1)).toBe('[DONE]');
    expect(okText).not.toContain('"error"');
    expect(h.services.repos.usage.list(WS1, { limit: 1 })[0]).toMatchObject({ status: 'ok', errorCode: null });
    await h.close();
    h = await makeHarness({ ANTHROPIC_API_KEY: 'sk-ant', PROVIDER_TIMEOUT_MS: '1000' }, { adapters: { anthropic: paced('anthropic', [[0, chunk('a')], [1500, chunk('b')], [0, FINISH()]]) } }, false);
    const key2 = h.key(WS1);
    h.credit(WS1, 10_000_000n);
    const stalled = await h.app.request(jsonRequest('POST', '/v1/chat/completions', body, { authorization: `Bearer ${key2}` }));
    const text = await stalled.text();
    expect(text).toContain('timed out');
    expect(h.services.repos.usage.list(WS1, { limit: 1 })[0]).toMatchObject({ status: 'error', errorCode: 'timeout' });
  });

  it('credit bound: max_tokens is clamped so the worst case fits available credit (or MAX_RESERVE), 402 when the prompt alone does not', async () => {
    const fable = DEFAULT_CATALOG.find((m) => m.id === 'anthropic/claude-fable-5-1')!;
    const seen: number[] = [];
    const echoMax: ProviderAdapter = {
      provider: 'anthropic',
      async complete(req) {
        seen.push(req.maxTokens);
        return { id: 'x', model: req.upstreamModel, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, finishReason: 'length', usage: { inputTokens: 4, outputTokens: req.maxTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
      async *stream() {
        throw new Error('unused');
      },
    };
    h = await makeHarness({ ANTHROPIC_API_KEY: 'sk-ant' }, { adapters: { anthropic: echoMax } }, false);
    const key = h.key(WS1);
    const nowMs = h.services.now();
    h.services.repos.workspaces.ensure(WS1, nowMs);
    h.services.repos.budgets.upsertOpened({ budgetId: 1, owner: WS1, workspace: WS1, cap: 10n ** 24n, deadline: Math.floor(nowMs / 1000) + 7200, openedBlock: 1, now: nowMs });
    h.services.repos.budgets.setHeadroom(1, 10n ** 24n, 5_000_000n, null, nowMs);
    const body = { model: 'anthropic/claude-fable-5-1', max_tokens: 128_000, messages: [{ role: 'user', content: 'hello fable' }] };
    const res = await h.app.request(jsonRequest('POST', '/v1/chat/completions', body, { authorization: `Bearer ${key}` }));
    expect(res.status).toBe(200);
    const capped = seen[0]!;
    expect(capped).toBeLessThan(128_000);
    expect(capped).toBeGreaterThan(50_000);
    const inputTokens = Math.ceil('hello fable'.length / 4);
    expect(applyMarkupBps(costMicroUsd({ inputTokens, outputTokens: capped }, fable.price), 1000)).toBeLessThanOrEqual(5_000_000n);
    expect(applyMarkupBps(costMicroUsd({ inputTokens, outputTokens: capped + 1 }, fable.price), 1000)).toBeGreaterThan(5_000_000n);
    expect(h.services.repos.usage.list(WS1, { limit: 1 })[0]?.routeReasons.some((r) => r.startsWith('credit bound'))).toBe(true);
    const charged = BigInt(res.headers.get('x-beagle-cost-micro') ?? '0');
    expect(charged).toBeLessThanOrEqual(5_000_000n); // the deficit is fully covered by the budget's headroom
    expect(h.services.repos.usage.unsettled(WS1)[0]?.chargedMicro).toBe(charged);
    // Plenty of credit → the requested max_tokens stands.
    h.credit(WS1, 100_000_000n);
    const rich = await h.app.request(jsonRequest('POST', '/v1/chat/completions', body, { authorization: `Bearer ${key}` }));
    expect(rich.status).toBe(200);
    expect(seen[1]).toBe(128_000);
    expect(h.services.repos.usage.list(WS1, { limit: 1 })[0]?.routeReasons.some((r) => r.startsWith('credit bound'))).toBe(false);
    expect(maxTokensWithinBound({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(40_000) }] }], maxTokens: 10, stream: false }, fable, 20_000n, 1000)).toBeUndefined();
    await h.close();
    // The prompt alone exceeds the bound → 402 before anything is sent upstream.
    h = await makeHarness({ ANTHROPIC_API_KEY: 'sk-ant', MAX_RESERVE_USD: '0.02' }, { adapters: { anthropic: echoMax } }, false);
    const key2 = h.key(WS1);
    h.credit(WS1, 20_000n);
    const poor = await h.app.request(jsonRequest('POST', '/v1/chat/completions', { ...body, messages: [{ role: 'user', content: 'x'.repeat(40_000) }] }, { authorization: `Bearer ${key2}` }));
    expect(poor.status).toBe(402);
    expect(await poor.json()).toMatchObject({ error: { code: 'insufficient_credit' } });
    expect(seen).toHaveLength(2);
    expect(h.services.ledger.balance(WS1)).toBe(20_000n);
  });
});

describe('health store', () => {
  it('opens after 3 retryable failures, half-opens after the window, doubles, resets on success', () => {
    let now = 1_000_000;
    const hs = new HealthStore(undefined, () => now);
    const err = new ProviderError({ provider: 'openai', status: 500, code: 'upstream_error', message: 'x', retryable: true });
    const nonRetryable = new ProviderError({ provider: 'openai', status: 400, code: 'bad_request', message: 'x', retryable: false });
    hs.recordFailure('openai', nonRetryable, 'platform');
    hs.recordFailure('openai', err, 'platform');
    hs.recordFailure('openai', err, 'platform');
    expect(hs.state('openai')).toBe('ok');
    hs.recordFailure('openai', err, 'platform');
    expect(hs.state('openai')).toBe('down');
    now += HEALTH_OPEN_MS;
    expect(hs.state('openai')).toBe('degraded');
    hs.recordFailure('openai', err, 'platform'); // trial failed → reopen, doubled
    expect(hs.state('openai')).toBe('down');
    now += HEALTH_OPEN_MS;
    expect(hs.state('openai')).toBe('down');
    now += HEALTH_OPEN_MS;
    expect(hs.state('openai')).toBe('degraded');
    hs.recordSuccess('openai');
    expect(hs.state('openai')).toBe('ok');
    expect(hs.snapshot().openai).toEqual({ state: 'ok' });
  });

  it('platform auth failures open immediately; BYOK failures of any kind never touch health', () => {
    const hs = new HealthStore(undefined, () => 1);
    const auth = new ProviderError({ provider: 'google', status: 401, code: 'auth', message: 'x', retryable: true, authFailure: true });
    hs.recordFailure('google', auth, 'byok');
    expect(hs.state('google')).toBe('ok');
    const quota = new ProviderError({ provider: 'google', status: 429, code: 'rate_limited', message: 'x', retryable: true });
    const down = new ProviderError({ provider: 'google', status: 503, code: 'upstream_error', message: 'x', retryable: true });
    for (const e of [quota, quota, down, down, networkError('google', new Error('ECONNRESET'))]) hs.recordFailure('google', e, 'byok');
    expect(hs.state('google')).toBe('ok');
    hs.recordFailure('google', auth, 'platform');
    expect(hs.state('google')).toBe('down');
  });

  it('failures outside the 60 s window do not count', () => {
    let now = 0;
    const hs = new HealthStore(undefined, () => now);
    const err = new ProviderError({ provider: 'house', status: 502, code: 'upstream_error', message: 'x', retryable: true });
    hs.recordFailure('house', err, 'platform');
    now += 61_000;
    hs.recordFailure('house', err, 'platform');
    now += 1;
    hs.recordFailure('house', err, 'platform');
    expect(hs.state('house')).toBe('ok');
  });
});

describe('model catalog availability', () => {
  it('marks platform-less providers unavailable', async () => {
    const h = await makeHarness({}, {}, false);
    try {
      const models = (await (await h.app.request('/api/models')).json()) as { models: (ModelSpec & { available: boolean; providerState: string })[] };
      expect(models.models.every((m) => !m.available)).toBe(true);
      expect(models.models[0]?.providerState).toBe('down');
    } finally {
      await h.close();
    }
  });
});

void BASE;
