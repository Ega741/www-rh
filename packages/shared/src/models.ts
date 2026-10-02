/**
 * Model catalog (SPEC §3 `models.ts`, directive R12). The on-chain `modelId` is
 * `keccak256(toBytes(id))` — the keccak of the UTF-8 bytes of the catalog id string.
 *
 * Also exports the price table used to bill usage at the model that actually *served* a request
 * (`message.model`), which may differ from the requested model when server-side fallbacks run,
 * and an exact integer micro-USD cost function so draw receipts are reproducible (R2).
 *
 * @module models
 */
import { keccak256, toBytes, type Hex } from 'viem';

/** Model ids a mind can be configured with. */
export type ModelId = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-4-5' | 'claude-fable-5-1';

/** Per-token prices, USD per million tokens. */
export interface ModelPricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
}

/** Thinking configuration the runner sends for a model (SDK rules in the implementation brief). */
export type ModelThinkingConfig = { type: 'adaptive'; display: 'summarized' } | { type: 'enabled'; budget_tokens: number };

/** One entry of the model catalog. Prices are USD per million tokens. */
export interface ModelSpec extends ModelPricing {
  /** Anthropic model id, passed verbatim to the SDK. */
  id: ModelId;
  /** Display label. */
  label: string;
  /** Short description for the create form. */
  description: string;
  /** `keccak256(toBytes(id))` — stored on-chain as `bytes32 modelId` (R12). */
  modelIdHash: Hex;
  /** Whether server-side fallbacks (`betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`) are sent. */
  supportsFallbacks: boolean;
  /** Thinking configuration: adaptive/summarized for the 5.x family, an explicit budget for haiku-4-5. */
  thinking: ModelThinkingConfig;
  /** `output_config.effort` to send, or `null` when the model does not take it (haiku-4-5). */
  effort: 'medium' | null;
  /** `max_tokens` per request. */
  maxTokens: number;
}

/** Converts a model id string to its on-chain `bytes32` hash: `keccak256(toBytes(id))` (R12). */
export function modelIdToHash(id: string): Hex {
  return keccak256(toBytes(id));
}

/** The default model for new minds. */
export const DEFAULT_MODEL: ModelId = 'claude-opus-5-5';

/** Catalog of supported models with prices (USD / MTok) and request flags. */
export const MODELS: readonly ModelSpec[] = Object.freeze([
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    description: 'Default. Strongest reasoning and browsing; balanced price.',
    modelIdHash: modelIdToHash('claude-opus-5-5'),
    inputUsdPerMTok: 4,
    outputUsdPerMTok: 20,
    cacheReadUsdPerMTok: 0.2,
    cacheWriteUsdPerMTok: 5,
    supportsFallbacks: true,
    thinking: { type: 'adaptive', display: 'summarized' },
    effort: 'medium',
    maxTokens: 16_000,
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    description: 'Fast and capable; half the price of Opus.',
    modelIdHash: modelIdToHash('claude-sonnet-5-5'),
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 10,
    cacheReadUsdPerMTok: 0.2,
    cacheWriteUsdPerMTok: 2.5,
    supportsFallbacks: true,
    thinking: { type: 'adaptive', display: 'summarized' },
    effort: 'medium',
    maxTokens: 16_000,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    description: 'Cheapest; good for long-lived minds on a small vault.',
    modelIdHash: modelIdToHash('claude-haiku-4-5'),
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    cacheReadUsdPerMTok: 0.1,
    cacheWriteUsdPerMTok: 1.25,
    supportsFallbacks: false,
    thinking: { type: 'enabled', budget_tokens: 2048 },
    effort: null,
    maxTokens: 8_192,
  },
  {
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    description: 'Premium frontier model; most expensive.',
    modelIdHash: modelIdToHash('claude-fable-5-1'),
    inputUsdPerMTok: 10,
    outputUsdPerMTok: 50,
    cacheReadUsdPerMTok: 0.25,
    cacheWriteUsdPerMTok: 12.5,
    supportsFallbacks: true,
    thinking: { type: 'adaptive', display: 'summarized' },
    effort: 'medium',
    maxTokens: 16_000,
  },
] satisfies ModelSpec[]);

/** All model ids in catalog order. */
export const MODEL_IDS: readonly ModelId[] = MODELS.map((m) => m.id);

/** Type guard for {@link ModelId}. */
export function isModelId(id: string): id is ModelId {
  return (MODEL_IDS as readonly string[]).includes(id);
}

/** Looks up a model by its on-chain `bytes32` hash (case-insensitive). Returns `undefined` if unknown. */
export function modelById(hash: string): ModelSpec | undefined {
  const needle = hash.toLowerCase();
  return MODELS.find((m) => m.modelIdHash.toLowerCase() === needle);
}

/** Looks up a model by its string id. Returns `undefined` if unknown. */
export function modelSpec(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}

/** The catalog entry of {@link DEFAULT_MODEL}. */
export const DEFAULT_MODEL_SPEC: ModelSpec = MODELS.find((m) => m.id === DEFAULT_MODEL) as ModelSpec;

/**
 * Prices of models that may *serve* a request without being in the catalog: the targets of
 * server-side fallbacks (`fallbacks: 'default'` routes declined requests to e.g. Claude Opus 5 /
 * Claude Opus 4.8 / Claude Sonnet 5). Usage is billed at the served model (`message.model`).
 */
export const SERVED_MODEL_PRICING: Readonly<Record<string, Readonly<ModelPricing>>> = Object.freeze({
  'claude-opus-5-5': { inputUsdPerMTok: 4, outputUsdPerMTok: 20, cacheReadUsdPerMTok: 0.2, cacheWriteUsdPerMTok: 5 },
  'claude-sonnet-5-5': { inputUsdPerMTok: 2, outputUsdPerMTok: 10, cacheReadUsdPerMTok: 0.2, cacheWriteUsdPerMTok: 2.5 },
  'claude-haiku-4-5': { inputUsdPerMTok: 1, outputUsdPerMTok: 5, cacheReadUsdPerMTok: 0.1, cacheWriteUsdPerMTok: 1.25 },
  'claude-fable-5-1': { inputUsdPerMTok: 10, outputUsdPerMTok: 50, cacheReadUsdPerMTok: 0.25, cacheWriteUsdPerMTok: 12.5 },
  'claude-opus-5': { inputUsdPerMTok: 5, outputUsdPerMTok: 25, cacheReadUsdPerMTok: 0.5, cacheWriteUsdPerMTok: 6.25 },
  'claude-opus-4-8': { inputUsdPerMTok: 5, outputUsdPerMTok: 25, cacheReadUsdPerMTok: 0.5, cacheWriteUsdPerMTok: 6.25 },
  'claude-sonnet-5': { inputUsdPerMTok: 2, outputUsdPerMTok: 10, cacheReadUsdPerMTok: 0.2, cacheWriteUsdPerMTok: 2.5 },
  'claude-fable-5': { inputUsdPerMTok: 10, outputUsdPerMTok: 50, cacheReadUsdPerMTok: 1, cacheWriteUsdPerMTok: 12.5 },
});

/** Extracts the pricing fields of a catalog entry. */
export function pricingOf(model: ModelPricing): ModelPricing {
  return {
    inputUsdPerMTok: model.inputUsdPerMTok,
    outputUsdPerMTok: model.outputUsdPerMTok,
    cacheReadUsdPerMTok: model.cacheReadUsdPerMTok,
    cacheWriteUsdPerMTok: model.cacheWriteUsdPerMTok,
  };
}

/**
 * Pricing for the model id reported in `message.model`. Exact ids win; dated snapshot ids
 * (`claude-haiku-4-5-20251001`) match their alias by longest prefix. Returns `undefined` for an
 * unknown model so the caller can decide (the runner falls back to the requested model's price).
 */
export function pricingForServedModel(servedModel: string): ModelPricing | undefined {
  const exact = SERVED_MODEL_PRICING[servedModel];
  if (exact !== undefined) return pricingOf(exact);
  let best: string | undefined;
  for (const id of Object.keys(SERVED_MODEL_PRICING)) {
    if (servedModel.startsWith(`${id}-`) && (best === undefined || id.length > best.length)) best = id;
  }
  const hit = best === undefined ? undefined : SERVED_MODEL_PRICING[best];
  return hit === undefined ? undefined : pricingOf(hit);
}

/** Token usage counters as reported by the Anthropic API (`message.usage`). */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null | undefined;
  cache_creation_input_tokens?: number | null | undefined;
}

/**
 * Cost in USD (floating point) of `usage` under `model` prices. Uncached input tokens are billed
 * at `inputUsdPerMTok`; cache reads/writes at their own rates; output at `outputUsdPerMTok`.
 * Prefer {@link costOfUsageMicroUsd} wherever the value is persisted or hashed.
 */
export function costOfUsageUsd(model: ModelPricing, usage: TokenUsage): number {
  return costOfUsageMicroUsd(model, usage) / 1_000_000;
}

/** Converts a USD-per-MTok price (at most 2 decimals) to integer centi-USD per MTok. */
function centiUsdPerMTok(price: number): bigint {
  const cents = Math.round(price * 100);
  if (!Number.isFinite(price) || price < 0 || Math.abs(cents - price * 100) > 1e-6) {
    throw new RangeError(`price ${price} USD/MTok must be non-negative with at most 2 decimals`);
  }
  return BigInt(cents);
}

function tokens(value: number | null | undefined): bigint {
  const n = value ?? 0;
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`token count ${String(value)} must be a non-negative integer`);
  return BigInt(n);
}

/**
 * Exact cost of `usage` in integer micro-USD (1e-6 USD), the unit used by draw receipts (R2):
 *
 * ```
 * costUsdMicro = round_half_up( Σ_class tokens_class · priceCentiUsdPerMTok_class / 100 )
 * ```
 *
 * (`tokens · USD/MTok` is micro-USD; prices are scaled to integer cents to keep the arithmetic exact.)
 */
export function costOfUsageMicroUsd(model: ModelPricing, usage: TokenUsage): number {
  const sum =
    tokens(usage.input_tokens) * centiUsdPerMTok(model.inputUsdPerMTok) +
    tokens(usage.output_tokens) * centiUsdPerMTok(model.outputUsdPerMTok) +
    tokens(usage.cache_read_input_tokens) * centiUsdPerMTok(model.cacheReadUsdPerMTok) +
    tokens(usage.cache_creation_input_tokens) * centiUsdPerMTok(model.cacheWriteUsdPerMTok);
  return Number((sum + 50n) / 100n);
}

/** Public projection of a {@link ModelSpec} for `GET /api/models` (no request flags). */
export interface PublicModelSpec {
  id: ModelId;
  label: string;
  description: string;
  modelIdHash: Hex;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
  isDefault: boolean;
}

/** Strips runtime-only fields from a model spec (what the API serves). */
export function toPublicModelSpec(model: ModelSpec): PublicModelSpec {
  return {
    id: model.id,
    label: model.label,
    description: model.description,
    modelIdHash: model.modelIdHash,
    inputUsdPerMTok: model.inputUsdPerMTok,
    outputUsdPerMTok: model.outputUsdPerMTok,
    cacheReadUsdPerMTok: model.cacheReadUsdPerMTok,
    cacheWriteUsdPerMTok: model.cacheWriteUsdPerMTok,
    isDefault: model.id === DEFAULT_MODEL,
  };
}
