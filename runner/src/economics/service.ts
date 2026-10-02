/**
 * Per-mind economics view: budget (on-chain balance when reachable, indexed balance otherwise),
 * burn-governor interval, burn rate and runway.
 *
 * @module economics/service
 */
import type { Address } from 'viem';
import type { LaunchpadReader } from '../chain/launchpad.js';
import type { Repos } from '../db/repos.js';
import type { Logger } from '../log.js';
import { computeBudget, type Budget } from './budget.js';
import type { EthUsdSource } from './ethUsd.js';
import { averageTickCostUsd, burnUsdPerHour, dailyBudgetUsd, governedTickIntervalMs, runwayHours, type GovernorPolicy } from './governor.js';

/** Number of recent ticks averaged by the governor. */
export const GOVERNOR_WINDOW = 10;

/** Economics snapshot of one mind. */
export interface MindEconomics {
  budget: Budget;
  avgTickCostUsd: number;
  dailyBudgetUsd: number;
  tickIntervalMs: number;
  burnUsdPerHour: number;
  runwayHours: number | null;
}

/** Computes {@link MindEconomics}. */
export class EconomicsService {
  constructor(
    private readonly repos: Repos,
    private readonly ethUsd: EthUsdSource,
    private readonly reader: LaunchpadReader | null,
    private readonly policy: GovernorPolicy,
    private readonly log: Logger,
  ) {}

  /** Current ETH/USD × 1e6. */
  ethUsdMicro(): Promise<number> {
    return this.ethUsd.priceMicro();
  }

  /**
   * Snapshot for `token`. With `fresh`, reads `mindBalance` on-chain (and refreshes the indexed
   * value); falls back to the indexed balance if the RPC fails.
   */
  async snapshot(token: string, opts: { fresh?: boolean } = {}): Promise<MindEconomics> {
    const row = this.repos.minds.get(token);
    let balanceWei = BigInt(row?.mind_balance ?? '0');
    if (opts.fresh === true && this.reader !== null && row !== undefined) {
      try {
        balanceWei = await this.reader.mindBalance(token as Address);
        this.repos.minds.setBalance(row.token, balanceWei);
      } catch (err) {
        this.log.debug('mindBalance read failed; using indexed balance', { token, error: (err as Error).message });
      }
    }
    const ethUsdPriceMicro = await this.ethUsd.priceMicro();
    const budget = computeBudget({ balanceWei, unsettledUsdMicro: this.repos.compute.unsettledMicro(token), ethUsdPriceMicro });
    const avg = averageTickCostUsd(this.repos.ticks.recentCosts(token, GOVERNOR_WINDOW));
    const availableUsd = budget.availableUsdMicro / 1_000_000;
    const interval = governedTickIntervalMs(avg, availableUsd, this.policy);
    const burn = burnUsdPerHour(avg, interval);
    return {
      budget,
      avgTickCostUsd: avg,
      dailyBudgetUsd: dailyBudgetUsd(availableUsd, this.policy),
      tickIntervalMs: interval,
      burnUsdPerHour: burn,
      runwayHours: runwayHours(availableUsd, burn),
    };
  }
}
