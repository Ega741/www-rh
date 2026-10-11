import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_ERROR_TYPE,
  ChatCompletionChunkSchema,
  ChatCompletionRequestSchema,
  ChatCompletionSchema,
  ERROR_STATUS,
  OPENAI_ERROR_CODES,
  OpenAiErrorBodySchema,
  OpenAiModelListSchema,
  SSE_DONE,
  anthropicError,
  buildChatCompletion,
  buildChatCompletionChunk,
  formatSseBeagleTrailer,
  formatSseData,
  isOpenAiErrorCode,
  openAiError,
  requestedMaxTokens,
  toOpenAiUsage,
} from '../src/openai.js';

describe('ChatCompletionRequestSchema', () => {
  it('accepts a minimal request and passes unknown fields through', () => {
    const parsed = ChatCompletionRequestSchema.parse({ model: 'beagle/auto', messages: [{ role: 'user', content: 'hi' }], foo: { bar: 1 } });
    expect(parsed.model).toBe('beagle/auto');
    expect(parsed.messages[0]).toEqual({ role: 'user', content: 'hi' });
    expect((parsed as Record<string, unknown>)['foo']).toEqual({ bar: 1 });
  });

  it('accepts the full feature set of SPEC §5.8', () => {
    const parsed = ChatCompletionRequestSchema.parse({
      model: 'anthropic/claude-opus-5-5',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'developer', content: [{ type: 'text', text: 'dev' }] },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp":20}' },
        { role: 'assistant', content: 'It is 20°C.' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} }, strict: true } }],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      response_format: { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' }, strict: true } },
      max_completion_tokens: 100,
      temperature: 0.5,
      top_p: 0.9,
      stop: ['END'],
      reasoning_effort: 'high',
      stream: true,
      stream_options: { include_usage: true },
      user: 'u',
      n: 1,
      seed: 7,
      parallel_tool_calls: false,
      metadata: { k: 'v' },
    });
    expect(parsed.tools?.[0]?.function.name).toBe('get_weather');
    expect(parsed.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    expect(parsed.response_format?.type).toBe('json_schema');
    expect(parsed.stream).toBe(true);
    expect(parsed.messages).toHaveLength(6);
  });

  it('accepts nulls for optional scalars (OpenAI SDK defaults)', () => {
    const parsed = ChatCompletionRequestSchema.parse({ model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: null, max_tokens: null, stop: null, tool_choice: null, tools: null, stream_options: null, n: null });
    expect(parsed.temperature).toBeNull();
  });

  it('rejects invalid requests', () => {
    const base = { model: 'm', messages: [{ role: 'user', content: 'x' }] };
    expect(ChatCompletionRequestSchema.safeParse({ ...base, n: 2 }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, messages: [] }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, model: '' }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ model: 'm' }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, messages: [{ role: 'robot', content: 'x' }] }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, messages: [{ role: 'user', content: [{ type: 'audio', data: 'x' }] }] }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, messages: [{ role: 'tool', content: 'x' }] }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, reasoning_effort: 'ultra' }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, temperature: 3 }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, max_tokens: 0 }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, stop: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, tools: [{ type: 'function', function: { name: 'bad name' } }] }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, tool_choice: 'maybe' }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ ...base, response_format: { type: 'xml' } }).success).toBe(false);
  });

  it('requestedMaxTokens prefers max_completion_tokens', () => {
    expect(requestedMaxTokens({ max_tokens: 10, max_completion_tokens: 20 })).toBe(20);
    expect(requestedMaxTokens({ max_tokens: 10 })).toBe(10);
    expect(requestedMaxTokens({ max_tokens: null, max_completion_tokens: null })).toBe(4096);
    expect(requestedMaxTokens({}, 99)).toBe(99);
  });
});

describe('builders', () => {
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 };

  it('toOpenAiUsage folds cached tokens into prompt_tokens', () => {
    expect(toOpenAiUsage(usage)).toEqual({ prompt_tokens: 13, completion_tokens: 5, total_tokens: 18, prompt_tokens_details: { cached_tokens: 3 } });
    expect(toOpenAiUsage({ inputTokens: 1, outputTokens: 2 })).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    expect(toOpenAiUsage({ inputTokens: 1, outputTokens: 2, cacheWriteTokens: 4 }).prompt_tokens).toBe(5);
  });

  it('buildChatCompletion produces a valid chat.completion', () => {
    const completion = buildChatCompletion({ id: 'req_1', created: 1_760_000_000, model: 'house/gpt-oss-20b', content: 'hello', finishReason: 'stop', usage });
    expect(ChatCompletionSchema.parse(completion)).toEqual(completion);
    expect(completion).toEqual({
      id: 'req_1',
      object: 'chat.completion',
      created: 1_760_000_000,
      model: 'house/gpt-oss-20b',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello', refusal: null }, finish_reason: 'stop', logprobs: null }],
      usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18, prompt_tokens_details: { cached_tokens: 3 } },
    });
    expect('tool_calls' in completion.choices[0]!.message).toBe(false);
    expect('system_fingerprint' in completion).toBe(false);
  });

  it('buildChatCompletion includes tool calls and fingerprint when given', () => {
    const toolCalls = [{ id: 'call_1', type: 'function' as const, function: { name: 'f', arguments: '{}' } }];
    const completion = buildChatCompletion({ id: 'req_2', created: 1, model: 'm', content: null, toolCalls, finishReason: 'tool_calls', usage, systemFingerprint: 'fp', refusal: 'no' });
    expect(ChatCompletionSchema.safeParse(completion).success).toBe(true);
    expect(completion.choices[0]?.message.tool_calls).toEqual(toolCalls);
    expect(completion.choices[0]?.message.refusal).toBe('no');
    expect(completion.system_fingerprint).toBe('fp');
    expect(buildChatCompletion({ id: 'r', created: 1, model: 'm', content: 'x', toolCalls: [], finishReason: 'stop', usage }).choices[0]?.message.tool_calls).toBeUndefined();
  });

  it('buildChatCompletionChunk builds delta, finish and usage-only chunks', () => {
    const delta = buildChatCompletionChunk({ id: 'req_1', created: 1, model: 'm', delta: { role: 'assistant', content: 'he' } });
    expect(ChatCompletionChunkSchema.parse(delta)).toEqual(delta);
    expect(delta).toEqual({ id: 'req_1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'he' }, finish_reason: null, logprobs: null }] });
    expect('usage' in delta).toBe(false);

    const tool = buildChatCompletionChunk({ id: 'req_1', created: 1, model: 'm', delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{' } }] } });
    expect(ChatCompletionChunkSchema.safeParse(tool).success).toBe(true);

    const finish = buildChatCompletionChunk({ id: 'req_1', created: 1, model: 'm', delta: {}, finishReason: 'stop', usage: null });
    expect(finish.choices[0]?.finish_reason).toBe('stop');
    expect(finish.usage).toBeNull();
    expect(ChatCompletionChunkSchema.safeParse(finish).success).toBe(true);

    const usageOnly = buildChatCompletionChunk({ id: 'req_1', created: 1, model: 'm', usage });
    expect(usageOnly.choices).toEqual([]);
    expect(usageOnly.usage).toEqual(toOpenAiUsage(usage));
    expect(ChatCompletionChunkSchema.safeParse(usageOnly).success).toBe(true);

    const withChoice = buildChatCompletionChunk({ id: 'req_1', created: 1, model: 'm', usage, usageOnly: false, systemFingerprint: 'fp' });
    expect(withChoice.choices).toHaveLength(1);
    expect(withChoice.system_fingerprint).toBe('fp');

    const finishWithUsage = buildChatCompletionChunk({ id: 'req_1', created: 1, model: 'm', finishReason: 'length', usage });
    expect(finishWithUsage.choices).toEqual([{ index: 0, delta: {}, finish_reason: 'length', logprobs: null }]);
  });

  it('SSE helpers', () => {
    expect(formatSseData({ a: 1 })).toBe('data: {"a":1}\n\n');
    expect(SSE_DONE).toBe('data: [DONE]\n\n');
    expect(formatSseBeagleTrailer(6n, 9_980_000n)).toBe(': beagle cost=6 balance=9980000\n\n');
  });

  it('OpenAiModelListSchema', () => {
    const list = { object: 'list', data: [{ id: 'beagle/auto', object: 'model', created: 1, owned_by: 'beagle', beagle: { tier: null, price: null, available: true, requiresPlan: null, alias: true } }, { id: 'house/gpt-oss-20b', object: 'model', created: 1, owned_by: 'house' }] };
    expect(OpenAiModelListSchema.parse(list)).toEqual(list);
    expect(OpenAiModelListSchema.safeParse({ object: 'list', data: [{ id: 'x', object: 'thing', created: 1, owned_by: 'y' }] }).success).toBe(false);
  });
});

describe('errors (SPEC §5.8)', () => {
  it('maps every code to the specified status', () => {
    expect(ERROR_STATUS).toEqual({
      invalid_request_error: 400,
      invalid_api_key: 401,
      insufficient_credit: 402,
      plan_required: 403,
      model_not_found: 404,
      rate_limited: 429,
      upstream_rate_limited: 429,
      upstream_error: 502,
      no_model_available: 503,
      request_too_large: 413,
      internal_error: 500,
    });
    expect(OPENAI_ERROR_CODES).toHaveLength(11);
    expect(isOpenAiErrorCode('rate_limited')).toBe(true);
    expect(isOpenAiErrorCode('teapot')).toBe(false);
  });

  it('openAiError builds the envelope of SPEC §5.7', () => {
    const e = openAiError('insufficient_credit', 'Insufficient credit: burn BEAGLE on the Credits page or open a budget.');
    expect(e).toEqual({
      status: 402,
      body: {
        error: {
          message: 'Insufficient credit: burn BEAGLE on the Credits page or open a budget.',
          type: 'insufficient_credit',
          code: 'insufficient_credit',
          param: null,
        },
      },
    });
    expect(OpenAiErrorBodySchema.parse(e.body)).toEqual(e.body);
    const custom = openAiError('invalid_request_error', 'n must be 1', 400, { param: 'n', type: 'invalid_request_error' });
    expect(custom.body.error.param).toBe('n');
    expect(openAiError('upstream_error', 'boom', 504).status).toBe(504);
    for (const code of OPENAI_ERROR_CODES) expect(openAiError(code, 'm').status).toBe(ERROR_STATUS[code]);
  });

  it('anthropicError uses the Anthropic envelope and the insufficient_credit prefix', () => {
    expect(anthropicError('insufficient_credit', 'burn BEAGLE')).toEqual({
      status: 402,
      body: { type: 'error', error: { type: 'invalid_request_error', message: 'insufficient_credit: burn BEAGLE' } },
    });
    expect(anthropicError('insufficient_credit', 'insufficient_credit: already').body.error.message).toBe('insufficient_credit: already');
    expect(anthropicError('invalid_api_key', 'nope')).toEqual({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'nope' } } });
    expect(anthropicError('rate_limited', 'slow', 429).body.error.type).toBe('rate_limit_error');
    expect(anthropicError('model_not_found', 'x').body.error.type).toBe('not_found_error');
    for (const code of OPENAI_ERROR_CODES) expect(typeof ANTHROPIC_ERROR_TYPE[code]).toBe('string');
  });
});
