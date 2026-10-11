/**
 * OpenAI-compatible adapter over `fetch` (SPEC §5.5) serving `openai`, `google` and `house`:
 * `POST {baseUrl}/chat/completions`, SSE streaming with `stream_options.include_usage`, and a
 * robust SSE parser (multi-line events, partial frames, `[DONE]`).
 *
 * @module providers/openaiCompat
 */
import type { Provider } from '@beagle/shared/models';
import type { FinishReason, InternalChunk, InternalMessage, InternalRequest, InternalResponse, Part, Usage } from '../translate/internal.js';
import { classifyStatus, networkError, parseRetryAfter, ProviderError, type Credentials, type ProviderAdapter } from './types.js';

/** The subset of `fetch` the adapter needs. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Options of {@link createOpenAiCompatAdapter}. */
export interface OpenAiCompatOptions {
  provider: Provider;
  fetch?: FetchLike;
  /** Extra headers (e.g. none; reserved for future vendor headers). */
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------------------------
// Request body

function contentOf(message: InternalMessage): string | unknown[] {
  const parts = message.content.filter((p) => p.type === 'text' || p.type === 'image');
  if (parts.every((p) => p.type === 'text')) return parts.map((p) => (p as Extract<Part, { type: 'text' }>).text).join('');
  return parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: p.url ?? `data:${p.mediaType ?? 'image/png'};base64,${p.base64 ?? ''}` } },
  );
}

/** Builds the OpenAI chat request body for `req`. */
export function buildOpenAiBody(req: InternalRequest, provider: Provider): Record<string, unknown> {
  const messages: unknown[] = [];
  for (const m of req.messages) {
    switch (m.role) {
      case 'system':
        messages.push({ role: 'system', content: contentOf(m) });
        break;
      case 'user':
        messages.push({ role: 'user', content: contentOf(m), ...(m.name === undefined ? {} : { name: m.name }) });
        break;
      case 'assistant': {
        const calls = m.content.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call');
        const text = contentOf(m);
        messages.push({
          role: 'assistant',
          content: typeof text === 'string' && text === '' ? null : text,
          ...(calls.length === 0 ? {} : { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }),
        });
        break;
      }
      case 'tool':
        for (const p of m.content) {
          if (p.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: p.toolCallId, content: p.content });
        }
        break;
    }
  }
  // OpenAI's reasoning models (the whole `openai/*` catalog) reject `max_tokens` with a non-retryable
  // 400 and want `max_completion_tokens`; other compat servers (Gemini, vLLM, Ollama) take `max_tokens`.
  const body: Record<string, unknown> = {
    model: req.upstreamModel,
    messages,
    ...(provider === 'openai' ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
    stream: req.stream,
  };
  if (req.stream) body['stream_options'] = { include_usage: true };
  if (req.temperature !== undefined) body['temperature'] = req.temperature;
  if (req.topP !== undefined) body['top_p'] = req.topP;
  if (req.stop !== undefined) body['stop'] = req.stop;
  if (req.tools !== undefined) {
    body['tools'] = req.tools.map((t) => ({ type: 'function', function: { name: t.name, ...(t.description === undefined ? {} : { description: t.description }), parameters: t.parameters } }));
  }
  if (req.toolChoice !== undefined) {
    body['tool_choice'] = typeof req.toolChoice === 'string' ? req.toolChoice : { type: 'function', function: { name: req.toolChoice.name } };
  }
  if (req.responseFormat !== undefined) {
    body['response_format'] =
      req.responseFormat.type === 'json_object'
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: req.responseFormat.name ?? 'response', schema: req.responseFormat.schema } };
  }
  if (req.reasoningEffort !== undefined && provider === 'openai') body['reasoning_effort'] = req.reasoningEffort;
  return body;
}

// ---------------------------------------------------------------------------------------------
// Response parsing

interface OaiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

/** Maps an OpenAI `usage` object onto internal usage (cached tokens are carved out of the prompt). */
export function usageFromOpenAi(u: OaiUsage | null | undefined): Usage {
  const prompt = Math.max(0, Math.trunc(u?.prompt_tokens ?? 0));
  const cached = Math.max(0, Math.min(prompt, Math.trunc(u?.prompt_tokens_details?.cached_tokens ?? 0)));
  return { inputTokens: prompt - cached, outputTokens: Math.max(0, Math.trunc(u?.completion_tokens ?? 0)), cacheReadTokens: cached, cacheWriteTokens: 0 };
}

/** Maps an OpenAI `finish_reason`. */
export function finishFromOpenAi(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

interface OaiToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface OaiMessage {
  content?: string | null | { type?: string; text?: string }[];
  tool_calls?: OaiToolCall[];
  refusal?: string | null;
}
interface OaiCompletion {
  id?: string;
  model?: string;
  choices?: { message?: OaiMessage; finish_reason?: string | null }[];
  usage?: OaiUsage | null;
  error?: { message?: string; type?: string; code?: string | null };
}
interface OaiChunk {
  id?: string;
  model?: string;
  choices?: { index?: number; delta?: { content?: string | null; tool_calls?: OaiToolCall[]; refusal?: string | null }; finish_reason?: string | null }[];
  usage?: OaiUsage | null;
  error?: { message?: string; type?: string; code?: string | null };
}

function messageText(content: OaiMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => p.text ?? '').join('');
  return '';
}

/** Parses a complete `chat.completion` object. */
export function parseOpenAiCompletion(json: OaiCompletion, fallbackModel: string): InternalResponse {
  const choice = json.choices?.[0];
  const parts: Part[] = [];
  const text = messageText(choice?.message?.content);
  if (text !== '') parts.push({ type: 'text', text });
  for (const call of choice?.message?.tool_calls ?? []) {
    parts.push({ type: 'tool_call', id: call.id ?? `call_${parts.length}`, name: call.function?.name ?? '', arguments: call.function?.arguments ?? '' });
  }
  const finish = choice?.message?.refusal ? 'content_filter' : finishFromOpenAi(choice?.finish_reason);
  if (choice?.message?.refusal && parts.length === 0) parts.push({ type: 'text', text: choice.message.refusal });
  return {
    id: json.id ?? '',
    model: json.model ?? fallbackModel,
    message: { role: 'assistant', content: parts },
    finishReason: finish,
    usage: usageFromOpenAi(json.usage),
  };
}

// ---------------------------------------------------------------------------------------------
// SSE parser

/** One parsed SSE event. */
export interface SseEvent {
  event: string | undefined;
  data: string;
}

/**
 * Incremental SSE parser: feed decoded text, receive complete events. Handles CRLF, multi-line
 * `data:` fields (joined with `\n`), comments and frames split across chunks.
 */
export class SseParser {
  private buffer = '';

  /** Parses as much of `text` as forms complete events. */
  feed(text: string): SseEvent[] {
    this.buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const events: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const ev = SseParser.parseBlock(block);
      if (ev !== undefined) events.push(ev);
    }
    return events;
  }

  /** Flushes a trailing event without a terminating blank line. */
  end(): SseEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    const ev = rest.trim() === '' ? undefined : SseParser.parseBlock(rest);
    return ev === undefined ? [] : [ev];
  }

  private static parseBlock(block: string): SseEvent | undefined {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
    }
    if (data.length === 0) return undefined;
    return { event, data: data.join('\n') };
  }
}

/** Reads a streaming body as decoded text chunks. */
async function* textChunks(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail !== '') yield tail;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Classifies an in-band SSE error frame (`data: {"error": …}`) like an HTTP status would be: server /
 * overload / rate-limit errors are retryable (and so are all frames seen before any content, since
 * nothing was delivered yet), request errors after the first byte are not.
 */
export function streamFrameError(provider: Provider, error: NonNullable<OaiChunk['error']>, delivered: boolean): ProviderError {
  const kind = `${error.type ?? ''} ${error.code ?? ''}`.toLowerCase();
  const rateLimited = /rate_limit|rate limit|quota|too_many|429/.test(kind);
  const serverSide = /server_error|internal|overloaded|unavailable|timeout|5\d\d/.test(kind);
  const message = `${provider}: ${error.message ?? 'stream error'}`;
  if (rateLimited) return new ProviderError({ provider, status: 429, code: 'rate_limited', message, retryable: true });
  if (serverSide || !delivered) return new ProviderError({ provider, status: 502, code: 'stream_error', message, retryable: true });
  return new ProviderError({ provider, status: 502, code: 'stream_error', message, retryable: false });
}

async function readErrorMessage(res: Response): Promise<string> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return `HTTP ${res.status}`;
  }
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? json.message;
    if (typeof msg === 'string' && msg !== '') return msg;
  } catch {
    // not JSON
  }
  return text.trim() === '' ? `HTTP ${res.status}` : text.slice(0, 500);
}

/** Creates the OpenAI-compatible adapter for `provider`. */
export function createOpenAiCompatAdapter(options: OpenAiCompatOptions): ProviderAdapter {
  const provider = options.provider;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function send(req: InternalRequest, creds: Credentials, signal: AbortSignal): Promise<Response> {
    const url = `${creds.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: req.stream ? 'text/event-stream' : 'application/json', ...(options.headers ?? {}) };
    if (creds.key !== '') headers['authorization'] = `Bearer ${creds.key}`;
    let res: Response;
    try {
      // `redirect: 'manual'`: a validated BYOK base URL must not be able to bounce the request (and
      // its body) to another host, scheme or private address behind the SSRF guard (SPEC §5.9).
      res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(buildOpenAiBody(req, provider)), signal, redirect: 'manual' });
    } catch (e) {
      throw networkError(provider, e);
    }
    if (res.status >= 300 && res.status < 400) {
      throw new ProviderError({ provider, status: 502, code: 'upstream_error', message: `${provider}: upstream answered with a redirect (${res.status}), which the gateway does not follow`, retryable: false });
    }
    if (!res.ok) {
      const message = await readErrorMessage(res);
      throw classifyStatus(provider, res.status, creds.kind, `${provider}: ${message}`, parseRetryAfter(res.headers.get('retry-after')));
    }
    return res;
  }

  return {
    provider,
    async complete(req, creds, signal) {
      const res = await send({ ...req, stream: false }, creds, signal);
      let json: OaiCompletion;
      try {
        json = (await res.json()) as OaiCompletion;
      } catch (e) {
        throw new ProviderError({ provider, status: 502, code: 'upstream_error', message: `${provider}: invalid JSON response`, retryable: true, cause: e });
      }
      if (json.error !== undefined) {
        throw new ProviderError({ provider, status: 502, code: 'upstream_error', message: `${provider}: ${json.error.message ?? 'error'}`, retryable: true });
      }
      return parseOpenAiCompletion(json, req.upstreamModel);
    },
    async *stream(req, creds, signal) {
      const res = await send({ ...req, stream: true }, creds, signal);
      if (res.body === null) throw new ProviderError({ provider, status: 502, code: 'upstream_error', message: `${provider}: empty stream`, retryable: true });
      const parser = new SseParser();
      let finishReason: FinishReason | undefined;
      let usage: Usage | undefined;
      let done = false;
      let delivered = false;
      let errored = false;
      const toolIds = new Map<number, string>();
      const handle = function* (ev: SseEvent): Generator<InternalChunk> {
        if (ev.data.trim() === '[DONE]') {
          done = true;
          return;
        }
        let chunk: OaiChunk;
        try {
          chunk = JSON.parse(ev.data) as OaiChunk;
        } catch {
          return;
        }
        if (chunk.error !== undefined) {
          yield { type: 'error', error: streamFrameError(provider, chunk.error, delivered) };
          done = true;
          errored = true;
          return;
        }
        if (chunk.usage !== undefined && chunk.usage !== null) usage = usageFromOpenAi(chunk.usage);
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {};
          if (typeof delta.content === 'string' && delta.content !== '') {
            delivered = true;
            yield { type: 'text', delta: delta.content };
          }
          if (typeof delta.refusal === 'string' && delta.refusal !== '') {
            delivered = true;
            yield { type: 'text', delta: delta.refusal };
          }
          for (const call of delta.tool_calls ?? []) {
            const index = call.index ?? 0;
            if (call.id !== undefined) toolIds.set(index, call.id);
            delivered = true;
            yield {
              type: 'tool_call',
              index,
              ...(call.id === undefined ? {} : { id: call.id }),
              ...(call.function?.name === undefined ? {} : { name: call.function.name }),
              argumentsDelta: call.function?.arguments ?? '',
            };
          }
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = finishFromOpenAi(choice.finish_reason);
        }
      };
      try {
        for await (const text of textChunks(res.body, signal)) {
          for (const ev of parser.feed(text)) yield* handle(ev);
          if (done) break;
        }
        if (!done) for (const ev of parser.end()) yield* handle(ev);
      } catch (e) {
        yield { type: 'error', error: networkError(provider, e) };
        return;
      }
      if (errored) return;
      // No `usage` frame at all → zeros; the executor charges the estimate for delivered content.
      yield { type: 'finish', finishReason: finishReason ?? 'stop', usage: usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    },
  };
}
