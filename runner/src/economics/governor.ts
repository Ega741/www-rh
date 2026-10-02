/**
 * Burn governor (`docs/SPEC.md` §4.1 economics):
 *
 * ```
 * dailyBudgetUsd = max(vaultUsd / TARGET_RUNWAY_DAYS, MIN_DAILY_SPEND_USD)
 * avgTickCostUsd = mean of the last 20 tick costs (MAX_TICK_COST_USD without history)
 * tickIntervalMs = max(TICK_INTERVAL_MS, 86_400_000 · avgTickCostUsd / dailyBudgetUsd)
 * nextTickAt     = lastTickEndedAt + tickIntervalMs
 * burnUsdPerHour = Σ cost of ticks started in the last 6 h / 6
 * runwayHours    = burnUsdPerHour > 0 ? vaultUsd / burnUsdPerHour : null
 * ```
 * plus the per-tick guard: stop iterating once the running tick cost reaches `MAX_TICK_COST_USD`.
 *
 * @module economics/governor
 */
import { usdToMicro } from './budget.js';

/** Ticks averaged by the governor. */
export const GOVERNOR_WINDOW = 20;
/** Burn-rate reporting window. */
export const BURN_WINDOW_MS = 6 * 3_600_000;

/** Governor knobs. */
export interface GovernorPolicy {
  tickIntervalMs: number;
  targetRunwayDays: number;
  minDailySpendUsd: number;
  maxTickCostUsd: number;
}

/** `max(vaultUsd / TARGET_RUNWAY_DAYS, MIN_DAILY_SPEND_USD)` */
export function dailyBudgetUsd(vaultUsd: number, p: GovernorPolicy): number {
  return Math.max(Math.max(0, vaultUsd) / p.targetRunwayDays, p.minDailySpendUsd);
}

/** Mean of recent tick costs (µUSD) in USD; `MAX_TICK_COST_USD` without history. */
export function averageTickCostUsd(recentCostsMicro: readonly number[], p: Pick<GovernorPolicy, 'maxTickCostUsd'>): number {
  if (recentCostsMicro.length === 0) return p.maxTickCostUsd;
  return recentCostsMicro.reduce((a, b) => a + b, 0) / recentCostsMicro.length / 1_000_000;
}

/** `max(TICK_INTERVAL_MS, 86_400_000 · avgTickCostUsd / dailyBudgetUsd)`, rounded up. */
export function tickIntervalMs(avgTickCostUsd: number, vaultUsd: number, p: GovernorPolicy): number {
  return Math.max(p.tickIntervalMs, Math.ceil((86_400_000 * Math.max(0, avgTickCostUsd)) / dailyBudgetUsd(vaultUsd, p)));
}

/** `lastTickEndedAt + interval` (0 = due now when the mind never ticked). */
export function nextTickAt(lastTickEndedAt: number | null, intervalMs: number): number {
  return lastTickEndedAt === null ? 0 : lastTickEndedAt + intervalMs;
}

/** Σ cost of the last 6 h (µUSD) / 6, in USD per hour. */
export function burnUsdPerHour(costLast6hMicro: number): number {
  return costLast6hMicro / 6 / 1_000_000;
}

/** `burn > 0 ? vaultUsd / burn : null` */
export function runwayHours(vaultUsd: number, burnPerHour: number): number | null {
  return burnPerHour > 0 ? Math.max(0, vaultUsd) / burnPerHour : null;
}

/** Per-tick guard: true once the running tick cost reaches `MAX_TICK_COST_USD`. */
export function shouldStopTick(runningCostMicro: number, p: Pick<GovernorPolicy, 'maxTickCostUsd'>): boolean {
  return runningCostMicro >= usdToMicro(p.maxTickCostUsd);
}
