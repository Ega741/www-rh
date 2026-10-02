/**
 * Model catalog (SPEC §3 `models.ts` / §4). The on-chain `modelId` is `keccak256(utf8(id))`.
 *
 * @module models
 */
import { keccak256, toHex, type Hex } from 'viem';

/** Model ids a mind can be configured with. */
export type ModelId = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-4-5' | 'claude-fable-5-1';

/** One entry of the model catalog. Prices are USD per million tokens. */
export interface ModelSpec {
  /** Anthropic model id, passed verbatim to the SDK. */
  id: ModelId;
  /** Display label. */
  label: string;
  /** Short description for the create form. */
  description: string;
  /** `keccak256(toHex(id))` — stored on-chain as `bytes32 modelId`. */
  modelIdHash: Hex;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
  /** Whether server-side fallbacks (`betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`) may be used. */
  supportsFallbacks: boolean;
  /**
   * Thinking configuration the runner must send for this model (SPEC §4.1):
   * adaptive/summarized for the 5.x family, an explicit budget for haiku-4-5.
   */
  thinking: { type: 'adaptive'; display: 'summarized' } | { type: 'enabled'; budget_tokens: number };
}

/** Converts a model id string to its on-chain `bytes32` hash (`keccak256(utf8(id))`). */
export function modelIdToHash(id: string): Hex {
  return keccak256(toHex(id));
}

/** The default model for new minds. */
export const DEFAULT_MODEL: ModelId = 'claude-opus-5-5';

/** Catalog of supported models with prices (USD / MTok) and runtime flags. */
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

/** Token usage counters as reported by the Anthropic API (`message.usage`). */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null | undefined;
  cache_creation_input_tokens?: number | null | undefined;
}

/**
 * Cost in USD of `usage` under `model` prices. Uncached input tokens are billed at
 * `inputUsdPerMTok`; cache reads/writes at their own rates; output at `outputUsdPerMTok`.
 */
export function costOfUsageUsd(model: ModelSpec, usage: TokenUsage): number {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const perTok = 1 / 1_000_000;
  return (
    usage.input_tokens * model.inputUsdPerMTok * perTok +
    cacheRead * model.cacheReadUsdPerMTok * perTok +
    cacheWrite * model.cacheWriteUsdPerMTok * perTok +
    usage.output_tokens * model.outputUsdPerMTok * perTok
  );
}

/** Public projection of a {@link ModelSpec} for `GET /models` (no runtime flags). */
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
