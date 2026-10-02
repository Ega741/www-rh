/**
 * Mind budget (SPEC §4.1 economics, R5): `available = onchainMindBalance · ethUsd − unsettledSpend`,
 * all in integer micro-USD. A mind is runnable only when
 * `available ≥ max(MIN_TICK_BUDGET_USD, MAX_TICK_COST_USD)`.
 *
 * @module economics/budget
 */
import { usdToMicro } from './cost.js';

const WAD = 10n ** 18n;

/** Inputs of {@link computeBudget}. */
export interface BudgetInputs {
  /** Vault balance (`mindBalance(token)`), wei. */
  balanceWei: bigint;
  /** Spend not yet settled on-chain, µUSD. */
  unsettledUsdMicro: number;
  /** ETH/USD × 1e6. */
  ethUsdPriceMicro: number;
}

/** A mind's budget snapshot. */
export interface Budget extends BudgetInputs {
  balanceUsdMicro: number;
  /** `max(0, balanceUsdMicro − unsettledUsdMicro)` */
  availableUsdMicro: number;
}

/** wei → µUSD (floor). */
export function weiToUsdMicro(wei: bigint, ethUsdPriceMicro: number): number {
  return Number((wei * BigInt(ethUsdPriceMicro)) / WAD);
}

/** µUSD → wei (floor): never converts to more ETH than the USD amount is worth. */
export function usdMicroToWei(usdMicro: number | bigint, ethUsdPriceMicro: number): bigint {
  return (BigInt(usdMicro) * WAD) / BigInt(ethUsdPriceMicro);
}

/** Computes the budget snapshot. */
export function computeBudget(inputs: BudgetInputs): Budget {
  const balanceUsdMicro = weiToUsdMicro(inputs.balanceWei, inputs.ethUsdPriceMicro);
  return { ...inputs, balanceUsdMicro, availableUsdMicro: Math.max(0, balanceUsdMicro - inputs.unsettledUsdMicro) };
}

/** Budget policy knobs. */
export interface BudgetPolicy {
  minTickBudgetUsd: number;
  maxTickCostUsd: number;
}

/** Minimum available budget (µUSD) for a mind to be runnable (R5). */
export function runnableThresholdMicro(policy: BudgetPolicy): number {
  return usdToMicro(Math.max(policy.minTickBudgetUsd, policy.maxTickCostUsd));
}

/** Whether the budget allows a tick. */
export function hasTickBudget(budget: Budget, policy: BudgetPolicy): boolean {
  return budget.availableUsdMicro >= runnableThresholdMicro(policy);
}

/** Why a mind cannot tick right now. */
export type NotRunnableReason = 'not-alive' | 'cooling' | 'budget' | 'no-api-key';

/** Runnability decision. */
export type Runnability = { runnable: true } | { runnable: false; reason: NotRunnableReason };

/**
 * Full runnability check: on-chain status must be Alive (0), the mind must not be cooling, an API
 * key must be configured and the budget must cover a maximal tick.
 */
export function mindRunnability(args: {
  status: number;
  coolingUntil: string | null;
  budget: Budget;
  policy: BudgetPolicy;
  hasApiKey: boolean;
  now: number;
}): Runnability {
  if (args.status !== 0) return { runnable: false, reason: 'not-alive' };
  if (args.coolingUntil !== null && Date.parse(args.coolingUntil) > args.now) return { runnable: false, reason: 'cooling' };
  if (!args.hasApiKey) return { runnable: false, reason: 'no-api-key' };
  if (!hasTickBudget(args.budget, args.policy)) return { runnable: false, reason: 'budget' };
  return { runnable: true };
}
