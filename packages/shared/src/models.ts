/**
 * Model catalog and pricing (`docs/SPEC.md` §3.1 `models.ts`). The on-chain `modelId` is
 * `keccak256(toBytes(id))` — the keccak of the UTF-8 bytes of the catalog id.
 *
 * Usage is billed at the model that *served* a request (`message.model`), which differs from the
 * requested model when server-side fallbacks run; {@link MODEL_PRICES} therefore also lists the
 * fallback targets, and {@link costOfUsageMicroUsd} computes exact integer micro-USD so draw
 * receipts are reproducible.
 *
 * @module models
 */
import { keccak256, toBytes, type Hex } from 'viem';

/** Model ids a mind can be configured with. */
export type ModelId = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-4-5' | 'claude-fable-5-1';

/** Per-token prices, USD per million tokens. */
export interface ModelPrices {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
}

/** One entry of the model catalog. */
export interface ModelSpec extends ModelPrices {
  /** Anthropic model id, passed verbatim to the SDK. */
  id: ModelId;
  /** Display label. */
  label: string;
  /** Short description for the create form. */
  description: string;
  /** `keccak256(toBytes(id))` — stored on-chain as `bytes32 modelId`. */
  modelIdHash: Hex;
  /** `max_tokens` per request. */
  maxTokens: number;
  /** Thinking configuration: adaptive/summarized for the 5.x family, an explicit budget for haiku-4-5. */
  thinking: { type: 'adaptive'; display: 'summarized' } | { type: 'enabled'; budget_tokens: number };
  /** Whether `output_config: { effort: 'medium' }` is sent. */
  supportsEffort: boolean;
  /** Whether server-side fallbacks (`betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`) are sent. */
  supportsFallbacks: boolean;
}

/** Converts a model id string to its on-chain `bytes32` hash: `keccak256(toBytes(id))`. */
export function modelIdToHash(id: string): Hex {
  return keccak256(toBytes(id));
}

/** The default model for new minds. */
export const DEFAULT_MODEL: ModelId = 'claude-opus-5-5';

const ADAPTIVE = { type: 'adaptive', display: 'summarized' } as const;

/** Catalog of supported models (catalog order is display order). */
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
    maxTokens: 16_000,
    thinking: ADAPTIVE,
    supportsEffort: true,
    supportsFallbacks: true,
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
    maxTokens: 16_000,
    thinking: ADAPTIVE,
    supportsEffort: true,
    supportsFallbacks: true,
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
    maxTokens: 8_192,
    thinking: { type: 'enabled', budget_tokens: 2048 },
    supportsEffort: false,
    supportsFallbacks: false,
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
    maxTokens: 16_000,
    thinking: ADAPTIVE,
    supportsEffort: true,
    supportsFallbacks: true,
  },
] satisfies ModelSpec[]);

/** All model ids in catalog order. */
export const MODEL_IDS: readonly ModelId[] = MODELS.map((m) => m.id);

/** Type guard for {@link ModelId}. */
export function isModelId(id: string): id is ModelId {
  return (MODEL_IDS as readonly string[]).includes(id);
}

/** Looks up a model by its on-chain `bytes32` hash (case-insensitive). `undefined` if unknown. */
export function modelById(hash: string): ModelSpec | undefined {
  const needle = hash.toLowerCase();
  return MODELS.find((m) => m.modelIdHash.toLowerCase() === needle);
}

/** Looks up a model by its string id. `undefined` if unknown. */
export function modelSpec(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}

/** The catalog entry of {@link DEFAULT_MODEL}. */
export const DEFAULT_MODEL_SPEC: ModelSpec = MODELS.find((m) => m.id === DEFAULT_MODEL) as ModelSpec;

function prices(m: ModelPrices): ModelPrices {
  return Object.freeze({
    inputUsdPerMTok: m.inputUsdPerMTok,
    outputUsdPerMTok: m.outputUsdPerMTok,
    cacheReadUsdPerMTok: m.cacheReadUsdPerMTok,
    cacheWriteUsdPerMTok: m.cacheWriteUsdPerMTok,
  });
}

/**
 * Prices of every model that may serve a request: the four catalog models plus the server-side
 * fallback targets `claude-opus-5`, `claude-opus-4-8` and `claude-sonnet-5`.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrices>> = Object.freeze({
  ...Object.fromEntries(MODELS.map((m) => [m.id, prices(m)])),
  'claude-opus-5': prices({ inputUsdPerMTok: 5, outputUsdPerMTok: 25, cacheReadUsdPerMTok: 0.5, cacheWriteUsdPerMTok: 6.25 }),
  'claude-opus-4-8': prices({ inputUsdPerMTok: 5, outputUsdPerMTok: 25, cacheReadUsdPerMTok: 0.5, cacheWriteUsdPerMTok: 6.25 }),
  'claude-sonnet-5': prices({ inputUsdPerMTok: 2, outputUsdPerMTok: 10, cacheReadUsdPerMTok: 0.2, cacheWriteUsdPerMTok: 2.5 }),
});

/**
 * Prices for the model id reported in `message.model` (exact id match). Unknown ids get the
 * `claude-fable-5-1` prices (the most expensive catalog model) and `known: false`.
 */
export function pricesForServedModel(model: string): { prices: ModelPrices; known: boolean } {
  const hit = Object.prototype.hasOwnProperty.call(MODEL_PRICES, model) ? MODEL_PRICES[model] : undefined;
  if (hit !== undefined) return { prices: hit, known: true };
  return { prices: MODEL_PRICES['claude-fable-5-1'] as ModelPrices, known: false };
}

/** Token usage counters as reported by the Anthropic API (structurally compatible with `BetaUsage`). */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** USD per MTok → integer nano-USD per token (`Math.round(usdPerMTok · 1000)`). */
function nanoPerToken(usdPerMTok: number): bigint {
  if (!Number.isFinite(usdPerMTok) || usdPerMTok < 0) throw new RangeError(`invalid price ${usdPerMTok}`);
  return BigInt(Math.round(usdPerMTok * 1000));
}

function count(value: number | null | undefined): bigint {
  const n = value ?? 0;
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`token count ${String(value)} must be a non-negative integer`);
  return BigInt(n);
}

/**
 * Exact cost of one response in integer micro-USD, billed at `servedModel` (unknown models at
 * `claude-fable-5-1` prices):
 *
 * ```
 * cost = ceil( Σ tokens_class · nanoPerToken_class / 1000 )
 * ```
 * over uncached input, output, cache-read and cache-write tokens.
 */
export function costOfUsageMicroUsd(servedModel: string, usage: TokenUsage): number {
  const p = pricesForServedModel(servedModel).prices;
  const nano =
    count(usage.input_tokens) * nanoPerToken(p.inputUsdPerMTok) +
    count(usage.output_tokens) * nanoPerToken(p.outputUsdPerMTok) +
    count(usage.cache_read_input_tokens) * nanoPerToken(p.cacheReadUsdPerMTok) +
    count(usage.cache_creation_input_tokens) * nanoPerToken(p.cacheWriteUsdPerMTok);
  return Number((nano + 999n) / 1000n);
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

/** Strips request flags from a model spec (what the API serves). */
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
