import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnthropicAdapter, mapAnthropicError, parseAnthropicMessage, type AnthropicClientLike } from '../src/providers/anthropic.js';
import { createOpenAiCompatAdapter, SseParser, usageFromOpenAi } from '../src/providers/openaiCompat.js';
import { assertSafeBaseUrl, isPrivateAddress, UnsafeBaseUrlError } from '../src/providers/registry.js';
import { classifyStatus, ProviderError, parseRetryAfter, type Credentials } from '../src/providers/types.js';
import { ChunkAssembler, type InternalChunk, type InternalRequest } from '../src/translate/internal.js';
import { startMockProvider, type MockProvider } from './helpers.js';

const REQ: InternalRequest = {
  upstreamModel: 'openai/gpt-oss-20b',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello there' }] }],
  maxTokens: 20,
  stream: false,
  metadata: { requestId: 'req_t', workspace: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' },
};

async function collect(it: AsyncIterable<InternalChunk>): Promise<InternalChunk[]> {
  const out: InternalChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('SSE parser', () => {
  it('handles partial frames, CRLF, comments and multi-line data', () => {
    const p = new SseParser();
    expect(p.feed('data: {"a"')).toEqual([]);
    expect(p.feed(':1}\n\n: comment\r\nevent: x\r\ndata: line1\r\ndata: line2\r\n\r\n')).toEqual([
      { event: undefined, data: '{"a":1}' },
      { event: 'x', data: 'line1\nline2' },
    ]);
    expect(p.feed('data: [DONE]')).toEqual([]);
    expect(p.end()).toEqual([{ event: undefined, data: '[DONE]' }]);
  });
});

describe('OpenAI-compatible adapter', () => {
  let mock: MockProvider;
  beforeAll(async () => {
    mock = await startMockProvider();
  });
  afterAll(async () => mock.close());

  const creds = (): Credentials => ({ kind: 'platform', key: '', baseUrl: mock.url });
  const adapter = createOpenAiCompatAdapter({ provider: 'house' });

  it('completes and maps usage; no auth header for an empty key', async () => {
    mock.options.status = 0;
    const res = await adapter.complete(REQ, creds(), AbortSignal.timeout(5000));
    expect(res.message.content).toEqual([{ type: 'text', text: 'echo: hello there' }]);
    expect(res.finishReason).toBe('stop');
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(mock.requests.at(-1)?.headers['authorization']).toBeUndefined();
    const withKey = await adapter.complete(REQ, { kind: 'platform', key: 'house-key', baseUrl: mock.url }, AbortSignal.timeout(5000));
    expect(withKey.id).toMatch(/^chatcmpl-mock/);
    expect(mock.requests.at(-1)?.headers['authorization']).toBe('Bearer house-key');
  });

  it('streams text and tool calls through split frames and reports usage', async () => {
    mock.options.status = 0;
    delete mock.options.toolCall;
    const chunks = await collect(adapter.stream({ ...REQ, stream: true }, creds(), AbortSignal.timeout(5000)));
    const asm = new ChunkAssembler();
    for (const c of chunks) asm.push(c);
    expect(asm.response('r', 'm').message.content).toEqual([{ type: 'text', text: 'echo: hello there' }]);
    const finish = chunks.at(-1);
    expect(finish?.type).toBe('finish');
    if (finish?.type === 'finish') expect(finish.usage.outputTokens).toBeGreaterThan(0);

    mock.options.toolCall = { name: 'lookup', arguments: '{"city":"Paris","units":"metric"}' };
    const toolChunks = await collect(adapter.stream({ ...REQ, stream: true }, creds(), AbortSignal.timeout(5000)));
    delete mock.options.toolCall;
    const asm2 = new ChunkAssembler();
    for (const c of toolChunks) asm2.push(c);
    const r = asm2.response('r', 'm');
    expect(r.message.content).toEqual([{ type: 'tool_call', id: 'call_1', name: 'lookup', arguments: '{"city":"Paris","units":"metric"}' }]);
    expect(r.finishReason).toBe('tool_calls');
    expect(mock.requests.at(-1)?.body['stream_options']).toEqual({ include_usage: true });
  });

  it('maps 429 (retryable, Retry-After) and 500 (retryable) and 400 (not retryable)', async () => {
    mock.options.status = 429;
    const e429 = await adapter.complete(REQ, creds(), AbortSignal.timeout(5000)).catch((e: unknown) => e);
    expect(ProviderError.is(e429)).toBe(true);
    if (ProviderError.is(e429)) {
      expect(e429.status).toBe(429);
      expect(e429.retryable).toBe(true);
      expect(e429.retryAfterSec).toBe(7);
    }
    mock.options.status = 500;
    const e500 = await adapter.complete(REQ, creds(), AbortSignal.timeout(5000)).catch((e: unknown) => e);
    expect(ProviderError.is(e500) && e500.retryable && e500.status === 500).toBe(true);
    const s500 = await adapter.stream({ ...REQ, stream: true }, creds(), AbortSignal.timeout(5000))[Symbol.asyncIterator]().next().catch((e: unknown) => e);
    expect(ProviderError.is(s500) && s500.retryable).toBe(true);
    mock.options.status = 400;
    const e400 = await adapter.complete(REQ, creds(), AbortSignal.timeout(5000)).catch((e: unknown) => e);
    expect(ProviderError.is(e400) && !e400.retryable && e400.message.includes('mock forced 400')).toBe(true);
    mock.options.status = 401;
    const byok = await adapter.complete(REQ, { kind: 'byok', key: 'k', baseUrl: mock.url }, AbortSignal.timeout(5000)).catch((e: unknown) => e);
    expect(ProviderError.is(byok) && byok.authFailure && !byok.retryable).toBe(true);
    const platform = await adapter.complete(REQ, creds(), AbortSignal.timeout(5000)).catch((e: unknown) => e);
    expect(ProviderError.is(platform) && platform.authFailure && platform.retryable).toBe(true);
    mock.options.status = 0;
  });

  it('turns a mid-stream disconnect into an error chunk after the first byte', async () => {
    mock.options.breakStream = true;
    const chunks = await collect(adapter.stream({ ...REQ, stream: true }, creds(), AbortSignal.timeout(5000)));
    mock.options.breakStream = false;
    expect(chunks[0]).toEqual({ type: 'text', delta: 'echo:' });
    expect(chunks.at(-1)?.type).toBe('error');
  });

  it('network failures and timeouts are retryable', async () => {
    const dead = createOpenAiCompatAdapter({ provider: 'openai' });
    const e = await dead.complete(REQ, { kind: 'platform', key: 'k', baseUrl: 'http://127.0.0.1:1/v1' }, AbortSignal.timeout(5000)).catch((x: unknown) => x);
    expect(ProviderError.is(e) && e.retryable && e.status === 0).toBe(true);
    mock.options.delayMs = 300;
    const slow = await adapter.complete(REQ, creds(), AbortSignal.timeout(50)).catch((x: unknown) => x);
    mock.options.delayMs = 0;
    expect(ProviderError.is(slow) && slow.code === 'timeout').toBe(true);
  });

  it('usageFromOpenAi carves cached tokens out of the prompt', () => {
    expect(usageFromOpenAi({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } })).toEqual({ inputTokens: 60, outputTokens: 5, cacheReadTokens: 40, cacheWriteTokens: 0 });
    expect(usageFromOpenAi(null)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});

describe('Anthropic adapter (fake client)', () => {
  const message = (overrides: Partial<Anthropic.Message> = {}): Anthropic.Message =>
    ({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: 'hi!', citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 2, cache_creation: null, server_tool_use: null, service_tier: null, inference_geo: null, output_tokens_details: null },
      container: null,
      ...overrides,
    }) as Anthropic.Message;

  function fakeClient(impl: Partial<AnthropicClientLike['messages']>, seen: unknown[] = []): AnthropicClientLike {
    return {
      messages: {
        create: async (params) => {
          seen.push(params);
          if (impl.create) return impl.create(params);
          return message();
        },
        stream: (params) => {
          seen.push(params);
          if (impl.stream) return impl.stream(params);
          return (async function* () {})();
        },
      },
    };
  }

  const creds: Credentials = { kind: 'platform', key: 'sk-ant-test', baseUrl: '' };

  it('complete maps content, stop reason and cache usage; builds params without thinking', async () => {
    const seen: Anthropic.MessageCreateParams[] = [];
    const adapter = createAnthropicAdapter({ timeoutMs: 1000, clientFactory: () => fakeClient({}, seen) });
    const res = await adapter.complete({ ...REQ, upstreamModel: 'claude-sonnet-5-5', reasoningEffort: 'high' }, creds, AbortSignal.timeout(1000));
    expect(res.message.content).toEqual([{ type: 'text', text: 'hi!' }]);
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 3, cacheReadTokens: 7, cacheWriteTokens: 2 });
    expect(res.finishReason).toBe('stop');
    expect(seen[0]).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 20, stream: false, output_config: { effort: 'high' } });
    expect((seen[0] as unknown as Record<string, unknown>)['thinking']).toBeUndefined();
    expect((seen[0] as unknown as Record<string, unknown>)['tool_choice']).toBeUndefined();
  });

  it('parses tool_use blocks and refusal', () => {
    const r = parseAnthropicMessage(message({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'f', input: { a: 1 }, caller: { type: 'direct' } } as Anthropic.ToolUseBlock], stop_reason: 'tool_use' }));
    expect(r.message.content).toEqual([{ type: 'tool_call', id: 'toolu_1', name: 'f', arguments: '{"a":1}' }]);
    expect(r.finishReason).toBe('tool_calls');
    expect(parseAnthropicMessage(message({ stop_reason: 'refusal' })).finishReason).toBe('content_filter');
    expect(parseAnthropicMessage(message({ stop_reason: 'max_tokens' })).finishReason).toBe('length');
  });

  it('streams text, input_json_delta and message_delta usage', async () => {
    const events: Anthropic.RawMessageStreamEvent[] = [
      { type: 'message_start', message: message({ content: [], usage: { ...message().usage, output_tokens: 0 } }) },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'get', input: {}, caller: { type: 'direct' } } as Anthropic.ToolUseBlock },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"x"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null, container: null }, usage: { output_tokens: 9, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, server_tool_use: null, output_tokens_details: null } } as Anthropic.RawMessageDeltaEvent,
      { type: 'message_stop' },
    ];
    const adapter = createAnthropicAdapter({
      timeoutMs: 1000,
      clientFactory: () =>
        fakeClient({
          stream: () =>
            (async function* () {
              for (const e of events) yield e;
            })(),
        }),
    });
    const chunks = await collect(adapter.stream({ ...REQ, stream: true }, creds, AbortSignal.timeout(1000)));
    const asm = new ChunkAssembler();
    for (const c of chunks) asm.push(c);
    const r = asm.response('r', 'm');
    expect(r.message.content).toEqual([{ type: 'text', text: 'Hello' }, { type: 'tool_call', id: 'toolu_9', name: 'get', arguments: '{"q":"x"}' }]);
    expect(r.finishReason).toBe('tool_calls');
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 9, cacheReadTokens: 7, cacheWriteTokens: 2 });
  });

  it('maps SDK errors by class, most specific first', () => {
    const headers = new Headers({ 'retry-after': '12' });
    const rl = mapAnthropicError(new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', headers), 'platform');
    expect(rl).toMatchObject({ status: 429, retryable: true, retryAfterSec: 12, code: 'rate_limited' });
    const authByok = mapAnthropicError(new Anthropic.AuthenticationError(401, {}, 'bad key', new Headers()), 'byok');
    expect(authByok).toMatchObject({ status: 401, retryable: false, authFailure: true });
    const authPlatform = mapAnthropicError(new Anthropic.PermissionDeniedError(403, {}, 'nope', new Headers()), 'platform');
    expect(authPlatform).toMatchObject({ status: 403, retryable: true, authFailure: true });
    const bad = mapAnthropicError(Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: too big' } }, undefined, new Headers()), 'platform');
    expect(bad).toMatchObject({ status: 400, retryable: false });
    expect(bad.message).toContain('max_tokens: too big');
    expect(bad.cause).toBeInstanceOf(Anthropic.BadRequestError);
    const conn = mapAnthropicError(new Anthropic.APIConnectionError({ message: 'ECONNRESET' }), 'platform');
    expect(conn).toMatchObject({ status: 0, retryable: true });
    const timeout = mapAnthropicError(new Anthropic.APIConnectionTimeoutError(), 'platform');
    expect(timeout.code).toBe('timeout');
    const overloaded = mapAnthropicError(new Anthropic.InternalServerError(529, {}, 'overloaded', new Headers()), 'platform');
    expect(overloaded).toMatchObject({ status: 529, retryable: true });
    const unknown = mapAnthropicError(new Error('weird'), 'platform');
    expect(unknown.retryable).toBe(true);
  });

  it('adapter.complete rethrows mapped errors; stream errors before the first event reject', async () => {
    const adapter = createAnthropicAdapter({
      timeoutMs: 1000,
      clientFactory: () =>
        fakeClient({
          create: async () => {
            throw new Anthropic.RateLimitError(429, {}, 'rl', new Headers());
          },
          stream: () =>
            (async function* () {
              throw new Anthropic.InternalServerError(500, {}, 'boom', new Headers());
            })(),
        }),
    });
    const e = await adapter.complete(REQ, creds, AbortSignal.timeout(1000)).catch((x: unknown) => x);
    expect(ProviderError.is(e) && e.status === 429).toBe(true);
    const s = await adapter.stream({ ...REQ, stream: true }, creds, AbortSignal.timeout(1000))[Symbol.asyncIterator]().next().catch((x: unknown) => x);
    expect(ProviderError.is(s) && s.status === 500 && s.retryable).toBe(true);
  });
});

describe('status classification and SSRF guard', () => {
  it('classifyStatus follows SPEC §5.5', () => {
    expect(classifyStatus('openai', 429, 'platform', 'x')).toMatchObject({ retryable: true, code: 'rate_limited' });
    expect(classifyStatus('openai', 401, 'byok', 'x')).toMatchObject({ retryable: false, authFailure: true });
    expect(classifyStatus('openai', 403, 'platform', 'x')).toMatchObject({ retryable: true, authFailure: true });
    expect(classifyStatus('openai', 404, 'platform', 'x')).toMatchObject({ retryable: false });
    expect(classifyStatus('openai', 422, 'platform', 'x')).toMatchObject({ retryable: false });
    expect(classifyStatus('openai', 503, 'platform', 'x')).toMatchObject({ retryable: true });
    expect(parseRetryAfter('3')).toBe(3);
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThanOrEqual(4);
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('isPrivateAddress and assertSafeBaseUrl', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '104.18.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
    const lookup = async (host: string): Promise<string[]> => (host === 'evil.example' ? ['10.0.0.9'] : ['104.18.0.1']);
    await expect(assertSafeBaseUrl('https://api.openai.com/v1', lookup)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeBaseUrl('http://api.openai.com/v1', lookup)).rejects.toBeInstanceOf(UnsafeBaseUrlError);
    await expect(assertSafeBaseUrl('https://evil.example/v1', lookup)).rejects.toThrow(/private/);
    await expect(assertSafeBaseUrl('https://127.0.0.1/v1', lookup)).rejects.toBeInstanceOf(UnsafeBaseUrlError);
    await expect(assertSafeBaseUrl('https://user:pw@api.openai.com/v1', lookup)).rejects.toBeInstanceOf(UnsafeBaseUrlError);
    await expect(assertSafeBaseUrl('https://metadata.internal/', lookup)).rejects.toBeInstanceOf(UnsafeBaseUrlError);
    await expect(assertSafeBaseUrl('not a url', lookup)).rejects.toBeInstanceOf(UnsafeBaseUrlError);
  });
});
