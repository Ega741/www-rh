/**
 * Internal response / chunks → OpenAI `chat.completion` and `chat.completion.chunk` (SPEC §5.5).
 *
 * @module translate/toOpenAI
 */
import {
  buildChatCompletion,
  buildChatCompletionChunk,
  formatSseData,
  openAiError,
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChunkDelta,
  type ChunkToolCall,
  type OpenAiErrorCode,
  type ToolCall,
} from '@beagle/shared/openai';
import type { InternalChunk, InternalResponse, Part, Usage } from './internal.js';

/** Identity of the response being rendered. */
export interface ResponseMeta {
  /** Request id (`req_…`). */
  id: string;
  /** Unix seconds. */
  created: number;
  /** Catalog id of the served model. */
  model: string;
}

function toolCallsOf(parts: readonly Part[]): ToolCall[] {
  return parts
    .filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call')
    .map((p) => ({ id: p.id, type: 'function', function: { name: p.name, arguments: p.arguments } }));
}

/** Renders a complete response as a `chat.completion`. */
export function toChatCompletion(resp: InternalResponse, meta: ResponseMeta): ChatCompletion {
  const text = resp.message.content
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
  const toolCalls = toolCallsOf(resp.message.content);
  // OpenAI puts a refusal in `refusal` with `content: null` (unless tool calls are present).
  const refused = resp.finishReason === 'content_filter';
  return buildChatCompletion({
    id: meta.id,
    created: meta.created,
    model: meta.model,
    content: (text === '' && toolCalls.length > 0) || (refused && toolCalls.length === 0) ? null : text,
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
    finishReason: resp.finishReason,
    usage: resp.usage,
    ...(refused ? { refusal: text === '' ? 'refused' : text } : {}),
  });
}

/** Turns internal chunks into OpenAI chunks, remembering tool-call ids per index. */
export class OpenAiChunkEncoder {
  private started = false;
  private readonly seenToolIndex = new Set<number>();

  constructor(
    private readonly meta: ResponseMeta,
    private readonly includeUsage: boolean,
  ) {}

  /** The chunks to emit for `chunk` (0, 1 or 2 objects). */
  encode(chunk: InternalChunk): ChatCompletionChunk[] {
    const out: ChatCompletionChunk[] = [];
    const base = { id: this.meta.id, created: this.meta.created, model: this.meta.model };
    const withRole = (delta: ChunkDelta): ChunkDelta => {
      if (this.started) return delta;
      this.started = true;
      return { role: 'assistant', ...delta };
    };
    switch (chunk.type) {
      case 'text':
        if (chunk.delta === '' && this.started) return out;
        out.push(buildChatCompletionChunk({ ...base, delta: withRole({ content: chunk.delta }) }));
        break;
      case 'tool_call': {
        const first = !this.seenToolIndex.has(chunk.index);
        this.seenToolIndex.add(chunk.index);
        const call: ChunkToolCall = {
          index: chunk.index,
          ...(first ? { type: 'function' as const } : {}),
          ...(chunk.id === undefined || chunk.id === '' ? {} : { id: chunk.id }),
          function: {
            ...(chunk.name === undefined || chunk.name === '' ? {} : { name: chunk.name }),
            arguments: chunk.argumentsDelta,
          },
        };
        out.push(buildChatCompletionChunk({ ...base, delta: withRole({ tool_calls: [call] }) }));
        break;
      }
      case 'finish':
        if (!this.started) out.push(buildChatCompletionChunk({ ...base, delta: withRole({ content: '' }) }));
        out.push(buildChatCompletionChunk({ ...base, delta: {}, finishReason: chunk.finishReason }));
        if (this.includeUsage) out.push(buildChatCompletionChunk({ ...base, usage: chunk.usage }));
        break;
      case 'error':
        break;
    }
    return out;
  }

  /** The usage-only chunk (for `stream_options.include_usage` after an error). */
  usageChunk(usage: Usage): ChatCompletionChunk {
    return buildChatCompletionChunk({ id: this.meta.id, created: this.meta.created, model: this.meta.model, usage });
  }
}

/** The SSE frame carrying an OpenAI error envelope inside a stream. */
export function openAiErrorFrame(code: OpenAiErrorCode, message: string): string {
  return formatSseData(openAiError(code, message).body);
}
