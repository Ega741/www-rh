/**
 * Internal response / chunks → Anthropic Messages API objects and SSE events (SPEC §5.5).
 *
 * @module translate/toAnthropic
 */
import { anthropicError, type OpenAiErrorCode } from '@beagle/shared/openai';
import type { FinishReason, InternalChunk, InternalResponse, Part, Usage } from './internal.js';

/** Anthropic `stop_reason` values the gateway emits. */
export type AnthropicStopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal';

/** Anthropic `usage` object. */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** Anthropic content block (output subset). */
export type AnthropicContentBlock = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };

/** Anthropic `message` object. */
export interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: AnthropicStopReason;
  stop_sequence: null;
  usage: AnthropicUsage;
}

/** Maps an internal finish reason onto Anthropic's. */
export function toAnthropicStopReason(reason: FinishReason): AnthropicStopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
  }
}

/** Maps internal usage onto Anthropic's. */
export function toAnthropicUsage(usage: Usage): AnthropicUsage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens,
  };
}

function parseArguments(args: string): unknown {
  if (args.trim() === '') return {};
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return { _raw: args };
  }
}

/** Renders content parts as Anthropic blocks. */
export function toAnthropicBlocks(parts: readonly Part[]): AnthropicContentBlock[] {
  const out: AnthropicContentBlock[] = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text !== '') out.push({ type: 'text', text: p.text });
    } else if (p.type === 'tool_call') out.push({ type: 'tool_use', id: p.id, name: p.name, input: parseArguments(p.arguments) });
  }
  return out;
}

/** Renders a complete response as an Anthropic message. `id` is the request id, `model` the catalog id. */
export function toAnthropicMessage(resp: InternalResponse, meta: { id: string; model: string }): AnthropicMessage {
  const content = toAnthropicBlocks(resp.message.content);
  return {
    id: meta.id,
    type: 'message',
    role: 'assistant',
    model: meta.model,
    content: content.length === 0 ? [{ type: 'text', text: '' }] : content,
    stop_reason: toAnthropicStopReason(resp.finishReason),
    stop_sequence: null,
    usage: toAnthropicUsage(resp.usage),
  };
}

/** Formats one Anthropic SSE event. */
export function formatAnthropicEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Streaming encoder: tracks open content blocks and emits the Anthropic event sequence. */
export class AnthropicStreamEncoder {
  private nextIndex = 0;
  private open: { kind: 'text' } | { kind: 'tool'; toolIndex: number } | undefined;
  private readonly toolBlockIndex = new Map<number, number>();
  private started = false;

  constructor(private readonly meta: { id: string; model: string }) {}

  /** The `message_start` event (emit before the first chunk). */
  start(): string {
    this.started = true;
    const message: AnthropicMessage = {
      id: this.meta.id,
      type: 'message',
      role: 'assistant',
      model: this.meta.model,
      content: [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    const { stop_reason: _s, ...rest } = message;
    return formatAnthropicEvent('message_start', { type: 'message_start', message: { ...rest, stop_reason: null } });
  }

  private closeOpen(): string {
    if (this.open === undefined) return '';
    const index = this.nextIndex - 1;
    this.open = undefined;
    return formatAnthropicEvent('content_block_stop', { type: 'content_block_stop', index });
  }

  /** Events for one internal chunk (possibly several frames). */
  encode(chunk: InternalChunk): string {
    let out = this.started ? '' : this.start();
    switch (chunk.type) {
      case 'text': {
        if (this.open?.kind !== 'text') {
          out += this.closeOpen();
          const index = this.nextIndex++;
          this.open = { kind: 'text' };
          out += formatAnthropicEvent('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        }
        out += formatAnthropicEvent('content_block_delta', { type: 'content_block_delta', index: this.nextIndex - 1, delta: { type: 'text_delta', text: chunk.delta } });
        break;
      }
      case 'tool_call': {
        if (this.open?.kind !== 'tool' || this.open.toolIndex !== chunk.index) {
          out += this.closeOpen();
          const index = this.nextIndex++;
          this.open = { kind: 'tool', toolIndex: chunk.index };
          this.toolBlockIndex.set(chunk.index, index);
          out += formatAnthropicEvent('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: chunk.id ?? `toolu_${chunk.index}`, name: chunk.name ?? '', input: {} },
          });
        }
        if (chunk.argumentsDelta !== '') {
          out += formatAnthropicEvent('content_block_delta', {
            type: 'content_block_delta',
            index: this.nextIndex - 1,
            delta: { type: 'input_json_delta', partial_json: chunk.argumentsDelta },
          });
        }
        break;
      }
      case 'finish': {
        if (this.open === undefined && this.nextIndex === 0) {
          out += formatAnthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          this.nextIndex = 1;
          this.open = { kind: 'text' };
        }
        out += this.closeOpen();
        out += formatAnthropicEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: toAnthropicStopReason(chunk.finishReason), stop_sequence: null },
          usage: toAnthropicUsage(chunk.usage),
        });
        out += formatAnthropicEvent('message_stop', { type: 'message_stop' });
        break;
      }
      case 'error':
        out += this.closeOpen();
        out += anthropicErrorEvent('upstream_error', chunk.error.message);
        break;
    }
    return out;
  }
}

/** An Anthropic `error` SSE event. */
export function anthropicErrorEvent(code: OpenAiErrorCode, message: string): string {
  return formatAnthropicEvent('error', anthropicError(code, message).body);
}
