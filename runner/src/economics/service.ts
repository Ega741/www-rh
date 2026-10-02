/**
 * Per-mind economics view (`docs/SPEC.md` §4.1 economics): budget from the indexed vault balance
 * (exact: every vault change is evented) and the on-chain epoch allowance (cached 60 s,
 * invalidated after every draw), burn governor, burn rate and runway.
 *
 * Pons mode (§9.4): the budget counts the vault (`mindBalance`) only; `claimableWei` — creator fees
 * credited to the mind account in the Pons escrow (plus ETH held by the account, §9.7) and not yet
 * harvested — is reported next to it (`registry.claimable(token)`, cached 60 s and invalidated by
 * escrow / harvest events; the indexed escrow balance when the read fails).
 *
 * @module economics/service
 */
import type { Address } from 'viem';
import { modelById } from '@www-rh/shared';
import type { LaunchpadReader } from '../chain/launchpad.js';
import type { Repos } from '../db/repos.js';
import { errorMessage, type Logger } from '../log.js';
import { computeBudget, epochRemainingWei, runnableThresholdMicro, type Budget, type EpochState } from './budget.js';
import type { EthUsdSource } from './ethUsd.js';
import { averageTickCostUsd, BURN_WINDOW_MS, burnUsdPerHour, dailyBudgetUsd, GOVERNOR_WINDOW, nextTickAt, runwayHours, tickIntervalMs, type GovernorPolicy } from './governor.js';

/** Epoch-state cache lifetime. */
export const EPOCH_CACHE_MS = 60_000;
/** `claimable(token)` cache lifetime (Pons). */
export const CLAIMABLE_CACHE_MS = 60_000;

/** Economics policy (env knobs). */
export interface EconomicsPolicy extends GovernorPolicy {
  minTickBudgetUsd: number;
}

/** Economics snapshot of one mind. */
export interface MindEconomics {
  budget: Budget;
  thresholdUsdMicro: number;
  /** `availableUsd >= max(MIN_TICK_BUDGET_USD, MAX_TICK_COST_USD)` */
  hasBudget: boolean;
  modelKnown: boolean;
  avgTickCostUsd: number;
  dailyBudgetUsd: number;
  tickIntervalMs: number;
  nextTickAt: number;
  burnUsdPerHour: number;
  runwayHours: number | null;
  /** Pons: escrow balance of the mind account (not part of the budget until harvested); `null` for curve minds. */
  claimableWei: bigint | null;
}

/** Computes {@link MindEconomics}. */
export class EconomicsService {
  readonly #epochs = new Map<string, { state: EpochState | null; at: number }>();
  readonly #claimable = new Map<string, { value: bigint; at: number }>();
  #limit: { value: { maxPerEpoch: bigint; epochSeconds: number }; at: number } | null = null;

  /**
   * @param claimableReader Pons: `registry.claimable(token)`; `null` uses the indexed escrow balance.
   */
  constructor(
    private readonly repos: Repos,
    private readonly ethUsd: EthUsdSource,
    private readonly reader: Pick<LaunchpadReader, 'drawLimit' | 'drawnInEpoch' | 'latestTimestamp'> | null,
    readonly policy: EconomicsPolicy,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    private readonly claimableReader: ((token: Address) => Promise<bigint>) | null = null,
  ) {}

  /** Forgets the cached `claimable(token)` (escrow credit / claim, harvest). */
  invalidateClaimable(token: string): void {
    this.#claimable.delete(token.toLowerCase());
  }

  /** Pons: the mind account's escrow balance (`claimable(token)`, cached; the indexed value when the read fails). */
  async claimableWei(token: string): Promise<bigint | null> {
    const key = token.toLowerCase();
    const row = this.repos.pons.get(key);
    if (row === undefined) return null;
    const indexed = BigInt(row.claimable);
    if (this.claimableReader === null) return indexed;
    const cached = this.#claimable.get(key);
    if (cached !== undefined && this.now() - cached.at < CLAIMABLE_CACHE_MS) return cached.value;
    try {
      const value = await this.claimableReader(key as Address);
      this.#claimable.set(key, { value, at: this.now() });
      return value;
    } catch (err) {
      this.log.debug('claimable(token) unavailable; using the indexed escrow balance', { token: key, error: errorMessage(err) });
      return indexed;
    }
  }

  /** ETH/USD × 1e6. */
  ethUsdMicro(): Promise<number> {
    return this.ethUsd.ethUsdMicro();
  }

  /** Forgets the cached epoch state of `token` (after a draw). */
  invalidateEpoch(token: string): void {
    this.#epochs.delete(token.toLowerCase());
  }

  /** On-chain epoch state (cached), or `null` when it cannot be read. */
  async epochState(token: string): Promise<EpochState | null> {
    const key = token.toLowerCase();
    const cached = this.#epochs.get(key);
    if (cached !== undefined && this.now() - cached.at < EPOCH_CACHE_MS) return cached.state;
    let state: EpochState | null = null;
    if (this.reader !== null) {
      try {
        if (this.#limit === null || this.now() - this.#limit.at >= EPOCH_CACHE_MS) this.#limit = { value: await this.reader.drawLimit(), at: this.now() };
        const [used, now] = await Promise.all([this.reader.drawnInEpoch(key as Address), this.reader.latestTimestamp()]);
        state = { ...this.#limit.value, drawn: used.drawn, epochStart: used.epochStart, now };
      } catch (err) {
        this.log.debug('epoch state unavailable', { token: key, error: errorMessage(err) });
      }
    }
    this.#epochs.set(key, { state, at: this.now() });
    return state;
  }

  /** Snapshot for `token`. */
  async snapshot(token: string): Promise<MindEconomics> {
    const key = token.toLowerCase();
    const row = this.repos.minds.get(key);
    const balanceWei = BigInt(row?.mind_balance ?? '0');
    const [ethUsdMicro, epoch, claimableWei] = await Promise.all([this.ethUsd.ethUsdMicro(), this.epochState(key), row?.venue === 'pons' ? this.claimableWei(key) : Promise.resolve(null)]);
    const budget = computeBudget({
      balanceWei,
      epochRemainingWei: epoch === null ? null : epochRemainingWei(epoch),
      unsettledUsdMicro: this.repos.ticks.unsettledMicro(key),
      ethUsdMicro,
    });
    const thresholdUsdMicro = runnableThresholdMicro(this.policy);
    const vaultUsd = budget.vaultUsdMicro / 1_000_000;
    const avg = averageTickCostUsd(this.repos.ticks.recentCosts(key, GOVERNOR_WINDOW), this.policy);
    const interval = tickIntervalMs(avg, vaultUsd, this.policy);
    const burn = burnUsdPerHour(this.repos.ticks.costSince(key, this.now() - BURN_WINDOW_MS));
    return {
      budget,
      thresholdUsdMicro,
      hasBudget: budget.availableUsdMicro >= thresholdUsdMicro,
      modelKnown: row !== undefined && modelById(row.model_id) !== undefined,
      avgTickCostUsd: avg,
      dailyBudgetUsd: dailyBudgetUsd(vaultUsd, this.policy),
      tickIntervalMs: interval,
      nextTickAt: nextTickAt(row?.last_tick_ended_at ?? null, interval),
      burnUsdPerHour: burn,
      runwayHours: runwayHours(vaultUsd, burn),
      claimableWei,
    };
  }
}
