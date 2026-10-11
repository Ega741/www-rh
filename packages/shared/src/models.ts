/**
 * Model catalog (SPEC §4.4): the default table of upstream models with µUSD prices per 1M tokens,
 * the `beagle/*` aliases, lookup helpers and the operator override merge.
 *
 * @module models
 */
import { z } from 'zod';

/** Upstream providers. `house` is the project's own vLLM deployment. */
export const PROVIDERS = ['anthropic', 'openai', 'google', 'house'] as const;
/** One of {@link PROVIDERS}. */
export type Provider = (typeof PROVIDERS)[number];

/** Providers a workspace may bring its own key for (SPEC §5.9). */
export const BYOK_PROVIDERS = ['anthropic', 'openai', 'google'] as const;
/** One of {@link BYOK_PROVIDERS}. */
export type ByokProvider = (typeof BYOK_PROVIDERS)[number];

/** Price classes, most expensive first. The router walks this list when falling back. */
export const TIER_ORDER = ['frontier', 'efficient', 'budget', 'house'] as const;
/** One of {@link TIER_ORDER}. */
export type Tier = (typeof TIER_ORDER)[number];

/** Workspace plans (SPEC §5.11). */
export const PLANS = ['free', 'pro'] as const;
/** One of {@link PLANS}. */
export type Plan = (typeof PLANS)[number];

/** Virtual model ids resolved by the router (SPEC §1). */
export const ALIASES = ['beagle/auto', 'beagle/best', 'beagle/cheap', 'beagle/house'] as const;
/** One of {@link ALIASES}. */
export type Alias = (typeof ALIASES)[number];

/** Short descriptions of the aliases for `/v1/models` and the MCP catalog. */
export const ALIAS_DESCRIPTIONS: Readonly<Record<Alias, string>> = Object.freeze({
  'beagle/auto': 'Picks a tier from the estimated difficulty, downgrades as credit or provider limits run down.',
  'beagle/best': 'Frontier tier first, then cheaper fallbacks.',
  'beagle/cheap': 'Budget tier first, then the house model.',
  'beagle/house': "The project's own model served by vLLM.",
});

/** µUSD per 1M tokens. */
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
}

/** What a model can do; the router drops models lacking a capability the request needs. */
export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  json: boolean;
  reasoning: boolean;
}

/** One catalog entry. */
export interface ModelSpec {
  /** Catalog id `provider/model`. */
  id: string;
  provider: Provider;
  /** Id sent to the provider. */
  upstreamId: string;
  displayName: string;
  tier: Tier;
  contextWindow: number;
  maxOutput: number;
  price: ModelPrice;
  capabilities: ModelCapabilities;
  /** May the router pick it for aliases and fallback expansion? */
  autoEligible: boolean;
  requiresPlan?: 'pro';
  notes?: string;
}

const nonNegInt = z.number().int().nonnegative();
const posInt = z.number().int().positive();

/** Zod schema of {@link ModelPrice}. */
export const ModelPriceSchema = z.object({
  inputPerM: nonNegInt,
  outputPerM: nonNegInt,
  cacheReadPerM: nonNegInt.optional(),
  cacheWritePerM: nonNegInt.optional(),
});

/** Zod schema of {@link ModelCapabilities}. */
export const ModelCapabilitiesSchema = z.object({
  tools: z.boolean(),
  vision: z.boolean(),
  json: z.boolean(),
  reasoning: z.boolean(),
});

/** Zod schema of a complete {@link ModelSpec} (used for new entries in catalog override files). */
export const ModelSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/, 'model id must look like provider/model'),
  provider: z.enum(PROVIDERS),
  upstreamId: z.string().min(1),
  displayName: z.string().min(1),
  tier: z.enum(TIER_ORDER),
  contextWindow: posInt,
  maxOutput: posInt,
  price: ModelPriceSchema,
  capabilities: ModelCapabilitiesSchema,
  autoEligible: z.boolean(),
  requiresPlan: z.literal('pro').optional(),
  notes: z.string().optional(),
});

/**
 * One entry of an operator catalog override (`MODEL_CATALOG_FILE`): a partial {@link ModelSpec}
 * keyed by `id`; `remove: true` deletes the model; `requiresPlan: null` / `notes: null` clear
 * those fields. Entries whose `id` is not in the defaults must be complete.
 */
export const CatalogOverrideSchema = z.object({
  id: z.string().min(1),
  remove: z.boolean().optional(),
  provider: z.enum(PROVIDERS).optional(),
  upstreamId: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  tier: z.enum(TIER_ORDER).optional(),
  contextWindow: posInt.optional(),
  maxOutput: posInt.optional(),
  price: ModelPriceSchema.partial().optional(),
  capabilities: ModelCapabilitiesSchema.partial().optional(),
  autoEligible: z.boolean().optional(),
  requiresPlan: z.literal('pro').nullable().optional(),
  notes: z.string().nullable().optional(),
});

/** Parsed form of {@link CatalogOverrideSchema}. */
export type CatalogOverride = z.output<typeof CatalogOverrideSchema>;

/** Zod schema of a whole override file: an array of {@link CatalogOverrideSchema}. */
export const CatalogOverridesFileSchema = z.array(CatalogOverrideSchema);

const THIRD_PARTY_NOTE = 'price snapshot 2026-10; verify';
const ALL: ModelCapabilities = { tools: true, vision: true, json: true, reasoning: true };

function spec(s: ModelSpec): ModelSpec {
  return Object.freeze({ ...s, price: Object.freeze({ ...s.price }), capabilities: Object.freeze({ ...s.capabilities }) });
}

/** The default catalog of SPEC §4.4 (prices are µUSD per 1M tokens, snapshot 2026-10). */
export const DEFAULT_CATALOG: readonly ModelSpec[] = Object.freeze([
  spec({
    id: 'anthropic/claude-opus-5-5',
    provider: 'anthropic',
    upstreamId: 'claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    tier: 'frontier',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    price: { inputPerM: 4_000_000, outputPerM: 20_000_000, cacheReadPerM: 200_000, cacheWritePerM: 5_000_000 },
    capabilities: ALL,
    autoEligible: true,
  }),
  spec({
    id: 'anthropic/claude-sonnet-5-5',
    provider: 'anthropic',
    upstreamId: 'claude-sonnet-5-5',
    displayName: 'Claude Sonnet 5.5',
    tier: 'efficient',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    price: { inputPerM: 2_000_000, outputPerM: 10_000_000, cacheReadPerM: 200_000, cacheWritePerM: 2_500_000 },
    capabilities: ALL,
    autoEligible: true,
  }),
  spec({
    id: 'anthropic/claude-haiku-5-5',
    provider: 'anthropic',
    upstreamId: 'claude-haiku-5-5',
    displayName: 'Claude Haiku 5.5',
    tier: 'budget',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    price: { inputPerM: 100_000, outputPerM: 500_000, cacheReadPerM: 10_000, cacheWritePerM: 125_000 },
    capabilities: ALL,
    autoEligible: true,
  }),
  spec({
    id: 'anthropic/claude-fable-5-1',
    provider: 'anthropic',
    upstreamId: 'claude-fable-5-1',
    displayName: 'Claude Fable 5.1',
    tier: 'frontier',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    price: { inputPerM: 10_000_000, outputPerM: 50_000_000, cacheReadPerM: 250_000, cacheWritePerM: 12_500_000 },
    capabilities: ALL,
    autoEligible: false,
    notes: 'explicit only: never picked by aliases or fallback',
  }),
  spec({
    id: 'openai/gpt-5.5',
    provider: 'openai',
    upstreamId: 'gpt-5.5',
    displayName: 'GPT-5.5',
    tier: 'frontier',
    contextWindow: 400_000,
    maxOutput: 128_000,
    price: { inputPerM: 5_000_000, outputPerM: 30_000_000, cacheReadPerM: 500_000 },
    capabilities: ALL,
    autoEligible: true,
    notes: THIRD_PARTY_NOTE,
  }),
  spec({
    id: 'openai/gpt-5.4-mini',
    provider: 'openai',
    upstreamId: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 mini',
    tier: 'efficient',
    contextWindow: 400_000,
    maxOutput: 128_000,
    price: { inputPerM: 750_000, outputPerM: 4_500_000, cacheReadPerM: 75_000 },
    capabilities: ALL,
    autoEligible: true,
    notes: THIRD_PARTY_NOTE,
  }),
  spec({
    id: 'openai/gpt-5.4-nano',
    provider: 'openai',
    upstreamId: 'gpt-5.4-nano',
    displayName: 'GPT-5.4 nano',
    tier: 'budget',
    contextWindow: 400_000,
    maxOutput: 128_000,
    price: { inputPerM: 200_000, outputPerM: 1_200_000, cacheReadPerM: 20_000 },
    capabilities: { tools: true, vision: true, json: true, reasoning: false },
    autoEligible: true,
    notes: THIRD_PARTY_NOTE,
  }),
  spec({
    id: 'google/gemini-3.1-pro',
    provider: 'google',
    upstreamId: 'gemini-3.1-pro',
    displayName: 'Gemini 3.1 Pro',
    tier: 'frontier',
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    price: { inputPerM: 2_000_000, outputPerM: 12_000_000, cacheReadPerM: 200_000 },
    capabilities: ALL,
    autoEligible: true,
    notes: THIRD_PARTY_NOTE,
  }),
  spec({
    id: 'google/gemini-3-flash',
    provider: 'google',
    upstreamId: 'gemini-3-flash',
    displayName: 'Gemini 3 Flash',
    tier: 'efficient',
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    price: { inputPerM: 500_000, outputPerM: 3_000_000, cacheReadPerM: 50_000 },
    capabilities: ALL,
    autoEligible: true,
    notes: THIRD_PARTY_NOTE,
  }),
  spec({
    id: 'google/gemini-3.1-flash-lite',
    provider: 'google',
    upstreamId: 'gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash-Lite',
    tier: 'budget',
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    price: { inputPerM: 250_000, outputPerM: 1_500_000, cacheReadPerM: 25_000 },
    capabilities: { tools: true, vision: true, json: true, reasoning: false },
    autoEligible: true,
    notes: THIRD_PARTY_NOTE,
  }),
  spec({
    id: 'house/gpt-oss-20b',
    provider: 'house',
    upstreamId: 'openai/gpt-oss-20b',
    displayName: 'gpt-oss-20b (house)',
    tier: 'house',
    contextWindow: 131_072,
    maxOutput: 32_768,
    price: { inputPerM: 50_000, outputPerM: 200_000 },
    capabilities: { tools: true, vision: false, json: true, reasoning: true },
    autoEligible: true,
  }),
  spec({
    id: 'house/gpt-oss-120b',
    provider: 'house',
    upstreamId: 'openai/gpt-oss-120b',
    displayName: 'gpt-oss-120b (house, Pro)',
    tier: 'house',
    contextWindow: 131_072,
    maxOutput: 32_768,
    price: { inputPerM: 100_000, outputPerM: 500_000 },
    capabilities: { tools: true, vision: false, json: true, reasoning: true },
    autoEligible: true,
    requiresPlan: 'pro',
  }),
]);

/** `true` when `id` is one of {@link ALIASES}. */
export function isAlias(id: string): id is Alias {
  return (ALIASES as readonly string[]).includes(id);
}

/** Position of `tier` in {@link TIER_ORDER} (0 = frontier). */
export function tierIndex(tier: Tier): number {
  return TIER_ORDER.indexOf(tier);
}

/** The next cheaper tier, or `undefined` for `house`. */
export function cheaperTier(tier: Tier): Tier | undefined {
  return TIER_ORDER[tierIndex(tier) + 1];
}

/** The next more expensive tier, or `undefined` for `frontier`. */
export function pricierTier(tier: Tier): Tier | undefined {
  const i = tierIndex(tier);
  return i <= 0 ? undefined : TIER_ORDER[i - 1];
}

/** The model with catalog id `id`, else the unique model with upstream id `id`, else `undefined`. */
export function findModel(id: string, catalog: readonly ModelSpec[] = DEFAULT_CATALOG): ModelSpec | undefined {
  const byId = catalog.find((m) => m.id === id);
  if (byId) return byId;
  const byUpstream = catalog.filter((m) => m.upstreamId === id);
  return byUpstream.length === 1 ? byUpstream[0] : undefined;
}

/** Result of {@link resolveModel}: a concrete model or an alias. */
export type ResolvedModel = { kind: 'model'; model: ModelSpec } | { kind: 'alias'; alias: Alias };

/**
 * Resolves a requested model id: a catalog id, one of the {@link ALIASES}, or a bare upstream id
 * when it is unique in the catalog. Returns `undefined` for unknown or ambiguous ids.
 */
export function resolveModel(id: string, catalog: readonly ModelSpec[] = DEFAULT_CATALOG): ResolvedModel | undefined {
  const trimmed = id.trim();
  if (isAlias(trimmed)) return { kind: 'alias', alias: trimmed };
  const model = findModel(trimmed, catalog);
  return model === undefined ? undefined : { kind: 'model', model };
}

/** Groups `catalog` by tier (catalog order preserved; every tier present, possibly empty). */
export function modelsByTier(catalog: readonly ModelSpec[] = DEFAULT_CATALOG): Readonly<Record<Tier, ModelSpec[]>> {
  const groups: Record<Tier, ModelSpec[]> = { frontier: [], efficient: [], budget: [], house: [] };
  for (const m of catalog) groups[m.tier].push(m);
  return groups;
}

/** The models of `catalog` in `tier`, in catalog order. */
export function modelsInTier(catalog: readonly ModelSpec[], tier: Tier): ModelSpec[] {
  return catalog.filter((m) => m.tier === tier);
}

/** Builds an exact {@link ModelSpec} (no explicit `undefined` members) from parsed data. */
function toSpec(parsed: z.output<typeof ModelSpecSchema>): ModelSpec {
  const price: ModelPrice = {
    inputPerM: parsed.price.inputPerM,
    outputPerM: parsed.price.outputPerM,
    ...(parsed.price.cacheReadPerM === undefined ? {} : { cacheReadPerM: parsed.price.cacheReadPerM }),
    ...(parsed.price.cacheWritePerM === undefined ? {} : { cacheWritePerM: parsed.price.cacheWritePerM }),
  };
  return spec({
    id: parsed.id,
    provider: parsed.provider,
    upstreamId: parsed.upstreamId,
    displayName: parsed.displayName,
    tier: parsed.tier,
    contextWindow: parsed.contextWindow,
    maxOutput: parsed.maxOutput,
    price,
    capabilities: { ...parsed.capabilities },
    autoEligible: parsed.autoEligible,
    ...(parsed.requiresPlan === undefined ? {} : { requiresPlan: parsed.requiresPlan }),
    ...(parsed.notes === undefined ? {} : { notes: parsed.notes }),
  });
}

function formatIssues(prefix: string, error: z.ZodError): Error {
  const details = error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return new Error(`${prefix}: ${details}`);
}

/**
 * Applies operator `overrides` to `defaults`: entries are matched by `id`; `remove: true` deletes;
 * other fields replace the defaults (`price` and `capabilities` merge field by field; `null`
 * clears `requiresPlan` / `notes`). Unknown ids are appended and must be complete specs.
 * Throws on invalid input. Pure: returns a new array.
 */
export function mergeCatalog(defaults: readonly ModelSpec[], overrides: readonly unknown[]): ModelSpec[] {
  const parsedOverrides = CatalogOverridesFileSchema.safeParse(overrides);
  if (!parsedOverrides.success) throw formatIssues('mergeCatalog: invalid overrides', parsedOverrides.error);
  const byId = new Map<string, ModelSpec>();
  for (const m of defaults) byId.set(m.id, m);
  for (const o of parsedOverrides.data) {
    const existing = byId.get(o.id);
    if (o.remove) {
      byId.delete(o.id);
      continue;
    }
    const { id, remove: _remove, price, capabilities, requiresPlan, notes, ...rest } = o;
    const definedRest = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    const mergedPrice = { ...(existing?.price ?? {}), ...stripUndefined(price ?? {}) };
    const mergedCaps = { ...(existing?.capabilities ?? {}), ...stripUndefined(capabilities ?? {}) };
    const candidate: Record<string, unknown> = {
      ...(existing ?? {}),
      ...definedRest,
      id,
      price: mergedPrice,
      capabilities: mergedCaps,
    };
    if (requiresPlan === null) delete candidate['requiresPlan'];
    else if (requiresPlan !== undefined) candidate['requiresPlan'] = requiresPlan;
    if (notes === null) delete candidate['notes'];
    else if (notes !== undefined) candidate['notes'] = notes;
    const parsed = ModelSpecSchema.safeParse(candidate);
    if (!parsed.success) {
      throw formatIssues(
        existing ? `mergeCatalog: invalid override for ${id}` : `mergeCatalog: new model ${id} is incomplete`,
        parsed.error,
      );
    }
    byId.set(id, toSpec(parsed.data));
  }
  return [...byId.values()];
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** `inputPerM + outputPerM`: the router's cheapness key within a tier. */
export function modelPriceSum(model: ModelSpec): number {
  return model.price.inputPerM + model.price.outputPerM;
}
