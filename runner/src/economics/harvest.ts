/**
 * Pons-mode harvest policy (`docs/SPEC.md` §9.4, §9.7). `harvest(token)` sweeps what the registry may
 * sweep (the curve's pending fees for minds launched here / adopted, the pool's fees with `poolIdOf`
 * or else `derivedPoolId`) and claims the mind account's escrow balance into the vault. It is an
 * operator transaction, so it is sent only when worth it:
 *
 * | rule | when | reason |
 * |---|---|---|
 * | 1 | `claimable ≥ HARVEST_MIN_WEI` (and > 0) | `threshold` |
 * | 2 | the vault alone cannot cover the next tick, vault + claimable + sweepable can, and claimable + sweepable > 0 | `runway` |
 * | 3 | hourly sweep: `claimable + sweepable ≥ HARVEST_MIN_WEI` (and > 0) | `hourly` |
 * | 4 | hourly sweep: graduated, pool id known (`PoolRegistered`, `PoolIdSet` or `derivedPoolId`), no harvest for `HARVEST_INTERVAL_MS` (pool fees are not observable before a sweep) | `pool` |
 *
 * `sweepable` = the creator share of the curve fee / tax indexed since the last `FeesSwept`, counted
 * only while `harvest` can sweep the curve itself (still bonding, and the mind account is the
 * creator fee recipient: launched here or adopted and the creator has not left — `MindAccount.sweepCurve`,
 * else the registry as the launch deployer). After `leave` the creator share goes to the new recipient.
 *
 * @module economics/harvest
 */
import { ponsCreatorShare } from '@www-rh/shared';
import type { PonsMindRow } from '../db/repos.js';
import { computeBudget } from './budget.js';
import type { MindEconomics } from './service.js';

/** What triggered the evaluation. */
export type HarvestTrigger = 'evaluate' | 'hourly';
/** Why a harvest is sent. */
export type HarvestReason = 'threshold' | 'runway' | 'hourly' | 'pool';

/** Inputs of {@link harvestDecision}. */
export interface HarvestInputs {
  claimableWei: bigint;
  /** Creator share of curve fees pending a sweep that `harvest` performs itself; 0 when it cannot sweep them. */
  sweepableWei: bigint;
  harvestMinWei: bigint;
  /** The vault alone covers the next tick (`availableUsd ≥ runnable threshold`). */
  vaultCoversNextTick: boolean;
  /** The vault plus claimable + sweepable would cover it. */
  harvestCoversNextTick: boolean;
  /** Rule 4 applies (graduated, pool id recorded, last harvest older than `HARVEST_INTERVAL_MS`). */
  poolSweepDue: boolean;
  trigger: HarvestTrigger;
}

/** The harvest decision table (pure). */
export function harvestDecision(i: HarvestInputs): HarvestReason | null {
  if (i.claimableWei > 0n && i.claimableWei >= i.harvestMinWei) return 'threshold';
  const harvestable = i.claimableWei + i.sweepableWei;
  if (!i.vaultCoversNextTick && i.harvestCoversNextTick && harvestable > 0n) return 'runway';
  if (i.trigger === 'hourly') {
    if (harvestable > 0n && harvestable >= i.harvestMinWei) return 'hourly';
    if (i.poolSweepDue) return 'pool';
  }
  return null;
}

/** Builds {@link HarvestInputs} for a Pons mind from its rows and economics snapshot. */
export function harvestInputs(
  p: Pick<PonsMindRow, 'claimable' | 'pending_fee' | 'pending_tax' | 'launched_here' | 'adopted' | 'launch_phase' | 'pool_id' | 'registry_pool_id' | 'last_harvest_at'> &
    Partial<Pick<PonsMindRow, 'has_left' | 'derived_pool_id'>>,
  econ: Pick<MindEconomics, 'claimableWei' | 'budget' | 'thresholdUsdMicro' | 'hasBudget'>,
  o: { harvestMinWei: bigint; harvestIntervalMs: number; now: number; trigger: HarvestTrigger; mindCanTick: boolean },
): HarvestInputs {
  const claimableWei = econ.claimableWei ?? BigInt(p.claimable);
  const canSweep = p.launch_phase === 0 && (p.launched_here === 1 || p.adopted === 1) && p.has_left !== 1;
  const sweepableWei = canSweep ? ponsCreatorShare(BigInt(p.pending_fee), BigInt(p.pending_tax)) : 0n;
  const withHarvest = computeBudget({
    balanceWei: econ.budget.balanceWei + claimableWei + sweepableWei,
    epochRemainingWei: econ.budget.epochRemainingWei,
    unsettledUsdMicro: econ.budget.unsettledUsdMicro,
    ethUsdMicro: econ.budget.ethUsdMicro,
  });
  return {
    claimableWei,
    sweepableWei,
    harvestMinWei: o.harvestMinWei,
    // a mind that cannot tick (paused, unknown model) never needs a harvest for its runway
    vaultCoversNextTick: !o.mindCanTick || econ.hasBudget,
    harvestCoversNextTick: withHarvest.availableUsdMicro >= econ.thresholdUsdMicro,
    poolSweepDue:
      p.launch_phase >= 2 &&
      (p.registry_pool_id ?? p.pool_id ?? p.derived_pool_id ?? null) !== null &&
      (p.last_harvest_at === null || o.now - p.last_harvest_at >= o.harvestIntervalMs),
    trigger: o.trigger,
  };
}
