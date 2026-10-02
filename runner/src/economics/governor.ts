/**
 * Burn governor (R5): spreads a mind's vault over `TARGET_RUNWAY_DAYS`.
 *
 * ```
 * dailyBudgetUsd = max(vaultUsd / TARGET_RUNWAY_DAYS, MIN_DAILY_SPEND_USD)
 * interval       = max(TICK_INTERVAL_MS, 86_400_000 · avgTickCostUsd / dailyBudgetUsd)
 * ```
 * and a per-tick guard that stops iterating once the running tick cost reaches `MAX_TICK_COST_USD`.
 *
 * @module economics/governor
 */
import { usdToMicro } from './cost.js';

/** Governor knobs. */
export interface GovernorPolicy {
  tickIntervalMs: number;
  targetRunwayDays: number;
  minDailySpendUsd: number;
  maxTickCostUsd: number;
}

const DAY_MS = 86_400_000;

/** `max(vaultUsd / TARGET_RUNWAY_DAYS, MIN_DAILY_SPEND_USD)` */
export function dailyBudgetUsd(vaultUsd: number, policy: GovernorPolicy): number {
  return Math.max(Math.max(0, vaultUsd) / policy.targetRunwayDays, policy.minDailySpendUsd);
}

/** `max(TICK_INTERVAL_MS, 86_400_000 · avgTickCostUsd / dailyBudgetUsd)` (rounded up to whole ms). */
export function governedTickIntervalMs(avgTickCostUsd: number, vaultUsd: number, policy: GovernorPolicy): number {
  const daily = dailyBudgetUsd(vaultUsd, policy);
  const paced = avgTickCostUsd > 0 ? Math.ceil((DAY_MS * avgTickCostUsd) / daily) : 0;
  return Math.max(policy.tickIntervalMs, paced);
}

/** Mean of recent tick costs (µUSD) in USD; 0 without history. */
export function averageTickCostUsd(recentCostsMicro: readonly number[]): number {
  if (recentCostsMicro.length === 0) return 0;
  return recentCostsMicro.reduce((a, b) => a + b, 0) / recentCostsMicro.length / 1_000_000;
}

/** Per-tick guard: stop iterating when the running tick cost reaches `MAX_TICK_COST_USD`. */
export function shouldStopTick(runningCostUsdMicro: number, policy: Pick<GovernorPolicy, 'maxTickCostUsd'>): boolean {
  return runningCostUsdMicro >= usdToMicro(policy.maxTickCostUsd);
}

/** Expected burn rate (USD/h) at the governed interval. */
export function burnUsdPerHour(avgTickCostUsd: number, intervalMs: number): number {
  if (avgTickCostUsd <= 0 || intervalMs <= 0) return 0;
  return (avgTickCostUsd * 3_600_000) / intervalMs;
}

/** Hours until the available budget is exhausted at `burnPerHour`, or `null` for no burn. */
export function runwayHours(availableUsd: number, burnPerHour: number): number | null {
  if (burnPerHour <= 0) return null;
  return Math.max(0, availableUsd) / burnPerHour;
}
