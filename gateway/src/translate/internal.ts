/**
 * Provider-neutral request / response model (SPEC §5.5). Every inbound format (OpenAI chat,
 * Anthropic messages) is translated into these types, every adapter consumes them, and every
 * outbound format is rendered from them.
 *
 * @module translate/internal
 */
import type { Provider } from '@beagle/shared/models';
import type { ProviderError } from '../providers/types.js';

/** One content part of a message. */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; url?: string; base64?: string; mediaType?: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean };

/** One message. */
export interface InternalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: Part[];
  name?: string;
  toolCallId?: string;
}

/** A function tool definition. */
export interface ToolDef {
  name: string;
  description?: string;
  /** JSON schema of the arguments (object). */
  parameters: Record<string, unknown>;
}

/** Tool choice. */
export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

/** Response format constraint. */
export type ResponseFormat = { type: 'json_object' } | { type: 'json_schema'; schema: Record<string, unknown>; name?: string };

/** Reasoning effort understood by adapters. */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/** The request without the fields the router adds (`upstreamModel`, `metadata`). */
export interface InternalRequestBase {
  messages: InternalMessage[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  responseFormat?: ResponseFormat;
  reasoningEffort?: ReasoningEffort;
  stream: boolean;
}

/** The request an adapter receives. */
export interface InternalRequest extends InternalRequestBase {
  /** Provider model id (`claude-opus-5-5`, `gpt-5.5`, `openai/gpt-oss-20b`). */
  upstreamModel: string;
  metadata: { requestId: string; workspace: string };
}

/** Token counts reported by the provider. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Why the model stopped. */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

/** A complete (non-streamed) response. */
export interface InternalResponse {
  /** Upstream response id. */
  id: string;
  /** Upstream model id as reported by the provider. */
  model: string;
  message: InternalMessage;
  finishReason: FinishReason;
  usage: Usage;
}

/** One streamed increment. */
export type InternalChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: 'finish'; finishReason: FinishReason; usage: Usage }
  | { type: 'error'; error: ProviderError };

/** Zero usage. */
export const ZERO_USAGE: Readonly<Usage> = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/** Text of all `text` parts of a message, joined with newlines. */
export function textOf(message: InternalMessage): string {
  return message.content
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** Character count of a message's text, tool calls and tool results (images count 1 000). */
export function charsOf(message: InternalMessage): number {
  let n = 0;
  for (const p of message.content) {
    switch (p.type) {
      case 'text':
        n += p.text.length;
        break;
      case 'image':
        n += 1000;
        break;
      case 'tool_call':
        n += p.name.length + p.arguments.length;
        break;
      case 'tool_result':
        n += p.content.length;
        break;
    }
  }
  return n;
}

/** Total characters of a request (messages + tool definitions). */
export function totalChars(req: InternalRequestBase): number {
  const msgs = req.messages.reduce((sum, m) => sum + charsOf(m), 0);
  const tools = (req.tools ?? []).reduce((sum, t) => sum + t.name.length + (t.description?.length ?? 0) + JSON.stringify(t.parameters).length, 0);
  return msgs + tools;
}

/** `true` when any message carries an image part. */
export function hasImages(req: InternalRequestBase): boolean {
  return req.messages.some((m) => m.content.some((p) => p.type === 'image'));
}

/** Assembles streamed chunks into a complete response (used for metering and tests). */
export class ChunkAssembler {
  private text = '';
  private readonly toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private finish: { finishReason: FinishReason; usage: Usage } | undefined;
  private error: ProviderError | undefined;

  /** Feeds one chunk. */
  push(chunk: InternalChunk): void {
    switch (chunk.type) {
      case 'text':
        this.text += chunk.delta;
        break;
      case 'tool_call': {
        const existing = this.toolCalls.get(chunk.index) ?? { id: '', name: '', arguments: '' };
        if (chunk.id !== undefined && chunk.id !== '') existing.id = chunk.id;
        if (chunk.name !== undefined && chunk.name !== '') existing.name = chunk.name;
        existing.arguments += chunk.argumentsDelta;
        this.toolCalls.set(chunk.index, existing);
        break;
      }
      case 'finish':
        this.finish = { finishReason: chunk.finishReason, usage: chunk.usage };
        break;
      case 'error':
        this.error = chunk.error;
        break;
    }
  }

  /** Characters streamed so far (for charging a broken stream). */
  get streamedChars(): number {
    let n = this.text.length;
    for (const t of this.toolCalls.values()) n += t.name.length + t.arguments.length;
    return n;
  }

  /** The error chunk, if one was seen. */
  get failure(): ProviderError | undefined {
    return this.error;
  }

  /** The finish info, if seen. */
  get finished(): { finishReason: FinishReason; usage: Usage } | undefined {
    return this.finish;
  }

  /** The assembled message. */
  message(): InternalMessage {
    const content: Part[] = [];
    if (this.text !== '') content.push({ type: 'text', text: this.text });
    for (const [, t] of [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      content.push({ type: 'tool_call', id: t.id, name: t.name, arguments: t.arguments });
    }
    return { role: 'assistant', content };
  }

  /** A complete response (finish reason defaults to `stop`, usage to zeros). */
  response(id: string, model: string): InternalResponse {
    const message = this.message();
    const finishReason = this.finish?.finishReason ?? (message.content.some((p) => p.type === 'tool_call') ? 'tool_calls' : 'stop');
    return { id, model, message, finishReason, usage: this.finish?.usage ?? { ...ZERO_USAGE } };
  }
}

/** Describes a provider for error messages. */
export function providerLabel(p: Provider): string {
  return p === 'house' ? 'house model' : p;
}

/** A request the gateway rejects before routing (HTTP 400 `invalid_request_error`). */
export class RequestValidationError extends Error {
  override readonly name = 'RequestValidationError';
  readonly code = 'invalid_request_error';
  readonly param: string | null;

  constructor(message: string, param: string | null = null) {
    super(message);
    this.param = param;
  }
}

/** Maps the OpenAI `reasoning_effort` vocabulary onto the three adapter levels. */
export function normalizeReasoningEffort(effort: string | null | undefined): ReasoningEffort | undefined {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high';
    default:
      return undefined;
  }
}

/** Splits a `data:` URI into media type and base64 payload, or `undefined` for other URLs. */
export function parseDataUri(url: string): { mediaType: string; base64: string } | undefined {
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s.exec(url);
  if (!m) return undefined;
  return { mediaType: m[1] ?? 'application/octet-stream', base64: m[2] ?? '' };
}
