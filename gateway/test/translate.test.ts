import { ChatCompletionRequestSchema } from '@beagle/shared/openai';
import { describe, expect, it } from 'vitest';
import { AnthropicMessagesRequestSchema, fromAnthropic } from '../src/translate/fromAnthropic.js';
import { fromOpenAI } from '../src/translate/fromOpenAI.js';
import { ChunkAssembler, RequestValidationError, type InternalChunk, type InternalResponse } from '../src/translate/internal.js';
import { AnthropicStreamEncoder, toAnthropicMessage } from '../src/translate/toAnthropic.js';
import { OpenAiChunkEncoder, toChatCompletion } from '../src/translate/toOpenAI.js';
import { buildAnthropicParams } from '../src/providers/anthropic.js';
import { buildOpenAiBody } from '../src/providers/openaiCompat.js';

const META = { requestId: 'req_1', workspace: '46WBYp3PQAdDmjJ2MH3Duz3nm6WN7ZZMDhxZqcB9XF2k' };

describe('fromOpenAI', () => {
  it('translates text, images, tools, tool results and options', () => {
    const req = ChatCompletionRequestSchema.parse({
      model: 'beagle/auto',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'result' },
        { role: 'user', content: 'thanks' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'number' } } } } }],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
      response_format: { type: 'json_object' },
      max_completion_tokens: 77,
      temperature: 0.2,
      stop: 'END',
      reasoning_effort: 'xhigh',
      stream: true,
    });
    const r = fromOpenAI(req);
    expect(r.messages).toHaveLength(5);
    expect(r.messages[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'be terse' }] });
    expect(r.messages[1]?.content[1]).toEqual({ type: 'image', base64: 'AAAA', mediaType: 'image/png' });
    expect(r.messages[2]?.content[0]).toEqual({ type: 'tool_call', id: 'call_1', name: 'lookup', arguments: '{"q":1}' });
    expect(r.messages[3]).toMatchObject({ role: 'tool', toolCallId: 'call_1', content: [{ type: 'tool_result', toolCallId: 'call_1', content: 'result' }] });
    expect(r.tools?.[0]?.name).toBe('lookup');
    expect(r.toolChoice).toEqual({ name: 'lookup' });
    expect(r.responseFormat).toEqual({ type: 'json_object' });
    expect(r.maxTokens).toBe(77);
    expect(r.temperature).toBe(0.2);
    expect(r.stop).toEqual(['END']);
    expect(r.reasoningEffort).toBe('high');
    expect(r.stream).toBe(true);
  });

  it('defaults max tokens to 4096 and rejects tool_choice without tools', () => {
    const r = fromOpenAI(ChatCompletionRequestSchema.parse({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }));
    expect(r.maxTokens).toBe(4096);
    expect(r.stream).toBe(false);
    expect(() => fromOpenAI(ChatCompletionRequestSchema.parse({ model: 'x', messages: [{ role: 'user', content: 'hi' }], tool_choice: 'required' }))).toThrow(RequestValidationError);
  });

  it('schema rejects n != 1 and unknown roles', () => {
    expect(ChatCompletionRequestSchema.safeParse({ model: 'x', messages: [{ role: 'user', content: 'hi' }], n: 2 }).success).toBe(false);
    expect(ChatCompletionRequestSchema.safeParse({ model: 'x', messages: [{ role: 'robot', content: 'hi' }] }).success).toBe(false);
  });
});

describe('toOpenAI', () => {
  const resp: InternalResponse = {
    id: 'up_1',
    model: 'gpt-x',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'tool_call', id: 'call_9', name: 'f', arguments: '{}' }] },
    finishReason: 'tool_calls',
    usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 0 },
  };

  it('renders chat.completion with catalog id, request id and usage incl. cached tokens', () => {
    const c = toChatCompletion(resp, { id: 'req_1', created: 1, model: 'openai/gpt-5.5' });
    expect(c.id).toBe('req_1');
    expect(c.model).toBe('openai/gpt-5.5');
    expect(c.choices[0]?.message.content).toBe('hello');
    expect(c.choices[0]?.message.tool_calls?.[0]).toEqual({ id: 'call_9', type: 'function', function: { name: 'f', arguments: '{}' } });
    expect(c.choices[0]?.finish_reason).toBe('tool_calls');
    expect(c.usage).toEqual({ prompt_tokens: 13, completion_tokens: 4, total_tokens: 17, prompt_tokens_details: { cached_tokens: 3 } });
  });

  it('puts a refusal in `refusal` with `content: null`', () => {
    const refused = toChatCompletion({ ...resp, message: { role: 'assistant', content: [{ type: 'text', text: "I can't help with that" }] }, finishReason: 'content_filter' }, { id: 'req_1', created: 1, model: 'm' });
    expect(refused.choices[0]?.message).toMatchObject({ content: null, refusal: "I can't help with that" });
    expect(refused.choices[0]?.finish_reason).toBe('content_filter');
    const plain = toChatCompletion({ ...resp, message: { role: 'assistant', content: [{ type: 'text', text: 'sure' }] }, finishReason: 'stop' }, { id: 'req_1', created: 1, model: 'm' });
    expect(plain.choices[0]?.message).toMatchObject({ content: 'sure', refusal: null });
  });

  it('streams chunks with a role on the first delta and reassembles', () => {
    const enc = new OpenAiChunkEncoder({ id: 'req_1', created: 1, model: 'house/gpt-oss-20b' }, true);
    const chunks: InternalChunk[] = [
      { type: 'text', delta: 'he' },
      { type: 'text', delta: 'llo' },
      { type: 'tool_call', index: 0, id: 'call_1', name: 'f', argumentsDelta: '{"a"' },
      { type: 'tool_call', index: 0, argumentsDelta: ':1}' },
      { type: 'finish', finishReason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ];
    const out = chunks.flatMap((c) => enc.encode(c));
    expect(out[0]?.choices[0]?.delta).toEqual({ role: 'assistant', content: 'he' });
    expect(out[1]?.choices[0]?.delta).toEqual({ content: 'llo' });
    expect(out[2]?.choices[0]?.delta.tool_calls?.[0]).toMatchObject({ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a"' } });
    expect(out[3]?.choices[0]?.delta.tool_calls?.[0]).toEqual({ index: 0, function: { arguments: ':1}' } });
    expect(out[4]?.choices[0]?.finish_reason).toBe('tool_calls');
    expect(out[5]?.choices).toEqual([]);
    expect(out[5]?.usage?.total_tokens).toBe(3);
    const asm = new ChunkAssembler();
    for (const c of chunks) asm.push(c);
    const r = asm.response('req_1', 'm');
    expect(r.message.content).toEqual([{ type: 'text', text: 'hello' }, { type: 'tool_call', id: 'call_1', name: 'f', arguments: '{"a":1}' }]);
    expect(r.finishReason).toBe('tool_calls');
  });
});

describe('fromAnthropic / toAnthropic', () => {
  it('translates system, blocks, tool_use/tool_result and rejects forced tool choice', () => {
    const req = AnthropicMessagesRequestSchema.parse({
      model: 'anthropic/claude-sonnet-5-5',
      max_tokens: 50,
      system: [{ type: 'text', text: 'sys' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done', is_error: true }, { type: 'text', text: 'next' }] },
      ],
      tools: [{ name: 'get', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' },
      stop_sequences: ['X'],
      stream: false,
    });
    const r = fromAnthropic(req);
    expect(r.messages[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'sys' }] });
    expect(r.messages[1]?.content[1]).toEqual({ type: 'image', base64: 'QUJD', mediaType: 'image/jpeg' });
    expect(r.messages[2]?.content[0]).toEqual({ type: 'tool_call', id: 'toolu_1', name: 'get', arguments: '{"a":1}' });
    expect(r.messages[3]).toMatchObject({ role: 'tool', content: [{ type: 'tool_result', toolCallId: 'toolu_1', content: 'done', isError: true }] });
    expect(r.messages[4]).toEqual({ role: 'user', content: [{ type: 'text', text: 'next' }] });
    expect(r.maxTokens).toBe(50);
    expect(r.stop).toEqual(['X']);
    expect(r.toolChoice).toBe('auto');
    expect(() => fromAnthropic({ ...req, tool_choice: { type: 'any' } })).toThrow(RequestValidationError);
    expect(() => fromAnthropic({ ...req, tool_choice: { type: 'tool', name: 'get' } })).toThrow(RequestValidationError);
  });

  it('renders an Anthropic message and the SSE event sequence', () => {
    const resp: InternalResponse = {
      id: 'u',
      model: 'm',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool_call', id: 't1', name: 'f', arguments: '{"x":2}' }] },
      finishReason: 'tool_calls',
      usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 1 },
    };
    const m = toAnthropicMessage(resp, { id: 'req_2', model: 'anthropic/claude-haiku-5-5' });
    expect(m).toMatchObject({ id: 'req_2', type: 'message', role: 'assistant', model: 'anthropic/claude-haiku-5-5', stop_reason: 'tool_use', stop_sequence: null });
    expect(m.content).toEqual([{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'f', input: { x: 2 } }]);
    expect(m.usage).toEqual({ input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 });

    const enc = new AnthropicStreamEncoder({ id: 'req_3', model: 'house/gpt-oss-20b' });
    let text = enc.start();
    for (const c of [
      { type: 'text', delta: 'he' },
      { type: 'text', delta: 'y' },
      { type: 'tool_call', index: 0, id: 't', name: 'f', argumentsDelta: '' },
      { type: 'tool_call', index: 0, argumentsDelta: '{}' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ] as InternalChunk[]) {
      text += enc.encode(c);
    }
    const events = text.split('\n').filter((l) => l.startsWith('event: ')).map((l) => l.slice(7));
    expect(events).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(text).toContain('"input_json_delta"');
    expect(text).toContain('"stop_reason":"end_turn"');
  });
});

describe('upstream request bodies', () => {
  const base = fromOpenAI(
    ChatCompletionRequestSchema.parse({
      model: 'x',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'https://img.example/a.png' } }] },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"k":1}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'out' },
      ],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'required',
      response_format: { type: 'json_schema', json_schema: { name: 'S', schema: { type: 'object' } } },
      reasoning_effort: 'low',
      max_tokens: 12,
    }),
  );

  it('OpenAI-compatible body mirrors the request; reasoning_effort and max_completion_tokens only for openai', () => {
    const body = buildOpenAiBody({ ...base, upstreamModel: 'gpt-5.5', metadata: META }, 'openai');
    expect(body['model']).toBe('gpt-5.5');
    expect(body['reasoning_effort']).toBe('low');
    expect(body['max_completion_tokens']).toBe(12);
    expect(body['max_tokens']).toBeUndefined();
    for (const provider of ['google', 'house'] as const) {
      const other = buildOpenAiBody({ ...base, upstreamModel: 'g', metadata: META }, provider);
      expect(other['max_tokens']).toBe(12);
      expect(other['max_completion_tokens']).toBeUndefined();
    }
    expect(body['tool_choice']).toBe('required');
    expect(body['response_format']).toEqual({ type: 'json_schema', json_schema: { name: 'S', schema: { type: 'object' } } });
    const msgs = body['messages'] as Record<string, unknown>[];
    expect(msgs[0]).toEqual({ role: 'system', content: 'sys' });
    expect((msgs[1]?.['content'] as unknown[])[1]).toEqual({ type: 'image_url', image_url: { url: 'https://img.example/a.png' } });
    expect(msgs[2]).toMatchObject({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"k":1}' } }] });
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'out' });
    expect(buildOpenAiBody({ ...base, upstreamModel: 'g', metadata: META }, 'google')['reasoning_effort']).toBeUndefined();
    expect(buildOpenAiBody({ ...base, upstreamModel: 'g', metadata: META, stream: true }, 'house')['stream_options']).toEqual({ include_usage: true });
  });

  it('Anthropic params: system, tool_result in a user turn, auto tool choice, output_config, no thinking', () => {
    const p = buildAnthropicParams({ ...base, upstreamModel: 'claude-sonnet-5-5', metadata: META });
    expect(p.model).toBe('claude-sonnet-5-5');
    expect(p.max_tokens).toBe(12);
    expect(String(p.system)).toContain('sys');
    expect(String(p.system)).toMatch(/must call one of the provided tools/);
    expect(p.tool_choice).toEqual({ type: 'auto' });
    expect(p.tools?.[0]).toMatchObject({ name: 'f', description: 'd', input_schema: { type: 'object' } });
    expect(p.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } });
    expect((p as unknown as Record<string, unknown>)['thinking']).toBeUndefined();
    expect(p.messages[0]?.role).toBe('user');
    expect(p.messages[1]?.role).toBe('assistant');
    expect(p.messages[1]?.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'f', input: { k: 1 } }]);
    expect(p.messages[2]?.role).toBe('user');
    expect(p.messages[2]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'c1', content: 'out' }]);
    expect(p.metadata).toEqual({ user_id: META.workspace });
  });

  it('Anthropic params clamp an OpenAI-range temperature to [0, 1]', () => {
    expect(buildAnthropicParams({ ...base, upstreamModel: 'claude-sonnet-5-5', metadata: META, temperature: 1.3 }).temperature).toBe(1);
    expect(buildAnthropicParams({ ...base, upstreamModel: 'claude-sonnet-5-5', metadata: META, temperature: 0.4 }).temperature).toBe(0.4);
    expect(buildAnthropicParams({ ...base, upstreamModel: 'claude-sonnet-5-5', metadata: META, topP: 0.9 }).top_p).toBe(0.9);
  });
});
