/**
 * OpenAI Chat Completions request → internal request (SPEC §5.5).
 *
 * @module translate/fromOpenAI
 */
import { requestedMaxTokens, type ChatCompletionRequest, type ChatMessage } from '@beagle/shared/openai';
import {
  normalizeReasoningEffort,
  parseDataUri,
  RequestValidationError,
  type InternalMessage,
  type InternalRequestBase,
  type Part,
  type ToolChoice,
  type ToolDef,
} from './internal.js';

function textParts(content: string | readonly { type: 'text'; text: string }[] | null | undefined): Part[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  return content.map((p) => ({ type: 'text', text: p.text }));
}

function userParts(content: ChatCompletionRequest['messages'][number]['content']): Part[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (content === null || content === undefined) return [];
  const out: Part[] = [];
  for (const part of content) {
    if (part.type === 'text') out.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url') {
      const data = parseDataUri(part.image_url.url);
      out.push(data === undefined ? { type: 'image', url: part.image_url.url } : { type: 'image', base64: data.base64, mediaType: data.mediaType });
    }
  }
  return out;
}

/** Translates one OpenAI message. */
export function fromOpenAIMessage(message: ChatMessage): InternalMessage[] {
  switch (message.role) {
    case 'system':
    case 'developer': {
      const parts = textParts(message.content);
      return [{ role: 'system', content: parts.length === 0 ? [{ type: 'text', text: '' }] : parts, ...(message.name === undefined ? {} : { name: message.name }) }];
    }
    case 'user':
      return [{ role: 'user', content: userParts(message.content), ...(message.name === undefined ? {} : { name: message.name }) }];
    case 'assistant': {
      const parts: Part[] = textParts(message.content);
      for (const call of message.tool_calls ?? []) {
        parts.push({ type: 'tool_call', id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
      return [{ role: 'assistant', content: parts, ...(message.name === undefined ? {} : { name: message.name }) }];
    }
    case 'tool': {
      const text = typeof message.content === 'string' ? message.content : message.content.map((p) => p.text).join('\n');
      return [{ role: 'tool', toolCallId: message.tool_call_id, content: [{ type: 'tool_result', toolCallId: message.tool_call_id, content: text }] }];
    }
  }
}

/** Translates `tool_choice`. */
export function fromOpenAIToolChoice(choice: ChatCompletionRequest['tool_choice']): ToolChoice | undefined {
  if (choice === null || choice === undefined) return undefined;
  if (typeof choice === 'string') return choice;
  return { name: choice.function.name };
}

/**
 * Translates a validated OpenAI request. Throws {@link RequestValidationError} for inputs the
 * schema accepts but the gateway cannot serve (empty messages after translation, tool messages
 * without a preceding tool call, …).
 */
export function fromOpenAI(req: ChatCompletionRequest): InternalRequestBase {
  const messages = req.messages.flatMap(fromOpenAIMessage);
  if (messages.length === 0) throw new RequestValidationError('messages must not be empty', 'messages');
  const tools: ToolDef[] | undefined =
    req.tools === null || req.tools === undefined || req.tools.length === 0
      ? undefined
      : req.tools.map((t) => ({
          name: t.function.name,
          ...(t.function.description === undefined ? {} : { description: t.function.description }),
          parameters: t.function.parameters ?? { type: 'object', properties: {} },
        }));
  const toolChoice = fromOpenAIToolChoice(req.tool_choice);
  if (toolChoice !== undefined && toolChoice !== 'none' && tools === undefined) {
    throw new RequestValidationError('tool_choice requires tools', 'tool_choice');
  }
  if (typeof toolChoice === 'object' && tools !== undefined && !tools.some((t) => t.name === toolChoice.name)) {
    throw new RequestValidationError(`tool_choice names an unknown tool ${JSON.stringify(toolChoice.name)}`, 'tool_choice');
  }
  const stop = req.stop === null || req.stop === undefined ? undefined : typeof req.stop === 'string' ? [req.stop] : req.stop;
  const rf = req.response_format;
  const responseFormat: InternalRequestBase['responseFormat'] =
    rf === null || rf === undefined || rf.type === 'text'
      ? undefined
      : rf.type === 'json_object'
        ? { type: 'json_object' }
        : { type: 'json_schema', schema: rf.json_schema.schema ?? {}, name: rf.json_schema.name };
  const effort = normalizeReasoningEffort(req.reasoning_effort);
  return {
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    maxTokens: requestedMaxTokens(req, 4096),
    ...(req.temperature === null || req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.top_p === null || req.top_p === undefined ? {} : { topP: req.top_p }),
    ...(stop === undefined || stop.length === 0 ? {} : { stop }),
    ...(responseFormat === undefined ? {} : { responseFormat }),
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    stream: req.stream === true,
  };
}
