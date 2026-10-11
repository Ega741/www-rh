import { afterEach, describe, expect, it } from 'vitest';
import type { ModelSpec } from '@beagle/shared/models';
import { HEALTH_OPEN_MS, HealthStore } from '../src/router/health.js';
import { ProviderError, type ProviderAdapter } from '../src/providers/types.js';
import type { InternalChunk, InternalRequestBase } from '../src/translate/internal.js';
import { jsonRequest, makeHarness, parseSse, WS1, type Harness } from './helpers.js';

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

  it('platform auth failures open immediately; BYOK auth failures never touch health', () => {
    const hs = new HealthStore(undefined, () => 1);
    const auth = new ProviderError({ provider: 'google', status: 401, code: 'auth', message: 'x', retryable: true, authFailure: true });
    hs.recordFailure('google', auth, 'byok');
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
