/**
 * Budget arithmetic (`docs/SPEC.md` §4.1 economics), all in integer micro-USD:
 *
 * ```
 * usdMicroOfWei(wei)   = wei · ethUsdMicro / 1e18            (floor)
 * weiOfUsdMicro(usd)   = ceilDiv(usd · 1e18, ethUsdMicro)
 * epochRemainingWei    = now ≥ epochStart + epochSeconds ? maxPerEpoch : max(0, maxPerEpoch − drawn)
 * availableUsdMicro    = usdMicroOfWei(min(balanceWei, epochRemainingWei)) − unsettledUsdMicro
 * vaultUsdMicro        = max(0, usdMicroOfWei(balanceWei) − unsettledUsdMicro)
 * runnable threshold   = max(MIN_TICK_BUDGET_USD, MAX_TICK_COST_USD)
 * ```
 *
 * @module economics/budget
 */

const WAD = 10n ** 18n;

/** `wei · ethUsdMicro / 1e18` (floor). */
export function usdMicroOfWei(wei: bigint, ethUsdMicro: number): number {
  return Number((wei * BigInt(ethUsdMicro)) / WAD);
}

/** `ceilDiv(usdMicro · 1e18, ethUsdMicro)`. */
export function weiOfUsdMicro(usdMicro: number | bigint, ethUsdMicro: number): bigint {
  const num = BigInt(usdMicro) * WAD;
  const den = BigInt(ethUsdMicro);
  return num === 0n ? 0n : (num - 1n) / den + 1n;
}

/** On-chain draw allowance inputs (`drawLimit()`, `drawnInEpoch()`, latest block timestamp). */
export interface EpochState {
  maxPerEpoch: bigint;
  epochSeconds: number;
  drawn: bigint;
  epochStart: bigint;
  /** Latest block timestamp, unix seconds. */
  now: bigint;
}

/** Remaining draw allowance of the current epoch (the contract resets lazily on the next draw). */
export function epochRemainingWei(e: EpochState): bigint {
  if (e.now >= e.epochStart + BigInt(e.epochSeconds)) return e.maxPerEpoch;
  return e.maxPerEpoch > e.drawn ? e.maxPerEpoch - e.drawn : 0n;
}

/** Budget snapshot of one mind. */
export interface Budget {
  balanceWei: bigint;
  /** `null` when the epoch state is unknown (treated as unlimited). */
  epochRemainingWei: bigint | null;
  unsettledUsdMicro: number;
  ethUsdMicro: number;
  balanceUsdMicro: number;
  /** May be negative when unsettled spend exceeds the drawable amount. */
  availableUsdMicro: number;
  vaultUsdMicro: number;
}

/** Computes the {@link Budget}. */
export function computeBudget(i: { balanceWei: bigint; epochRemainingWei: bigint | null; unsettledUsdMicro: number; ethUsdMicro: number }): Budget {
  const balanceUsdMicro = usdMicroOfWei(i.balanceWei, i.ethUsdMicro);
  const drawable = i.epochRemainingWei !== null && i.epochRemainingWei < i.balanceWei ? i.epochRemainingWei : i.balanceWei;
  return {
    ...i,
    balanceUsdMicro,
    availableUsdMicro: usdMicroOfWei(drawable, i.ethUsdMicro) - i.unsettledUsdMicro,
    vaultUsdMicro: Math.max(0, balanceUsdMicro - i.unsettledUsdMicro),
  };
}

/** USD → integer micro-USD. */
export function usdToMicro(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/** micro-USD → USD rounded to 6 decimals. */
export function microToUsd(micro: number): number {
  return Math.round(micro) / 1_000_000;
}

/** `max(MIN_TICK_BUDGET_USD, MAX_TICK_COST_USD)` in micro-USD. */
export function runnableThresholdMicro(p: { minTickBudgetUsd: number; maxTickCostUsd: number }): number {
  return usdToMicro(Math.max(p.minTickBudgetUsd, p.maxTickCostUsd));
}
