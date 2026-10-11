/**
 * Anthropic Messages API request (subset of SPEC §5.8) → internal request.
 *
 * @module translate/fromAnthropic
 */
import { z } from 'zod';
import { normalizeReasoningEffort, RequestValidationError, type InternalMessage, type InternalRequestBase, type Part, type ToolDef } from './internal.js';

const TextBlock = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const ImageBlock = z
  .object({
    type: z.literal('image'),
    source: z.union([
      z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string() }),
      z.object({ type: z.literal('url'), url: z.string().min(1) }),
    ]),
  })
  .passthrough();
const ToolUseBlock = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }).passthrough();
const ToolResultBlock = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(z.union([TextBlock, ImageBlock]))]).optional(),
    is_error: z.boolean().optional(),
  })
  .passthrough();
const ContentBlock = z.discriminatedUnion('type', [TextBlock, ImageBlock, ToolUseBlock, ToolResultBlock]);

/** Zod schema of the accepted `/v1/messages` body. Unknown fields pass through. */
export const AnthropicMessagesRequestSchema = z.looseObject({
  model: z.string().min(1),
  max_tokens: z.number().int().positive(),
  system: z.union([z.string(), z.array(TextBlock)]).optional(),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(ContentBlock)]) }))
    .min(1),
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(128),
        description: z.string().optional(),
        input_schema: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  tool_choice: z.object({ type: z.enum(['auto', 'none', 'any', 'tool']), name: z.string().optional(), disable_parallel_tool_use: z.boolean().optional() }).optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop_sequences: z.array(z.string()).max(8).optional(),
  stream: z.boolean().optional(),
  metadata: z.object({ user_id: z.string().nullable().optional() }).passthrough().optional(),
  output_config: z.object({ effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional() }).passthrough().optional(),
});
/** Parsed `/v1/messages` body. */
export type AnthropicMessagesRequest = z.output<typeof AnthropicMessagesRequestSchema>;

type Block = z.output<typeof ContentBlock>;

function imagePart(block: z.output<typeof ImageBlock>): Part {
  return block.source.type === 'base64'
    ? { type: 'image', base64: block.source.data, mediaType: block.source.media_type }
    : { type: 'image', url: block.source.url };
}

function toolResultText(content: z.output<typeof ToolResultBlock>['content']): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map((b) => (b.type === 'text' ? b.text : '[image]')).join('\n');
}

/** Translates one Anthropic message into one or more internal messages. */
export function fromAnthropicMessage(message: AnthropicMessagesRequest['messages'][number]): InternalMessage[] {
  if (typeof message.content === 'string') return [{ role: message.role, content: [{ type: 'text', text: message.content }] }];
  const out: InternalMessage[] = [];
  const own: Part[] = [];
  const blocks: Block[] = message.content;
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        own.push({ type: 'text', text: block.text });
        break;
      case 'image':
        own.push(imagePart(block));
        break;
      case 'tool_use':
        own.push({ type: 'tool_call', id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
        break;
      case 'tool_result':
        out.push({
          role: 'tool',
          toolCallId: block.tool_use_id,
          content: [{ type: 'tool_result', toolCallId: block.tool_use_id, content: toolResultText(block.content), ...(block.is_error === true ? { isError: true } : {}) }],
        });
        break;
    }
  }
  if (own.length > 0 || out.length === 0) out.push({ role: message.role, content: own });
  return out;
}

/** Translates a validated Anthropic request. `tool_choice` `any`/`tool` are rejected (400) like upstream. */
export function fromAnthropic(req: AnthropicMessagesRequest): InternalRequestBase {
  const messages: InternalMessage[] = [];
  if (req.system !== undefined) {
    const text = typeof req.system === 'string' ? req.system : req.system.map((b) => b.text).join('\n');
    if (text !== '') messages.push({ role: 'system', content: [{ type: 'text', text }] });
  }
  for (const m of req.messages) messages.push(...fromAnthropicMessage(m));
  if (messages.every((m) => m.role === 'system')) throw new RequestValidationError('messages must contain at least one user or assistant message', 'messages');
  const tools: ToolDef[] | undefined =
    req.tools === undefined || req.tools.length === 0
      ? undefined
      : req.tools.map((t) => ({ name: t.name, ...(t.description === undefined ? {} : { description: t.description }), parameters: t.input_schema }));
  let toolChoice: InternalRequestBase['toolChoice'];
  if (req.tool_choice !== undefined) {
    if (req.tool_choice.type === 'any' || req.tool_choice.type === 'tool') {
      throw new RequestValidationError(`tool_choice.type ${JSON.stringify(req.tool_choice.type)} is not supported: forced tool use is rejected by current models; use "auto"`, 'tool_choice');
    }
    if (tools === undefined && req.tool_choice.type !== 'none') throw new RequestValidationError('tool_choice requires tools', 'tool_choice');
    toolChoice = req.tool_choice.type;
  }
  const effort = normalizeReasoningEffort(req.output_config?.effort ?? undefined);
  return {
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    maxTokens: req.max_tokens,
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.top_p === undefined ? {} : { topP: req.top_p }),
    ...(req.stop_sequences === undefined || req.stop_sequences.length === 0 ? {} : { stop: req.stop_sequences }),
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    stream: req.stream === true,
  };
}
