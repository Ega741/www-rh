/**
 * Pure routing policy (SPEC §4.6): turns a request (`beagle/*` alias or explicit model id), the
 * workspace's credit and keys, and provider health into an ordered list of candidate models.
 * Deterministic: no randomness, no clock.
 *
 * @module routing
 */
import { formatUsdMicro } from './credit.js';
import {
  TIER_ORDER,
  cheaperTier,
  modelPriceSum,
  resolveModel,
  tierIndex,
  type Alias,
  type ModelSpec,
  type Plan,
  type Provider,
  type Tier,
} from './models.js';

/** Health of one provider as seen by the gateway (SPEC §5.6). */
export interface ProviderState {
  state: 'ok' | 'degraded' | 'down';
  /** Remaining share of a known rate/spend limit in `[0, 1]`; `< 0.2` counts as degraded. */
  quotaRatio?: number;
}

/** How far the router may stray from the requested model. */
export type FallbackPolicy = 'none' | 'cheaper' | 'any';

/** Who pays for a candidate. */
export type PaidBy = 'credit' | 'byok';

/** What the request needs from a model. */
export interface RoutingNeeds {
  tools: boolean;
  vision: boolean;
  json: boolean;
  /** Estimated prompt tokens. */
  contextTokens: number;
  /** Requested (or default) completion budget. */
  maxOutputTokens: number;
}

/** The billing side of the request. */
export interface RoutingWorkspace {
  /** `balance − reserved + budgetHeadroom` in µUSD (may be negative). */
  availableMicroUsd: bigint;
  plan: Plan;
  /** Providers the workspace brought its own key for. */
  byok: readonly Provider[];
}

/** Tunables of {@link route}; defaults from SPEC §4.6 / §5.11. */
export interface RoutingLimits {
  /** Below this, aliases move one tier cheaper (default $1.00). */
  lowCreditMicroUsd?: bigint;
  /** Below this, aliases go straight to the house tier (default $0.10). */
  veryLowCreditMicroUsd?: bigint;
  /** House context limit on the free plan (default 32_768 tokens). */
  houseFreeContextTokens?: number;
}

/** Input of {@link route}. */
export interface RoutingInput {
  /** Catalog id, alias, or bare upstream id. */
  requested: string;
  /** Difficulty in `[0, 1]` (see `estimateDifficulty`). */
  difficulty: number;
  needs: RoutingNeeds;
  workspace: RoutingWorkspace;
  providers: Record<Provider, ProviderState>;
  /** Defaults to `'cheaper'` (for aliases and explicit ids alike). */
  fallback?: FallbackPolicy;
  catalog: readonly ModelSpec[];
  /** Provider order within a tier; default {@link DEFAULT_PREFERENCE}. */
  preference?: readonly Provider[];
  limits?: RoutingLimits;
}

/** One model the gateway should try, in order. */
export interface Candidate {
  model: ModelSpec;
  paidBy: PaidBy;
}

/** Error codes of {@link route} (mapped to HTTP by the gateway, SPEC §5.6). */
export type RoutingErrorCode = 'unknown_model' | 'plan_required' | 'no_capable_model' | 'insufficient_credit';

/** Result of {@link route}. `tier` is the tier of the first candidate. */
export type RoutingDecision =
  | { kind: 'ok'; tier: Tier; candidates: Candidate[]; reasons: string[] }
  | { kind: 'error'; code: RoutingErrorCode; message: string; reasons: string[] };

/** Default provider preference within a tier. */
export const DEFAULT_PREFERENCE: readonly Provider[] = ['anthropic', 'openai', 'google', 'house'];
/** Default `lowCreditMicroUsd` ($1.00). */
export const DEFAULT_LOW_CREDIT_MICRO_USD = 1_000_000n;
/** Default `veryLowCreditMicroUsd` ($0.10). */
export const DEFAULT_VERY_LOW_CREDIT_MICRO_USD = 100_000n;
/** Default house context limit for the free plan (SPEC §5.11). */
export const DEFAULT_HOUSE_FREE_CONTEXT_TOKENS = 32_768;
/** `quotaRatio` below which a provider counts as degraded. */
export const QUOTA_DEGRADED_RATIO = 0.2;
/** Difficulty below which a quota-limited provider is pushed behind cheaper tiers. */
export const QUOTA_DEMOTION_DIFFICULTY = 0.5;

/** The 402 message of SPEC §5.7. */
export const INSUFFICIENT_CREDIT_MESSAGE = 'Insufficient credit: burn BEAGLE on the Credits page or open a budget.';

/** Tier `beagle/auto` targets for `difficulty`: `≥ 0.66` frontier, `≥ 0.33` efficient, else budget. */
export function autoTier(difficulty: number): Tier {
  if (difficulty >= 0.66) return 'frontier';
  if (difficulty >= 0.33) return 'efficient';
  return 'budget';
}

/** Target tier of an alias (`best → frontier`, `cheap → budget`, `house → house`, `auto → autoTier`). */
export function aliasTier(alias: Alias, difficulty: number): Tier {
  switch (alias) {
    case 'beagle/best':
      return 'frontier';
    case 'beagle/cheap':
      return 'budget';
    case 'beagle/house':
      return 'house';
    case 'beagle/auto':
      return autoTier(difficulty);
  }
}

interface Scored extends Candidate {
  seq: number;
  stateRank: number;
  quotaLimited: boolean;
}

const STATE_RANK: Record<ProviderState['state'], number> = { ok: 0, degraded: 1, down: 2 };

/** Why a model cannot serve the request, or `undefined` when it can (SPEC §4.6 step 2, §5.11). */
export function incapableReason(
  model: ModelSpec,
  needs: RoutingNeeds,
  plan: Plan,
  houseFreeContextTokens = DEFAULT_HOUSE_FREE_CONTEXT_TOKENS,
): string | undefined {
  if (needs.tools && !model.capabilities.tools) return 'no tools';
  if (needs.vision && !model.capabilities.vision) return 'no vision';
  if (needs.json && !model.capabilities.json) return 'no json';
  const total = needs.contextTokens + needs.maxOutputTokens;
  if (model.contextWindow < total) return `context ${total} > ${model.contextWindow}`;
  if (model.requiresPlan !== undefined && model.requiresPlan !== plan) return `requires plan ${model.requiresPlan}`;
  if (model.tier === 'house' && plan === 'free' && total > houseFreeContextTokens) return 'house_context_pro';
  return undefined;
}

/** Position of a tier in the fallback walk from `base`, or `undefined` when the policy excludes it. */
function sequence(tier: Tier, base: Tier, fallback: FallbackPolicy): number | undefined {
  const d = tierIndex(tier) - tierIndex(base);
  if (d === 0) return 0;
  if (fallback === 'none') return undefined;
  if (d > 0) return d;
  if (fallback !== 'any') return undefined;
  return TIER_ORDER.length - 1 - tierIndex(base) - d;
}

function describe(c: Candidate): string {
  return `${c.model.id}(${c.paidBy})`;
}

/**
 * Routes a request (SPEC §4.6). Steps, each appending a reason:
 * 1 resolve · 2 capability filter · 3 paidBy · 4 credit runway (aliases) · 5 provider state ·
 * 6 fallback expansion · 7 credit gate.
 */
export function route(input: RoutingInput): RoutingDecision {
  const reasons: string[] = [];
  const fallback = input.fallback ?? 'cheaper';
  const preference = input.preference ?? DEFAULT_PREFERENCE;
  const low = input.limits?.lowCreditMicroUsd ?? DEFAULT_LOW_CREDIT_MICRO_USD;
  const veryLow = input.limits?.veryLowCreditMicroUsd ?? DEFAULT_VERY_LOW_CREDIT_MICRO_USD;
  const houseFreeCtx = input.limits?.houseFreeContextTokens ?? DEFAULT_HOUSE_FREE_CONTEXT_TOKENS;
  const { plan, availableMicroUsd: available } = input.workspace;
  const byok = new Set<Provider>(input.workspace.byok);
  const difficulty = Number.isFinite(input.difficulty) ? Math.min(1, Math.max(0, input.difficulty)) : 0;
  const fail = (code: RoutingErrorCode, message: string): RoutingDecision => ({ kind: 'error', code, message, reasons });

  // 1. Resolve.
  const resolved = resolveModel(input.requested, input.catalog);
  if (resolved === undefined) {
    reasons.push(`resolve: unknown model "${input.requested}"`);
    return fail('unknown_model', `Unknown model "${input.requested}".`);
  }
  let primary: ModelSpec | undefined;
  let targetTier: Tier;
  if (resolved.kind === 'alias') {
    targetTier = aliasTier(resolved.alias, difficulty);
    reasons.push(
      `resolve: alias ${resolved.alias} → tier ${targetTier}` +
        (resolved.alias === 'beagle/auto' ? ` (difficulty ${difficulty.toFixed(2)})` : ''),
    );
  } else {
    primary = resolved.model;
    targetTier = primary.tier;
    if (primary.requiresPlan !== undefined && primary.requiresPlan !== plan) {
      reasons.push(`resolve: ${primary.id} requires plan ${primary.requiresPlan} (workspace plan ${plan})`);
      return fail('plan_required', `Model ${primary.id} requires the ${primary.requiresPlan} plan.`);
    }
    reasons.push(
      `resolve: explicit ${primary.id} (tier ${primary.tier}${primary.id === input.requested ? '' : `, from "${input.requested}"`})`,
    );
  }

  // 2. Capability filter.
  const capable: ModelSpec[] = [];
  const dropped: string[] = [];
  for (const model of input.catalog) {
    const why = incapableReason(model, input.needs, plan, houseFreeCtx);
    if (why === undefined) capable.push(model);
    else dropped.push(`${model.id} (${why})`);
  }
  reasons.push(dropped.length === 0 ? `capability: all ${capable.length} models fit` : `capability: dropped ${dropped.join(', ')}`);
  const primaryCapable = primary === undefined || capable.includes(primary);

  // 3. paidBy.
  const byokList = [...byok].filter((p) => input.catalog.some((m) => m.provider === p));
  reasons.push(byokList.length === 0 ? 'paidBy: credit (no BYOK keys)' : `paidBy: byok for ${byokList.join(', ')}, credit otherwise`);
  const paidByOf = (model: ModelSpec): PaidBy => (byok.has(model.provider) ? 'byok' : 'credit');

  // 4. Credit runway (aliases only; applies to credit-paid candidates).
  let creditTier: Tier = targetTier;
  if (primary === undefined) {
    if (available < veryLow) {
      creditTier = 'house';
      reasons.push(`credit: available ${formatUsdMicro(available)} < ${formatUsdMicro(veryLow)} → house tier for credit-paid`);
    } else if (available < low) {
      const c = cheaperTier(targetTier);
      if (c !== undefined) creditTier = c;
      reasons.push(`credit: available ${formatUsdMicro(available)} < ${formatUsdMicro(low)} → tier ${creditTier} for credit-paid`);
    } else {
      reasons.push(`credit: available ${formatUsdMicro(available)}, no downgrade`);
    }
  } else {
    reasons.push('credit: explicit request keeps its model');
  }

  // 5. Provider state.
  const stateOf = (provider: Provider): ProviderState => input.providers[provider] ?? { state: 'ok' };
  const quotaLimited = (provider: Provider): boolean => {
    const q = stateOf(provider).quotaRatio;
    return q !== undefined && q < QUOTA_DEGRADED_RATIO;
  };
  const effectiveState = (provider: Provider): ProviderState['state'] => {
    const s = stateOf(provider).state;
    return s === 'ok' && quotaLimited(provider) ? 'degraded' : s;
  };
  const providerNotes: string[] = [];
  for (const provider of new Set(input.catalog.map((m) => m.provider))) {
    const s = stateOf(provider);
    const eff = effectiveState(provider);
    if (eff === 'ok') continue;
    const q = s.quotaRatio !== undefined ? `, quota ${s.quotaRatio.toFixed(2)}` : '';
    providerNotes.push(`${provider} ${eff}${q}${eff === 'down' ? ' (credit-paid dropped)' : ''}`);
  }
  reasons.push(providerNotes.length === 0 ? 'providers: all ok' : `providers: ${providerNotes.join('; ')}`);

  // 6. Fallback expansion.
  const pool: Scored[] = [];
  for (const model of capable) {
    const isPrimary = model === primary;
    if (!isPrimary && !model.autoEligible) continue;
    const paidBy = paidByOf(model);
    const state = effectiveState(model.provider);
    if (paidBy === 'credit' && state === 'down') continue;
    const base = paidBy === 'byok' ? targetTier : creditTier;
    const seq = isPrimary ? -1 : sequence(model.tier, base, fallback);
    if (seq === undefined) continue;
    pool.push({ model, paidBy, seq, stateRank: STATE_RANK[state], quotaLimited: paidBy === 'credit' && quotaLimited(model.provider) });
  }
  const prefIndex = (p: Provider): number => {
    const i = preference.indexOf(p);
    return i === -1 ? preference.length : i;
  };
  pool.sort(
    (a, b) =>
      a.seq - b.seq ||
      (a.paidBy === 'byok' ? 0 : 1) - (b.paidBy === 'byok' ? 0 : 1) ||
      a.stateRank - b.stateRank ||
      prefIndex(a.model.provider) - prefIndex(b.model.provider) ||
      modelPriceSum(a.model) - modelPriceSum(b.model) ||
      (a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0),
  );
  let ordered: Scored[];
  if (fallback === 'none') {
    ordered = primary !== undefined ? pool.filter((c) => c.model === primary) : pool.slice(0, 1);
  } else {
    ordered = pool;
  }
  // "Limit running down": quota-limited credit-paid providers go behind every cheaper-tier candidate.
  if (difficulty < QUOTA_DEMOTION_DIFFICULTY && ordered.some((c) => c.quotaLimited)) {
    const kept = ordered.filter((c) => !c.quotaLimited);
    for (const demoted of ordered.filter((c) => c.quotaLimited)) {
      let at = kept.length;
      for (let i = kept.length - 1; i >= 0; i--) {
        if (tierIndex((kept[i] as Scored).model.tier) >= tierIndex(demoted.model.tier)) {
          at = i + 1;
          break;
        }
        at = i;
      }
      kept.splice(at, 0, demoted);
    }
    ordered = kept;
    reasons.push(`quota: difficulty ${difficulty.toFixed(2)} < ${QUOTA_DEMOTION_DIFFICULTY} → quota-limited providers placed after cheaper tiers`);
  }
  reasons.push(
    `fallback ${fallback}: ${ordered.length} candidate${ordered.length === 1 ? '' : 's'}` +
      (primary !== undefined && !primaryCapable ? ` (requested ${primary.id} excluded by capability)` : ''),
  );

  // 7. Credit gate.
  const beforeGate = ordered.length;
  if (available <= 0n) {
    ordered = ordered.filter((c) => c.paidBy !== 'credit');
    const removed = beforeGate - ordered.length;
    if (removed > 0) reasons.push(`credit gate: available ${formatUsdMicro(available)} ≤ $0 → removed ${removed} credit-paid`);
  }
  if (ordered.length === 0) {
    if (beforeGate > 0) {
      reasons.push('result: insufficient_credit');
      return fail('insufficient_credit', INSUFFICIENT_CREDIT_MESSAGE);
    }
    reasons.push('result: no_capable_model');
    return fail(
      'no_capable_model',
      `No model can serve "${input.requested}" (capabilities, context size, plan or provider availability).`,
    );
  }

  const candidates: Candidate[] = ordered.map((c) => ({ model: c.model, paidBy: c.paidBy }));
  reasons.push(`candidates: ${candidates.map(describe).join(' > ')}`);
  return { kind: 'ok', tier: (candidates[0] as Candidate).model.tier, candidates, reasons };
}
