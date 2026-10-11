/**
 * Anthropic adapter over the official SDK (SPEC §5.5): `messages.create` / `messages.stream`,
 * `maxRetries: 0`, clients cached per credential, typed error mapping via `instanceof`.
 * Forced tool use is never sent (`required`/named choice → `auto` plus a system line); `thinking`
 * is never sent (adaptive by default); `reasoningEffort` → `output_config.effort`.
 *
 * @module providers/anthropic
 */
import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParamsBase } from '@anthropic-ai/sdk/resources/messages';
import type { Provider } from '@beagle/shared/models';
import { sha256Hex } from '../auth/crypto.js';
import type { FinishReason, InternalChunk, InternalMessage, InternalRequest, InternalResponse, Part, Usage } from '../translate/internal.js';
import { networkError, ProviderError, type Credentials, type ProviderAdapter } from './types.js';

/** The slice of the SDK client the adapter uses (injectable for tests). */
export interface AnthropicClientLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
    stream(params: MessageCreateParamsBase, options?: { signal?: AbortSignal }): AsyncIterable<Anthropic.RawMessageStreamEvent>;
  };
}

/** Builds (and may cache) a client for a credential. */
export type AnthropicClientFactory = (creds: Credentials) => AnthropicClientLike;

/** Options of {@link createAnthropicAdapter}. */
export interface AnthropicAdapterOptions {
  timeoutMs: number;
  clientFactory?: AnthropicClientFactory;
}

/** The default Anthropic base URL. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** The real SDK factory: `new Anthropic({ apiKey, baseURL, maxRetries: 0, timeout })`, cached by key hash. */
export function defaultAnthropicClientFactory(timeoutMs: number): AnthropicClientFactory {
  const cache = new Map<string, Anthropic>();
  return (creds) => {
    const baseURL = creds.baseUrl === '' ? ANTHROPIC_BASE_URL : creds.baseUrl;
    const id = sha256Hex(`${creds.key}|${baseURL}`);
    let client = cache.get(id);
    if (client === undefined) {
      client = new Anthropic({ apiKey: creds.key, baseURL, maxRetries: 0, timeout: timeoutMs });
      if (cache.size > 256) cache.clear();
      cache.set(id, client);
    }
    return client;
  };
}

// ---------------------------------------------------------------------------------------------
// Request mapping

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function imageBlock(p: Extract<Part, { type: 'image' }>): Anthropic.ImageBlockParam | undefined {
  if (p.base64 !== undefined) {
    const mediaType = p.mediaType !== undefined && IMAGE_TYPES.has(p.mediaType) ? p.mediaType : 'image/png';
    return { type: 'image', source: { type: 'base64', media_type: mediaType as Anthropic.Base64ImageSource['media_type'], data: p.base64 } };
  }
  if (p.url !== undefined) return { type: 'image', source: { type: 'url', url: p.url } };
  return undefined;
}

function parseInput(args: string): Record<string, unknown> {
  if (args.trim() === '') return {};
  try {
    const v = JSON.parse(args) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { _raw: args };
  }
}

function blocksOf(m: InternalMessage): Anthropic.ContentBlockParam[] {
  const out: Anthropic.ContentBlockParam[] = [];
  for (const p of m.content) {
    switch (p.type) {
      case 'text':
        if (p.text !== '') out.push({ type: 'text', text: p.text });
        break;
      case 'image': {
        const b = imageBlock(p);
        if (b !== undefined) out.push(b);
        break;
      }
      case 'tool_call':
        out.push({ type: 'tool_use', id: p.id, name: p.name, input: parseInput(p.arguments) });
        break;
      case 'tool_result':
        out.push({ type: 'tool_result', tool_use_id: p.toolCallId, content: p.content, ...(p.isError === true ? { is_error: true } : {}) });
        break;
    }
  }
  return out;
}

/** Builds the SDK `MessageCreateParamsBase` for `req` (without `stream`). */
export function buildAnthropicParams(req: InternalRequest): MessageCreateParamsBase {
  const systemLines: string[] = [];
  const messages: Anthropic.MessageParam[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      const text = m.content
        .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      if (text !== '') systemLines.push(text);
      continue;
    }
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = blocksOf(m);
    if (blocks.length === 0) continue;
    const last = messages[messages.length - 1];
    if (last !== undefined && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  if (messages.length === 0 || messages[0]?.role !== 'user') messages.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation start)' }] });

  const params: MessageCreateParamsBase = { model: req.upstreamModel, max_tokens: req.maxTokens, messages };
  if (req.tools !== undefined && req.tools.length > 0) {
    params.tools = req.tools.map((t): Anthropic.Tool => ({
      name: t.name,
      ...(t.description === undefined ? {} : { description: t.description }),
      input_schema: { ...t.parameters, type: 'object' } as Anthropic.Tool.InputSchema,
    }));
    if (req.toolChoice === 'none') params.tool_choice = { type: 'none' };
    else if (req.toolChoice === 'required') {
      params.tool_choice = { type: 'auto' };
      systemLines.push('You must call one of the provided tools to answer; do not reply with plain text.');
    } else if (typeof req.toolChoice === 'object') {
      params.tool_choice = { type: 'auto' };
      systemLines.push(`You must call the tool "${req.toolChoice.name}" to answer; do not reply with plain text.`);
    } else params.tool_choice = { type: 'auto' };
  }
  if (req.responseFormat?.type === 'json_object') systemLines.push('Respond with a single valid JSON object and nothing else.');
  const outputConfig: Anthropic.OutputConfig = {};
  if (req.reasoningEffort !== undefined) outputConfig.effort = req.reasoningEffort;
  if (req.responseFormat?.type === 'json_schema') outputConfig.format = { type: 'json_schema', schema: req.responseFormat.schema };
  if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;
  if (systemLines.length > 0) params.system = systemLines.join('\n\n');
  if (req.temperature !== undefined) params.temperature = req.temperature;
  else if (req.topP !== undefined) params.top_p = req.topP;
  if (req.stop !== undefined && req.stop.length > 0) params.stop_sequences = req.stop;
  params.metadata = { user_id: req.metadata.workspace };
  return params;
}

// ---------------------------------------------------------------------------------------------
// Response mapping

/** Maps an Anthropic stop reason. */
export function finishFromAnthropic(reason: Anthropic.StopReason | null | undefined): FinishReason {
  switch (reason) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/** Maps SDK usage (cache fields may be null). */
export function usageFromAnthropic(u: Anthropic.Usage | Anthropic.MessageDeltaUsage | undefined, base?: Usage): Usage {
  return {
    inputTokens: Math.max(0, u?.input_tokens ?? base?.inputTokens ?? 0),
    outputTokens: Math.max(0, u?.output_tokens ?? base?.outputTokens ?? 0),
    cacheReadTokens: Math.max(0, u?.cache_read_input_tokens ?? base?.cacheReadTokens ?? 0),
    cacheWriteTokens: Math.max(0, u?.cache_creation_input_tokens ?? base?.cacheWriteTokens ?? 0),
  };
}

/** Maps a complete SDK message. */
export function parseAnthropicMessage(message: Anthropic.Message): InternalResponse {
  const parts: Part[] = [];
  for (const block of message.content) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text });
    else if (block.type === 'tool_use') parts.push({ type: 'tool_call', id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
  }
  return {
    id: message.id,
    model: message.model,
    message: { role: 'assistant', content: parts },
    finishReason: finishFromAnthropic(message.stop_reason),
    usage: usageFromAnthropic(message.usage),
  };
}

/** Maps any error thrown by the SDK onto a {@link ProviderError} (SPEC §5.5, most specific first). */
export function mapAnthropicError(e: unknown, kind: Credentials['kind']): ProviderError {
  const provider: Provider = 'anthropic';
  if (ProviderError.is(e)) return e;
  if (e instanceof Anthropic.RateLimitError) {
    const ra = e.headers.get('retry-after');
    const retryAfterSec = ra !== null && Number.isFinite(Number(ra)) ? Math.ceil(Number(ra)) : undefined;
    return new ProviderError({ provider, status: 429, code: 'rate_limited', message: `anthropic: ${e.message}`, retryable: true, ...(retryAfterSec === undefined ? {} : { retryAfterSec }), cause: e });
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError({ provider, status: e.status, code: 'auth', message: `anthropic: ${e.message}`, retryable: kind === 'platform', authFailure: true, cause: e });
  }
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.UnprocessableEntityError) {
    return new ProviderError({ provider, status: e.status, code: 'bad_request', message: e.message, retryable: false, cause: e });
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new ProviderError({
      provider,
      status: 0,
      code: e instanceof Anthropic.APIConnectionTimeoutError ? 'timeout' : 'network',
      message: `anthropic: ${e.message}`,
      retryable: true,
      cause: e,
    });
  }
  if (e instanceof Anthropic.InternalServerError) {
    return new ProviderError({ provider, status: e.status ?? 500, code: 'upstream_error', message: `anthropic: ${e.message}`, retryable: true, cause: e });
  }
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0;
    return new ProviderError({ provider, status, code: status >= 500 || status === 0 ? 'upstream_error' : 'bad_request', message: `anthropic: ${e.message}`, retryable: status >= 500 || status === 0, cause: e });
  }
  return networkError(provider, e);
}

/** Creates the Anthropic adapter. */
export function createAnthropicAdapter(options: AnthropicAdapterOptions): ProviderAdapter {
  const factory = options.clientFactory ?? defaultAnthropicClientFactory(options.timeoutMs);
  return {
    provider: 'anthropic',
    async complete(req, creds, signal) {
      const client = factory(creds);
      try {
        const message = await client.messages.create({ ...buildAnthropicParams(req), stream: false }, { signal });
        return parseAnthropicMessage(message);
      } catch (e) {
        throw mapAnthropicError(e, creds.kind);
      }
    },
    async *stream(req, creds, signal) {
      const client = factory(creds);
      let iterator: AsyncIterator<Anthropic.RawMessageStreamEvent>;
      let first: IteratorResult<Anthropic.RawMessageStreamEvent>;
      try {
        iterator = client.messages.stream(buildAnthropicParams(req), { signal })[Symbol.asyncIterator]();
        first = await iterator.next();
      } catch (e) {
        throw mapAnthropicError(e, creds.kind);
      }
      let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      let finish: FinishReason = 'stop';
      const toolOrdinal = new Map<number, number>();
      let nextOrdinal = 0;
      const handle = function* (ev: Anthropic.RawMessageStreamEvent): Generator<InternalChunk> {
        switch (ev.type) {
          case 'message_start':
            usage = usageFromAnthropic(ev.message.usage, usage);
            break;
          case 'content_block_start':
            if (ev.content_block.type === 'tool_use') {
              const ordinal = nextOrdinal++;
              toolOrdinal.set(ev.index, ordinal);
              yield { type: 'tool_call', index: ordinal, id: ev.content_block.id, name: ev.content_block.name, argumentsDelta: '' };
            } else if (ev.content_block.type === 'text' && ev.content_block.text !== '') yield { type: 'text', delta: ev.content_block.text };
            break;
          case 'content_block_delta':
            if (ev.delta.type === 'text_delta') yield { type: 'text', delta: ev.delta.text };
            else if (ev.delta.type === 'input_json_delta') {
              const ordinal = toolOrdinal.get(ev.index) ?? 0;
              yield { type: 'tool_call', index: ordinal, argumentsDelta: ev.delta.partial_json };
            }
            break;
          case 'message_delta':
            finish = finishFromAnthropic(ev.delta.stop_reason);
            usage = usageFromAnthropic(ev.usage, usage);
            break;
          case 'content_block_stop':
          case 'message_stop':
            break;
        }
      };
      let result = first;
      try {
        while (!result.done) {
          yield* handle(result.value);
          result = await iterator.next();
        }
      } catch (e) {
        yield { type: 'error', error: mapAnthropicError(e, creds.kind) };
        return;
      }
      yield { type: 'finish', finishReason: finish, usage };
    },
  };
}
