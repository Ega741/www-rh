/**
 * OpenAI Chat Completions wire format (SPEC §4.8, §5.8): request schema (known fields typed,
 * unknown fields passed through), response builders, the error envelope and the
 * error code → HTTP status map.
 *
 * @module openai
 */
import { z } from 'zod';
import type { UsageTokens } from './credit.js';
import { ModelPriceSchema, TIER_ORDER } from './models.js';

// ---------------------------------------------------------------------------------------------
// Request

/** `{ type: 'text', text }` content part. */
export const TextPartSchema = z.object({ type: z.literal('text'), text: z.string() });
export type TextPart = z.output<typeof TextPartSchema>;

/** `{ type: 'image_url', image_url: { url, detail? } }` content part (`url` may be a data: URI). */
export const ImageUrlPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({ url: z.string().min(1), detail: z.enum(['auto', 'low', 'high']).optional() }),
});
export type ImageUrlPart = z.output<typeof ImageUrlPartSchema>;

/** Any supported content part. */
export const ContentPartSchema = z.discriminatedUnion('type', [TextPartSchema, ImageUrlPartSchema]);
export type ContentPart = z.output<typeof ContentPartSchema>;

/** An assistant tool call. */
export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
export type ToolCall = z.output<typeof ToolCallSchema>;

/** `system` / `developer` message. */
export const SystemMessageSchema = z.looseObject({
  role: z.enum(['system', 'developer']),
  content: z.union([z.string(), z.array(TextPartSchema)]),
  name: z.string().optional(),
});
/** `user` message (text and image parts). */
export const UserMessageSchema = z.looseObject({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(ContentPartSchema)]),
  name: z.string().optional(),
});
/** `assistant` message (content and/or tool calls). */
export const AssistantMessageSchema = z.looseObject({
  role: z.literal('assistant'),
  content: z.union([z.string(), z.array(TextPartSchema)]).nullish(),
  tool_calls: z.array(ToolCallSchema).optional(),
  refusal: z.string().nullish(),
  name: z.string().optional(),
});
/** `tool` message (result of a tool call). */
export const ToolMessageSchema = z.looseObject({
  role: z.literal('tool'),
  content: z.union([z.string(), z.array(TextPartSchema)]),
  tool_call_id: z.string(),
});
/** Any chat message. */
export const ChatMessageSchema = z.union([SystemMessageSchema, UserMessageSchema, AssistantMessageSchema, ToolMessageSchema]);
export type ChatMessage = z.output<typeof ChatMessageSchema>;
export type SystemMessage = z.output<typeof SystemMessageSchema>;
export type UserMessage = z.output<typeof UserMessageSchema>;
export type AssistantMessage = z.output<typeof AssistantMessageSchema>;
export type ToolMessage = z.output<typeof ToolMessageSchema>;

/** A function tool definition. */
export const ToolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'tool names are [A-Za-z0-9_-]'),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().nullish(),
  }),
});
export type ToolDefinition = z.output<typeof ToolDefinitionSchema>;

/** `tool_choice`. */
export const ToolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
]);
export type ToolChoice = z.output<typeof ToolChoiceSchema>;

/** `response_format`. */
export const ResponseFormatSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string(),
      description: z.string().optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
      strict: z.boolean().nullish(),
    }),
  }),
]);
export type ResponseFormat = z.output<typeof ResponseFormatSchema>;

/** `reasoning_effort` vocabulary accepted on input. */
export const ReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ReasoningEffortValue = z.output<typeof ReasoningEffortSchema>;

/**
 * `POST /v1/chat/completions` body. Known fields are validated; unknown fields pass through.
 * `n` must be 1 when present (SPEC §5.8).
 */
export const ChatCompletionRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  tools: z.array(ToolDefinitionSchema).nullish(),
  tool_choice: ToolChoiceSchema.nullish(),
  response_format: ResponseFormatSchema.nullish(),
  max_tokens: z.number().int().positive().nullish(),
  max_completion_tokens: z.number().int().positive().nullish(),
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).nullish(),
  reasoning_effort: ReasoningEffortSchema.nullish(),
  stream: z.boolean().nullish(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).nullish(),
  user: z.string().nullish(),
  n: z.literal(1).nullish(),
  seed: z.number().int().nullish(),
  presence_penalty: z.number().min(-2).max(2).nullish(),
  frequency_penalty: z.number().min(-2).max(2).nullish(),
  parallel_tool_calls: z.boolean().nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
});
export type ChatCompletionRequest = z.output<typeof ChatCompletionRequestSchema>;
export type ChatCompletionRequestInput = z.input<typeof ChatCompletionRequestSchema>;

/** The effective completion budget: `max_completion_tokens`, else `max_tokens`, else `fallback`. */
export function requestedMaxTokens(req: Pick<ChatCompletionRequest, 'max_tokens' | 'max_completion_tokens'>, fallback = 4096): number {
  return req.max_completion_tokens ?? req.max_tokens ?? fallback;
}

// ---------------------------------------------------------------------------------------------
// Responses

/** Finish reasons the gateway emits. */
export const FinishReasonSchema = z.enum(['stop', 'length', 'tool_calls', 'content_filter']);
export type FinishReason = z.output<typeof FinishReasonSchema>;

/** `usage` object of completions and final chunks. */
export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
}

/** Zod schema of {@link ChatCompletionUsage}. */
export const ChatCompletionUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative() }).optional(),
});

/** Assistant message of a completion. */
export interface ChatCompletionMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
  refusal: string | null;
}

/** One choice of a completion. */
export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: FinishReason;
  logprobs: null;
}

/** `chat.completion` object. `model` is the Beagle catalog id, `id` the request id (SPEC §5.6). */
export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
  system_fingerprint?: string;
}

/** Zod schema of {@link ChatCompletion}. */
export const ChatCompletionSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number().int(),
      message: z.object({
        role: z.literal('assistant'),
        content: z.string().nullable(),
        tool_calls: z.array(ToolCallSchema).optional(),
        refusal: z.string().nullable(),
      }),
      finish_reason: FinishReasonSchema,
      logprobs: z.null(),
    }),
  ),
  usage: ChatCompletionUsageSchema,
  system_fingerprint: z.string().optional(),
});

/** Tool call fragment inside a streamed delta. */
export interface ChunkToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

/** Streamed delta. */
export interface ChunkDelta {
  role?: 'assistant';
  content?: string | null;
  tool_calls?: ChunkToolCall[];
  refusal?: string | null;
}

/** One choice of a chunk. */
export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChunkDelta;
  finish_reason: FinishReason | null;
  logprobs: null;
}

/** `chat.completion.chunk` object. */
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: ChatCompletionUsage | null;
  system_fingerprint?: string;
}

/** Zod schema of {@link ChatCompletionChunk}. */
export const ChatCompletionChunkSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion.chunk'),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number().int(),
      delta: z.object({
        role: z.literal('assistant').optional(),
        content: z.string().nullish(),
        tool_calls: z
          .array(
            z.object({
              index: z.number().int(),
              id: z.string().optional(),
              type: z.literal('function').optional(),
              function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional(),
            }),
          )
          .optional(),
        refusal: z.string().nullish(),
      }),
      finish_reason: FinishReasonSchema.nullable(),
      logprobs: z.null(),
    }),
  ),
  usage: ChatCompletionUsageSchema.nullish(),
  system_fingerprint: z.string().optional(),
});

/** Converts internal token counts into the OpenAI `usage` object. */
export function toOpenAiUsage(usage: UsageTokens): ChatCompletionUsage {
  const cached = usage.cacheReadTokens ?? 0;
  // OpenAI counts cached tokens inside prompt_tokens; Anthropic reports them separately, so add them.
  const prompt = usage.inputTokens + cached + (usage.cacheWriteTokens ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.outputTokens,
    total_tokens: prompt + usage.outputTokens,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

/** Input of {@link buildChatCompletion}. */
export interface BuildChatCompletionInput {
  /** Request id (`req_…`). */
  id: string;
  /** Unix seconds. */
  created: number;
  /** Beagle catalog id of the served model. */
  model: string;
  content: string | null;
  toolCalls?: readonly ToolCall[];
  finishReason: FinishReason;
  usage: UsageTokens;
  refusal?: string | null;
  systemFingerprint?: string;
}

/** Builds a `chat.completion` response object. */
export function buildChatCompletion(input: BuildChatCompletionInput): ChatCompletion {
  const message: ChatCompletionMessage = {
    role: 'assistant',
    content: input.content,
    ...(input.toolCalls !== undefined && input.toolCalls.length > 0 ? { tool_calls: [...input.toolCalls] } : {}),
    refusal: input.refusal ?? null,
  };
  return {
    id: input.id,
    object: 'chat.completion',
    created: input.created,
    model: input.model,
    choices: [{ index: 0, message, finish_reason: input.finishReason, logprobs: null }],
    usage: toOpenAiUsage(input.usage),
    ...(input.systemFingerprint === undefined ? {} : { system_fingerprint: input.systemFingerprint }),
  };
}

/** Input of {@link buildChatCompletionChunk}. */
export interface BuildChatCompletionChunkInput {
  id: string;
  /** Unix seconds (the same value for every chunk of one response). */
  created: number;
  model: string;
  /** Omit (or pass `{}`) for the final usage-only chunk when `includeEmptyChoice` is false. */
  delta?: ChunkDelta;
  finishReason?: FinishReason | null;
  /** Token counts for the final chunk (`stream_options.include_usage`). */
  usage?: UsageTokens | null;
  /**
   * When `usage` is given and no `delta`/`finishReason`: emit `choices: []` (OpenAI's usage-only
   * chunk). Default `true`.
   */
  usageOnly?: boolean;
  systemFingerprint?: string;
}

/** Builds a `chat.completion.chunk` object (single choice, index 0). */
export function buildChatCompletionChunk(input: BuildChatCompletionChunkInput): ChatCompletionChunk {
  const usageOnly = input.usageOnly ?? true;
  const hasChoice = input.delta !== undefined || input.finishReason !== undefined && input.finishReason !== null;
  const choices: ChatCompletionChunkChoice[] =
    !hasChoice && usageOnly && input.usage !== undefined && input.usage !== null
      ? []
      : [{ index: 0, delta: input.delta ?? {}, finish_reason: input.finishReason ?? null, logprobs: null }];
  return {
    id: input.id,
    object: 'chat.completion.chunk',
    created: input.created,
    model: input.model,
    choices,
    ...(input.usage === undefined ? {} : { usage: input.usage === null ? null : toOpenAiUsage(input.usage) }),
    ...(input.systemFingerprint === undefined ? {} : { system_fingerprint: input.systemFingerprint }),
  };
}

/** Formats one SSE frame: `data: <json>\n\n`. */
export function formatSseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The terminal SSE frame of a streamed completion. */
export const SSE_DONE = 'data: [DONE]\n\n';

/** Formats the final SSE comment line carrying cost and balance (SPEC §5.8). */
export function formatSseBeagleTrailer(costMicro: bigint, balanceMicro: bigint): string {
  return `: beagle cost=${costMicro.toString()} balance=${balanceMicro.toString()}\n\n`;
}

// ---------------------------------------------------------------------------------------------
// Models list

/** Beagle extension fields on `/v1/models` entries (SPEC §5.8). */
export const OpenAiModelBeagleSchema = z.object({
  tier: z.enum(TIER_ORDER).nullable(),
  price: ModelPriceSchema.nullable(),
  available: z.boolean(),
  requiresPlan: z.literal('pro').nullable(),
  alias: z.boolean(),
});

/** One `/v1/models` entry. */
export const OpenAiModelSchema = z.object({
  id: z.string(),
  object: z.literal('model'),
  created: z.number().int(),
  owned_by: z.string(),
  beagle: OpenAiModelBeagleSchema.optional(),
});
export type OpenAiModel = z.output<typeof OpenAiModelSchema>;

/** `GET /v1/models`. */
export const OpenAiModelListSchema = z.object({ object: z.literal('list'), data: z.array(OpenAiModelSchema) });
export type OpenAiModelList = z.output<typeof OpenAiModelListSchema>;

// ---------------------------------------------------------------------------------------------
// Errors

/** Error codes of the inference API (SPEC §5.8) plus the two generic ones. */
export const OPENAI_ERROR_CODES = [
  'invalid_request_error',
  'invalid_api_key',
  'insufficient_credit',
  'plan_required',
  'model_not_found',
  'rate_limited',
  'upstream_rate_limited',
  'upstream_error',
  'no_model_available',
  'request_too_large',
  'internal_error',
] as const;
/** One of {@link OPENAI_ERROR_CODES}. */
export type OpenAiErrorCode = (typeof OPENAI_ERROR_CODES)[number];

/** Error code → HTTP status (SPEC §5.8). */
export const ERROR_STATUS: Readonly<Record<OpenAiErrorCode, number>> = Object.freeze({
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

/** `true` when `code` is one of {@link OPENAI_ERROR_CODES}. */
export function isOpenAiErrorCode(code: string): code is OpenAiErrorCode {
  return (OPENAI_ERROR_CODES as readonly string[]).includes(code);
}

/** OpenAI error envelope. */
export interface OpenAiErrorBody {
  error: { message: string; type: string; code: string; param: string | null };
}

/** Zod schema of {@link OpenAiErrorBody}. */
export const OpenAiErrorBodySchema = z.object({
  error: z.object({ message: z.string(), type: z.string(), code: z.string().nullable(), param: z.string().nullable() }),
});

/** An error ready to send: status plus envelope. */
export interface OpenAiErrorResponse {
  status: number;
  body: OpenAiErrorBody;
}

/**
 * Builds the OpenAI error envelope `{ error: { message, type, code, param } }` for `code`.
 * `type` defaults to the code itself (as in the 402 body of SPEC §5.7); `status` defaults to
 * {@link ERROR_STATUS}.
 */
export function openAiError(
  code: OpenAiErrorCode,
  message: string,
  status: number = ERROR_STATUS[code],
  options: { param?: string | null; type?: string } = {},
): OpenAiErrorResponse {
  return {
    status,
    body: { error: { message, type: options.type ?? code, code, param: options.param ?? null } },
  };
}

/** Anthropic error envelope (`/v1/messages`). */
export interface AnthropicErrorBody {
  type: 'error';
  error: { type: string; message: string };
}

/** Anthropic error `type` for each Beagle error code (SPEC §5.8). */
export const ANTHROPIC_ERROR_TYPE: Readonly<Record<OpenAiErrorCode, string>> = Object.freeze({
  invalid_request_error: 'invalid_request_error',
  invalid_api_key: 'authentication_error',
  insufficient_credit: 'invalid_request_error',
  plan_required: 'permission_error',
  model_not_found: 'not_found_error',
  rate_limited: 'rate_limit_error',
  upstream_rate_limited: 'rate_limit_error',
  upstream_error: 'api_error',
  no_model_available: 'overloaded_error',
  request_too_large: 'request_too_large',
  internal_error: 'api_error',
});

/**
 * Builds the Anthropic error envelope `{ type: 'error', error: { type, message } }`. For
 * `insufficient_credit` the message is prefixed with `insufficient_credit: ` (SPEC §5.8).
 */
export function anthropicError(
  code: OpenAiErrorCode,
  message: string,
  status: number = ERROR_STATUS[code],
): { status: number; body: AnthropicErrorBody } {
  const text = code === 'insufficient_credit' && !message.startsWith('insufficient_credit:') ? `insufficient_credit: ${message}` : message;
  return { status, body: { type: 'error', error: { type: ANTHROPIC_ERROR_TYPE[code], message: text } } };
}
